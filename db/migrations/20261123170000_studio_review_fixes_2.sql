-- Review fixes, second batch, and the dev account's credit refill (2026-11-23, Londi: "fix all the issues"). @anlim
-- The two large functions are patched in place: their live definition is read, one exact piece of text is replaced,
-- and the function is recreated. Each patch refuses to run if its text is not found exactly as expected, so a
-- definition that changed since this was written is never half-edited.

-- 1. request_assembly: when more than one take is marked in_cut, the newest is used (was: any one, review finding 6).
do $$
declare d text; n int;
begin
  d := pg_get_functiondef('studio.request_assembly(uuid, text, jsonb)'::regprocedure);
  n := (length(d) - length(replace(d, 'a.in_cut and a.status = ''done'' limit 1', ''))) / length('a.in_cut and a.status = ''done'' limit 1');
  if n <> 3 then raise exception 'request_assembly: expected 3 take lookups, found %', n; end if;
  execute replace(d, 'a.in_cut and a.status = ''done'' limit 1', 'a.in_cut and a.status = ''done'' order by a.created_at desc limit 1');
end $$;

-- 2. apply_stripe_event: an upgrade's old plan is found by its sandbox price too, so sandbox upgrades get the same
--    top-up credits as live ones (review finding 8).
do $$
declare d text;
  old_txt text := 'where stripe_price_id = coalesce(v_old_line->''pricing''->''price_details''->>''price'', v_old_line->''price''->>''id'');';
  new_txt text := 'where coalesce(v_old_line->''pricing''->''price_details''->>''price'', v_old_line->''price''->>''id'') in (stripe_price_id, stripe_price_id_test);';
begin
  d := pg_get_functiondef('studio.apply_stripe_event(jsonb)'::regprocedure);
  if position(old_txt in d) = 0 then raise exception 'apply_stripe_event: old-plan lookup not found'; end if;
  execute replace(d, old_txt, new_txt);
end $$;

-- 3. The dev account's refill (Londi, 2026-11-23): instead of unlimited credits, an account listed here is topped back
--    up to `target` whenever its spendable credits (balance - reserved) drop below `floor`. Real provider spending stays
--    bounded: one runaway day can spend at most one refill before someone notices the ledger lines.
create table if not exists studio.credit_refills (
  owner uuid primary key references studio.accounts(owner) on delete cascade,
  floor_credits int not null check (floor_credits >= 0),
  target_credits int not null check (target_credits > floor_credits),
  created_at timestamptz not null default now()
);
alter table studio.credit_refills enable row level security;   -- no policies: creators cannot read or change it
revoke all on studio.credit_refills from public, anon, authenticated;

create or replace function studio.accounts_refill()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r studio.credit_refills; v_add int;
begin
  select * into r from studio.credit_refills where owner = new.owner;
  if r.owner is not null and new.balance - new.reserved < r.floor_credits then
    v_add := r.target_credits - (new.balance - new.reserved);
    new.balance := new.balance + v_add;
    insert into studio.credit_ledger(owner, kind, credits, note) values (new.owner, 'grant', v_add, 'dev account refill');
  end if;
  return new;
end $$;
revoke execute on function studio.accounts_refill() from public, anon, authenticated;
-- named to run last among the accounts triggers (they fire in name order): plan-first spending and debt repayment
-- see the real charge before the refill tops the balance back up
drop trigger if exists accounts_zz_refill on studio.accounts;
create trigger accounts_zz_refill before update of balance, reserved on studio.accounts
  for each row execute function studio.accounts_refill();

-- creator-dev: refill to 10,000 when below 2,000
insert into studio.credit_refills(owner, floor_credits, target_credits)
  values ('eca1c5f2-96a7-4a01-9a7d-a19e8afa6561', 2000, 10000)
  on conflict (owner) do update set floor_credits = excluded.floor_credits, target_credits = excluded.target_credits;
