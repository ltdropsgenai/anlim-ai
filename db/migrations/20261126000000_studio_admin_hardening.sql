-- Admin console hardening (2026-11-25 review, Londi: "Fix all then run the migration"). @anlim
--   1. An account becomes an admin only once it has its own two-step code (a verified TOTP factor). Before this, a new
--      admin set the code up on their first visit to the console, so whoever had their password first could claim it.
--      They now set it up beforehand at anlim.ai/admin (the page offers the set-up to signed-in non-admins).
--   2. Admins (not the owner) may give at most 20,000 credits in any 24 hours, all grants together.
--   3. studio-health answers only calls that carry the key kept in Vault (the 15-minute schedule sends it), so a stranger
--      can no longer make it run its checks. The key is made here and never leaves the database.

-- 1
create or replace function studio.admin_add(p_email text)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v uuid;
begin
  if studio.admin_guard() <> 'owner' then raise exception 'only the owner adds admins'; end if;
  select id into v from auth.users where lower(email) = lower(trim(coalesce(p_email, '')));
  if v is null then raise exception 'no account with that email: they sign up first'; end if;
  if exists (select 1 from studio.user_blocks where owner = v and (until is null or until > now())) then raise exception 'that account is blocked'; end if;
  if exists (select 1 from studio.admins where user_id = v) then raise exception 'already an admin'; end if;
  if not exists (select 1 from auth.mfa_factors f where f.user_id = v and f.status = 'verified') then
    raise exception 'that account has no two-step code yet: they sign in, open anlim.ai/admin and set it up, then add them';
  end if;
  insert into studio.admins(user_id, role, added_by) values (v, 'admin', auth.uid());
  perform studio.admin_note('add_admin', v, '{}'::jsonb);
  return v;
end $$;

-- 2
create or replace function studio.admin_grant(p_user uuid, p_credits int, p_note text)
returns int language plpgsql security definer set search_path to '' as $$
declare v int; v_role text := studio.admin_guard(); v_given int;
begin
  if p_credits is null or p_credits < 1 or p_credits > 20000 then raise exception 'credits must be 1 to 20000'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'give a reason'; end if;
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'account not found'; end if;
  if v_role <> 'owner' then
    perform pg_advisory_xact_lock(hashtext('admin_grant:' || auth.uid()::text));   -- two grants at once cannot both fit
    select coalesce(sum((detail ->> 'credits')::int), 0) into v_given from studio.admin_log
     where admin_id = auth.uid() and action = 'grant_credits' and at > now() - interval '24 hours';
    if v_given + p_credits > 20000 then
      raise exception 'admins can give at most 20000 credits in 24 hours (% left now); the owner has no limit', greatest(0, 20000 - v_given);
    end if;
  end if;
  v := studio.grant_credits(p_user, p_credits, 'grant', 'admin: ' || left(trim(p_note), 300));
  perform studio.admin_note('grant_credits', p_user, jsonb_build_object('credits', p_credits, 'note', left(trim(p_note), 300), 'balance', v));
  return v;
end $$;
revoke execute on function studio.admin_grant(uuid, int, text) from public, anon;
grant execute on function studio.admin_grant(uuid, int, text) to authenticated;
revoke execute on function studio.admin_add(text) from public, anon;
grant execute on function studio.admin_add(text) to authenticated;

-- 3
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'studio_health_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'studio_health_key', 'studio-health: the schedule''s key');
  end if;
end $$;

select cron.unschedule(jobid) from cron.job where jobname = 'studio-health';
select cron.schedule('studio-health', '*/15 * * * *', $job$
  select net.http_post(
    url := 'https://zejyuxnuzmvlcbpfklrg.supabase.co/functions/v1/studio-health',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-health-key', (select decrypted_secret from vault.decrypted_secrets where name = 'studio_health_key')),
    timeout_milliseconds := 20000)
$job$);
