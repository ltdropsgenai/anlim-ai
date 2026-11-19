-- Trial guard (2026-11-18): welcome credits once per person, not once per account.
--  1. one grant per normalized email, remembered even after the account is deleted (hash only, no raw email)
--     normalized = lower case, "+tag" dropped, Gmail dots dropped, googlemail.com -> gmail.com
--  2. no welcome credits for throwaway-email domains (studio.disposable_domains, subdomains included)
--  3. circuit breaker: at most studio.settings.welcome_daily_cap grants per rolling 24 h; the rest wait
--     as 'held' until studio.release_held_welcomes() is run.
-- Sign-up itself is never blocked: an account that gets no welcome credits still works and can buy credits.

create table if not exists studio.welcome_claims (
  email_key  text primary key,           -- sha256 hex of the normalized email
  owner      uuid not null,
  claimed_at timestamptz not null default now()
);
alter table studio.welcome_claims enable row level security;   -- no policies: definer functions only
revoke all on studio.welcome_claims from public, anon, authenticated;

create table if not exists studio.disposable_domains (domain text primary key);
alter table studio.disposable_domains enable row level security;
revoke all on studio.disposable_domains from public, anon, authenticated;

alter table studio.accounts add column if not exists welcome_status text
  check (welcome_status in ('granted','repeat','disposable','held','off'));

insert into studio.settings(key, value, note) values
  ('welcome_daily_cap', '50'::jsonb, 'most welcome grants per rolling 24 h; more wait as held (2026-11-18)')
on conflict (key) do nothing;

create or replace function studio.email_key(p_email text) returns text
language plpgsql immutable set search_path to '' as $$
declare e text := lower(trim(coalesce(p_email,''))); at int; loc text; dom text;
begin
  at := length(e) - position('@' in reverse(e)) + 1;          -- last @
  if at < 2 or at = length(e) + 1 then return encode(sha256(convert_to(e,'UTF8')),'hex'); end if;
  loc := split_part(left(e, at - 1), '+', 1);
  dom := substr(e, at + 1);
  if dom in ('gmail.com','googlemail.com') then loc := replace(loc, '.', ''); dom := 'gmail.com'; end if;
  return encode(sha256(convert_to(loc || '@' || dom, 'UTF8')), 'hex');
end $$;

create or replace function studio.is_disposable(p_email text) returns boolean
language sql stable security definer set search_path to '' as $$
  with d as (select lower(trim(substr(p_email, length(p_email) - position('@' in reverse(p_email)) + 2))) as dom),
       parts as (select string_to_array(dom, '.') a from d),
       suffixes as (select array_to_string(a[i:array_length(a,1)], '.') s
                      from parts, generate_series(1, greatest(array_length(a,1) - 1, 1)) i)
  select exists (select 1 from studio.disposable_domains x join suffixes on x.domain = suffixes.s);
$$;

create or replace function studio.grant_welcome(p_owner uuid) returns integer
language plpgsql security definer set search_path to '' as $$
declare
  v     int := coalesce((select (value #>> '{}')::int from studio.settings where key = 'welcome_credits'), 0);
  v_cap int := coalesce((select (value #>> '{}')::int from studio.settings where key = 'welcome_daily_cap'), 50);
  v_email text; v_key text; v_holder uuid; v_recent int;
begin
  insert into studio.accounts(owner) values (p_owner) on conflict do nothing;
  if exists (select 1 from studio.accounts where owner = p_owner and welcome_granted_at is not null) then return 0; end if;
  perform pg_advisory_xact_lock(hashtext('studio.grant_welcome'));        -- one grant decision at a time

  if v <= 0 then
    update studio.accounts set welcome_granted_at = now(), welcome_status = 'off', updated_at = now() where owner = p_owner;
    return 0;
  end if;

  select email into v_email from auth.users where id = p_owner;
  if v_email is null then return 0; end if;                              -- phone-only sign-up: not handled, nothing granted

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

  select count(*) into v_recent from studio.credit_ledger
   where kind = 'grant' and note = 'welcome credits' and created_at > now() - interval '24 hours';
  if v_recent >= v_cap then
    update studio.accounts set welcome_status = 'held', updated_at = now() where owner = p_owner;   -- granted later
    return 0;
  end if;

  update studio.accounts set welcome_granted_at = now(), welcome_status = 'granted',
         balance = balance + v, updated_at = now() where owner = p_owner;
  insert into studio.credit_ledger(owner, kind, credits, note) values (p_owner, 'grant', v, 'welcome credits');
  return v;
end $$;
revoke all on function studio.grant_welcome(uuid) from public, anon, authenticated;

-- Owner-run: grant held welcomes, oldest first, ignoring the daily cap. Returns how many were granted.
create or replace function studio.release_held_welcomes(p_limit int default 50) returns integer
language plpgsql security definer set search_path to '' as $$
declare r record; n int := 0;
  v int := coalesce((select (value #>> '{}')::int from studio.settings where key = 'welcome_credits'), 0);
begin
  if v <= 0 then return 0; end if;
  for r in select owner from studio.accounts where welcome_status = 'held' and welcome_granted_at is null
           order by updated_at limit greatest(p_limit, 0) loop
    update studio.accounts set welcome_granted_at = now(), welcome_status = 'granted',
           balance = balance + v, updated_at = now() where owner = r.owner and welcome_granted_at is null;
    if found then
      insert into studio.credit_ledger(owner, kind, credits, note) values (r.owner, 'grant', v, 'welcome credits');
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function studio.release_held_welcomes(int) from public, anon, authenticated;
revoke all on function studio.email_key(text) from public, anon, authenticated;
revoke all on function studio.is_disposable(text) from public, anon, authenticated;

-- Existing accounts: remember the emails that already had their welcome, so re-sign-ups don't get a second one.
insert into studio.welcome_claims(email_key, owner)
select studio.email_key(u.email), u.id
  from auth.users u join studio.accounts a on a.owner = u.id
 where a.welcome_granted_at is not null and u.email is not null
on conflict do nothing;
update studio.accounts a set welcome_status = 'granted'
 where welcome_status is null
   and exists (select 1 from studio.credit_ledger l where l.owner = a.owner and l.kind = 'grant' and l.note = 'welcome credits');

-- Data: studio.disposable_domains loaded 2026-11-18 from db/data/disposable_email_blocklist.conf
-- (github.com/disposable-email-domains/disposable-email-domains, 10,400 domains) through a temporary
-- definer function studio._load_disposable(text[]) granted to studio_worker; that function is to be dropped.
