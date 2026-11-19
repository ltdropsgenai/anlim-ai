-- Fix: a plan cancelled in the Stripe portal still showed "Renews …" (live test 2026-11-13). @anlim
-- Stripe's flexible billing mode cancels by setting subscription.cancel_at (a date) and leaves
-- cancel_at_period_end false; the handler only read cancel_at_period_end. Now: cancelled = either one, and the
-- end date is kept in accounts.plan_cancel_at (cancel_at, or the period end for the older style).
alter table studio.accounts add column if not exists plan_cancel_at timestamptz;

create or replace function studio.apply_subscription_state(p_owner uuid, o jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare p studio.price_plans; v_end timestamptz;
begin
  v_end := to_timestamp(coalesce(o->'items'->'data'->0->>'current_period_end', o->>'current_period_end')::double precision);
  p := studio.plan_for_price(o->'items'->'data'->0->'price'->>'id', o->'metadata'->>'plan_id');
  update studio.accounts set plan_status = o->>'status', stripe_subscription_id = o->>'id',
         plan_cancel_at_period_end = coalesce((o->>'cancel_at_period_end')::boolean, false) or (o->>'cancel_at') is not null,
         plan_cancel_at = case when (o->>'cancel_at') is not null then to_timestamp((o->>'cancel_at')::double precision)
                               when coalesce((o->>'cancel_at_period_end')::boolean, false) then coalesce(v_end, plan_period_end) end,
         plan_period_end = coalesce(v_end, plan_period_end), plan_id = coalesce(p.id, plan_id)
   where owner = p_owner;
end $$;
revoke execute on function studio.apply_subscription_state(uuid, jsonb) from public, anon, authenticated;

create or replace function studio.apply_stripe_event(p_event jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare
  t text := p_event->>'type'; o jsonb := p_event->'data'->'object'; v_owner uuid; p studio.price_plans; old_p studio.price_plans;
  v_meta jsonb; v_sub text; v_line jsonb; v_old_line jsonb; v_price text; v_end timestamptz; v_result text; v_pi text;
  v_pay studio.payments; v_back int; a studio.accounts;
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
         where stripe_price_id = coalesce(v_old_line->'pricing'->'price_details'->>'price', v_old_line->'price'->>'id');
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
    v_price := o->'items'->'data'->0->'price'->>'id';
    v_end := to_timestamp(coalesce(o->'items'->'data'->0->>'current_period_end', o->>'current_period_end')::double precision);
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
    end if;
  else
    v_result := 'ignored';
  end if;
  update studio.stripe_events set result = v_result where id = p_event->>'id';
  return v_result;
end $$;
revoke execute on function studio.apply_stripe_event(jsonb) from public, anon, authenticated;
