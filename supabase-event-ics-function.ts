// Supabase Edge Function: event-ics
// "Add to my calendar" on iPhone. Safari only offers "Add to Calendar" for a calendar file it loads
// from a real web address, so the portal gets a 10-minute pass for one event (calendar_ticket) and
// opens this function's address with it. The pass is checked here; no login goes in the link.
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name it
// "event-ics" → paste this whole file → Deploy, then turn OFF "Verify JWT"
// (the phone opens this address directly; the pass is what's checked). No secrets needed.
import { createClient } from 'npm:@supabase/supabase-js@2';

const TIME_ZONE = 'America/Chicago';

const pad = (n: number) => String(n).padStart(2, '0');
const utc = (ts: string | Date) => {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
};
// The Central-time date of a moment, as YYYYMMDD (for all-day events)
const localDay = (ts: string | Date, addDays = 0) => {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(ts));
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + addDays);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
};
const text = (v: unknown) => String(v ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const fold = (line: string) => {
  const out: string[] = [];
  let l = line;
  while (l.length > 60) { out.push(l.slice(0, 60)); l = ' ' + l.slice(60); }
  out.push(l);
  return out.join('\r\n');
};
const page = (msg: string, status: number) =>
  new Response(`<!doctype html><meta name="viewport" content="width=device-width"><p style="font:16px system-ui;padding:24px">${msg}</p>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

Deno.serve(async (req) => {
  try {
    const token = new URL(req.url).searchParams.get('t') || '';
    if (!/^[0-9a-f]{64}$/.test(token)) return page('This link isn’t valid.', 400);
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } });

    const { data: t } = await admin.from('calendar_tickets').select('*').eq('token', token)
      .gt('expires_at', new Date().toISOString()).maybeSingle();
    if (!t) return page('This link has expired. Go back to the portal and tap “Add to my calendar” again.', 410);

    // The event or off-duty job, in the same shape
    let ev: { id: string; title: string; starts_at: string; ends_at: string | null; all_day: boolean; location: string | null; details: string | null; kind: string } | null = null;
    if (t.kind === 'event') {
      const { data } = await admin.from('events').select('*').eq('id', t.item_id).maybeSingle();
      ev = data;
    } else {
      const { data } = await admin.from('offduty_jobs').select('*').eq('id', t.item_id).maybeSingle();
      if (data) ev = { ...data, kind: 'offduty', all_day: false, title: `Off-duty: ${data.title}` };
    }
    if (!ev) return page('That event was removed from the calendar.', 404);

    const title = ev.kind === 'court' ? `Court: ${ev.title}` : ev.title;
    const when = ev.all_day
      ? [`DTSTART;VALUE=DATE:${localDay(ev.starts_at)}`, `DTEND;VALUE=DATE:${localDay(ev.ends_at || ev.starts_at, 1)}`]
      : [`DTSTART:${utc(ev.starts_at)}`, `DTEND:${utc(ev.ends_at || new Date(new Date(ev.starts_at).getTime() + 3600000))}`];
    const host = new URL(Deno.env.get('SUPABASE_URL')!).hostname;
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CCSO//Employee Portal//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT', `UID:${ev.id}@${host}`, `DTSTAMP:${utc(new Date())}`, ...when,
      `SUMMARY:${text(title)}`, ev.location ? `LOCATION:${text(ev.location)}` : '', ev.details ? `DESCRIPTION:${text(ev.details)}` : '',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(title)}`, ev.all_day ? 'TRIGGER:-PT15H' : 'TRIGGER:-PT1H', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).map(fold).join('\r\n') + '\r\n';

    const name = (ev.title || 'event').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'event';
    return new Response(ics, { headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `inline; filename="${name}.ics"`,
      'Cache-Control': 'no-store'
    } });
  } catch (err) {
    return page(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
});
