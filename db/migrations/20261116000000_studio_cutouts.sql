-- Character reference images cut out of a shot's still (frame_jobs kind 'cutout'). @anlim
-- Why: new-setup start stills draw each character from its reference image. Uploaded crops carry the room behind the
-- character, which the image model can copy into the new setup. frame_check cutout.py cuts each character out onto
-- white: YOLOX people boxes + isnet-anime matting, intersected with "differs from the location's empty-room plate"
-- when the plate fits the still (2026-11-16: matting alone kept the sofa / rug / floor on 3 of 4 Phase 0 stills; with
-- the plate the S4 and new-setup cut-outs were clean).
-- Free: code only, no image model, no credits. The worker asks the checker service (POST /cutouts), uploads one PNG per
-- character to <owner>/characters/ and lists them in check_result.cutouts (index, path, box, warnings), left to right.
-- The creator picks which cut-out is which character: studio.use_cutout -> set_character_ref.

alter table studio.frame_jobs drop constraint if exists frame_jobs_kind_check;
alter table studio.frame_jobs add constraint frame_jobs_kind_check check (kind in ('end','start','plate','cutout'));

create or replace function studio.request_cutouts(p_shot uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_src text; v_plate text; v_id uuid;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'shot not found'; end if;
  select sh.start_frame_path, l.layout_path into v_src, v_plate
    from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id left join studio.locations l on l.id = sc.location_id
   where sh.id = p_shot;
  if v_src is null then raise exception 'this shot has no start frame to cut characters out of'; end if;
  if exists (select 1 from studio.frame_jobs where shot_id = p_shot and kind = 'cutout' and status in ('queued','running','composing')) then
    raise exception 'cut-outs are already being made from this shot'; end if;
  insert into studio.frame_jobs(owner, shot_id, kind, instruction, source_path, ref_paths, endpoint, usd, credits_reserved)
    values (v_owner, p_shot, 'cutout', 'Cut each character out onto white.', v_src,
            case when v_plate is null then '{}'::text[] else array[v_plate] end, 'local/cutout', 0, 0)
    returning id into v_id;
  return v_id;
end $$;

-- Use cut-out number p_index of a finished job as a character's reference image.
create or replace function studio.use_cutout(p_job uuid, p_index int, p_character uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare j studio.frame_jobs; v_path text; v_job_series uuid; v_char_series uuid;
begin
  select * into j from studio.frame_jobs where id = p_job;
  if not found or j.kind <> 'cutout' or (auth.uid() is not null and j.owner <> auth.uid()) then raise exception 'not found'; end if;
  if j.status not in ('ready','approved') then raise exception 'the cut-outs are %', j.status; end if;
  select sc.series_id into v_job_series from studio.shots sh join studio.scenes sc on sc.id = sh.scene_id where sh.id = j.shot_id;
  select series_id into v_char_series from studio.characters where id = p_character;
  if v_char_series is null or v_char_series <> v_job_series then raise exception 'character not found in this series'; end if;
  select c->>'path' into v_path from jsonb_array_elements(j.check_result->'cutouts') c where (c->>'index')::int = p_index;
  if v_path is null then raise exception 'no cut-out number %', p_index; end if;
  perform studio.set_character_ref(p_character, v_path);
  return v_path;
end $$;

revoke execute on function studio.request_cutouts(uuid), studio.use_cutout(uuid, int, uuid) from public, anon;
grant execute on function studio.request_cutouts(uuid), studio.use_cutout(uuid, int, uuid) to authenticated, service_role;
