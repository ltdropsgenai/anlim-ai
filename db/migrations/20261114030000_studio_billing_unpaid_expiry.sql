-- Fix: unpaid plan credits lasted an extra month (Stripe test clock, 2026-11-13). @anlim
-- When a renewal fails, Stripe still moves the subscription's period forward (customer.subscription.updated carries
-- the new, unpaid period end), and refresh_plan expired credits a day after plan_period_end, i.e. a month late.
-- Now the "not renewed" expiry keys on plan_next_refresh, which only moves when credits were actually given
-- (paid invoice, or an annual refill inside a paid year).
create or replace function studio.refresh_plan(p_owner uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare a studio.accounts; p studio.price_plans;
begin
  select * into a from studio.accounts where owner = p_owner for update;
  if not found or a.plan_next_refresh is null or a.plan_next_refresh > now() then return 'nothing due'; end if;
  select * into p from studio.price_plans where id = a.plan_id;
  if a.plan_status in ('active','trialing') and p.billing_interval = 'year' and a.plan_period_end is not null
     and a.plan_next_refresh < a.plan_period_end - interval '1 day' then
    -- inside a paid annual period: this month's credits
    perform studio.grant_plan_credits(p_owner, p.credits, p.name || ' monthly credits (annual plan)');
    update studio.accounts set plan_next_refresh = least(plan_next_refresh + interval '1 month', plan_period_end) where owner = p_owner;
    return 'refilled';
  end if;
  if now() > a.plan_next_refresh + interval '1 day' then
    perform studio.expire_plan_credits(p_owner, 'plan month ended without a paid renewal');
    update studio.accounts set plan_next_refresh = null where owner = p_owner;
    return 'expired';
  end if;
  return 'waiting for renewal';
end $$;
revoke execute on function studio.refresh_plan(uuid) from public, anon, authenticated;
