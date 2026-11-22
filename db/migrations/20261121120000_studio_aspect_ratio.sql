-- Aspect ratio per project (2026-11-21, Londi: "make sure that users can choose 9:16, 16:9 and other aspect ratios").
-- Until now every start image and every clip made from words was 16:9 (Londi's own episodes); vertical creators got a
-- 16:9 clip with a blurred fill on export. The choices are the ratios every text-to-video model in use accepts
-- (fal pages read 2026-11-21: Kling 4.0, MiniMax H3 and Seedance 2.0 text-to-video all take 21:9, 16:9, 4:3, 1:1,
-- 3:4, 9:16) and Nano Banana 2 draws all of them (frames.js RATIOS). Image-to-video models have no ratio field: their clips are
-- expected to follow the start image's shape (not yet verified with a vertical render, 2026-11-21).
-- Existing projects stay 16:9 (everything in them was made 16:9). @anlim

alter table studio.series add column if not exists aspect text not null default '16:9';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'series_aspect_check') then
    alter table studio.series add constraint series_aspect_check check (aspect in ('16:9', '9:16', '1:1', '4:3', '3:4', '21:9'));
  end if;
end $$;

-- the project's shape; changing it applies to images and clips made afterwards
create or replace function studio.set_series_aspect(p_series uuid, p_aspect text)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if p_aspect not in ('16:9', '9:16', '1:1', '4:3', '3:4', '21:9') then raise exception 'aspect must be 16:9, 9:16, 1:1, 4:3, 3:4 or 21:9'; end if;
  update studio.series set aspect = p_aspect where id = p_series and owner = auth.uid();
  if not found then raise exception 'project not found'; end if;
end $$;
revoke execute on function studio.set_series_aspect(uuid, text) from public, anon;
grant execute on function studio.set_series_aspect(uuid, text) to authenticated;

-- Home: a new project gets the shape the creator picked (an existing project keeps its own)
drop function if exists studio.quick_create(text, text, integer, text, text, uuid, text);
create or replace function studio.quick_create(p_prompt text, p_look text, p_duration integer, p_output text,
                                               p_camera text default null, p_series uuid default null, p_model text default null,
                                               p_aspect text default '16:9')
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := auth.uid(); v_series uuid := p_series; v_scene uuid; v_shot uuid; v_job uuid; v_gen uuid; v_n int;
        v_name text; v_text text := trim(coalesce(p_prompt, '')); v_model studio.models; v_clip int := 0; v_avail int;
        v_look text; v_cast boolean := false; v_from_text boolean := false; v_aspect text;
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
    select count(*) into v_n from studio.series where owner = v_uid and name ~ '^Untitled project( [0-9]+)?$';
    v_name := case when v_n = 0 then 'Untitled project' else 'Untitled project ' || (v_n + 1) end;
    v_series := studio.create_series(v_name, null, p_look);
    update studio.series set aspect = coalesce(p_aspect, '16:9') where id = v_series;
    v_scene := studio.create_scene(v_series, 'Scene 1');
  else
    select se.look, se.name into v_look, v_name from studio.series se where se.id = v_series and se.owner = v_uid;
    if v_look is null then raise exception 'project not found'; end if;
    select id into v_scene from studio.scenes where series_id = v_series order by ord desc limit 1;
    if v_scene is null then v_scene := studio.create_scene(v_series, 'Scene 1'); end if;
    v_cast := exists (select 1 from studio.characters where series_id = v_series);
  end if;
  select aspect into v_aspect from studio.series where id = v_series;
  v_shot := studio.create_shot(v_scene, v_text, p_camera, p_duration);
  if p_output = 'video' then
    v_from_text := not v_cast;
    if v_from_text then
      update studio.shots set from_text = true where id = v_shot;
      select * into v_model from studio.models where id = coalesce(p_model, 'kling-v4-i2v-720p') and active;
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
        select * into v_model from studio.models where id = p_model and active;
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
end $$;
revoke all on function studio.quick_create(text, text, integer, text, text, uuid, text, text) from public, anon;
grant execute on function studio.quick_create(text, text, integer, text, text, uuid, text, text) to authenticated;

-- cuts: every project shape can be exported in its own shape (and the existing 16:9, 9:16, 4:5)
alter table studio.assemblies drop constraint if exists assemblies_format_check;
alter table studio.assemblies add constraint assemblies_format_check
  check (format in ('16x9', '9x16', '4x5', '1x1', '4x3', '3x4', '21x9'));
create or replace function studio.request_assembly(p_scene uuid, p_format text, p_options jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_owner uuid; v_items jsonb; v_skipped jsonb; v_music text; v_id uuid; v_opts jsonb;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select se.owner into v_owner from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = p_scene;
  if v_owner is null or v_owner <> auth.uid() then raise exception 'scene not found'; end if;
  if p_format not in ('16x9', '9x16', '4x5', '1x1', '4x3', '3x4', '21x9') then
    raise exception 'format must be 16x9, 9x16, 4x5, 1x1, 4x3, 3x4 or 21x9'; end if;
  if exists (select 1 from studio.assemblies where owner = v_owner and status in ('queued', 'running')) then
    raise exception 'a cut is already being made; wait for it to finish';
  end if;
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
