-- Model choices from the held-out test (2026-11-19, Londi's blind labels on 20 first-time-user prompts x 5 models;
-- project doc claude/anlim-heldout-model-test-2026-11-19.md). Londi: "Kling as the default. Fix all items listed."
-- 1. Auto (balanced) = Kling 4.0 for every look and kind: 14/19 strict pass (74%), 16/19 usable. Cartoon walking and
--    handling were MiniMax H3 (Phase 0 / MiniMax benchmark); on fresh prompts MiniMax passed 7/19.
-- 2. "Lowest cost" (economy) = MiniMax H3 for every kind: cheapest per usable clip ($0.44 fal vs $0.93 Kling 4.0), 13/19 usable.
-- 3. Wan 2.7 (8/20 usable) and Kling 3.0 Pro (6/20 strict pass) leave the picker.
-- 4. Seedance 2.0 stays for cartoon only: 10/10 cartoon usable, but fal refused 4 of 10 photoreal frames
--    ("likenesses of real people"). models.looks (null = every look) is honoured by the picker and enqueue_generation.
-- @anlim
update studio.model_routes set model_id = 'kling-v4-i2v-720p', updated_at = now(),
       reason = 'Kling 4.0 had the most clips usable as is on 20 fresh first-time-user prompts (blind test, 2026-11-19).',
       evidence = 'Held-out test 2026-11-19: Kling 4.0 14/19 pass, 16/19 usable; Seedance 2.0 8/20 pass; MiniMax H3 7/19; Kling 3.0 Pro 6/20; Wan 2.7 4/20.'
 where model_id <> 'kling-v4-i2v-720p' or reason not like 'Kling 4.0 had the most%';

insert into studio.model_routes_tier (look, kind, tier, model_id, reason, evidence)
select r.look, r.kind, 'economy', 'minimax-h3-i2v-768p',
       'MiniMax H3 is the cheapest per usable clip (about half of Kling 4.0), with more retries.',
       'Held-out test 2026-11-19: MiniMax H3 13/19 usable (7 pass), $0.44 fal per usable clip vs $0.93 for Kling 4.0.'
  from studio.model_routes r
on conflict do nothing;

update studio.models set active = false where id in ('wan-2-7-i2v-720p', 'kling-v3-pro-i2v');

alter table studio.models add column if not exists looks text[];
comment on column studio.models.looks is 'Looks this model may render (null = all). Seedance 2.0: cartoon only (fal refuses real-person likenesses).';
update studio.models set looks = array['cartoon'] where id = 'seedance-2-0-i2v-720p';

create or replace function studio.enqueue_generation(p_shot uuid, p_model text default null)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_owner uuid; v_shot studio.shots; v_model studio.models; v_cost int; v_acc studio.accounts; v_id uuid;
        v_kind text; v_reason text; v_mid text := p_model; v_look text;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null then raise exception 'shot not found'; end if;
  if auth.uid() is not null and auth.uid() <> v_owner then raise exception 'not your shot'; end if;
  select * into v_shot from studio.shots where id = p_shot for update;
  if not v_shot.start_frame_approved or v_shot.start_frame_path is null then
    raise exception 'approve the start frame before generating'; end if;
  if v_shot.end_frame_path is not null and not v_shot.end_frame_approved then
    raise exception 'approve the end frame (or remove it) before generating'; end if;
  if exists (select 1 from studio.generations where shot_id = p_shot and status in ('queued','running','checking')) then
    raise exception 'a generation is already in flight for this shot'; end if;
  if v_mid is null then
    select r.kind, r.model_id, r.reason into v_kind, v_mid, v_reason from studio.route_model(p_shot) r;
  end if;
  select * into v_model from studio.models where id = v_mid and active;
  if not found then raise exception 'unknown model %', v_mid; end if;
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
