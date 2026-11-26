-- One credit grant per invoice (2026-11-26, Londi: "I don't want users to get double charged or credits to be credited
-- into accounts twice when the user only paid once").
-- Stripe sends BOTH invoice.paid and invoice.payment_succeeded for every paid invoice. apply_stripe_event dedupes by
-- event id only, so both ran the plan grant: the first live subscription (2026-11-26 07:57 UTC) shows +1900, then
-- expire 1900 ("unused plan credits from the last month") and +1900 again within the same second. The balance came out
-- right only because nothing was spent between the two; had the second event come later (a Stripe retry, hours on),
-- the expire would take back only what was left and the grant would give a full month again: the credits already spent
-- would come back for free. (The sandbox never sent invoice.payment_succeeded, so testing did not show it.)
-- Fix: the invoice is applied once. payments already has a unique stripe_invoice; when the insert finds the invoice
-- already recorded, the event is noted and nothing else changes (no plan update, no grant, no expiry). Both event types
-- stay handled, so whichever arrives first does the work. Customers are charged by Stripe once per invoice either way;
-- the app never charges.
-- The live function is patched in place (only this line changes), so the rest stays exactly as deployed. @anlim

do $migration$
declare d text; n text;
  old_line constant text := $x$values (v_owner, p.id, o->>'id', coalesce((o->>'amount_paid')::int, 0), p.credits) on conflict do nothing;$x$;
  new_line constant text := $x$values (v_owner, p.id, o->>'id', coalesce((o->>'amount_paid')::int, 0), p.credits) on conflict do nothing;
      -- 2026-11-26: invoice.paid and invoice.payment_succeeded both come for every invoice: apply it once
      if not found then
        update studio.stripe_events set result = 'invoice already applied' where id = p_event->>'id';
        return 'invoice already applied';
      end if;$x$;
begin
  d := pg_get_functiondef('studio.apply_stripe_event(jsonb)'::regprocedure);
  if position('invoice already applied' in d) > 0 then raise notice 'already patched'; return; end if;
  if (length(d) - length(replace(d, old_line, ''))) / length(old_line) <> 1 then
    raise exception 'apply_stripe_event is not the expected version: the payments line was not found exactly once';
  end if;
  n := replace(d, old_line, new_line);
  execute n;
end $migration$;
