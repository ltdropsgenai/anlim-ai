-- Health alerts every 15 minutes (2026-11-25 launch audit: nothing watched the worker). @anlim
-- pg_cron starts the studio-health Edge Function through pg_net, from inside the database, so the check runs even
-- when the Fly worker is down. The function reads the job tables and emails sysadmin@codeascent.online when work is
-- stalled or stuck, a provider refuses for money or quota, or failures spike (at most once per 6 hours per kind).
create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job where jobname = 'studio-health';
select cron.schedule('studio-health', '*/15 * * * *', $job$
  select net.http_post(
    url := 'https://zejyuxnuzmvlcbpfklrg.supabase.co/functions/v1/studio-health',
    body := '{}'::jsonb,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 20000)
$job$);
