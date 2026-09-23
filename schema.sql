-- =====================================================================
-- Employee Portal — Supabase schema
-- Run this in Supabase → SQL Editor → New query → Run.
-- Safe to re-run. If you ran an earlier version, running this again
-- upgrades it (adds the 14-day pay period and extra hour columns).
-- =====================================================================

-- ---------- PROFILES (one row per login) ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  email       text,
  role        text not null default 'employee' check (role in ('employee', 'manager')),
  created_at  timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- Helper: is the logged-in user a manager?
create or replace function public.is_manager()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'manager');
$$;

-- Create a profile automatically whenever a user is invited / created
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for any users that already exist
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- Only managers can change roles; nobody can change their own id/email here
create or replace function public.profiles_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- auth.uid() is null when you run SQL from the dashboard: allow everything
  if auth.uid() is null then return new; end if;

  if tg_op = 'INSERT' then
    new.id    := auth.uid();
    new.role  := 'employee';
    new.email := (select email from auth.users where id = auth.uid());
    return new;
  end if;

  new.id := old.id;
  new.email := old.email;
  new.created_at := old.created_at;

  if not public.is_manager() then
    new.role := old.role;
  end if;

  if old.id = auth.uid() and old.role = 'manager' and new.role <> 'manager' then
    raise exception 'You cannot remove your own manager access.';
  end if;

  return new;
end $$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard
  before insert or update on public.profiles
  for each row execute function public.profiles_guard();


-- ---------- SPECIAL DUTIES (K9, DEA, Supervisor, grant overtime …) ----------
-- Managers create these on the Team tab and tick which people have them.
-- Only assigned people (or everyone, if "everyone" is on) see that line on their timesheet.
create table if not exists public.duties (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,                 -- short name, e.g. 'K9'
  label          text not null,                        -- line on the timesheet
  note           text not null default '',             -- small print next to the line
  default_hours  numeric(6,2) not null default 0 check (default_hours >= 0),  -- pre-filled each pay period
  everyone       boolean not null default false,
  active         boolean not null default true,
  sort           int not null default 100,
  created_at     timestamptz not null default now()
);
alter table public.duties enable row level security;

create table if not exists public.profile_duties (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  duty_id  uuid not null references public.duties(id) on delete cascade,
  primary key (user_id, duty_id)
);
alter table public.profile_duties enable row level security;

-- Starter list — rename, edit or turn these off on the Team tab
insert into public.duties (name, label, note, sort) values
  ('Traffic OT', 'Total Traffic Overtime Hours', 'This is only for grant overtime hours worked such as STEP.', 10),
  ('K9', 'K9 At Home Care', '.5 HOUR FOR UNSCHEDULED WORK DAYS', 20),
  ('DEA', 'DEA Overtime Hours', '', 30),
  ('Supervisor', 'Supervisor Hours', '', 40)
on conflict (name) do nothing;


-- ---------- TIMESHEETS (one per employee per pay period) ----------
create table if not exists public.timesheets (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  period_start      date not null,
  entries           jsonb not null default '[]'::jsonb,  -- [{date, in, out, hours, explanation}]
  total_hours       numeric(6,2) not null default 0,     -- hours actually worked (sum of days)
  vacation_hours    numeric(6,2) not null default 0,
  holiday_hours     numeric(6,2) not null default 0,
  sick_hours        numeric(6,2) not null default 0,
  traffic_ot_hours  numeric(6,2) not null default 0,     -- grant overtime such as STEP
  k9_hours          numeric(6,2) not null default 0,     -- K9 at-home care
  total_paid_hours  numeric(7,2) not null default 0,     -- total hours to be paid
  notes             text,
  signature_data    text not null check (signature_data like 'data:image/png;base64,%'),
  signed_name       text not null check (length(trim(signed_name)) > 0),
  signed_at         timestamptz not null default now(),
  status            text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected')),
  manager_note      text,
  reviewed_by       uuid references public.profiles(id),
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now(),
  unique (user_id, period_start)
);
alter table public.timesheets enable row level security;

-- Upgrade from the first version (weekly timesheets)
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'timesheets' and column_name = 'week_start')
     and not exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'timesheets' and column_name = 'period_start') then
    alter table public.timesheets rename column week_start to period_start;
  end if;
end $$;
alter table public.timesheets add column if not exists vacation_hours   numeric(6,2) not null default 0;
alter table public.timesheets add column if not exists holiday_hours    numeric(6,2) not null default 0;
alter table public.timesheets add column if not exists sick_hours       numeric(6,2) not null default 0;
alter table public.timesheets add column if not exists traffic_ot_hours numeric(6,2) not null default 0;
alter table public.timesheets add column if not exists k9_hours         numeric(6,2) not null default 0;
alter table public.timesheets add column if not exists total_paid_hours numeric(7,2) not null default 0;
-- Special-duty hours, saved with their labels so old timesheets print exactly as signed:
-- [{duty_id, name, label, note, hours}]
alter table public.timesheets add column if not exists duty_hours jsonb not null default '[]'::jsonb;
alter table public.timesheets drop constraint if exists timesheets_total_hours_check;
alter table public.timesheets drop constraint if exists timesheets_hours_check;
alter table public.timesheets add constraint timesheets_hours_check check (
  total_hours between 0 and 400 and vacation_hours >= 0 and holiday_hours >= 0 and
  sick_hours >= 0 and traffic_ot_hours >= 0 and k9_hours >= 0
);
create index if not exists timesheets_status_idx on public.timesheets (status);

create or replace function public.timesheets_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
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
      new.duty_hours := coalesce((
        select jsonb_agg(jsonb_build_object(
                 'duty_id', d.id, 'name', d.name, 'label', d.label, 'note', d.note,
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

  -- Totals are always calculated by the database, never trusted from the browser
  new.total_hours := coalesce((
    select sum(coalesce((e->>'hours')::numeric, 0))
    from jsonb_array_elements(coalesce(new.entries, '[]'::jsonb)) e
  ), 0);
  new.total_paid_hours := new.total_hours + new.vacation_hours + new.holiday_hours
                        + new.sick_hours + new.traffic_ot_hours + new.k9_hours
                        + coalesce((select sum(coalesce((x->>'hours')::numeric, 0))
                                    from jsonb_array_elements(coalesce(new.duty_hours, '[]'::jsonb)) x), 0);
  return new;
end $$;

drop trigger if exists timesheets_guard on public.timesheets;
create trigger timesheets_guard
  before insert or update on public.timesheets
  for each row execute function public.timesheets_guard();

-- Fill in totals for any rows created before this version
update public.timesheets set total_paid_hours = total_paid_hours where total_paid_hours = 0;


-- ---------- TIME-OFF REQUESTS ----------
create table if not exists public.time_off_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  type          text not null default 'vacation'
                check (type in ('vacation', 'sick', 'personal', 'unpaid', 'other')),
  start_date    date not null,
  end_date      date not null,
  reason        text,
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'denied', 'cancelled')),
  manager_note  text,
  reviewed_by   uuid references public.profiles(id),
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now(),
  check (end_date >= start_date)
);
alter table public.time_off_requests enable row level security;
create index if not exists time_off_status_idx on public.time_off_requests (status);

create or replace function public.time_off_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then return new; end if;

  if tg_op = 'INSERT' then
    new.user_id      := auth.uid();
    new.status       := 'pending';
    new.manager_note := null;
    new.reviewed_by  := null;
    new.reviewed_at  := null;
    new.created_at   := now();
    return new;
  end if;

  -- The request itself never changes after it's submitted
  new.id := old.id;
  new.user_id := old.user_id;
  new.type := old.type;
  new.start_date := old.start_date;
  new.end_date := old.end_date;
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
end $$;

drop trigger if exists time_off_guard on public.time_off_requests;
create trigger time_off_guard
  before insert or update on public.time_off_requests
  for each row execute function public.time_off_guard();


-- ---------- ROW LEVEL SECURITY ----------
-- Employees see only their own rows; managers see everyone's.
alter table public.profiles          enable row level security;
alter table public.timesheets        enable row level security;
alter table public.time_off_requests enable row level security;

drop policy if exists "profiles_select" on public.profiles;
drop policy if exists "profiles_insert" on public.profiles;
drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_select" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_manager());
create policy "profiles_insert" on public.profiles for insert to authenticated
  with check (id = auth.uid());
create policy "profiles_update" on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_manager());

drop policy if exists "timesheets_select" on public.timesheets;
drop policy if exists "timesheets_insert" on public.timesheets;
drop policy if exists "timesheets_update" on public.timesheets;
create policy "timesheets_select" on public.timesheets for select to authenticated
  using (user_id = auth.uid() or public.is_manager());
create policy "timesheets_insert" on public.timesheets for insert to authenticated
  with check (user_id = auth.uid());
create policy "timesheets_update" on public.timesheets for update to authenticated
  using (user_id = auth.uid() or public.is_manager());
-- No delete policy: signed timesheets can't be deleted from the website.

alter table public.duties         enable row level security;
alter table public.profile_duties enable row level security;

drop policy if exists "duties_select" on public.duties;
drop policy if exists "duties_manage" on public.duties;
create policy "duties_select" on public.duties for select to authenticated using (true);
create policy "duties_manage" on public.duties for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists "profile_duties_select" on public.profile_duties;
drop policy if exists "profile_duties_manage" on public.profile_duties;
create policy "profile_duties_select" on public.profile_duties for select to authenticated
  using (user_id = auth.uid() or public.is_manager());
create policy "profile_duties_manage" on public.profile_duties for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists "time_off_select" on public.time_off_requests;
drop policy if exists "time_off_insert" on public.time_off_requests;
drop policy if exists "time_off_update" on public.time_off_requests;
create policy "time_off_select" on public.time_off_requests for select to authenticated
  using (user_id = auth.uid() or public.is_manager());
create policy "time_off_insert" on public.time_off_requests for insert to authenticated
  with check (user_id = auth.uid());
create policy "time_off_update" on public.time_off_requests for update to authenticated
  using (user_id = auth.uid() or public.is_manager());


-- ---------- AFTER YOU'VE ACCEPTED YOUR OWN INVITE ----------
-- Make yourself a manager (change the email, then run just this line):
-- update public.profiles set role = 'manager' where email = 'you@example.com';
