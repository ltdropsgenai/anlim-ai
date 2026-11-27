-- Replace a person (2026-11-27, Londi: "Bundle both models. Make sure that it is done safely"). @anlim
-- The creator uploads a short clip (an iconic sports moment, a scene from their own footage) and a photo of themselves
-- (a character's reference photo, with likeness consent): ONE person in the clip is replaced by them, and everything
-- else (the place, the other people, the camera, the cuts, the sound) stays as filmed. Unlike motion transfer, which
-- redraws the whole picture from the clip's movement.
--
-- Models (fal):
--   MiniMax H3 Max Recast  minimax/h3-max/recast                 5-30 s, no shot over 15 s, says who is replaced in words
--   Wan 2.2 Animate Replace fal-ai/wan/v2.2-14b/animate/replace   no prompt: it replaces the clip's main person
-- Prices are NOT confirmed: fal's Recast page says $0.30/s (768P) and $0.45/s (1080P), its llms.txt says $0.085/s and
-- $0.17/s plus input-video tokens (both read 2026-11-27). Credits use the higher figure and the motion-transfer rule
-- (cost a second x 1.8 / $0.0066, the cheapest credit), so a confirmed lower price can only lower them. Wan bills frames
-- at 16 a second; the worker sends it at most 24 fps, so a second costs 1.5 x the listed rate. Every row starts
-- INACTIVE: only admins (studio.admins) can run them until a test run confirms the real charge and Londi turns them on.
--
-- Safety (the disclaimers' wording is Londi's and his lawyer's; these are the mechanisms):
--   1. The person put INTO the clip is a reference photo with likeness consent (the creator, or someone who agreed).
--   2. The creator confirms, per clip, that they may use the footage (own it, licensed it, or another lawful basis),
--      that only ONE person is replaced, and that the result will be presented as an edited video. Kept in
--      studio.likeness_consents (kind 'replace_footage') with the exact statement, like the likeness consent.
--   3. The content check (moderate.py, Job: replace) blocks: inserting a named real public figure; news, political,
--      crime or disaster footage (a swap there makes a false record of a real event); sexual or humiliating edits;
--      anything else moderate.py already blocks. Real people who stay in the clip as filmed are allowed.
--   4. Every result carries a visible "AI-edited" label burned into the picture (worker), on free and paid accounts.
--   5. The provider's own safety checker is on (enable_safety_checker).
--   6. After the clip is made, the worker checks that the face in it matches the reference photo (photoreal).

alter table studio.models drop constraint if exists models_kind_check;
alter table studio.models add constraint models_kind_check check (kind in ('clip', 'motion', 'lipsync', 'music', 'replace'));

insert into studio.models (id, provider, endpoint, resolution, credits_per_second, usd_per_second, active,
                           min_duration_s, max_duration_s, label, kind, bill_step_s)
values ('recast-768p',  'fal', 'minimax/h3-max/recast',               '768P', 82,  0.3000, false, 5, 30, 'MiniMax Recast', 'replace', 1),
       ('recast-1080p', 'fal', 'minimax/h3-max/recast',               '1080P', 123, 0.4500, false, 5, 30, 'MiniMax Recast', 'replace', 1),
       ('wan-replace-720p', 'fal', 'fal-ai/wan/v2.2-14b/animate/replace', '720p', 33, 0.1200, false, 5, 15, 'Wan Animate Replace', 'replace', 1),
       ('wan-replace-480p', 'fal', 'fal-ai/wan/v2.2-14b/animate/replace', '480p', 17, 0.0600, false, 5, 15, 'Wan Animate Replace', 'replace', 1)
on conflict (id) do nothing;

alter table studio.likeness_consents drop constraint if exists likeness_consents_kind_check;
alter table studio.likeness_consents add constraint likeness_consents_kind_check
  check (kind in ('character', 'start_still', 'motion', 'upload', 'replace_footage'));

alter table studio.moderation_log drop constraint if exists moderation_log_kind_check;
alter table studio.moderation_log add constraint moderation_log_kind_check check (kind in ('clip', 'frame', 'audio', 'song', 'replace'));

-- The words the creator agrees to for the footage (shown next to the checkbox; DRAFT until Londi's lawyer reviews it).
create or replace function studio.replace_statement() returns text language sql immutable set search_path = '' as $$
  select ('I own this video or have the right to use it this way. I am replacing one person in it with myself or with '
       || 'someone who agreed. I will not present the result as real footage or use it to deceive, defame or harass anyone.')::text $$;
grant execute on function studio.replace_statement() to authenticated;

create or replace function studio.replace_create(p_source_path text, p_ref_path text, p_who text, p_seconds numeric,
                                                 p_model text, p_series uuid, p_rights_ok boolean, p_via text default 'app')
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_uid uuid := auth.uid(); v_series uuid := p_series; v_scene uuid; v_shot uuid; v_gen uuid; v_n int;
        v_name text; v_who text := trim(coalesce(p_who, '')); v_model studio.models; v_secs int; v_used numeric;
        v_cost int; v_acc studio.accounts; v_base text := studio.ui_word('Replace a person'); v_admin boolean;
begin
  if v_uid is null then raise exception 'sign in first'; end if;
  v_admin := exists (select 1 from studio.admins where user_id = v_uid);
  select * into v_model from studio.models where id = p_model and kind = 'replace';
  if not found or (not v_model.active and not v_admin) then raise exception 'unknown replace model %', p_model; end if;
  if not studio.has_paid(v_uid) then raise exception 'Replacing a person comes with a paid account (buy credits or a plan).'; end if;
  if p_via not in ('app', 'connector') then raise exception 'unknown route'; end if;
  if p_source_path is null or split_part(p_source_path, '/', 1) <> v_uid::text or p_source_path like '%..%' then
    raise exception 'upload the clip first'; end if;
  if p_ref_path is null or split_part(p_ref_path, '/', 1) <> v_uid::text or p_ref_path like '%..%' then
    raise exception 'pick the photo of the person who goes into the clip'; end if;
  -- safety 1: the person put into the clip is the creator or agreed (the same consent as a character's photo)
  if not studio.has_likeness_consent(v_uid, p_ref_path) then
    raise exception 'Confirm that the person in this photo is you or agreed to it (likeness consent).'; end if;
  -- safety 2: the footage itself, every time
  if p_rights_ok is not true then
    raise exception 'Confirm that you may use this clip and that the result will not be passed off as real footage.'; end if;
  if v_model.endpoint like 'minimax/%' and length(v_who) < 3 then
    raise exception 'Say who in the clip is replaced (for example: the player in the red number 10 shirt).'; end if;
  if length(v_who) > 300 then raise exception 'describe who is replaced in under 300 characters'; end if;
  if p_seconds is null or p_seconds < v_model.min_duration_s then
    raise exception 'the clip must be at least % seconds long', v_model.min_duration_s; end if;
  if p_seconds > v_model.max_duration_s + 0.5 then
    raise exception '% takes clips up to % seconds; trim it first', v_model.label, v_model.max_duration_s; end if;
  v_used := least(p_seconds, v_model.max_duration_s);
  v_secs := ceil(v_used)::int;
  v_cost := v_model.credits_per_second * v_secs;

  insert into studio.likeness_consents(owner, kind, path, statement, via)
    values (v_uid, 'replace_footage', p_source_path, studio.replace_statement(), p_via);

  if v_series is null then
    select count(*) into v_n from studio.series where owner = v_uid and name ~ ('^' || v_base || '( [0-9]+)?$');
    v_name := case when v_n = 0 then v_base else v_base || ' ' || (v_n + 1) end;
    v_series := studio.create_series(v_name, null, 'photoreal');
    v_scene := studio.create_scene(v_series, studio.ui_word('Scene 1'));
  else
    select se.name into v_name from studio.series se where se.id = v_series and se.owner = v_uid;
    if v_name is null then raise exception 'project not found'; end if;
    select id into v_scene from studio.scenes where series_id = v_series order by ord desc limit 1;
    if v_scene is null then v_scene := studio.create_scene(v_series, studio.ui_word('Scene 1')); end if;
  end if;
  v_shot := studio.create_shot(v_scene, 'Replace: ' || coalesce(nullif(v_who, ''), 'the main person'), null, v_secs);
  update studio.shots set motion_source_path = p_source_path, motion_ref_paths = array[p_ref_path], motion_seconds = p_seconds,
                          duration_s = v_secs, start_frame_approved = true, status = 'generating'
   where id = v_shot;

  insert into studio.accounts(owner) values (v_uid) on conflict do nothing;
  select * into v_acc from studio.accounts where owner = v_uid for update;
  if v_acc.balance - v_acc.reserved < v_cost then
    raise exception 'This clip needs % credits (% s at % a second); you have %.', v_cost, v_secs, v_model.credits_per_second,
      v_acc.balance - v_acc.reserved; end if;
  update studio.accounts set reserved = reserved + v_cost, updated_at = now() where owner = v_uid;
  insert into studio.generations(owner, shot_id, model_id, credits_reserved, route_kind, route_reason)
    values (v_uid, v_shot, v_model.id, v_cost, 'motion', 'Replace a person: picked by the creator')
    returning id into v_gen;
  insert into studio.credit_ledger(owner, kind, credits, generation_id) values (v_uid, 'reserve', v_cost, v_gen);
  return jsonb_build_object('series_id', v_series, 'scene_id', v_scene, 'shot_id', v_shot, 'generation_id', v_gen,
                            'series_name', v_name, 'seconds', v_secs, 'credits', v_cost);
end $function$;
revoke all on function studio.replace_create(text, text, text, numeric, text, uuid, boolean, text) from public, anon;
grant execute on function studio.replace_create(text, text, text, numeric, text, uuid, boolean, text) to authenticated;
