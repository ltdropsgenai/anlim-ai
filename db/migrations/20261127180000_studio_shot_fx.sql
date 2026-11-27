-- Shot effects (2026-11-27, Londi: "I want to build the same effects and more cinematic production effects into anlim.ai",
-- then "Let's start with Tier1 and 2"; plan in claude/anlim-vfx-effects-plan-2026-11-27.md). @anlim
-- studio.shots.fx holds a shot's effects; the worker (worker/src/fx.js) makes them with ffmpeg and a CPU person matte, no
-- AI model and no credits, like every cut. studio.set_shot_fx checks them; request_assembly passes them to the worker with
-- the other shot's clip for a layout (with_path), leaves out shots marked inset_only (used only inside another shot's
-- layout) and passes options.caption_style ('plain' or 'bold'). Everything else in request_assembly is as in
-- 20261126060000_studio_cut_logo.

alter table studio.shots add column if not exists fx jsonb not null default '{}'::jsonb;

create or replace function studio.set_shot_fx(p_shot uuid, p_fx jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_owner uuid; v_scene uuid; k text; v_s jsonb; n int; v_t text;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null or auth.uid() is null or auth.uid() <> v_owner then raise exception 'shot not found'; end if;
  if p_fx is null or jsonb_typeof(p_fx) <> 'object' then raise exception 'effects must be an object'; end if;
  for k in select jsonb_object_keys(p_fx) loop
    if k not in ('look', 'title', 'stickers', 'frame', 'layout', 'behind', 'ghost', 'trails', 'clone', 'inset_only') then
      raise exception 'unknown effect %', k; end if;
  end loop;
  -- every piece of text the creator typed: printable, short
  for v_t in select x #>> '{}' from jsonb_path_query(p_fx, 'lax $.**.text ? (@.type() == "string")') q(x)
             union all select x #>> '{}' from jsonb_path_query(p_fx, 'lax $.frame.views ? (@.type() == "string")') q(x)
             union all select x #>> '{}' from jsonb_path_query(p_fx, 'lax $.layout.labels[*] ? (@.type() == "string")') q(x) loop
    if v_t ~ '[[:cntrl:]]' then raise exception 'effect text cannot contain line breaks or control characters'; end if;
    if length(v_t) > 40 then raise exception 'effect text is at most 40 characters'; end if;
  end loop;
  if p_fx ? 'look' and p_fx->>'look' not in ('moody', 'bw', 'warm', 'cool', 'teal_orange', 'vivid') then
    raise exception 'look is moody, bw, warm, cool, teal_orange or vivid'; end if;
  if p_fx ? 'title' and length(btrim(coalesce(p_fx->'title'->>'text', ''))) = 0 then raise exception 'a title needs its text'; end if;
  if p_fx ? 'stickers' then
    if jsonb_typeof(p_fx->'stickers') <> 'array' or jsonb_array_length(p_fx->'stickers') > 6 then raise exception 'at most 6 stickers'; end if;
    for v_s in select value from jsonb_array_elements(p_fx->'stickers') loop
      if v_s->>'kind' not in ('pow', 'boom', 'wow', 'zap', 'arrow', 'circle', 'star') then
        raise exception 'a sticker is pow, boom, wow, zap, arrow, circle or star'; end if;
    end loop;
  end if;
  if p_fx ? 'frame' and p_fx ? 'layout' then raise exception 'a shot has a phone frame or a layout, not both'; end if;
  if p_fx ? 'frame' and p_fx->'frame'->>'kind' is distinct from 'phone' then raise exception 'the frame is phone'; end if;
  if p_fx ? 'layout' then
    if p_fx->'layout'->>'kind' not in ('pip', 'split', 'compare') then raise exception 'the layout is pip, split or compare'; end if;
    select scene_id into v_scene from studio.shots where id = p_shot;
    select count(*) into n from studio.shots where id::text = p_fx->'layout'->>'with_shot' and scene_id = v_scene and id <> p_shot;
    if n = 0 then raise exception 'the layout needs another shot of the same scene (with_shot)'; end if;
  end if;
  if p_fx ? 'behind' and length(btrim(coalesce(p_fx->'behind'->>'text', ''))) = 0 then raise exception 'words behind the person need their text'; end if;
  if p_fx ? 'behind' and length(p_fx->'behind'->>'text') > 20 then raise exception 'words behind the person are at most 20 characters'; end if;
  update studio.shots set fx = p_fx where id = p_shot;
  return p_fx;
end $$;
revoke all on function studio.set_shot_fx(uuid, jsonb) from public, anon;
grant execute on function studio.set_shot_fx(uuid, jsonb) to authenticated;

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
