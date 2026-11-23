-- 2026-11-23: fixes from the review of 2026-11-22's code (bugs and security). @anlim
-- 1. generations.clip_s: the delivered clip's real length (the worker fills it); trims and the score use it when known.
-- 2. set_shot_trim, set_shot_speed, request_end_setup: the owner check now refuses a caller with no user (auth.uid() null)
--    instead of letting it through. Only creators call these, as themselves; a future service-role caller can no longer
--    reach another creator's shot by mistake.
-- 3. set_shot_trim checks the trims against the kept clip's real length.
-- 4. request_assembly: locks the account row first (a double click queued two cuts), at most 20 cuts an hour, and at
--    most 180 s of slowed shots per cut (each is rebuilt frame by frame).
-- 5. request_audio: at most 100 pieces of audio per 24 hours (the creator's own ElevenLabs credits).

alter table studio.generations add column if not exists clip_s numeric;

create or replace function studio.set_shot_speed(p_shot uuid, p_speed numeric)
returns void language plpgsql security definer set search_path to '' as $$
declare v_owner uuid;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null or auth.uid() is null or auth.uid() <> v_owner then raise exception 'shot not found'; end if;
  if p_speed is null or p_speed < 0.5 or p_speed > 2 then raise exception 'speed is 0.5 (half speed) to 2 (double speed); 1 is normal'; end if;
  update studio.shots set speed = round(p_speed, 3) where id = p_shot;
end $$;

create or replace function studio.set_shot_trim(p_shot uuid, p_start numeric, p_end numeric)
returns void language plpgsql security definer set search_path to '' as $$
declare v_owner uuid; v_len numeric;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null or auth.uid() is null or auth.uid() <> v_owner then raise exception 'shot not found'; end if;
  if coalesce(p_start, 0) < 0 or coalesce(p_end, 0) < 0 then raise exception 'trims are seconds to cut off, 0 or more'; end if;
  -- the kept clip's real length when the worker measured it, else the shot's asked length
  select coalesce(g.clip_s, sh.duration_s) into v_len
    from studio.shots sh left join studio.generations g on g.id = sh.approved_generation_id where sh.id = p_shot;
  if coalesce(p_start, 0) + coalesce(p_end, 0) > greatest(coalesce(v_len, 0) - 1, 0) then
    raise exception 'that leaves less than 1 second of a % s clip', round(coalesce(v_len, 0), 1); end if;
  update studio.shots set trim_start_s = round(coalesce(p_start, 0), 2), trim_end_s = round(coalesce(p_end, 0), 2) where id = p_shot;
end $$;

create or replace function studio.request_end_setup(p_shot uuid, p_instruction text)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_owner uuid; v_shot studio.shots; v_cost int := 20; v_ins text := nullif(trim(coalesce(p_instruction, '')), '');
        v_refs text[]; v_names text[]; v_heights numeric[]; v_missing text; v_n int; v_endpoint text := 'fal-ai/nano-banana-2/edit';
        v_look text; v_id uuid;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null or auth.uid() is null or auth.uid() <> v_owner then raise exception 'shot not found'; end if;
  if v_ins is null then raise exception 'say where everyone is and what they are doing at the end'; end if;
  if length(v_ins) > 1000 then raise exception 'keep it under 1000 characters'; end if;
  select * into v_shot from studio.shots where id = p_shot for update;
  if not v_shot.start_frame_approved or v_shot.start_frame_path is null then raise exception 'approve the start frame first'; end if;
  if studio.shot_busy(p_shot) or exists (select 1 from studio.frame_jobs where shot_id = p_shot and status in ('queued','running','composing')) then
    raise exception 'wait until the render or frame in progress is done'; end if;
  select se.look into v_look from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = v_shot.scene_id;
  select array_agg(c.ref_front_path order by c.height_units desc nulls last, c.name), array_agg(c.name order by c.height_units desc nulls last, c.name),
         array_agg(c.height_units order by c.height_units desc nulls last, c.name), count(*),
         string_agg(c.name, ', ') filter (where c.ref_front_path is null)
    into v_refs, v_names, v_heights, v_n, v_missing
    from studio.characters c join studio.scenes sc on sc.series_id = c.series_id
   where sc.id = v_shot.scene_id and (cardinality(v_shot.cast_ids) = 0 or c.id = any(v_shot.cast_ids));
  if coalesce(v_n, 0) = 0 then raise exception 'the shot has nobody in it: add characters to the series or the shot'; end if;
  if v_missing is not null then raise exception 'add a reference image for %', v_missing; end if;
  if v_n > 6 then raise exception 'at most 6 characters in a new setup (this shot has %)', v_n; end if;
  if v_look = 'photoreal' then v_endpoint := 'openai/gpt-image-2.6/sunburst/edit'; v_cost := 17 + 3 * v_n; end if;
  perform studio.reserve_frame_credits(v_owner, v_cost);
  insert into studio.frame_jobs(owner, shot_id, kind, mode, instruction, source_path, ref_paths, ref_names, ref_heights,
                                endpoint, usd, credits_reserved)
    values (v_owner, p_shot, 'end', 'new_setup', v_ins, v_shot.start_frame_path, v_refs, v_names, coalesce(v_heights, '{}'),
            v_endpoint, case when v_endpoint like 'openai/gpt-image%' then 0.068 + 0.012 * v_n else 0.08 end, v_cost)
    returning id into v_id;
  insert into studio.credit_ledger(owner, kind, credits, frame_job_id) values (v_owner, 'reserve', v_cost, v_id);
  update studio.shots set end_instruction = v_ins where id = p_shot;
  return v_id;
end $$;

create or replace function studio.request_assembly(p_scene uuid, p_format text, p_options jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_owner uuid; v_items jsonb; v_skipped jsonb; v_music text; v_id uuid; v_opts jsonb; v_slow numeric; n int;
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
  v_opts := jsonb_build_object('fade', coalesce((p_options->>'fade')::boolean, true),
                               'end_card', coalesce((p_options->>'end_card')::boolean, false),
                               'music_path', v_music,
                               'voice', coalesce((p_options->>'voice')::boolean, true),
                               'sfx', coalesce((p_options->>'sfx')::boolean, true));
  select coalesce(jsonb_agg(jsonb_build_object('shot_id', sh.id, 'ord', sh.ord, 'generation_id', g.id, 'path', g.output_path,
           'trim_start', sh.trim_start_s, 'trim_end', sh.trim_end_s, 'speed', sh.speed,
           'vo', (select a.output_path from studio.audio_jobs a where a.shot_id = sh.id and a.kind = 'voiceover' and a.in_cut and a.status = 'done' limit 1),
           'sfx', (select a.output_path from studio.audio_jobs a where a.shot_id = sh.id and a.kind = 'sfx' and a.in_cut and a.status = 'done' limit 1))
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
end $$;

create or replace function studio.request_audio(p_scene uuid, p_shot uuid, p_kind text, p_input jsonb)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_owner uuid; v_id uuid; v_text text; v_in jsonb; n int; v_dur numeric; v_len numeric;
        v_secs jsonb := '[]'::jsonb; v_sec jsonb; v_label text; v_s numeric; v_total numeric := 0; v_styles text;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select se.owner into v_owner from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = p_scene;
  if v_owner is null or v_owner <> auth.uid() then raise exception 'scene not found'; end if;
  if p_kind not in ('voiceover', 'sfx', 'music') then raise exception 'unknown kind of audio'; end if;
  if p_kind = 'music' then p_shot := null;
  elsif p_shot is null or not exists (select 1 from studio.shots where id = p_shot and scene_id = p_scene) then
    raise exception 'pick a shot of this scene';
  end if;
  if not exists (select 1 from studio.connections where owner = v_owner and provider = 'elevenlabs' and status = 'ok') then
    raise exception 'connect your ElevenLabs account first (Account > Connections)';
  end if;
  select count(*) into n from studio.audio_jobs where owner = v_owner and status in ('queued', 'running');
  if n >= 6 then raise exception 'six pieces of audio are already being made; wait for them to finish'; end if;
  -- 2026-11-23 (review): audio runs on the creator's own ElevenLabs credits; a looping tool must not drain them
  select count(*) into n from studio.audio_jobs where owner = v_owner and created_at > now() - interval '24 hours';
  if n >= 100 then raise exception 'you made 100 pieces of audio in the last 24 hours; try again later'; end if;

  v_text := trim(coalesce(p_input->>'text', ''));
  if p_kind = 'voiceover' then
    if v_text = '' then raise exception 'write what you want first'; end if;
    if length(v_text) > 3000 then raise exception 'a voiceover line can be up to 3,000 characters'; end if;
    if coalesce(p_input->>'voice_id', '') !~ '^[A-Za-z0-9]{8,40}$' then raise exception 'pick a voice'; end if;
    v_in := jsonb_build_object('text', v_text, 'voice_id', p_input->>'voice_id', 'voice_name', left(coalesce(p_input->>'voice_name', ''), 80),
                               'model', 'eleven_v3');
  elsif p_kind = 'sfx' then
    if v_text = '' then raise exception 'write what you want first'; end if;
    if length(v_text) > 450 then raise exception 'describe the sound in up to 450 characters'; end if;
    v_dur := nullif(p_input->>'duration_s', '')::numeric;
    if v_dur is not null and (v_dur < 0.5 or v_dur > 30) then raise exception 'a sound effect can be 0.5 to 30 seconds'; end if;
    v_in := jsonb_build_object('text', v_text, 'duration_s', v_dur);
  else
    v_styles := nullif(trim(coalesce(p_input->>'styles', '')), '');
    if length(coalesce(v_styles, '')) > 1000 then raise exception 'describe the score''s style in up to 1,000 characters'; end if;
    if jsonb_typeof(p_input->'sections') = 'array' and jsonb_array_length(p_input->'sections') > 0 then
      -- a score shaped to the shots: one section per shot, in order
      if jsonb_array_length(p_input->'sections') > 30 then raise exception 'a score can have up to 30 sections'; end if;
      for v_sec in select value from jsonb_array_elements(p_input->'sections') loop
        v_label := left(trim(coalesce(v_sec->>'label', '')), 60);
        if v_label = '' then v_label := 'Section ' || (jsonb_array_length(v_secs) + 1); end if;
        v_s := nullif(v_sec->>'seconds', '')::numeric;
        if v_s is null or v_s < 3 or v_s > 120 then raise exception 'each section is 3 to 120 seconds (%: %)', v_label, coalesce(v_s::text, 'none'); end if;
        if length(coalesce(v_sec->>'styles', '')) > 500 then raise exception 'describe % in up to 500 characters', v_label; end if;
        if length(coalesce(v_sec->>'avoid', '')) > 300 then raise exception 'keep what % avoids under 300 characters', v_label; end if;
        v_secs := v_secs || jsonb_build_object('label', v_label, 'seconds', round(v_s, 1),
                    'styles', trim(coalesce(v_sec->>'styles', '')), 'avoid', trim(coalesce(v_sec->>'avoid', '')));
        v_total := v_total + round(v_s, 1);
      end loop;
      if v_total < 3 or v_total > 600 then raise exception 'a score can be 3 seconds to 10 minutes (this one is % s)', v_total; end if;
      if v_styles is null and v_text = '' then raise exception 'describe the score''s style first'; end if;
      v_in := jsonb_build_object('text', coalesce(v_styles, v_text), 'styles', coalesce(v_styles, v_text), 'sections', v_secs,
                                 'length_s', v_total, 'instrumental', true, 'model', 'music_v2_5');
    else
      if v_text = '' and v_styles is null then raise exception 'write what you want first'; end if;
      v_text := coalesce(nullif(v_text, ''), v_styles);
      if length(v_text) > 2000 then raise exception 'describe the score in up to 2,000 characters'; end if;
      v_len := coalesce(nullif(p_input->>'length_s', '')::numeric, 30);
      if v_len < 3 or v_len > 600 then raise exception 'a score can be 3 seconds to 10 minutes'; end if;
      v_in := jsonb_build_object('text', v_text, 'length_s', round(v_len, 1), 'instrumental', coalesce((p_input->>'instrumental')::boolean, true),
                                 'model', 'music_v2_5');
    end if;
  end if;
  insert into studio.audio_jobs(owner, scene_id, shot_id, kind, input) values (v_owner, p_scene, p_shot, p_kind, v_in) returning id into v_id;
  return v_id;
end $$;
