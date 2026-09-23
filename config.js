// Fill these in from Supabase → Connect (or Project Settings → Data API / API Keys).
// The anon / publishable key is meant to be public — your data is protected
// by the Row Level Security rules in schema.sql. NEVER put the service_role
// (secret) key here.
window.APP_CONFIG = {
  SUPABASE_URL: SUPABASE_URL: 'https://tywkcyehermpttuvkmta.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_UbA262eQKl-r6EBT1vOS6g_t4mju8Sz',

  // Printed at the top of every timesheet
  COMPANY_NAME: "CLEBURNE COUNTY SHERIFF'S OFFICE",
  REPORT_TITLE: 'DEPUTIES DAILY REPORT',

  // Pay periods: the first day of any one pay period, and how many days each lasts.
  // 9/17/2026 + every 14 days (so 9/17/2026 – 9/30/2026 is a pay period).
  PAY_PERIOD_START: '2025-09-17',
  PAY_PERIOD_DAYS: 14
};
