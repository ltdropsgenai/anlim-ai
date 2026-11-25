-- 2026-11-25 (Number 10 recreation, Londi): two pieces the "frozen moment" beats need. @anlim
-- 1. An uploaded image as a shot's end frame. The beat is a camera swing around frozen players between two stills made
--    together (the end frame first, then the start frame as "the same moment from a camera 90 degrees to the left").
--    Swing test 4 (Kling 3.0, start df90ac46 -> end ce424b58) kept the #10 on the ball only when both stills described
--    one consistent moment; anlim's own end-frame modes edit the start still and cannot move the camera.
--    An uploaded end frame is approved when it is set (as set_start_frame + approve_start_frame do), and the worker's
--    end-frame gate (only the characters may change) does not apply to it: a new camera angle changes the whole frame
--    by design. end_frame_upload_path remembers which path came from an upload, so a made end frame approved later
--    (decide_frame writes end_frame_path) is checked again without touching decide_frame.
-- 2. Hold a shot's last frame for N seconds in the scene cut (the concept video holds each landed angle about 1 s,
--    frame-to-frame difference ~0.2 from 25.0 to 26.0 s). The worker already pads with the last frame (tpad clone).

alter table studio.shots
  add column if not exists end_frame_upload_path text,
  add column if not exists hold_end_s numeric not null default 0 check (hold_end_s >= 0 and hold_end_s <= 5);

create or replace function studio.set_end_frame(p_shot uuid, p_path text)
returns void language plpgsql security definer set search_path to '' as $$
declare v_owner uuid; v_start text;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null or auth.uid() is null or auth.uid() <> v_owner then raise exception 'shot not found'; end if;
  if studio.shot_busy(p_shot) then raise exception 'wait until the render or end frame in progress is done'; end if;
  if p_path is null or p_path !~ ('^' || v_owner::text || '/stills/[A-Za-z0-9._-]{1,120}\.(png|jpg|jpeg|webp)$') or p_path like '%..%' then
    raise exception 'bad file path'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'studio' and name = p_path) then
    raise exception 'upload the image first'; end if;
  select start_frame_path into v_start from studio.shots where id = p_shot for update;
  if v_start is null then raise exception 'give the shot a start image first (set_start_image or make_start_image)'; end if;
  if not studio.made_by_anlim(v_owner, p_path) and not studio.has_likeness_consent(v_owner, p_path) then
    raise exception 'Confirm that any real person in this picture is you or agreed to it (likeness consent).'; end if;
  -- an end frame made earlier (waiting or approved) gives way to the uploaded one
  update studio.frame_jobs set status = 'discarded', updated_at = now()
   where shot_id = p_shot and kind = 'end' and status in ('ready', 'approved');
  update studio.shots set end_frame_path = p_path, end_frame_approved = true, end_frame_upload_path = p_path
   where id = p_shot;
end $$;

create or replace function studio.set_shot_hold(p_shot uuid, p_seconds numeric)
returns void language plpgsql security definer set search_path to '' as $$
declare v_owner uuid;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null or auth.uid() is null or auth.uid() <> v_owner then raise exception 'shot not found'; end if;
  if p_seconds is null or p_seconds < 0 or p_seconds > 5 then raise exception 'hold is 0 to 5 seconds'; end if;
  update studio.shots set hold_end_s = round(p_seconds, 2) where id = p_shot;
end $$;

-- the scene cut carries each shot's hold to the worker (live definition of 2026-11-24, plus 'hold')
create or replace function studio.request_assembly(p_scene uuid, p_format text, p_options jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path to '' as $function$
declare v_owner uuid; v_items jsonb; v_skipped jsonb; v_music text; v_id uuid; v_opts jsonb; v_slow numeric; n int; v_look text;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select se.owner into v_owner from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = p_scene;
  if v_owner is null or v_owner <> auth.uid() then raise exception 'scene not found'; end if;
  if p_format not in ('16x9', '9x16', '4x5', '1x1', '4x3', '3x4', '21x9') then
    raise exception 'format must be 16x9, 9x16, 4x5, 1x1, 4x3, 3x4 or 21x9'; end if;
  perform 1 from studio.accounts where owner = v_owner for update;
  if exists (select 1 from studio.assemblies where owner = v_owner and status in ('queued', 'running')) then
    raise exception 'a cut is already being made; wait for it to finish';
  end if;
  select count(*) into n from studio.assemblies where owner = v_owner and created_at > now() - interval '1 hour';
  if n >= 20 then raise exception 'you made 20 cuts in the last hour; try again in a while'; end if;
  v_music := nullif(trim(coalesce(p_options->>'music_path', '')), '');
  if v_music is not null and (left(v_music, 37) <> v_owner::text || '/' or v_music like '%..%') then
    raise exception 'music must be a file you uploaded or a score made for you';
  end if;
  v_look := nullif(trim(coalesce(p_options->'style'->>'look_ref', '')), '');
  if v_look is not null and (left(v_look, 37) <> v_owner::text || '/' or v_look like '%..%' or v_look !~* '\.(png|jpe?g|webp)$') then
    v_look := null;
  end if;
  v_opts := jsonb_build_object('fade', coalesce((p_options->>'fade')::boolean, true),
                               'end_card', coalesce((p_options->>'end_card')::boolean, false),
                               'music_path', v_music,
                               'voice', coalesce((p_options->>'voice')::boolean, true),
                               'sfx', coalesce((p_options->>'sfx')::boolean, true),
                               'captions', coalesce((p_options->>'captions')::boolean, false),
                               'style', case when jsonb_typeof(p_options->'style') = 'object' and p_options->'style'->>'preset' = 'story' then
                                 jsonb_build_object('preset', 'story',
                                   'transitions', case when p_options->'style'->>'transitions' in ('mixed', 'flash', 'whip', 'zoom', 'spin', 'glitch', 'punch', 'cut')
                                                       then p_options->'style'->>'transitions' else 'mixed' end,
                                   'grade', coalesce((p_options->'style'->>'grade')::boolean, true),
                                   'push', coalesce((p_options->'style'->>'push')::boolean, true),
                                   'rain', coalesce((p_options->'style'->>'rain')::boolean, false),
                                   'drops', coalesce((p_options->'style'->>'drops')::boolean, false),
                                   'look_ref', v_look,
                                   'hits', coalesce((p_options->'style'->>'hits')::boolean, true),
                                   'beat_sync', coalesce((p_options->'style'->>'beat_sync')::boolean, true),
                                   'title', nullif(left(btrim(regexp_replace(coalesce(p_options->'style'->>'title', ''), '[[:cntrl:]]+', ' ', 'g')), 60), ''),
                                   'handle', nullif(left(btrim(regexp_replace(coalesce(p_options->'style'->>'handle', ''), '[[:cntrl:]]+', ' ', 'g')), 30), ''))
                               end,
                               'narration', (select jsonb_build_object('path', a.output_path,
                                                     'at_s', coalesce(nullif(a.input->>'at_s', '')::numeric, 0))
                                               from studio.audio_jobs a
                                              where a.scene_id = p_scene and a.shot_id is null and a.kind = 'voiceover'
                                                and a.in_cut and a.status = 'done' order by a.created_at desc limit 1));
  select coalesce(jsonb_agg(jsonb_build_object('shot_id', sh.id, 'ord', sh.ord, 'generation_id', g.id, 'path', g.output_path,
           'trim_start', sh.trim_start_s, 'trim_end', sh.trim_end_s, 'speed', sh.speed, 'hold', sh.hold_end_s, 'words', sh.words,
           'vo', (select a.output_path from studio.audio_jobs a where a.shot_id = sh.id and a.kind = 'voiceover' and a.in_cut and a.status = 'done' order by a.created_at desc limit 1),
           'sfx', (select a.output_path from studio.audio_jobs a where a.shot_id = sh.id and a.kind = 'sfx' and a.in_cut and a.status = 'done' order by a.created_at desc limit 1))
                            order by sh.ord), '[]'::jsonb)
    into v_items
    from studio.shots sh join studio.generations g on g.id = sh.approved_generation_id
   where sh.scene_id = p_scene and g.output_path is not null;
  if jsonb_array_length(v_items) = 0 then raise exception 'approve at least one clip in this scene first'; end if;
  select coalesce(sum(greatest(1, coalesce(g.clip_s, sh.duration_s) - sh.trim_start_s - sh.trim_end_s) / sh.speed), 0) into v_slow
    from studio.shots sh join studio.generations g on g.id = sh.approved_generation_id
   where sh.scene_id = p_scene and g.output_path is not null and sh.speed < 1;
  if v_slow > 180 then
    raise exception 'the slowed shots come to % s in this cut; at most 180 s of slowed shots fit in one cut', round(v_slow); end if;
  select coalesce(jsonb_agg(sh.ord order by sh.ord), '[]'::jsonb) into v_skipped
    from studio.shots sh left join studio.generations g on g.id = sh.approved_generation_id
   where sh.scene_id = p_scene and (sh.approved_generation_id is null or g.output_path is null);
  insert into studio.assemblies(owner, scene_id, format, options, items, skipped)
  values (v_owner, p_scene, p_format, v_opts, v_items, v_skipped) returning id into v_id;
  return v_id;
end $function$;

revoke all on function studio.set_end_frame(uuid, text) from public, anon;
grant execute on function studio.set_end_frame(uuid, text) to authenticated;
revoke all on function studio.set_shot_hold(uuid, numeric) from public, anon;
grant execute on function studio.set_shot_hold(uuid, numeric) to authenticated;
