-- Refund requests (2026-11-20, Londi: "instead of the checker failing clips automatically, it flags for manual review.
-- If the user can articulate why it is a genuine rejection, then we refund but we collect these for review. The refund
-- is permanent if we can validate their verdict on the asset, if we can't the refund is reversed with a notification to
-- the user." Defaults agreed: a reversal may leave the account owing credits (no new work until paid), requests within
-- 7 days of the clip, at most 5 pending per account, in-app notice first.)
--   * the checker no longer fails clips (worker.js): a FAIL is a flag; every delivered clip is charged.
--   * studio.request_refund: the creator gives a defect type, a reason (15+ characters) and optionally the moment; the
--     credits come back at once and the request waits for an admin.
--   * studio.decide_refund (admins): uphold = the refund stands; reverse = the credits are taken back (what the balance
--     can cover now, the rest as debt paid from the next credits) and the creator is told why.
-- @anlim

create table if not exists studio.admins (user_id uuid primary key references auth.users(id) on delete cascade, added_at timestamptz not null default now());
alter table studio.admins enable row level security;
insert into studio.admins(user_id) values ('eca1c5f2-96a7-4a01-9a7d-a19e8afa6561') on conflict do nothing;   -- Londi

create or replace function studio.is_admin() returns boolean language sql stable security definer set search_path to ''
as $$ select exists (select 1 from studio.admins where user_id = auth.uid()) $$;
grant execute on function studio.is_admin() to authenticated;

-- in-app notices (refund decisions now; anything that needs to reach a creator later)
create table if not exists studio.notifications (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  link text,
  created_at timestamptz not null default now(),
  read_at timestamptz);
create index if not exists notifications_owner_unread on studio.notifications(owner, created_at desc) where read_at is null;
alter table studio.notifications enable row level security;
drop policy if exists notifications_own on studio.notifications;
create policy notifications_own on studio.notifications for select to authenticated using (owner = auth.uid());
grant select on studio.notifications to authenticated;

create or replace function studio.mark_notifications_read(p_ids uuid[]) returns void language sql security definer set search_path to ''
as $$ update studio.notifications set read_at = now() where owner = auth.uid() and id = any(p_ids) and read_at is null $$;
grant execute on function studio.mark_notifications_read(uuid[]) to authenticated;

create table if not exists studio.refund_requests (
  id uuid primary key default gen_random_uuid(),
  generation_id uuid not null unique references studio.generations(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  reasons text[] not null,
  note text not null,
  at_s numeric,
  credits int not null check (credits >= 0),
  checker_verdict text,
  status text not null default 'pending' check (status in ('pending', 'upheld', 'reversed')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid,
  decision_note text,
  clawed int not null default 0);
create index if not exists refund_requests_pending on studio.refund_requests(created_at) where status = 'pending';
alter table studio.refund_requests enable row level security;
drop policy if exists refund_requests_own on studio.refund_requests;
create policy refund_requests_own on studio.refund_requests for select to authenticated using (owner = auth.uid());
grant select on studio.refund_requests to authenticated;

-- credits owed after a reversed refund the balance could not cover
alter table studio.accounts add column if not exists debt int not null default 0 check (debt >= 0);

-- new credits pay the debt first
create or replace function studio.pay_debt() returns trigger language plpgsql security definer set search_path to ''
as $$
declare v_pay int;
begin
  if new.debt > 0 and new.balance - new.reserved > 0 then
    v_pay := least(new.debt, new.balance - new.reserved);
    new.balance := new.balance - v_pay;
    new.debt := new.debt - v_pay;
    new.plan_credits := least(new.plan_credits, new.balance);
    insert into studio.credit_ledger(owner, kind, credits, note) values (new.owner, 'clawback', v_pay, 'reversed refund paid from new credits');
  end if;
  return new;
end $$;
drop trigger if exists accounts_pay_debt on studio.accounts;
create trigger accounts_pay_debt before update of balance, reserved, debt on studio.accounts for each row execute function studio.pay_debt();

-- no new work while credits are owed (every reservation writes a 'reserve' ledger row)
create or replace function studio.block_reserve_in_debt() returns trigger language plpgsql security definer set search_path to ''
as $$
declare v_debt int;
begin
  if new.kind = 'reserve' then
    select debt into v_debt from studio.accounts where owner = new.owner;
    if coalesce(v_debt, 0) > 0 then
      raise exception 'Your account owes % credits from a refund we could not confirm. Add credits to continue.', v_debt;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists credit_ledger_block_in_debt on studio.credit_ledger;
create trigger credit_ledger_block_in_debt before insert on studio.credit_ledger for each row execute function studio.block_reserve_in_debt();

create or replace function studio.request_refund(p_gen uuid, p_reasons text[], p_note text, p_at_s numeric default null)
 returns uuid language plpgsql security definer set search_path to ''
as $function$
declare g studio.generations; v_id uuid; v_pending int; v_note text := trim(coalesce(p_note, '')); v_verdict text;
begin
  select * into g from studio.generations where id = p_gen for update;
  if not found or g.owner <> auth.uid() then raise exception 'clip not found'; end if;
  if exists (select 1 from studio.refund_requests where generation_id = p_gen) then raise exception 'a refund was already requested for this clip'; end if;
  if g.status not in ('review', 'succeeded') or g.settled is distinct from 'charged' or coalesce(g.credits_charged, 0) = 0 then
    raise exception 'this clip was not charged, so there is nothing to refund'; end if;
  if coalesce(g.finished_at, g.created_at) < now() - interval '7 days' then raise exception 'refunds can be requested within 7 days of the clip'; end if;
  if cardinality(coalesce(p_reasons, '{}')) = 0 then raise exception 'pick what is wrong with the clip'; end if;
  if length(v_note) < 15 then raise exception 'say in a sentence what is wrong (at least 15 characters)'; end if;
  if length(v_note) > 1000 then raise exception 'keep it under 1000 characters'; end if;
  select count(*) into v_pending from studio.refund_requests where owner = g.owner and status = 'pending';
  if v_pending >= 5 then raise exception 'you have 5 refund requests waiting; we will answer those first'; end if;
  select q.verdict into v_verdict from studio.qc_runs q where q.generation_id = p_gen order by q.created_at desc limit 1;
  insert into studio.refund_requests(generation_id, owner, reasons, note, at_s, credits, checker_verdict)
    values (p_gen, g.owner, p_reasons[1:10], v_note, p_at_s, g.credits_charged, v_verdict) returning id into v_id;
  update studio.accounts set balance = balance + g.credits_charged, updated_at = now() where owner = g.owner;
  insert into studio.credit_ledger(owner, kind, credits, generation_id, note) values (g.owner, 'refund', g.credits_charged, p_gen, 'refund requested');
  update studio.generations set status = 'failed', error = 'refund requested', updated_at = now() where id = p_gen;
  update studio.shots set status = 'rejected', approved_generation_id = case when approved_generation_id = p_gen then null else approved_generation_id end
   where id = g.shot_id;
  return v_id;
end $function$;
grant execute on function studio.request_refund(uuid, text[], text, numeric) to authenticated;

create or replace function studio.decide_refund(p_req uuid, p_decision text, p_note text default null)
 returns text language plpgsql security definer set search_path to ''
as $function$
declare r studio.refund_requests; a studio.accounts; v_take int; v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not studio.is_admin() then raise exception 'admins only'; end if;
  if p_decision not in ('uphold', 'reverse') then raise exception 'decision must be uphold or reverse'; end if;
  select * into r from studio.refund_requests where id = p_req for update;
  if not found then raise exception 'request not found'; end if;
  if r.status <> 'pending' then raise exception 'this request was already decided (%)', r.status; end if;
  if p_decision = 'reverse' and v_note is null then raise exception 'say why, the creator will read it'; end if;
  if p_decision = 'uphold' then
    update studio.refund_requests set status = 'upheld', decided_at = now(), decided_by = auth.uid(), decision_note = v_note where id = p_req;
    insert into studio.notifications(owner, kind, title, body, link)
      values (r.owner, 'refund_upheld', 'Refund confirmed', 'We looked at your clip and agree. The ' || r.credits || ' credits are yours to keep.'
              || coalesce(' ' || v_note, ''), '/clip/' || r.generation_id);
  else
    select * into a from studio.accounts where owner = r.owner for update;
    v_take := greatest(0, least(r.credits, a.balance - a.reserved));
    update studio.accounts set balance = balance - v_take, debt = debt + (r.credits - v_take),
           plan_credits = least(plan_credits, balance - v_take), updated_at = now() where owner = r.owner;
    if v_take > 0 then
      insert into studio.credit_ledger(owner, kind, credits, generation_id, note) values (r.owner, 'clawback', v_take, r.generation_id, 'refund reversed');
    end if;
    update studio.refund_requests set status = 'reversed', decided_at = now(), decided_by = auth.uid(), decision_note = v_note, clawed = v_take where id = p_req;
    update studio.generations set status = 'review', error = 'refund reversed', updated_at = now() where id = r.generation_id;
    insert into studio.notifications(owner, kind, title, body, link)
      values (r.owner, 'refund_reversed', 'Refund reversed', 'We looked at your clip and could not confirm the problem: ' || v_note
              || ' The ' || r.credits || ' credits were taken back' || case when v_take < r.credits
                 then ' (' || (r.credits - v_take) || ' of them from your next credits).' else '.' end,
              '/clip/' || r.generation_id);
  end if;
  return p_decision;
end $function$;
grant execute on function studio.decide_refund(uuid, text, text) to authenticated;

-- the admin review list: the request, the clip, what the checker said
create or replace function studio.admin_refunds(p_status text default 'pending')
 returns table (id uuid, generation_id uuid, owner uuid, email text, reasons text[], note text, at_s numeric, credits int,
                checker_verdict text, status text, created_at timestamptz, decided_at timestamptz, decision_note text,
                action text, model_id text, output_path text, start_frame_path text, qc_reasons jsonb, qc_flags jsonb,
                owner_requests int, owner_reversed int)
 language plpgsql stable security definer set search_path to ''
as $function$
begin
  if not studio.is_admin() then raise exception 'admins only'; end if;
  return query
  select r.id, r.generation_id, r.owner, u.email::text, r.reasons, r.note, r.at_s, r.credits, r.checker_verdict, r.status,
         r.created_at, r.decided_at, r.decision_note, sh.action, g.model_id, g.output_path, sh.start_frame_path,
         q.raw -> 'reasons', q.flags,
         (select count(*)::int from studio.refund_requests x where x.owner = r.owner),
         (select count(*)::int from studio.refund_requests x where x.owner = r.owner and x.status = 'reversed')
    from studio.refund_requests r
    join studio.generations g on g.id = r.generation_id
    join studio.shots sh on sh.id = g.shot_id
    left join auth.users u on u.id = r.owner
    left join lateral (select * from studio.qc_runs q where q.generation_id = g.id order by q.created_at desc limit 1) q on true
   where p_status is null or r.status = p_status
   order by r.created_at limit 200;
end $function$;
grant execute on function studio.admin_refunds(text) to authenticated;
