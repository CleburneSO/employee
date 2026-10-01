-- =====================================================================
-- Daily court / training reminder job
-- Run once in Supabase → SQL Editor → New query → Run, after deploying the
-- event-reminder Edge Function. Safe to re-run.
--
-- Every afternoon at 21:00 UTC (4 PM in summer, 3 PM in winter, Central time)
-- the database calls the event-reminder function, which emails each deputy
-- tagged on a court date, training or other event that starts tomorrow.
-- =====================================================================

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- The tables this needs (also in schema.sql; created here too in case that hasn't been run yet)
create table if not exists public.event_reminders (
  event_id uuid not null,
  user_id uuid not null,
  starts_at timestamp with time zone not null,
  sent_at timestamp with time zone default now() not null,
  constraint event_reminders_pkey PRIMARY KEY (event_id, user_id, starts_at),
  constraint event_reminders_event_id_fkey FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  constraint event_reminders_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);
alter table public.event_reminders enable row level security;
create table if not exists public.app_secrets (
  key text not null,
  value text not null,
  constraint app_secrets_pkey PRIMARY KEY (key)
);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;

-- The same secret the timesheet reminder job uses (created if it isn't there yet)
insert into public.app_secrets (key, value)
values ('cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

-- Calls the function. dry_run = true only reports who would be reminded, without emailing:
--   select public.run_event_reminder(true);
--   select status_code, content from net._http_response order by created desc limit 1;
create or replace function public.run_event_reminder(dry_run boolean default false)
returns bigint
language sql security definer set search_path = public, extensions
as $$
  select net.http_post(
    url := 'https://tywkcyehermpttuvkmta.supabase.co/functions/v1/event-reminder',
    body := jsonb_build_object('dry_run', dry_run),
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'x-cron-secret', (select value from public.app_secrets where key = 'cron_secret')),
    timeout_milliseconds := 30000);
$$;
revoke execute on function public.run_event_reminder(boolean) from public, anon, authenticated;

-- Every day at 21:00 UTC (re-running replaces the schedule rather than adding a second one)
select cron.schedule('event-reminder', '0 21 * * *', $$select public.run_event_reminder(false)$$);
