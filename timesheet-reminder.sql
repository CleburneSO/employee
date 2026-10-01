-- =====================================================================
-- Daily timesheet reminder job
-- Run once in Supabase → SQL Editor → New query → Run, AFTER schema.sql
-- and after deploying the timesheet-reminder Edge Function. Safe to re-run.
--
-- Every morning at 13:00 UTC (8 AM in summer, 7 AM in winter, Central time)
-- the database calls the timesheet-reminder function. On the last day of a
-- pay period it emails everyone who hasn't submitted; other days it does nothing.
-- =====================================================================

-- Supabase's built-in scheduler and web-request extensions
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- A random secret only this job and the function know (stored in app_secrets, which
-- the website can't read). Re-running keeps the existing one.
insert into public.app_secrets (key, value)
values ('cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

-- Calls the function. dry_run = true only reports who would be reminded, without emailing:
--   select public.run_timesheet_reminder(true);
--   select status_code, content from net._http_response order by created desc limit 1;
create or replace function public.run_timesheet_reminder(dry_run boolean default false)
returns bigint
language sql security definer set search_path = public, extensions
as $$
  select net.http_post(
    url := 'https://tywkcyehermpttuvkmta.supabase.co/functions/v1/timesheet-reminder',
    body := jsonb_build_object('dry_run', dry_run),
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'x-cron-secret', (select value from public.app_secrets where key = 'cron_secret')),
    timeout_milliseconds := 30000);
$$;
revoke execute on function public.run_timesheet_reminder(boolean) from public, anon, authenticated;

-- Every day at 13:00 UTC (re-running replaces the schedule rather than adding a second one)
select cron.schedule('timesheet-reminder', '0 13 * * *', $$select public.run_timesheet_reminder(false)$$);
