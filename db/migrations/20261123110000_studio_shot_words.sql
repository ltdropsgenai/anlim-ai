-- 2026-11-23 (Londi's promo: "actual words falling from him as the VO delivers them"): words drawn over a shot in the
-- cut. Each word has its text, the moment it appears (seconds into the shot as it plays in the cut, after the speed
-- change), where it appears (x and y as fractions of the frame) and how long it stays. The worker (assemble.js) draws
-- them with a real font, falling and fading; the video model is not asked to write them. @anlim

alter table studio.shots add column if not exists words jsonb not null default '[]'::jsonb;

create or replace function studio.set_shot_words(p_shot uuid, p_words jsonb)
returns void language plpgsql security definer set search_path to '' as $$
declare v_owner uuid; v_w jsonb; v_out jsonb := '[]'::jsonb; v_text text; v_at numeric; v_x numeric; v_y numeric; v_d numeric;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null or auth.uid() is null or auth.uid() <> v_owner then raise exception 'shot not found'; end if;
  if p_words is null or jsonb_typeof(p_words) <> 'array' then raise exception 'words must be a list'; end if;
  if jsonb_array_length(p_words) > 12 then raise exception 'at most 12 words on a shot'; end if;
  for v_w in select value from jsonb_array_elements(p_words) loop
    v_text := trim(coalesce(v_w->>'text', ''));
    if v_text = '' or length(v_text) > 40 then raise exception 'each word is 1 to 40 characters'; end if;
    if v_text ~ '[[:cntrl:]]' then raise exception 'a word cannot contain line breaks or control characters'; end if;
    v_at := coalesce(nullif(v_w->>'at_s', '')::numeric, 0);
    v_x := coalesce(nullif(v_w->>'x', '')::numeric, 0.5);
    v_y := coalesce(nullif(v_w->>'y', '')::numeric, 0.4);
    v_d := coalesce(nullif(v_w->>'dur_s', '')::numeric, 2.6);
    if v_at < 0 or v_at > 600 then raise exception 'a word appears 0 to 600 seconds into the shot'; end if;
    if v_x < 0 or v_x > 1 or v_y < 0 or v_y > 1 then raise exception 'x and y are fractions of the frame, 0 to 1'; end if;
    if v_d < 1 or v_d > 6 then raise exception 'a word stays 1 to 6 seconds'; end if;
    v_out := v_out || jsonb_build_object('text', v_text, 'at_s', round(v_at, 2), 'x', round(v_x, 3), 'y', round(v_y, 3), 'dur_s', round(v_d, 2));
  end loop;
  update studio.shots set words = v_out where id = p_shot;
end $$;

revoke all on function studio.set_shot_words(uuid, jsonb) from public;
grant execute on function studio.set_shot_words(uuid, jsonb) to authenticated;

-- the scene cut carries each shot's words to the worker
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
