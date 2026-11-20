-- Motion transfer (2026-11-20, Londi): recast an uploaded clip with the creator's reference images. Two Higgsfield
-- models, each at two resolutions, paid accounts only. Prices approved by Londi 2026-11-20:
--   Genjutsu       720p 100 cr/s ($0.3446/s at Higgsfield), 480p 50 cr/s ($0.1540/s)
--   Genjutsu Light 720p  40 cr/s ($0.1471/s),               480p 20 cr/s ($0.0739/s); Light uses the first 15 s
-- Higgsfield bills the source length rounded up to a whole second (open.higgsfield.ai model pages, read 2026-11-20);
-- so does anlim. Tests behind the choice: project doc anlim-motion-transfer-test-2026-11-20. @anlim

alter table studio.models add column if not exists kind text not null default 'clip';
alter table studio.models drop constraint if exists models_kind_check;
alter table studio.models add constraint models_kind_check check (kind in ('clip', 'motion'));
alter table studio.models drop constraint if exists models_provider_check;
alter table studio.models add constraint models_provider_check check (provider in ('fal', 'mock', 'higgsfield'));

insert into studio.models (id, provider, endpoint, resolution, credits_per_second, usd_per_second, active,
                           min_duration_s, max_duration_s, label, looks, t2v_endpoint, kind) values
  ('genjutsu-mt-720p',       'higgsfield', 'higgsfield/genjutsu/motion-transfer/v1.0',       '720p', 100, 0.3446, true, 4, 30, 'Genjutsu',       null, null, 'motion'),
  ('genjutsu-mt-480p',       'higgsfield', 'higgsfield/genjutsu/motion-transfer/v1.0',       '480p',  50, 0.1540, true, 4, 30, 'Genjutsu',       null, null, 'motion'),
  ('genjutsu-light-mt-720p', 'higgsfield', 'higgsfield/genjutsu-light/motion-transfer/v1.0', '720p',  40, 0.1471, true, 4, 15, 'Genjutsu Light', null, null, 'motion'),
  ('genjutsu-light-mt-480p', 'higgsfield', 'higgsfield/genjutsu-light/motion-transfer/v1.0', '480p',  20, 0.0739, true, 4, 15, 'Genjutsu Light', null, null, 'motion'),
  ('mock-motion',            'mock',       'mock/motion',                                    '720p',   1, 0.0000, true, 1, 30, 'Test model',     null, null, 'motion')
on conflict (id) do update set provider = excluded.provider, endpoint = excluded.endpoint, resolution = excluded.resolution,
  credits_per_second = excluded.credits_per_second, usd_per_second = excluded.usd_per_second, active = excluded.active,
  min_duration_s = excluded.min_duration_s, max_duration_s = excluded.max_duration_s, label = excluded.label, kind = excluded.kind;

-- The uploaded source clip and the reference images (storage paths under the owner's folder) and the source's real
-- length in seconds (duration_s holds it rounded up: what is billed).
alter table studio.shots add column if not exists motion_source_path text;
alter table studio.shots add column if not exists motion_ref_paths text[];
alter table studio.shots add column if not exists motion_seconds numeric;

-- Motion models never appear among the clip models, and clip routes never pick one.
create or replace function studio.motion_create(p_source_path text, p_ref_paths text[], p_prompt text, p_seconds numeric,
                                                p_model text, p_series uuid default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_uid uuid := auth.uid(); v_series uuid := p_series; v_scene uuid; v_shot uuid; v_gen uuid; v_n int;
        v_name text; v_text text := trim(coalesce(p_prompt, '')); v_model studio.models; v_secs int; v_used numeric;
        v_cost int; v_acc studio.accounts; r text;
begin
  if v_uid is null then raise exception 'sign in first'; end if;
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
    v_series := studio.create_series(v_name, null, 'cartoon');
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
revoke all on function studio.motion_create(text, text[], text, numeric, text, uuid) from public, anon;
grant execute on function studio.motion_create(text, text[], text, numeric, text, uuid) to authenticated;

-- Clip renders refuse a motion model (it needs a source clip, not a start frame): only change is "and kind = 'clip'".
CREATE OR REPLACE FUNCTION studio.enqueue_generation(p_shot uuid, p_model text DEFAULT NULL::text)
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
  if v_shot.motion_source_path is not null then raise exception 'this is a motion transfer shot; make it from Motion transfer'; end if;
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
  select * into v_model from studio.models where id = v_mid and active and kind = 'clip';
  if not found then raise exception 'unknown model %', v_mid; end if;
  if v_text and v_model.t2v_endpoint is null then
    if p_model is not null then
      raise exception '% cannot make a clip from words alone; make an image first and animate it', coalesce(v_model.label, v_mid);
    end if;
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
