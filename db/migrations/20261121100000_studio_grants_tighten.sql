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
