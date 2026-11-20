-- Charging policy v2 (2026-11-20, Londi: "Even if they reject the first image generated, the credits should be deducted
-- because we get charged on the backend regardless ... charge them if our checker flags and/or passes the asset
-- generated. They are only refunded if/when the asset is demonstrably unusable. This has to make financial sense.")
--   images (start/end frames, plates): charged when made, kept or not (unchanged: frames.js settles 'charge').
--   clips: charged when the check PASSES or FLAGS them (worker.js), and when the check could not run (the clip was made
--          and delivered). Credits back only when the check FAILS the clip (a confirmed defect) or the render never
--          finished (provider error / timeout: nothing was delivered).
--   rejecting a clip no longer gives credits back (v1 released a FLAGGED clip on reject: anyone could render, reject,
--          and pay nothing while anlim paid fal).
-- @anlim
create or replace function studio.review_generation(p_gen uuid, p_decision text, p_reasons text[] default '{}'::text[], p_note text default null)
 returns text
 language plpgsql
 security definer
 set search_path to ''
as $function$
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
  -- policy v2: a clip that reached review was delivered and is charged, kept or not (normally already settled by the
  -- worker when the check finished; this covers older clips)
  perform studio.settle_generation(p_gen, 'charge');
  if p_decision = 'approve' then
    update studio.generations set status = 'succeeded', updated_at = now() where id = p_gen;
    update studio.shots set status = 'approved', approved_generation_id = p_gen where id = g.shot_id;
  else
    update studio.generations set status = 'failed', error = 'rejected by creator', updated_at = now() where id = p_gen;
    update studio.shots set status = 'rejected' where id = g.shot_id and approved_generation_id is distinct from p_gen;
  end if;
  return p_decision;
end $function$;
