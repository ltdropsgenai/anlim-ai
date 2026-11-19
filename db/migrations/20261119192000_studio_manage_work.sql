-- Managing work (2026-11-19, Londi: rename / delete scenes and series, reorder shots, delete assets). @anlim
-- Deleting returns the storage paths of the files that belonged to what was deleted; studio-api removes them from the
-- bucket with the service role. Credit history stays: credit_ledger rows keep their amounts (their links to deleted
-- clips and frames become empty, on delete set null).

create or replace function studio.rename_series(p_series uuid, p_name text)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if coalesce(trim(p_name), '') = '' then raise exception 'give the series a name'; end if;
  update studio.series set name = left(trim(p_name), 200) where id = p_series and owner = auth.uid();
  if not found then raise exception 'series not found'; end if;
end $$;

create or replace function studio.rename_scene(p_scene uuid, p_title text)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if coalesce(trim(p_title), '') = '' then raise exception 'give the scene a title'; end if;
  update studio.scenes sc set title = left(trim(p_title), 200)
    from studio.series se where sc.id = p_scene and se.id = sc.series_id and se.owner = auth.uid();
  if not found then raise exception 'scene not found'; end if;
end $$;

-- every stored file that belongs to a set of shots (clips, previews, frames, cuts, audio)
create or replace function studio.files_of_shots(p_shots uuid[])
returns setof text language sql stable security definer set search_path to '' as $$
  select p from (
    select unnest(array[g.output_path, g.preview_path]) p from studio.generations g where g.shot_id = any(p_shots)
    union all select unnest(array[f.composed_path, f.raw_path]) from studio.frame_jobs f where f.shot_id = any(p_shots)
    union all select unnest(array[sh.start_frame_path, sh.end_frame_path]) from studio.shots sh where sh.id = any(p_shots)
    union all select a.output_path from studio.audio_jobs a where a.shot_id = any(p_shots)
  ) x where p is not null
$$;
revoke all on function studio.files_of_shots(uuid[]) from public, anon, authenticated;

create or replace function studio.delete_scene(p_scene uuid)
returns setof text language plpgsql security definer set search_path to '' as $$
declare v_shots uuid[]; v_files text[];
begin
  if not exists (select 1 from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = p_scene and se.owner = auth.uid())
    then raise exception 'scene not found'; end if;
  select coalesce(array_agg(id), '{}') into v_shots from studio.shots where scene_id = p_scene;
  if exists (select 1 from unnest(v_shots) s where studio.shot_busy(s))
     or exists (select 1 from studio.assemblies where scene_id = p_scene and status in ('queued', 'running'))
     or exists (select 1 from studio.audio_jobs where scene_id = p_scene and status in ('queued', 'running'))
    then raise exception 'something in this scene is still being made; wait for it to finish'; end if;
  select coalesce(array_agg(p), '{}') into v_files from (
    select studio.files_of_shots(v_shots) p
    union all select unnest(array[a.output_path, a.preview_path]) from studio.assemblies a where a.scene_id = p_scene
    union all select a.output_path from studio.audio_jobs a where a.scene_id = p_scene and a.shot_id is null) x where p is not null;
  delete from studio.scenes where id = p_scene;      -- cascades: shots > generations, frame jobs; cuts; audio
  return query select unnest(v_files);
end $$;

create or replace function studio.delete_series(p_series uuid)
returns setof text language plpgsql security definer set search_path to '' as $$
declare v_scene uuid; v_files text[] := '{}';
begin
  if not exists (select 1 from studio.series where id = p_series and owner = auth.uid()) then raise exception 'series not found'; end if;
  if exists (select 1 from studio.frame_jobs f join studio.locations l on l.id = f.location_id
              where l.series_id = p_series and f.status in ('queued', 'running', 'composing'))
    then raise exception 'something in this series is still being made; wait for it to finish'; end if;
  for v_scene in select id from studio.scenes where series_id = p_series loop
    v_files := v_files || array(select studio.delete_scene(v_scene));
  end loop;
  v_files := v_files || array(select p from (
      select ref_front_path p from studio.characters where series_id = p_series
      union all select unnest(ref_angle_paths) from studio.characters where series_id = p_series
      union all select layout_path from studio.locations where series_id = p_series
      union all select unnest(other_plates) from studio.locations where series_id = p_series
      union all select unnest(array[f.composed_path, f.raw_path]) from studio.frame_jobs f join studio.locations l on l.id = f.location_id
                 where l.series_id = p_series) x where p is not null);
  delete from studio.series where id = p_series;     -- cascades: characters, locations, their frame jobs
  return query select unnest(v_files);
end $$;

-- move a shot one place earlier (-1) or later (+1) in its scene
create or replace function studio.move_shot(p_shot uuid, p_dir int)
returns void language plpgsql security definer set search_path to '' as $$
declare v_scene uuid; v_ord int; v_other uuid; v_other_ord int;
begin
  if studio.shot_owner(p_shot) is distinct from auth.uid() then raise exception 'shot not found'; end if;
  select scene_id, ord into v_scene, v_ord from studio.shots where id = p_shot;
  if p_dir < 0 then select id, ord into v_other, v_other_ord from studio.shots where scene_id = v_scene and ord < v_ord order by ord desc limit 1;
  else select id, ord into v_other, v_other_ord from studio.shots where scene_id = v_scene and ord > v_ord order by ord limit 1; end if;
  if v_other is null then return; end if;            -- already first / last
  update studio.shots set ord = v_other_ord where id = p_shot;
  update studio.shots set ord = v_ord where id = v_other;
end $$;

-- delete one asset from the Assets library; returns the files to remove from storage
create or replace function studio.delete_asset(p_kind text, p_id uuid)
returns setof text language plpgsql security definer set search_path to '' as $$
declare g studio.generations; f studio.frame_jobs; a studio.assemblies; au studio.audio_jobs;
begin
  if p_kind = 'clip' then
    select * into g from studio.generations where id = p_id and owner = auth.uid();
    if g.id is null then raise exception 'not found'; end if;
    if g.status in ('queued', 'running', 'checking') then raise exception 'this clip is still being made'; end if;
    if exists (select 1 from studio.shots where approved_generation_id = p_id) then
      raise exception 'this is the kept clip of its shot; keep another take first, or delete the shot'; end if;
    if exists (select 1 from studio.generations where parent_id = p_id) then
      update studio.generations set parent_id = null where parent_id = p_id; end if;
    delete from studio.generations where id = p_id;
    return query select x from unnest(array[g.output_path, g.preview_path]) x where x is not null;
  elsif p_kind = 'cut' then
    select * into a from studio.assemblies where id = p_id and owner = auth.uid();
    if a.id is null then raise exception 'not found'; end if;
    if a.status in ('queued', 'running') then raise exception 'this cut is still being made'; end if;
    delete from studio.assemblies where id = p_id;
    return query select x from unnest(array[a.output_path, a.preview_path]) x where x is not null;
  elsif p_kind = 'still' then
    select * into f from studio.frame_jobs where id = p_id and owner = auth.uid();
    if f.id is null then raise exception 'not found'; end if;
    if exists (select 1 from studio.shots where start_frame_path = f.composed_path or end_frame_path = f.composed_path) then
      raise exception 'this frame is in use by its shot; change the shot''s frame first'; end if;
    update studio.frame_jobs set status = 'discarded', composed_path = null, raw_path = null, updated_at = now() where id = p_id;
    return query select x from unnest(array[f.composed_path, f.raw_path]) x where x is not null;
  elsif p_kind in ('voice', 'sfx', 'music') then
    select * into au from studio.audio_jobs where id = p_id and owner = auth.uid();
    if au.id is null then raise exception 'not found'; end if;
    if au.status in ('queued', 'running') then raise exception 'this is still being made'; end if;
    delete from studio.audio_jobs where id = p_id;
    return query select x from unnest(array[au.output_path]) x where x is not null;
  else
    raise exception 'this kind of asset is managed in Cast & places';
  end if;
end $$;

revoke all on function studio.rename_series(uuid, text), studio.rename_scene(uuid, text), studio.delete_scene(uuid),
  studio.delete_series(uuid), studio.move_shot(uuid, int), studio.delete_asset(text, uuid) from public, anon;
grant execute on function studio.rename_series(uuid, text), studio.rename_scene(uuid, text), studio.delete_scene(uuid),
  studio.delete_series(uuid), studio.move_shot(uuid, int), studio.delete_asset(text, uuid) to authenticated;
