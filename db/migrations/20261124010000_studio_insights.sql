-- Error monitoring and usage analytics, inside Supabase (2026-11-23, Londi chose "Built into Supabase": no new
-- accounts, no keys). @anlim
--   studio.app_errors : unexpected errors from the app (screens that crashed, browser errors), studio-api and the
--                       connector (anything that is not a message written for creators) and the worker (job steps).
--   studio.app_events : which pages signed-in creators open (one row per page view), for where people stop.
--   studio.admin_insights(days) : the funnel (sign-up -> first picture -> first clip -> kept clip -> cut -> paid),
--                       failure rates per job type, the most common errors and page views. Admins only.
-- Both tables are server-only (RLS on, no policies for creators); creators write through the two functions below,
-- which cap how much one account can send.

create table if not exists studio.app_errors (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  source text not null check (source in ('app', 'api', 'mcp', 'worker')),
  owner uuid,
  place text,                 -- the screen, the api op, the tool, or the worker step ("clip queued")
  message text not null,
  ref text,                   -- the reference shown to the creator, or the job id
  detail jsonb
);
create index if not exists app_errors_at on studio.app_errors(at desc);
alter table studio.app_errors enable row level security;
revoke all on studio.app_errors from public, anon, authenticated;
grant insert on studio.app_errors to studio_worker;
create policy worker_errors on studio.app_errors for insert to studio_worker with check (source = 'worker');

create table if not exists studio.app_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  owner uuid not null,
  name text not null,         -- 'view' for a page view
  route text
);
create index if not exists app_events_at on studio.app_events(at desc);
alter table studio.app_events enable row level security;
revoke all on studio.app_events from public, anon, authenticated;

-- An error the app saw (at most 30 an hour per account; longer texts are cut).
create or replace function studio.log_client_error(p_place text, p_message text, p_detail jsonb default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return; end if;
  if (select count(*) from studio.app_errors where owner = v_uid and source = 'app' and at > now() - interval '1 hour') >= 30 then return; end if;
  insert into studio.app_errors(source, owner, place, message, detail)
    values ('app', v_uid, left(coalesce(p_place, ''), 200), left(coalesce(nullif(p_message, ''), 'unknown error'), 2000),
            case when p_detail is null or length(p_detail::text) > 8000 then null else p_detail end);
end $$;
revoke execute on function studio.log_client_error(text, text, jsonb) from public, anon;
grant execute on function studio.log_client_error(text, text, jsonb) to authenticated;

-- A page view (at most 600 an hour per account). Only the path is kept, never its query string.
create or replace function studio.track(p_name text, p_route text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or p_name !~ '^[a-z_]{1,40}$' then return; end if;
  if (select count(*) from studio.app_events where owner = v_uid and at > now() - interval '1 hour') >= 600 then return; end if;
  insert into studio.app_events(owner, name, route) values (v_uid, p_name, left(split_part(coalesce(p_route, ''), '?', 1), 200));
end $$;
revoke execute on function studio.track(text, text) from public, anon;
grant execute on function studio.track(text, text) to authenticated;

-- The admin page's numbers. Accounts made in the last p_days days, and how far each got; jobs and errors of that window.
create or replace function studio.admin_insights(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_since timestamptz := now() - make_interval(days => greatest(1, least(p_days, 365))); r jsonb;
begin
  if not exists (select 1 from studio.admins where user_id = auth.uid()) then raise exception 'admins only'; end if;
  with u as (
    select au.id, au.created_at from auth.users au where au.created_at >= v_since
  ), steps as (
    select u.id, u.created_at,
      (select min(f.created_at) from studio.frame_jobs f where f.owner = u.id and f.status in ('ready', 'approved')) as picture,
      (select min(g.created_at) from studio.generations g where g.owner = u.id and g.status in ('review', 'succeeded')) as clip,
      (select min(rv.created_at) from studio.reviews rv join studio.generations g on g.id = rv.generation_id
        where g.owner = u.id and rv.decision = 'approve') as kept,
      (select min(a.created_at) from studio.assemblies a where a.owner = u.id and a.status = 'done') as cut,
      (select min(p.created_at) from studio.payments p where p.owner = u.id) as paid
    from u
  )
  select jsonb_build_object(
    'days', p_days, 'since', v_since,
    'funnel', jsonb_build_array(
      jsonb_build_object('step', 'Signed up', 'n', (select count(*) from steps)),
      jsonb_build_object('step', 'First picture', 'n', (select count(picture) from steps),
        'median_h', (select round((percentile_cont(0.5) within group (order by extract(epoch from picture - created_at)) / 3600)::numeric, 1) from steps where picture is not null)),
      jsonb_build_object('step', 'First clip', 'n', (select count(clip) from steps),
        'median_h', (select round((percentile_cont(0.5) within group (order by extract(epoch from clip - created_at)) / 3600)::numeric, 1) from steps where clip is not null)),
      jsonb_build_object('step', 'Kept a clip', 'n', (select count(kept) from steps)),
      jsonb_build_object('step', 'Made a cut', 'n', (select count(cut) from steps)),
      jsonb_build_object('step', 'Paid', 'n', (select count(paid) from steps),
        'median_h', (select round((percentile_cont(0.5) within group (order by extract(epoch from paid - created_at)) / 3600)::numeric, 1) from steps where paid is not null))),
    'jobs', (select coalesce(jsonb_agg(x order by x->>'kind'), '[]') from (
      select jsonb_build_object('kind', 'clip', 'total', count(*), 'failed', count(*) filter (where status = 'failed')) x
        from studio.generations where created_at >= v_since
      union all select jsonb_build_object('kind', 'picture', 'total', count(*), 'failed', count(*) filter (where status = 'failed'))
        from studio.frame_jobs where created_at >= v_since and kind in ('start', 'end', 'plate')
      union all select jsonb_build_object('kind', 'cut', 'total', count(*), 'failed', count(*) filter (where status = 'failed'))
        from studio.assemblies where created_at >= v_since
      union all select jsonb_build_object('kind', 'audio', 'total', count(*), 'failed', count(*) filter (where status = 'failed'))
        from studio.audio_jobs where created_at >= v_since) j),
    'blocked', (select count(*) from studio.moderation_log where at >= v_since and verdict = 'BLOCK'),
    'errors', (select coalesce(jsonb_agg(e order by (e->>'n')::int desc), '[]') from (
      select jsonb_build_object('source', source, 'place', place, 'message', left(message, 300), 'n', count(*),
                                'accounts', count(distinct owner), 'last', max(at)) e
        from studio.app_errors where at >= v_since group by source, place, left(message, 300)
       order by count(*) desc limit 25) t),
    'views', (select coalesce(jsonb_agg(v order by (v->>'n')::int desc), '[]') from (
      select jsonb_build_object('route', route, 'n', count(*), 'accounts', count(distinct owner)) v
        from studio.app_events where at >= v_since and name = 'view' group by route order by count(*) desc limit 25) t)
  ) into r;
  return r;
end $$;
revoke execute on function studio.admin_insights(int) from public, anon;
grant execute on function studio.admin_insights(int) to authenticated;

-- Errors and page views older than 90 days are not needed (the daily storage clean-up calls this).
create or replace function studio.insights_trim() returns int language sql security definer set search_path = '' as $$
  with a as (delete from studio.app_errors where at < now() - interval '90 days' returning 1),
       b as (delete from studio.app_events where at < now() - interval '90 days' returning 1)
  select ((select count(*) from a) + (select count(*) from b))::int $$;
revoke execute on function studio.insights_trim() from public, anon, authenticated;
grant execute on function studio.insights_trim() to service_role, studio_worker;
