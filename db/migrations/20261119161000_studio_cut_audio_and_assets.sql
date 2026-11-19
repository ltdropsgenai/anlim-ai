-- Scene cuts carry each shot's chosen voiceover and sound effect; Assets lists made audio (2026-11-19). @anlim
create or replace function studio.request_assembly(p_scene uuid, p_format text, p_options jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_owner uuid; v_items jsonb; v_skipped jsonb; v_music text; v_id uuid; v_opts jsonb;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select se.owner into v_owner from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = p_scene;
  if v_owner is null or v_owner <> auth.uid() then raise exception 'scene not found'; end if;
  if p_format not in ('16x9', '9x16', '4x5') then raise exception 'format must be 16x9, 9x16 or 4x5'; end if;
  if exists (select 1 from studio.assemblies where owner = v_owner and status in ('queued', 'running')) then
    raise exception 'a cut is already being made; wait for it to finish';
  end if;

  -- the creator's own uploaded track, or a score made for them (both live under <owner>/)
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
           'vo', (select a.output_path from studio.audio_jobs a where a.shot_id = sh.id and a.kind = 'voiceover' and a.in_cut and a.status = 'done' limit 1),
           'sfx', (select a.output_path from studio.audio_jobs a where a.shot_id = sh.id and a.kind = 'sfx' and a.in_cut and a.status = 'done' limit 1))
                            order by sh.ord), '[]'::jsonb)
    into v_items
    from studio.shots sh join studio.generations g on g.id = sh.approved_generation_id
   where sh.scene_id = p_scene and g.output_path is not null;
  if jsonb_array_length(v_items) = 0 then raise exception 'approve at least one clip in this scene first'; end if;
  select coalesce(jsonb_agg(sh.ord order by sh.ord), '[]'::jsonb) into v_skipped
    from studio.shots sh left join studio.generations g on g.id = sh.approved_generation_id
   where sh.scene_id = p_scene and (sh.approved_generation_id is null or g.output_path is null);

  insert into studio.assemblies(owner, scene_id, format, options, items, skipped)
  values (v_owner, p_scene, p_format, v_opts, v_items, v_skipped) returning id into v_id;
  return v_id;
end $$;

-- Assets: add made audio. kinds: voice (voiceover), sfx (sound effect), music (a generated score; uploaded tracks are
-- listed from storage by studio-api).
do $$ declare d text; begin
  d := pg_get_functiondef('studio.my_assets()'::regprocedure);
  d := replace(d, $q$   where ch.ref_front_path is not null
$q$, $q$   where ch.ref_front_path is not null
  union all
  select case a.kind when 'voiceover' then 'voice' when 'sfx' then 'sfx' else 'music' end, a.id, a.created_at, se.id, se.name,
         se.look, se.genre, sc.id, sc.title, sh.id, sh.ord, left(a.input->>'text', 160),
         case a.kind when 'voiceover' then 'Voice: ' || coalesce(nullif(a.input->>'voice_name', ''), 'ElevenLabs')
                     when 'sfx' then 'Sound effect' || coalesce(' · shot ' || sh.ord, '') else 'Score made with ElevenLabs' end,
         a.output_path, null, null, 'ElevenLabs', a.duration_s, 'kept', null
    from studio.audio_jobs a join studio.scenes sc on sc.id = a.scene_id join studio.series se on se.id = sc.series_id
    left join studio.shots sh on sh.id = a.shot_id
   where a.status = 'done' and a.output_path is not null
$q$);
  if d not like '%audio_jobs%' then raise exception 'my_assets: anchor not found'; end if;
  execute d;
end $$;
