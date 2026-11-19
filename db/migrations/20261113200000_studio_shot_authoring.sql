-- Creating scenes and shots in the app (until now: SQL by hand). @anlim
-- Writes go through these functions so the rules hold in one place:
--   a new start still is unapproved and drops the end frame made from the old one;
--   a shot can't be edited or deleted while a render or an end frame is being made;
--   a shot with renders is kept (history), not deleted.
-- Start stills are uploaded by the app straight to storage under <owner>/stills/ (policy studio_files_write).

create or replace function studio.create_scene(p_series uuid, p_title text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_id uuid;
begin
  select owner into v_owner from studio.series where id = p_series;
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'series not found'; end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'give the scene a title'; end if;
  insert into studio.scenes(series_id, ord, title)
    values (p_series, coalesce((select max(ord) from studio.scenes where series_id = p_series), 0) + 1, left(trim(p_title), 200))
    returning id into v_id;
  return v_id;
end $$;

create or replace function studio.create_shot(p_scene uuid, p_action text, p_camera text default 'locked', p_duration int default 5)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_id uuid;
begin
  select se.owner into v_owner from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = p_scene;
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'scene not found'; end if;
  if coalesce(trim(p_action), '') = '' then raise exception 'say what happens in the shot'; end if;
  if p_duration not between 3 and 30 then raise exception 'a shot is 3 to 30 seconds'; end if;
  insert into studio.shots(scene_id, ord, action, camera, duration_s, status)
    values (p_scene, coalesce((select max(ord) from studio.shots where scene_id = p_scene), 0) + 1,
            left(trim(p_action), 2000), nullif(left(trim(coalesce(p_camera, '')), 200), ''), p_duration, 'draft')
    returning id into v_id;
  return v_id;
end $$;

-- busy = a render or an end frame in flight
create or replace function studio.shot_busy(p_shot uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from studio.generations where shot_id = p_shot and status in ('queued','running','checking'))
      or exists (select 1 from studio.frame_jobs where shot_id = p_shot and status in ('queued','running','composing'))
$$;

create or replace function studio.update_shot(p_shot uuid, p_action text, p_camera text, p_duration int)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if studio.shot_owner(p_shot) is null or (auth.uid() is not null and auth.uid() <> studio.shot_owner(p_shot)) then
    raise exception 'shot not found'; end if;
  if studio.shot_busy(p_shot) then raise exception 'wait until the render or end frame in progress is done'; end if;
  if coalesce(trim(p_action), '') = '' then raise exception 'say what happens in the shot'; end if;
  if p_duration not between 3 and 30 then raise exception 'a shot is 3 to 30 seconds'; end if;
  update studio.shots set action = left(trim(p_action), 2000), camera = nullif(left(trim(coalesce(p_camera, '')), 200), ''),
         duration_s = p_duration where id = p_shot;
end $$;

-- New start still (already uploaded by the app). Unapproved until the creator approves it; the old end frame was
-- drawn from the old still, so it goes too.
create or replace function studio.set_start_frame(p_shot uuid, p_path text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'shot not found'; end if;
  if studio.shot_busy(p_shot) then raise exception 'wait until the render or end frame in progress is done'; end if;
  if p_path is null or p_path !~ ('^' || v_owner::text || '/stills/[A-Za-z0-9._-]{1,120}\.(png|jpg|jpeg|webp)$') or p_path like '%..%' then
    raise exception 'bad file path'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'studio' and name = p_path) then
    raise exception 'upload the image first'; end if;
  update studio.frame_jobs set status = 'discarded', updated_at = now() where shot_id = p_shot and status in ('ready','approved');
  update studio.shots set start_frame_path = p_path, start_frame_approved = false,
         end_frame_path = null, end_frame_approved = false, status = 'draft' where id = p_shot;
end $$;

create or replace function studio.approve_start_frame(p_shot uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_shot studio.shots;
begin
  if studio.shot_owner(p_shot) is null or (auth.uid() is not null and auth.uid() <> studio.shot_owner(p_shot)) then
    raise exception 'shot not found'; end if;
  select * into v_shot from studio.shots where id = p_shot for update;
  if v_shot.start_frame_path is null then raise exception 'add a start frame first'; end if;
  update studio.shots set start_frame_approved = true,
         status = case when status = 'draft' then 'ready' else status end where id = p_shot;
end $$;

-- Delete a shot that was never rendered (rendered shots keep their history).
create or replace function studio.delete_shot(p_shot uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if studio.shot_owner(p_shot) is null or (auth.uid() is not null and auth.uid() <> studio.shot_owner(p_shot)) then
    raise exception 'shot not found'; end if;
  if exists (select 1 from studio.generations where shot_id = p_shot) then raise exception 'this shot has renders; it is kept'; end if;
  if exists (select 1 from studio.frame_jobs where shot_id = p_shot and settled = 'charged') then
    raise exception 'this shot has a paid end frame; it is kept'; end if;
  delete from studio.frame_jobs where shot_id = p_shot;
  delete from studio.shots where id = p_shot;
end $$;

revoke execute on all functions in schema studio from public, anon;
grant execute on function studio.create_scene(uuid, text), studio.create_shot(uuid, text, text, int),
  studio.update_shot(uuid, text, text, int), studio.set_start_frame(uuid, text), studio.approve_start_frame(uuid),
  studio.delete_shot(uuid), studio.shot_busy(uuid) to authenticated;
