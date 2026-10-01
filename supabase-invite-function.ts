// Supabase Edge Function: invite-user
// Lets managers invite people from the Team tab of the portal.
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor
//         name it exactly  invite-user  → replace the sample code with this file → Deploy.
// It uses the project's secret service key, which Supabase provides to the function
// automatically — the key never goes in the website.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // 1. Who is asking? Must be an active manager.
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who, error: whoErr } = await admin.auth.getUser(token);
    if (whoErr || !who?.user) return json({ error: 'Please sign in again.' }, 401);
    const { data: me } = await admin.from('profiles').select('role, active').eq('id', who.user.id).maybeSingle();
    if (!me || me.role !== 'manager' || me.active === false) {
      return json({ error: 'Only managers can invite people.' }, 403);
    }

    // 2. Check the details
    const body = await req.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const fullName = String(body.full_name || '').trim();
    const role = body.role === 'manager' ? 'manager' : 'employee';
    const redirectTo = typeof body.redirect_to === 'string' ? body.redirect_to : undefined;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Enter a valid email address.' }, 400);
    if (!fullName) return json({ error: 'Enter the person’s full name.' }, 400);

    // 3. Send the invite (the name goes into the email and their profile)
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
      redirectTo
    });
    if (error) {
      const msg = /already.*registered|already exists/i.test(error.message)
        ? 'That email already has an account. If they never set a password, delete the user in Supabase (Authentication → Users) and invite again.'
        : error.message;
      return json({ error: msg }, 400);
    }

    // 4. Set their name and role on the profile
    const id = data.user?.id;
    if (id) {
      await admin.from('profiles').upsert({ id, email, full_name: fullName, role }, { onConflict: 'id' });
    }
    return json({ ok: true, id });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
