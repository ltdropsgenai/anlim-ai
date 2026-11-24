-- Story edit v2 and "recreate this frame" (2026-11-24, Londi: build what the reference edit does that anlim did not). @anlim
-- 1. request_assembly keeps the new style fields: transitions "zoom" and "spin" (the reference's zoom and spin whips),
--    "drops" (drops on the lens, bending the picture) and "look_ref" (a picture of the creator's whose colours every shot
--    is matched to). Copied from 20261124090000 (live definition of 2026-11-24) with only the style object changed.
-- 2. request_start_frame gets the mode "restyle": a picture the creator uploaded (a frame taken from a video, a photo) is
--    redrawn in the project's look, keeping its composition, camera and poses. In a cartoon project anyone may be redrawn
--    (a recognisable cartoon of a real person is allowed unless it is sexual, humiliating or deceptive: the content check
--    still runs on every job). In a photoreal project the picture needs the creator's likeness confirmation (Londi,
--    2026-11-24: "B limited as recommended": real people in photoreal only when they are the creator or agreed).

CREATE OR REPLACE FUNCTION studio.request_assembly(p_scene uuid, p_format text, p_options jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_owner uuid; v_items jsonb; v_skipped jsonb; v_music text; v_id uuid; v_opts jsonb; v_slow numeric; n int; v_look text;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select se.owner into v_owner from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = p_scene;
  if v_owner is null or v_owner <> auth.uid() then raise exception 'scene not found'; end if;
  if p_format not in ('16x9', '9x16', '4x5', '1x1', '4x3', '3x4', '21x9') then
    raise exception 'format must be 16x9, 9x16, 4x5, 1x1, 4x3, 3x4 or 21x9'; end if;
  -- 2026-11-23 (review): one request at a time per account (a double click queued two cuts), and at most 20 an hour
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
  -- 2026-11-24: the look picture, only from the creator's own folder and only a picture
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
                               -- 2026-11-23: the edit style (worker/src/editstyle.js); only "story" is kept, anything else is plain (null)
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
                               -- 2026-11-23: the scene's narration (a voiceover with no shot) and where it starts in the cut
                               'narration', (select jsonb_build_object('path', a.output_path,
                                                     'at_s', coalesce(nullif(a.input->>'at_s', '')::numeric, 0))
                                               from studio.audio_jobs a
                                              where a.scene_id = p_scene and a.shot_id is null and a.kind = 'voiceover'
                                                and a.in_cut and a.status = 'done' order by a.created_at desc limit 1));
  select coalesce(jsonb_agg(jsonb_build_object('shot_id', sh.id, 'ord', sh.ord, 'generation_id', g.id, 'path', g.output_path,
           'trim_start', sh.trim_start_s, 'trim_end', sh.trim_end_s, 'speed', sh.speed, 'words', sh.words,
           'vo', (select a.output_path from studio.audio_jobs a where a.shot_id = sh.id and a.kind = 'voiceover' and a.in_cut and a.status = 'done' order by a.created_at desc limit 1),
           'sfx', (select a.output_path from studio.audio_jobs a where a.shot_id = sh.id and a.kind = 'sfx' and a.in_cut and a.status = 'done' order by a.created_at desc limit 1))
                            order by sh.ord), '[]'::jsonb)
    into v_items
    from studio.shots sh join studio.generations g on g.id = sh.approved_generation_id
   where sh.scene_id = p_scene and g.output_path is not null;
  if jsonb_array_length(v_items) = 0 then raise exception 'approve at least one clip in this scene first'; end if;
  -- slowed shots are rebuilt frame by frame (motion interpolation, minutes per shot): at most 3 minutes of them in one cut
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

CREATE OR REPLACE FUNCTION studio.request_start_frame(p_shot uuid, p_mode text, p_instruction text DEFAULT NULL::text, p_source text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_owner uuid; v_shot studio.shots; v_prev studio.shots; v_prev_clip text; v_src text; v_cost int := 20;
        v_ins text := nullif(trim(coalesce(p_instruction, '')), ''); v_id uuid; v_plate text;
        v_refs text[]; v_names text[]; v_heights numeric[]; v_missing text; v_n int; v_endpoint text := 'fal-ai/nano-banana-2/edit';
        v_look text;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null or (auth.uid() is not null and auth.uid() <> v_owner) then raise exception 'shot not found'; end if;
  if p_mode not in ('continue','reposition','new_setup','prompt','restyle') then raise exception 'mode must be continue, reposition, new_setup, prompt or restyle'; end if;
  if length(coalesce(v_ins, '')) > 1000 then raise exception 'keep it under 1000 characters'; end if;
  select * into v_shot from studio.shots where id = p_shot for update;
  if studio.shot_busy(p_shot) then raise exception 'wait until the render or frame in progress is done'; end if;
  select se.look into v_look from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = v_shot.scene_id;
  select * into v_prev from studio.shots where scene_id = v_shot.scene_id and ord < v_shot.ord order by ord desc limit 1;
  if v_prev.id is not null and v_prev.approved_generation_id is not null then
    select output_path into v_prev_clip from studio.generations where id = v_prev.approved_generation_id;
  end if;

  if p_mode = 'prompt' then
    v_ins := coalesce(v_ins, left(v_shot.action, 1000));
    if v_ins is null then raise exception 'say what happens in the shot first'; end if;
    v_src := null; v_endpoint := 'fal-ai/nano-banana-2';
  elsif p_mode = 'restyle' then
    -- 2026-11-24: an uploaded picture redrawn in the project's look (worker frames.js restylePrompt)
    v_src := nullif(trim(coalesce(p_source, '')), '');
    if v_src is null or left(v_src, 37) <> v_owner::text || '/' or v_src like '%..%' or v_src !~* '\.(png|jpe?g|webp)$' then
      raise exception 'upload the image first'; end if;
    if v_look = 'photoreal' and not studio.has_likeness_consent(v_owner, v_src) then
      raise exception 'Confirm that any real person in this picture is you or agreed to it (likeness consent).'; end if;
    v_ins := coalesce(v_ins, left(v_shot.action, 1000));
  elsif p_mode = 'continue' then
    if v_prev.id is null then raise exception 'this is the first shot of the scene: there is no previous clip to continue from'; end if;
    if v_prev_clip is null then raise exception 'approve a clip of the previous shot first'; end if;
    v_src := v_prev_clip; v_cost := 0; v_endpoint := 'local/last-frame';
    v_ins := coalesce(v_ins, 'Continue from the last frame of the previous shot.');
  elsif p_mode = 'reposition' then
    if v_ins is null then raise exception 'say where everyone is and what they are doing'; end if;
    if p_source is not null and p_source not in ('prev_last','this_start','prev_start') then
      raise exception 'source must be prev_last, this_start or prev_start'; end if;
    v_src := case coalesce(p_source, case when v_prev_clip is not null then 'prev_last'
                                          when v_shot.start_frame_path is not null then 'this_start' else 'prev_start' end)
               when 'prev_last' then v_prev_clip when 'this_start' then v_shot.start_frame_path
               when 'prev_start' then case when v_prev.start_frame_approved then v_prev.start_frame_path end end;
    if v_src is null then raise exception 'no still to start from: add a start frame, or approve the previous shot''s start frame or clip'; end if;
  else
    if v_ins is null then raise exception 'say where everyone is and what they are doing'; end if;
    select l.layout_path into v_plate from studio.scenes sc left join studio.locations l on l.id = sc.location_id where sc.id = v_shot.scene_id;
    if v_plate is null then raise exception 'give the scene a location with an empty-room plate first'; end if;
    select array_agg(c.ref_front_path order by c.height_units desc nulls last, c.name), array_agg(c.name order by c.height_units desc nulls last, c.name),
           array_agg(c.height_units order by c.height_units desc nulls last, c.name), count(*),
           string_agg(c.name, ', ') filter (where c.ref_front_path is null)
      into v_refs, v_names, v_heights, v_n, v_missing
      from studio.characters c join studio.scenes sc on sc.series_id = c.series_id
     where sc.id = v_shot.scene_id and (cardinality(v_shot.cast_ids) = 0 or c.id = any(v_shot.cast_ids));
    if coalesce(v_n, 0) = 0 then raise exception 'the shot has nobody in it: add characters to the series or the shot'; end if;
    if v_missing is not null then raise exception 'add a reference image for %', v_missing; end if;
    if v_n > 6 then raise exception 'at most 6 characters in a new setup (this shot has %)', v_n; end if;
    v_src := v_plate;
    if v_look = 'photoreal' then v_endpoint := 'openai/gpt-image-2.6/sunburst/edit'; v_cost := 17 + 3 * v_n; end if;
  end if;

  perform studio.reserve_frame_credits(v_owner, v_cost);
  insert into studio.frame_jobs(owner, shot_id, kind, mode, instruction, source_path, ref_paths, ref_names, ref_heights,
                                endpoint, usd, credits_reserved)
    values (v_owner, p_shot, 'start', p_mode, v_ins, v_src, coalesce(v_refs, '{}'), coalesce(v_names, '{}'), coalesce(v_heights, '{}'),
            v_endpoint, case when v_cost = 0 then 0 when v_endpoint like 'openai/gpt-image%' then 0.068 + 0.012 * coalesce(v_n, 2) else 0.08 end, v_cost)
    returning id into v_id;
  if v_cost > 0 then insert into studio.credit_ledger(owner, kind, credits, frame_job_id) values (v_owner, 'reserve', v_cost, v_id); end if;
  return v_id;
end $function$;

-- frame_jobs.mode accepts "restyle"
alter table studio.frame_jobs drop constraint if exists frame_jobs_mode_check;
alter table studio.frame_jobs add constraint frame_jobs_mode_check
  check (mode = any (array['continue', 'reposition', 'new_setup', 'prompt', 'restyle']));
