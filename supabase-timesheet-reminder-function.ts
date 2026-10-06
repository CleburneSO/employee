// Supabase Edge Function: timesheet-reminder
// Runs every morning (scheduled by timesheet-reminder.sql). On the last day of a pay period it
// emails everyone active who hasn't submitted a timesheet for that period. Each person gets at
// most one reminder per pay period. On other days it does nothing.
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name it
// "timesheet-reminder" → paste this whole file → Deploy, then turn OFF "Verify JWT"
// (this function checks the job's secret itself). It uses the same secrets as "notify":
// RESEND_API_KEY, MAIL_FROM and SITE_URL.
//
// To see who would get a reminder without sending anything, run in the SQL Editor:
//   select public.run_timesheet_reminder(true);
// then look at the reply a few seconds later with:
//   select status_code, content from net._http_response order by created desc limit 1;
import { createClient } from 'npm:@supabase/supabase-js@2';

// Name in the emails' footer (optional ORG_NAME secret, e.g. "Cleburne County Jail" for the jail portal)
const ORG_NAME = Deno.env.get('ORG_NAME') || "Cleburne County Sheriff's Office";

// Must match the site: FIRST_PAY_PERIOD and PAY_PERIOD_DAYS in config.js
const FIRST_PERIOD = '2026-10-01';
const PERIOD_DAYS = 14;
const TIME_ZONE = 'America/Chicago';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// Same branded layout as the notify function's emails
function page(site: string, heading: string, lines: string[], button?: string) {
  const rows = lines.filter(Boolean).map((l) => `<p style="margin:0 0 10px;">${l}</p>`).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0;font-family:Arial,Helvetica,sans-serif;">
  <tr><td align="center"><table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-top:4px solid #e5a34c;border-radius:8px;">
    <tr><td align="center" style="padding:24px 24px 4px;"><img src="${site}logo.png" alt="Cleburne County Sheriff's Office" width="260" style="display:block;width:260px;max-width:100%;height:auto;border:0;"></td></tr>
    <tr><td style="padding:14px 30px 6px;color:#1d2330;font-size:15px;line-height:1.5;">
      <h1 style="margin:0 0 12px;font-size:20px;color:#41512c;">${heading}</h1>${rows}</td></tr>
    <tr><td align="center" style="padding:6px 30px 26px;"><a href="${site}" style="display:inline-block;background:#41512c;color:#fff;text-decoration:none;font-weight:bold;font-size:15px;padding:11px 24px;border-radius:6px;">${button || 'Open the Employee Portal'}</a></td></tr>
    <tr><td style="padding:12px 30px;border-top:1px solid #e3e6ec;color:#98a1b0;font-size:12px;">${esc(ORG_NAME)} Employee Portal · automated message, please don't reply</td></tr>
  </table></td></tr></table>`;
}

const DAY = 86400000;
const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);
const label = (iso: string) => { const d = toDate(iso); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`; };

Deno.serve(async (req) => {
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } });

    // Only the scheduled job knows this secret (it's in the app_secrets table)
    const given = req.headers.get('x-cron-secret') || '';
    const { data: secret } = await admin.from('app_secrets').select('value').eq('key', 'cron_secret').maybeSingle();
    if (!secret?.value || given !== secret.value) return json({ error: 'Not allowed.' }, 403);

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dry_run === true;

    // Today in Alabama, and the pay period it falls in
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());   // YYYY-MM-DD
    const diff = Math.round((toDate(today).getTime() - toDate(FIRST_PERIOD).getTime()) / DAY);
    if (diff < 0) return json({ skipped: 'Before the first pay period.' });
    const start = toIso(new Date(toDate(FIRST_PERIOD).getTime() + Math.floor(diff / PERIOD_DAYS) * PERIOD_DAYS * DAY));
    const end = toIso(new Date(toDate(start).getTime() + (PERIOD_DAYS - 1) * DAY));
    if (today !== end && !dryRun) return json({ skipped: `Not the last day of the pay period (${label(start)} – ${label(end)}).` });

    // Everyone active without a submitted or approved timesheet for this period
    const [people, sheets] = await Promise.all([
      admin.from('profiles').select('id, full_name, email').eq('active', true),
      admin.from('timesheets').select('user_id, status').eq('period_start', start)
    ]);
    if (people.error) throw people.error;
    if (sheets.error) throw sheets.error;
    const status = new Map(sheets.data.map((t) => [t.user_id, t.status]));
    const missing = people.data.filter((p) => p.email && !['submitted', 'approved'].includes(status.get(p.id) ?? ''));

    if (dryRun) {
      return json({ dry_run: true, period: `${label(start)} – ${label(end)}`, last_day: today === end,
        would_remind: missing.map((p) => `${p.full_name || p.email}${status.get(p.id) === 'rejected' ? ' (sent back)' : ''}`) });
    }
    if (!missing.length) return json({ sent: 0 });

    // Claim each reminder first, so a second run the same day sends nothing
    const claimed = await admin.from('timesheet_reminders')
      .upsert(missing.map((p) => ({ user_id: p.id, period_start: start })), { onConflict: 'user_id,period_start', ignoreDuplicates: true })
      .select('user_id');
    if (claimed.error) throw claimed.error;
    const ids = new Set(claimed.data.map((r) => r.user_id));
    const toSend = missing.filter((p) => ids.has(p.id));
    if (!toSend.length) return json({ sent: 0, note: 'Already reminded.' });

    let site = Deno.env.get('SITE_URL') || '';
    if (site && !site.endsWith('/')) site += '/';
    const period = `${label(start)} – ${label(end)}`;
    const emails = toSend.map((p) => {
      const sentBack = status.get(p.id) === 'rejected';
      return {
        from: Deno.env.get('MAIL_FROM'),
        to: [p.email],
        subject: sentBack ? `Reminder: your timesheet for ${period} was sent back` : `Reminder: timesheet due for ${period}`,
        html: page(site, sentBack ? 'Your timesheet still needs to be resubmitted' : 'Your timesheet is due today', [
          `Hi ${esc((p.full_name || '').split(' ')[0] || 'there')},`,
          sentBack
            ? `Your timesheet for <strong>${esc(period)}</strong> was sent back and hasn’t been resubmitted yet.`
            : `Today is the last day of the <strong>${esc(period)}</strong> pay period, and we don’t have your timesheet yet.`,
          'Finish and sign it on the My Timesheets tab.',
          '<span style="color:#98a1b0;font-size:13px;">If you’ve already turned it in another way, you can ignore this.</span>'
        ], sentBack ? 'Fix my timesheet' : 'Fill out my timesheet')
      };
    });

    // Resend sends up to 100 per batch
    let sent = 0;
    for (let i = 0; i < emails.length; i += 100) {
      const batch = emails.slice(i, i + 100);
      const res = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(batch)
      });
      if (!res.ok) {
        // un-claim the ones not sent so the next run can try again
        const unsent = toSend.slice(i).map((p) => p.id);
        await admin.from('timesheet_reminders').delete().eq('period_start', start).in('user_id', unsent);
        return json({ sent, error: `Email failed: ${await res.text()}` }, 502);
      }
      sent += batch.length;
    }
    return json({ sent, period });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
