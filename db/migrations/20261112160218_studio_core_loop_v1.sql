-- Continuity-first cartoon studio: core loop v1 (2026-11-12). Isolated in schema studio; RideLink's public schema untouched.
create schema if not exists studio;

create table studio.models (
  id text primary key,                         -- e.g. kling-v4-i2v-720p
  provider text not null check (provider in ('fal','mock')),
  endpoint text not null,                      -- provider model path, e.g. kling/v4/image-to-video
  resolution text not null default '720p',
  credits_per_second int not null check (credits_per_second > 0),
  usd_per_second numeric(10,4) not null,       -- provider list price, for cost tracking
  active boolean not null default true
);

create table studio.accounts (
  owner uuid primary key references auth.users(id) on delete cascade,
  balance int not null default 0 check (balance >= 0),     -- credits owned
  reserved int not null default 0 check (reserved >= 0),   -- held for in-flight generations
  updated_at timestamptz not null default now(),
  check (reserved <= balance)
);

create table studio.series (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  style_prompt text,
  created_at timestamptz not null default now()
);

create table studio.characters (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references studio.series(id) on delete cascade,
  name text not null,
  ref_front_path text,
  ref_angle_paths text[] not null default '{}',
  height_units numeric,                        -- relative height; lineup order is checked against it
  build text, palette jsonb, wardrobe text, voice_id text,
  created_at timestamptz not null default now()
);

create table studio.locations (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references studio.series(id) on delete cascade,
  name text not null, description text, layout_path text,
  created_at timestamptz not null default now()
);

create table studio.scenes (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references studio.series(id) on delete cascade,
  location_id uuid references studio.locations(id) on delete set null,
  ord int not null default 0,
  title text,
  blocking jsonb not null default '{}',        -- who stands where, facing which way
  created_at timestamptz not null default now()
);

create table studio.shots (
  id uuid primary key default gen_random_uuid(),
  scene_id uuid not null references studio.scenes(id) on delete cascade,
  ord int not null default 0,
  action text not null,                        -- what happens; the action check compares against this
  camera text,
  duration_s int not null default 5 check (duration_s between 3 and 30),
  start_frame_path text,
  end_frame_path text,
  start_frame_approved boolean not null default false,
  motion_complexity text check (motion_complexity in ('low','medium','high')),
  status text not null default 'draft'
    check (status in ('draft','ready','generating','review','approved','rejected')),
  approved_generation_id uuid,
  created_at timestamptz not null default now()
);

create table studio.generations (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  shot_id uuid not null references studio.shots(id) on delete cascade,
  model_id text not null references studio.models(id),
  parent_id uuid references studio.generations(id),   -- set on the free retry
  free_retry boolean not null default false,
  request jsonb not null default '{}',                -- compiled provider input
  status text not null default 'queued'
    check (status in ('queued','running','checking','review','succeeded','failed','cancelled')),
  provider_request_id text, provider_status_url text, provider_response_url text,
  credits_reserved int not null default 0 check (credits_reserved >= 0),
  credits_charged int not null default 0 check (credits_charged >= 0),
  settled text check (settled in ('charged','released')),
  provider_usd numeric(10,4),
  output_path text,
  error text,
  tries int not null default 0,                       -- worker attempts at the current step
  locked_by text, locked_until timestamptz,
  next_poll_at timestamptz,
  submitted_at timestamptz, finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on studio.generations (status, next_poll_at);
create index on studio.generations (shot_id);
create unique index generations_one_free_retry on studio.generations (parent_id) where parent_id is not null;

alter table studio.shots add constraint shots_approved_generation_fk
  foreign key (approved_generation_id) references studio.generations(id) on delete set null;

create table studio.qc_runs (
  id uuid primary key default gen_random_uuid(),
  generation_id uuid not null references studio.generations(id) on delete cascade,
  verdict text not null check (verdict in ('PASS','FLAG','FAIL','ERROR')),
  flags jsonb not null default '[]',            -- [{t_s, gate, note}] for the review UI
  review_usd numeric(10,4) not null default 0,
  verify_usd numeric(10,4) not null default 0,
  action_usd numeric(10,4) not null default 0,
  models jsonb, raw jsonb,
  created_at timestamptz not null default now()
);
create index on studio.qc_runs (generation_id);

create table studio.reviews (                   -- creator decisions; also the checker-agreement metric
  id uuid primary key default gen_random_uuid(),
  generation_id uuid not null references studio.generations(id) on delete cascade,
  reviewer uuid not null default auth.uid() references auth.users(id),
  decision text not null check (decision in ('approve','reject')),
  reasons text[] not null default '{}',
  note text,
  created_at timestamptz not null default now()
);

create table studio.credit_ledger (             -- append-only
  id bigserial primary key,
  owner uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('purchase','grant','reserve','charge','release','refund')),
  credits int not null check (credits >= 0),
  generation_id uuid references studio.generations(id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);
create index on studio.credit_ledger (owner, created_at);

-- ---------- functions ----------
create or replace function studio.owns_series(p_series uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from studio.series s where s.id = p_series and s.owner = auth.uid());
$$;

create or replace function studio.shot_owner(p_shot uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select se.owner from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id
         join studio.series se on se.id = sc.series_id where sh.id = p_shot;
$$;

-- Service: add credits (purchase or grant).
create or replace function studio.grant_credits(p_owner uuid, p_credits int, p_kind text default 'grant', p_note text default null)
returns int language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  if p_credits <= 0 or p_kind not in ('grant','purchase','refund') then raise exception 'bad grant'; end if;
  insert into studio.accounts(owner) values (p_owner) on conflict do nothing;
  update studio.accounts set balance = balance + p_credits, updated_at = now() where owner = p_owner returning balance into v;
  insert into studio.credit_ledger(owner, kind, credits, note) values (p_owner, p_kind, p_credits, p_note);
  return v;
end $$;

-- Creator: queue a paid generation for an approved start frame; reserves credits atomically.
create or replace function studio.enqueue_generation(p_shot uuid, p_model text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_shot studio.shots; v_model studio.models; v_cost int; v_acc studio.accounts; v_id uuid;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null then raise exception 'shot not found'; end if;
  if auth.uid() is not null and auth.uid() <> v_owner then raise exception 'not your shot'; end if;
  select * into v_shot from studio.shots where id = p_shot for update;
  if not v_shot.start_frame_approved or v_shot.start_frame_path is null then
    raise exception 'approve the start frame before generating'; end if;
  if exists (select 1 from studio.generations where shot_id = p_shot and status in ('queued','running','checking')) then
    raise exception 'a generation is already in flight for this shot'; end if;
  select * into v_model from studio.models where id = p_model and active;
  if not found then raise exception 'unknown model %', p_model; end if;
  v_cost := v_model.credits_per_second * v_shot.duration_s;
  insert into studio.accounts(owner) values (v_owner) on conflict do nothing;
  select * into v_acc from studio.accounts where owner = v_owner for update;
  if v_acc.balance - v_acc.reserved < v_cost then
    raise exception 'not enough credits: need %, available %', v_cost, v_acc.balance - v_acc.reserved; end if;
  update studio.accounts set reserved = reserved + v_cost, updated_at = now() where owner = v_owner;
  insert into studio.generations(owner, shot_id, model_id, credits_reserved)
    values (v_owner, p_shot, p_model, v_cost) returning id into v_id;
  insert into studio.credit_ledger(owner, kind, credits, generation_id) values (v_owner, 'reserve', v_cost, v_id);
  update studio.shots set status = 'generating' where id = p_shot;
  return v_id;
end $$;

-- Service: settle a generation's reservation exactly once ('charge' or 'release').
create or replace function studio.settle_generation(p_gen uuid, p_outcome text)
returns text language plpgsql security definer set search_path = '' as $$
declare g studio.generations;
begin
  if p_outcome not in ('charge','release') then raise exception 'bad outcome'; end if;
  select * into g from studio.generations where id = p_gen for update;
  if not found then raise exception 'generation not found'; end if;
  if g.settled is not null then return g.settled; end if;               -- idempotent
  if g.credits_reserved > 0 then
    perform 1 from studio.accounts where owner = g.owner for update;
    update studio.accounts set reserved = reserved - g.credits_reserved,
           balance = balance - case when p_outcome = 'charge' then g.credits_reserved else 0 end,
           updated_at = now() where owner = g.owner;
    insert into studio.credit_ledger(owner, kind, credits, generation_id)
      values (g.owner, p_outcome, g.credits_reserved, g.id);
  end if;
  update studio.generations set settled = case p_outcome when 'charge' then 'charged' else 'released' end,
         credits_charged = case when p_outcome = 'charge' then credits_reserved else 0 end, updated_at = now()
   where id = p_gen;
  return case p_outcome when 'charge' then 'charged' else 'released' end;
end $$;

-- Service: one free automatic retry after a checker FAIL on a paid first attempt (the app pays).
create or replace function studio.enqueue_free_retry(p_gen uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare g studio.generations; v_id uuid;
begin
  select * into g from studio.generations where id = p_gen;
  if g.free_retry or g.parent_id is not null then return null; end if;   -- only one, only for the first attempt
  insert into studio.generations(owner, shot_id, model_id, parent_id, free_retry, request)
    values (g.owner, g.shot_id, g.model_id, g.id, true, g.request)
    on conflict do nothing returning id into v_id;
  if v_id is not null then update studio.shots set status = 'generating' where id = g.shot_id; end if;
  return v_id;
end $$;

-- Service: lease due jobs to a worker (queued, or running/checking whose poll is due or whose lease expired).
create or replace function studio.claim_generations(p_worker text, p_limit int default 4, p_lease_s int default 120)
returns setof studio.generations language plpgsql security definer set search_path = '' as $$
begin
  return query
  update studio.generations g set locked_by = p_worker, locked_until = now() + make_interval(secs => p_lease_s), updated_at = now()
   where g.id in (
     select id from studio.generations
      where status in ('queued','running','checking')
        and (locked_until is null or locked_until < now())
        and (next_poll_at is null or next_poll_at <= now())
      order by created_at
      limit p_limit
      for update skip locked)
  returning g.*;
end $$;

-- Creator: decide on a clip waiting for review (FLAG, or a PASS they reject).
create or replace function studio.review_generation(p_gen uuid, p_decision text, p_reasons text[] default '{}', p_note text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare g studio.generations;
begin
  select * into g from studio.generations where id = p_gen for update;
  if not found or (auth.uid() is not null and g.owner <> auth.uid()) then raise exception 'not found'; end if;
  if g.status not in ('review','succeeded') then raise exception 'generation is %', g.status; end if;
  insert into studio.reviews(generation_id, reviewer, decision, reasons, note)
    values (p_gen, coalesce(auth.uid(), g.owner), p_decision, p_reasons, p_note);
  if p_decision = 'approve' then
    perform studio.settle_generation(p_gen, 'charge');
    update studio.generations set status = 'succeeded', updated_at = now() where id = p_gen;
    update studio.shots set status = 'approved', approved_generation_id = p_gen where id = g.shot_id;
  else
    -- policy v1: rejecting a FLAGGED clip releases its credits; rejecting a checker PASS keeps the charge
    if g.settled is null then perform studio.settle_generation(p_gen, 'release'); end if;
    update studio.generations set status = 'failed', error = 'rejected by creator', updated_at = now() where id = p_gen;
    update studio.shots set status = 'rejected' where id = g.shot_id;
  end if;
  return p_decision;
end $$;

-- ---------- privileges and RLS ----------
grant usage on schema studio to authenticated, service_role;
grant all on all tables in schema studio to service_role;
grant all on all sequences in schema studio to service_role;
grant select on all tables in schema studio to authenticated;
grant insert, update, delete on studio.series, studio.characters, studio.locations, studio.scenes, studio.shots to authenticated;

revoke execute on all functions in schema studio from public, anon;
grant execute on function studio.enqueue_generation(uuid, text), studio.review_generation(uuid, text, text[], text),
  studio.owns_series(uuid), studio.shot_owner(uuid) to authenticated;
grant execute on all functions in schema studio to service_role;

alter table studio.models enable row level security;
alter table studio.accounts enable row level security;
alter table studio.series enable row level security;
alter table studio.characters enable row level security;
alter table studio.locations enable row level security;
alter table studio.scenes enable row level security;
alter table studio.shots enable row level security;
alter table studio.generations enable row level security;
alter table studio.qc_runs enable row level security;
alter table studio.reviews enable row level security;
alter table studio.credit_ledger enable row level security;

create policy models_read on studio.models for select to authenticated using (active);
create policy accounts_own on studio.accounts for select to authenticated using (owner = (select auth.uid()));
create policy ledger_own on studio.credit_ledger for select to authenticated using (owner = (select auth.uid()));
create policy series_own on studio.series for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy characters_own on studio.characters for all to authenticated
  using (studio.owns_series(series_id)) with check (studio.owns_series(series_id));
create policy locations_own on studio.locations for all to authenticated
  using (studio.owns_series(series_id)) with check (studio.owns_series(series_id));
create policy scenes_own on studio.scenes for all to authenticated
  using (studio.owns_series(series_id)) with check (studio.owns_series(series_id));
create policy shots_own on studio.shots for all to authenticated
  using (studio.shot_owner(id) = (select auth.uid()))
  with check (exists (select 1 from studio.scenes sc where sc.id = scene_id and studio.owns_series(sc.series_id)));
create policy generations_own on studio.generations for select to authenticated using (owner = (select auth.uid()));
create policy qc_own on studio.qc_runs for select to authenticated
  using (exists (select 1 from studio.generations g where g.id = generation_id and g.owner = (select auth.uid())));
create policy reviews_own on studio.reviews for select to authenticated
  using (exists (select 1 from studio.generations g where g.id = generation_id and g.owner = (select auth.uid())));

-- ---------- seed models (prices: fal Kling 4.0 page, read 2026-11-12) ----------
-- credits: 1 credit = $0.01 of price; 60% margin on $0.157/s => $0.3925/s => 40 credits/s (rounded up)
insert into studio.models(id, provider, endpoint, resolution, credits_per_second, usd_per_second) values
  ('kling-v4-i2v-720p', 'fal', 'kling/v4/image-to-video', '720p', 40, 0.157),
  ('mock-i2v', 'mock', 'mock/i2v', '720p', 1, 0);

-- ---------- storage: private bucket, files under <owner uuid>/... ----------
insert into storage.buckets (id, name, public) values ('studio', 'studio', false) on conflict do nothing;
create policy studio_files_read on storage.objects for select to authenticated
  using (bucket_id = 'studio' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy studio_files_write on storage.objects for insert to authenticated
  with check (bucket_id = 'studio' and (storage.foldername(name))[1] = (select auth.uid())::text);
