// Supabase Edge Function: notify
// Sends the portal's email alerts through Resend.
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor
//         name it exactly  notify  → replace the sample code with this file → Deploy.
// Secrets (Edge Functions → Secrets):
//   RESEND_API_KEY  your Resend API key (Sending access)
//   MAIL_FROM       Cleburne County Sheriff's Office <noreply@ccsoportal.com>
//   SITE_URL        https://ccsoportal.com/
//
// The website only says WHAT happened (type + id). This function looks everything up
// itself and checks the person asking is allowed, so nobody can use it to send
// arbitrary emails.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TZ = 'America/Chicago';
const fmtWhen = (s, e, allDay) => {
  const d = new Date(s);
  const day = d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const t = (x) => new Date(x).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  if (allDay) return `${day} (all day)`;
  return e ? `${day}, ${t(s)} – ${t(e)}` : `${day}, ${t(s)}`;
};
const fmtDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function page(site, heading, lines, button) {
  const rows = lines.filter(Boolean).map((l) => `<p style="margin:0 0 10px;">${l}</p>`).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0;font-family:Arial,Helvetica,sans-serif;">
  <tr><td align="center"><table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-top:4px solid #e5a34c;border-radius:8px;">
    <tr><td align="center" style="padding:24px 24px 4px;"><img src="${site}logo.png" alt="Cleburne County Sheriff's Office" width="260" style="display:block;width:260px;max-width:100%;height:auto;border:0;"></td></tr>
    <tr><td style="padding:14px 30px 6px;color:#1d2330;font-size:15px;line-height:1.5;">
      <h1 style="margin:0 0 12px;font-size:20px;color:#41512c;">${heading}</h1>${rows}</td></tr>
    <tr><td align="center" style="padding:6px 30px 26px;"><a href="${site}" style="display:inline-block;background:#41512c;color:#fff;text-decoration:none;font-weight:bold;font-size:15px;padding:11px 24px;border-radius:6px;">${button || 'Open the Employee Portal'}</a></td></tr>
    <tr><td style="padding:12px 30px;border-top:1px solid #e3e6ec;color:#98a1b0;font-size:12px;">Cleburne County Sheriff's Office Employee Portal · automated message, please don't reply</td></tr>
  </table></td></tr></table>`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  try {
    const KEY = Deno.env.get('RESEND_API_KEY');
    const FROM = Deno.env.get('MAIL_FROM');
    let SITE = Deno.env.get('SITE_URL') || '';
    if (SITE && !SITE.endsWith('/')) SITE += '/';
    console.log(`notify: key ${KEY ? KEY.slice(0, 6) + '…' : 'MISSING'} · from ${FROM || 'MISSING'} · site ${SITE || 'MISSING'}`);
    if (!KEY || !FROM || !SITE) return json({ error: 'Email alerts are not set up (missing RESEND_API_KEY, MAIL_FROM or SITE_URL secret).' }, 500);

    const db = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // Who is asking?
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who } = await db.auth.getUser(token);
    if (!who?.user) return json({ error: 'Please sign in again.' }, 401);
    const { data: me } = await db.from('profiles').select('id, full_name, role, active').eq('id', who.user.id).maybeSingle();
    if (!me || me.active === false) return json({ error: 'Not allowed.' }, 403);
    const isMgr = me.role === 'manager';
    const mgrOnly = () => { if (!isMgr) throw Object.assign(new Error('Managers only.'), { status: 403 }); };

    const { type, id, user_ids, exclude_ids, everyone: toEveryone } = await req.json().catch(() => ({}));
    if (!type || !id) return json({ error: 'Missing type or id.' }, 400);

    const people = async (ids) => {
      if (!ids?.length) return [];
      const { data } = await db.from('profiles').select('id, full_name, email, active').in('id', ids);
      return (data || []).filter((p) => p.active !== false && p.email);
    };
    const everyone = async () => {
      const { data } = await db.from('profiles').select('id, full_name, email, active').eq('active', true);
      return (data || []).filter((p) => p.email);
    };
    const managers = async () => {
      const { data } = await db.from('profiles').select('id, full_name, email, active').eq('role', 'manager').eq('active', true);
      return (data || []).filter((p) => p.email);
    };

    let to = [], subject = '', html = '';

    if (type === 'offduty_decision') {
      mgrOnly();
      const { data: r } = await db.from('offduty_requests').select('*, offduty_jobs(*)').eq('id', id).single();
      if (!r || !['approved', 'declined'].includes(r.status)) return json({ ok: true, sent: 0 });
      const j = r.offduty_jobs;
      to = await people([r.user_id]);
      const ok = r.status === 'approved';
      subject = ok ? `Approved: ${j.title}` : `Off-duty request declined: ${j.title}`;
      html = page(SITE, ok ? 'You’re approved for an off-duty job' : 'Your off-duty request was declined', [
        `<strong>${esc(j.title)}</strong>`, esc(fmtWhen(j.starts_at, j.ends_at)),
        j.location ? `Location: ${esc(j.location)}` : '', j.pay ? `Pay: ${esc(j.pay)}` : '',
        j.details ? esc(j.details).replace(/\n/g, '<br>') : ''
      ]);
    } else if (type === 'offduty_request') {
      const { data: r } = await db.from('offduty_requests').select('*, offduty_jobs(*)').eq('id', id).single();
      if (!r || r.user_id !== me.id || r.status !== 'requested') return json({ ok: true, sent: 0 });
      const j = r.offduty_jobs;
      to = await managers();
      subject = `Off-duty request: ${me.full_name} — ${j.title}`;
      html = page(SITE, 'New off-duty job request', [
        `<strong>${esc(me.full_name)}</strong> requested <strong>${esc(j.title)}</strong>.`,
        esc(fmtWhen(j.starts_at, j.ends_at)), r.note ? `Note: “${esc(r.note)}”` : '',
        'Approve or decline it on the Off-Duty Jobs tab.'
      ], 'Review requests');
    } else if (type === 'offduty_new_job') {
      mgrOnly();
      const { data: j } = await db.from('offduty_jobs').select('*').eq('id', id).single();
      if (!j || j.status !== 'open') return json({ ok: true, sent: 0 });
      to = await everyone();
      subject = `New off-duty job: ${j.title}`;
      html = page(SITE, 'New off-duty job posted', [
        `<strong>${esc(j.title)}</strong>`, esc(fmtWhen(j.starts_at, j.ends_at)),
        j.location ? `Location: ${esc(j.location)}` : '', j.pay ? `Pay: ${esc(j.pay)}` : '',
        `Spots: ${j.spots}`, j.details ? esc(j.details).replace(/\n/g, '<br>') : '',
        'Request it on the Off-Duty Jobs tab. A manager will approve who works it.'
      ], 'Request this job');
    } else if (type === 'event_tagged' || type === 'event_changed' || type === 'event_deleted') {
      mgrOnly();
      const { data: e } = await db.from('events').select('*').eq('id', id).single();
      if (!e) return json({ ok: true, sent: 0 });
      const { data: tags } = await db.from('event_people').select('user_id').eq('event_id', id);
      const tagged = new Set((tags || []).map((t) => t.user_id));
      let ids = [...tagged];
      if (type === 'event_tagged') ids = (user_ids || []).filter((u) => tagged.has(u));
      if (type === 'event_changed') ids = ids.filter((u) => !(exclude_ids || []).includes(u));
      // Office-wide events ("Show to everyone" / paid holidays) can be emailed to everyone
      const all = !!toEveryone && e.for_everyone && e.kind !== 'holiday';
      if (e.kind === 'holiday') return json({ ok: true, sent: 0 });   // paid holidays don't send email
      to = all ? await everyone() : await people(ids);
      const kind = e.kind === 'court' ? 'court date' : e.kind === 'training' ? 'training' : e.kind === 'holiday' ? 'paid holiday' : 'event';
      const lines = [`<strong>${esc(e.title)}</strong>`, esc(fmtWhen(e.starts_at, e.ends_at, e.all_day)),
        e.location ? `Location: ${esc(e.location)}` : '', e.details ? esc(e.details).replace(/\n/g, '<br>') : ''];
      if (e.kind === 'holiday') lines.splice(2, 0, `Paid holiday: ${Number(e.holiday_hours ?? 8)} hours`);
      const label = e.kind === 'court' ? 'Court date' : e.kind === 'training' ? 'Training' : e.kind === 'holiday' ? 'Paid holiday' : 'Calendar';
      if (type === 'event_tagged') {
        subject = `${label}: ${e.title} — ${fmtWhen(e.starts_at, null, e.all_day)}`;
        html = page(SITE, all ? `New ${kind} on the calendar` : `You’ve been added to a ${kind}`, lines, 'View the calendar');
      } else if (type === 'event_changed') {
        subject = `Updated ${kind}: ${e.title}`;
        html = page(SITE, all ? `A ${kind} on the calendar has changed` : `A ${kind} you’re on has changed`, ['Here are the new details:', ...lines], 'View the calendar');
      } else {
        subject = `Cancelled ${kind}: ${e.title}`;
        html = page(SITE, all ? `A ${kind} was removed from the calendar` : `A ${kind} you were on was removed`, [...lines, 'It has been taken off the calendar.'], 'View the calendar');
      }
    } else if (type === 'announcement') {
      mgrOnly();
      const { data: a } = await db.from('announcements').select('*').eq('id', id).single();
      if (!a) return json({ ok: true, sent: 0 });
      to = await everyone();
      subject = `${a.kind === 'training' ? 'Training: ' : ''}${a.title}`;
      html = page(SITE, esc(a.title), [esc(a.body).replace(/\n/g, '<br>')]);
    } else if (type === 'timeoff_decision') {
      mgrOnly();
      const { data: r } = await db.from('time_off_requests').select('*').eq('id', id).single();
      if (!r || !['approved', 'denied'].includes(r.status)) return json({ ok: true, sent: 0 });
      to = await people([r.user_id]);
      const range = r.start_date === r.end_date ? fmtDate(r.start_date) : `${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}`;
      subject = `Time off ${r.status}: ${range}`;
      html = page(SITE, `Your time-off request was ${r.status}`, [
        `<strong>${esc(range)}</strong> (${esc(r.type)})`, r.manager_note ? `Note: “${esc(r.manager_note)}”` : ''
      ]);
    } else if (type === 'timesheet_returned') {
      mgrOnly();
      const { data: t } = await db.from('timesheets').select('*').eq('id', id).single();
      if (!t || t.status !== 'rejected') return json({ ok: true, sent: 0 });
      to = await people([t.user_id]);
      subject = `Timesheet sent back: pay period starting ${fmtDate(t.period_start)}`;
      html = page(SITE, 'Your timesheet was sent back', [
        `Pay period starting <strong>${esc(fmtDate(t.period_start))}</strong>.`,
        t.manager_note ? `Note: “${esc(t.manager_note)}”` : '',
        'Please fix it and sign it again on the My Timesheets tab.'
      ], 'Fix my timesheet');
    } else {
      return json({ error: 'Unknown type.' }, 400);
    }

    if (!to.length) return json({ ok: true, sent: 0 });
    // Resend batch: one separate email per person (nobody sees the others' addresses), 100 per call
    let sent = 0;
    for (let i = 0; i < to.length; i += 100) {
      const batch = to.slice(i, i + 100).map((p) => ({ from: FROM, to: [p.email], subject, html }));
      const res = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(batch)
      });
      if (!res.ok) {
        const detail = await res.text();
        console.error(`Resend refused the email (HTTP ${res.status}): ${detail}`);
        return json({ error: `Resend (HTTP ${res.status}): ${detail}`, sent }, 502);
      }
      sent += batch.length;
    }
    return json({ ok: true, sent });
  } catch (e) {
    console.error('notify failed:', e?.message || e);
    return json({ error: String(e?.message || e) }, e?.status || 500);
  }
});
