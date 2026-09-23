-- =====================================================================
-- Employee Portal — Supabase schema
-- Run this once in Supabase → SQL Editor → New query → Run.
-- Safe to re-run: it uses "if not exists" / "or replace" where it can.
-- =====================================================================

-- ---------- PROFILES (one row per login) ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  email       text,
  role        text not null default 'employee' check (role in ('employee', 'manager')),
  created_at  timestamptz not null default now()
);

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


-- ---------- TIMESHEETS ----------
create table if not exists public.timesheets (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  week_start      date not null,
  entries         jsonb not null default '[]'::jsonb,   -- [{date, in, out, break_min, hours}]
  total_hours     numeric(6,2) not null default 0 check (total_hours >= 0 and total_hours <= 168),
  notes           text,
  signature_data  text not null check (signature_data like 'data:image/png;base64,%'),
  signed_name     text not null check (length(trim(signed_name)) > 0),
  signed_at       timestamptz not null default now(),
  status          text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected')),
  manager_note    text,
  reviewed_by     uuid references public.profiles(id),
  reviewed_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (user_id, week_start)
);
create index if not exists timesheets_status_idx on public.timesheets (status);

create or replace function public.timesheets_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then return new; end if;

  if tg_op = 'INSERT' then
    new.user_id      := auth.uid();
    new.status       := 'submitted';
    new.signed_at    := now();            -- server time, not the browser's clock
    new.manager_note := null;
    new.reviewed_by  := null;
    new.reviewed_at  := null;
    new.created_at   := now();
    return new;
  end if;

  new.id := old.id;
  new.user_id := old.user_id;
  new.week_start := old.week_start;
  new.created_at := old.created_at;

  -- Manager approving / sending back: the employee's signed record stays untouched
  if public.is_manager()
     and new.status in ('approved', 'rejected')
     and new.status is distinct from old.status then
    new.entries        := old.entries;
    new.total_hours    := old.total_hours;
    new.notes          := old.notes;
    new.signature_data := old.signature_data;
    new.signed_name    := old.signed_name;
    new.signed_at      := old.signed_at;
    new.reviewed_by    := auth.uid();
    new.reviewed_at    := now();
    return new;
  end if;

  -- Employee re-signing their own timesheet (only if not approved yet)
  if old.user_id = auth.uid() then
    if old.status = 'approved' then
      raise exception 'This timesheet is approved and locked.';
    end if;
    new.status       := 'submitted';
    new.signed_at    := now();
    new.manager_note := null;
    new.reviewed_by  := null;
    new.reviewed_at  := null;
    return new;
  end if;

  raise exception 'Not allowed.';
end $$;

drop trigger if exists timesheets_guard on public.timesheets;
create trigger timesheets_guard
  before insert or update on public.timesheets
  for each row execute function public.timesheets_guard();


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
