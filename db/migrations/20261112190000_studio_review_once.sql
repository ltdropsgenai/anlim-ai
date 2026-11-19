-- One creator decision per generation (2026-11-12: a test reject overrode an approved take).
-- Decidable: status 'review' (FLAG / NOT_REVIEWED / checker gave up), or a checker PASS ('succeeded') not yet decided.
create or replace function studio.review_generation(p_gen uuid, p_decision text, p_reasons text[] default '{}', p_note text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare g studio.generations;
begin
  if p_decision not in ('approve','reject') then raise exception 'decision must be approve or reject'; end if;
  select * into g from studio.generations where id = p_gen for update;
  if not found or (auth.uid() is not null and g.owner <> auth.uid()) then raise exception 'not found'; end if;
  if exists (select 1 from studio.reviews where generation_id = p_gen) then
    raise exception 'this clip already has a decision'; end if;
  if g.status not in ('review','succeeded') then raise exception 'generation is %', g.status; end if;
  insert into studio.reviews(generation_id, reviewer, decision, reasons, note)
    values (p_gen, coalesce(auth.uid(), g.owner), p_decision, p_reasons, p_note);
  if p_decision = 'approve' then
    perform studio.settle_generation(p_gen, 'charge');
    update studio.generations set status = 'succeeded', updated_at = now() where id = p_gen;
    update studio.shots set status = 'approved', approved_generation_id = p_gen where id = g.shot_id;
  else
    -- policy v1: rejecting a FLAGGED clip releases its credits; rejecting a checker PASS keeps the charge
    if g.settled is null then perform studio.settle_generation(p_gen, 'release'); end if;
    update studio.generations set status = 'failed', error = 'rejected by creator', updated_at = now() where id = p_gen;
    update studio.shots set status = 'rejected' where id = g.shot_id and approved_generation_id is distinct from p_gen;
  end if;
  return p_decision;
end $$;
