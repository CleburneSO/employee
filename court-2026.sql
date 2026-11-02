-- 2026 District Court settings for the Info tab (from the posted 2026 DISTRICT COURT SETTINGS sheet).
-- Run once in the Sheriff's Office Supabase project (SQL Editor), after schema.sql. Running it again adds nothing twice.
insert into public.info_rows (section, data)
select 'court', v.data::jsonb
from (values
  ('{"kind":"felony","from":"2025-12-02","to":"2026-01-07","date":"2026-01-15","time":"09:00"}'),
  ('{"kind":"felony","from":"2026-01-08","to":"2026-02-03","date":"2026-02-12","time":"09:00"}'),
  ('{"kind":"felony","from":"2026-02-04","to":"2026-03-03","date":"2026-03-09","time":"09:00"}'),
  ('{"kind":"felony","from":"2026-03-04","to":"2026-04-07","date":"2026-04-16","time":"09:00"}'),
  ('{"kind":"felony","from":"2026-04-08","to":"2026-05-05","date":"2026-05-11","time":"09:00"}'),
  ('{"kind":"felony","from":"2026-05-06","to":"2026-06-09","date":"2026-06-15","time":"09:00"}'),
  ('{"kind":"felony","from":"2026-06-10","to":"2026-07-01","date":"2026-07-09","time":"09:00"}'),
  ('{"kind":"felony","from":"2026-07-02","to":"2026-07-31","date":"2026-08-03","time":"09:00"}'),
  ('{"kind":"felony","from":"2026-08-01","to":"2026-09-02","date":"2026-09-10","time":"09:00"}'),
  ('{"kind":"felony","from":"2026-09-03","to":"2026-10-06","date":"2026-10-15","time":"09:00"}'),
  ('{"kind":"felony","from":"2026-10-07","to":"2026-11-03","date":"2026-11-09","time":"09:00"}'),
  ('{"kind":"felony","from":"2026-11-04","to":"2026-11-30","date":"2026-12-03","time":"09:00"}'),
  ('{"kind":"misd","date":"2026-01-13"}'),
  ('{"kind":"misd","date":"2026-02-20"}'),
  ('{"kind":"misd","date":"2026-03-10"}'),
  ('{"kind":"misd","date":"2026-04-14"}'),
  ('{"kind":"misd","date":"2026-05-12"}'),
  ('{"kind":"misd","date":"2026-06-16"}'),
  ('{"kind":"misd","date":"2026-07-07"}'),
  ('{"kind":"misd","date":"2026-08-04"}'),
  ('{"kind":"misd","date":"2026-09-08"}'),
  ('{"kind":"misd","date":"2026-10-13"}'),
  ('{"kind":"misd","date":"2026-11-12"}'),
  ('{"kind":"misd","date":"2026-12-01"}')
) as v(data)
where not exists (
  select 1 from public.info_rows r
  where r.section = 'court' and r.data ->> 'kind' = v.data::jsonb ->> 'kind' and r.data ->> 'date' = v.data::jsonb ->> 'date'
);
