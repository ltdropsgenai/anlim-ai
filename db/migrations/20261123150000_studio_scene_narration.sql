-- Scene narration (2026-11-23, backlog; Londi: one narration over a scene needs one take). @anlim
-- A voiceover with no shot is the scene's narration: one take that plays over the whole cut from a start time (at_s,
-- seconds into the cut, default 0), instead of a line tied to one shot that spills into the next. Like every piece of
-- audio, the newest finished take is the one in the cut (in_cut is per scene, kind and shot, and "no shot" is its own
-- slot). The cut request carries it to the worker in options.narration {path, at_s}; assemble.js places it.
-- request_audio and request_assembly are copied from their latest versions (20261123090000, 20261123110000) with only
-- the narration lines added.

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
  elsif p_shot is null and p_kind = 'voiceover' then null;   -- 2026-11-23: scene narration, one line over the whole cut
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
    if p_shot is null then                                      -- narration: where it starts in the cut, in seconds
      v_s := coalesce(nullif(p_input->>'at_s', '')::numeric, 0);
      if v_s < 0 or v_s > 600 then raise exception 'the narration starts 0 to 600 seconds into the cut'; end if;
      v_in := v_in || jsonb_build_object('at_s', round(v_s, 2));
    end if;
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
                               'sfx', coalesce((p_options->>'sfx')::boolean, true),
                               -- 2026-11-23: the scene's narration (a voiceover with no shot) and where it starts in the cut
                               'narration', (select jsonb_build_object('path', a.output_path,
                                                     'at_s', coalesce(nullif(a.input->>'at_s', '')::numeric, 0))
                                               from studio.audio_jobs a
                                              where a.scene_id = p_scene and a.shot_id is null and a.kind = 'voiceover'
                                                and a.in_cut and a.status = 'done' limit 1));
  select coalesce(jsonb_agg(jsonb_build_object('shot_id', sh.id, 'ord', sh.ord, 'generation_id', g.id, 'path', g.output_path,
           'trim_start', sh.trim_start_s, 'trim_end', sh.trim_end_s, 'speed', sh.speed, 'words', sh.words,
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

-- move the narration's start without making it again
create or replace function studio.set_narration_start(p_id uuid, p_at numeric)
returns void language plpgsql security definer set search_path to '' as $$
declare j studio.audio_jobs;
begin
  select * into j from studio.audio_jobs where id = p_id and owner = auth.uid();
  if j.id is null or auth.uid() is null then raise exception 'not found'; end if;
  if j.kind <> 'voiceover' or j.shot_id is not null then raise exception 'only the scene''s narration has a start time'; end if;
  if p_at is null or p_at < 0 or p_at > 600 then raise exception 'the narration starts 0 to 600 seconds into the cut'; end if;
  update studio.audio_jobs set input = input || jsonb_build_object('at_s', round(p_at, 2)), updated_at = now() where id = p_id;
end $$;
revoke all on function studio.set_narration_start(uuid, numeric) from public, anon;
grant execute on function studio.set_narration_start(uuid, numeric) to authenticated;
