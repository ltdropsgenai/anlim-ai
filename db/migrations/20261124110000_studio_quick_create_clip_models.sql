-- quick_create: a picked model must be a clip model (2026-11-23, end-of-day review). @anlim
-- It took any active model id, so a lip sync or motion transfer model could be picked for a video from the Home prompt
-- or the API. Nothing was mis-charged (enqueue_generation only takes kind 'clip'), but an image + video request made
-- (and charged) the image, then failed the clip. Now refused up front with "unknown model". Otherwise unchanged from
-- 20261121120000_studio_aspect_ratio.sql (live body checked by md5 against it, 2026-11-23).
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
end $$;
