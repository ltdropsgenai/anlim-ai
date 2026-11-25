-- Admin console (2026-11-25, Londi: "a true Admin panel ... accessible to only one true admin account. This admin
-- account should be able to add new admin accounts, be able to block/ban users"). @anlim
--   * studio.admins gets a role: one 'owner' (tlondi@gmail.com, Londi's choice) and any number of 'admin's. Only the
--     owner adds or removes admins; nobody removes or blocks the owner.
--   * Every admin call needs the two-step code (the session's JWT says aal2): studio.admin_guard() checks it, from the
--     claims studio-api passes in (asAdmin). A stolen admin password alone does not open the console.
--   * studio.user_blocks: a blocked account cannot use studio-api, studio-mcp or checkout, and cannot upload files
--     (storage policy below). studio-api also bans the account in Supabase Auth and ends its sessions.
--   * studio.admin_log: every admin action, who did it and to whom.

-- 1. roles
alter table studio.admins add column if not exists role text not null default 'admin';
alter table studio.admins drop constraint if exists admins_role_check;
alter table studio.admins add constraint admins_role_check check (role in ('owner', 'admin'));
alter table studio.admins add column if not exists added_by uuid references auth.users(id) on delete set null;
create unique index if not exists admins_one_owner on studio.admins ((true)) where role = 'owner';
insert into studio.admins(user_id, role) values ('c5946314-e649-4bb3-b753-5c17ea22ef8a', 'owner')   -- tlondi@gmail.com
  on conflict (user_id) do update set role = 'owner';

-- 2. blocks and the log
create table if not exists studio.user_blocks (
  owner uuid primary key references auth.users(id) on delete cascade,
  reason text not null,
  blocked_by uuid references auth.users(id) on delete set null,
  blocked_at timestamptz not null default now(),
  until timestamptz);                       -- null = until an admin lifts it
alter table studio.user_blocks enable row level security;

create table if not exists studio.admin_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  admin_id uuid references auth.users(id) on delete set null,
  admin_email text,
  action text not null,
  target uuid,
  target_email text,
  detail jsonb not null default '{}'::jsonb);
alter table studio.admin_log enable row level security;
create index if not exists admin_log_target on studio.admin_log (target, at desc);

-- the edge functions (service connection) ask this before anything else
create or replace function studio.block_of(p_user uuid)
returns table (reason text, until timestamptz) language sql stable security definer set search_path to '' as $$
  select b.reason, b.until from studio.user_blocks b where b.owner = p_user and (b.until is null or b.until > now())
$$;
revoke execute on function studio.block_of(uuid) from public, anon, authenticated;

-- the caller only (the storage policy uses it)
create or replace function studio.am_blocked()
returns boolean language sql stable security definer set search_path to '' as $$
  select exists (select 1 from studio.user_blocks b where b.owner = auth.uid() and (b.until is null or b.until > now()))
$$;
revoke execute on function studio.am_blocked() from public, anon;
grant execute on function studio.am_blocked() to authenticated;

-- 3. the guard: an admin, signed in with the two-step code. Returns the role.
create or replace function studio.admin_guard()
returns text language plpgsql stable security definer set search_path to '' as $$
declare v text;
begin
  select role into v from studio.admins where user_id = auth.uid();
  if v is null then raise exception 'admins only'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then raise exception 'enter your two-step code first'; end if;
  return v;
end $$;

create or replace function studio.admin_note(p_action text, p_target uuid, p_detail jsonb)
returns void language sql security definer set search_path to '' as $$
  insert into studio.admin_log(admin_id, admin_email, action, target, target_email, detail)
  values (auth.uid(), (select email from auth.users where id = auth.uid()), p_action, p_target,
          (select email from auth.users where id = p_target), coalesce(p_detail, '{}'::jsonb))
$$;
revoke execute on function studio.admin_note(text, uuid, jsonb) from public, anon, authenticated;

-- 4. what the console shows
create or replace function studio.admin_overview()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_role text := studio.admin_guard();
begin
  return jsonb_build_object(
    'role', v_role,
    'users', (select count(*) from auth.users),
    'new_7d', (select count(*) from auth.users where created_at > now() - interval '7 days'),
    'active_7d', (select count(*) from studio.accounts where last_seen_at > now() - interval '7 days'),
    'paying', (select count(distinct owner) from studio.payments),
    'blocked', (select count(*) from studio.user_blocks where until is null or until > now()),
    'admins', (select count(*) from studio.admins),
    'refunds_pending', (select count(*) from studio.refund_requests where status = 'pending'),
    'failed_24h', (select count(*) from studio.generations where status = 'failed' and updated_at > now() - interval '24 hours')
                + (select count(*) from studio.frame_jobs where status = 'failed' and updated_at > now() - interval '24 hours'),
    'errors_24h', (select count(*) from studio.app_errors where at > now() - interval '24 hours'),
    'in_flight', (select count(*) from studio.generations where status in ('queued', 'running', 'checking'))
               + (select count(*) from studio.frame_jobs where status in ('queued', 'running', 'composing'))
               + (select count(*) from studio.assemblies where status in ('queued', 'running')));
end $$;

create or replace function studio.admin_users(p_q text default null, p_filter text default 'all', p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_q text := nullif(lower(trim(coalesce(p_q, ''))), ''); v jsonb; v_total int;
begin
  perform studio.admin_guard();
  with base as (
    select u.id, u.email, u.created_at, u.last_sign_in_at, u.email_confirmed_at is not null as confirmed,
           a.balance, a.reserved, a.plan_id, a.plan_status, a.last_seen_at, ad.role,
           b.reason as block_reason, b.until as block_until, (b.owner is not null) as blocked,
           (select coalesce(sum(p.amount_cents - coalesce(p.refunded_cents, 0)), 0) from studio.payments p where p.owner = u.id) as paid_cents,
           (select count(*) from studio.generations g where g.owner = u.id) as clips,
           (select count(*) from studio.generations g where g.owner = u.id and g.status = 'failed') as failed
      from auth.users u
      left join studio.accounts a on a.owner = u.id
      left join studio.admins ad on ad.user_id = u.id
      left join studio.user_blocks b on b.owner = u.id and (b.until is null or b.until > now())
     where (v_q is null or lower(coalesce(u.email, '')) like '%' || v_q || '%' or u.id::text = v_q)
  ), f as (
    select * from base where case coalesce(p_filter, 'all')
      when 'blocked' then blocked when 'admins' then role is not null when 'paying' then paid_cents > 0
      when 'active' then last_seen_at > now() - interval '7 days' else true end)
  select (select count(*) from f),
         coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc nulls last)
                     from (select * from f order by created_at desc nulls last
                           limit greatest(1, least(coalesce(p_limit, 50), 200)) offset greatest(0, coalesce(p_offset, 0))) x), '[]'::jsonb)
    into v_total, v;
  return jsonb_build_object('total', v_total, 'items', v);
end $$;

create or replace function studio.admin_user(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v jsonb;
begin
  perform studio.admin_guard();
  select jsonb_build_object(
    'id', u.id, 'email', u.email, 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at,
    'confirmed', u.email_confirmed_at is not null, 'banned_until', u.banned_until, 'phone', u.phone,
    'mfa', (select count(*) from auth.mfa_factors m where m.user_id = u.id and m.status = 'verified'),
    'role', (select role from studio.admins where user_id = u.id),
    'account', (select to_jsonb(a) - 'stripe_customer_id' - 'stripe_subscription_id'
                        || jsonb_build_object('has_stripe', a.stripe_customer_id is not null, 'subscription', a.stripe_subscription_id is not null)
                  from studio.accounts a where a.owner = u.id),
    'block', (select to_jsonb(b) || jsonb_build_object('by_email', (select email from auth.users where id = b.blocked_by))
                from studio.user_blocks b where b.owner = u.id and (b.until is null or b.until > now())),
    'counts', jsonb_build_object(
      'projects', (select count(*) from studio.series s where s.owner = u.id),
      'clips', (select count(*) from studio.generations g where g.owner = u.id),
      'clips_failed', (select count(*) from studio.generations g where g.owner = u.id and g.status = 'failed'),
      'images', (select count(*) from studio.frame_jobs j where j.owner = u.id),
      'in_flight', (select count(*) from studio.generations g where g.owner = u.id and g.status in ('queued', 'running', 'checking'))
                 + (select count(*) from studio.frame_jobs j where j.owner = u.id and j.status in ('queued', 'running', 'composing')),
      'mcp_calls_7d', (select count(*) from studio.mcp_calls m where m.owner = u.id and m.at > now() - interval '7 days')),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('at', p.created_at, 'plan_id', p.plan_id, 'amount_cents', p.amount_cents,
                                 'credits', p.credits, 'refunded_cents', p.refunded_cents) order by p.created_at desc)
                            from studio.payments p where p.owner = u.id), '[]'::jsonb),
    'ledger', coalesce((select jsonb_agg(x order by x.created_at desc) from (
                 select l.created_at, l.kind, l.credits, l.note from studio.credit_ledger l where l.owner = u.id
                  order by l.created_at desc limit 30) x), '[]'::jsonb),
    'jobs', coalesce((select jsonb_agg(x order by x.created_at desc) from (
                 select * from (
                   select 'clip' as kind, g.id, g.status, g.model_id as detail, g.error, g.created_at, g.credits_charged as credits
                     from studio.generations g where g.owner = u.id
                   union all
                   select 'image', j.id, j.status, j.kind, j.error, j.created_at, j.credits_reserved
                     from studio.frame_jobs j where j.owner = u.id) y
                  order by created_at desc limit 30) x), '[]'::jsonb),
    'refunds', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'credits', r.credits, 'created_at', r.created_at,
                                'reasons', r.reasons) order by r.created_at desc)
                           from studio.refund_requests r where r.owner = u.id), '[]'::jsonb),
    'errors', coalesce((select jsonb_agg(x order by x.at desc) from (
                 select e.at, e.source, e.place, left(e.message, 300) as message from studio.app_errors e where e.owner = u.id
                  order by e.at desc limit 15) x), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(x order by x.at desc) from (
                 select l.at, l.admin_email, l.action, l.detail from studio.admin_log l where l.target = u.id
                  order by l.at desc limit 30) x), '[]'::jsonb))
    into v from auth.users u where u.id = p_user;
  if v is null then raise exception 'account not found'; end if;
  return v;
end $$;

create or replace function studio.admin_issues()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  perform studio.admin_guard();
  return jsonb_build_object(
    'waiting', coalesce((select jsonb_agg(x order by x.since) from (
        select 'clip' as kind, g.id, g.owner, u.email, g.status, g.updated_at as since, g.error from studio.generations g join auth.users u on u.id = g.owner
         where (g.status = 'queued' and g.created_at < now() - interval '10 minutes')
            or (g.status in ('running', 'checking') and g.updated_at < now() - interval '75 minutes')
        union all
        select 'image', j.id, j.owner, u.email, j.status, j.updated_at, j.error from studio.frame_jobs j join auth.users u on u.id = j.owner
         where (j.status = 'queued' and j.created_at < now() - interval '10 minutes')
            or (j.status in ('running', 'composing') and j.updated_at < now() - interval '75 minutes')
        union all
        select 'cut', s.id, s.owner, u.email, s.status, s.updated_at, s.error from studio.assemblies s join auth.users u on u.id = s.owner
         where (s.status = 'queued' and s.created_at < now() - interval '10 minutes')
            or (s.status = 'running' and s.updated_at < now() - interval '75 minutes')
        limit 100) x), '[]'::jsonb),
    'failed', coalesce((select jsonb_agg(x order by x.at desc) from (
        select * from (
          select 'clip' as kind, g.id, g.owner, u.email, g.model_id as detail, left(g.error, 400) as error, g.updated_at as at
            from studio.generations g join auth.users u on u.id = g.owner
           where g.status = 'failed' and g.updated_at > now() - interval '48 hours'
          union all
          select 'image', j.id, j.owner, u.email, j.kind, left(j.error, 400), j.updated_at
            from studio.frame_jobs j join auth.users u on u.id = j.owner
           where j.status = 'failed' and j.updated_at > now() - interval '48 hours'
          union all
          select 'cut', s.id, s.owner, u.email, s.format, left(s.error, 400), s.updated_at
            from studio.assemblies s join auth.users u on u.id = s.owner
           where s.status = 'failed' and s.updated_at > now() - interval '48 hours') y
         order by at desc limit 60) x), '[]'::jsonb),
    'errors', coalesce((select jsonb_agg(x order by x.last desc) from (
        select e.source, e.place, left(e.message, 300) as message, count(*) as n, count(distinct e.owner) as accounts, max(e.at) as last
          from studio.app_errors e where e.at > now() - interval '24 hours'
         group by 1, 2, 3 order by max(e.at) desc limit 30) x), '[]'::jsonb),
    'refunds_pending', (select count(*) from studio.refund_requests where status = 'pending'));
end $$;

create or replace function studio.admin_admins()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  perform studio.admin_guard();
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'email', u.email, 'role', a.role, 'added_at', a.added_at,
                          'added_by', (select email from auth.users where id = a.added_by),
                          'mfa', exists (select 1 from auth.mfa_factors m where m.user_id = a.user_id and m.status = 'verified'))
                          order by (a.role = 'owner') desc, a.added_at)
                     from studio.admins a join auth.users u on u.id = a.user_id), '[]'::jsonb);
end $$;

create or replace function studio.admin_log_list(p_limit int default 100, p_before bigint default null)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  perform studio.admin_guard();
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.id desc) from (
            select * from studio.admin_log where p_before is null or id < p_before
             order by id desc limit greatest(1, least(coalesce(p_limit, 100), 500))) x), '[]'::jsonb);
end $$;

-- 5. what the console does
-- Block: p_hours null = until lifted. Admins and the owner cannot be blocked (the owner removes an admin first).
create or replace function studio.admin_block(p_user uuid, p_reason text, p_hours int default null)
returns timestamptz language plpgsql security definer set search_path to '' as $$
declare v_until timestamptz;
begin
  perform studio.admin_guard();
  if p_user = auth.uid() then raise exception 'you cannot block your own account'; end if;
  if exists (select 1 from studio.admins where user_id = p_user) then raise exception 'remove this account from the admins first'; end if;
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'account not found'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'give a reason'; end if;
  if p_hours is not null and (p_hours < 1 or p_hours > 87600) then raise exception 'hours must be 1 to 87600'; end if;
  v_until := case when p_hours is null then null else now() + make_interval(hours => p_hours) end;
  insert into studio.user_blocks(owner, reason, blocked_by, blocked_at, until)
  values (p_user, left(trim(p_reason), 1000), auth.uid(), now(), v_until)
  on conflict (owner) do update set reason = excluded.reason, blocked_by = excluded.blocked_by, blocked_at = now(), until = excluded.until;
  perform studio.admin_note('block', p_user, jsonb_build_object('reason', left(trim(p_reason), 1000), 'hours', p_hours));
  return v_until;
end $$;

create or replace function studio.admin_unblock(p_user uuid, p_note text default null)
returns void language plpgsql security definer set search_path to '' as $$
begin
  perform studio.admin_guard();
  delete from studio.user_blocks where owner = p_user;
  perform studio.admin_note('unblock', p_user, jsonb_build_object('note', left(coalesce(p_note, ''), 1000)));
end $$;

-- Give credits (support): 1 to 20,000 at a time, written to the ledger as a grant with the admin's note.
create or replace function studio.admin_grant(p_user uuid, p_credits int, p_note text)
returns int language plpgsql security definer set search_path to '' as $$
declare v int;
begin
  perform studio.admin_guard();
  if p_credits is null or p_credits < 1 or p_credits > 20000 then raise exception 'credits must be 1 to 20000'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'give a reason'; end if;
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'account not found'; end if;
  v := studio.grant_credits(p_user, p_credits, 'grant', 'admin: ' || left(trim(p_note), 300));
  perform studio.admin_note('grant_credits', p_user, jsonb_build_object('credits', p_credits, 'note', left(trim(p_note), 300), 'balance', v));
  return v;
end $$;

-- Owner only: add an admin by the email of an existing account; remove one.
create or replace function studio.admin_add(p_email text)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v uuid;
begin
  if studio.admin_guard() <> 'owner' then raise exception 'only the owner adds admins'; end if;
  select id into v from auth.users where lower(email) = lower(trim(coalesce(p_email, '')));
  if v is null then raise exception 'no account with that email: they sign up first'; end if;
  if exists (select 1 from studio.user_blocks where owner = v and (until is null or until > now())) then raise exception 'that account is blocked'; end if;
  if exists (select 1 from studio.admins where user_id = v) then raise exception 'already an admin'; end if;
  insert into studio.admins(user_id, role, added_by) values (v, 'admin', auth.uid());
  perform studio.admin_note('add_admin', v, '{}'::jsonb);
  return v;
end $$;

create or replace function studio.admin_remove(p_user uuid)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if studio.admin_guard() <> 'owner' then raise exception 'only the owner removes admins'; end if;
  if exists (select 1 from studio.admins where user_id = p_user and role = 'owner') then raise exception 'the owner cannot be removed'; end if;
  delete from studio.admins where user_id = p_user;
  if not found then raise exception 'not an admin'; end if;
  perform studio.admin_note('remove_admin', p_user, '{}'::jsonb);
end $$;

do $$ declare f text; begin
  foreach f in array array['admin_guard()', 'admin_overview()', 'admin_users(text, text, int, int)', 'admin_user(uuid)', 'admin_issues()',
                           'admin_admins()', 'admin_log_list(int, bigint)', 'admin_block(uuid, text, int)', 'admin_unblock(uuid, text)',
                           'admin_grant(uuid, int, text)', 'admin_add(text)', 'admin_remove(uuid)'] loop
    execute format('revoke execute on function studio.%s from public, anon', f);
    execute format('grant execute on function studio.%s to authenticated', f);
  end loop;
end $$;

-- 6. a blocked account cannot upload (same rule as 2026-11-20 studio_motion_upload_policy, plus the block)
drop policy if exists studio_files_write on storage.objects;
create policy studio_files_write on storage.objects for insert to authenticated with check (
  bucket_id = 'studio'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and array_length(storage.foldername(name), 1) = 2
  and (
    ((storage.foldername(name))[2] in ('stills', 'characters', 'locations') and lower(storage.extension(name)) in ('png', 'jpg', 'jpeg', 'webp'))
    or ((storage.foldername(name))[2] = 'music' and lower(storage.extension(name)) in ('mp3', 'wav', 'm4a', 'aac', 'mp4'))
    or ((storage.foldername(name))[2] = 'motion' and lower(storage.extension(name)) in ('mp4', 'mov', 'webm', 'png', 'jpg', 'jpeg', 'webp'))
  )
  and not (select studio.am_blocked())
);
