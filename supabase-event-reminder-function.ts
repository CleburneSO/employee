// Supabase Edge Function: event-reminder
// Runs every afternoon (scheduled by event-reminder.sql). Emails each deputy tagged on a court
// date, training or other office event that starts tomorrow (Central time). One reminder per
// person per event time; if an event is moved, the new time gets its own reminder.
// Paid holidays, "show to everyone" events nobody is tagged on, and personal events aren't reminded.
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name it
// "event-reminder" → paste this whole file → Deploy, then turn OFF "Verify JWT"
// (this function checks the job's secret itself). It uses the same secrets as "notify":
// RESEND_API_KEY, MAIL_FROM and SITE_URL.
//
// To see who would get a reminder without sending anything, run in the SQL Editor:
//   select public.run_event_reminder(true);
// then a few seconds later:
//   select status_code, content from net._http_response order by created desc limit 1;
import { createClient } from 'npm:@supabase/supabase-js@2';

// Name in the emails' footer (optional ORG_NAME secret, e.g. "Cleburne County Jail" for the jail portal)
const ORG_NAME = Deno.env.get('ORG_NAME') || "Cleburne County Sheriff's Office";

const TIME_ZONE = 'America/Chicago';
const KINDS = ['court', 'training', 'other'];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const localDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(d);   // YYYY-MM-DD
const fmtWhen = (s: string, e: string | null, allDay: boolean) => {
  const day = new Date(s).toLocaleDateString('en-US', { timeZone: TIME_ZONE, weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
  const t = (x: string) => new Date(x).toLocaleTimeString('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });
  if (allDay) return `${day} (all day)`;
  return e ? `${day}, ${t(s)} – ${t(e)}` : `${day}, ${t(s)}`;
};

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

    // Office events starting tomorrow in Central time (look 2 days ahead, then match the date)
    const now = new Date();
    const tomorrow = localDay(new Date(now.getTime() + 86400000));
    const evs = await admin.from('events').select('*')
      .in('kind', KINDS).is('owner_id', null)
      .gte('starts_at', now.toISOString()).lt('starts_at', new Date(now.getTime() + 2 * 86400000).toISOString());
    if (evs.error) throw evs.error;
    const events = evs.data.filter((e) => localDay(new Date(e.starts_at)) === tomorrow);
    if (!events.length) return json({ sent: 0, tomorrow, note: 'Nothing tomorrow.' });

    const tags = await admin.from('event_people').select('event_id, user_id').in('event_id', events.map((e) => e.id));
    if (tags.error) throw tags.error;
    const ids = [...new Set(tags.data.map((t) => t.user_id))];
    if (!ids.length) return json({ sent: 0, tomorrow, note: 'Nobody tagged.' });
    const people = await admin.from('profiles').select('id, full_name, email, active').in('id', ids);
    if (people.error) throw people.error;
    const who = new Map(people.data.filter((p) => p.active && p.email).map((p) => [p.id, p]));
    const byId = new Map(events.map((e) => [e.id, e]));
    let pairs = tags.data.filter((t) => who.has(t.user_id)).map((t) => ({ e: byId.get(t.event_id)!, p: who.get(t.user_id)! }));

    if (dryRun) {
      return json({ dry_run: true, tomorrow, would_remind: pairs.map(({ e, p }) => `${p.full_name || p.email}: ${e.title}`) });
    }
    if (!pairs.length) return json({ sent: 0, tomorrow });

    // Claim each reminder first, so a second run sends nothing
    const claimed = await admin.from('event_reminders')
      .upsert(pairs.map(({ e, p }) => ({ event_id: e.id, user_id: p.id, starts_at: e.starts_at })),
        { onConflict: 'event_id,user_id,starts_at', ignoreDuplicates: true })
      .select('event_id, user_id');
    if (claimed.error) throw claimed.error;
    const ok = new Set(claimed.data.map((r) => `${r.event_id}|${r.user_id}`));
    pairs = pairs.filter(({ e, p }) => ok.has(`${e.id}|${p.id}`));
    if (!pairs.length) return json({ sent: 0, tomorrow, note: 'Already reminded.' });

    let site = Deno.env.get('SITE_URL') || '';
    if (site && !site.endsWith('/')) site += '/';
    const label = (k: string) => (k === 'court' ? 'court date' : k === 'training' ? 'training' : 'event');
    const emails = pairs.map(({ e, p }) => ({
      from: Deno.env.get('MAIL_FROM'),
      to: [p.email],
      subject: `Reminder: ${e.kind === 'court' ? 'Court' : e.kind === 'training' ? 'Training' : 'Event'} tomorrow — ${e.title}`,
      html: page(site, `You have a ${label(e.kind)} tomorrow`, [
        `Hi ${esc((p.full_name || '').split(' ')[0] || 'there')},`,
        `<strong>${esc(e.title)}</strong>`,
        esc(fmtWhen(e.starts_at, e.ends_at, e.all_day)),
        e.location ? `Location: ${esc(e.location)}` : '',
        e.details ? esc(e.details).replace(/\n/g, '<br>') : ''
      ], 'View the calendar')
    }));

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
        for (const { e, p } of pairs.slice(i)) {
          await admin.from('event_reminders').delete().eq('event_id', e.id).eq('user_id', p.id).eq('starts_at', e.starts_at);
        }
        return json({ sent, error: `Email failed: ${await res.text()}` }, 502);
      }
      sent += batch.length;
    }
    return json({ sent, tomorrow });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
