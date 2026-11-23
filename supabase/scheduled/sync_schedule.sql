-- Supabase scheduler (pg_cron) jobs that start the GitHub workflows through the sync-trigger
-- function. Applied by hand to ig-wiki (not a migration: the local test database has no pg_cron).
-- Times are UTC. GitHub's own schedule proved unreliable for this repository, so it is not used.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobname) from cron.job where jobname in ('sfr-events-sync', 'sfr-events-health');

select cron.schedule('sfr-events-sync', '7,37 * * * *', $$
  select net.http_post(
    url := 'https://iudsjtrdtncqqhswcnfu.supabase.co/functions/v1/sync-trigger?source=cron&workflow=sync',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 10000)
$$);

select cron.schedule('sfr-events-health', '17 5 * * *', $$
  select net.http_post(
    url := 'https://iudsjtrdtncqqhswcnfu.supabase.co/functions/v1/sync-trigger?source=cron&workflow=health',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 10000)
$$);
