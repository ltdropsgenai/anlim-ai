-- Creator accounts: self sign-up with a one-time welcome grant. @anlim
-- Decided with Londi 2026-11-13: this project (formerly RideLink, abandoned) is the video app's own; its sign-in
-- held only our 3 test users. New creators get 300 credits once (a made start frame + 3-4 MiniMax clips; costs
-- ~$1.17 at ~0.39 c/credit). The grant waits for a confirmed email so unconfirmed sign-ups can't farm credits,
-- and accounts.welcome_granted_at makes it once per account no matter how often the trigger fires.
create table if not exists studio.settings (key text primary key, value jsonb not null, note text);
insert into studio.settings(key, value, note) values
  ('welcome_credits', '300', 'credits given once when a new creator confirms their email (2026-11-13)')
on conflict (key) do nothing;
alter table studio.settings enable row level security;          -- no policies: read only by security definer code

alter table studio.accounts add column if not exists welcome_granted_at timestamptz;

create or replace function studio.grant_welcome(p_owner uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare v int := coalesce((select (value #>> '{}')::int from studio.settings where key = 'welcome_credits'), 0);
begin
  insert into studio.accounts(owner) values (p_owner) on conflict do nothing;
  update studio.accounts set welcome_granted_at = now(), balance = balance + greatest(v, 0), updated_at = now()
   where owner = p_owner and welcome_granted_at is null;
  if not found or v <= 0 then return 0; end if;
  insert into studio.credit_ledger(owner, kind, credits, note) values (p_owner, 'grant', v, 'welcome credits');
  return v;
end $$;

-- auth.users: an account row for every new user; the welcome grant once the email is confirmed
create or replace function studio.on_auth_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into studio.accounts(owner) values (new.id) on conflict do nothing;
  if new.email_confirmed_at is not null and (tg_op = 'INSERT' or old.email_confirmed_at is null) then
    perform studio.grant_welcome(new.id);
  end if;
  return new;
exception when others then
  raise warning 'studio.on_auth_user(%): %', new.id, sqlerrm;    -- never block a sign-up or sign-in over credits
  return new;
end $$;
drop trigger if exists studio_on_auth_user on auth.users;
create trigger studio_on_auth_user after insert or update of email_confirmed_at on auth.users
  for each row execute function studio.on_auth_user();

-- existing users (our test identities) are treated as already welcomed: no back-grant
update studio.accounts set welcome_granted_at = coalesce(welcome_granted_at, now());
insert into studio.accounts(owner, welcome_granted_at) select id, now() from auth.users on conflict (owner) do nothing;

revoke execute on all functions in schema studio from public, anon;
revoke execute on function studio.grant_welcome(uuid), studio.on_auth_user() from authenticated;
