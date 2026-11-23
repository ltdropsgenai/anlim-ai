-- Sandbox for dev, live for everyone else (2026-11-23). @anlim
-- anlim moves to its own Stripe account (anlim.ai, under the CodeAscent LLC organization). That account has a live
-- mode and a sandbox. Accounts flagged billing_test (the dev and test accounts) pay in the sandbox; every other
-- account pays live. The billing function holds both keys and both webhook signing secrets and picks one per account.
--   * accounts.billing_test: which Stripe mode an account uses. Changing it clears the account's Stripe ids, because
--     a customer or subscription from one mode does not exist in the other.
--   * price_plans.stripe_price_id is the live price cache; stripe_price_id_test is the sandbox one.
--   * studio.apply_stripe_event_checked(event, live): the webhook's entry point. A sandbox event may only touch a
--     billing_test account and a live event only a normal one, so a free sandbox payment can never credit a real
--     account (and a real payment never lands on a test account by mistake).
--   * Every Stripe id cached so far came from the old account and is cleared. The dev account's plan from that old
--     sandbox is marked canceled (nothing can renew it any more, and an "active" plan would block testing checkout).

alter table studio.accounts add column if not exists billing_test boolean not null default false;
alter table studio.price_plans add column if not exists stripe_price_id_test text;

-- Stripe ids belong to one mode: flipping the flag forgets them (the next checkout makes new ones).
create or replace function studio.accounts_billing_mode_changed()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.billing_test is distinct from old.billing_test then
    new.stripe_customer_id := null;
    new.stripe_subscription_id := null;
  end if;
  return new;
end $$;
drop trigger if exists accounts_billing_mode_changed on studio.accounts;
create trigger accounts_billing_mode_changed before update of billing_test on studio.accounts
  for each row execute function studio.accounts_billing_mode_changed();

-- A price id from either mode finds its plan.
create or replace function studio.plan_for_price(p_price text, p_fallback text)
returns studio.price_plans language sql stable security definer set search_path = '' as $$
  select * from studio.price_plans
   where (p_price is not null and (stripe_price_id = p_price or stripe_price_id_test = p_price)) or id = p_fallback
   order by (p_price is not null and (stripe_price_id = p_price or stripe_price_id_test = p_price)) desc limit 1 $$;

create or replace function studio.set_stripe_price_mode(p_plan text, p_live boolean, p_price text)
returns void language sql security definer set search_path = '' as $$
  update studio.price_plans set stripe_price_id = p_price where p_live and id = p_plan and stripe_price_id is null;
  update studio.price_plans set stripe_price_id_test = p_price where not p_live and id = p_plan and stripe_price_id_test is null $$;

-- The webhook's entry point: the event's mode must match the account it would change.
create or replace function studio.apply_stripe_event_checked(p_event jsonb, p_live boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
  o jsonb := p_event->'data'->'object';
  v_meta jsonb := coalesce(o->'metadata', '{}') || coalesce(o->'subscription_details'->'metadata', '{}')
                  || coalesce(o->'parent'->'subscription_details'->'metadata', '{}');
  v_owner uuid;
  v_test boolean;
begin
  if coalesce((p_event->>'livemode')::boolean, false) <> p_live then
    return 'ignored: event mode does not match its signing secret';
  end if;
  v_owner := studio.owner_for(v_meta, o->>'customer');
  if v_owner is not null then
    select billing_test into v_test from studio.accounts where owner = v_owner;
    if coalesce(v_test, false) = p_live then                -- live event on a test account, or sandbox on a real one
      return case when p_live then 'ignored: live event for a test account' else 'ignored: sandbox event for a live account' end;
    end if;
  end if;
  return studio.apply_stripe_event(p_event);
end $$;

revoke execute on function studio.accounts_billing_mode_changed(), studio.plan_for_price(text, text),
  studio.set_stripe_price_mode(text, boolean, text), studio.apply_stripe_event_checked(jsonb, boolean)
  from public, anon, authenticated;

-- One-time move to the new Stripe account.
update studio.price_plans set stripe_price_id = null, stripe_price_id_test = null;
update studio.accounts set plan_status = 'canceled', plan_cancel_at_period_end = false, plan_cancel_at = null,
       plan_next_refresh = null
 where stripe_subscription_id is not null and plan_status in ('active', 'trialing', 'past_due');
update studio.accounts set stripe_customer_id = null, stripe_subscription_id = null
 where stripe_customer_id is not null or stripe_subscription_id is not null;
-- The sandbox accounts (Londi, 2026-11-23): creator-dev, billing-clock-test, tlondi, londitangu.
insert into studio.accounts(owner)
  select id from auth.users where id in ('eca1c5f2-96a7-4a01-9a7d-a19e8afa6561', 'c10c0000-0000-4000-8000-00000000c10c',
                                         'c5946314-e649-4bb3-b753-5c17ea22ef8a', 'd0ad38ff-869a-4ff0-be6e-3a8828d3a741')
  on conflict do nothing;
update studio.accounts set billing_test = true
 where owner in ('eca1c5f2-96a7-4a01-9a7d-a19e8afa6561', 'c10c0000-0000-4000-8000-00000000c10c',
                 'c5946314-e649-4bb3-b753-5c17ea22ef8a', 'd0ad38ff-869a-4ff0-be6e-3a8828d3a741');
