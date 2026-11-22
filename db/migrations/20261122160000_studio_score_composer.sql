-- 2026-11-22 (Londi: "a musical score composer component into the app, kind of a mini Suno"). Decisions: instrumental
-- first; the score follows the shots (one section per shot, each with its own mood, changing on the cut); it runs on the
-- creator's own ElevenLabs key, like voiceover (anlim-billed music needs ElevenLabs' terms vetted first). @anlim
-- request_audio's music branch now also takes:
--   styles   : the whole score's style (genre, instruments, tempo), up to 1000 characters
--   sections : up to 30 of { label (1-60), seconds (3-120), styles (up to 500), avoid (up to 300) }, in order; the score's
--              length is their sum (3 s to 10 min)
-- and every score now asks for ElevenLabs' music_v2_5 (music_v1, the API default, is removed on 2027-01-31).

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
