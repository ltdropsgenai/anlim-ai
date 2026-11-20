-- Model choice at the Home prompt for paid accounts (2026-11-20, Londi: "for a free account, the default should be
-- enforced but for someone on a paid account, they should be able to select what model to use for their generation").
-- * MiniMax H3 and Seedance 2.0 get their text-to-video endpoints (fal model pages read 2026-11-20: minimax/h3/text-to-video
--   $0.06/s at 768P, bytedance/seedance-2.0/text-to-video $0.3034/s at 720p: the same prices as their image-to-video).
-- * quick_create takes p_model; a picked model is refused for accounts that never paid (studio.has_paid, the same test
--   as the watermark), and enqueue_generation refuses a picked model for them too (the Workspace override chips).
-- * frame_jobs.render_model carries the pick through image-first videos (a project with a cast). @anlim
update studio.models set t2v_endpoint = 'minimax/h3/text-to-video' where id = 'minimax-h3-i2v-768p';
update studio.models set t2v_endpoint = 'bytedance/seedance-2.0/text-to-video' where id = 'seedance-2-0-i2v-720p';
alter table studio.frame_jobs add column if not exists render_model text;

create or replace function studio.enqueue_generation(p_shot uuid, p_model text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_owner uuid; v_shot studio.shots; v_model studio.models; v_cost int; v_acc studio.accounts; v_id uuid;
        v_kind text; v_reason text; v_mid text := p_model; v_look text; v_text boolean;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null then raise exception 'shot not found'; end if;
  if auth.uid() is not null and auth.uid() <> v_owner then raise exception 'not your shot'; end if;
  if p_model is not null and not studio.has_paid(v_owner) then
    raise exception 'Picking a model comes with a paid account (buy credits or a plan). Free accounts use Auto.'; end if;
  select * into v_shot from studio.shots where id = p_shot for update;
  v_text := studio.shot_renders_from_text(v_shot);
  if not v_text and (not v_shot.start_frame_approved or v_shot.start_frame_path is null) then
    raise exception 'approve the start frame before generating'; end if;
  if not v_text and v_shot.end_frame_path is not null and not v_shot.end_frame_approved then
    raise exception 'approve the end frame (or remove it) before generating'; end if;
  if exists (select 1 from studio.generations where shot_id = p_shot and status in ('queued','running','checking')) then
    raise exception 'a generation is already in flight for this shot'; end if;
  if v_mid is null then
    select r.kind, r.model_id, r.reason into v_kind, v_mid, v_reason from studio.route_model(p_shot) r;
  end if;
  select * into v_model from studio.models where id = v_mid and active;
  if not found then raise exception 'unknown model %', v_mid; end if;
  if v_text and v_model.t2v_endpoint is null then
    if p_model is not null then
      raise exception '% cannot make a clip from words alone; make an image first and animate it', coalesce(v_model.label, v_mid);
    end if;
    -- Auto picked a model without text-to-video: use Kling 4.0 (the only one wired for it)
    select * into v_model from studio.models where id = 'kling-v4-i2v-720p' and active;
    if not found then raise exception 'no model can make a clip from words alone right now; make an image first'; end if;
    v_mid := v_model.id;
    v_reason := 'Made from the words alone (no start image): Kling 4.0 is the model wired for that.';
  end if;
  if v_text then v_kind := 'text'; end if;
  select se.look into v_look from studio.scenes sc join studio.series se on se.id = sc.series_id where sc.id = v_shot.scene_id;
  if v_model.looks is not null and not (coalesce(v_look, 'cartoon') = any(v_model.looks)) then
    raise exception '% only makes % clips', coalesce(v_model.label, v_mid), array_to_string(v_model.looks, ' and '); end if;
  if v_shot.duration_s not between v_model.min_duration_s and v_model.max_duration_s then
    raise exception '% makes clips of % to % s; this shot is % s', v_mid, v_model.min_duration_s, v_model.max_duration_s, v_shot.duration_s; end if;
  v_cost := v_model.credits_per_second * v_shot.duration_s;
  insert into studio.accounts(owner) values (v_owner) on conflict do nothing;
  select * into v_acc from studio.accounts where owner = v_owner for update;
  if v_acc.balance - v_acc.reserved < v_cost then
    raise exception 'not enough credits: need %, available %', v_cost, v_acc.balance - v_acc.reserved; end if;
  update studio.accounts set reserved = reserved + v_cost, updated_at = now() where owner = v_owner;
  insert into studio.generations(owner, shot_id, model_id, credits_reserved, route_kind, route_reason)
    values (v_owner, p_shot, v_mid, v_cost, v_kind, v_reason) returning id into v_id;
  insert into studio.credit_ledger(owner, kind, credits, generation_id) values (v_owner, 'reserve', v_cost, v_id);
  update studio.shots set status = 'generating' where id = p_shot;
  return v_id;
end $function$;

drop function if exists studio.quick_create(text, text, integer, text, text, uuid);
create or replace function studio.quick_create(p_prompt text, p_look text, p_duration integer, p_output text,
                                               p_camera text default 'locked', p_series uuid default null,
                                               p_model text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_uid uuid := auth.uid(); v_series uuid := p_series; v_scene uuid; v_shot uuid; v_job uuid; v_gen uuid; v_n int;
        v_name text; v_text text := trim(coalesce(p_prompt, '')); v_model studio.models; v_clip int := 0; v_avail int;
        v_look text; v_cast boolean := false; v_from_text boolean := false;
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
    select count(*) into v_n from studio.series where owner = v_uid and name ~ '^Untitled project( [0-9]+)?$';
    v_name := case when v_n = 0 then 'Untitled project' else 'Untitled project ' || (v_n + 1) end;
    v_series := studio.create_series(v_name, null, p_look);
    v_scene := studio.create_scene(v_series, 'Scene 1');
  else
    select se.look, se.name into v_look, v_name from studio.series se where se.id = v_series and se.owner = v_uid;
    if v_look is null then raise exception 'project not found'; end if;
    select id into v_scene from studio.scenes where series_id = v_series order by ord desc limit 1;
    if v_scene is null then v_scene := studio.create_scene(v_series, 'Scene 1'); end if;
    v_cast := exists (select 1 from studio.characters where series_id = v_series);
  end if;
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
                            'series_name', v_name, 'output', p_output, 'clip_credits', v_clip);
end $function$;
revoke all on function studio.quick_create(text, text, integer, text, text, uuid, text) from public, anon;
grant execute on function studio.quick_create(text, text, integer, text, text, uuid, text) to authenticated;
