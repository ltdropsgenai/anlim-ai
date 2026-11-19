-- Model routing: the app picks the video model per shot from what the tests showed works best. @anlim
-- Londi 2026-11-13: "use the two in an intuitive way for what we have tested them to work best on".
--   shot kind  <- the action text (studio.shot_kind)
--   kind -> model, with the reason and the evidence, in studio.model_routes (data: change a row, not code)
--   enqueue_generation(shot) with no model uses the route; a model passed in is the creator's override.
-- Evidence so far (Phase 0 + path test v2, Londi's approvals): walking across a room - MiniMax H3 3/3 vs Kling 4.0
-- 0/3 on the same shot and end frame. Every other kind: only Kling tested (4/4 approved) -> Kling until the
-- MiniMax test on S1/S2/S4/S5 says otherwise.

-- Clip lengths each model accepts (fal pages read 2026-11-12: Kling 4.0 3-30 s, MiniMax H3 5-15 s).
alter table studio.models add column if not exists min_duration_s int not null default 1,
                          add column if not exists max_duration_s int not null default 60;
update studio.models set min_duration_s = 3, max_duration_s = 30 where id = 'kling-v4-i2v-720p';
update studio.models set min_duration_s = 5, max_duration_s = 15 where id = 'minimax-h3-i2v-768p';

-- What kind of shot this is, from the action. First match wins, so "walks to the sofa and sits down" is walking
-- (the hard part is the route); "takes one step toward King and hands him the truck" is handling (one step is not
-- a walk across the room). Keep in step with worker/src/compile.js MOVES (that list adds the [PATH] prompt line).
create or replace function studio.shot_kind(p_action text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_action ~* '\m(walks?|walking|runs?|running|cross(es|ing)?|goes to|go to|moves? to|dances?|dancing|skips?|hops?|chases?|crawls?)\M' then 'walking'
    when p_action ~* '\m(sits?|sitting|sat|stands? up|standing up|lies? down|lying down|gets? up|jumps? (up|down|off|onto))\M' then 'sit_stand'
    -- "hands him the truck" is handling, "small hand gestures" is not (2026-11-13: Phase 0 S5 was misread)
    when p_action ~* '\m(hands? (him|her|it|them|over|back|the)|gives?|takes?|places?|puts?|picks? up|stacks?|holds?|throws?|catches?|pours?|opens?|closes?|draws?|paints?|builds?)\M' then 'handling'
    when p_action ~* '\m(talks?|talking|says?|speaks?|speaking|sings?|singing|asks?|tells?|whispers?|shouts?|laughs?)\M' then 'talking'
    else 'other' end
$$;

create table if not exists studio.model_routes (
  kind       text primary key check (kind in ('walking', 'sit_stand', 'handling', 'talking', 'other')),
  model_id   text not null references studio.models(id),
  reason     text not null,          -- shown to the creator
  evidence   text not null,          -- what test this rests on
  updated_at timestamptz not null default now()
);
alter table studio.model_routes enable row level security;
drop policy if exists model_routes_read on studio.model_routes;
create policy model_routes_read on studio.model_routes for select to authenticated using (true);
grant select on studio.model_routes to authenticated;

insert into studio.model_routes(kind, model_id, reason, evidence) values
 ('walking',   'minimax-h3-i2v-768p', 'MiniMax H3 is best for walking across a room: it follows the route around furniture.',
  'Path test v2, S3 walk past the coffee table with start+end frames: MiniMax 3/3 approved vs Kling 4.0 0/3 (2026-11-12).'),
 ('sit_stand', 'kling-v4-i2v-720p', 'Kling 4.0: tested and approved on sitting down.',
  'Phase 0 S4 (sits on the sofa) approved on Kling 4.0; MiniMax not tested yet.'),
 ('handling',  'kling-v4-i2v-720p', 'Kling 4.0: tested and approved on handing over and stacking toys.',
  'Phase 0 S1 (hand-off) and S2 (block stacking, free retry) approved on Kling 4.0; MiniMax not tested yet.'),
 ('talking',   'kling-v4-i2v-720p', 'Kling 4.0: tested and approved on a talking shot.',
  'Phase 0 S5 (dialogue) approved on Kling 4.0; MiniMax not tested yet.'),
 ('other',     'kling-v4-i2v-720p', 'Kling 4.0: the default until a test says otherwise.',
  'No test for this kind of shot yet.')
on conflict (kind) do nothing;

-- The model the app would use for this shot, and why. When the routed model cannot make the shot's length, the
-- cheapest active model that can is used instead and the reason says so.
create or replace function studio.route_model(p_shot uuid)
returns table(kind text, model_id text, reason text, evidence text)
language plpgsql stable security definer set search_path = '' as $$
declare v_shot studio.shots; v_kind text; r studio.model_routes; m studio.models;
begin
  if studio.shot_owner(p_shot) is null then raise exception 'shot not found'; end if;
  if auth.uid() is not null and auth.uid() <> studio.shot_owner(p_shot) then raise exception 'not your shot'; end if;
  select * into v_shot from studio.shots where id = p_shot;
  v_kind := studio.shot_kind(v_shot.action);
  select * into r from studio.model_routes where model_routes.kind = v_kind;
  if not found then select * into r from studio.model_routes where model_routes.kind = 'other'; end if;
  select * into m from studio.models where id = r.model_id and active;
  if found and v_shot.duration_s between m.min_duration_s and m.max_duration_s then
    return query select v_kind, r.model_id, r.reason, r.evidence; return;
  end if;
  select * into m from studio.models where active and provider <> 'mock'
     and v_shot.duration_s between min_duration_s and max_duration_s order by usd_per_second limit 1;
  if not found then raise exception 'no model can make a % s clip', v_shot.duration_s; end if;
  return query select v_kind, m.id, format('%s cannot make a %s s clip; using %s instead.', r.model_id, v_shot.duration_s, m.id),
                      r.evidence;
end $$;

-- Which route each generation took (null = the creator chose the model).
alter table studio.generations add column if not exists route_kind text, add column if not exists route_reason text;

-- enqueue_generation: model now optional. Same checks as before, plus the length check for a chosen model.
create or replace function studio.enqueue_generation(p_shot uuid, p_model text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_shot studio.shots; v_model studio.models; v_cost int; v_acc studio.accounts; v_id uuid;
        v_kind text; v_reason text; v_mid text := p_model;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_owner is null then raise exception 'shot not found'; end if;
  if auth.uid() is not null and auth.uid() <> v_owner then raise exception 'not your shot'; end if;
  select * into v_shot from studio.shots where id = p_shot for update;
  if not v_shot.start_frame_approved or v_shot.start_frame_path is null then
    raise exception 'approve the start frame before generating'; end if;
  if exists (select 1 from studio.generations where shot_id = p_shot and status in ('queued','running','checking')) then
    raise exception 'a generation is already in flight for this shot'; end if;
  if v_mid is null then
    select r.kind, r.model_id, r.reason into v_kind, v_mid, v_reason from studio.route_model(p_shot) r;
  end if;
  select * into v_model from studio.models where id = v_mid and active;
  if not found then raise exception 'unknown model %', v_mid; end if;
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
end $$;

grant execute on function studio.route_model(uuid), studio.shot_kind(text) to authenticated;
