/* Employee Portal — static front end for GitHub Pages + Supabase */
(() => {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const app = document.getElementById('app');

  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('YOUR-PROJECT')) {
    app.innerHTML = `<div class="auth-wrap"><div class="card auth-card">
      <h2>Setup needed</h2>
      <p>Open <code>config.js</code> and paste in your Supabase project URL and anon key.</p>
    </div></div>`;
    return;
  }

  // Invite and password-reset links land here with the link type in the URL hash.
  // Read it before supabase-js consumes and clears the hash.
  const linkType = new URLSearchParams(location.hash.slice(1)).get('type');
  let mustSetPassword = linkType === 'invite' || linkType === 'recovery';

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  const state = { session: null, profile: null, view: 'timesheets', people: {} };
  let loadedUserId = null;

  const TIME_OFF_TYPES = [
    ['vacation', 'Vacation'], ['sick', 'Sick'], ['personal', 'Personal'],
    ['unpaid', 'Unpaid'], ['other', 'Other']
  ];

  /* ---------------- helpers ---------------- */
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const me = () => state.session.user.id;
  const isManager = () => state.profile?.role === 'manager';
  const round2 = (n) => Math.round(n * 100) / 100;

  const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const isoDate = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const mondayOf = (d) => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return addDays(x, -((x.getDay() + 6) % 7));
  };
  const fmtDate = (s) => parseDate(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtDay = (s) => parseDate(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtDateTime = (ts) => ts ? new Date(ts).toLocaleString() : '';
  const badge = (s) => `<span class="badge badge-${esc(s)}">${esc(s)}</span>`;
  const typeLabel = (t) => (TIME_OFF_TYPES.find(([k]) => k === t) || [t, t])[1];
  const dayCount = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000) + 1;
  const dateRange = (a, b) => a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`;

  function personName(id, fallback = '') {
    if (id === me()) return state.profile.full_name;
    return state.people[id]?.full_name || state.people[id]?.email || fallback;
  }

  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 4000);
  }

  async function withBusy(btn, fn) {
    if (btn) btn.disabled = true;
    try { await fn(); }
    catch (err) { toast(err.message || String(err), true); }
    finally { if (btn && btn.isConnected) btn.disabled = false; }
  }

  function openModal(html) {
    $('#modal-body').innerHTML = html;
    $('#modal').classList.remove('hidden');
  }
  function closeModal() { $('#modal').classList.add('hidden'); $('#modal-body').innerHTML = ''; }
  $('#modal .modal-close').onclick = closeModal;
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  function downloadCSV(filename, rows) {
    const csv = rows.map((r) => r.map((v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------------- signature pad ---------------- */
  function createSignaturePad(canvas) {
    const ctx = canvas.getContext('2d');
    let drawing = false, empty = true, last = null;

    function reset() {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, r.width, r.height);
      ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = '#111'; ctx.fillStyle = '#111';
      empty = true;
    }
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      drawing = true; last = pos(e);
      canvas.setPointerCapture(e.pointerId);
      ctx.beginPath(); ctx.arc(last.x, last.y, 1.1, 0, Math.PI * 2); ctx.fill();
      empty = false;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const p = pos(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p;
    });
    const stop = () => { drawing = false; };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);

    reset();
    return { clear: reset, isEmpty: () => empty, toDataURL: () => canvas.toDataURL('image/png') };
  }

  /* ---------------- auth flow ---------------- */
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') mustSetPassword = true;
    // Defer so we never call Supabase from inside the auth callback
    setTimeout(() => handleSession(session), 0);
  });

  async function handleSession(session) {
    state.session = session;
    if (!session) {
      loadedUserId = null; state.profile = null; state.people = {};
      return renderLogin();
    }
    if (mustSetPassword) return renderSetPassword();
    if (loadedUserId === session.user.id) return; // token refresh etc.
    loadedUserId = session.user.id;
    try {
      await loadProfile();
      if (!state.profile.full_name) return renderNameSetup();
      if (isManager()) await loadPeople();
      renderShell();
    } catch (err) {
      loadedUserId = null;
      app.innerHTML = `<div class="auth-wrap"><div class="card auth-card">
        <h2>Something went wrong</h2><p class="error-text">${esc(err.message)}</p>
        <button class="btn" id="so">Sign out</button></div></div>`;
      $('#so').onclick = () => sb.auth.signOut();
    }
  }

  async function loadProfile() {
    const uid = state.session.user.id;
    let { data, error } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
    if (error) throw error;
    if (!data) {
      const ins = await sb.from('profiles').insert({ id: uid, email: state.session.user.email }).select().single();
      if (ins.error) throw ins.error;
      data = ins.data;
    }
    state.profile = data;
  }

  async function loadPeople() {
    const { data, error } = await sb.from('profiles').select('id, full_name, email, role').order('full_name');
    if (error) throw error;
    state.people = Object.fromEntries(data.map((p) => [p.id, p]));
    return data;
  }

  function renderLogin(mode = 'login') {
    const reset = mode === 'reset';
    app.innerHTML = `<div class="auth-wrap"><div class="card auth-card">
      <h1>${esc(cfg.COMPANY_NAME || 'Employee Portal')}</h1>
      <p class="muted">${reset ? 'Enter your email and we’ll send you a reset link.' : 'Sign in to your account.'}</p>
      <form id="auth-form">
        <label>Email<input type="email" name="email" required autocomplete="email"></label>
        ${reset ? '' : '<label>Password<input type="password" name="password" required autocomplete="current-password"></label>'}
        <button class="btn primary block" type="submit">${reset ? 'Send reset link' : 'Sign in'}</button>
      </form>
      <button class="btn-link" id="toggle-mode">${reset ? 'Back to sign in' : 'Forgot password?'}</button>
    </div></div>`;
    $('#toggle-mode').onclick = () => renderLogin(reset ? 'login' : 'reset');
    $('#auth-form').onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      withBusy(e.target.querySelector('button'), async () => {
        if (reset) {
          const { error } = await sb.auth.resetPasswordForEmail(f.get('email'), {
            redirectTo: location.origin + location.pathname
          });
          if (error) throw error;
          toast('Check your email for a reset link.');
          renderLogin();
        } else {
          const { error } = await sb.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') });
          if (error) throw error;
        }
      });
    };
  }

  function renderSetPassword() {
    app.innerHTML = `<div class="auth-wrap"><div class="card auth-card">
      <h1>Set your password</h1>
      <p class="muted">Choose a password you’ll use to sign in (at least 8 characters).</p>
      <form id="pw-form">
        <label>New password<input type="password" name="pw" minlength="8" required autocomplete="new-password"></label>
        <label>Confirm password<input type="password" name="pw2" minlength="8" required autocomplete="new-password"></label>
        <button class="btn primary block" type="submit">Save password</button>
      </form>
    </div></div>`;
    $('#pw-form').onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      withBusy(e.target.querySelector('button'), async () => {
        if (f.get('pw') !== f.get('pw2')) throw new Error('Passwords don’t match.');
        const { error } = await sb.auth.updateUser({ password: f.get('pw') });
        if (error) throw error;
        mustSetPassword = false;
        history.replaceState(null, '', location.pathname);
        toast('Password saved.');
        loadedUserId = null;
        handleSession(state.session);
      });
    };
  }

  function renderNameSetup() {
    app.innerHTML = `<div class="auth-wrap"><div class="card auth-card">
      <h1>Welcome!</h1>
      <p class="muted">What’s your full name? This is how you’ll appear to your manager.</p>
      <form id="name-form">
        <label>Full name<input name="name" required autocomplete="name"></label>
        <button class="btn primary block" type="submit">Continue</button>
      </form>
    </div></div>`;
    $('#name-form').onsubmit = (e) => {
      e.preventDefault();
      const name = new FormData(e.target).get('name').trim();
      withBusy(e.target.querySelector('button'), async () => {
        if (!name) throw new Error('Please enter your name.');
        const { error } = await sb.from('profiles').update({ full_name: name }).eq('id', me());
        if (error) throw error;
        state.profile.full_name = name;
        if (isManager()) await loadPeople();
        renderShell();
      });
    };
  }

  /* ---------------- app shell ---------------- */
  const views = {};

  function renderShell() {
    const tabs = [['timesheets', 'My Timesheets'], ['timeoff', 'Time Off']];
    if (isManager()) tabs.push(['review', 'Approvals'], ['team', 'Team']);
    if (!tabs.some(([k]) => k === state.view)) state.view = 'timesheets';

    app.innerHTML = `
      <header class="topbar">
        <div class="brand">${esc(cfg.COMPANY_NAME || 'Employee Portal')}</div>
        <div class="user">
          <span>${esc(state.profile.full_name)}</span>
          <span class="role">${esc(state.profile.role)}</span>
          <button id="signout" class="btn-link light">Sign out</button>
        </div>
      </header>
      <nav class="tabs">${tabs.map(([k, l]) => `<button data-view="${k}">${l}</button>`).join('')}</nav>
      <main id="view"></main>`;
    $('#signout').onclick = () => sb.auth.signOut();
    $$('.tabs button').forEach((b) => { b.onclick = () => showView(b.dataset.view); });
    showView(state.view);
  }

  async function showView(v) {
    state.view = v;
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    const el = $('#view');
    el.innerHTML = '<div class="loading">Loading…</div>';
    try { await views[v](el); }
    catch (err) { el.innerHTML = `<div class="card"><p class="error-text">${esc(err.message)}</p></div>`; }
  }

  /* ---------------- timesheets ---------------- */
  function calcHours(inV, outV, brk) {
    if (!inV || !outV) return 0;
    const [ih, im] = inV.split(':').map(Number);
    const [oh, om] = outV.split(':').map(Number);
    let mins = (oh * 60 + om) - (ih * 60 + im);
    if (mins < 0) mins += 1440; // overnight shift
    mins -= Number(brk) || 0;
    return Math.max(0, mins / 60);
  }

  function buildRows(weekStart, entries = []) {
    const tbody = $('#ts-rows');
    tbody.innerHTML = [...Array(7)].map((_, i) => {
      const iso = isoDate(addDays(parseDate(weekStart), i));
      const e = entries.find((x) => x.date === iso) || {};
      return `<tr data-date="${iso}" data-label="${esc(fmtDay(iso))}">
        <td>${esc(fmtDay(iso))}</td>
        <td><input type="time" class="t-in" value="${esc(e.in || '')}"></td>
        <td><input type="time" class="t-out" value="${esc(e.out || '')}"></td>
        <td><input type="number" class="t-break" min="0" step="5" placeholder="0" value="${esc(e.break_min ?? '')}"></td>
        <td class="num t-hours">0.00</td>
      </tr>`;
    }).join('');
    recalc();
  }

  function recalc() {
    let total = 0;
    $$('#ts-rows tr').forEach((tr) => {
      const h = calcHours($('.t-in', tr).value, $('.t-out', tr).value, $('.t-break', tr).value);
      $('.t-hours', tr).textContent = h.toFixed(2);
      total += h;
    });
    $('#ts-total').textContent = total.toFixed(2);
  }

  views.timesheets = async (el) => {
    const { data: mine, error } = await sb.from('timesheets').select('*')
      .eq('user_id', me()).order('week_start', { ascending: false });
    if (error) throw error;

    el.innerHTML = `
      <section class="card">
        <h2>Submit a timesheet</h2>
        <form id="ts-form">
          <div class="row">
            <label>Week starting (Monday)<input type="date" id="ts-week" required></label>
          </div>
          <div id="ts-status" class="notice hidden"></div>
          <div class="table-wrap"><table class="grid">
            <thead><tr><th>Day</th><th>Time in</th><th>Time out</th><th>Break (min)</th><th class="num">Hours</th></tr></thead>
            <tbody id="ts-rows"></tbody>
            <tfoot><tr><td colspan="4">Total hours</td><td class="num" id="ts-total">0.00</td></tr></tfoot>
          </table></div>
          <label>Notes (optional)<textarea id="ts-notes" rows="2"></textarea></label>
          <fieldset class="sign">
            <legend>Electronic signature</legend>
            <div class="sig-box">
              <canvas id="sig"></canvas>
              <button type="button" class="btn small" id="sig-clear">Clear</button>
            </div>
            <p class="hint">Sign above with your mouse or finger.</p>
            <label>Type your full legal name<input id="ts-name" required autocomplete="name"></label>
            <label class="check"><input type="checkbox" id="ts-agree">
              <span>I certify the hours above are true and accurate, and I agree my electronic signature is the legal equivalent of my handwritten signature.</span></label>
          </fieldset>
          <button class="btn primary" type="submit" id="ts-submit">Sign &amp; submit</button>
        </form>
      </section>
      <section class="card"><h2>My timesheets</h2>${timesheetTable(mine, false)}</section>`;

    bindTimesheetButtons(el, mine);
    const pad = createSignaturePad($('#sig'));
    $('#sig-clear').onclick = () => pad.clear();
    $('#ts-rows').addEventListener('input', recalc);

    const weekInput = $('#ts-week');
    let existing = null;

    const loadWeek = () => {
      const wk = isoDate(mondayOf(weekInput.value ? parseDate(weekInput.value) : new Date()));
      weekInput.value = wk;
      existing = mine.find((t) => t.week_start === wk) || null;
      const note = $('#ts-status'), btn = $('#ts-submit');
      btn.disabled = false;
      note.className = 'notice hidden';
      if (existing) {
        note.className = 'notice';
        if (existing.status === 'approved') {
          note.textContent = 'This week is already approved and locked.';
          btn.disabled = true;
        } else if (existing.status === 'rejected') {
          note.innerHTML = `This week was sent back${existing.manager_note ? `: <em>${esc(existing.manager_note)}</em>` : '.'} Fix it and sign again to resubmit.`;
        } else {
          note.textContent = 'You already submitted this week. Submitting again replaces it and requires a new signature.';
        }
      }
      $('#ts-notes').value = existing?.notes || '';
      buildRows(wk, existing?.entries || []);
    };
    weekInput.value = isoDate(mondayOf(new Date()));
    loadWeek();
    weekInput.onchange = loadWeek;

    $('#ts-form').onsubmit = (e) => {
      e.preventDefault();
      withBusy($('#ts-submit'), async () => {
        const entries = [];
        let total = 0;
        for (const tr of $$('#ts-rows tr')) {
          const i = $('.t-in', tr).value, o = $('.t-out', tr).value;
          const b = Number($('.t-break', tr).value) || 0;
          if (!i && !o) continue;
          if (!i || !o) throw new Error(`Enter both time in and time out for ${tr.dataset.label}.`);
          const h = calcHours(i, o, b);
          entries.push({ date: tr.dataset.date, in: i, out: o, break_min: b, hours: round2(h) });
          total += h;
        }
        if (!entries.length) throw new Error('Enter hours for at least one day.');
        if (pad.isEmpty()) throw new Error('Please sign in the signature box.');
        const name = $('#ts-name').value.trim();
        if (!name) throw new Error('Please type your full name.');
        if (!$('#ts-agree').checked) throw new Error('Please check the certification box.');

        const row = {
          week_start: weekInput.value,
          entries,
          total_hours: round2(total),
          notes: $('#ts-notes').value.trim() || null,
          signature_data: pad.toDataURL(),
          signed_name: name,
          status: 'submitted'
        };
        const res = existing
          ? await sb.from('timesheets').update(row).eq('id', existing.id)
          : await sb.from('timesheets').insert({ ...row, user_id: me() });
        if (res.error) throw res.error;
        toast('Timesheet signed and submitted.');
        showView('timesheets');
      });
    };
  };

  function timesheetTable(list, mgr) {
    if (!list.length) return '<p class="muted">Nothing here yet.</p>';
    return `<div class="table-wrap"><table class="list">
      <thead><tr>${mgr ? '<th>Employee</th>' : ''}<th>Week of</th><th class="num">Hours</th><th>Status</th><th>Signed</th><th></th></tr></thead>
      <tbody>${list.map((t) => `<tr>
        ${mgr ? `<td>${esc(personName(t.user_id, 'Unknown'))}</td>` : ''}
        <td>${fmtDate(t.week_start)}</td>
        <td class="num">${Number(t.total_hours).toFixed(2)}</td>
        <td>${badge(t.status)}</td>
        <td>${esc(fmtDateTime(t.signed_at))}</td>
        <td class="right"><button class="btn small" data-ts="${t.id}">${mgr && t.status === 'submitted' ? 'Review' : 'View'}</button></td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  function bindTimesheetButtons(el, list) {
    $$('[data-ts]', el).forEach((b) => {
      b.onclick = () => openTimesheet(list.find((t) => t.id === b.dataset.ts));
    });
  }

  function reviewInfo(r) {
    if (!r.reviewed_at) return '';
    const by = personName(r.reviewed_by);
    return `<p class="muted">${esc(r.status[0].toUpperCase() + r.status.slice(1))}${by ? ` by ${esc(by)}` : ''} on ${esc(fmtDateTime(r.reviewed_at))}
      ${r.manager_note ? `<br>Manager note: ${esc(r.manager_note)}` : ''}</p>`;
  }

  function reviewControls(denyLabel) {
    return `<div class="review">
      <label>Note to employee (optional)<textarea id="rv-note" rows="2"></textarea></label>
      <div class="actions">
        <button class="btn primary" id="rv-approve">Approve</button>
        <button class="btn danger" id="rv-deny">${denyLabel}</button>
      </div></div>`;
  }

  function bindReview(table, id, denyStatus) {
    const act = (status, btn) => withBusy(btn, async () => {
      const { error } = await sb.from(table)
        .update({ status, manager_note: $('#rv-note').value.trim() || null }).eq('id', id);
      if (error) throw error;
      closeModal();
      toast(status === 'approved' ? 'Approved.' : 'Sent back to employee.');
      showView(state.view);
    });
    $('#rv-approve').onclick = (e) => act('approved', e.target);
    $('#rv-deny').onclick = (e) => act(denyStatus, e.target);
  }

  function openTimesheet(t) {
    const canReview = isManager() && t.status === 'submitted';
    const sigOk = typeof t.signature_data === 'string' && t.signature_data.startsWith('data:image/png;base64,');
    const rows = (t.entries || []).map((e) => `<tr>
      <td>${esc(fmtDay(e.date))}</td><td>${esc(e.in)}</td><td>${esc(e.out)}</td>
      <td class="num">${esc(e.break_min)}</td><td class="num">${Number(e.hours).toFixed(2)}</td></tr>`).join('');

    openModal(`
      <div class="doc">
        <h2>Timesheet</h2>
        <p><strong>${esc(personName(t.user_id, 'Employee'))}</strong> · Week of ${fmtDate(t.week_start)} ${badge(t.status)}</p>
        <div class="table-wrap"><table class="grid">
          <thead><tr><th>Day</th><th>In</th><th>Out</th><th class="num">Break</th><th class="num">Hours</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td colspan="4">Total hours</td><td class="num">${Number(t.total_hours).toFixed(2)}</td></tr></tfoot>
        </table></div>
        ${t.notes ? `<p><strong>Notes:</strong> ${esc(t.notes)}</p>` : ''}
        <div class="sig-record">
          ${sigOk ? `<img src="${t.signature_data}" alt="Signature">` : ''}
          <p>Electronically signed by <strong>${esc(t.signed_name)}</strong><br>${esc(fmtDateTime(t.signed_at))}</p>
        </div>
        ${reviewInfo(t)}
      </div>
      ${canReview ? reviewControls('Send back') : ''}
      <div class="actions no-print"><button class="btn" id="print-btn">Print / Save PDF</button></div>`);
    $('#print-btn').onclick = () => window.print();
    if (canReview) bindReview('timesheets', t.id, 'rejected');
  }

  /* ---------------- time off ---------------- */
  views.timeoff = async (el) => {
    const { data, error } = await sb.from('time_off_requests').select('*')
      .eq('user_id', me()).order('start_date', { ascending: false });
    if (error) throw error;

    el.innerHTML = `
      <section class="card">
        <h2>Request time off</h2>
        <form id="to-form">
          <div class="row">
            <label>Type<select name="type">${TIME_OFF_TYPES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
            <label>First day<input type="date" name="start" required></label>
            <label>Last day<input type="date" name="end" required></label>
          </div>
          <label>Reason (optional)<textarea name="reason" rows="2"></textarea></label>
          <button class="btn primary" type="submit">Submit request</button>
        </form>
      </section>
      <section class="card"><h2>My requests</h2>${timeOffTable(data, false)}</section>`;

    const form = $('#to-form');
    form.start.onchange = () => { if (!form.end.value || form.end.value < form.start.value) form.end.value = form.start.value; };
    form.onsubmit = (e) => {
      e.preventDefault();
      withBusy(form.querySelector('button[type=submit]'), async () => {
        if (form.end.value < form.start.value) throw new Error('Last day must be on or after the first day.');
        const { error } = await sb.from('time_off_requests').insert({
          user_id: me(), type: form.type.value, start_date: form.start.value,
          end_date: form.end.value, reason: form.reason.value.trim() || null
        });
        if (error) throw error;
        toast('Request submitted.');
        showView('timeoff');
      });
    };
    bindTimeOffButtons(el, data);
  };

  function timeOffTable(list, mgr) {
    if (!list.length) return '<p class="muted">Nothing here yet.</p>';
    return `<div class="table-wrap"><table class="list">
      <thead><tr>${mgr ? '<th>Employee</th>' : ''}<th>Dates</th><th class="num">Days</th><th>Type</th><th>Status</th><th>Note</th><th></th></tr></thead>
      <tbody>${list.map((r) => {
        let action = '';
        if (mgr && r.status === 'pending') action = `<button class="btn small" data-to="${r.id}">Review</button>`;
        else if (!mgr && r.status === 'pending') action = `<button class="btn small" data-cancel="${r.id}">Cancel</button>`;
        return `<tr>
          ${mgr ? `<td>${esc(personName(r.user_id, 'Unknown'))}</td>` : ''}
          <td>${esc(dateRange(r.start_date, r.end_date))}</td>
          <td class="num">${dayCount(r.start_date, r.end_date)}</td>
          <td>${esc(typeLabel(r.type))}</td>
          <td>${badge(r.status)}</td>
          <td class="note">${esc(r.manager_note || (mgr ? r.reason : '') || '')}</td>
          <td class="right">${action}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  function bindTimeOffButtons(el, list) {
    $$('[data-cancel]', el).forEach((b) => {
      b.onclick = () => {
        if (!confirm('Cancel this time-off request?')) return;
        withBusy(b, async () => {
          const { error } = await sb.from('time_off_requests').update({ status: 'cancelled' }).eq('id', b.dataset.cancel);
          if (error) throw error;
          toast('Request cancelled.');
          showView(state.view);
        });
      };
    });
    $$('[data-to]', el).forEach((b) => {
      b.onclick = () => openTimeOff(list.find((r) => r.id === b.dataset.to));
    });
  }

  function openTimeOff(r) {
    openModal(`
      <div class="doc">
        <h2>Time-off request</h2>
        <p><strong>${esc(personName(r.user_id, 'Employee'))}</strong> ${badge(r.status)}</p>
        <dl class="details">
          <dt>Type</dt><dd>${esc(typeLabel(r.type))}</dd>
          <dt>Dates</dt><dd>${esc(dateRange(r.start_date, r.end_date))} (${dayCount(r.start_date, r.end_date)} day${dayCount(r.start_date, r.end_date) > 1 ? 's' : ''})</dd>
          <dt>Reason</dt><dd>${esc(r.reason || '—')}</dd>
          <dt>Requested</dt><dd>${esc(fmtDateTime(r.created_at))}</dd>
        </dl>
        ${reviewInfo(r)}
      </div>
      ${isManager() && r.status === 'pending' ? reviewControls('Deny') : ''}`);
    if (isManager() && r.status === 'pending') bindReview('time_off_requests', r.id, 'denied');
  }

  /* ---------------- manager: approvals ---------------- */
  views.review = async (el) => {
    await loadPeople();
    const [ts, to, tsDone, toDone] = await Promise.all([
      sb.from('timesheets').select('*').eq('status', 'submitted').order('week_start'),
      sb.from('time_off_requests').select('*').eq('status', 'pending').order('start_date'),
      sb.from('timesheets').select('*').neq('status', 'submitted').order('week_start', { ascending: false }).limit(25),
      sb.from('time_off_requests').select('*').neq('status', 'pending').order('start_date', { ascending: false }).limit(25)
    ]);
    for (const r of [ts, to, tsDone, toDone]) if (r.error) throw r.error;

    const lastMonday = isoDate(addDays(mondayOf(new Date()), -7));
    el.innerHTML = `
      <section class="card"><h2>Timesheets awaiting approval <span class="count">${ts.data.length}</span></h2>
        <div id="ts-pending">${timesheetTable(ts.data, true)}</div></section>
      <section class="card"><h2>Time off awaiting approval <span class="count">${to.data.length}</span></h2>
        <div id="to-pending">${timeOffTable(to.data, true)}</div></section>
      <section class="card"><h2>Export timesheets for payroll</h2>
        <form id="exp" class="row end">
          <label>From week<input type="date" name="from" value="${lastMonday}" required></label>
          <label>To week<input type="date" name="to" value="${lastMonday}" required></label>
          <label>Include<select name="status"><option value="approved">Approved only</option><option value="all">All statuses</option></select></label>
          <button class="btn" type="submit">Download CSV</button>
        </form></section>
      <section class="card"><h2>Recent timesheets</h2><div id="ts-done">${timesheetTable(tsDone.data, true)}</div></section>
      <section class="card"><h2>Recent time off</h2><div id="to-done">${timeOffTable(toDone.data, true)}</div></section>`;

    bindTimesheetButtons($('#ts-pending'), ts.data);
    bindTimesheetButtons($('#ts-done'), tsDone.data);
    bindTimeOffButtons($('#to-pending'), to.data);
    bindTimeOffButtons($('#to-done'), toDone.data);

    const exp = $('#exp');
    exp.onsubmit = (e) => {
      e.preventDefault();
      withBusy(exp.querySelector('button'), async () => {
        const from = isoDate(mondayOf(parseDate(exp.from.value)));
        const to2 = exp.to.value;
        let q = sb.from('timesheets').select('*').gte('week_start', from).lte('week_start', to2);
        if (exp.status.value === 'approved') q = q.eq('status', 'approved');
        const { data, error } = await q.order('week_start');
        if (error) throw error;
        if (!data.length) throw new Error('No timesheets found for that range.');
        const rows = [['Employee', 'Email', 'Week start', 'Date', 'Time in', 'Time out', 'Break (min)', 'Hours', 'Week total', 'Status', 'Signed by', 'Signed at']];
        data.sort((a, b) => personName(a.user_id).localeCompare(personName(b.user_id)) || a.week_start.localeCompare(b.week_start));
        for (const t of data) {
          for (const en of t.entries || []) {
            rows.push([personName(t.user_id), state.people[t.user_id]?.email || '', t.week_start, en.date,
              en.in, en.out, en.break_min, en.hours, t.total_hours, t.status, t.signed_name, t.signed_at]);
          }
        }
        downloadCSV(`timesheets_${from}_to_${to2}.csv`, rows);
      });
    };
  };

  /* ---------------- manager: team ---------------- */
  views.team = async (el) => {
    const people = await loadPeople();
    el.innerHTML = `
      <section class="card">
        <h2>Team</h2>
        <p class="muted">To add someone, invite them from your Supabase dashboard: <strong>Authentication → Users → Invite user</strong>. They’ll get an email to set their password, then they can sign in here.</p>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
          <tbody>${people.map((p) => `<tr data-id="${p.id}">
            <td><input class="p-name" value="${esc(p.full_name)}"></td>
            <td>${esc(p.email)}</td>
            <td><select class="p-role" ${p.id === me() ? 'disabled title="You can’t change your own role"' : ''}>
              <option value="employee" ${p.role === 'employee' ? 'selected' : ''}>Employee</option>
              <option value="manager" ${p.role === 'manager' ? 'selected' : ''}>Manager</option>
            </select></td>
            <td class="right"><button class="btn small p-save">Save</button></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </section>`;

    $$('.p-save', el).forEach((b) => {
      b.onclick = () => {
        const tr = b.closest('tr');
        const id = tr.dataset.id;
        const update = { full_name: $('.p-name', tr).value.trim() };
        if (id !== me()) update.role = $('.p-role', tr).value;
        withBusy(b, async () => {
          if (!update.full_name) throw new Error('Name can’t be empty.');
          const { error } = await sb.from('profiles').update(update).eq('id', id);
          if (error) throw error;
          if (id === me()) state.profile.full_name = update.full_name;
          toast('Saved.');
          await loadPeople();
        });
      };
    });
  };
})();
