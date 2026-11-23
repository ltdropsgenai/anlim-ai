-- Guard the billing-mode switch (review 2026-11-23, finding 1). @anlim
-- Flipping accounts.billing_test forgets the account's Stripe customer and subscription ids (they belong to one Stripe
-- mode). If the account still has a plan Stripe is charging, that subscription keeps billing in the old mode while
-- studio.apply_stripe_event_checked refuses its events for the new mode: the creator pays and gets no credits, and
-- account deletion can no longer find the customer to cancel it. So the switch is refused while a plan is live; cancel
-- the plan first (Stripe billing portal or dashboard), then flip the flag.
create or replace function studio.accounts_billing_mode_changed()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.billing_test is distinct from old.billing_test then
    if old.stripe_subscription_id is not null and old.plan_status in ('active', 'trialing', 'past_due') then
      raise exception 'This account has a % plan in Stripe (%). Cancel it first, then switch its billing mode.',
        old.plan_status, case when old.billing_test then 'sandbox' else 'live' end;
    end if;
    new.stripe_customer_id := null;
    new.stripe_subscription_id := null;
  end if;
  return new;
end $$;
revoke execute on function studio.accounts_billing_mode_changed() from public, anon, authenticated;
