-- Lip sync moves to VEED Lipsync v2 (2026-11-23, Londi). @anlim
-- Why: on one test clip and one voice (Kijan scene 2, frame_check/lipsync_check.py), Kling LipSync barely opened the mouth
-- while the voice spoke (inner-lip gap 0.016) and Londi's take "does not land"; VEED opened it with the words (0.061,
-- follows the voice r 0.46) and Londi: "that lip-sync worked perfectly". Sync lipsync-2 and LatentSync measured worse.
-- Price: fal bills VEED Lipsync v2 at $0.07 per second of output video (fal.ai/models/veed/lipsync/v2/llms.txt, read
-- 2026-11-23; the page does not say how part seconds are rounded, so anlim charges whole seconds, rounded up). At anlim's
-- clip rate of about 255 credits per provider dollar (Kling 4.0: 40 credits a second for $0.157), 0.07 x 255 = 17.85, so
-- 18 credits a second: 90 for a 5 s clip, 108 for 5.04 s (billed 6 s; fal's cost $0.35 to $0.42).
-- Kling LipSync stays in the table, inactive (switched off 2026-11-23), for the takes already made with it.
-- VEED goes in INACTIVE: it is switched on after the worker with the lip sync check is deployed and one take is tested
-- (update studio.models set active = true where id = 'veed-lipsync').

alter table studio.models add column if not exists bill_step_s int not null default 1;   -- the provider bills in steps of this many seconds
update studio.models set bill_step_s = 5 where id = 'kling-lipsync';                      -- Kling LipSync: rounded up to 5 s

insert into studio.models(id, provider, endpoint, resolution, credits_per_second, usd_per_second, active, min_duration_s, max_duration_s,
                          label, looks, t2v_endpoint, kind, bill_step_s)
values ('veed-lipsync', 'fal', 'veed/lipsync/v2', '720p', 18, 0.07, false, 2, 10,
        'VEED Lipsync', array['cartoon', 'photoreal'], null, 'lipsync', 1)
on conflict (id) do update set endpoint = excluded.endpoint, credits_per_second = excluded.credits_per_second,
  usd_per_second = excluded.usd_per_second, min_duration_s = 2, max_duration_s = 10, kind = 'lipsync', bill_step_s = 1,
  label = excluded.label;

-- The quote uses the active lip sync model (VEED first if both were ever on) and bills in that model's steps.
create or replace function studio.lipsync_quote(p_shot uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_owner uuid; sh studio.shots; g studio.generations; v_vo studio.audio_jobs; m studio.models;
        v_len numeric; v_billed int; v_step int; v_last jsonb; v_why text;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_uid is null or v_owner is null or v_owner <> v_uid then raise exception 'shot not found'; end if;
  select * into sh from studio.shots where id = p_shot;
  select * into m from studio.models where kind = 'lipsync' and active order by (id = 'veed-lipsync') desc, id limit 1;
  select jsonb_build_object('generation_id', x.id, 'status', x.status, 'error', x.error, 'kept', sh.approved_generation_id = x.id)
    into v_last from studio.generations x where x.shot_id = p_shot and x.route_kind = 'lipsync' order by x.created_at desc limit 1;
  select * into g from studio.generations where id = sh.approved_generation_id;
  select * into v_vo from studio.audio_jobs where shot_id = p_shot and kind = 'voiceover' and status = 'done' and in_cut
   order by created_at desc limit 1;
  v_len := coalesce(g.clip_s, sh.duration_s);
  v_why := case
    when m.id is null then 'Lip sync is not available right now.'
    when g.id is null or g.output_path is null then 'Keep a clip for this shot first.'
    when g.route_kind = 'lipsync' then null
    when v_vo.id is null then 'Make this shot''s voiceover first (it must be in the cut).'
    when coalesce(sh.speed, 1) <> 1 then 'Set this shot to normal speed (1x): the voice plays at normal speed, so a slowed clip cannot match it.'
    when v_len < m.min_duration_s or v_len > m.max_duration_s then format('Lip sync works on clips of %s to %s seconds; this one is %s s.', m.min_duration_s, m.max_duration_s, round(v_len, 1))
    when not studio.has_paid(v_uid) then 'Lip sync comes with a paid account (buy credits or a plan).'
    else null end;
  if v_why is null and g.route_kind = 'lipsync' then v_why := 'The kept clip is already lip-synced. Make the voiceover again to sync a new take.'; end if;
  v_step := greatest(1, coalesce(m.bill_step_s, 1));
  v_billed := greatest(v_step, ceil(coalesce(v_len, 5) / v_step::numeric)::int * v_step);
  return jsonb_build_object('ok', v_why is null, 'why', v_why, 'seconds', v_billed, 'clip_s', v_len,
                            'credits', v_billed * coalesce(m.credits_per_second, 18), 'model', m.id, 'model_label', m.label,
                            'last', v_last);
end $$;
revoke execute on function studio.lipsync_quote(uuid) from public, anon;
grant execute on function studio.lipsync_quote(uuid) to authenticated;

-- Same as 20261124020000 except the model comes from the quote (it was always 'kling-lipsync').
create or replace function studio.lipsync_create(p_shot uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); q jsonb; sh studio.shots; v_vo uuid; v_cost int; v_acc studio.accounts; v_gen uuid;
begin
  if v_uid is null then raise exception 'sign in first'; end if;
  perform pg_advisory_xact_lock(hashtext('lipsync:' || p_shot::text));
  q := studio.lipsync_quote(p_shot);
  if not (q->>'ok')::boolean then raise exception '%', q->>'why'; end if;
  if exists (select 1 from studio.generations where shot_id = p_shot and route_kind = 'lipsync' and status in ('queued', 'running', 'checking')) then
    raise exception 'A lip sync of this shot is already being made.'; end if;
  select * into sh from studio.shots where id = p_shot;
  select id into v_vo from studio.audio_jobs where shot_id = p_shot and kind = 'voiceover' and status = 'done' and in_cut
   order by created_at desc limit 1;
  v_cost := (q->>'credits')::int;
  insert into studio.accounts(owner) values (v_uid) on conflict do nothing;
  select * into v_acc from studio.accounts where owner = v_uid for update;
  if v_acc.balance - v_acc.reserved < v_cost then
    raise exception 'Lip sync needs % credits; you have %.', v_cost, v_acc.balance - v_acc.reserved; end if;
  update studio.accounts set reserved = reserved + v_cost, updated_at = now() where owner = v_uid;
  insert into studio.generations(owner, shot_id, model_id, credits_reserved, route_kind, route_reason, lipsync_source, lipsync_audio, lipsync_s)
    values (v_uid, p_shot, q->>'model', v_cost, 'lipsync', 'Lip sync to the voiceover: picked by the creator',
            sh.approved_generation_id, v_vo, (q->>'seconds')::int)
    returning id into v_gen;
  insert into studio.credit_ledger(owner, kind, credits, generation_id) values (v_uid, 'reserve', v_cost, v_gen);
  return jsonb_build_object('generation_id', v_gen, 'credits', v_cost, 'seconds', (q->>'seconds')::int, 'model', q->>'model');
end $$;
revoke execute on function studio.lipsync_create(uuid) from public, anon;
grant execute on function studio.lipsync_create(uuid) to authenticated;
