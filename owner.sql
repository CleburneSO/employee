-- =====================================================================
-- Site owner access
-- Run in Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- The site owner is a manager with extra powers:
--   • only the owner can read the Audit Log
--   • only the owner can download the database setup
--   • other managers can't change the owner's role or deactivate them
-- The owner flag can only be set here in the SQL Editor, never from the site.
-- =====================================================================

alter table public.profiles add column if not exists is_owner boolean not null default false;

-- Helper: is the logged-in user the site owner?
create or replace function public.is_owner()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and is_owner and coalesce(active, true));
$$;

-- Nobody can give themselves the owner flag from the site, and other
-- managers can't demote or deactivate the owner.
create or replace function public.profiles_owner_lock()
returns trigger
language plpgsql security definer set search_path = public
as $$
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
end $$;

drop trigger if exists profiles_owner_lock on public.profiles;
create trigger profiles_owner_lock
  before insert or update on public.profiles
  for each row execute function public.profiles_owner_lock();

-- Audit log: only the owner can read it. This is added on top of the
-- existing rules ("restrictive"), so nothing about how entries are written changes.
do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relname = 'audit_log' and c.relkind in ('r', 'p')) then
    drop policy if exists "audit_log_owner_only" on public.audit_log;
    create policy "audit_log_owner_only" on public.audit_log as restrictive
      for select to authenticated using (public.is_owner());
    drop policy if exists "audit_log_owner_select" on public.audit_log;
    create policy "audit_log_owner_select" on public.audit_log
      for select to authenticated using (public.is_owner());
  else
    raise notice 'No audit_log table found; skipped the audit log lock.';
  end if;
end $$;

-- Download database setup: every table, index, function, trigger and
-- security rule as one SQL file. Structure only, no records.
create or replace function public.export_db_setup()
returns text
language plpgsql stable security definer set search_path = public, pg_catalog
as $$
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
end $$;

revoke execute on function public.export_db_setup() from public, anon;
grant execute on function public.export_db_setup() to authenticated;

-- Make yourself the site owner (use the email you sign in to the site with)
update public.profiles set is_owner = true where email = 'dsims125@gmail.com';
