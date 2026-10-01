-- =====================================================================
-- Employee Portal — Supabase database setup
-- Run in Supabase → SQL Editor → New query → Run. Safe to re-run: it
-- creates anything missing and brings functions, triggers and security
-- rules up to date without touching any records.
--
-- Built from the live database (Audit Log → Download database setup,
-- 2026-10-01). When the database is changed in Supabase, download the
-- setup again and update this file so the repo stays the source of truth.
--
-- Not in this file: the notify and invite-user Edge Functions
-- (Supabase → Edge Functions) and their secrets.
-- =====================================================================

-- ---------------------------------------------------------------- tables

-- One row per login. role: employee or manager. is_owner: the site owner (set only from the SQL Editor).
create table if not exists public.profiles (
  id uuid not null,
  full_name text default ''::text not null,
  email text,
  role text default 'employee'::text not null,
  created_at timestamp with time zone default now() not null,
  active boolean default true not null,
  deactivated_at timestamp with time zone,
  patrol boolean default false not null,
  shift text,
  is_supervisor boolean default false not null,
  reports_to uuid,
  usual_in text,
  usual_out text,
  is_owner boolean default false not null,
  constraint profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint profiles_pkey PRIMARY KEY (id),
  constraint profiles_reports_to_fkey FOREIGN KEY (reports_to) REFERENCES profiles(id) ON DELETE SET NULL,
  constraint profiles_reports_to_self CHECK (((reports_to IS NULL) OR (reports_to <> id))),
  constraint profiles_role_check CHECK ((role = ANY (ARRAY['employee'::text, 'manager'::text]))),
  constraint profiles_shift_check CHECK ((shift = ANY (ARRAY['A'::text, 'B'::text]))),
  constraint profiles_usual_hours_check CHECK ((((usual_in IS NULL) AND (usual_out IS NULL)) OR ((usual_in ~ '^([01][0-9]|2[0-3]):(00|15|30|45)$'::text) AND (usual_out ~ '^([01][0-9]|2[0-3]):(00|15|30|45)$'::text) AND (usual_in <> usual_out))))
);
alter table public.profiles enable row level security;

-- Special duties (K9, DEA, Supervisor, Traffic OT, …) managers create on the Team tab.
create table if not exists public.duties (
  id uuid default gen_random_uuid() not null,
  name text not null,
  label text not null,
  note text default ''::text not null,
  default_hours numeric(6,2) default 0 not null,
  everyone boolean default false not null,
  active boolean default true not null,
  sort integer default 100 not null,
  created_at timestamp with time zone default now() not null,
  paid boolean default true not null,
  constraint duties_default_hours_check CHECK ((default_hours >= (0)::numeric)),
  constraint duties_name_key UNIQUE (name),
  constraint duties_pkey PRIMARY KEY (id)
);
alter table public.duties enable row level security;

-- Which people have which special duties.
create table if not exists public.profile_duties (
  user_id uuid not null,
  duty_id uuid not null,
  constraint profile_duties_duty_id_fkey FOREIGN KEY (duty_id) REFERENCES duties(id) ON DELETE CASCADE,
  constraint profile_duties_pkey PRIMARY KEY (user_id, duty_id),
  constraint profile_duties_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);
alter table public.profile_duties enable row level security;

-- Calendar events. Deputies see events they are tagged on, plus "show to everyone" ones.
create table if not exists public.events (
  id uuid default gen_random_uuid() not null,
  kind text default 'other'::text not null,
  title text not null,
  starts_at timestamp with time zone not null,
  ends_at timestamp with time zone,
  all_day boolean default false not null,
  location text,
  details text,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone,
  for_everyone boolean default false not null,
  holiday_hours numeric(4,2) default 8 not null,
  constraint events_check CHECK (((ends_at IS NULL) OR (ends_at >= starts_at))),
  constraint events_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id),
  constraint events_holiday_hours_check CHECK (((holiday_hours >= (0)::numeric) AND (holiday_hours <= (24)::numeric))),
  constraint events_kind_check CHECK ((kind = ANY (ARRAY['training'::text, 'court'::text, 'other'::text, 'holiday'::text]))),
  constraint events_pkey PRIMARY KEY (id),
  constraint events_title_check CHECK ((length(TRIM(BOTH FROM title)) > 0))
);
alter table public.events enable row level security;

-- Who is tagged on each event.
create table if not exists public.event_people (
  event_id uuid not null,
  user_id uuid not null,
  constraint event_people_event_id_fkey FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  constraint event_people_pkey PRIMARY KEY (event_id, user_id),
  constraint event_people_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);
alter table public.event_people enable row level security;

-- Announcements and training announcements at the top of the calendar.
create table if not exists public.announcements (
  id uuid default gen_random_uuid() not null,
  kind text default 'general'::text not null,
  title text not null,
  body text default ''::text not null,
  pinned boolean default false not null,
  show_until date,
  posted_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone,
  constraint announcements_kind_check CHECK ((kind = ANY (ARRAY['general'::text, 'training'::text]))),
  constraint announcements_pkey PRIMARY KEY (id),
  constraint announcements_posted_by_fkey FOREIGN KEY (posted_by) REFERENCES profiles(id),
  constraint announcements_title_check CHECK ((length(TRIM(BOTH FROM title)) > 0))
);
alter table public.announcements enable row level security;

-- Every change, recorded by audit_trigger(). Only the site owner can read it; nobody can edit it.
create table if not exists public.audit_log (
  id bigint generated always as identity not null,
  at timestamp with time zone default now() not null,
  actor uuid,
  actor_name text,
  action text not null,
  table_name text not null,
  row_id text,
  subject uuid,
  label text,
  changes jsonb default '{}'::jsonb not null,
  constraint audit_log_pkey PRIMARY KEY (id)
);
alter table public.audit_log enable row level security;

-- Next case number count for each year.
create table if not exists public.case_counters (
  year integer not null,
  next_seq integer default 1 not null,
  constraint case_counters_next_seq_check CHECK ((next_seq >= 1)),
  constraint case_counters_pkey PRIMARY KEY (year)
);
alter table public.case_counters enable row level security;

-- Reserved case numbers. Never deleted; mistakes are voided.
create table if not exists public.case_numbers (
  id uuid default gen_random_uuid() not null,
  case_number text not null,
  year integer not null,
  seq integer not null,
  reserved_by uuid not null,
  reserved_at timestamp with time zone default now() not null,
  case_date date not null,
  initials text default ''::text not null,
  victim_defendant text,
  kind text,
  charge text,
  void boolean default false not null,
  void_reason text,
  voided_by uuid,
  voided_at timestamp with time zone,
  updated_by uuid,
  updated_at timestamp with time zone,
  constraint case_numbers_case_number_key UNIQUE (case_number),
  constraint case_numbers_kind_check CHECK ((kind = ANY (ARRAY['A'::text, 'I/O'::text]))),
  constraint case_numbers_pkey PRIMARY KEY (id),
  constraint case_numbers_reserved_by_fkey FOREIGN KEY (reserved_by) REFERENCES profiles(id) ON DELETE RESTRICT,
  constraint case_numbers_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES profiles(id),
  constraint case_numbers_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES profiles(id),
  constraint case_numbers_year_seq_key UNIQUE (year, seq)
);
alter table public.case_numbers enable row level security;

-- Manager adjustments to comp time balances.
create table if not exists public.comp_adjustments (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  hours numeric(6,2) not null,
  note text not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  constraint comp_adjustments_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id),
  constraint comp_adjustments_hours_check CHECK (((hours <> (0)::numeric) AND ((hours >= ('-999'::integer)::numeric) AND (hours <= (999)::numeric)) AND ((hours * (4)::numeric) = round((hours * (4)::numeric))))),
  constraint comp_adjustments_note_check CHECK ((length(TRIM(BOTH FROM note)) > 0)),
  constraint comp_adjustments_pkey PRIMARY KEY (id),
  constraint comp_adjustments_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE RESTRICT
);
alter table public.comp_adjustments enable row level security;

-- Off-duty jobs managers post.
create table if not exists public.offduty_jobs (
  id uuid default gen_random_uuid() not null,
  title text not null,
  location text,
  starts_at timestamp with time zone not null,
  ends_at timestamp with time zone,
  pay text,
  spots integer default 1 not null,
  details text,
  status text default 'open'::text not null,
  posted_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone,
  constraint offduty_jobs_check CHECK (((ends_at IS NULL) OR (ends_at >= starts_at))),
  constraint offduty_jobs_pkey PRIMARY KEY (id),
  constraint offduty_jobs_posted_by_fkey FOREIGN KEY (posted_by) REFERENCES profiles(id),
  constraint offduty_jobs_spots_check CHECK (((spots >= 1) AND (spots <= 50))),
  constraint offduty_jobs_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text, 'cancelled'::text]))),
  constraint offduty_jobs_title_check CHECK ((length(TRIM(BOTH FROM title)) > 0))
);
alter table public.offduty_jobs enable row level security;

-- Deputies requesting off-duty jobs.
create table if not exists public.offduty_requests (
  id uuid default gen_random_uuid() not null,
  job_id uuid not null,
  user_id uuid default auth.uid() not null,
  status text default 'requested'::text not null,
  note text,
  created_at timestamp with time zone default now() not null,
  decided_by uuid,
  decided_at timestamp with time zone,
  constraint offduty_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES profiles(id),
  constraint offduty_requests_job_id_fkey FOREIGN KEY (job_id) REFERENCES offduty_jobs(id) ON DELETE CASCADE,
  constraint offduty_requests_job_id_user_id_key UNIQUE (job_id, user_id),
  constraint offduty_requests_pkey PRIMARY KEY (id),
  constraint offduty_requests_status_check CHECK ((status = ANY (ARRAY['requested'::text, 'approved'::text, 'declined'::text, 'withdrawn'::text]))),
  constraint offduty_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE RESTRICT
);
alter table public.offduty_requests enable row level security;

-- Patrol stats each deputy logs per shift.
create table if not exists public.patrol_stats (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  shift_date date not null,
  shift text not null,
  felony_warrants integer default 0 not null,
  misd_warrants integer default 0 not null,
  civil_papers integer default 0 not null,
  felony_arrests integer default 0 not null,
  misd_arrests integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_by uuid,
  updated_at timestamp with time zone,
  constraint patrol_stats_civil_papers_check CHECK (((civil_papers >= 0) AND (civil_papers <= 99))),
  constraint patrol_stats_felony_arrests_check CHECK (((felony_arrests >= 0) AND (felony_arrests <= 99))),
  constraint patrol_stats_felony_warrants_check CHECK (((felony_warrants >= 0) AND (felony_warrants <= 99))),
  constraint patrol_stats_misd_arrests_check CHECK (((misd_arrests >= 0) AND (misd_arrests <= 99))),
  constraint patrol_stats_misd_warrants_check CHECK (((misd_warrants >= 0) AND (misd_warrants <= 99))),
  constraint patrol_stats_pkey PRIMARY KEY (id),
  constraint patrol_stats_shift_check CHECK ((shift = ANY (ARRAY['A'::text, 'B'::text]))),
  constraint patrol_stats_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES profiles(id),
  constraint patrol_stats_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE RESTRICT,
  constraint patrol_stats_user_id_shift_date_key UNIQUE (user_id, shift_date)
);
alter table public.patrol_stats enable row level security;

-- Time off and comp time requests.
create table if not exists public.time_off_requests (
  id uuid default gen_random_uuid() not null,
  user_id uuid default auth.uid() not null,
  type text default 'vacation'::text not null,
  start_date date not null,
  end_date date not null,
  reason text,
  status text default 'pending'::text not null,
  manager_note text,
  reviewed_by uuid,
  reviewed_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  hours numeric(6,2),
  constraint time_off_requests_check CHECK ((end_date >= start_date)),
  constraint time_off_requests_hours_check CHECK (((hours IS NULL) OR ((hours > (0)::numeric) AND (hours <= (999)::numeric) AND ((hours * (4)::numeric) = round((hours * (4)::numeric)))))),
  constraint time_off_requests_pkey PRIMARY KEY (id),
  constraint time_off_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES profiles(id),
  constraint time_off_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'cancelled'::text]))),
  constraint time_off_requests_type_check CHECK ((type = ANY (ARRAY['vacation'::text, 'sick'::text, 'personal'::text, 'unpaid'::text, 'other'::text, 'comp'::text, 'comp_earned'::text]))),
  constraint time_off_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE RESTRICT
);
alter table public.time_off_requests enable row level security;

-- One signed timesheet per employee per pay period.
create table if not exists public.timesheets (
  id uuid default gen_random_uuid() not null,
  user_id uuid default auth.uid() not null,
  period_start date not null,
  entries jsonb default '[]'::jsonb not null,
  total_hours numeric(6,2) default 0 not null,
  notes text,
  signature_data text not null,
  signed_name text not null,
  signed_at timestamp with time zone default now() not null,
  status text default 'submitted'::text not null,
  manager_note text,
  reviewed_by uuid,
  reviewed_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  vacation_hours numeric(6,2) default 0 not null,
  holiday_hours numeric(6,2) default 0 not null,
  sick_hours numeric(6,2) default 0 not null,
  traffic_ot_hours numeric(6,2) default 0 not null,
  k9_hours numeric(6,2) default 0 not null,
  total_paid_hours numeric(7,2) default 0 not null,
  duty_hours jsonb default '[]'::jsonb not null,
  constraint timesheets_hours_check CHECK ((((total_hours >= (0)::numeric) AND (total_hours <= (400)::numeric)) AND (vacation_hours >= (0)::numeric) AND (holiday_hours >= (0)::numeric) AND (sick_hours >= (0)::numeric) AND (traffic_ot_hours >= (0)::numeric) AND (k9_hours >= (0)::numeric))),
  constraint timesheets_pkey PRIMARY KEY (id),
  constraint timesheets_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES profiles(id),
  constraint timesheets_signature_data_check CHECK ((signature_data ~~ 'data:image/png;base64,%'::text)),
  constraint timesheets_signed_name_check CHECK ((length(TRIM(BOTH FROM signed_name)) > 0)),
  constraint timesheets_status_check CHECK ((status = ANY (ARRAY['submitted'::text, 'approved'::text, 'rejected'::text]))),
  constraint timesheets_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE RESTRICT,
  constraint timesheets_user_id_week_start_key UNIQUE (user_id, period_start)
);
alter table public.timesheets enable row level security;

-- ---------------------------------------------------------------- indexes

create index if not exists audit_log_actor_idx ON public.audit_log USING btree (actor, at DESC);

create index if not exists audit_log_at_idx ON public.audit_log USING btree (at DESC);

create index if not exists audit_log_subject_idx ON public.audit_log USING btree (subject, at DESC);

create index if not exists audit_log_table_idx ON public.audit_log USING btree (table_name, at DESC);

create index if not exists case_numbers_year_seq_idx ON public.case_numbers USING btree (year, seq DESC);

create index if not exists comp_adjustments_user_idx ON public.comp_adjustments USING btree (user_id, created_at);

create index if not exists events_starts_idx ON public.events USING btree (starts_at);

create index if not exists offduty_jobs_starts_idx ON public.offduty_jobs USING btree (starts_at);

create index if not exists patrol_stats_date_idx ON public.patrol_stats USING btree (shift_date);

create index if not exists time_off_status_idx ON public.time_off_requests USING btree (status);

create index if not exists timesheets_status_idx ON public.timesheets USING btree (status);

-- ---------------------------------------------------------------- functions
-- Helpers first: is_active / is_manager / is_owner are used by the security rules.

CREATE OR REPLACE FUNCTION public.is_active()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$function$
;

CREATE OR REPLACE FUNCTION public.is_manager()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'manager' and active);
$function$
;

CREATE OR REPLACE FUNCTION public.is_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and is_owner and coalesce(active, true));
$function$
;

CREATE OR REPLACE FUNCTION public.can_see_event(p_event uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.is_manager()
      or (public.is_active() and exists (
            select 1 from public.events e
            where e.id = p_event
              and (e.for_everyone
                   or exists (select 1 from public.event_people ep
                              where ep.event_id = e.id and ep.user_id = auth.uid()))));
$function$
;

CREATE OR REPLACE FUNCTION public.can_see_stats_of(p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.is_active() and (
    p_user = auth.uid()
    or public.is_manager()
    or exists (select 1 from public.profiles d
               join public.profiles s on s.id = d.reports_to
               where d.id = p_user and s.id = auth.uid() and s.is_supervisor)
  );
$function$
;

CREATE OR REPLACE FUNCTION public.patrol_month_facts(p_month date)
 RETURNS TABLE(user_id uuid, shift text, felony_warrants integer, misd_warrants integer, civil_papers integer, felony_arrests integer, misd_arrests integer, io_reports integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with b as (
    select date_trunc('month', p_month)::date as a,
           (date_trunc('month', p_month) + interval '1 month')::date as z
  ), logs as (
    select s.* from public.patrol_stats s, b where s.shift_date >= b.a and s.shift_date < b.z
  ), ios as (
    select c.reserved_by as user_id, c.case_date as d, count(*)::int as n
    from public.case_numbers c, b
    where c.kind = 'I/O' and not c.void and c.case_date >= b.a and c.case_date < b.z
    group by 1, 2
  )
  select p.id, coalesce(l.shift, p.shift),
         coalesce(l.felony_warrants, 0), coalesce(l.misd_warrants, 0), coalesce(l.civil_papers, 0),
         coalesce(l.felony_arrests, 0), coalesce(l.misd_arrests, 0), coalesce(i.n, 0)
  from logs l
  full join ios i on i.user_id = l.user_id and i.d = l.shift_date
  join public.profiles p on p.id = coalesce(l.user_id, i.user_id)
  where p.patrol;
$function$
;

CREATE OR REPLACE FUNCTION public.patrol_shift_totals(p_month date)
 RETURNS TABLE(shift text, felony_warrants integer, misd_warrants integer, civil_papers integer, felony_arrests integer, misd_arrests integer, io_reports integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select f.shift,
         sum(f.felony_warrants)::int, sum(f.misd_warrants)::int, sum(f.civil_papers)::int,
         sum(f.felony_arrests)::int, sum(f.misd_arrests)::int, sum(f.io_reports)::int
  from public.patrol_month_facts(p_month) f
  where f.shift is not null and public.is_active()
    and (public.is_manager()
         or f.shift = (select me.shift from public.profiles me where me.id = auth.uid()))
  group by f.shift
  order by f.shift;
$function$
;

CREATE OR REPLACE FUNCTION public.patrol_stats_month(p_month date)
 RETURNS TABLE(user_id uuid, full_name text, usual_shift text, reports_to uuid, active boolean, felony_warrants integer, misd_warrants integer, civil_papers integer, felony_arrests integer, misd_arrests integer, io_reports integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p.id, p.full_name, p.shift, p.reports_to, p.active,
         coalesce(sum(f.felony_warrants), 0)::int, coalesce(sum(f.misd_warrants), 0)::int,
         coalesce(sum(f.civil_papers), 0)::int, coalesce(sum(f.felony_arrests), 0)::int,
         coalesce(sum(f.misd_arrests), 0)::int, coalesce(sum(f.io_reports), 0)::int
  from public.profiles p
  left join public.patrol_month_facts(p_month) f on f.user_id = p.id
  where p.patrol and public.can_see_stats_of(p.id)
  group by p.id
  having p.active or count(f.user_id) > 0
  order by p.full_name;
$function$
;

CREATE OR REPLACE FUNCTION public.people_directory()
 RETURNS TABLE(id uuid, full_name text, active boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p.id, p.full_name, p.active from public.profiles p
  where public.is_active()
  order by p.full_name;
$function$
;

CREATE OR REPLACE FUNCTION public.comp_balances()
 RETURNS TABLE(user_id uuid, full_name text, active boolean, balance numeric, earned numeric, used numeric, adjusted numeric, pending_earned numeric, pending_used numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with r as (
    select t.user_id,
      coalesce(sum(t.hours) filter (where t.type = 'comp_earned' and t.status = 'approved'), 0) as earned,
      coalesce(sum(t.hours) filter (where t.type = 'comp' and t.status = 'approved'), 0) as used,
      coalesce(sum(t.hours) filter (where t.type = 'comp_earned' and t.status = 'pending'), 0) as pending_earned,
      coalesce(sum(t.hours) filter (where t.type = 'comp' and t.status = 'pending'), 0) as pending_used
    from public.time_off_requests t
    where t.type in ('comp', 'comp_earned') and t.hours is not null
    group by t.user_id
  ), a as (
    select c.user_id, sum(c.hours) as adjusted from public.comp_adjustments c group by c.user_id
  )
  select p.id, p.full_name, p.active,
         coalesce(r.earned, 0) - coalesce(r.used, 0) + coalesce(a.adjusted, 0),
         coalesce(r.earned, 0), coalesce(r.used, 0), coalesce(a.adjusted, 0),
         coalesce(r.pending_earned, 0), coalesce(r.pending_used, 0)
  from public.profiles p
  left join r on r.user_id = p.id
  left join a on a.user_id = p.id
  where public.is_active() and (p.id = auth.uid() or public.is_manager())
  order by p.full_name;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.profiles_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- auth.uid() is null when you run SQL from the dashboard: allow everything
  if auth.uid() is null then
    if tg_op = 'UPDATE' and new.active is distinct from old.active then
      new.deactivated_at := case when new.active then null else now() end;
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.id    := auth.uid();
    new.role  := 'employee';
    new.email := (select email from auth.users where id = auth.uid());
    new.active := true;
    new.deactivated_at := null;
    new.patrol := false;
    new.shift := null;
    new.is_supervisor := false;
    new.reports_to := null;
    return new;
  end if;

  new.id := old.id;
  new.email := old.email;
  new.created_at := old.created_at;

  if not public.is_manager() then
    new.role := old.role;
    new.active := old.active;
    new.deactivated_at := old.deactivated_at;
    new.patrol := old.patrol;
    new.shift := old.shift;
    new.is_supervisor := old.is_supervisor;
    new.reports_to := old.reports_to;
  end if;

  if old.id = auth.uid() and old.role = 'manager' and new.role <> 'manager' then
    raise exception 'You cannot remove your own manager access.';
  end if;
  if old.id = auth.uid() and old.active and not new.active then
    raise exception 'You cannot deactivate your own account.';
  end if;
  if new.reports_to is not null and not exists
     (select 1 from public.profiles where id = new.reports_to and is_supervisor) then
    raise exception 'Pick someone marked Supervisor.';
  end if;

  if new.active is distinct from old.active then
    new.deactivated_at := case when new.active then null else now() end;
  end if;

  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.profiles_owner_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- auth.uid() is null when you run SQL from the dashboard: allow everything
  if auth.uid() is null then return new; end if;

  if tg_op = 'INSERT' then
    new.is_owner := false;
    return new;
  end if;

  new.is_owner := old.is_owner;
  if old.is_owner and old.id <> auth.uid()
     and (new.role is distinct from old.role or new.active is distinct from old.active) then
    raise exception 'The site owner''s role and access can only be changed by the site owner.';
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.timesheets_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- auth.uid() is null when you run SQL from the dashboard: skip the permission rules
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.user_id      := auth.uid();
      new.status       := 'submitted';
      new.signed_at    := now();            -- server time, not the browser's clock
      new.manager_note := null;
      new.reviewed_by  := null;
      new.reviewed_at  := null;
      new.created_at   := now();
    else
      new.id := old.id;
      new.user_id := old.user_id;
      new.period_start := old.period_start;
      new.created_at := old.created_at;

      if public.is_manager()
         and new.status in ('approved', 'rejected')
         and new.status is distinct from old.status then
        -- Manager approving / sending back: the employee's signed record stays untouched
        new.entries          := old.entries;
        new.vacation_hours   := old.vacation_hours;
        new.holiday_hours    := old.holiday_hours;
        new.sick_hours       := old.sick_hours;
        new.traffic_ot_hours := old.traffic_ot_hours;
        new.k9_hours         := old.k9_hours;
        new.duty_hours       := old.duty_hours;
        new.notes            := old.notes;
        new.signature_data   := old.signature_data;
        new.signed_name      := old.signed_name;
        new.signed_at        := old.signed_at;
        new.reviewed_by      := auth.uid();
        new.reviewed_at      := now();
      elsif old.user_id = auth.uid() then
        -- Employee re-signing their own timesheet (only if not approved yet)
        if old.status = 'approved' then
          raise exception 'This timesheet is approved and locked.';
        end if;
        new.status       := 'submitted';
        new.signed_at    := now();
        new.manager_note := null;
        new.reviewed_by  := null;
        new.reviewed_at  := null;
      else
        raise exception 'Not allowed.';
      end if;
    end if;

    -- When the employee signs: keep only special duties assigned to them,
    -- and save each line's current label/note with the timesheet.
    if new.status = 'submitted' then
      -- Time is kept in 15-minute increments
      if exists (select 1 from jsonb_array_elements(coalesce(new.entries, '[]'::jsonb)) e
                 where coalesce(e->>'in', '') !~ '^([01][0-9]|2[0-3]):(00|15|30|45)$' and coalesce(e->>'in', '') <> ''
                    or coalesce(e->>'out', '') !~ '^([01][0-9]|2[0-3]):(00|15|30|45)$' and coalesce(e->>'out', '') <> '') then
        raise exception 'Times must be in 15-minute steps (:00, :15, :30 or :45).';
      end if;
      if mod(new.vacation_hours, 0.25) <> 0 or mod(new.holiday_hours, 0.25) <> 0 or mod(new.sick_hours, 0.25) <> 0
         or exists (select 1 from jsonb_array_elements(coalesce(new.duty_hours, '[]'::jsonb)) x
                    where mod(coalesce((x->>'hours')::numeric, 0), 0.25) <> 0) then
        raise exception 'Hours must be in quarter-hour steps (for example 4, 4.25 or 4.5).';
      end if;

      -- Each block of time: the database figures its hours from time in/out itself
      new.entries := coalesce((
        select jsonb_agg(
                 case when coalesce(e->>'in', '') <> '' and coalesce(e->>'out', '') <> '' then
                   jsonb_set(e, '{hours}', to_jsonb(round(
                     case when (e->>'out')::time > (e->>'in')::time
                          then extract(epoch from (e->>'out')::time - (e->>'in')::time) / 3600
                          else 24 + extract(epoch from (e->>'out')::time - (e->>'in')::time) / 3600 end, 2)))
                 else jsonb_set(e, '{hours}', '0'::jsonb) end
                 order by n)
        from jsonb_array_elements(coalesce(new.entries, '[]'::jsonb)) with ordinality as t(e, n)
      ), '[]'::jsonb);

      -- A block marked as a special duty (e.g. Traffic OT) must be one assigned to this person
      if exists (
        select 1 from jsonb_array_elements(new.entries) e
        where coalesce(e->>'duty_id', '') <> ''
          and not exists (select 1 from public.duties d
                          where d.id::text = e->>'duty_id' and d.active
                            and (d.everyone or exists (select 1 from public.profile_duties pd
                                                       where pd.user_id = new.user_id and pd.duty_id = d.id)))) then
        raise exception 'One of your time blocks is marked with a special duty you are not assigned to.';
      end if;

      -- Duty lines that have time blocks are the total of those blocks
      new.duty_hours := coalesce((
        select jsonb_agg(case when b.did is not null then jsonb_set(x, '{hours}', to_jsonb(b.h)) else x end order by n)
        from jsonb_array_elements(coalesce(new.duty_hours, '[]'::jsonb)) with ordinality as t(x, n)
        left join (select e->>'duty_id' as did, sum((e->>'hours')::numeric) as h
                   from jsonb_array_elements(new.entries) e
                   where coalesce(e->>'duty_id', '') <> '' group by 1) b on b.did = x->>'duty_id'
      ), '[]'::jsonb);

      new.duty_hours := coalesce((
        select jsonb_agg(jsonb_build_object(
                 'duty_id', d.id, 'name', d.name, 'label', d.label, 'note', d.note, 'paid', d.paid,
                 'hours', round(greatest(coalesce((x->>'hours')::numeric, 0), 0), 2))
               order by d.sort, d.name)
        from jsonb_array_elements(coalesce(new.duty_hours, '[]'::jsonb)) x
        join public.duties d on d.id::text = x->>'duty_id'
        where d.active
          and (d.everyone or exists (select 1 from public.profile_duties pd
                                     where pd.user_id = new.user_id and pd.duty_id = d.id))
      ), '[]'::jsonb);
    end if;
  end if;

  -- Totals are always calculated by the database, never trusted from the browser.
  -- Hours worked = regular blocks only; blocks marked with a duty go on that duty's line.
  new.total_hours := coalesce((
    select sum(coalesce((e->>'hours')::numeric, 0))
    from jsonb_array_elements(coalesce(new.entries, '[]'::jsonb)) e
    where coalesce(e->>'duty_id', '') = ''
  ), 0);
  new.total_paid_hours := new.total_hours + new.vacation_hours + new.holiday_hours
                        + new.sick_hours + new.traffic_ot_hours + new.k9_hours
                        + coalesce((select sum(coalesce((x->>'hours')::numeric, 0))
                                    from jsonb_array_elements(coalesce(new.duty_hours, '[]'::jsonb)) x
                                    where coalesce((x->>'paid')::boolean, true)), 0);   -- e.g. Comp Time Earned is banked, not paid
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.time_off_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then return new; end if;

  if tg_op = 'INSERT' then
    new.user_id      := auth.uid();
    new.status       := 'pending';
    new.manager_note := null;
    new.reviewed_by  := null;
    new.reviewed_at  := null;
    new.created_at   := now();
    if new.type not in ('vacation', 'sick', 'comp', 'comp_earned') then
      raise exception 'Time off must be Vacation, Sick or Comp time.';
    end if;
    if new.hours is null then
      raise exception 'Enter how many hours.';
    end if;
    if new.type = 'comp_earned' then
      new.end_date := new.start_date;          -- earned on one day
      if coalesce(trim(new.reason), '') = '' then
        raise exception 'Say what the comp time was earned for.';
      end if;
      if new.start_date > (now() at time zone 'America/Chicago')::date then
        raise exception 'Comp time can only be logged for a day you already worked.';
      end if;
    end if;
    return new;
  end if;

  -- The request itself never changes after it's submitted
  new.id := old.id;
  new.user_id := old.user_id;
  new.type := old.type;
  new.start_date := old.start_date;
  new.end_date := old.end_date;
  new.hours := old.hours;
  new.reason := old.reason;
  new.created_at := old.created_at;

  -- Manager decision
  if public.is_manager()
     and new.status in ('approved', 'denied')
     and new.status is distinct from old.status then
    new.reviewed_by := auth.uid();
    new.reviewed_at := now();
    return new;
  end if;

  -- Employee cancelling their own pending request
  if old.user_id = auth.uid() and old.status = 'pending' and new.status = 'cancelled' then
    new.manager_note := old.manager_note;
    new.reviewed_by  := old.reviewed_by;
    new.reviewed_at  := old.reviewed_at;
    return new;
  end if;

  raise exception 'Not allowed.';
end $function$
;

CREATE OR REPLACE FUNCTION public.comp_adjustments_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then return new; end if;
  new.created_by := auth.uid();
  new.created_at := now();
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.events_holiday_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.kind = 'holiday' then
    new.for_everyone := true;
    new.all_day := true;
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.case_numbers_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then return new; end if;   -- dashboard

  -- The number itself and who reserved it never change
  new.id := old.id;
  new.case_number := old.case_number;
  new.year := old.year;
  new.seq := old.seq;
  new.reserved_by := old.reserved_by;
  new.reserved_at := old.reserved_at;
  new.initials := upper(trim(coalesce(new.initials, '')));

  if not (public.is_manager() or (old.reserved_by = auth.uid() and public.is_active())) then
    raise exception 'Only the person who reserved this number or a manager can change it.';
  end if;

  if new.void and not old.void then
    if coalesce(trim(new.void_reason), '') = '' then
      raise exception 'Give a reason for voiding this case number.';
    end if;
    new.voided_by := auth.uid();
    new.voided_at := now();
  elsif old.void and not new.void then
    if not public.is_manager() then
      raise exception 'Only a manager can restore a voided case number.';
    end if;
    new.void_reason := null;
    new.voided_by := null;
    new.voided_at := null;
  elsif old.void then
    if not public.is_manager() then
      raise exception 'This case number is void. Ask a manager if it needs to be restored.';
    end if;
    new.void_reason := old.void_reason;
    new.voided_by := old.voided_by;
    new.voided_at := old.voided_at;
  else
    new.void_reason := null;
    new.voided_by := null;
    new.voided_at := null;
  end if;

  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.reserve_case_number(p_case_date date, p_initials text, p_victim_defendant text, p_kind text, p_charge text)
 RETURNS case_numbers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  local_day date := (now() at time zone 'America/Chicago')::date;
  y int := extract(year from local_day)::int;
  s int;
  r public.case_numbers;
begin
  if auth.uid() is null or not public.is_active() then
    raise exception 'Not allowed.';
  end if;
  if nullif(p_kind, '') is not null and p_kind not in ('A', 'I/O') then
    raise exception 'A – I/O must be A or I/O.';
  end if;

  insert into public.case_counters (year) values (y) on conflict (year) do nothing;
  -- This row lock makes simultaneous reservations wait their turn
  update public.case_counters set next_seq = next_seq + 1 where year = y
  returning next_seq - 1 into s;

  insert into public.case_numbers
    (case_number, year, seq, reserved_by, case_date, initials, victim_defendant, kind, charge)
  values
    (to_char(local_day, 'YYYYMMDD') || lpad(s::text, 4, '0'), y, s, auth.uid(),
     coalesce(p_case_date, local_day), upper(trim(coalesce(p_initials, ''))),
     nullif(trim(p_victim_defendant), ''), nullif(p_kind, ''), nullif(trim(p_charge), ''))
  returning * into r;
  return r;
end $function$
;

CREATE OR REPLACE FUNCTION public.set_next_case_seq(p_year integer, p_next integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare used int;
begin
  if not public.is_manager() then raise exception 'Managers only.'; end if;
  if p_next is null or p_next < 1 then raise exception 'The next number must be 1 or higher.'; end if;
  select max(seq) into used from public.case_numbers where year = p_year;
  if used is not null and p_next <= used then
    raise exception 'Numbers up to % are already used in %. Pick a number higher than that.', used, p_year;
  end if;
  insert into public.case_counters (year, next_seq) values (p_year, p_next)
  on conflict (year) do update set next_seq = excluded.next_seq;
end $function$
;

CREATE OR REPLACE FUNCTION public.offduty_requests_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare j public.offduty_jobs; taken int;
begin
  if auth.uid() is null then return new; end if;   -- dashboard
  select * into j from public.offduty_jobs where id = coalesce(new.job_id, old.job_id) for update;

  if tg_op = 'INSERT' then
    new.user_id := auth.uid();
    new.status := 'requested';
    new.decided_by := null; new.decided_at := null; new.created_at := now();
    if j.status <> 'open' or j.starts_at < now() then
      raise exception 'This job is no longer taking requests.';
    end if;
    return new;
  end if;

  new.id := old.id; new.job_id := old.job_id; new.user_id := old.user_id; new.created_at := old.created_at;
  if new.status = old.status then
    new.decided_by := old.decided_by; new.decided_at := old.decided_at;
    if old.user_id <> auth.uid() then new.note := old.note; end if;
    return new;
  end if;

  if new.status in ('approved', 'declined') then
    if not public.is_manager() then raise exception 'Only a manager can approve or decline.'; end if;
    if new.status = 'approved' then
      select count(*) into taken from public.offduty_requests
        where job_id = old.job_id and status = 'approved' and id <> old.id;
      if taken >= j.spots then
        raise exception 'This job is full (% of % spots filled).', taken, j.spots;
      end if;
    end if;
    new.decided_by := auth.uid(); new.decided_at := now();
    return new;
  end if;

  if new.status = 'withdrawn' and old.user_id = auth.uid() and old.status in ('requested', 'approved') then
    new.decided_by := old.decided_by; new.decided_at := now();
    return new;
  end if;

  -- Re-requesting after withdrawing
  if new.status = 'requested' and old.status = 'withdrawn' and old.user_id = auth.uid() then
    if j.status <> 'open' or j.starts_at < now() then
      raise exception 'This job is no longer taking requests.';
    end if;
    new.decided_by := null; new.decided_at := null;
    return new;
  end if;

  -- Manager moving someone back to "requested" (undo a decision)
  if new.status = 'requested' and public.is_manager() then
    new.decided_by := null; new.decided_at := null;
    return new;
  end if;

  raise exception 'Not allowed.';
end $function$
;

CREATE OR REPLACE FUNCTION public.patrol_stats_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then return new; end if;   -- dashboard
  if tg_op = 'INSERT' then
    new.user_id := auth.uid();
    new.created_at := now();
    if not exists (select 1 from public.profiles where id = auth.uid() and patrol and active) then
      raise exception 'Only patrol deputies log stats. Ask a manager to mark you Patrol on the Team tab.';
    end if;
  else
    new.id := old.id;
    new.user_id := old.user_id;
    new.created_at := old.created_at;
  end if;
  if new.shift_date > (now() at time zone 'America/Chicago')::date + 1 then
    raise exception 'That shift date is in the future.';
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.audit_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  o jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end;
  n jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end;
  r jsonb := coalesce(n, o);
  diff jsonb := '{}'::jsonb;
  k text;
  -- noisy or huge fields that aren't worth storing
  skip text[] := array['signature_data', 'updated_at', 'updated_by'];
begin
  -- Reserving a case number bumps the counter by one; that's already logged as the new case number
  if tg_table_name = 'case_counters' and tg_op = 'UPDATE'
     and (n ->> 'next_seq')::int = (o ->> 'next_seq')::int + 1 then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(n) loop
      if not (k = any(skip)) and (o -> k) is distinct from (n -> k) then
        diff := diff || jsonb_build_object(k, jsonb_build_object('old', o -> k, 'new', n -> k));
      end if;
    end loop;
    -- a new signature is worth noting, without storing the image
    if (o ->> 'signature_data') is distinct from (n ->> 'signature_data') then
      diff := diff || jsonb_build_object('signature', jsonb_build_object('old', 'signed', 'new', 're-signed'));
    end if;
    if diff = '{}'::jsonb then return null; end if;   -- nothing actually changed
  else
    diff := coalesce(n, o) - skip;
  end if;

  insert into public.audit_log (actor, actor_name, action, table_name, row_id, subject, label, changes)
  values (
    auth.uid(),
    (select full_name from public.profiles where id = auth.uid()),
    lower(tg_op),
    tg_table_name,
    coalesce(r ->> 'id', concat_ws('/', r ->> 'event_id', r ->> 'duty_id', r ->> 'user_id')),
    coalesce((r ->> 'user_id')::uuid, (r ->> 'reserved_by')::uuid,
             case when tg_table_name = 'profiles' then (r ->> 'id')::uuid end),
    coalesce(r ->> 'case_number', r ->> 'title', r ->> 'period_start', r ->> 'shift_date', r ->> 'full_name',
             r ->> 'name', r ->> 'start_date', (r ->> 'year') || ' counter'),
    diff
  );
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION public.export_db_setup()
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  out text;
begin
  if not public.is_owner() then
    raise exception 'Only the site owner can download the database setup.';
  end if;

  with t as (
    select c.oid, c.relname, c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  ), parts as (
    select 1 as part, relname::text as name,
      'create table public.' || quote_ident(relname) || E' (\n' ||
      (select string_agg('  ' || quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod)
         || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
         || case a.attidentity when 'a' then ' generated always as identity'
                               when 'd' then ' generated by default as identity' else '' end
         || case when a.attnotnull then ' not null' else '' end, E',\n' order by a.attnum)
       from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped)
      || coalesce((select E',\n' || string_agg('  constraint ' || quote_ident(conname) || ' ' || pg_get_constraintdef(oid), E',\n')
                   from pg_constraint where conrelid = t.oid), '')
      || E'\n);'
      || case when relrowsecurity then E'\nalter table public.' || quote_ident(relname) || ' enable row level security;' else '' end as sql
    from t
    union all
    select 2, indexname::text, indexdef || ';'
    from pg_indexes where schemaname = 'public' and indexname not in (select conname from pg_constraint)
    union all
    select 3, p.proname::text, pg_get_functiondef(p.oid) || ';'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind in ('f', 'p')
    union all
    select 4, tg.tgname::text, pg_get_triggerdef(tg.oid) || ';'
    from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where (n.nspname = 'public' or (n.nspname = 'auth' and c.relname = 'users')) and not tg.tgisinternal
    union all
    select 5, tablename || '.' || policyname,
      format('create policy %I on public.%I as %s for %s to %s%s%s;', policyname, tablename, permissive, cmd,
             array_to_string(roles, ', '), coalesce(' using (' || qual || ')', ''), coalesce(' with check (' || with_check || ')', ''))
    from pg_policies where schemaname = 'public'
  )
  select '-- Database setup exported ' || to_char(now(), 'YYYY-MM-DD HH24:MI') || E' UTC\n\n'
         || string_agg(sql, E'\n\n' order by part, name)
    into out from parts;
  return out;
end $function$
;

-- Functions in the public schema can be called by anyone through the API
-- unless execute is revoked. These are only for use inside other functions.
revoke execute on function public.patrol_month_facts(date) from public, anon, authenticated;
revoke execute on function public.export_db_setup() from public, anon;
grant execute on function public.export_db_setup() to authenticated;

-- ---------------------------------------------------------------- triggers

drop trigger if exists audit_announcements on public.announcements;
CREATE TRIGGER audit_announcements AFTER INSERT OR DELETE OR UPDATE ON public.announcements FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();

drop trigger if exists audit_case_counters on public.case_counters;
CREATE TRIGGER audit_case_counters AFTER INSERT OR DELETE OR UPDATE ON public.case_counters FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();

drop trigger if exists audit_case_numbers on public.case_numbers;
CREATE TRIGGER audit_case_numbers AFTER INSERT OR DELETE OR UPDATE ON public.case_numbers FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();

drop trigger if exists audit_comp_adjustments on public.comp_adjustments;
CREATE TRIGGER audit_comp_adjustments AFTER INSERT OR DELETE OR UPDATE ON public.comp_adjustments FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();

drop trigger if exists audit_duties on public.duties;
CREATE TRIGGER audit_duties AFTER INSERT OR DELETE OR UPDATE ON public.duties FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();

drop trigger if exists audit_event_people on public.event_people;
CREATE TRIGGER audit_event_people AFTER INSERT OR DELETE OR UPDATE ON public.event_people FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();

drop trigger if exists audit_events on public.events;
CREATE TRIGGER audit_events AFTER INSERT OR DELETE OR UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();

drop trigger if exists audit_offduty_jobs on public.offduty_jobs;
CREATE TRIGGER audit_offduty_jobs AFTER INSERT OR DELETE OR UPDATE ON public.offduty_jobs FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();

drop trigger if exists audit_offduty_requests on public.offduty_requests;
CREATE TRIGGER audit_offduty_requests AFTER INSERT OR DELETE OR UPDATE ON public.offduty_requests FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();

drop trigger if exists audit_patrol_stats on public.patrol_stats;
CREATE TRIGGER audit_patrol_stats AFTER INSERT OR DELETE OR UPDATE ON public.patrol_stats FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();

drop trigger if exists audit_profile_duties on public.profile_duties;
CREATE TRIGGER audit_profile_duties AFTER INSERT OR DELETE OR UPDATE ON public.profile_duties FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();

drop trigger if exists audit_profiles on public.profiles;
CREATE TRIGGER audit_profiles AFTER INSERT OR DELETE OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();

drop trigger if exists audit_time_off_requests on public.time_off_requests;
CREATE TRIGGER audit_time_off_requests AFTER INSERT OR DELETE OR UPDATE ON public.time_off_requests FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();

drop trigger if exists audit_timesheets on public.timesheets;
CREATE TRIGGER audit_timesheets AFTER INSERT OR DELETE OR UPDATE ON public.timesheets FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();

drop trigger if exists case_numbers_guard on public.case_numbers;
CREATE TRIGGER case_numbers_guard BEFORE UPDATE ON public.case_numbers FOR EACH ROW EXECUTE FUNCTION public.case_numbers_guard();

drop trigger if exists comp_adjustments_guard on public.comp_adjustments;
CREATE TRIGGER comp_adjustments_guard BEFORE INSERT ON public.comp_adjustments FOR EACH ROW EXECUTE FUNCTION public.comp_adjustments_guard();

drop trigger if exists events_holiday_guard on public.events;
CREATE TRIGGER events_holiday_guard BEFORE INSERT OR UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.events_holiday_guard();

drop trigger if exists offduty_requests_guard on public.offduty_requests;
CREATE TRIGGER offduty_requests_guard BEFORE INSERT OR UPDATE ON public.offduty_requests FOR EACH ROW EXECUTE FUNCTION public.offduty_requests_guard();

drop trigger if exists on_auth_user_created on auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

drop trigger if exists patrol_stats_guard on public.patrol_stats;
CREATE TRIGGER patrol_stats_guard BEFORE INSERT OR UPDATE ON public.patrol_stats FOR EACH ROW EXECUTE FUNCTION public.patrol_stats_guard();

drop trigger if exists profiles_guard on public.profiles;
CREATE TRIGGER profiles_guard BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.profiles_guard();

drop trigger if exists profiles_owner_lock on public.profiles;
CREATE TRIGGER profiles_owner_lock BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.profiles_owner_lock();

drop trigger if exists time_off_guard on public.time_off_requests;
CREATE TRIGGER time_off_guard BEFORE INSERT OR UPDATE ON public.time_off_requests FOR EACH ROW EXECUTE FUNCTION public.time_off_guard();

drop trigger if exists timesheets_guard on public.timesheets;
CREATE TRIGGER timesheets_guard BEFORE INSERT OR UPDATE ON public.timesheets FOR EACH ROW EXECUTE FUNCTION public.timesheets_guard();

-- ---------------------------------------------------------------- security rules
-- Row Level Security: who can see and change which rows.

drop policy if exists announcements_manage on public.announcements;
create policy announcements_manage on public.announcements as PERMISSIVE for ALL to authenticated using (is_manager()) with check (is_manager());

drop policy if exists announcements_select on public.announcements;
create policy announcements_select on public.announcements as PERMISSIVE for SELECT to authenticated using (is_active());

drop policy if exists audit_log_owner_only on public.audit_log;
create policy audit_log_owner_only on public.audit_log as RESTRICTIVE for SELECT to authenticated using (is_owner());

drop policy if exists audit_log_owner_select on public.audit_log;
create policy audit_log_owner_select on public.audit_log as PERMISSIVE for SELECT to authenticated using (is_owner());

drop policy if exists case_counters_select on public.case_counters;
create policy case_counters_select on public.case_counters as PERMISSIVE for SELECT to authenticated using (is_active());

drop policy if exists case_numbers_select on public.case_numbers;
create policy case_numbers_select on public.case_numbers as PERMISSIVE for SELECT to authenticated using (is_active());

drop policy if exists case_numbers_update on public.case_numbers;
create policy case_numbers_update on public.case_numbers as PERMISSIVE for UPDATE to authenticated using ((is_manager() OR ((reserved_by = auth.uid()) AND is_active())));

drop policy if exists comp_adjustments_insert on public.comp_adjustments;
create policy comp_adjustments_insert on public.comp_adjustments as PERMISSIVE for INSERT to authenticated with check (is_manager());

drop policy if exists comp_adjustments_select on public.comp_adjustments;
create policy comp_adjustments_select on public.comp_adjustments as PERMISSIVE for SELECT to authenticated using ((((user_id = auth.uid()) AND is_active()) OR is_manager()));

drop policy if exists duties_manage on public.duties;
create policy duties_manage on public.duties as PERMISSIVE for ALL to authenticated using (is_manager()) with check (is_manager());

drop policy if exists duties_select on public.duties;
create policy duties_select on public.duties as PERMISSIVE for SELECT to authenticated using (is_active());

drop policy if exists event_people_manage on public.event_people;
create policy event_people_manage on public.event_people as PERMISSIVE for ALL to authenticated using (is_manager()) with check (is_manager());

drop policy if exists event_people_select on public.event_people;
create policy event_people_select on public.event_people as PERMISSIVE for SELECT to authenticated using (can_see_event(event_id));

drop policy if exists events_manage on public.events;
create policy events_manage on public.events as PERMISSIVE for ALL to authenticated using (is_manager()) with check (is_manager());

drop policy if exists events_select on public.events;
create policy events_select on public.events as PERMISSIVE for SELECT to authenticated using (can_see_event(id));

drop policy if exists offduty_jobs_manage on public.offduty_jobs;
create policy offduty_jobs_manage on public.offduty_jobs as PERMISSIVE for ALL to authenticated using (is_manager()) with check (is_manager());

drop policy if exists offduty_jobs_select on public.offduty_jobs;
create policy offduty_jobs_select on public.offduty_jobs as PERMISSIVE for SELECT to authenticated using (is_active());

drop policy if exists offduty_requests_insert on public.offduty_requests;
create policy offduty_requests_insert on public.offduty_requests as PERMISSIVE for INSERT to authenticated with check (((user_id = auth.uid()) AND is_active()));

drop policy if exists offduty_requests_select on public.offduty_requests;
create policy offduty_requests_select on public.offduty_requests as PERMISSIVE for SELECT to authenticated using ((is_manager() OR (is_active() AND ((user_id = auth.uid()) OR (status = 'approved'::text)))));

drop policy if exists offduty_requests_update on public.offduty_requests;
create policy offduty_requests_update on public.offduty_requests as PERMISSIVE for UPDATE to authenticated using ((is_manager() OR ((user_id = auth.uid()) AND is_active())));

drop policy if exists patrol_stats_delete on public.patrol_stats;
create policy patrol_stats_delete on public.patrol_stats as PERMISSIVE for DELETE to authenticated using ((((user_id = auth.uid()) AND is_active()) OR is_manager()));

drop policy if exists patrol_stats_insert on public.patrol_stats;
create policy patrol_stats_insert on public.patrol_stats as PERMISSIVE for INSERT to authenticated with check (((user_id = auth.uid()) AND is_active()));

drop policy if exists patrol_stats_select on public.patrol_stats;
create policy patrol_stats_select on public.patrol_stats as PERMISSIVE for SELECT to authenticated using (can_see_stats_of(user_id));

drop policy if exists patrol_stats_update on public.patrol_stats;
create policy patrol_stats_update on public.patrol_stats as PERMISSIVE for UPDATE to authenticated using ((((user_id = auth.uid()) AND is_active()) OR is_manager()));

drop policy if exists profile_duties_manage on public.profile_duties;
create policy profile_duties_manage on public.profile_duties as PERMISSIVE for ALL to authenticated using (is_manager()) with check (is_manager());

drop policy if exists profile_duties_select on public.profile_duties;
create policy profile_duties_select on public.profile_duties as PERMISSIVE for SELECT to authenticated using ((((user_id = auth.uid()) AND is_active()) OR is_manager()));

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles as PERMISSIVE for INSERT to authenticated with check ((id = auth.uid()));

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles as PERMISSIVE for SELECT to authenticated using (((id = auth.uid()) OR is_manager()));

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles as PERMISSIVE for UPDATE to authenticated using ((((id = auth.uid()) AND is_active()) OR is_manager()));

drop policy if exists time_off_insert on public.time_off_requests;
create policy time_off_insert on public.time_off_requests as PERMISSIVE for INSERT to authenticated with check (((user_id = auth.uid()) AND is_active()));

drop policy if exists time_off_select on public.time_off_requests;
create policy time_off_select on public.time_off_requests as PERMISSIVE for SELECT to authenticated using ((((user_id = auth.uid()) AND is_active()) OR is_manager()));

drop policy if exists time_off_update on public.time_off_requests;
create policy time_off_update on public.time_off_requests as PERMISSIVE for UPDATE to authenticated using ((((user_id = auth.uid()) AND is_active()) OR is_manager()));

drop policy if exists timesheets_insert on public.timesheets;
create policy timesheets_insert on public.timesheets as PERMISSIVE for INSERT to authenticated with check (((user_id = auth.uid()) AND is_active()));

drop policy if exists timesheets_select on public.timesheets;
create policy timesheets_select on public.timesheets as PERMISSIVE for SELECT to authenticated using ((((user_id = auth.uid()) AND is_active()) OR is_manager()));

drop policy if exists timesheets_update on public.timesheets;
create policy timesheets_update on public.timesheets as PERMISSIVE for UPDATE to authenticated using ((((user_id = auth.uid()) AND is_active()) OR is_manager()));

drop policy if exists audit_log_select on public.audit_log;

-- ---------------------------------------------------------------- existing logins
-- Make sure every login has a profile (handle_new_user does this for new ones)
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;
