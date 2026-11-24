-- Referral amounts (2026-11-23, Londi): the inviter gets 500 credits and the invited creator 200, on top of the welcome
-- credits every new account gets. Paid out, as before, when the invited creator first buys credits or a plan (the
-- welcome credits alone never pay a referral), at most referral_monthly_cap rewards per inviter in 30 days. @anlim
insert into studio.settings(key, value, note) values ('referral_credits_referrer', '500'::jsonb,
  'credits for the inviter when a creator they invited first buys credits or a plan; 0 = off (2026-11-23)')
on conflict (key) do update set value = excluded.value, note = excluded.note;
insert into studio.settings(key, value, note) values ('referral_credits_referred', '200'::jsonb,
  'credits for the invited creator at their first purchase, on top of the welcome credits; 0 = none (2026-11-23)')
on conflict (key) do update set value = excluded.value, note = excluded.note;
update studio.settings set note = 'replaced by referral_credits_referrer and referral_credits_referred (2026-11-23); unused'
 where key = 'referral_credits';

create or replace function studio.my_referral() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_code text; v_mine int; v_theirs int;
begin
  if v_uid is null then raise exception 'sign in first'; end if;
  insert into studio.accounts(owner) values (v_uid) on conflict do nothing;
  select referral_code into v_code from studio.accounts where owner = v_uid;
  while v_code is null loop
    v_code := substr(md5(random()::text || clock_timestamp()::text || v_uid::text), 1, 8);
    begin update studio.accounts set referral_code = v_code where owner = v_uid and referral_code is null;
    exception when unique_violation then v_code := null; end;
  end loop;
  select (value #>> '{}')::int into v_mine from studio.settings where key = 'referral_credits_referrer';
  select (value #>> '{}')::int into v_theirs from studio.settings where key = 'referral_credits_referred';
  return jsonb_build_object('code', v_code, 'credits', coalesce(v_mine, 0), 'referred_credits', coalesce(v_theirs, 0),
    'invited', (select count(*) from studio.referrals where referrer = v_uid),
    'rewarded', (select count(*) from studio.referrals where referrer = v_uid and rewarded_at is not null));
end $$;
revoke execute on function studio.my_referral() from public, anon;
grant execute on function studio.my_referral() to authenticated;

create or replace function studio.trg_referral_reward() returns trigger
language plpgsql security definer set search_path = '' as $$
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
  update studio.referrals set rewarded_at = now(), credits = v_mine where referred = r.referred;
  return new;
end $$;
