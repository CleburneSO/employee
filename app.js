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

  const ORG = cfg.COMPANY_NAME || 'Employee Portal';
  const REPORT_TITLE = cfg.REPORT_TITLE || 'DAILY REPORT';
  const PERIOD_DAYS = Number(cfg.PAY_PERIOD_DAYS) || 14;
  const PERIOD_ANCHOR = cfg.PAY_PERIOD_START || '2025-06-12';

  // Invite and password-reset links land here with the link type in the URL hash.
  // Read it before supabase-js consumes and clears the hash.
  const linkType = new URLSearchParams(location.hash.slice(1)).get('type');
  let mustSetPassword = linkType === 'invite' || linkType === 'recovery';

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  const state = { session: null, profile: null, view: 'timesheets', people: {}, duties: [] };
  let loadedUserId = null;

  const TIME_OFF_TYPES = [
    ['vacation', 'Vacation'], ['sick', 'Sick'], ['personal', 'Personal'],
    ['unpaid', 'Unpaid'], ['other', 'Other']
  ];

  // Hour lines every employee has (matches the paper Deputies Daily Report)
  const EXTRA_HOURS = [
    ['vacation_hours', 'Total Vacation Hours', 'Please list here Vacation hours you have used or would like cashed out.'],
    ['holiday_hours', 'Total Holiday Hours', ''],
    ['sick_hours', 'Total Sick Hours', 'Note: Once you reach 80 hours (including Holiday Hours) sick leave stops. A Dr.’s excuse is required to use sick leave for more than 2 consecutive days.']
  ];
  // Columns used by the first version, before special duties were assignable
  const LEGACY_HOURS = [
    ['traffic_ot_hours', 'Traffic OT', 'Total Traffic Overtime Hours', 'This is only for grant overtime hours worked such as STEP.'],
    ['k9_hours', 'K9', 'K9 At Home Care', '.5 HOUR FOR UNSCHEDULED WORK DAYS']
  ];
  // Special-duty lines on a saved timesheet (K9, DEA, Supervisor, …)
  function dutyLines(t) {
    const lines = (t.duty_hours || []).map((d) => ({ ...d, hours: Number(d.hours) || 0 }));
    for (const [k, name, label, note] of LEGACY_HOURS) {
      if (Number(t[k])) lines.push({ name, label, note, hours: Number(t[k]) });
    }
    return lines;
  }
  const dutyChips = (t) => dutyLines(t).filter((d) => d.hours > 0)
    .map((d) => `<span class="chip">${esc(d.name)} ${hrs(d.hours)}</span>`).join(' ');
  const SIGN_STATEMENT = 'By signing, you agree that the time reported is reported accurate and true.';

  /* ---------------- helpers ---------------- */
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const me = () => state.session.user.id;
  const isManager = () => state.profile?.role === 'manager';
  const round2 = (n) => Math.round(n * 100) / 100;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
  const hrs = (v) => Number(v || 0).toFixed(2);

  const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const isoDate = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const fmtDate = (s) => parseDate(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtShort = (s) => { const d = parseDate(s); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; };
  const fmtDay = (s) => parseDate(s).toLocaleDateString(undefined, { weekday: 'short' });
  const fmtDateTime = (ts) => ts ? new Date(ts).toLocaleString() : '';
  const badge = (s) => `<span class="badge badge-${esc(s)}">${esc(s)}</span>`;
  const typeLabel = (t) => (TIME_OFF_TYPES.find(([k]) => k === t) || [t, t])[1];
  const dayCount = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000) + 1;
  const dateRange = (a, b) => a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`;

  /* pay periods */
  function periodStartFor(d) {
    const anchor = parseDate(PERIOD_ANCHOR);
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((x - anchor) / 86400000);
    return addDays(anchor, Math.floor(diff / PERIOD_DAYS) * PERIOD_DAYS);
  }
  const periodEnd = (s) => isoDate(addDays(parseDate(s), PERIOD_DAYS - 1));
  const periodLabel = (s) => `${fmtShort(s)} – ${fmtShort(periodEnd(s))}`;
  const periodDays = (s) => [...Array(PERIOD_DAYS)].map((_, i) => isoDate(addDays(parseDate(s), i)));
  function periodOptions(extra = [], back = 8, ahead = 1) {
    const cur = periodStartFor(new Date());
    const set = new Set(extra);
    for (let i = ahead; i >= -back; i--) set.add(isoDate(addDays(cur, i * PERIOD_DAYS)));
    return [...set].sort().reverse();
  }
  const currentPeriod = () => isoDate(periodStartFor(new Date()));
  const previousPeriod = () => isoDate(addDays(periodStartFor(new Date()), -PERIOD_DAYS));
  const periodSelect = (id, selected, extra = []) =>
    `<select id="${id}">${periodOptions(extra).map((p) =>
      `<option value="${p}" ${p === selected ? 'selected' : ''}>${periodLabel(p)}${p === currentPeriod() ? ' (current)' : ''}</option>`).join('')}</select>`;

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
    $('#modal').scrollTop = 0;
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

  async function loadDuties() {
    const { data, error } = await sb.from('duties').select('*').order('sort').order('name');
    if (error) throw error;
    state.duties = data;
    return data;
  }

  async function loadAssignments(userId) {
    let q = sb.from('profile_duties').select('user_id, duty_id');
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  }

  function renderLogin(mode = 'login') {
    const reset = mode === 'reset';
    app.innerHTML = `<div class="auth-wrap"><div class="card auth-card">
      <h1>${esc(ORG)}</h1>
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
      <p class="muted">What’s your full name? This is how it will print on your timesheet.</p>
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
        <div class="brand">${esc(ORG)}</div>
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

  /* ---------------- timesheets: entry ---------------- */
  function calcHours(inV, outV) {
    if (!inV || !outV) return 0;
    const [ih, im] = inV.split(':').map(Number);
    const [oh, om] = outV.split(':').map(Number);
    let mins = (oh * 60 + om) - (ih * 60 + im);
    if (mins <= 0) mins += 1440; // overnight shift (e.g. 18:00 → 06:00)
    return mins / 60;
  }

  function buildRows(start, entries = []) {
    $('#ts-rows').innerHTML = periodDays(start).map((iso) => {
      const e = entries.find((x) => x.date === iso) || {};
      return `<tr data-date="${iso}" data-label="${esc(fmtShort(iso))}">
        <td class="day"><strong>${esc(fmtShort(iso))}</strong><span>${esc(fmtDay(iso))}</span></td>
        <td><input type="time" class="t-in" value="${esc(e.in || '')}" aria-label="Time in"></td>
        <td><input type="time" class="t-out" value="${esc(e.out || '')}" aria-label="Time out"></td>
        <td class="num t-hours"></td>
        <td><input class="t-expl" value="${esc(e.explanation || '')}" placeholder="" aria-label="Explanation"></td>
      </tr>`;
    }).join('');
  }

  function readExtras() {
    return Object.fromEntries(EXTRA_HOURS.map(([k]) => [k, round2(num($(`#x-${k}`).value))]));
  }

  function readDuties() {
    return $$('.duty-input').map((i) => ({ duty_id: i.dataset.duty, hours: round2(num(i.value)) }));
  }

  function recalc() {
    let worked = 0;
    $$('#ts-rows tr').forEach((tr) => {
      const h = calcHours($('.t-in', tr).value, $('.t-out', tr).value);
      $('.t-hours', tr).textContent = h ? h.toFixed(2) : '';
      worked += round2(h);
    });
    const x = readExtras();
    const special = readDuties().reduce((a, d) => a + d.hours, 0);
    $$('.duty-input').forEach((i) => i.closest('tr').classList.toggle('has-hours', num(i.value) > 0));
    const paid = worked + special + Object.values(x).reduce((a, b) => a + b, 0);
    $('#ts-total').textContent = hrs(worked);
    $('#ts-paid').textContent = hrs(paid);
    const warn = $('#ts-warn');
    if (x.sick_hours > 0 && worked + x.holiday_hours + x.sick_hours > 80) {
      warn.textContent = `Heads up: worked + holiday + sick comes to ${hrs(worked + x.holiday_hours + x.sick_hours)} hours. Sick leave stops once you reach 80 hours (including holiday hours).`;
      warn.classList.remove('hidden');
    } else warn.classList.add('hidden');
  }

  views.timesheets = async (el) => {
    const [{ data: mine, error }, , assigned] = await Promise.all([
      sb.from('timesheets').select('*').eq('user_id', me()).order('period_start', { ascending: false }),
      loadDuties(),
      loadAssignments(me())
    ]);
    if (error) throw error;
    const myIds = new Set(assigned.map((a) => a.duty_id));
    const myDuties = state.duties.filter((d) => d.active && (d.everyone || myIds.has(d.id)));

    el.innerHTML = `
      <section class="card">
        <h2>Submit a timesheet</h2>
        <form id="ts-form" autocomplete="off">
          <div class="row">
            <label>Pay period${periodSelect('ts-period', currentPeriod(), mine.map((t) => t.period_start))}</label>
          </div>
          <div id="ts-status" class="notice hidden"></div>
          <div class="table-wrap"><table class="grid entry">
            <thead><tr><th>Date</th><th>Time in</th><th>Time out</th><th class="num">Hours</th><th>Explanation of overtime or absences</th></tr></thead>
            <tbody id="ts-rows"></tbody>
          </table></div>
          <p class="hint">Hours are figured from time in and time out. Overnight shifts are handled automatically.</p>

          <div class="table-wrap"><table class="grid extras">
            <tbody>
              <tr class="total"><th>Total Hours Worked</th><td class="num" id="ts-total">0.00</td><td class="hint">This is the number of hours you actually worked.</td></tr>
              ${EXTRA_HOURS.map(([k, label, hint]) => `<tr>
                <th><label for="x-${k}">${esc(label)}</label></th>
                <td><input type="number" id="x-${k}" min="0" step="0.25" placeholder="0" inputmode="decimal"></td>
                <td class="hint">${esc(hint)}</td></tr>`).join('')}
              ${myDuties.map((d) => `<tr class="duty-row">
                <th><label for="d-${d.id}">${esc(d.label)}</label> <span class="chip">${esc(d.name)}</span></th>
                <td><input type="number" id="d-${d.id}" class="duty-input" data-duty="${d.id}" min="0" step="0.25" placeholder="0" inputmode="decimal"></td>
                <td class="hint">${esc(d.note)}</td></tr>`).join('')}
              <tr class="total"><th>Total Hours To Be Paid</th><td class="num" id="ts-paid">0.00</td><td></td></tr>
            </tbody>
          </table></div>
          <div id="ts-warn" class="notice warn hidden"></div>

          <fieldset class="sign">
            <legend>Employee signature</legend>
            <p class="sign-statement">${esc(SIGN_STATEMENT)}</p>
            <div class="sig-box">
              <canvas id="sig"></canvas>
              <button type="button" class="btn small" id="sig-clear">Clear</button>
            </div>
            <p class="hint">Sign above with your mouse or finger.</p>
            <label>Type your full name<input id="ts-name" required autocomplete="name"></label>
            <label class="check"><input type="checkbox" id="ts-agree">
              <span>I agree the time reported is accurate and true, and that my electronic signature is the legal equivalent of my handwritten signature.</span></label>
          </fieldset>
          <button class="btn primary" type="submit" id="ts-submit">Sign &amp; submit</button>
        </form>
      </section>
      <section class="card"><h2>My timesheets</h2>${timesheetTable(mine, false)}</section>`;

    bindTimesheetButtons(el, mine);
    const pad = createSignaturePad($('#sig'));
    $('#sig-clear').onclick = () => pad.clear();
    $('#ts-form').addEventListener('input', (e) => { if (!e.target.closest('.sign')) recalc(); });

    const periodInput = $('#ts-period');
    let existing = null;

    const loadPeriod = () => {
      const p = periodInput.value;
      existing = mine.find((t) => t.period_start === p) || null;
      const note = $('#ts-status'), btn = $('#ts-submit');
      btn.disabled = false;
      note.className = 'notice hidden';
      if (existing) {
        note.className = 'notice';
        if (existing.status === 'approved') {
          note.textContent = 'This pay period is already approved and locked.';
          btn.disabled = true;
        } else if (existing.status === 'rejected') {
          note.innerHTML = `This timesheet was sent back${existing.manager_note ? `: <em>${esc(existing.manager_note)}</em>` : '.'} Fix it and sign again to resubmit.`;
        } else {
          note.textContent = 'You already submitted this pay period. Submitting again replaces it and needs a new signature.';
        }
      }
      buildRows(p, existing?.entries || []);
      EXTRA_HOURS.forEach(([k]) => { $(`#x-${k}`).value = existing && Number(existing[k]) ? Number(existing[k]) : ''; });
      myDuties.forEach((d) => {
        const saved = existing ? (existing.duty_hours || []).find((x) => x.duty_id === d.id) : null;
        const v = existing ? Number(saved?.hours) || 0 : Number(d.default_hours) || 0;  // new sheet: pre-fill automatic hours
        $(`#d-${d.id}`).value = v ? v : '';
      });
      recalc();
    };
    loadPeriod();
    periodInput.onchange = loadPeriod;

    $('#ts-form').onsubmit = (e) => {
      e.preventDefault();
      withBusy($('#ts-submit'), async () => {
        const entries = [];
        for (const tr of $$('#ts-rows tr')) {
          const i = $('.t-in', tr).value, o = $('.t-out', tr).value;
          const expl = $('.t-expl', tr).value.trim();
          if ((i && !o) || (!i && o)) throw new Error(`Enter both time in and time out for ${tr.dataset.label}.`);
          if (!i && !expl) continue;
          entries.push({ date: tr.dataset.date, in: i, out: o, hours: round2(calcHours(i, o)), explanation: expl });
        }
        const extras = readExtras();
        const duty_hours = readDuties();
        const anyHours = entries.some((x) => x.hours > 0) || Object.values(extras).some((v) => v > 0)
          || duty_hours.some((d) => d.hours > 0);
        if (!anyHours) throw new Error('Enter at least one day worked or some vacation, holiday or sick hours.');
        if (pad.isEmpty()) throw new Error('Please sign in the signature box.');
        const name = $('#ts-name').value.trim();
        if (!name) throw new Error('Please type your full name.');
        if (!$('#ts-agree').checked) throw new Error('Please check the box agreeing the time is accurate.');

        const row = {
          period_start: periodInput.value,
          entries,
          ...extras,
          duty_hours,
          traffic_ot_hours: 0,
          k9_hours: 0,
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

  /* ---------------- timesheets: lists & printable sheet ---------------- */
  function timesheetTable(list, mgr) {
    if (!list.length) return '<p class="muted">Nothing here yet.</p>';
    return `<div class="table-wrap"><table class="list">
      <thead><tr>${mgr ? '<th>Employee</th>' : ''}<th>Pay period</th><th class="num">Worked</th><th>Special / grant OT</th><th class="num">To be paid</th><th>Status</th><th>Signed</th><th></th></tr></thead>
      <tbody>${list.map((t) => `<tr>
        ${mgr ? `<td>${esc(personName(t.user_id, 'Unknown'))}</td>` : ''}
        <td>${esc(periodLabel(t.period_start))}</td>
        <td class="num">${hrs(t.total_hours)}</td>
        <td>${dutyChips(t) || '<span class="muted">—</span>'}</td>
        <td class="num">${hrs(t.total_paid_hours)}</td>
        <td>${badge(t.status)}</td>
        <td>${esc(fmtDateTime(t.signed_at))}</td>
        <td class="right"><button class="btn small" data-ts="${t.id}">${mgr && t.status === 'submitted' ? 'Review' : 'View / Print'}</button></td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  function bindTimesheetButtons(el, list) {
    $$('[data-ts]', el).forEach((b) => {
      b.onclick = () => openTimesheet(list.find((t) => t.id === b.dataset.ts));
    });
  }

  // The printable form, laid out like the paper Deputies Daily Report
  function sheetHTML(t) {
    const sigOk = typeof t.signature_data === 'string' && t.signature_data.startsWith('data:image/png;base64,');
    const blankIfZero = (v) => Number(v) ? hrs(v) : '';
    const dayRows = periodDays(t.period_start).map((iso) => {
      const e = (t.entries || []).find((x) => x.date === iso) || {};
      return `<tr class="d">
        <td class="c-date">${esc(fmtShort(iso))}</td>
        <td class="c">${esc(e.in || '')}</td>
        <td class="c">${esc(e.out || '')}</td>
        <td class="c">${e.hours ? hrs(e.hours) : ''}</td>
        <td class="c-expl">${esc(e.explanation || '')}</td></tr>`;
    }).join('');
    const sumRow = (label, value, note, cls = '') =>
      `<tr class="s ${cls}"><th colspan="3">${esc(label)}</th><td class="c">${value}</td><td class="s-note">${esc(note)}</td></tr>`;
    const duties = dutyLines(t);
    const special = duties.filter((d) => d.hours > 0);
    const compact = duties.length > 3 ? ' compact' : '';

    return `<div class="sheet${compact}">
      <div class="sheet-head">
        <div class="org">${esc(ORG)}</div>
        <div class="title">${esc(REPORT_TITLE)}</div>
        <div class="emp">${esc(personName(t.user_id, t.signed_name).toUpperCase())}</div>
        ${special.length ? `<div class="special-flag">SPECIAL / GRANT OT: ${special.map((d) => `${esc(d.name)} ${hrs(d.hours)}`).join(' · ')}</div>` : ''}
      </div>
      <table class="sheet-table">
        <colgroup><col style="width:18%"><col style="width:9.5%"><col style="width:9.5%"><col style="width:11%"><col></colgroup>
        <thead><tr><th>Date</th><th>Time In</th><th>Time Out</th><th>Total Hours Worked</th><th>Explanation of Overtime or Absences</th></tr></thead>
        <tbody>
          ${dayRows}
          ${sumRow('Total Hours Worked', hrs(t.total_hours), 'This is the number of hours you actually worked.')}
          ${EXTRA_HOURS.map(([k, label, note]) => sumRow(label, blankIfZero(t[k]), note, k === 'sick_hours' ? 'tall' : '')).join('')}
          ${duties.map((d) => sumRow(d.label, blankIfZero(d.hours), d.note, d.hours > 0 ? 'duty hl' : 'duty')).join('')}
          ${sumRow('Total Hours To Be Paid', hrs(t.total_paid_hours), '')}
        </tbody>
      </table>
      <div class="sheet-sign">
        <div class="red">${esc(SIGN_STATEMENT)}</div>
        <div class="sig-line">
          <span class="red">Employee Signature:</span>
          <span class="sig-space">${sigOk ? `<img src="${t.signature_data}" alt="Signature of ${esc(t.signed_name)}">` : ''}</span>
        </div>
        <div class="sig-meta">Electronically signed by ${esc(t.signed_name)} on ${esc(fmtDateTime(t.signed_at))}</div>
      </div>
    </div>
    ${t.status === 'approved' && t.reviewed_at
      ? `<div class="sheet-after">Approved by ${esc(personName(t.reviewed_by, 'manager'))} on ${esc(fmtDateTime(t.reviewed_at))}${t.manager_note ? ` — ${esc(t.manager_note)}` : ''}</div>`
      : ''}`;
  }

  function reviewInfo(r) {
    if (!r.reviewed_at) return '';
    const by = personName(r.reviewed_by);
    return `<p class="muted">${esc(r.status[0].toUpperCase() + r.status.slice(1))}${by ? ` by ${esc(by)}` : ''} on ${esc(fmtDateTime(r.reviewed_at))}
      ${r.manager_note ? `<br>Manager note: ${esc(r.manager_note)}` : ''}</p>`;
  }

  function reviewControls(denyLabel) {
    return `<div class="review no-print">
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
    openModal(`
      <div class="modal-head no-print">
        <strong>${esc(personName(t.user_id, 'Employee'))}</strong> · ${esc(periodLabel(t.period_start))} ${badge(t.status)}
        ${t.status === 'rejected' && t.manager_note ? `<div class="muted">Sent back: ${esc(t.manager_note)}</div>` : ''}
      </div>
      <div class="print-area"><div class="sheet-page">${sheetHTML(t)}</div></div>
      ${canReview ? reviewControls('Send back') : ''}
      <div class="actions no-print"><button class="btn" id="print-btn">Print / Save PDF</button></div>`);
    $('#print-btn').onclick = () => window.print();
    if (canReview) bindReview('timesheets', t.id, 'rejected');
  }

  function openManySheets(list, title) {
    openModal(`
      <div class="modal-head no-print">
        <strong>${esc(title)}</strong> · ${list.length} timesheet${list.length === 1 ? '' : 's'}
        <div class="actions"><button class="btn primary" id="print-btn">Print all</button></div>
      </div>
      <div class="print-area">${list.map((t) => `<div class="sheet-page">${sheetHTML(t)}</div>`).join('')}</div>`);
    $('#print-btn').onclick = () => window.print();
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
      sb.from('timesheets').select('*').eq('status', 'submitted').order('period_start'),
      sb.from('time_off_requests').select('*').eq('status', 'pending').order('start_date'),
      sb.from('timesheets').select('*').neq('status', 'submitted').order('period_start', { ascending: false }).limit(25),
      sb.from('time_off_requests').select('*').neq('status', 'pending').order('start_date', { ascending: false }).limit(25)
    ]);
    for (const r of [ts, to, tsDone, toDone]) if (r.error) throw r.error;

    el.innerHTML = `
      <section class="card"><h2>Timesheets awaiting approval <span class="count">${ts.data.length}</span></h2>
        <div id="ts-pending">${timesheetTable(ts.data, true)}</div></section>
      <section class="card"><h2>Time off awaiting approval <span class="count">${to.data.length}</span></h2>
        <div id="to-pending">${timeOffTable(to.data, true)}</div></section>
      <section class="card"><h2>Payroll: print or export a pay period</h2>
        <form id="exp" class="row end">
          <label>Pay period${periodSelect('exp-period', previousPeriod())}</label>
          <label>Include<select id="exp-status"><option value="approved">Approved only</option><option value="all">All statuses</option></select></label>
          <label>CSV layout<select id="exp-layout"><option value="summary">One row per person</option><option value="daily">One row per day</option></select></label>
        </form>
        <div class="actions">
          <button class="btn primary" id="exp-print">Print all timesheets</button>
          <button class="btn" id="exp-csv">Download CSV</button>
        </div></section>
      <section class="card"><h2>Recent timesheets</h2><div id="ts-done">${timesheetTable(tsDone.data, true)}</div></section>
      <section class="card"><h2>Recent time off</h2><div id="to-done">${timeOffTable(toDone.data, true)}</div></section>`;

    bindTimesheetButtons($('#ts-pending'), ts.data);
    bindTimesheetButtons($('#ts-done'), tsDone.data);
    bindTimeOffButtons($('#to-pending'), to.data);
    bindTimeOffButtons($('#to-done'), toDone.data);

    async function fetchPeriod() {
      const p = $('#exp-period').value;
      let q = sb.from('timesheets').select('*').eq('period_start', p);
      if ($('#exp-status').value === 'approved') q = q.eq('status', 'approved');
      const { data, error } = await q;
      if (error) throw error;
      if (!data.length) throw new Error(`No ${$('#exp-status').value === 'approved' ? 'approved ' : ''}timesheets for ${periodLabel(p)}.`);
      data.sort((a, b) => personName(a.user_id).localeCompare(personName(b.user_id)));
      return { p, data };
    }

    $('#exp').onsubmit = (e) => e.preventDefault();
    $('#exp-print').onclick = (e) => withBusy(e.target, async () => {
      const { p, data } = await fetchPeriod();
      openManySheets(data, `Pay period ${periodLabel(p)}`);
    });
    $('#exp-csv').onclick = (e) => withBusy(e.target, async () => {
      const { p, data } = await fetchPeriod();
      const extraHeads = EXTRA_HOURS.map(([, label]) => label.replace(/^Total /, ''));
      const extraVals = (t) => EXTRA_HOURS.map(([k]) => Number(t[k] || 0));
      let rows;
      if ($('#exp-layout').value === 'summary') {
        // one column per special duty that shows up in this pay period
        const dutyNames = [...new Set(data.flatMap((t) => dutyLines(t).filter((d) => d.hours > 0).map((d) => d.name)))];
        rows = [['Employee', 'Email', 'Period start', 'Period end', 'Hours worked', ...extraHeads, ...dutyNames, 'Total to be paid', 'Status', 'Signed by', 'Signed at']];
        for (const t of data) {
          const lines = dutyLines(t);
          const dutyVals = dutyNames.map((n) => lines.filter((d) => d.name === n).reduce((a, d) => a + d.hours, 0));
          rows.push([personName(t.user_id), state.people[t.user_id]?.email || '', t.period_start, periodEnd(t.period_start),
            Number(t.total_hours), ...extraVals(t), ...dutyVals, Number(t.total_paid_hours), t.status, t.signed_name, t.signed_at]);
        }
      } else {
        rows = [['Employee', 'Email', 'Date', 'Time in', 'Time out', 'Hours', 'Explanation', 'Status']];
        for (const t of data) {
          for (const en of t.entries || []) {
            rows.push([personName(t.user_id), state.people[t.user_id]?.email || '', en.date,
              en.in, en.out, en.hours, en.explanation || '', t.status]);
          }
        }
      }
      downloadCSV(`timesheets_${p}_to_${periodEnd(p)}.csv`, rows);
    });
  };

  /* ---------------- manager: team & special duties ---------------- */
  views.team = async (el) => {
    const [people, duties, assigns] = await Promise.all([loadPeople(), loadDuties(), loadAssignments()]);
    const has = new Set(assigns.map((a) => `${a.user_id}|${a.duty_id}`));
    const active = duties.filter((d) => d.active);

    el.innerHTML = `
      <section class="card">
        <h2>Team</h2>
        <p class="muted">To add someone, invite them from your Supabase dashboard: <strong>Authentication → Users → Invite user</strong>. The name here is what prints at the top of their timesheet. Tick the special duties each person has — only those lines will show on their timesheet.</p>
        <div class="table-wrap"><table class="list team">
          <thead><tr><th>Name</th><th>Email</th><th>Special duties</th><th>Role</th><th></th></tr></thead>
          <tbody>${people.map((p) => `<tr data-id="${p.id}">
            <td><input class="p-name" value="${esc(p.full_name)}"></td>
            <td class="email">${esc(p.email)}</td>
            <td class="duty-checks">${active.length ? active.map((d) => d.everyone
              ? `<span class="chip muted-chip" title="Shown on everyone’s timesheet">${esc(d.name)} (all)</span>`
              : `<label class="chip-check"><input type="checkbox" data-duty="${d.id}" ${has.has(`${p.id}|${d.id}`) ? 'checked' : ''}><span>${esc(d.name)}</span></label>`).join('')
              : '<span class="muted">None set up</span>'}</td>
            <td><select class="p-role" ${p.id === me() ? 'disabled title="You can’t change your own role"' : ''}>
              <option value="employee" ${p.role === 'employee' ? 'selected' : ''}>Employee</option>
              <option value="manager" ${p.role === 'manager' ? 'selected' : ''}>Manager</option>
            </select></td>
            <td class="right"><button class="btn small p-save">Save</button></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </section>

      <section class="card">
        <h2>Special duties</h2>
        <p class="muted">Grant and automatic overtime lines such as K9, DEA or Supervisor. <strong>Timesheet line</strong> and <strong>Note</strong> print on the timesheet. <strong>Auto hours</strong> are filled in for the person each pay period (they can change them). <strong>Everyone</strong> shows the line on every timesheet. Turn off <strong>Active</strong> to retire a duty — past timesheets keep it.</p>
        <div class="table-wrap"><table class="list duties">
          <thead><tr><th>Short name</th><th>Timesheet line</th><th>Note</th><th>Auto hours</th><th>Everyone</th><th>Active</th><th></th></tr></thead>
          <tbody>
            ${duties.map((d) => dutyRow(d)).join('')}
            ${dutyRow({ id: '', name: '', label: '', note: '', default_hours: 0, everyone: false, active: true })}
          </tbody>
        </table></div>
      </section>`;

    $$('.p-save', el).forEach((b) => {
      b.onclick = () => {
        const tr = b.closest('tr');
        const id = tr.dataset.id;
        const update = { full_name: $('.p-name', tr).value.trim() };
        if (id !== me()) update.role = $('.p-role', tr).value;
        const checks = $$('input[data-duty]', tr);
        const add = checks.filter((c) => c.checked && !has.has(`${id}|${c.dataset.duty}`)).map((c) => c.dataset.duty);
        const remove = checks.filter((c) => !c.checked && has.has(`${id}|${c.dataset.duty}`)).map((c) => c.dataset.duty);
        withBusy(b, async () => {
          if (!update.full_name) throw new Error('Name can’t be empty.');
          const { error } = await sb.from('profiles').update(update).eq('id', id);
          if (error) throw error;
          if (add.length) {
            const r = await sb.from('profile_duties').insert(add.map((duty_id) => ({ user_id: id, duty_id })));
            if (r.error) throw r.error;
          }
          if (remove.length) {
            const r = await sb.from('profile_duties').delete().eq('user_id', id).in('duty_id', remove);
            if (r.error) throw r.error;
          }
          add.forEach((d) => has.add(`${id}|${d}`));
          remove.forEach((d) => has.delete(`${id}|${d}`));
          if (id === me()) state.profile.full_name = update.full_name;
          toast('Saved.');
          await loadPeople();
        });
      };
    });

    $$('.d-save', el).forEach((b) => {
      b.onclick = () => {
        const tr = b.closest('tr');
        const row = {
          name: $('.d-name', tr).value.trim(),
          label: $('.d-label', tr).value.trim(),
          note: $('.d-note', tr).value.trim(),
          default_hours: round2(num($('.d-default', tr).value)),
          everyone: $('.d-everyone', tr).checked,
          active: $('.d-active', tr).checked
        };
        withBusy(b, async () => {
          if (!row.name) throw new Error('Give the duty a short name, like K9.');
          if (!row.label) row.label = row.name + ' Hours';
          const res = tr.dataset.id
            ? await sb.from('duties').update(row).eq('id', tr.dataset.id)
            : await sb.from('duties').insert(row);
          if (res.error) throw res.error.code === '23505' ? new Error('There’s already a duty with that short name.') : res.error;
          toast(tr.dataset.id ? 'Duty saved.' : 'Duty added.');
          showView('team');
        });
      };
    });
  };

  function dutyRow(d) {
    return `<tr data-id="${esc(d.id)}" class="${d.id ? '' : 'new-duty'}">
      <td><input class="d-name" value="${esc(d.name)}" placeholder="${d.id ? '' : 'New, e.g. DEA'}"></td>
      <td><input class="d-label" value="${esc(d.label)}" placeholder="e.g. DEA Overtime Hours"></td>
      <td><input class="d-note" value="${esc(d.note)}" placeholder="Optional"></td>
      <td><input class="d-default" type="number" min="0" step="0.25" value="${Number(d.default_hours) || ''}" placeholder="0"></td>
      <td class="center"><input type="checkbox" class="d-everyone" ${d.everyone ? 'checked' : ''}></td>
      <td class="center"><input type="checkbox" class="d-active" ${d.active ? 'checked' : ''}></td>
      <td class="right"><button class="btn small ${d.id ? '' : 'primary'} d-save">${d.id ? 'Save' : 'Add'}</button></td>
    </tr>`;
  }
})();
