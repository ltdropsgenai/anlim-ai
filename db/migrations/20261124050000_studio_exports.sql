-- Download a whole project (2026-11-23, Londi: "all of the above"). @anlim
-- The worker gathers a project's kept clips, its latest cuts (and their captions), approved start and end frames,
-- cast and place pictures and the audio in its cuts into zip files (stored, not compressed: video does not shrink),
-- at most 100 MB each (the worker reads an upload into memory whole). One export per project is kept: a new one
-- replaces the files of the last. Free accounts get the watermarked copies, as everywhere else.

create table if not exists studio.exports (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  series_id uuid not null references studio.series(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  parts jsonb,                         -- [{path, bytes, files}]
  files int, bytes bigint, error text,
  tries int not null default 0, locked_by text, locked_until timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists exports_series on studio.exports(series_id, created_at desc);
alter table studio.exports enable row level security;
revoke all on studio.exports from public, anon, authenticated;
grant select on studio.exports to authenticated;
create policy exports_own on studio.exports for select to authenticated using (owner = auth.uid());
grant select, update on studio.exports to studio_worker;
create policy worker_exports on studio.exports for all to studio_worker using (true) with check (true);

create or replace function studio.request_export(p_series uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_id uuid;
begin
  if v_uid is null then raise exception 'sign in first'; end if;
  if not exists (select 1 from studio.series where id = p_series and owner = v_uid) then raise exception 'project not found'; end if;
  perform pg_advisory_xact_lock(hashtext('export:' || v_uid::text));
  if exists (select 1 from studio.exports where owner = v_uid and status in ('queued', 'running')) then
    raise exception 'A download is already being prepared; wait for it to finish.'; end if;
  if (select count(*) from studio.exports where owner = v_uid and created_at > now() - interval '1 day') >= 10 then
    raise exception 'You prepared 10 downloads today; try again tomorrow.'; end if;
  insert into studio.exports(owner, series_id) values (v_uid, p_series) returning id into v_id;
  return v_id;
end $$;
revoke execute on function studio.request_export(uuid) from public, anon;
grant execute on function studio.request_export(uuid) to authenticated;

create or replace function studio.claim_exports(p_worker text, p_lease_s int default 1800)
returns setof studio.exports language plpgsql security definer set search_path = '' as $$
begin
  return query
  update studio.exports e set status = 'running', locked_by = p_worker, locked_until = now() + make_interval(secs => p_lease_s),
         tries = e.tries + 1, updated_at = now()
   where e.id in (select id from studio.exports where (status = 'queued' or (status = 'running' and locked_until < now()))
                   order by created_at limit 1 for update skip locked)
  returning e.*;
end $$;
revoke execute on function studio.claim_exports(text, int) from public, anon, authenticated;
grant execute on function studio.claim_exports(text, int) to studio_worker;

-- Everything an export takes, as stored paths with names for inside the zip (worker/src/export.js).
create or replace function studio.export_manifest(p_export uuid)
returns table(path text, name text) language plpgsql stable security definer set search_path = '' as $$
declare e studio.exports; v_paid boolean;
begin
  select * into e from studio.exports where id = p_export;
  if not found then raise exception 'export not found'; end if;
  v_paid := studio.has_paid(e.owner);
  return query
  with sc as (
    select s.id, s.ord, regexp_replace(coalesce(nullif(s.title, ''), 'Scene'), '[^A-Za-z0-9 ._-]+', '', 'g') as t
      from studio.scenes s where s.series_id = e.series_id
  ), files as (
    -- kept clips
    select case when v_paid then g.output_path else g.preview_path end as p,
           format('%s %s/shot-%s-clip.mp4', lpad(sc.ord::text, 2, '0'), sc.t, lpad(sh.ord::text, 2, '0')) as n
      from sc join studio.shots sh on sh.scene_id = sc.id join studio.generations g on g.id = sh.approved_generation_id
    union all
    select sh.start_frame_path, format('%s %s/shot-%s-start%s', lpad(sc.ord::text, 2, '0'), sc.t, lpad(sh.ord::text, 2, '0'),
                                       coalesce(substring(sh.start_frame_path from '\.[A-Za-z0-9]+$'), '.png'))
      from sc join studio.shots sh on sh.scene_id = sc.id where sh.start_frame_approved
    union all
    select sh.end_frame_path, format('%s %s/shot-%s-end%s', lpad(sc.ord::text, 2, '0'), sc.t, lpad(sh.ord::text, 2, '0'),
                                     coalesce(substring(sh.end_frame_path from '\.[A-Za-z0-9]+$'), '.png'))
      from sc join studio.shots sh on sh.scene_id = sc.id where sh.end_frame_approved
    union all
    -- each scene's 3 newest finished cuts, and their captions
    select case when v_paid then a.output_path else a.preview_path end,
           format('%s %s/cut-%s-%s.mp4', lpad(sc.ord::text, 2, '0'), sc.t, a.format, to_char(a.created_at, 'YYYY-MM-DD-HH24MI'))
      from sc join lateral (select * from studio.assemblies x where x.scene_id = sc.id and x.status = 'done' order by x.created_at desc limit 3) a on true
    union all
    select a.report -> 'captions' ->> 'srt',
           format('%s %s/cut-%s-%s.srt', lpad(sc.ord::text, 2, '0'), sc.t, a.format, to_char(a.created_at, 'YYYY-MM-DD-HH24MI'))
      from sc join lateral (select * from studio.assemblies x where x.scene_id = sc.id and x.status = 'done' order by x.created_at desc limit 3) a on true
    union all
    -- the audio in the cut
    select au.output_path, format('%s %s/audio/%s-%s.mp3', lpad(sc.ord::text, 2, '0'), sc.t,
                                  coalesce('shot-' || lpad(sh.ord::text, 2, '0'), 'scene'), au.kind)
      from sc join studio.audio_jobs au on au.scene_id = sc.id left join studio.shots sh on sh.id = au.shot_id
     where au.in_cut and au.status = 'done'
    union all
    select c.ref_front_path, format('cast/%s%s', regexp_replace(c.name, '[^A-Za-z0-9 ._-]+', '', 'g'),
                                    coalesce(substring(c.ref_front_path from '\.[A-Za-z0-9]+$'), '.png'))
      from studio.characters c where c.series_id = e.series_id
    union all
    select l.layout_path, format('places/%s%s', regexp_replace(l.name, '[^A-Za-z0-9 ._-]+', '', 'g'),
                                 coalesce(substring(l.layout_path from '\.[A-Za-z0-9]+$'), '.png'))
      from studio.locations l where l.series_id = e.series_id
  )
  select distinct on (f.n) f.p, f.n from files f
   where f.p is not null and f.p not like '%..%'
     and (split_part(f.p, '/', 1) = e.owner::text or f.p like '00000000-0000-0000-0000-000000000000/clean/' || e.owner::text || '/%');
end $$;
revoke execute on function studio.export_manifest(uuid) from public, anon, authenticated;
grant execute on function studio.export_manifest(uuid) to studio_worker;
