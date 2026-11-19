-- Billing engine tests on the local database (run after e2e_reset.sh). @anlim
-- Fake Stripe events shaped like the 2025+ API (invoice.parent.subscription_details, line pricing.price_details).
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
create temp table out(n serial, line text);
grant all on out to authenticated; grant all on sequence out_n_seq to authenticated;
create or replace function pg_temp.acct() returns text language sql as $$
  select format('balance %s (plan %s, held %s) plan=%s status=%s next=%s', balance, plan_credits, reserved,
         coalesce(plan_id, '-'), coalesce(plan_status, '-'), coalesce(to_char(plan_next_refresh, 'YYYY-MM-DD'), '-'))
    from studio.accounts where owner = '00000000-0000-4000-8000-0000000c0de1' $$;
create or replace function pg_temp.cancel_state() returns text language sql as $$
  select 'cancelled=' || plan_cancel_at_period_end || ' ends ' || coalesce(to_char(plan_cancel_at, 'YYYY-MM-DD'), '-')
    from studio.accounts where owner = '00000000-0000-4000-8000-0000000c0de1' $$;
create or replace function pg_temp.ev(id text, typ text, obj jsonb) returns text language sql as $$
  select studio.apply_stripe_event(jsonb_build_object('id', id, 'type', typ, 'data', jsonb_build_object('object', obj))) $$;
create or replace function pg_temp.inv(id text, reason text, price text, amount int, pend timestamptz) returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'customer', 'cus_T', 'billing_reason', reason, 'amount_paid', amount,
    'parent', jsonb_build_object('subscription_details', jsonb_build_object('subscription', 'sub_T',
      'metadata', jsonb_build_object('owner', '00000000-0000-4000-8000-0000000c0de1'))),
    'lines', jsonb_build_object('data', jsonb_build_array(
      jsonb_build_object('amount', amount, 'pricing', jsonb_build_object('price_details', jsonb_build_object('price', price)),
                         'period', jsonb_build_object('end', extract(epoch from pend)))))) $$;
update studio.accounts set balance = 0, reserved = 0 where owner = '00000000-0000-4000-8000-0000000c0de1';
update studio.price_plans set stripe_price_id = 'price_' || id;
insert into out(line) select 'start: ' || pg_temp.acct();

-- pack purchase, then the same event again
insert into out(line) select 'pack: ' || pg_temp.ev('evt_1', 'checkout.session.completed', '{"mode":"payment","payment_status":"paid","customer":"cus_T","payment_intent":"pi_1","amount_total":2500,"metadata":{"owner":"00000000-0000-4000-8000-0000000c0de1","plan_id":"pack_2500_v1"}}') || ' -> ' || pg_temp.acct();
insert into out(line) select 'same event again: ' || pg_temp.ev('evt_1', 'checkout.session.completed', '{}') || ' -> ' || pg_temp.acct();
insert into out(line) select 'unpaid session: ' || pg_temp.ev('evt_1b', 'checkout.session.completed', '{"mode":"payment","payment_status":"unpaid","customer":"cus_T","metadata":{"owner":"00000000-0000-4000-8000-0000000c0de1","plan_id":"pack_1000_v1"}}');
insert into out(line) select 'fake owner: ' || pg_temp.ev('evt_1c', 'checkout.session.completed', '{"mode":"payment","payment_status":"paid","customer":"cus_X","payment_intent":"pi_x","metadata":{"owner":"00000000-0000-4000-8000-00000000dead","plan_id":"pack_5000_v1"}}');

-- monthly plan starts
insert into out(line) select 'pro monthly: ' || pg_temp.ev('evt_2', 'invoice.paid', pg_temp.inv('in_1', 'subscription_create', 'price_pro_month_v1', 4900, now() + interval '1 month')) || ' -> ' || pg_temp.acct();
-- spend 6,000: plan credits go first
update studio.accounts set reserved = 6000 where owner = '00000000-0000-4000-8000-0000000c0de1';
update studio.accounts set reserved = 0, balance = balance - 6000 where owner = '00000000-0000-4000-8000-0000000c0de1';
insert into out(line) select 'spent 6,000 (plan first): ' || pg_temp.acct();
-- renewal: no plan credits were left; new month
insert into out(line) select 'renewal: ' || pg_temp.ev('evt_3', 'invoice.paid', pg_temp.inv('in_2', 'subscription_cycle', 'price_pro_month_v1', 4900, now() + interval '2 month')) || ' -> ' || pg_temp.acct();
-- spend 400, then the next renewal: the 5,000 unused plan credits expire, 5,400 new
update studio.accounts set balance = balance - 400 where owner = '00000000-0000-4000-8000-0000000c0de1';
insert into out(line) select 'renewal with 5,000 unused: ' || pg_temp.ev('evt_4', 'invoice.paid', pg_temp.inv('in_3', 'subscription_cycle', 'price_pro_month_v1', 4900, now() + interval '3 month')) || ' -> ' || pg_temp.acct();
insert into out(line) select '  ledger: ' || string_agg(kind || ' ' || credits, ', ' order by id) from studio.credit_ledger
 where owner = '00000000-0000-4000-8000-0000000c0de1' and kind in ('plan','expire','purchase');
-- upgrade mid-month to Studio: top up 6,600, even when subscription.updated arrived first (live 2026-11-13)
insert into out(line) select 'sub updated first: ' || pg_temp.ev('evt_5a', 'customer.subscription.updated', '{"id":"sub_T","customer":"cus_T","status":"active","items":{"data":[{"price":{"id":"price_studio_month_v1"}}]}}') || ' -> ' || pg_temp.acct();
insert into out(line) select 'upgrade invoice: ' || pg_temp.ev('evt_5', 'invoice.paid', pg_temp.inv('in_4', 'subscription_update', 'price_studio_month_v1', 3000, now() + interval '3 month')
  #- '{lines}' || jsonb_build_object('lines', jsonb_build_object('data', jsonb_build_array(
     jsonb_build_object('amount', -1500, 'pricing', jsonb_build_object('price_details', jsonb_build_object('price', 'price_pro_month_v1')), 'period', jsonb_build_object('end', extract(epoch from now() + interval '3 month'))),
     jsonb_build_object('amount', 4500, 'pricing', jsonb_build_object('price_details', jsonb_build_object('price', 'price_studio_month_v1')), 'period', jsonb_build_object('end', extract(epoch from now() + interval '3 month')))))))
  || ' -> ' || pg_temp.acct();
-- failed renewal: past_due; period passes without payment -> plan credits expire after a day's grace
insert into out(line) select 'failed renewal: ' || pg_temp.ev('evt_6', 'invoice.payment_failed', '{"customer":"cus_T"}') || ' -> ' || pg_temp.acct();
-- Stripe moves the period forward even though the renewal failed (test clock 2026-11-13): period end in the future
update studio.accounts set plan_period_end = now() + interval '1 month', plan_next_refresh = now() - interval '2 days' where owner = '00000000-0000-4000-8000-0000000c0de1';
insert into out(line) select 'month over, unpaid: ' || studio.refresh_plan('00000000-0000-4000-8000-0000000c0de1') || ' -> ' || pg_temp.acct();
-- annual plan: credits monthly
insert into out(line) select 'creator annual: ' || pg_temp.ev('evt_7', 'invoice.paid', pg_temp.inv('in_5', 'subscription_create', 'price_creator_year_v1', 18240, now() + interval '1 year')) || ' -> ' || pg_temp.acct();
update studio.accounts set balance = balance - 900 where owner = '00000000-0000-4000-8000-0000000c0de1';
insert into out(line) select 'annual, month 2 not due: ' || studio.refresh_plan('00000000-0000-4000-8000-0000000c0de1');
update studio.accounts set plan_next_refresh = now() - interval '1 minute' where owner = '00000000-0000-4000-8000-0000000c0de1';
insert into out(line) select 'annual, month 2 (1,000 unused): ' || studio.refresh_plans() || ' account(s) -> ' || pg_temp.acct();
-- portal cancellation, flexible billing style: cancel_at set, cancel_at_period_end false (live 2026-11-13)
insert into out(line) select 'cancel via portal: ' || pg_temp.ev('evt_7c', 'customer.subscription.updated', jsonb_build_object('id','sub_T','customer','cus_T','status','active','cancel_at_period_end',false,'cancel_at',extract(epoch from now() + interval '1 year'),'items',jsonb_build_object('data',jsonb_build_array(jsonb_build_object('price',jsonb_build_object('id','price_creator_year_v1'),'current_period_end',extract(epoch from now() + interval '1 year')))))) || ' -> ' || pg_temp.cancel_state();
insert into out(line) select 'un-cancel: ' || pg_temp.ev('evt_7d', 'customer.subscription.updated', jsonb_build_object('id','sub_T','customer','cus_T','status','active','cancel_at_period_end',false,'cancel_at',null,'items',jsonb_build_object('data',jsonb_build_array(jsonb_build_object('price',jsonb_build_object('id','price_creator_year_v1')))))) || ' -> ' || pg_temp.cancel_state();
-- held credits survive expiry
update studio.accounts set reserved = 2000 where owner = '00000000-0000-4000-8000-0000000c0de1';
insert into out(line) select 'cancelled with 2,000 held: ' || pg_temp.ev('evt_8', 'customer.subscription.deleted', '{"id":"sub_T","customer":"cus_T","status":"canceled","items":{"data":[{"price":{"id":"price_creator_year_v1"},"current_period_end":0}]}}') || ' -> ' || pg_temp.acct();
update studio.accounts set reserved = 0 where owner = '00000000-0000-4000-8000-0000000c0de1';
-- refund of the 2,500 pack, half then full
insert into out(line) select 'half refund: ' || pg_temp.ev('evt_9', 'charge.refunded', '{"payment_intent":"pi_1","amount_refunded":1250}') || ' -> ' || pg_temp.acct();
insert into out(line) select 'rest refunded: ' || pg_temp.ev('evt_10', 'charge.refunded', '{"payment_intent":"pi_1","amount_refunded":2500}') || ' -> ' || pg_temp.acct();
insert into out(line) select 'unrelated event: ' || pg_temp.ev('evt_11', 'customer.created', '{}');
-- the app cannot call the Stripe functions
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000c0de1', false) \g /dev/null
do $$ begin perform studio.apply_stripe_event('{"id":"x","type":"invoice.paid"}');
  insert into out(line) values ('creator called apply_stripe_event: ALLOWED (bad)');
exception when insufficient_privilege then insert into out(line) values ('creator called apply_stripe_event: refused'); end $$;
insert into out(line) select 'creator refresh_my_plan: ' || studio.refresh_my_plan();
insert into out(line) select 'creator sees plans: ' || count(*) from studio.price_plans;
reset role;
select line from out order by n;
