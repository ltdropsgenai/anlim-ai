-- Names anlim gives new things, in the creator's language (2026-11-24, Londi: "nothing hardcoded in English when we
-- toggle languages"). "Untitled project", "Motion transfer" (project name), "Scene 1" and " (copy)" come from
-- studio.ui_word, which reads studio.accounts.language of the caller. Existing names are not changed (the creator can
-- rename them). The shot action "Motion transfer" stays English: the worker reads it (worker.js) and the app shows it
-- translated. @anlim

create or replace function studio.ui_word(p_key text) returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    case (select language from studio.accounts where owner = auth.uid())
      when 'es' then case p_key when 'Untitled project' then 'Proyecto sin título' when 'Motion transfer' then 'Transferencia de movimiento'
                                when 'Scene 1' then 'Escena 1' when ' (copy)' then ' (copia)' end
      when 'fr' then case p_key when 'Untitled project' then 'Projet sans titre' when 'Motion transfer' then 'Transfert de mouvement'
                                when 'Scene 1' then 'Scène 1' when ' (copy)' then ' (copie)' end
    end, p_key) $$;
revoke execute on function studio.ui_word(text) from public, anon;
grant execute on function studio.ui_word(text) to authenticated;

CREATE OR REPLACE FUNCTION studio.duplicate_scene(p_scene uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare sc studio.scenes; v_new uuid;
begin
  select s.* into sc from studio.scenes s join studio.series se on se.id = s.series_id where s.id = p_scene and se.owner = auth.uid();
  if not found then raise exception 'scene not found'; end if;
  insert into studio.scenes(series_id, location_id, ord, title, blocking)
    values (sc.series_id, sc.location_id, coalesce((select max(ord) from studio.scenes where series_id = sc.series_id), 0) + 1,
            left(sc.title || studio.ui_word(' (copy)'), 200), sc.blocking) returning id into v_new;
  perform studio.copy_shots(p_scene, v_new);
  return v_new;
end $function$;

CREATE OR REPLACE FUNCTION studio.motion_create(p_source_path text, p_ref_paths text[], p_prompt text, p_seconds numeric, p_model text, p_series uuid, p_look text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := auth.uid(); v_series uuid := p_series; v_scene uuid; v_shot uuid; v_gen uuid; v_n int;
        v_name text; v_text text := trim(coalesce(p_prompt, '')); v_model studio.models; v_secs int; v_used numeric;
        v_cost int; v_acc studio.accounts; r text; v_look text := p_look; v_base text := studio.ui_word('Motion transfer');
begin
  if v_uid is null then raise exception 'sign in first'; end if;
  if p_series is null and v_look is null then raise exception 'Choose a look for the project: cartoon or photoreal.'; end if;
  if v_look is not null and v_look not in ('cartoon', 'photoreal') then raise exception 'look must be cartoon or photoreal'; end if;
  select * into v_model from studio.models where id = p_model and active and kind = 'motion';
  if not found then raise exception 'unknown motion model %', p_model; end if;
  if v_model.provider = 'mock' and not exists (select 1 from studio.admins where user_id = v_uid) then
    raise exception 'unknown motion model %', p_model; end if;
  if not studio.has_paid(v_uid) then
    raise exception 'Motion transfer comes with a paid account (buy credits or a plan).'; end if;
  if p_source_path is null or split_part(p_source_path, '/', 1) <> v_uid::text then raise exception 'upload the source clip first'; end if;
  if coalesce(cardinality(p_ref_paths), 0) not between 1 and 8 then raise exception 'add 1 to 8 reference images'; end if;
  foreach r in array p_ref_paths loop
    if split_part(r, '/', 1) <> v_uid::text then raise exception 'reference image not found'; end if;
  end loop;
  if length(v_text) > 2000 then raise exception 'keep the description under 2000 characters'; end if;
  if p_seconds is null or p_seconds < 4 then raise exception 'the source clip must be at least 4 seconds long'; end if;
  v_used := least(p_seconds, v_model.max_duration_s);
  v_secs := ceil(v_used)::int;
  v_cost := v_model.credits_per_second * v_secs;

  if v_series is null then
    select count(*) into v_n from studio.series where owner = v_uid and name ~ ('^' || v_base || '( [0-9]+)?$');
    v_name := case when v_n = 0 then v_base else v_base || ' ' || (v_n + 1) end;
    v_series := studio.create_series(v_name, null, v_look);
    v_scene := studio.create_scene(v_series, studio.ui_word('Scene 1'));
  else
    select se.name into v_name from studio.series se where se.id = v_series and se.owner = v_uid;
    if v_name is null then raise exception 'project not found'; end if;
    select id into v_scene from studio.scenes where series_id = v_series order by ord desc limit 1;
    if v_scene is null then v_scene := studio.create_scene(v_series, studio.ui_word('Scene 1')); end if;
  end if;
  v_shot := studio.create_shot(v_scene, coalesce(nullif(v_text, ''), 'Motion transfer'), null, v_secs);
  update studio.shots set motion_source_path = p_source_path, motion_ref_paths = p_ref_paths, motion_seconds = p_seconds,
                          duration_s = v_secs, start_frame_approved = true, status = 'generating'
   where id = v_shot;

  insert into studio.accounts(owner) values (v_uid) on conflict do nothing;
  select * into v_acc from studio.accounts where owner = v_uid for update;
  if v_acc.balance - v_acc.reserved < v_cost then
    raise exception 'This clip needs % credits (% s at % a second); you have %.', v_cost, v_secs, v_model.credits_per_second,
      v_acc.balance - v_acc.reserved; end if;
  update studio.accounts set reserved = reserved + v_cost, updated_at = now() where owner = v_uid;
  insert into studio.generations(owner, shot_id, model_id, credits_reserved, route_kind, route_reason)
    values (v_uid, v_shot, v_model.id, v_cost, 'motion', 'Motion transfer: picked by the creator')
    returning id into v_gen;
  insert into studio.credit_ledger(owner, kind, credits, generation_id) values (v_uid, 'reserve', v_cost, v_gen);
  return jsonb_build_object('series_id', v_series, 'scene_id', v_scene, 'shot_id', v_shot, 'generation_id', v_gen,
                            'series_name', v_name, 'seconds', v_secs, 'credits', v_cost);
end $function$;

CREATE OR REPLACE FUNCTION studio.quick_create(p_prompt text, p_look text, p_duration integer, p_output text, p_camera text DEFAULT NULL::text, p_series uuid DEFAULT NULL::uuid, p_model text DEFAULT NULL::text, p_aspect text DEFAULT '16:9'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := auth.uid(); v_series uuid := p_series; v_scene uuid; v_shot uuid; v_job uuid; v_gen uuid; v_n int;
        v_name text; v_text text := trim(coalesce(p_prompt, '')); v_model studio.models; v_clip int := 0; v_avail int;
        v_look text; v_cast boolean := false; v_from_text boolean := false; v_aspect text; v_base text := studio.ui_word('Untitled project');
begin
  if v_uid is null then raise exception 'sign in first'; end if;
  if p_output not in ('image', 'video') then raise exception 'make an image or a video'; end if;
  if length(v_text) < 8 then raise exception 'describe the shot in a few more words'; end if;
  if length(v_text) > 2000 then raise exception 'keep it under 2000 characters'; end if;
  if p_model is not null and p_output <> 'video' then raise exception 'a model is picked for videos only'; end if;
  if p_model is not null and not studio.has_paid(v_uid) then
    raise exception 'Picking a model comes with a paid account (buy credits or a plan). Free accounts use Auto.'; end if;
  if v_series is null then
    if p_look not in ('cartoon', 'photoreal') then raise exception 'look must be cartoon or photoreal'; end if;
    if coalesce(p_aspect, '16:9') not in ('16:9', '9:16', '1:1', '4:3', '3:4', '21:9') then
      raise exception 'aspect must be 16:9, 9:16, 1:1, 4:3, 3:4 or 21:9'; end if;
    select count(*) into v_n from studio.series where owner = v_uid and name ~ ('^' || v_base || '( [0-9]+)?$');
    v_name := case when v_n = 0 then v_base else v_base || ' ' || (v_n + 1) end;
    v_series := studio.create_series(v_name, null, p_look);
    update studio.series set aspect = coalesce(p_aspect, '16:9') where id = v_series;
    v_scene := studio.create_scene(v_series, studio.ui_word('Scene 1'));
  else
    select se.look, se.name into v_look, v_name from studio.series se where se.id = v_series and se.owner = v_uid;
    if v_look is null then raise exception 'project not found'; end if;
    select id into v_scene from studio.scenes where series_id = v_series order by ord desc limit 1;
    if v_scene is null then v_scene := studio.create_scene(v_series, studio.ui_word('Scene 1')); end if;
    v_cast := exists (select 1 from studio.characters where series_id = v_series);
  end if;
  select aspect into v_aspect from studio.series where id = v_series;
  v_shot := studio.create_shot(v_scene, v_text, p_camera, p_duration);
  if p_output = 'video' then
    v_from_text := not v_cast;
    if v_from_text then
      update studio.shots set from_text = true where id = v_shot;
      select * into v_model from studio.models where id = coalesce(p_model, 'kling-v4-i2v-720p') and active and kind = 'clip';
      if not found then raise exception 'unknown model %', p_model; end if;
      v_clip := v_model.credits_per_second * p_duration;
      select balance - reserved into v_avail from studio.accounts where owner = v_uid;
      if coalesce(v_avail, 0) < v_clip then
        raise exception 'A % s video needs % credits; you have %. Make an image (20 credits), or add credits.',
          p_duration, v_clip, coalesce(v_avail, 0);
      end if;
      v_gen := studio.enqueue_generation(v_shot, p_model);
    else
      if p_model is not null then
        select * into v_model from studio.models where id = p_model and active and kind = 'clip';
        if not found then raise exception 'unknown model %', p_model; end if;
      else
        select m.* into v_model from studio.route_model(v_shot) r join studio.models m on m.id = r.model_id;
      end if;
      v_clip := v_model.credits_per_second * p_duration;
      select balance - reserved into v_avail from studio.accounts where owner = v_uid;
      if coalesce(v_avail, 0) < 20 + v_clip then
        raise exception 'A % s video needs % credits (20 for the frame, % for the clip); you have %. Make an image, or add credits.',
          p_duration, 20 + v_clip, v_clip, coalesce(v_avail, 0);
      end if;
    end if;
  end if;
  if not v_from_text then
    v_job := studio.request_start_frame(v_shot, 'prompt', null, null);
    update studio.frame_jobs set then_render = (p_output = 'video'), render_model = p_model where id = v_job;
  end if;
  return jsonb_build_object('series_id', v_series, 'scene_id', v_scene, 'shot_id', v_shot, 'job_id', v_job,
                            'generation_id', v_gen, 'from_text', v_from_text, 'model', p_model,
                            'series_name', v_name, 'output', p_output, 'clip_credits', v_clip, 'aspect', v_aspect);
end $function$;

CREATE OR REPLACE FUNCTION studio.duplicate_series(p_series uuid, p_name text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := auth.uid(); se studio.series; v_new uuid; v_name text; v_map jsonb := '{}'; v_lmap jsonb := '{}';
        c studio.characters; l studio.locations; sc studio.scenes; v_id uuid; v_sc uuid; k int := 1; v_copy text := studio.ui_word(' (copy)');
begin
  select * into se from studio.series where id = p_series and owner = v_uid;
  if not found then raise exception 'project not found'; end if;
  v_name := left(coalesce(nullif(trim(p_name), ''), se.name || v_copy), 200);
  while exists (select 1 from studio.series where owner = v_uid and name = v_name) loop
    k := k + 1; v_name := left(coalesce(nullif(trim(p_name), ''), se.name || v_copy), 190) || ' ' || k;
  end loop;
  insert into studio.series(owner, name, style_prompt, look, quality, genre, aspect)
    values (v_uid, v_name, se.style_prompt, se.look, se.quality, se.genre, se.aspect) returning id into v_new;
  for c in select * from studio.characters where series_id = p_series loop
    if c.ref_front_path is not null and coalesce(c.kind, 'person') = 'person' and not studio.has_likeness_consent(v_uid, c.ref_front_path) then
      insert into studio.likeness_consents(owner, kind, path, statement, via)
        values (v_uid, 'character', c.ref_front_path, 'Copied from the creator''s own project (no new upload).', 'app');
    end if;
    insert into studio.characters(series_id, name, ref_front_path, ref_angle_paths, height_units, build, palette, wardrobe, voice_id, kind, what)
      values (v_new, c.name, c.ref_front_path, c.ref_angle_paths, c.height_units, c.build, c.palette, c.wardrobe, c.voice_id, c.kind, c.what)
      returning id into v_id;
    v_map := v_map || jsonb_build_object(c.id::text, v_id);
  end loop;
  for l in select * from studio.locations where series_id = p_series loop
    insert into studio.locations(series_id, name, description, layout_path, other_plates)
      values (v_new, l.name, l.description, l.layout_path, l.other_plates) returning id into v_id;
    v_lmap := v_lmap || jsonb_build_object(l.id::text, v_id);
  end loop;
  for sc in select * from studio.scenes where series_id = p_series order by ord loop
    insert into studio.scenes(series_id, location_id, ord, title, blocking)
      values (v_new, (v_lmap ->> sc.location_id::text)::uuid, sc.ord, sc.title, sc.blocking) returning id into v_sc;
    perform studio.copy_shots(sc.id, v_sc, v_map);
  end loop;
  return v_new;
end $function$;
