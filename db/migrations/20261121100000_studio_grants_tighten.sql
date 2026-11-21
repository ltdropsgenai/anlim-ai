-- Review 2026-11-21: tighten grants (defence in depth; nothing in the app changes). @anlim
-- 1. Functions made after the 11-19 review kept PostgreSQL's default EXECUTE for PUBLIC, so the anon role could run
--    admin_refunds, decide_refund, request_refund, mark_notifications_read, is_admin and two trigger functions. Each
--    checks auth.uid() / admins itself and the studio schema is not on the public API, so nothing was reachable, but
--    anon should hold no studio functions at all. Revoke PUBLIC/anon everywhere and give authenticated back exactly the
--    ones the app calls as the user.
-- 2. authenticated could INSERT/UPDATE/DELETE series, scenes, shots, characters and locations directly (RLS limits it to
--    the creator's own rows). Every write already goes through security definer functions, so a direct write is only a
--    way around their checks (for example, a shot's duration or motion source path). Reads stay as they are.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'studio' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
  end loop;
end $$;
grant execute on function studio.admin_refunds(text), studio.decide_refund(uuid, text, text),
  studio.request_refund(uuid, text[], text, numeric), studio.mark_notifications_read(uuid[]), studio.is_admin(),
  studio.shot_renders_from_text(studio.shots) to authenticated;
alter default privileges in schema studio revoke execute on functions from public;

revoke insert, update, delete on studio.series, studio.scenes, studio.shots, studio.characters, studio.locations from authenticated;

-- 3. Performance advisor (2026-11-21): policies that called auth.uid() once per row, and foreign keys with no index.
drop policy if exists payments_own on studio.payments;
create policy payments_own on studio.payments for select to authenticated using (owner = (select auth.uid()));
drop policy if exists notifications_own on studio.notifications;
create policy notifications_own on studio.notifications for select to authenticated using (owner = (select auth.uid()));
drop policy if exists refund_requests_own on studio.refund_requests;
create policy refund_requests_own on studio.refund_requests for select to authenticated using (owner = (select auth.uid()));
create index if not exists generations_owner_idx on studio.generations(owner);
create index if not exists generations_model_id_idx on studio.generations(model_id);
create index if not exists series_owner_idx on studio.series(owner);
create index if not exists scenes_series_id_idx on studio.scenes(series_id);
create index if not exists scenes_location_id_idx on studio.scenes(location_id);
create index if not exists shots_scene_id_idx on studio.shots(scene_id);
create index if not exists shots_approved_generation_idx on studio.shots(approved_generation_id);
create index if not exists characters_series_id_idx on studio.characters(series_id);
create index if not exists locations_series_id_idx on studio.locations(series_id);
create index if not exists credit_ledger_generation_id_idx on studio.credit_ledger(generation_id);
create index if not exists credit_ledger_frame_job_id_idx on studio.credit_ledger(frame_job_id);
create index if not exists frame_jobs_owner_idx on studio.frame_jobs(owner);
create index if not exists assemblies_scene_id_idx on studio.assemblies(scene_id);
create index if not exists audio_jobs_shot_id_idx on studio.audio_jobs(shot_id);
create index if not exists payments_owner_idx on studio.payments(owner);
create index if not exists payments_plan_id_idx on studio.payments(plan_id);
create index if not exists refund_requests_owner_idx on studio.refund_requests(owner);
create index if not exists reviews_generation_id_idx on studio.reviews(generation_id);
create index if not exists reviews_reviewer_idx on studio.reviews(reviewer);
create index if not exists accounts_plan_id_idx on studio.accounts(plan_id);
create index if not exists model_routes_model_id_idx on studio.model_routes(model_id);
create index if not exists model_routes_tier_model_id_idx on studio.model_routes_tier(model_id);
