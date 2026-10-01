// Cleburne County Jail portal settings.
// Same app as the Sheriff's Office portal, with its own Supabase project, so jail logins,
// records and approvals are completely separate.
//
// ▼ From the JAIL's Supabase project → Connect (or Project Settings → Data API / API Keys).
//   The anon / publishable key is meant to be public. NEVER put the service_role (secret) key here.
window.APP_CONFIG = {
  SUPABASE_URL: 'https://ljewpcydupdaspmcpvoq.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxqZXdwY3lkdXBkYXNwbWNwdm9xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4MTcwNjUsImV4cCI6MjEwNjM5MzA2NX0.JNjgRK42W7Q-ckt9imZA474_W1wJLwvMXCt7kUqBucU',

  // Printed at the top of every timesheet
  COMPANY_NAME: 'CLEBURNE COUNTY JAIL',
  REPORT_TITLE: 'DAILY REPORT',
  PORTAL_LABEL: 'Jail',

  // Logo in this folder (jail/logo.png); the emails use it too
  LOGO: 'logo.png',

  // Same pay periods as the Sheriff's Office
  FIRST_PAY_PERIOD: '2026-09-17',
  PAY_PERIOD_DAYS: 14,

  // The jail uses the calendar, timesheets and time off; these are off
  FEATURES: { cases: false, stats: false, offduty: false },

  // Shown to managers in the Admin menu
  OTHER_PORTAL: { label: "Sheriff's Office portal", url: '../' }
};
