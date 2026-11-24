-- Lip sync (2026-11-23, Londi chose Kling LipSync on fal). @anlim
-- A shot with a kept clip and a voiceover in the cut can get a lip-synced copy of that clip: the mouths move to the
-- voiceover. It is a new clip of the same shot (studio.generations, route_kind 'lipsync'), charged and reviewed like
-- any clip; the kept clip stays in the cut until the creator keeps the lip-synced one.
-- Price: fal bills Kling LipSync at $0.014 per second of input video, rounded up to the next 5 seconds
-- (fal.ai/models/fal-ai/kling-video/lipsync/audio-to-video, checked 2026-11-23). anlim's clip prices are about 255
-- credits per provider dollar (Kling 4.0: 40 credits a second for $0.157; MiniMax H3: 15 for $0.06), so 4 credits a
-- billed second: 20 credits for up to 5 s ($0.07), 40 for up to 10 s ($0.14). Clips of 2 to 10 s (Kling's limits).
-- The voiceover starts where the shot starts in the cut, so the clip must play at normal speed (1x) for the mouths to
-- match; a slowed or sped-up shot is refused with that reason.

alter table studio.models drop constraint if exists models_kind_check;
alter table studio.models add constraint models_kind_check check (kind in ('clip', 'motion', 'lipsync'));
insert into studio.models(id, provider, endpoint, resolution, credits_per_second, usd_per_second, active, min_duration_s, max_duration_s,
                          label, looks, t2v_endpoint, kind)
values ('kling-lipsync', 'fal', 'fal-ai/kling-video/lipsync/audio-to-video', '720p', 4, 0.014, true, 2, 10,
        'Kling LipSync', array['cartoon', 'photoreal'], null, 'lipsync')
on conflict (id) do update set endpoint = excluded.endpoint, credits_per_second = excluded.credits_per_second,
  usd_per_second = excluded.usd_per_second, active = true, min_duration_s = 2, max_duration_s = 10, kind = 'lipsync';

alter table studio.generations add column if not exists lipsync_source uuid references studio.generations(id) on delete set null;
alter table studio.generations add column if not exists lipsync_audio uuid references studio.audio_jobs(id) on delete set null;
alter table studio.generations add column if not exists lipsync_s int;   -- seconds fal bills (rounded up to 5)

-- What a lip sync of this shot would cost, or why it cannot be made now. Also the latest lip sync of the shot.
create or replace function studio.lipsync_quote(p_shot uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_owner uuid; sh studio.shots; g studio.generations; v_vo studio.audio_jobs; m studio.models;
        v_len numeric; v_billed int; v_last jsonb; v_why text;
begin
  v_owner := studio.shot_owner(p_shot);
  if v_uid is null or v_owner is null or v_owner <> v_uid then raise exception 'shot not found'; end if;
  select * into sh from studio.shots where id = p_shot;
  select * into m from studio.models where id = 'kling-lipsync' and active;
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
  v_billed := greatest(5, ceil(coalesce(v_len, 5) / 5.0)::int * 5);
  return jsonb_build_object('ok', v_why is null, 'why', v_why, 'seconds', v_billed, 'clip_s', v_len,
                            'credits', v_billed * coalesce(m.credits_per_second, 4), 'last', v_last);
end $$;
revoke execute on function studio.lipsync_quote(uuid) from public, anon;
grant execute on function studio.lipsync_quote(uuid) to authenticated;

-- Start a lip sync of the shot's kept clip to its voiceover. Credits are reserved now and charged when it is made
-- (released if it fails), like any clip.
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
    values (v_uid, p_shot, 'kling-lipsync', v_cost, 'lipsync', 'Lip sync to the voiceover: picked by the creator',
            sh.approved_generation_id, v_vo, (q->>'seconds')::int)
    returning id into v_gen;
  insert into studio.credit_ledger(owner, kind, credits, generation_id) values (v_uid, 'reserve', v_cost, v_gen);
  return jsonb_build_object('generation_id', v_gen, 'credits', v_cost, 'seconds', (q->>'seconds')::int);
end $$;
revoke execute on function studio.lipsync_create(uuid) from public, anon;
grant execute on function studio.lipsync_create(uuid) to authenticated;

-- Rejecting a new take of a shot that already has a kept clip (a lip sync, a second render) used to mark the whole
-- shot rejected, so the cut left it out although its kept clip was still there. The shot now stays approved.
create or replace function studio.review_generation(p_gen uuid, p_decision text, p_reasons text[] default '{}'::text[],
                                                    p_note text default null::text, p_at_s numeric default null::numeric)
returns text language plpgsql security definer set search_path = '' as $function$
declare g studio.generations;
begin
  if p_decision not in ('approve','reject') then raise exception 'decision must be approve or reject'; end if;
  select * into g from studio.generations where id = p_gen for update;
  if not found or (auth.uid() is not null and g.owner <> auth.uid()) then raise exception 'not found'; end if;
  if exists (select 1 from studio.reviews where generation_id = p_gen) then raise exception 'this clip already has a decision'; end if;
  if g.status not in ('review','succeeded') then raise exception 'generation is %', g.status; end if;
  perform studio.settle_generation(p_gen, 'charge');
  select * into g from studio.generations where id = p_gen;
  if p_decision = 'reject' then
    perform studio.open_refund_request(g, p_reasons, p_note, p_at_s);
  end if;
  insert into studio.reviews(generation_id, reviewer, decision, reasons, note)
    values (p_gen, coalesce(auth.uid(), g.owner), p_decision, p_reasons, p_note);
  if p_decision = 'approve' then
    update studio.generations set status = 'succeeded', updated_at = now() where id = p_gen;
    update studio.shots set status = 'approved', approved_generation_id = p_gen where id = g.shot_id;
  else
    update studio.generations set status = 'failed', error = 'rejected by creator', updated_at = now() where id = p_gen;
    update studio.shots set approved_generation_id = case when approved_generation_id = p_gen then null else approved_generation_id end,
                            status = case when approved_generation_id is not null and approved_generation_id <> p_gen then 'approved' else 'rejected' end
     where id = g.shot_id;
  end if;
  return p_decision;
end $function$;
