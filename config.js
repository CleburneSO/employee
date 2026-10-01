// Fill these in from Supabase → Connect (or Project Settings → Data API / API Keys).
// The anon / publishable key is meant to be public — your data is protected
// by the Row Level Security rules in schema.sql. NEVER put the service_role
// (secret) key here.
window.APP_CONFIG = {
  SUPABASE_URL: 'https://tywkcyehermpttuvkmta.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_UbA262eQKl-r6EBT1vOS6g_t4mju8Sz',

  // Printed at the top of every timesheet
  COMPANY_NAME: "CLEBURNE COUNTY SHERIFF'S OFFICE",
  REPORT_TITLE: 'DEPUTIES DAILY REPORT',

  // Logo shown on the sign-in page and in the header. Upload the image to the
  // repo next to index.html with this exact name (case matters). '' = no logo.
  LOGO: 'logo.png',

  // Pay periods: the portal's first pay period, and how many days each lasts.
  // Every pay period counts on from this date (9/17–9/30/2026, 10/1–10/14/2026, …);
  // nothing earlier is offered. If you change these, also change FIRST_PERIOD /
  // PERIOD_DAYS at the top of supabase-timesheet-reminder-function.ts.
  FIRST_PAY_PERIOD: '2026-09-17',
  PAY_PERIOD_DAYS: 14
};
