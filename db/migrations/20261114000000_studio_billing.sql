-- Billing: credit packs, monthly and annual plans, paid through Stripe. @anlim
-- Decided with Londi 2026-11-13, after comparing Runway and Kling pricing (third-party summaries, Jun/Nov 2026):
--   packs  $10 / $25 / $50 -> 1,000 / 2,500 / 5,000 credits, never expire (1.00 c/credit, ~61% margin before Stripe's fee)
--   plans  Creator $19 -> 1,900/mo, Pro $49 -> 5,400/mo, Studio $99 -> 12,000/mo; annual = 20% off, credits still
--          given monthly; plan credits expire at the end of each month; plan credits are spent before pack credits;
--          failed renewal = keep what's left, no new monthly credits until paid.
-- Margins after the discounts (cost ~0.39 c/credit): Creator 61%/51%, Pro 57%/46%, Studio 53%/41% (monthly/annual),
-- before Stripe's fee and before unused (expired) plan credits, which raise them.
--
-- Credits model: accounts.balance stays the one spendable total, so every existing reserve/charge path is unchanged.
-- accounts.plan_credits is the part of balance that came from the plan allowance; a trigger takes every charge out of
-- it first (spend order), and expiry removes what is left of it. Credits held by an in-flight render when the month
-- ends are not taken back (they are charged or released as usual; at most one render's worth).
--
-- Stripe talks to us only through studio.apply_stripe_event(event jsonb), called by the studio-billing Edge Function
-- after it checks the webhook signature. Every event id is recorded once, so a re-sent event changes nothing.

-- ---------- catalogue ----------
create table if not exists studio.price_plans (
  id text primary key,                         -- also the Stripe price lookup_key; change a price = new id (…_v2)
  kind text not null check (kind in ('pack','plan')),
  tier text,                                   -- plans: creator / pro / studio
  billing_interval text check (billing_interval in ('month','year')),
  name text not null,
  price_cents int not null check (price_cents > 0),
  credits int not null check (credits > 0),    -- packs: credits bought; plans: credits per month
  active boolean not null default true,
  sort int not null default 0,
  stripe_price_id text unique,                 -- filled by studio-billing the first time the price is used
  check ((kind = 'pack') = (billing_interval is null) and (kind = 'pack') = (tier is null))
);
insert into studio.price_plans(id, kind, tier, billing_interval, name, price_cents, credits, sort) values
  ('pack_1000_v1',      'pack', null,      null,    '1,000 credits',  1000,  1000, 10),
  ('pack_2500_v1',      'pack', null,      null,    '2,500 credits',  2500,  2500, 11),
  ('pack_5000_v1',      'pack', null,      null,    '5,000 credits',  5000,  5000, 12),
  ('creator_month_v1',  'plan', 'creator', 'month', 'Creator',        1900,  1900, 20),
  ('creator_year_v1',   'plan', 'creator', 'year',  'Creator',       18240,  1900, 21),
  ('pro_month_v1',      'plan', 'pro',     'month', 'Pro',            4900,  5400, 22),
  ('pro_year_v1',       'plan', 'pro',     'year',  'Pro',           47040,  5400, 23),
  ('studio_month_v1',   'plan', 'studio',  'month', 'Studio',         9900, 12000, 24),
  ('studio_year_v1',    'plan', 'studio',  'year',  'Studio',        95040, 12000, 25)
on conflict (id) do nothing;
alter table studio.price_plans enable row level security;
drop policy if exists price_plans_read on studio.price_plans;
create policy price_plans_read on studio.price_plans for select to authenticated using (active);
grant select on studio.price_plans to authenticated;

-- ---------- account: plan state, Stripe ids ----------
alter table studio.accounts
  add column if not exists plan_credits int not null default 0 check (plan_credits >= 0),
  add column if not exists plan_id text references studio.price_plans(id),
  add column if not exists plan_status text,               -- Stripe subscription status: active, past_due, canceled, …
  add column if not exists plan_period_end timestamptz,    -- end of the paid period (month, or year for annual)
  add column if not exists plan_next_refresh timestamptz,  -- when this month's plan credits end (and annual refills)
  add column if not exists plan_cancel_at_period_end boolean not null default false,
  add column if not exists stripe_customer_id text unique,
  add column if not exists stripe_subscription_id text unique;
alter table studio.accounts drop constraint if exists accounts_plan_le_balance;
alter table studio.accounts add constraint accounts_plan_le_balance check (plan_credits <= balance);

alter table studio.credit_ledger drop constraint if exists credit_ledger_kind_check;
alter table studio.credit_ledger add constraint credit_ledger_kind_check
  check (kind in ('purchase','grant','reserve','charge','release','refund','plan','expire','clawback'));

create table if not exists studio.stripe_events (
  id text primary key, type text not null, received_at timestamptz not null default now(), result text);
create table if not exists studio.payments (
  id bigserial primary key,
  owner uuid not null references auth.users(id) on delete cascade,
  plan_id text not null references studio.price_plans(id),
  stripe_payment_intent text unique,           -- packs: refunds find the purchase by this
  stripe_invoice text unique,                  -- plans
  amount_cents int not null, credits int not null, refunded_cents int not null default 0,
  created_at timestamptz not null default now());
alter table studio.stripe_events enable row level security;   -- no policies: only security definer functions use them
alter table studio.payments enable row level security;
drop policy if exists payments_own on studio.payments;
create policy payments_own on studio.payments for select to authenticated using (owner = auth.uid());
grant select on studio.payments to authenticated;

-- spend order: a charge (balance going down without plan_credits being set) comes out of plan credits first
create or replace function studio.accounts_spend_plan_first() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.balance < old.balance and new.plan_credits = old.plan_credits
     and coalesce(current_setting('studio.purchased_only', true), '') <> 'on' then
    new.plan_credits := greatest(0, old.plan_credits - (old.balance - new.balance));
  end if;
  return new;
end $$;
drop trigger if exists accounts_spend_plan_first on studio.accounts;
create trigger accounts_spend_plan_first before update on studio.accounts
  for each row execute function studio.accounts_spend_plan_first();

-- ---------- plan credit movements (internal) ----------
create or replace function studio.expire_plan_credits(p_owner uuid, p_note text)
returns int language plpgsql security definer set search_path = '' as $$
declare a studio.accounts; v int;
begin
  select * into a from studio.accounts where owner = p_owner for update;
  if not found or a.plan_credits = 0 then return 0; end if;
  v := least(a.plan_credits, a.balance - a.reserved);      -- credits held by an in-flight job stay
  update studio.accounts set balance = balance - greatest(v, 0), plan_credits = 0, updated_at = now() where owner = p_owner;
  if v > 0 then insert into studio.credit_ledger(owner, kind, credits, note) values (p_owner, 'expire', v, p_note); end if;
  return greatest(v, 0);
end $$;

create or replace function studio.grant_plan_credits(p_owner uuid, p_credits int, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform studio.expire_plan_credits(p_owner, 'unused plan credits from the last month');
  insert into studio.accounts(owner) values (p_owner) on conflict do nothing;
  update studio.accounts set balance = balance + p_credits, plan_credits = plan_credits + p_credits, updated_at = now()
   where owner = p_owner;
  insert into studio.credit_ledger(owner, kind, credits, note) values (p_owner, 'plan', p_credits, p_note);
end $$;

-- Month boundaries that no Stripe event marks: annual plans refill monthly; a plan that was not renewed loses its
-- credits a day after the paid period (grace for a late invoice.paid). Run by the worker every tick and by `me`.
create or replace function studio.refresh_plan(p_owner uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare a studio.accounts; p studio.price_plans;
begin
  select * into a from studio.accounts where owner = p_owner for update;
  if not found or a.plan_next_refresh is null or a.plan_next_refresh > now() then return 'nothing due'; end if;
  select * into p from studio.price_plans where id = a.plan_id;
  if a.plan_status in ('active','trialing') and a.plan_period_end is not null
     and a.plan_next_refresh < a.plan_period_end - interval '1 day' then
    -- inside a paid annual period: this month's credits
    perform studio.grant_plan_credits(p_owner, p.credits, p.name || ' monthly credits (annual plan)');
    update studio.accounts set plan_next_refresh = least(plan_next_refresh + interval '1 month', plan_period_end) where owner = p_owner;
    return 'refilled';
  end if;
  if now() > coalesce(a.plan_period_end, a.plan_next_refresh) + interval '1 day' then
    perform studio.expire_plan_credits(p_owner, 'plan period ended without a renewal');
    update studio.accounts set plan_next_refresh = null where owner = p_owner;
    return 'expired';
  end if;
  return 'waiting for renewal';
end $$;

create or replace function studio.refresh_plans()
returns int language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select owner from studio.accounts where plan_next_refresh <= now() limit 200 loop
    if studio.refresh_plan(r.owner) in ('refilled','expired') then n := n + 1; end if;
  end loop;
  return n;
end $$;

create or replace function studio.refresh_my_plan()
returns text language sql security definer set search_path = '' as $$ select studio.refresh_plan(auth.uid()) $$;

-- ---------- Stripe ----------
-- The plan a subscription is on, from its price (portal plan changes keep the old metadata, so price wins)
create or replace function studio.plan_for_price(p_price text, p_fallback text)
returns studio.price_plans language sql stable security definer set search_path = '' as $$
  select * from studio.price_plans where stripe_price_id = p_price or id = p_fallback
   order by (stripe_price_id = p_price) desc nulls last limit 1 $$;

create or replace function studio.owner_for(p_meta jsonb, p_customer text)
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce((select case when p_meta->>'owner' ~ '^[0-9a-f-]{36}$' then (p_meta->>'owner')::uuid end
                    where exists (select 1 from auth.users where id::text = p_meta->>'owner')),
                  (select owner from studio.accounts where stripe_customer_id = p_customer)) $$;

create or replace function studio.apply_stripe_event(p_event jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare
  t text := p_event->>'type'; o jsonb := p_event->'data'->'object'; v_owner uuid; p studio.price_plans; old_p studio.price_plans;
  v_meta jsonb; v_sub text; v_line jsonb; v_price text; v_end timestamptz; v_result text; v_pi text; v_pay studio.payments;
  v_back int; a studio.accounts;
begin
  insert into studio.stripe_events(id, type) values (p_event->>'id', t) on conflict (id) do nothing;
  if not found then return 'duplicate'; end if;

  if t = 'checkout.session.completed' then
    v_owner := studio.owner_for(o->'metadata', o->>'customer');
    if v_owner is null then v_result := 'no owner';
    else
      insert into studio.accounts(owner) values (v_owner) on conflict do nothing;
      update studio.accounts set stripe_customer_id = coalesce(stripe_customer_id, o->>'customer') where owner = v_owner;
      if o->>'mode' = 'payment' then
        select * into p from studio.price_plans where id = o->'metadata'->>'plan_id' and kind = 'pack';
        if p.id is null then v_result := 'unknown pack';
        elsif o->>'payment_status' <> 'paid' then v_result := 'not paid yet';
        else
          insert into studio.payments(owner, plan_id, stripe_payment_intent, amount_cents, credits)
            values (v_owner, p.id, o->>'payment_intent', coalesce((o->>'amount_total')::int, p.price_cents), p.credits);
          update studio.accounts set balance = balance + p.credits, updated_at = now() where owner = v_owner;
          insert into studio.credit_ledger(owner, kind, credits, note) values (v_owner, 'purchase', p.credits, p.name);
          v_result := 'pack ' || p.id;
        end if;
      else
        update studio.accounts set stripe_subscription_id = o->>'subscription' where owner = v_owner;
        v_result := 'subscription started (credits come with invoice.paid)';
      end if;
    end if;

  elsif t in ('invoice.paid', 'invoice.payment_succeeded') then
    v_meta := coalesce(o->'parent'->'subscription_details'->'metadata', o->'subscription_details'->'metadata', '{}');
    v_sub := coalesce(o->'parent'->'subscription_details'->>'subscription', o->>'subscription');
    -- the line for the plan itself (positive amount); proration credit lines are negative
    select l into v_line from jsonb_array_elements(o->'lines'->'data') l
     where coalesce((l->>'amount')::int, 0) > 0 order by (l->>'amount')::int desc limit 1;
    v_price := coalesce(v_line->'pricing'->'price_details'->>'price', v_line->'price'->>'id');
    v_end := to_timestamp((v_line->'period'->>'end')::double precision);
    v_owner := studio.owner_for(v_meta, o->>'customer');
    p := studio.plan_for_price(v_price, v_meta->>'plan_id');
    if v_sub is null then v_result := 'not a subscription invoice';
    elsif v_owner is null or p.id is null or p.kind <> 'plan' then v_result := 'unknown owner or plan';
    else
      insert into studio.accounts(owner) values (v_owner) on conflict do nothing;
      select * into a from studio.accounts where owner = v_owner for update;
      select * into old_p from studio.price_plans where id = a.plan_id;
      insert into studio.payments(owner, plan_id, stripe_invoice, amount_cents, credits)
        values (v_owner, p.id, o->>'id', coalesce((o->>'amount_paid')::int, 0), p.credits) on conflict do nothing;
      update studio.accounts set plan_id = p.id, plan_status = 'active', stripe_subscription_id = v_sub,
             stripe_customer_id = coalesce(stripe_customer_id, o->>'customer'), plan_period_end = v_end where owner = v_owner;
      if o->>'billing_reason' = 'subscription_update' and old_p.id is not null and a.plan_next_refresh > now() then
        -- plan change inside the month: top up to the new plan's monthly amount, no fresh month
        if p.credits > old_p.credits then
          update studio.accounts set balance = balance + (p.credits - old_p.credits),
                 plan_credits = plan_credits + (p.credits - old_p.credits), updated_at = now() where owner = v_owner;
          insert into studio.credit_ledger(owner, kind, credits, note)
            values (v_owner, 'plan', p.credits - old_p.credits, 'upgrade to ' || p.name || ' (' || p.billing_interval || 'ly)');
        end if;
        v_result := 'plan changed to ' || p.id;
      else
        perform studio.grant_plan_credits(v_owner, p.credits, p.name || ' monthly credits');
        update studio.accounts set plan_next_refresh = least(now() + interval '1 month', v_end) where owner = v_owner;
        v_result := 'plan credits ' || p.id;
      end if;
    end if;

  elsif t = 'invoice.payment_failed' then
    v_owner := studio.owner_for('{}', o->>'customer');
    update studio.accounts set plan_status = 'past_due' where owner = v_owner and plan_status is not null;
    v_result := case when found then 'past_due' else 'no plan' end;

  elsif t in ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted') then
    v_owner := studio.owner_for(coalesce(o->'metadata', '{}'), o->>'customer');
    v_price := o->'items'->'data'->0->'price'->>'id';
    v_end := to_timestamp(coalesce(o->'items'->'data'->0->>'current_period_end', o->>'current_period_end')::double precision);
    if v_owner is null then v_result := 'no owner';
    else
      p := studio.plan_for_price(v_price, o->'metadata'->>'plan_id');
      update studio.accounts set plan_status = o->>'status', stripe_subscription_id = o->>'id',
             plan_cancel_at_period_end = coalesce((o->>'cancel_at_period_end')::boolean, false),
             plan_period_end = coalesce(v_end, plan_period_end), plan_id = coalesce(p.id, plan_id)
       where owner = v_owner;
      if t = 'customer.subscription.deleted' then
        perform studio.expire_plan_credits(v_owner, 'plan ended');
        update studio.accounts set plan_status = 'canceled', plan_next_refresh = null where owner = v_owner;
      end if;
      v_result := 'subscription ' || (o->>'status');
    end if;

  elsif t = 'charge.refunded' then
    -- packs only: take back the refunded share of the credits, as far as unspent purchased credits allow
    v_pi := o->>'payment_intent';
    select * into v_pay from studio.payments where stripe_payment_intent = v_pi for update;
    if v_pay.id is null then v_result := 'not a pack payment';
    else
      v_back := floor(v_pay.credits::numeric * ((o->>'amount_refunded')::int - v_pay.refunded_cents) / v_pay.amount_cents);
      select * into a from studio.accounts where owner = v_pay.owner for update;
      v_back := greatest(0, least(v_back, a.balance - a.plan_credits, a.balance - a.reserved));
      perform set_config('studio.purchased_only', 'on', true);       -- a clawback comes out of purchased credits
      update studio.accounts set balance = balance - v_back, updated_at = now() where owner = v_pay.owner;
      perform set_config('studio.purchased_only', '', true);
      update studio.payments set refunded_cents = (o->>'amount_refunded')::int where id = v_pay.id;
      insert into studio.credit_ledger(owner, kind, credits, note)
        values (v_pay.owner, 'clawback', v_back, 'refund of ' || v_pay.plan_id);
      v_result := 'took back ' || v_back;
    end if;
  else
    v_result := 'ignored';
  end if;
  update studio.stripe_events set result = v_result where id = p_event->>'id';
  return v_result;
end $$;

-- checkout needs the customer id kept per creator
create or replace function studio.set_stripe_customer(p_owner uuid, p_customer text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into studio.accounts(owner) values (p_owner) on conflict do nothing;
  update studio.accounts set stripe_customer_id = p_customer where owner = p_owner and stripe_customer_id is null;
end $$;

create or replace function studio.set_stripe_price(p_plan text, p_price text)
returns void language sql security definer set search_path = '' as $$
  update studio.price_plans set stripe_price_id = p_price where id = p_plan and stripe_price_id is null $$;

-- reserve_frame_credits (frames) refreshes the plan first so an expired month is never spent
create or replace function studio.reserve_frame_credits(p_owner uuid, p_cost int)
returns void language plpgsql security definer set search_path = '' as $$
declare v_acc studio.accounts;
begin
  if p_cost <= 0 then return; end if;
  insert into studio.accounts(owner) values (p_owner) on conflict do nothing;
  perform studio.refresh_plan(p_owner);
  select * into v_acc from studio.accounts where owner = p_owner for update;
  if v_acc.balance - v_acc.reserved < p_cost then
    raise exception 'not enough credits: need %, available %', p_cost, v_acc.balance - v_acc.reserved; end if;
  update studio.accounts set reserved = reserved + p_cost, updated_at = now() where owner = p_owner;
end $$;

revoke execute on all functions in schema studio from public, anon;
revoke execute on function studio.expire_plan_credits(uuid, text), studio.grant_plan_credits(uuid, int, text),
  studio.refresh_plan(uuid), studio.refresh_plans(), studio.plan_for_price(text, text), studio.owner_for(jsonb, text),
  studio.apply_stripe_event(jsonb), studio.set_stripe_customer(uuid, text), studio.set_stripe_price(text, text)
  from authenticated;
grant execute on function studio.refresh_my_plan() to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'studio_worker') then
    grant execute on function studio.refresh_plans() to studio_worker;
  end if;
end $$;
