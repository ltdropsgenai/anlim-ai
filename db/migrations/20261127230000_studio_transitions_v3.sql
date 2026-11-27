-- Transitions v3 (2026-11-27, from the analysis of the Buzzy ad; worker editstyle.js and assemble.js). @anlim
-- request_assembly accepts four more values for options.style.transitions: 'leak' (a warm light-leak burn at every
-- change), 'clean' (hard cuts, a leak only where the narration turns), 'dissolve' and 'morph' (made from both shots, in a
-- small part of their own between them), and passes options.style.word_sync (default on: each shot change moves to land
-- 2 to 5 frames before a spoken word of the narration; the cut keeps its length). Everything else in request_assembly is
-- exactly as in 20261127180000_studio_shot_fx. Free like every cut: plain ffmpeg on the worker, no AI model, no credits.

create or replace function studio.request_assembly(p_scene uuid, p_format text, p_options jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path to '' as $function$
declare v_owner uuid; v_items jsonb; v_skipped jsonb; v_music text; v_id uuid; v_opts jsonb; v_slow numeric; n int; v_look text;
        v_logo jsonb; v_lp text;
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
  -- 2026-11-25: the logo
  if jsonb_typeof(p_options->'logo') = 'object' then
    v_lp := nullif(trim(coalesce(p_options->'logo'->>'path', '')), '');
    if v_lp is not null then
      if left(v_lp, 37) <> v_owner::text || '/' or v_lp like '%..%' or v_lp !~* '\.(png|jpe?g)$' then
        raise exception 'the logo must be a PNG or JPG image you uploaded';
      end if;
      v_logo := jsonb_build_object('path', v_lp,
        'corner', case when p_options->'logo'->>'corner' in ('top_left', 'top_right', 'bottom_left', 'bottom_right')
                       then p_options->'logo'->>'corner' else 'bottom_right' end,
        'size', least(0.4, greatest(0.03, coalesce(nullif(p_options->'logo'->>'size', '')::numeric, 0.12))),
        'opacity', least(1, greatest(0, coalesce(nullif(p_options->'logo'->>'opacity', '')::numeric, 0.9))));
    end if;
  end if;
  v_opts := jsonb_build_object('fade', coalesce((p_options->>'fade')::boolean, true),
                               'end_card', coalesce((p_options->>'end_card')::boolean, false),
                               'music_path', v_music,
                               'voice', coalesce((p_options->>'voice')::boolean, true),
                               'sfx', coalesce((p_options->>'sfx')::boolean, true),
                               'captions', coalesce((p_options->>'captions')::boolean, false),
                               'caption_style', case when p_options->>'caption_style' = 'bold' then 'bold' else 'plain' end,
                               'logo', v_logo,
                               'style', case when jsonb_typeof(p_options->'style') = 'object' and p_options->'style'->>'preset' = 'story' then
                                 jsonb_build_object('preset', 'story',
                                   'transitions', case when p_options->'style'->>'transitions' in ('mixed', 'flash', 'whip', 'zoom', 'spin', 'glitch', 'punch',
                                                                                                 'leak', 'clean', 'dissolve', 'morph', 'cut')
                                                       then p_options->'style'->>'transitions' else 'mixed' end,
                                   'grade', coalesce((p_options->'style'->>'grade')::boolean, true),
                                   'push', coalesce((p_options->'style'->>'push')::boolean, true),
                                   'rain', coalesce((p_options->'style'->>'rain')::boolean, false),
                                   'drops', coalesce((p_options->'style'->>'drops')::boolean, false),
                                   'look_ref', v_look,
                                   'hits', coalesce((p_options->'style'->>'hits')::boolean, true),
                                   'beat_sync', coalesce((p_options->'style'->>'beat_sync')::boolean, true),
                                   'word_sync', coalesce((p_options->'style'->>'word_sync')::boolean, true),
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
           'fx', sh.fx,
           'with_path', (select g2.output_path from studio.shots s2 join studio.generations g2 on g2.id = s2.approved_generation_id
                          where s2.scene_id = sh.scene_id and s2.id::text = sh.fx->'layout'->>'with_shot' and s2.id <> sh.id),
           'vo', (select a.output_path from studio.audio_jobs a where a.shot_id = sh.id and a.kind = 'voiceover' and a.in_cut and a.status = 'done' order by a.created_at desc limit 1),
           'sfx', (select a.output_path from studio.audio_jobs a where a.shot_id = sh.id and a.kind = 'sfx' and a.in_cut and a.status = 'done' order by a.created_at desc limit 1))
                            order by sh.ord), '[]'::jsonb)
    into v_items
    from studio.shots sh join studio.generations g on g.id = sh.approved_generation_id
   where sh.scene_id = p_scene and g.output_path is not null and coalesce((sh.fx->>'inset_only')::boolean, false) = false;
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
