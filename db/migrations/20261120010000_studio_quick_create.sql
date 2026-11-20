-- Quick create from the Home prompt (2026-11-20, Londi: "we need for our initial prompt to be able to generate both a
-- still image and/or a short video clip ... Then, they have the option to start a project from their generated asset or
-- just download it. Either way, a default workspace is created along with an untitled project.")
-- One call makes everything: an "Untitled project" (numbered), its "Scene 1", the shot, and the start frame drawn from
-- the prompt. Output 'video' also marks the frame job then_render: the worker approves the frame when it is ready and
-- starts the render with Auto's model (frames.js renderNow). The credits for frame + clip are checked up front so a
-- video request does not stop half way for want of credits; they are still reserved step by step (frame now, clip when
-- the frame is ready), and the clip is charged only if it passes the check or the creator keeps it, as before. @anlim
alter table studio.frame_jobs add column if not exists then_render boolean not null default false;
alter table studio.frame_jobs add column if not exists render_error text;

create or replace function studio.quick_create(p_prompt text, p_look text, p_duration integer, p_output text,
                                               p_camera text default 'locked', p_series uuid default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_uid uuid := auth.uid(); v_series uuid := p_series; v_scene uuid; v_shot uuid; v_job uuid; v_n int; v_name text;
        v_text text := trim(coalesce(p_prompt, '')); v_model studio.models; v_clip int := 0; v_avail int; v_look text;
begin
  if v_uid is null then raise exception 'sign in first'; end if;
  if p_output not in ('image', 'video') then raise exception 'make an image or a video'; end if;
  if length(v_text) < 8 then raise exception 'describe the shot in a few more words'; end if;
  if length(v_text) > 2000 then raise exception 'keep it under 2000 characters'; end if;
  if v_series is null then
    if p_look not in ('cartoon', 'photoreal') then raise exception 'look must be cartoon or photoreal'; end if;
    select count(*) into v_n from studio.series where owner = v_uid and name ~ '^Untitled project( [0-9]+)?$';
    v_name := case when v_n = 0 then 'Untitled project' else 'Untitled project ' || (v_n + 1) end;
    v_series := studio.create_series(v_name, null, p_look);
    v_scene := studio.create_scene(v_series, 'Scene 1');
  else
    select se.look, se.name into v_look, v_name from studio.series se where se.id = v_series and se.owner = v_uid;
    if v_look is null then raise exception 'project not found'; end if;
    select id into v_scene from studio.scenes where series_id = v_series order by ord desc limit 1;
    if v_scene is null then v_scene := studio.create_scene(v_series, 'Scene 1'); end if;
  end if;
  v_shot := studio.create_shot(v_scene, v_text, p_camera, p_duration);
  if p_output = 'video' then
    select m.* into v_model from studio.route_model(v_shot) r join studio.models m on m.id = r.model_id;
    v_clip := v_model.credits_per_second * p_duration;
    select balance - reserved into v_avail from studio.accounts where owner = v_uid;
    if coalesce(v_avail, 0) < 20 + v_clip then
      raise exception 'A % s video needs % credits (20 for the frame, % for the clip); you have %. Make an image, or add credits.',
        p_duration, 20 + v_clip, v_clip, coalesce(v_avail, 0);
    end if;
  end if;
  v_job := studio.request_start_frame(v_shot, 'prompt', null, null);
  update studio.frame_jobs set then_render = (p_output = 'video') where id = v_job;
  return jsonb_build_object('series_id', v_series, 'scene_id', v_scene, 'shot_id', v_shot, 'job_id', v_job,
                            'series_name', v_name, 'output', p_output, 'clip_credits', v_clip);
end $function$;
revoke all on function studio.quick_create(text, text, integer, text, text, uuid) from public, anon;
grant execute on function studio.quick_create(text, text, integer, text, text, uuid) to authenticated;
