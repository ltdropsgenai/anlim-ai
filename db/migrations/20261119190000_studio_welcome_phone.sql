-- SMS check before free credits (2026-11-19; Londi 2026-11-18: "CAPTCHA and Phone SMS checks ... before launch").
-- Off until studio.settings welcome_requires_phone = true, which needs Supabase Auth's phone provider (an SMS service
-- such as Twilio) set up first. When on: a new account's welcome credits wait ('needs_phone') until the creator
-- verifies a phone number in the app; one phone number gets the welcome credits once (hash kept, like the email). @anlim
alter table studio.accounts drop constraint if exists accounts_welcome_status_check;
alter table studio.accounts add constraint accounts_welcome_status_check
  check (welcome_status = any (array['granted', 'repeat', 'disposable', 'held', 'off', 'needs_phone']));

create table if not exists studio.welcome_phone_claims (
  phone_key  text primary key,           -- sha256 of the phone number in E.164 digits, never the number itself
  owner      uuid not null,
  created_at timestamptz not null default now()
);
alter table studio.welcome_phone_claims enable row level security;
revoke all on studio.welcome_phone_claims from public, anon, authenticated;

insert into studio.settings(key, value) values ('welcome_requires_phone', 'false'::jsonb) on conflict (key) do nothing;

create or replace function studio.grant_welcome(p_owner uuid)
returns integer language plpgsql security definer set search_path to '' as $function$
declare
  v     int := coalesce((select (value #>> '{}')::int from studio.settings where key = 'welcome_credits'), 0);
  v_cap int := coalesce((select (value #>> '{}')::int from studio.settings where key = 'welcome_daily_cap'), 50);
  v_phone_on boolean := coalesce((select (value #>> '{}')::boolean from studio.settings where key = 'welcome_requires_phone'), false);
  v_email text; v_phone text; v_phone_ok timestamptz; v_key text; v_holder uuid; v_recent int;
begin
  insert into studio.accounts(owner) values (p_owner) on conflict do nothing;
  if exists (select 1 from studio.accounts where owner = p_owner and welcome_granted_at is not null) then return 0; end if;
  perform pg_advisory_xact_lock(hashtext('studio.grant_welcome'));

  if v <= 0 then
    update studio.accounts set welcome_granted_at = now(), welcome_status = 'off', updated_at = now() where owner = p_owner;
    return 0;
  end if;

  select email, phone, phone_confirmed_at into v_email, v_phone, v_phone_ok from auth.users where id = p_owner;
  if v_email is null then return 0; end if;

  if studio.is_disposable(v_email) then
    update studio.accounts set welcome_granted_at = now(), welcome_status = 'disposable', updated_at = now() where owner = p_owner;
    return 0;
  end if;

  v_key := studio.email_key(v_email);
  insert into studio.welcome_claims(email_key, owner) values (v_key, p_owner) on conflict do nothing;
  select owner into v_holder from studio.welcome_claims where email_key = v_key;
  if v_holder <> p_owner then
    update studio.accounts set welcome_granted_at = now(), welcome_status = 'repeat', updated_at = now() where owner = p_owner;
    return 0;
  end if;

  -- phone check (when on): wait for a verified number; one number, one welcome
  if v_phone_on then
    if v_phone_ok is null or coalesce(v_phone, '') = '' then
      update studio.accounts set welcome_status = 'needs_phone', updated_at = now() where owner = p_owner;
      return 0;
    end if;
    v_key := encode(sha256(convert_to(regexp_replace(v_phone, '[^0-9]', '', 'g'), 'UTF8')), 'hex');
    insert into studio.welcome_phone_claims(phone_key, owner) values (v_key, p_owner) on conflict do nothing;
    select owner into v_holder from studio.welcome_phone_claims where phone_key = v_key;
    if v_holder <> p_owner then
      update studio.accounts set welcome_granted_at = now(), welcome_status = 'repeat', updated_at = now() where owner = p_owner;
      return 0;
    end if;
  end if;

  select count(*) into v_recent from studio.credit_ledger
   where kind = 'grant' and note = 'welcome credits' and created_at > now() - interval '24 hours';
  if v_recent >= v_cap then
    update studio.accounts set welcome_status = 'held', updated_at = now() where owner = p_owner;
    return 0;
  end if;

  update studio.accounts set welcome_granted_at = now(), welcome_status = 'granted',
         balance = balance + v, updated_at = now() where owner = p_owner;
  insert into studio.credit_ledger(owner, kind, credits, note) values (p_owner, 'grant', v, 'welcome credits');
  return v;
end $function$;

-- also run the welcome check when a phone number is verified
create or replace function studio.on_auth_user()
returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  insert into studio.accounts(owner) values (new.id) on conflict do nothing;
  if (new.email_confirmed_at is not null and (tg_op = 'INSERT' or old.email_confirmed_at is null))
     or (tg_op = 'UPDATE' and new.phone_confirmed_at is not null and old.phone_confirmed_at is distinct from new.phone_confirmed_at) then
    perform studio.grant_welcome(new.id);
  end if;
  return new;
exception when others then
  raise warning 'studio.on_auth_user(%): %', new.id, sqlerrm;
  return new;
end $function$;

drop trigger if exists studio_on_auth_user on auth.users;
create trigger studio_on_auth_user after insert or update of email_confirmed_at, phone_confirmed_at on auth.users
  for each row execute function studio.on_auth_user();
