-- Creator accounts tests on the local database (after e2e_reset.sh). @anlim
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
create temp table out(n serial, line text);
grant all on out to authenticated; grant all on sequence out_n_seq to authenticated;
create or replace function pg_temp.st(u uuid) returns text language sql as $$
  select coalesce((select format('account=yes balance %s welcomed=%s', balance, welcome_granted_at is not null) from studio.accounts where owner = u), 'account=no') $$;
insert into auth.users(id, email) values ('a0000000-0000-4000-8000-0000000000a1', 'new@example.invalid');
insert into out(line) select 'signed up, unconfirmed: ' || pg_temp.st('a0000000-0000-4000-8000-0000000000a1');
update auth.users set email_confirmed_at = now() where id = 'a0000000-0000-4000-8000-0000000000a1';
insert into out(line) select 'email confirmed: ' || pg_temp.st('a0000000-0000-4000-8000-0000000000a1');
update auth.users set email_confirmed_at = null where id = 'a0000000-0000-4000-8000-0000000000a1';
update auth.users set email_confirmed_at = now() where id = 'a0000000-0000-4000-8000-0000000000a1';
insert into out(line) select 'confirmed again: ' || pg_temp.st('a0000000-0000-4000-8000-0000000000a1');
insert into auth.users(id, email, email_confirmed_at) values ('a0000000-0000-4000-8000-0000000000a2', 'oauth@example.invalid', now());
insert into out(line) select 'created already confirmed: ' || pg_temp.st('a0000000-0000-4000-8000-0000000000a2');
insert into out(line) select 'existing test user (no back-grant): ' || pg_temp.st('00000000-0000-4000-8000-0000000c0de1');
insert into out(line) select 'ledger: ' || string_agg(owner::text || ' ' || kind || ' ' || credits, ', ') from studio.credit_ledger where note = 'welcome credits';
update studio.settings set value = '0' where key = 'welcome_credits';
insert into auth.users(id, email, email_confirmed_at) values ('a0000000-0000-4000-8000-0000000000a3', 'zero@example.invalid', now());
insert into out(line) select 'welcome set to 0: ' || pg_temp.st('a0000000-0000-4000-8000-0000000000a3');
set role authenticated;
do $$ begin perform studio.grant_welcome('a0000000-0000-4000-8000-0000000000a3');
  insert into out(line) values ('creator called grant_welcome: ALLOWED (bad)');
exception when insufficient_privilege then insert into out(line) values ('creator called grant_welcome: refused'); end $$;
reset role;
select line from out order by n;
