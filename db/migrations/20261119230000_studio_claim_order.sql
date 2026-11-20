-- Claim order (2026-11-19, 100-clip held-out run): claims were oldest-first, so with many clips waiting for the
-- checker every batch was filled with checks the worker had to put back (the checker runs 2 at a time) and finished
-- renders at fal were not collected for 40+ min. Quick steps (queued submit, running poll) now come first; checks
-- after them, the longest-waiting first. @anlim
create or replace function studio.claim_generations(p_worker text, p_limit integer default 4, p_lease_s integer default 120)
 returns setof studio.generations
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  return query
  update studio.generations g set locked_by = p_worker, locked_until = now() + make_interval(secs => p_lease_s), updated_at = now()
   where g.id in (
     select id from studio.generations
      where status in ('queued','running','checking')
        and (locked_until is null or locked_until < now())
        and (next_poll_at is null or next_poll_at <= now())
      order by (status = 'checking'), coalesce(next_poll_at, created_at), created_at
      limit p_limit
      for update skip locked)
  returning g.*;
end $function$;
