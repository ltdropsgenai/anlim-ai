-- Watermark for free accounts (2026-11-18, Londi: "watermark is critical for free accounts").
-- An account counts as paid once it has ever bought credits or had a plan (credit_ledger kind purchase / plan).
-- Clips rendered while an account is unpaid: generations.output_path = the clean clip, stored under the all-zero
-- "vault" folder no creator can read (storage policy studio_files_read: first folder = own user id);
-- generations.preview_path = the watermarked copy in the creator's own folder. studio-api shows the preview until
-- the account has paid, then the clean clip. Everything internal (checker, "continue" start stills) keeps using
-- output_path, so a watermark never leaks into the next shot.
-- Worker: src/watermark.js + assets/watermark.png; studio-api v17 (op "clip" returns watermarked, hides both paths).
alter table studio.generations add column if not exists preview_path text;

create or replace function studio.has_paid(p_owner uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select exists (select 1 from studio.credit_ledger where owner = p_owner and kind in ('purchase', 'plan'));
$$;
revoke all on function studio.has_paid(uuid) from public, anon, authenticated;
grant execute on function studio.has_paid(uuid) to studio_worker;
