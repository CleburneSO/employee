// Supabase Edge Function: timeoff-alert
// Emails the time-off approvers (managers ticked "Approves time off" on the Team tab,
// e.g. the sheriff and chief deputy) when someone requests time off or logs comp time.
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name it
// "timeoff-alert" → paste this whole file → Deploy, then turn OFF "Verify JWT"
// (this function checks the caller itself). It uses the same secrets as "notify":
// RESEND_API_KEY, MAIL_FROM and SITE_URL.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const TYPES: Record<string, string> = {
  vacation: 'Vacation', sick: 'Sick', comp: 'Comp time used', comp_earned: 'Comp time earned'
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
    <tr><td style="padding:12px 30px;border-top:1px solid #e3e6ec;color:#98a1b0;font-size:12px;">Cleburne County Sheriff's Office Employee Portal · automated message, please don't reply</td></tr>
  </table></td></tr></table>`;
}

const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US',
  { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } });

    // Who is calling?
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: 'Not signed in.' }, 401);

    const { id } = await req.json().catch(() => ({}));
    if (!id) return json({ error: 'Missing request id.' }, 400);

    // Only the person who made the request, only while it's pending, only once.
    // Marking it first means two calls can never send two emails.
    const { data: r, error } = await admin.from('time_off_requests')
      .update({ approver_alerted_at: new Date().toISOString() })
      .eq('id', id).eq('user_id', user.id).eq('status', 'pending').is('approver_alerted_at', null)
      .select('*').maybeSingle();
    if (error) throw error;
    if (!r) return json({ sent: 0, note: 'Nothing to send.' });

    const { data: who } = await admin.from('profiles').select('full_name, email, active').eq('id', r.user_id).single();
    if (!who?.active) return json({ sent: 0, note: 'Inactive account.' });

    // The approvers; if nobody is ticked, every active manager
    const managers = await admin.from('profiles').select('email, timeoff_approver').eq('role', 'manager').eq('active', true);
    if (managers.error) throw managers.error;
    const ticked = managers.data.filter((m) => m.timeoff_approver);
    const to = [...new Set((ticked.length ? ticked : managers.data).map((m) => m.email).filter(Boolean))];
    if (!to.length) return json({ sent: 0, note: 'No approvers.' });

    const name = who.full_name || who.email;
    const type = TYPES[r.type] || r.type;
    const earned = r.type === 'comp_earned';
    const when = earned || r.start_date === r.end_date ? day(r.start_date) : `${day(r.start_date)} – ${day(r.end_date)}`;
    let site = Deno.env.get('SITE_URL') || '';
    if (site && !site.endsWith('/')) site += '/';
    const subject = earned ? `Comp time to approve: ${name}` : `Time-off request: ${name}, ${when}`;
    const html = page(site, earned ? 'Comp time to approve' : 'New time-off request', [
      `<strong>${esc(name)}</strong> ${earned ? 'logged comp time earned' : 'requested time off'}.`,
      `${earned ? 'Day worked' : 'Dates'}: <strong>${esc(when)}</strong>`,
      `Type: ${esc(type)}`,
      `Hours: ${esc(r.hours ?? '—')}`,
      r.reason ? `${earned ? 'What for' : 'Reason'}: “${esc(r.reason)}”` : '',
      'Approve or deny it on the Approvals tab.'
    ], 'Review it');

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: Deno.env.get('MAIL_FROM'), to, subject, html })
    });
    if (!res.ok) {
      // let the next call try again
      await admin.from('time_off_requests').update({ approver_alerted_at: null }).eq('id', id);
      return json({ error: `Email failed: ${await res.text()}` }, 502);
    }
    return json({ sent: to.length });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
