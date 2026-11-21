-- Charging and refunds, v3 (2026-11-21, Londi): "No clips in review are left in credit limbo."
--  * Every clip is charged the moment it is delivered (status review or succeeded), as motion clips already were.
--    Before this, a clip waiting in review kept its credits reserved until the creator decided, with no end date.
--  * Review offers only Keep or Reject. Reject needs the reason (what's wrong, in a sentence) and opens a refund request.
--  * The credits come back only when an admin upholds the request (the problem is "valid and apparent"). A declined
--    request leaves the charge as it was. Before this, the credits came back at once and an admin could claw them back.
--    Requests made under v2 were already credited (credited = true), so declining one of those still takes them back.
-- @anlim

alter table studio.refund_requests add column if not exists credited boolean not null default true;
alter table studio.refund_requests alter column credited set default false;

-- 1. charge on delivery: when the worker (or anything) moves a clip to review or succeeded, settle it as charged
create or replace function studio.charge_on_delivery() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  perform studio.settle_generation(new.id, 'charge');
  return null;
end $$;
revoke execute on function studio.charge_on_delivery() from public, anon, authenticated;
drop trigger if exists generations_charge_on_delivery on studio.generations;
create trigger generations_charge_on_delivery after update of status on studio.generations
  for each row when (new.status in ('review', 'succeeded') and new.settled is null and old.status is distinct from new.status)
  execute function studio.charge_on_delivery();

-- the clips already waiting in review (19 on 2026-11-21, all in Londi's account) are charged now
do $$ declare r record; begin
  for r in select id from studio.generations where status in ('review', 'succeeded') and settled is null loop
    perform studio.settle_generation(r.id, 'charge');
  end loop;
end $$;

-- 2. the refund request itself: one per clip, within 7 days, nothing credited until an admin upholds it
create or replace function studio.open_refund_request(g studio.generations, p_reasons text[], p_note text, p_at_s numeric)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_id uuid; v_pending int; v_note text := trim(coalesce(p_note, '')); v_verdict text;
begin
  if exists (select 1 from studio.refund_requests where generation_id = g.id) then raise exception 'a refund was already requested for this clip'; end if;
  if g.settled is distinct from 'charged' or coalesce(g.credits_charged, 0) = 0 then
    raise exception 'this clip was not charged, so there is nothing to refund'; end if;
  if coalesce(g.finished_at, g.created_at) < now() - interval '7 days' then raise exception 'refunds can be requested within 7 days of the clip'; end if;
  if cardinality(coalesce(p_reasons, '{}')) = 0 then raise exception 'pick what is wrong with the clip'; end if;
  if length(v_note) < 15 then raise exception 'say in a sentence what is wrong (at least 15 characters)'; end if;
  if length(v_note) > 1000 then raise exception 'keep it under 1000 characters'; end if;
  select count(*) into v_pending from studio.refund_requests where owner = g.owner and status = 'pending';
  if v_pending >= 5 then raise exception 'you have 5 refund requests waiting; we will answer those first'; end if;
  select q.verdict into v_verdict from studio.qc_runs q where q.generation_id = g.id order by q.created_at desc limit 1;
  insert into studio.refund_requests(generation_id, owner, reasons, note, at_s, credits, checker_verdict, credited)
    values (g.id, g.owner, p_reasons[1:10], v_note, p_at_s, g.credits_charged, v_verdict, false) returning id into v_id;
  return v_id;
end $$;
revoke execute on function studio.open_refund_request(studio.generations, text[], text, numeric) from public, anon, authenticated;

-- 3. review: Keep, or Reject with the reason (which opens the refund request)
drop function if exists studio.review_generation(uuid, text, text[], text);
create or replace function studio.review_generation(p_gen uuid, p_decision text, p_reasons text[] default '{}', p_note text default null,
                                                    p_at_s numeric default null)
returns text language plpgsql security definer set search_path to '' as $$
declare g studio.generations;
begin
  if p_decision not in ('approve','reject') then raise exception 'decision must be approve or reject'; end if;
  select * into g from studio.generations where id = p_gen for update;
  if not found or (auth.uid() is not null and g.owner <> auth.uid()) then raise exception 'not found'; end if;
  if exists (select 1 from studio.reviews where generation_id = p_gen) then raise exception 'this clip already has a decision'; end if;
  if g.status not in ('review','succeeded') then raise exception 'generation is %', g.status; end if;
  perform studio.settle_generation(p_gen, 'charge');            -- normally done at delivery already (idempotent)
  select * into g from studio.generations where id = p_gen;
  if p_decision = 'reject' then
    perform studio.open_refund_request(g, p_reasons, p_note, p_at_s);    -- raises if the reason is missing
  end if;
  insert into studio.reviews(generation_id, reviewer, decision, reasons, note)
    values (p_gen, coalesce(auth.uid(), g.owner), p_decision, p_reasons, p_note);
  if p_decision = 'approve' then
    update studio.generations set status = 'succeeded', updated_at = now() where id = p_gen;
    update studio.shots set status = 'approved', approved_generation_id = p_gen where id = g.shot_id;
  else
    update studio.generations set status = 'failed', error = 'rejected by creator', updated_at = now() where id = p_gen;
    update studio.shots set status = 'rejected', approved_generation_id = case when approved_generation_id = p_gen then null else approved_generation_id end
     where id = g.shot_id;
  end if;
  return p_decision;
end $$;
revoke execute on function studio.review_generation(uuid, text, text[], text, numeric) from public, anon;
grant execute on function studio.review_generation(uuid, text, text[], text, numeric) to authenticated;

-- the old "refund" button path: now the same as rejecting the clip
create or replace function studio.request_refund(p_gen uuid, p_reasons text[], p_note text, p_at_s numeric default null)
returns uuid language plpgsql security definer set search_path to '' as $$
begin
  perform studio.review_generation(p_gen, 'reject', p_reasons, p_note, p_at_s);
  return (select id from studio.refund_requests where generation_id = p_gen);
end $$;

-- 4. the admin's decision: uphold = the credits come back now; decline (stored as 'reversed') = the charge stands
create or replace function studio.decide_refund(p_req uuid, p_decision text, p_note text default null)
returns text language plpgsql security definer set search_path to '' as $$
declare r studio.refund_requests; a studio.accounts; v_take int; v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not studio.is_admin() then raise exception 'admins only'; end if;
  if p_decision not in ('uphold', 'reverse') then raise exception 'decision must be uphold or reverse'; end if;
  select * into r from studio.refund_requests where id = p_req for update;
  if not found then raise exception 'request not found'; end if;
  if r.status <> 'pending' then raise exception 'this request was already decided (%)', r.status; end if;
  if p_decision = 'reverse' and v_note is null then raise exception 'say why, the creator will read it'; end if;
  if p_decision = 'uphold' then
    if not r.credited then
      update studio.accounts set balance = balance + r.credits, updated_at = now() where owner = r.owner;
      insert into studio.credit_ledger(owner, kind, credits, generation_id, note) values (r.owner, 'refund', r.credits, r.generation_id, 'refund upheld');
    end if;
    update studio.refund_requests set status = 'upheld', credited = true, decided_at = now(), decided_by = auth.uid(), decision_note = v_note where id = p_req;
    insert into studio.notifications(owner, kind, title, body, link)
      values (r.owner, 'refund_upheld', 'Refund approved', 'We looked at your clip and agree. ' || r.credits || ' credits are back in your account.'
              || coalesce(' ' || v_note, ''), '/clip/' || r.generation_id);
  else
    v_take := 0;
    if r.credited then                                          -- a v2 request: the credits went back at once
      select * into a from studio.accounts where owner = r.owner for update;
      v_take := greatest(0, least(r.credits, a.balance - a.reserved));
      update studio.accounts set balance = balance - v_take, debt = debt + (r.credits - v_take),
             plan_credits = least(plan_credits, balance - v_take), updated_at = now() where owner = r.owner;
      if v_take > 0 then
        insert into studio.credit_ledger(owner, kind, credits, generation_id, note) values (r.owner, 'clawback', v_take, r.generation_id, 'refund reversed');
      end if;
    end if;
    update studio.refund_requests set status = 'reversed', decided_at = now(), decided_by = auth.uid(), decision_note = v_note, clawed = v_take where id = p_req;
    insert into studio.notifications(owner, kind, title, body, link)
      values (r.owner, 'refund_reversed', 'Refund declined', 'We looked at your clip and could not see the problem: ' || v_note
              || ' The charge stands' || case when r.credited then ' and the ' || r.credits || ' credits were taken back' else '' end || '.',
              '/clip/' || r.generation_id);
  end if;
  return p_decision;
end $$;
