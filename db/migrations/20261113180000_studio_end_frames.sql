-- End frames made in the app: the creator says how the shot ends, the worker edits the start still with
-- Nano Banana 2 (fal-ai/nano-banana-2/edit), rebuilds it with frame_check end_frame.py compose (room pixel-for-pixel
-- from the start still) and checks it; the creator approves it before the shot can render. @anlim
-- Model choice: 2026-11-13 bake-off (Londi): of GPT Image 2.6, Nano Banana 2 and Seedream 5.0 Lite, Nano Banana 2 was
-- the only one that changed nothing but the characters, and the fastest (21-23 s). $0.08 per edit
-- (fal.ai/learn/tools/best-image-to-image-apis-2026) -> 20 credits at the house margin (0.08 / 0.4 = 0.20 $).

alter table studio.shots add column if not exists end_frame_approved boolean not null default false,
                         add column if not exists end_instruction text;
-- end frames already in use (path test v2) were approved by hand
update studio.shots set end_frame_approved = true where end_frame_path is not null and not end_frame_approved;

create table if not exists studio.frame_jobs (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  shot_id uuid not null references studio.shots(id) on delete cascade,
  kind text not null default 'end' check (kind in ('end')),
  instruction text not null,                 -- the creator's words: how the shot ends
  prompt text,                               -- what was sent to the edit model
  endpoint text not null default 'fal-ai/nano-banana-2/edit',
  usd numeric(8,4) not null default 0.08,
  credits_reserved int not null default 0,
  settled text check (settled in ('charged','released')),
  status text not null default 'queued' check (status in ('queued','running','composing','ready','failed','approved','discarded')),
  provider_request_id text, provider_status_url text, provider_response_url text,
  raw_path text,                             -- the edit model's image
  composed_path text,                        -- after compose: the candidate end frame
  check_result jsonb,                        -- end_frame.check on the composed frame
  error text,
  tries int not null default 0,
  locked_by text, locked_until timestamptz, next_poll_at timestamptz, submitted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists frame_jobs_due on studio.frame_jobs (status, next_poll_at);
create index if not exists frame_jobs_shot on studio.frame_jobs (shot_id, created_at desc);
alter table studio.frame_jobs enable row level security;
drop policy if exists frame_jobs_own on studio.frame_jobs;
create policy frame_jobs_own on studio.frame_jobs for select to authenticated using (owner = (select auth.uid()));
grant select on studio.frame_jobs to authenticated;

alter table studio.credit_ledger add column if not exists frame_job_id uuid references studio.frame_jobs(id) on delete set null;

-- Creator: ask for an end frame. Reserves the credits; one job in flight per shot.
create or replace function studio.request_end_frame(p_shot uuid, p_instruction text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_shot studio.shots; v_acc studio.accounts; v_id uuid; v_cost int := 20;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null then raise exception 'shot not found'; end if;
  if auth.uid() is not null and auth.uid() <> v_owner then raise exception 'not your shot'; end if;
  if coalesce(trim(p_instruction), '') = '' then raise exception 'say how the shot ends'; end if;
  if length(p_instruction) > 1000 then raise exception 'keep it under 1000 characters'; end if;
  select * into v_shot from studio.shots where id = p_shot for update;
  if not v_shot.start_frame_approved or v_shot.start_frame_path is null then
    raise exception 'approve the start frame first'; end if;
  if exists (select 1 from studio.frame_jobs where shot_id = p_shot and status in ('queued','running','composing')) then
    raise exception 'an end frame is already being made for this shot'; end if;
  insert into studio.accounts(owner) values (v_owner) on conflict do nothing;
  select * into v_acc from studio.accounts where owner = v_owner for update;
  if v_acc.balance - v_acc.reserved < v_cost then
    raise exception 'not enough credits: need %, available %', v_cost, v_acc.balance - v_acc.reserved; end if;
  update studio.accounts set reserved = reserved + v_cost, updated_at = now() where owner = v_owner;
  insert into studio.frame_jobs(owner, shot_id, instruction, credits_reserved) values (v_owner, p_shot, trim(p_instruction), v_cost)
    returning id into v_id;
  insert into studio.credit_ledger(owner, kind, credits, frame_job_id) values (v_owner, 'reserve', v_cost, v_id);
  update studio.shots set end_instruction = trim(p_instruction) where id = p_shot;
  return v_id;
end $$;

-- Service: charge or release a frame job's reservation, once.
create or replace function studio.settle_frame_job(p_job uuid, p_outcome text)
returns text language plpgsql security definer set search_path = '' as $$
declare j studio.frame_jobs;
begin
  if p_outcome not in ('charge','release') then raise exception 'bad outcome'; end if;
  select * into j from studio.frame_jobs where id = p_job for update;
  if not found then raise exception 'frame job not found'; end if;
  if j.settled is not null then return j.settled; end if;
  if j.credits_reserved > 0 then
    perform 1 from studio.accounts where owner = j.owner for update;
    update studio.accounts set reserved = reserved - j.credits_reserved,
           balance = balance - case when p_outcome = 'charge' then j.credits_reserved else 0 end, updated_at = now()
     where owner = j.owner;
    insert into studio.credit_ledger(owner, kind, credits, frame_job_id) values (j.owner, p_outcome, j.credits_reserved, j.id);
  end if;
  update studio.frame_jobs set settled = case p_outcome when 'charge' then 'charged' else 'released' end, updated_at = now()
   where id = p_job;
  return case p_outcome when 'charge' then 'charged' else 'released' end;
end $$;

-- Service: lease due frame jobs (same pattern as claim_generations).
create or replace function studio.claim_frame_jobs(p_worker text, p_limit int default 4, p_lease_s int default 300)
returns setof studio.frame_jobs language plpgsql security definer set search_path = '' as $$
begin
  return query
  update studio.frame_jobs f set locked_by = p_worker, locked_until = now() + make_interval(secs => p_lease_s), updated_at = now()
   where f.id in (
     select id from studio.frame_jobs
      where status in ('queued','running','composing')
        and (locked_until is null or locked_until < now())
        and (next_poll_at is null or next_poll_at <= now())
      order by created_at limit p_limit for update skip locked)
  returning f.*;
end $$;

-- Creator: approve a ready end frame (it becomes the shot's end frame) or discard it. Credits were charged when the
-- frame was made: discarding does not refund (the edit was paid for); a failed job was never charged.
create or replace function studio.decide_end_frame(p_job uuid, p_decision text)
returns text language plpgsql security definer set search_path = '' as $$
declare j studio.frame_jobs;
begin
  if p_decision not in ('approve','discard') then raise exception 'decision must be approve or discard'; end if;
  select * into j from studio.frame_jobs where id = p_job for update;
  if not found or (auth.uid() is not null and j.owner <> auth.uid()) then raise exception 'not found'; end if;
  if j.status <> 'ready' then raise exception 'end frame is %', j.status; end if;
  if p_decision = 'approve' then
    update studio.frame_jobs set status = 'discarded', updated_at = now()
     where shot_id = j.shot_id and status = 'approved';
    update studio.frame_jobs set status = 'approved', updated_at = now() where id = p_job;
    update studio.shots set end_frame_path = j.composed_path, end_frame_approved = true where id = j.shot_id;
  else
    update studio.frame_jobs set status = 'discarded', updated_at = now() where id = p_job;
  end if;
  return p_decision;
end $$;

-- Creator: drop the shot's end frame (render from the start frame only).
create or replace function studio.clear_end_frame(p_shot uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if studio.shot_owner(p_shot) is null or (auth.uid() is not null and auth.uid() <> studio.shot_owner(p_shot)) then
    raise exception 'not found'; end if;
  update studio.frame_jobs set status = 'discarded', updated_at = now() where shot_id = p_shot and status = 'approved';
  update studio.shots set end_frame_path = null, end_frame_approved = false where id = p_shot;
end $$;

-- enqueue_generation: an end frame must be approved before rendering (the worker also checks it for drift).
create or replace function studio.enqueue_generation(p_shot uuid, p_model text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_shot studio.shots; v_model studio.models; v_cost int; v_acc studio.accounts; v_id uuid;
        v_kind text; v_reason text; v_mid text := p_model;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null then raise exception 'shot not found'; end if;
  if auth.uid() is not null and auth.uid() <> v_owner then raise exception 'not your shot'; end if;
  select * into v_shot from studio.shots where id = p_shot for update;
  if not v_shot.start_frame_approved or v_shot.start_frame_path is null then
    raise exception 'approve the start frame before generating'; end if;
  if v_shot.end_frame_path is not null and not v_shot.end_frame_approved then
    raise exception 'approve the end frame (or remove it) before generating'; end if;
  if exists (select 1 from studio.generations where shot_id = p_shot and status in ('queued','running','checking')) then
    raise exception 'a generation is already in flight for this shot'; end if;
  if v_mid is null then
    select r.kind, r.model_id, r.reason into v_kind, v_mid, v_reason from studio.route_model(p_shot) r;
  end if;
  select * into v_model from studio.models where id = v_mid and active;
  if not found then raise exception 'unknown model %', v_mid; end if;
  if v_shot.duration_s not between v_model.min_duration_s and v_model.max_duration_s then
    raise exception '% makes clips of % to % s; this shot is % s', v_mid, v_model.min_duration_s, v_model.max_duration_s, v_shot.duration_s; end if;
  v_cost := v_model.credits_per_second * v_shot.duration_s;
  insert into studio.accounts(owner) values (v_owner) on conflict do nothing;
  select * into v_acc from studio.accounts where owner = v_owner for update;
  if v_acc.balance - v_acc.reserved < v_cost then
    raise exception 'not enough credits: need %, available %', v_cost, v_acc.balance - v_acc.reserved; end if;
  update studio.accounts set reserved = reserved + v_cost, updated_at = now() where owner = v_owner;
  insert into studio.generations(owner, shot_id, model_id, credits_reserved, route_kind, route_reason)
    values (v_owner, p_shot, v_mid, v_cost, v_kind, v_reason) returning id into v_id;
  insert into studio.credit_ledger(owner, kind, credits, generation_id) values (v_owner, 'reserve', v_cost, v_id);
  update studio.shots set status = 'generating' where id = p_shot;
  return v_id;
end $$;

-- Functions created after core_loop_v1 got Postgres's default EXECUTE for PUBLIC again (v1's revoke covered only the
-- functions that existed then). These treat "no signed-in user" as the service, so nobody unauthenticated may call them.
revoke execute on all functions in schema studio from public, anon;
grant execute on function studio.request_end_frame(uuid, text), studio.decide_end_frame(uuid, text),
  studio.clear_end_frame(uuid), studio.route_model(uuid), studio.shot_kind(text) to authenticated;
revoke execute on function studio.settle_frame_job(uuid, text), studio.claim_frame_jobs(text, int, int) from public, authenticated, anon;
grant execute on function studio.settle_frame_job(uuid, text), studio.claim_frame_jobs(text, int, int) to service_role;

-- worker role (exists on RideLink; created out of band)
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'studio_worker') then
    grant select, update on studio.frame_jobs to studio_worker;
    grant execute on function studio.settle_frame_job(uuid, text), studio.claim_frame_jobs(text, int, int) to studio_worker;
    drop policy if exists worker_all_frame_jobs on studio.frame_jobs;
    create policy worker_all_frame_jobs on studio.frame_jobs for all to studio_worker using (true) with check (true);
  end if;
end $$;
