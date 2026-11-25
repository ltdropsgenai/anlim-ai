-- Review 2026-11-24 (Londi: "Fix them all"). @anlim
--  1. Translations: each queued text records the account that asked for it, so studio-api can cap new texts at 200 a
--     day per account (each costs a Claude call on anlim's key; before, any account could queue them without limit).
--  2. Chargebacks: charge.dispute.created takes back what is left of the disputed pack's credits; what the account no
--     longer has becomes debt (debt blocks new reservations). Before, a dispute changed nothing.
--  3. Referrals: the purchase that paid a referral reward is recorded. When that purchase is disputed, both rewards
--     (inviter and invited) are taken back, with debt for what is gone; when it is refunded in full, both are taken back
--     as far as the balances allow (no debt: a refund is anlim's own decision and the inviter did nothing wrong).
--     Before, refunds and disputes left the 500 + 200 referral credits in place.
--  4. Grants: anon (and PUBLIC) lose EXECUTE on the trigger functions and likeness_statement made after the 11-21
--     grants migration. A trigger function's EXECUTE is only checked when a trigger is created, not when it fires.

-- 1 ---------------------------------------------------------------------------------------------------------------
alter table studio.translations add column if not exists owner uuid;
create index if not exists translations_owner_recent on studio.translations (owner, created_at) where owner is not null;

-- 3 (columns first: the functions below use them) -----------------------------------------------------------------
alter table studio.referrals add column if not exists payment_id bigint;
alter table studio.referrals add column if not exists reversed_at timestamptz;
alter table studio.referrals add column if not exists reversed_credits int not null default 0;
-- rewards already paid: the referred account's first payment is the one that paid them
update studio.referrals r set payment_id = (select p.id from studio.payments p where p.owner = r.referred order by p.created_at, p.id limit 1)
 where r.rewarded_at is not null and r.payment_id is null;

-- Takes up to p_credits from an account's balance; with p_debt, what it no longer has is added to its debt.
-- Returns the credits taken. Same rule as a reversed refund (studio.decide_refund): reserved credits are not touched.
create or replace function studio.take_credits(p_owner uuid, p_credits int, p_debt boolean, p_note text)
returns int language plpgsql security definer set search_path = '' as $$
declare a studio.accounts; v_take int;
begin
  if coalesce(p_credits, 0) <= 0 then return 0; end if;
  select * into a from studio.accounts where owner = p_owner for update;
  if a.owner is null then return 0; end if;
  v_take := greatest(0, least(p_credits, a.balance - a.reserved));
  update studio.accounts set balance = balance - v_take,
         debt = debt + case when p_debt then p_credits - v_take else 0 end,
         plan_credits = least(plan_credits, balance - v_take), updated_at = now() where owner = p_owner;
  if v_take > 0 then
    insert into studio.credit_ledger(owner, kind, credits, note) values (p_owner, 'clawback', v_take, p_note);
  end if;
  return v_take;
end $$;
revoke execute on function studio.take_credits(uuid, int, boolean, text) from public, anon, authenticated;

-- Takes back the referral rewards a payment paid (once). Returns what was taken, both accounts together.
create or replace function studio.reverse_referral(p_payment bigint, p_debt boolean, p_why text)
returns int language plpgsql security definer set search_path = '' as $$
declare r studio.referrals; v_mine int; v_theirs int; v_taken int := 0;
begin
  select * into r from studio.referrals where payment_id = p_payment and rewarded_at is not null and reversed_at is null for update;
  if not found then return 0; end if;
  v_mine := coalesce(r.credits, 0);
  select (value #>> '{}')::int into v_theirs from studio.settings where key = 'referral_credits_referred';
  v_taken := v_taken + studio.take_credits(r.referrer, v_mine, p_debt, 'referral reward taken back: ' || p_why);
  v_taken := v_taken + studio.take_credits(r.referred, coalesce(v_theirs, 0), p_debt, 'referral reward taken back: ' || p_why);
  update studio.referrals set reversed_at = now(), reversed_credits = v_taken where referred = r.referred;
  insert into studio.notifications(owner, kind, title, body, link)
    select who, 'referral', 'Referral credits taken back',
           format('The purchase that earned referral credits was %s, so those credits were taken back.', p_why), '/billing'
      from unnest(array[r.referrer, r.referred]) who;
  return v_taken;
end $$;
revoke execute on function studio.reverse_referral(bigint, boolean, text) from public, anon, authenticated;

-- the reward trigger, unchanged except that it records the payment that paid the reward
create or replace function studio.trg_referral_reward() returns trigger language plpgsql security definer set search_path = '' as $$
declare r studio.referrals; v_mine int; v_theirs int; v_cap int; who uuid; v_amount int;
begin
  select * into r from studio.referrals where referred = new.owner and rewarded_at is null for update;
  if not found then return new; end if;
  select (value #>> '{}')::int into v_mine from studio.settings where key = 'referral_credits_referrer';
  select (value #>> '{}')::int into v_theirs from studio.settings where key = 'referral_credits_referred';
  select (value #>> '{}')::int into v_cap from studio.settings where key = 'referral_monthly_cap';
  if coalesce(v_mine, 0) <= 0 then return new; end if;   -- the inviter's reward is the switch for the whole programme
  if (select count(*) from studio.referrals where referrer = r.referrer and rewarded_at > now() - interval '30 days') >= coalesce(v_cap, 20) then
    return new; end if;
  foreach who in array array[r.referrer, r.referred] loop
    v_amount := case when who = r.referrer then v_mine else coalesce(v_theirs, 0) end;
    continue when v_amount <= 0;
    insert into studio.accounts(owner) values (who) on conflict do nothing;
    update studio.accounts set balance = balance + v_amount, updated_at = now() where owner = who;
    insert into studio.credit_ledger(owner, kind, credits, note) values (who, 'grant', v_amount,
      case when who = r.referrer then 'referral: invited creator bought' else 'referral: joined from an invite' end);
    insert into studio.notifications(owner, kind, title, body, link)
      values (who, 'referral', 'Referral credits',
              case when who = r.referrer then format('%s credits were added: a creator you invited bought credits or a plan.', v_amount)
                   else format('%s credits were added for joining from an invite and making your first purchase.', v_amount) end, '/billing');
  end loop;
  update studio.referrals set rewarded_at = now(), credits = v_mine, payment_id = new.id where referred = r.referred;
  return new;
end $$;
revoke execute on function studio.trg_referral_reward() from public, anon, authenticated;

-- 2 + 3: the Stripe event handler. Unchanged except: charge.refunded also takes back the referral rewards when the
-- payment is refunded in full, and the new charge.dispute.created branch.
create or replace function studio.apply_stripe_event(p_event jsonb)
 returns text language plpgsql security definer set search_path to '' as $function$
declare
  t text := p_event->>'type'; o jsonb := p_event->'data'->'object'; v_owner uuid; p studio.price_plans; old_p studio.price_plans;
  v_meta jsonb; v_sub text; v_line jsonb; v_old_line jsonb; v_price text; v_end timestamptz; v_result text; v_pi text;
  v_pay studio.payments; v_back int; a studio.accounts; v_ref int;
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
    select l into v_line from jsonb_array_elements(o->'lines'->'data') l
     where coalesce((l->>'amount')::int, 0) > 0 order by (l->>'amount')::int desc limit 1;
    select l into v_old_line from jsonb_array_elements(o->'lines'->'data') l
     where coalesce((l->>'amount')::int, 0) < 0 order by (l->>'amount')::int asc limit 1;
    v_price := coalesce(v_line->'pricing'->'price_details'->>'price', v_line->'price'->>'id');
    v_end := to_timestamp((v_line->'period'->>'end')::double precision);
    v_owner := studio.owner_for(v_meta, o->>'customer');
    p := studio.plan_for_price(v_price, v_meta->>'plan_id');
    if v_sub is null then v_result := 'not a subscription invoice';
    elsif v_owner is null or p.id is null or p.kind <> 'plan' then v_result := 'unknown owner or plan';
    else
      insert into studio.accounts(owner) values (v_owner) on conflict do nothing;
      select * into a from studio.accounts where owner = v_owner for update;
      if v_old_line is not null then
        select * into old_p from studio.price_plans
         where coalesce(v_old_line->'pricing'->'price_details'->>'price', v_old_line->'price'->>'id') in (stripe_price_id, stripe_price_id_test);
      end if;
      if old_p.id is null then select * into old_p from studio.price_plans where id = a.plan_id; end if;
      insert into studio.payments(owner, plan_id, stripe_invoice, amount_cents, credits)
        values (v_owner, p.id, o->>'id', coalesce((o->>'amount_paid')::int, 0), p.credits) on conflict do nothing;
      update studio.accounts set plan_id = p.id, plan_status = 'active', stripe_subscription_id = v_sub,
             stripe_customer_id = coalesce(stripe_customer_id, o->>'customer'), plan_period_end = v_end where owner = v_owner;
      if o->>'billing_reason' = 'subscription_update' and old_p.id is not null and a.plan_next_refresh > now() then
        if p.credits > old_p.credits then
          update studio.accounts set balance = balance + (p.credits - old_p.credits),
                 plan_credits = plan_credits + (p.credits - old_p.credits), updated_at = now() where owner = v_owner;
          insert into studio.credit_ledger(owner, kind, credits, note)
            values (v_owner, 'plan', p.credits - old_p.credits, 'upgrade from ' || old_p.name || ' to ' || p.name);
          v_result := 'plan changed to ' || p.id || ', +' || (p.credits - old_p.credits);
        else
          v_result := 'plan changed to ' || p.id;
        end if;
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
    if v_owner is null then v_result := 'no owner';
    else
      perform studio.apply_subscription_state(v_owner, o);
      if t = 'customer.subscription.deleted' then
        perform studio.expire_plan_credits(v_owner, 'plan ended');
        update studio.accounts set plan_status = 'canceled', plan_next_refresh = null, plan_cancel_at_period_end = false,
               plan_cancel_at = null where owner = v_owner;
      end if;
      v_result := 'subscription ' || (o->>'status');
    end if;

  elsif t = 'charge.refunded' then
    v_pi := o->>'payment_intent';
    select * into v_pay from studio.payments where stripe_payment_intent = v_pi for update;
    if v_pay.id is null then v_result := 'not a pack payment';
    else
      v_back := floor(v_pay.credits::numeric * ((o->>'amount_refunded')::int - v_pay.refunded_cents) / v_pay.amount_cents);
      select * into a from studio.accounts where owner = v_pay.owner for update;
      v_back := greatest(0, least(v_back, a.balance - a.plan_credits, a.balance - a.reserved));
      perform set_config('studio.purchased_only', 'on', true);
      update studio.accounts set balance = balance - v_back, updated_at = now() where owner = v_pay.owner;
      perform set_config('studio.purchased_only', '', true);
      update studio.payments set refunded_cents = (o->>'amount_refunded')::int where id = v_pay.id;
      insert into studio.credit_ledger(owner, kind, credits, note)
        values (v_pay.owner, 'clawback', v_back, 'refund of ' || v_pay.plan_id);
      v_result := 'took back ' || v_back;
      -- review 2026-11-24: a purchase refunded in full no longer pays referral rewards
      if (o->>'amount_refunded')::int >= v_pay.amount_cents then
        v_ref := studio.reverse_referral(v_pay.id, false, 'refunded');
        if v_ref > 0 then v_result := v_result || ', referral ' || v_ref; end if;
      end if;
    end if;

  elsif t = 'charge.dispute.created' then
    -- review 2026-11-24: a chargeback. The money is held by the bank, so what is left of the pack's credits is taken
    -- back now; what the account no longer has becomes debt. A dispute anlim later wins does not give them back by itself
    -- (an admin grants them). A disputed plan invoice is not matched here (payments keep the invoice id, not the payment
    -- intent): it is logged for a look in Stripe.
    v_pi := o->>'payment_intent';
    select * into v_pay from studio.payments where stripe_payment_intent = v_pi for update;
    if v_pay.id is null then v_result := 'dispute: not a pack payment (check it in Stripe)';
    else
      v_back := floor(v_pay.credits::numeric * (v_pay.amount_cents - v_pay.refunded_cents) / v_pay.amount_cents);
      v_back := studio.take_credits(v_pay.owner, v_back, true, 'dispute of ' || v_pay.plan_id);
      update studio.payments set refunded_cents = amount_cents where id = v_pay.id;
      v_ref := studio.reverse_referral(v_pay.id, true, 'disputed');
      v_result := 'dispute: took back ' || v_back || case when v_ref > 0 then ', referral ' || v_ref else '' end;
    end if;
  else
    v_result := 'ignored';
  end if;
  update studio.stripe_events set result = v_result where id = p_event->>'id';
  return v_result;
end $function$;
revoke execute on function studio.apply_stripe_event(jsonb) from public, anon, authenticated;

-- 4 ---------------------------------------------------------------------------------------------------------------
revoke execute on function studio.trg_character_consent() from public, anon, authenticated;
revoke execute on function studio.trg_shot_consent() from public, anon, authenticated;
revoke execute on function studio.trg_mail_assembly() from public, anon, authenticated;
revoke execute on function studio.trg_mail_generation() from public, anon, authenticated;
revoke execute on function studio.likeness_statement() from public, anon;
grant execute on function studio.likeness_statement() to authenticated;
