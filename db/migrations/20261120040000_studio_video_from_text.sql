-- Home prompt: a video straight from the words (2026-11-20, Londi: "the default for a prompt should be a video, not an
-- image that then gets animated. If the user specifically selects image, then that gets generated").
-- Output 'video' no longer draws a start image first: the shot is marked from_text and the clip is made by the model's
-- text-to-video endpoint (Kling 4.0: kling/v4/text-to-video, $0.157/s at 720p, the same as its image-to-video; fal
-- model page, read 2026-11-20). The worker stores the clip's first frame as the shot's start frame afterwards, so the
-- checker, the refund page and later shots in the project have a frame to work from.
-- Exception: a project that already has characters keeps image-first, because a text-only clip cannot follow their
-- reference images. Output 'image' is unchanged. @anlim
alter table studio.models add column if not exists t2v_endpoint text;
update studio.models set t2v_endpoint = 'kling/v4/text-to-video' where id = 'kling-v4-i2v-720p';
update studio.models set t2v_endpoint = 'mock/t2v' where id = 'mock-i2v';
alter table studio.shots add column if not exists from_text boolean not null default false;

-- A from_text shot renders from text while its start frame is missing or is the one the worker took from its own clip
-- (path ends in /clip-first-frame.png). Once the creator sets another start frame, it renders image-first as usual.
create or replace function studio.shot_renders_from_text(p studio.shots)
 returns boolean language sql immutable set search_path to ''
as $$ select p.from_text and (p.start_frame_path is null or p.start_frame_path like '%/clip-first-frame.png') $$;

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

create or replace function studio.quick_create(p_prompt text, p_look text, p_duration integer, p_output text,
                                               p_camera text default 'locked', p_series uuid default null)
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
      select * into v_model from studio.models where id = 'kling-v4-i2v-720p';
      v_clip := v_model.credits_per_second * p_duration;
      select balance - reserved into v_avail from studio.accounts where owner = v_uid;
      if coalesce(v_avail, 0) < v_clip then
        raise exception 'A % s video needs % credits; you have %. Make an image (20 credits), or add credits.',
          p_duration, v_clip, coalesce(v_avail, 0);
      end if;
      v_gen := studio.enqueue_generation(v_shot, null);
    else
      select m.* into v_model from studio.route_model(v_shot) r join studio.models m on m.id = r.model_id;
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
    update studio.frame_jobs set then_render = (p_output = 'video') where id = v_job;
  end if;
  return jsonb_build_object('series_id', v_series, 'scene_id', v_scene, 'shot_id', v_shot, 'job_id', v_job,
                            'generation_id', v_gen, 'from_text', v_from_text,
                            'series_name', v_name, 'output', p_output, 'clip_credits', v_clip);
end $function$;
revoke all on function studio.quick_create(text, text, integer, text, text, uuid) from public, anon;
grant execute on function studio.quick_create(text, text, integer, text, text, uuid) to authenticated;
