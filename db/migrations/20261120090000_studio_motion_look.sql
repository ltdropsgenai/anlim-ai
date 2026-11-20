-- Motion transfer works for any look (2026-11-20, Londi: "Motion transfer should be possible if we want to switch
-- characters even in photoreal"). A 7-argument studio.motion_create(..., p_series, p_look) labels the new project
-- cartoon or photoreal; the model takes the look from the reference images either way. Same body as
-- 20261120070000_studio_motion_transfer otherwise (applied to the project 2026-11-20). Until studio-api passes the
-- look, the app sets it on the new project with series_update. @anlim
create or replace function studio.motion_create(p_source_path text, p_ref_paths text[], p_prompt text, p_seconds numeric,
                                                p_model text, p_series uuid, p_look text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_uid uuid := auth.uid(); v_series uuid := p_series; v_scene uuid; v_shot uuid; v_gen uuid; v_n int;
        v_name text; v_text text := trim(coalesce(p_prompt, '')); v_model studio.models; v_secs int; v_used numeric;
        v_cost int; v_acc studio.accounts; r text; v_look text := coalesce(p_look, 'cartoon');
begin
  if v_uid is null then raise exception 'sign in first'; end if;
  if v_look not in ('cartoon', 'photoreal') then raise exception 'look must be cartoon or photoreal'; end if;
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
  -- Genjutsu trims a longer source to 30 s and Light uses the first 15 s: bill what is used, rounded up
  v_used := least(p_seconds, v_model.max_duration_s);
  v_secs := ceil(v_used)::int;
  v_cost := v_model.credits_per_second * v_secs;

  if v_series is null then
    select count(*) into v_n from studio.series where owner = v_uid and name ~ '^Motion transfer( [0-9]+)?$';
    v_name := case when v_n = 0 then 'Motion transfer' else 'Motion transfer ' || (v_n + 1) end;
    v_series := studio.create_series(v_name, null, v_look);
    v_scene := studio.create_scene(v_series, 'Scene 1');
  else
    select se.name into v_name from studio.series se where se.id = v_series and se.owner = v_uid;
    if v_name is null then raise exception 'project not found'; end if;
    select id into v_scene from studio.scenes where series_id = v_series order by ord desc limit 1;
    if v_scene is null then v_scene := studio.create_scene(v_series, 'Scene 1'); end if;
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
revoke all on function studio.motion_create(text, text[], text, numeric, text, uuid, text) from public, anon;
grant execute on function studio.motion_create(text, text[], text, numeric, text, uuid, text) to authenticated;
