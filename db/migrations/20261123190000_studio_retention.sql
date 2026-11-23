-- Storage clean-up (2026-11-23, Londi: "yes" to removing what nobody kept). @anlim
-- Nothing was ever removed except when a creator deleted something or their account, so rejected and failed clips,
-- discarded frames and every old cut stayed in the studio bucket for good. After RETENTION days these are removed:
--   * clips that failed or were rejected (a pending refund request keeps its clip until 30 days after the decision);
--   * start and end frames the creator discarded;
--   * cuts of a scene older than 30 days, except the scene's 3 newest.
-- Never removed: kept (approved) clips, clips waiting for review, approved or waiting frames, characters, locations,
-- uploads, audio, and any file that a kept row still points to. The sweep runs in the studio-storage Edge Function
-- (service role), started once a day by the worker; the worker never names a file, so its token cannot delete anything
-- the sweep did not choose. Each removal is logged in studio.retention_log.

create table if not exists studio.retention_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null check (kind in ('clip', 'frame', 'cut')),
  ref_id uuid not null,
  owner uuid,
  paths text[] not null,
  bytes bigint not null default 0
);
alter table studio.retention_log enable row level security;   -- no policies: server-side only
revoke all on studio.retention_log from public, anon, authenticated;

-- What may go now: one row per clip, frame or cut, with the files to remove and their owner. Files any kept row
-- still points to are left out of the list (and the row is then skipped).
create or replace function studio.retention_due(p_days int default 30, p_limit int default 200)
returns table(kind text, ref_id uuid, owner uuid, paths text[], bytes bigint)
language sql stable security definer set search_path = '' as $$
  with keep as (
    select start_frame_path as p from studio.shots where start_frame_path is not null
    union select end_frame_path from studio.shots where end_frame_path is not null
    union select motion_source_path from studio.shots where motion_source_path is not null
    union select unnest(motion_ref_paths) from studio.shots where motion_ref_paths is not null
    union select ref_front_path from studio.characters where ref_front_path is not null
    union select layout_path from studio.locations where layout_path is not null
    union select unnest(other_plates) from studio.locations where other_plates is not null
    union select g.output_path from studio.generations g join studio.shots sh on sh.approved_generation_id = g.id
    union select g.preview_path from studio.generations g join studio.shots sh on sh.approved_generation_id = g.id
    union select output_path from studio.audio_jobs where output_path is not null
  ),
  cand as (
    select 'clip'::text as kind, g.id as ref_id, g.owner,
           array_remove(array[g.output_path, g.preview_path], null) as paths
      from studio.generations g
      left join studio.refund_requests rr on rr.generation_id = g.id
     where g.status = 'failed' and (g.output_path is not null or g.preview_path is not null)
       and not exists (select 1 from studio.shots sh where sh.approved_generation_id = g.id)
       and coalesce(rr.status, 'none') <> 'pending'
       and coalesce(rr.decided_at, g.updated_at, g.created_at) < now() - make_interval(days => p_days)
    union all
    select 'frame', f.id, sc_owner.owner, array[f.composed_path]
      from studio.frame_jobs f
      join lateral (select se.owner from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id
                      join studio.series se on se.id = sc.series_id where sh.id = f.shot_id) sc_owner on true
     where f.status = 'discarded' and f.composed_path is not null
       and coalesce(f.updated_at, f.created_at) < now() - make_interval(days => p_days)
    union all
    select 'cut', a.id, se.owner, array_remove(array[a.output_path, a.preview_path], null)
      from (select a.*, row_number() over (partition by a.scene_id order by a.created_at desc) as n
              from studio.assemblies a where a.status = 'done') a
      join studio.scenes sc on sc.id = a.scene_id join studio.series se on se.id = sc.series_id
     where a.n > 3 and (a.output_path is not null or a.preview_path is not null)
       and a.created_at < now() - make_interval(days => p_days)
  )
  select c.kind, c.ref_id, c.owner, c.paths,
         coalesce((select sum((o.metadata->>'size')::bigint) from storage.objects o
                    where o.bucket_id = 'studio' and o.name = any(c.paths)), 0)::bigint
    from cand c
   where c.owner is not null and cardinality(c.paths) > 0
     and not exists (select 1 from keep k where k.p = any(c.paths))
   limit greatest(1, least(p_limit, 500));
$$;
revoke execute on function studio.retention_due(int, int) from public, anon, authenticated;
grant execute on function studio.retention_due(int, int) to service_role;

-- After the files are removed: the row stops pointing at them (Assets and Review then leave it out), and it is logged.
create or replace function studio.retention_done(p_kind text, p_id uuid, p_owner uuid, p_paths text[], p_bytes bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_kind = 'clip' then
    update studio.generations set output_path = null, preview_path = null where id = p_id and status = 'failed';
  elsif p_kind = 'frame' then
    update studio.frame_jobs set composed_path = null where id = p_id and status = 'discarded';
  elsif p_kind = 'cut' then
    update studio.assemblies set output_path = null, preview_path = null where id = p_id;
  else
    raise exception 'unknown kind %', p_kind;
  end if;
  insert into studio.retention_log(kind, ref_id, owner, paths, bytes) values (p_kind, p_id, p_owner, p_paths, coalesce(p_bytes, 0));
end $$;
revoke execute on function studio.retention_done(text, uuid, uuid, text[], bigint) from public, anon, authenticated;
grant execute on function studio.retention_done(text, uuid, uuid, text[], bigint) to service_role;

-- How much a creator stores (Account page): their own folder in the studio bucket.
create or replace function studio.my_storage()
returns table(bytes bigint, files bigint)
language sql stable security definer set search_path = '' as $$
  select coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint, count(*)::bigint
    from storage.objects o
   where o.bucket_id = 'studio' and auth.uid() is not null and o.name like auth.uid()::text || '/%';
$$;
revoke execute on function studio.my_storage() from public, anon;
grant execute on function studio.my_storage() to authenticated;
