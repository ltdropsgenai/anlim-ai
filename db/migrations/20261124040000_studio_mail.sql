-- "Your clip is ready" emails (2026-11-23, Londi chose anlim.ai as the sender; Resend domain mail.anlim.ai). @anlim
-- When a clip, lip sync, motion transfer or cut finishes (or cannot be made), a row goes into studio.mail_queue (triggers
-- below). The studio-mail Edge Function, started by the worker once a minute, sends one email per account for what is
-- waiting, at most one every 10 minutes, and only when the creator is not in the app (the app asks for "me" every 20 s
-- while it is on screen; that stamps accounts.last_seen_at). Creators can turn the emails off on the Account page.

alter table studio.accounts add column if not exists email_ready boolean not null default true;
alter table studio.accounts add column if not exists last_seen_at timestamptz;

create table if not exists studio.mail_queue (
  id bigint generated always as identity primary key,
  owner uuid not null,
  kind text not null check (kind in ('clip', 'clip_failed', 'cut', 'cut_failed')),
  ref_id uuid not null,
  title text not null,
  link text not null,
  detail text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  outcome text                          -- sent | off (turned off) | in_app (they were using the app) | failed: ...
);
create index if not exists mail_queue_waiting on studio.mail_queue(owner) where sent_at is null;
alter table studio.mail_queue enable row level security;
revoke all on studio.mail_queue from public, anon, authenticated;

create or replace function studio.trg_mail_generation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_title text; v_kind text;
begin
  if old.status not in ('queued', 'running', 'checking') then return new; end if;
  if new.status in ('review', 'succeeded') then v_kind := 'clip';
  elsif new.status = 'failed' and coalesce(new.error, '') <> 'rejected by creator' then v_kind := 'clip_failed';
  else return new; end if;
  select left(case new.route_kind when 'lipsync' then 'Lip sync: ' when 'motion' then 'Motion transfer: ' else '' end ||
              coalesce(nullif(sh.action, ''), 'A clip'), 90) || ' (' || se.name || ')'
    into v_title
    from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id join studio.series se on se.id = sc.series_id where sh.id = new.shot_id;
  insert into studio.mail_queue(owner, kind, ref_id, title, link, detail)
    values (new.owner, v_kind, new.id, coalesce(v_title, 'A clip'), '/clip/' || new.id, case when v_kind = 'clip_failed' then left(new.error, 300) end);
  return new;
end $$;
drop trigger if exists mail_generation on studio.generations;
create trigger mail_generation after update of status on studio.generations
  for each row when (old.status is distinct from new.status) execute function studio.trg_mail_generation();

create or replace function studio.trg_mail_assembly() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_title text;
begin
  if new.status not in ('done', 'failed') or old.status in ('done', 'failed') then return new; end if;
  select left(se.name || ' · ' || sc.title, 120) into v_title from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = new.scene_id;
  insert into studio.mail_queue(owner, kind, ref_id, title, link, detail)
    values (new.owner, case when new.status = 'done' then 'cut' else 'cut_failed' end, new.id, coalesce(v_title, 'Your scene'),
            '/cut/' || new.scene_id, case when new.status = 'failed' then left(new.error, 300) end);
  return new;
end $$;
drop trigger if exists mail_assembly on studio.assemblies;
create trigger mail_assembly after update of status on studio.assemblies
  for each row when (old.status is distinct from new.status) execute function studio.trg_mail_assembly();

-- The app is on screen (studio-api "me", every 20 s while visible): at most one write a minute.
create or replace function studio.touch_seen() returns void language sql security definer set search_path = '' as $$
  update studio.accounts set last_seen_at = now()
   where owner = auth.uid() and (last_seen_at is null or last_seen_at < now() - interval '1 minute') $$;
revoke execute on function studio.touch_seen() from public, anon;
grant execute on function studio.touch_seen() to authenticated;

create or replace function studio.set_email_ready(p_on boolean) returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  insert into studio.accounts(owner) values (auth.uid()) on conflict do nothing;
  update studio.accounts set email_ready = coalesce(p_on, true), updated_at = now() where owner = auth.uid();
end $$;
revoke execute on function studio.set_email_ready(boolean) from public, anon;
grant execute on function studio.set_email_ready(boolean) to authenticated;

-- For studio-mail: what can go out now, one row per account (items waiting at least 60 s, so a clip and its cut
-- finishing together go in one email). Accounts that turned emails off, or are in the app, have their rows closed here.
create or replace function studio.mail_due(p_limit int default 50)
returns table(owner uuid, email text, items jsonb)
language plpgsql security definer set search_path = '' as $$
begin
  update studio.mail_queue q set sent_at = now(), outcome = 'off'
    from studio.accounts a where a.owner = q.owner and q.sent_at is null and not a.email_ready;
  update studio.mail_queue q set sent_at = now(), outcome = 'in_app'
    from studio.accounts a where a.owner = q.owner and q.sent_at is null and a.last_seen_at > q.created_at - interval '30 seconds';
  update studio.mail_queue set sent_at = now(), outcome = 'expired' where sent_at is null and created_at < now() - interval '1 day';
  return query
  select q.owner, u.email::text, jsonb_agg(jsonb_build_object('id', q.id, 'kind', q.kind, 'title', q.title, 'link', q.link, 'detail', q.detail)
                                           order by q.created_at)
    from studio.mail_queue q join auth.users u on u.id = q.owner
   where q.sent_at is null and u.email is not null
     and q.owner in (select q2.owner from studio.mail_queue q2 where q2.sent_at is null group by q2.owner
                      having max(q2.created_at) < now() - interval '60 seconds')
     and not exists (select 1 from studio.mail_queue s where s.owner = q.owner and s.outcome = 'sent' and s.sent_at > now() - interval '10 minutes')
   group by q.owner, u.email
   limit greatest(1, least(p_limit, 200));
end $$;
revoke execute on function studio.mail_due(int) from public, anon, authenticated;
grant execute on function studio.mail_due(int) to service_role;

create or replace function studio.mail_done(p_ids bigint[], p_outcome text) returns void
language sql security definer set search_path = '' as $$
  update studio.mail_queue set sent_at = now(), outcome = left(p_outcome, 300) where id = any(p_ids) and sent_at is null $$;
revoke execute on function studio.mail_done(bigint[], text) from public, anon, authenticated;
grant execute on function studio.mail_done(bigint[], text) to service_role;
