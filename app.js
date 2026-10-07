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
  // Which parts of the portal are on (FEATURES in config.js). Everything is on unless switched off,
  // e.g. the jail portal turns off case numbers, patrol stats and off-duty jobs.
  const FEATURES = { cases: true, stats: true, offduty: true, comp: true, uniforms: true, ...(cfg.FEATURES || {}) };
  const on = (f) => FEATURES[f] !== false;
  // Comp time: everyone (true), nobody (false), or only people ticked "Has comp time" on the Team tab ('ticked')
  const compPerPerson = FEATURES.comp === 'ticked';
  const hasComp = (p) => on('comp') && (!compPerPerson || !!p?.comp_time);
  const PORTAL_LABEL = cfg.PORTAL_LABEL || '';   // e.g. "Jail", shown next to the logo
  const PERIOD_DAYS = Number(cfg.PAY_PERIOD_DAYS) || 14;
  // The portal's first pay period (FIRST_PAY_PERIOD in config.js). Every pay period is counted
  // in PAY_PERIOD_DAYS steps from this date, and nothing earlier is offered.
  const FIRST_PERIOD = cfg.FIRST_PAY_PERIOD || '2026-10-01';
  const PERIOD_ANCHOR = FIRST_PERIOD;
  const LOGO = cfg.LOGO === undefined ? 'logo.png' : cfg.LOGO;   // '' = no logo
  // Logo image; hides itself if the file isn't there
  const logoImg = (cls) => LOGO
    ? `<img src="${esc(LOGO)}" alt="${esc(ORG)}" class="${cls}" onerror="this.remove()">`
    : '';

  // Invite and password-reset links land here with the link type in the URL hash.
  // Read it before supabase-js consumes and clears the hash.
  const linkType = new URLSearchParams(location.hash.slice(1)).get('type');
  let mustSetPassword = linkType === 'invite' || linkType === 'recovery';

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  const state = { session: null, profile: null, view: 'calendar', month: null, calMine: false, dir: {}, people: {}, duties: [], filterUser: '', cases: { year: null, q: '', page: 0 }, audit: { page: 0, actor: '', subject: '', area: '', from: '', to: '' } };
  let loadedUserId = null;

  const TIME_OFF_TYPES = [
    ['vacation', 'Vacation'], ['sick', 'Sick'], ['comp', 'Comp time used'], ['comp_earned', 'Comp time earned'],
    ['personal', 'Personal'], ['unpaid', 'Unpaid'], ['other', 'Other']   // older requests only
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
  const isOwner = () => isManager() && !!state.profile?.is_owner;   // site owner: set only from the Supabase SQL Editor
  // Time off is approved by managers ticked "Approves time off" on the Team tab (the sheriff and chief deputy).
  // If nobody is ticked, any manager can (the database applies the same rule).
  const timeOffApprovers = () => Object.values(state.people).filter((p) => p.role === 'manager' && p.active !== false && p.timeoff_approver);
  const canApproveTimeOff = () => isManager() && (!!state.profile?.timeoff_approver || !timeOffApprovers().length);
  // Only approvers (or the site owner) pick who approves, so other managers (e.g. clerks) can't give themselves approval
  const canSetApprovers = () => canApproveTimeOff() || isOwner();
  const approverNames = () => timeOffApprovers().map((p) => p.full_name || p.email).join(' or ');
  const round2 = (n) => Math.round(n * 100) / 100;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
  const hrs = (v) => String(Number(Number(v || 0).toFixed(2)));   // 12, 12.5, 0.5
  // "18:00" -> "6p", "06:30" -> "6:30a" (how times are written on the paper forms)
  const clock = (v) => { if (!v) return ''; const [h, m] = v.split(':').map(Number); return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 ? 'a' : 'p'}`; };

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
    // only real pay periods: on or after the first one and on the 14-day schedule
    const onSchedule = (p) => p >= FIRST_PERIOD && Math.round((parseDate(p) - parseDate(FIRST_PERIOD)) / 86400000) % PERIOD_DAYS === 0;
    const set = new Set(extra.filter(onSchedule));
    for (let i = ahead; i >= -back; i--) {
      const p = isoDate(addDays(cur, i * PERIOD_DAYS));
      if (p >= FIRST_PERIOD) set.add(p);
    }
    if (!set.size) set.add(FIRST_PERIOD);
    return [...set].sort().reverse();
  }
  const atLeastFirst = (p) => (p < FIRST_PERIOD ? FIRST_PERIOD : p);
  const currentPeriod = () => atLeastFirst(isoDate(periodStartFor(new Date())));
  const previousPeriod = () => atLeastFirst(isoDate(addDays(periodStartFor(new Date()), -PERIOD_DAYS)));
  const periodSelect = (id, selected, extra = []) =>
    `<select id="${id}">${periodOptions(extra).map((p) =>
      `<option value="${p}" ${p === selected ? 'selected' : ''}>${periodLabel(p)}${p === currentPeriod() ? ' (current)' : ''}</option>`).join('')}</select>`;

  function personName(id, fallback = '') {
    if (id === me()) return state.profile.full_name;
    return state.people[id]?.full_name || state.people[id]?.email || state.dir[id]?.full_name || fallback;
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

  // Copy each column's heading onto its cells so phones can show tables as cards
  function labelTables(root) {
    $$('table.list', root).forEach((t) => {
      const heads = $$('thead th', t).map((th) => th.textContent.trim());
      $$('tbody tr', t).forEach((tr) => {
        let i = 0;
        [...tr.children].forEach((td) => {
          if (!td.hasAttribute('data-label')) td.setAttribute('data-label', td.colSpan > 1 ? '' : (heads[i] || ''));
          i += td.colSpan || 1;
        });
      });
    });
  }

  function openModal(html) {
    $('#modal-body').innerHTML = html;
    labelTables($('#modal-body'));
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

  /* ---------------- auto sign-out when idle ---------------- */
  const IDLE_MS = (Number(cfg.IDLE_MINUTES) || 30) * 60000;
  const WARN_MS = Math.min(2 * 60000, IDLE_MS / 2);
  const IDLE_KEY = `portal_last_activity:${cfg.SUPABASE_URL}`;   // per portal (they share one web address)
  let idleOn = false, idleTimer = null, lastLocal = Date.now(), signedOutForIdle = false;
  const storeActivity = (t) => { try { localStorage.setItem(IDLE_KEY, String(t)); } catch (_) { /* private mode */ } };
  const lastActivity = () => { let t = lastLocal; try { t = Math.max(t, Number(localStorage.getItem(IDLE_KEY)) || 0); } catch (_) { /* ignore */ } return t; };
  function markActive() {
    const now = Date.now();
    if (now - lastLocal < 10000 && !$('#idle-warn')) return;   // don't write on every mouse move
    lastLocal = now; storeActivity(now);
    if ($('#idle-warn')) checkIdle();
  }
  function showIdleWarning(msLeft) {
    let w = $('#idle-warn');
    if (!w) {
      document.body.insertAdjacentHTML('beforeend', `<div id="idle-warn" class="idle-warn" role="alertdialog" aria-live="assertive">
        <div class="idle-box"><strong>Still there?</strong>
        <p>For security, you’ll be signed out in <span id="idle-left"></span> because of inactivity. Timesheets are saved as drafts; anything else you haven’t saved will be lost.</p>
        <button class="btn primary" id="idle-stay">Stay signed in</button></div></div>`);
      w = $('#idle-warn');
      $('#idle-stay').onclick = () => { lastLocal = Date.now(); storeActivity(lastLocal); hideIdleWarning(); };
    }
    const s = Math.max(0, Math.ceil(msLeft / 1000));
    $('#idle-left').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function hideIdleWarning() { $('#idle-warn')?.remove(); }
  function checkIdle() {
    if (!idleOn) return;
    const idle = Date.now() - lastActivity();
    if (idle >= IDLE_MS) { idleSignOut(); return; }
    if (idle >= IDLE_MS - WARN_MS) showIdleWarning(IDLE_MS - idle); else hideIdleWarning();
  }
  const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart', 'mousemove', 'wheel'];
  function startIdleWatch() {
    if (idleOn) return;
    idleOn = true; lastLocal = Date.now(); storeActivity(lastLocal);
    ACTIVITY_EVENTS.forEach((ev) => document.addEventListener(ev, markActive, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', checkIdle);   // phone waking up / tab coming back
    idleTimer = setInterval(checkIdle, 1000);
  }
  function stopIdleWatch() {
    idleOn = false; clearInterval(idleTimer); hideIdleWarning();
    ACTIVITY_EVENTS.forEach((ev) => document.removeEventListener(ev, markActive, { capture: true }));
    document.removeEventListener('visibilitychange', checkIdle);
  }
  async function idleSignOut() {
    stopIdleWatch(); closeModal(); signedOutForIdle = true;
    await sb.auth.signOut();
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
      stopIdleWatch();
      return renderLogin();
    }
    if (mustSetPassword) return renderSetPassword();
    if (loadedUserId === session.user.id) return; // token refresh etc.
    loadedUserId = session.user.id;
    try {
      await loadProfile();
      if (state.profile.active === false) return renderDeactivated();
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
    const { data, error } = await sb.from('profiles').select('*').order('full_name');
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
      ${logoImg('auth-logo')}
      <h1 class="auth-org">${esc(ORG)}</h1>
      ${PORTAL_LABEL ? `<p class="portal-label-auth">${esc(PORTAL_LABEL)} portal</p>` : ''}
      ${signedOutForIdle && !reset ? `<div class="notice">You were signed out after ${Math.round(IDLE_MS / 60000)} minutes of inactivity.</div>` : ''}
      <p class="muted">${reset ? 'Enter your email and we’ll send you a reset link.' : 'Sign in to your account.'}</p>
      <form id="auth-form">
        <label>Email<input type="email" name="email" required autocomplete="email"></label>
        ${reset ? '' : '<label>Password<input type="password" name="password" required autocomplete="current-password"></label>'}
        <button class="btn primary block" type="submit">${reset ? 'Send reset link' : 'Sign in'}</button>
      </form>
      <button class="btn-link" id="toggle-mode">${reset ? 'Back to sign in' : 'Forgot password?'}</button>
    </div></div>`;
    signedOutForIdle = false;
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
      ${logoImg('auth-logo')}
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

  function renderDeactivated() {
    app.innerHTML = `<div class="auth-wrap"><div class="card auth-card">
      ${logoImg('auth-logo')}
      <h1>Account deactivated</h1>
      <p class="muted">This account no longer has access to the employee portal. If you think this is a mistake, contact your supervisor.</p>
      <button class="btn block" id="so">Sign out</button>
    </div></div>`;
    $('#so').onclick = () => sb.auth.signOut();
  }

  function renderNameSetup() {
    app.innerHTML = `<div class="auth-wrap"><div class="card auth-card">
      ${logoImg('auth-logo')}
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

  /* ---------------- light / dark ---------------- */
  const THEME_KEY = 'portal_theme';
  const savedTheme = () => { try { const t = localStorage.getItem(THEME_KEY); return t === 'dark' || t === 'light' ? t : null; } catch (_) { return null; } };
  const deviceTheme = () => (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const currentTheme = () => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  function setTheme(t, save) {
    document.documentElement.setAttribute('data-theme', t);
    if (save) { try { localStorage.setItem(THEME_KEY, t); } catch (_) { /* private mode */ } }
    const b = $('#theme-toggle');
    if (b) {
      b.textContent = t === 'dark' ? '☀' : '☾';
      b.title = b.ariaLabel = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    }
  }
  function bindThemeToggle() {
    setTheme(currentTheme(), false);
    $('#theme-toggle').onclick = () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
  }
  // Set the theme right away (in case an older index.html without the early script is cached)
  setTheme(savedTheme() || deviceTheme(), false);
  // Until someone picks, follow the device as it switches between light and dark
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (!savedTheme()) setTheme(deviceTheme(), false); });

  /* ---------------- app shell ---------------- */
  const views = {};

  function renderShell() {
    const tabs = [['calendar', 'Calendar'], ['timesheets', 'My Timesheets'], ['timeoff', hasComp(state.profile) ? 'Time Off & Comp' : 'Time Off']];
    if (on('uniforms')) tabs.push(['uniforms', 'Uniforms']);
    if (on('cases')) tabs.push(['cases', 'Case Numbers']);
    if (on('stats') && canSeeStats()) tabs.push(['stats', 'Stats']);
    if (on('offduty')) tabs.push(['offduty', 'Off-Duty Jobs']);
    // Manager pages sit under one "Admin" drop-down
    const admin = [];
    if (isManager()) admin.push(['review', 'Approvals'], ['payroll', 'Payroll & History'], ['team', 'Team']);
    if (isOwner()) admin.push(['audit', 'Audit Log']);
    state.adminViews = admin.map(([k]) => k);
    if (![...tabs, ...admin].some(([k]) => k === state.view)) state.view = 'calendar';
    const tabBtn = ([k, l]) => `<button type="button" data-view="${k}" data-label="${esc(l)}">${esc(l)}${k === 'review' ? ' <span class="count tab-count" hidden></span>' : ''}</button>`;

    app.innerHTML = `
      <header class="topbar">
        <div class="brand">${logoImg('brand-logo')}<span>${esc(ORG)}</span>${PORTAL_LABEL ? `<b class="portal-label">${esc(PORTAL_LABEL)}</b>` : ''}</div>
        <div class="user">
          <span>${esc(state.profile.full_name)}</span>
          <span class="role">${esc(state.profile.role)}</span>
          <button id="theme-toggle" class="theme-toggle" type="button"></button>
          <button id="signout" class="btn-link light">Sign out</button>
        </div>
      </header>
      <div class="tabs-wrap">
        <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="main-nav">
          <span class="menu-icon" aria-hidden="true">☰</span><span class="menu-current"></span><span class="menu-caret" aria-hidden="true">▾</span>
        </button>
        <nav class="tabs" id="main-nav">${tabs.map(tabBtn).join('')}
          ${admin.length ? `<div class="tab-group">
            <button type="button" class="tab-group-toggle" aria-expanded="false" aria-haspopup="true">Admin <span class="count tab-count" hidden></span> <span class="tab-caret" aria-hidden="true">▾</span></button>
            <div class="tab-group-label">Admin</div>
            <div class="tab-drop">${admin.map(tabBtn).join('')}${cfg.OTHER_PORTAL?.url ? `<a class="tab-link" href="${esc(cfg.OTHER_PORTAL.url)}">${esc(cfg.OTHER_PORTAL.label || 'Other portal')} ↗</a>` : ''}</div>
          </div>` : ''}</nav>
      </div>
      <div id="due" class="due-wrap"></div>
      <main id="view"></main>`;
    $('#signout').onclick = () => sb.auth.signOut();
    bindThemeToggle();
    startIdleWatch();
    $$('.tabs button[data-view]').forEach((b) => { b.onclick = () => { setMenuOpen(false); setAdminOpen(false); showView(b.dataset.view); }; });
    $('.tab-group-toggle')?.addEventListener('click', () => setAdminOpen(!$('.tab-group').classList.contains('open')));
    $('.menu-toggle').onclick = () => setMenuOpen(!$('.tabs-wrap').classList.contains('open'));
    showView(state.view);
  }

  // Phone menu: the tab list drops down from the menu button; tap outside or Esc closes it
  function setMenuOpen(open) {
    const wrap = $('.tabs-wrap');
    if (!wrap) return;
    wrap.classList.toggle('open', open);
    wrap.querySelector('.menu-toggle').setAttribute('aria-expanded', open);
  }
  // Computer: the Admin tab opens a small drop-down of the manager pages
  function setAdminOpen(open) {
    const g = $('.tab-group');
    if (!g) return;
    g.classList.toggle('open', open);
    $('.tab-group-toggle', g).setAttribute('aria-expanded', open);
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.tabs-wrap')) setMenuOpen(false);
    if (!e.target.closest('.tab-group')) setAdminOpen(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMenuOpen(false); setAdminOpen(false); } });

  // How many things are waiting on this manager (shown on Admin and Approvals)
  async function refreshAdminCount() {
    if (!isManager() || !$('.tab-count')) return;
    const [ts, to] = await Promise.all([
      sb.from('timesheets').select('id', { count: 'exact', head: true }).eq('status', 'submitted'),
      canApproveTimeOff() ? sb.from('time_off_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending') : { count: 0 },
      on('uniforms') && canApproveTimeOff() ? sb.from('uniform_orders').select('id', { count: 'exact', head: true }).eq('status', 'pending') : { count: 0 }
    ]).then((r) => [r[0], { count: (r[1].count || 0) + (r[2].count || 0), error: r[1].error || r[2].error }]);
    if (ts.error || to.error) return;
    const n = (ts.count || 0) + (to.count || 0);
    $$('.tab-count').forEach((c) => { c.textContent = n; c.hidden = !n; });
  }

  // Save any timesheet draft that's waiting when the page is hidden or closed
  document.addEventListener('visibilitychange', () => { if (document.hidden) state.flushDraft?.(); });

  // Banner until submitted: last pay period's timesheet, and the current one on its last day.
  // Only on the Calendar and My Timesheets, so the other pages stay clean.
  async function refreshDue() {
    const box = $('#due');
    if (!box) return;
    if (!['calendar', 'timesheets'].includes(state.view)) { box.innerHTML = ''; return; }
    const cur = currentPeriod(), prev = previousPeriod();
    const joined = state.profile.created_at ? isoDate(new Date(state.profile.created_at)) : '';
    const want = [];
    if (prev !== cur && periodEnd(prev) >= joined) want.push(prev);
    if (periodEnd(cur) === isoDate(new Date())) want.push(cur);
    if (!want.length) { box.innerHTML = ''; return; }
    const { data, error } = await sb.from('timesheets').select('period_start, status').eq('user_id', me()).in('period_start', want);
    if (error || !['calendar', 'timesheets'].includes(state.view)) return;   // moved to another page meanwhile
    const status = Object.fromEntries(data.map((t) => [t.period_start, t.status]));
    box.innerHTML = want.filter((p) => !['submitted', 'approved'].includes(status[p])).map((p) => `<div class="notice warn due"><span>
      ${status[p] === 'rejected' ? `Your timesheet for <strong>${esc(periodLabel(p))}</strong> was sent back and needs to be resubmitted.`
        : p === cur ? `Today is the last day of the pay period. Your timesheet for <strong>${esc(periodLabel(p))}</strong> is due.`
        : `Your timesheet for <strong>${esc(periodLabel(p))}</strong> hasn’t been submitted.`}</span>
      <button class="btn small primary" type="button" data-due="${p}">Fill it out</button></div>`).join('');
    $$('[data-due]', box).forEach((b) => { b.onclick = () => { state.tsPeriod = b.dataset.due; showView('timesheets'); }; });
  }

  async function showView(v) {
    state.flushDraft?.();
    state.view = v;
    refreshDue();
    $$('.tabs button[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    $('.tab-group-toggle')?.classList.toggle('active', (state.adminViews || []).includes(v));
    const cur = $('.menu-current');
    if (cur) cur.textContent = $('.tabs button[data-view].active')?.dataset.label || '';
    refreshAdminCount();
    const el = $('#view');
    el.innerHTML = '<div class="loading">Loading…</div>';
    try { await views[v](el); labelTables(el); }
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

  // Times are kept in 15-minute steps: 00:00, 00:15 … 23:45
  const HALF_HOURS = [...Array(96)].map((_, i) => {
    const h = Math.floor(i / 4), m = String((i % 4) * 15).padStart(2, '0');
    const v = `${String(h).padStart(2, '0')}:${m}`;
    return [v, clock(v)];
  });
  const isHalfHourTime = (v) => /^([01]\d|2[0-3]):(00|15|30|45)$/.test(v);
  const isHalfStep = (n) => Math.abs(n * 4 - Math.round(n * 4)) < 1e-9;   // quarter hours
  // Usual hours: the person's normal shift, offered at the top of the Time in / Time out lists
  const USUAL_PRESETS = [['07:00', '19:00'], ['19:00', '07:00'], ['13:00', '01:00'], ['08:00', '16:00'], ['08:00', '18:00'], ['07:00', '17:00']];
  const shiftText = (i, o) => `${clock(i)}–${clock(o)}`;
  const hasUsual = () => !!(state.profile?.usual_in && state.profile?.usual_out);
  function usualOption(cls) {
    if (!hasUsual()) return '';
    const p = state.profile;
    return cls === 't-in'
      ? `<option value="usual">★ ${esc(shiftText(p.usual_in, p.usual_out))} (usual)</option>`
      : `<option value="usual">★ ${esc(clock(p.usual_out))} (usual)</option>`;
  }
  function timeSelect(cls, value, label, usual = false) {
    const extra = value && !isHalfHourTime(value) ? `<option value="${esc(value)}" selected>${esc(value)} (fix)</option>` : '';
    return `<select class="${cls}" aria-label="${label}"><option value=""></option>${usual ? usualOption(cls) : ''}${extra}${HALF_HOURS.map(([v, l]) =>
      `<option value="${v}" ${v === value ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  }
  // A preset list (plus Custom…) for choosing someone's usual hours
  function usualPicker(inV, outV) {
    const cur = inV && outV ? `${inV}-${outV}` : '';
    const isPreset = USUAL_PRESETS.some(([a, b]) => `${a}-${b}` === cur);
    return `<span class="usual-picker">
      <select class="usual-preset" aria-label="Usual hours">
        <option value="">None</option>
        ${USUAL_PRESETS.map(([a, b]) => `<option value="${a}-${b}" ${cur === `${a}-${b}` ? 'selected' : ''}>${esc(shiftText(a, b))}</option>`).join('')}
        <option value="custom" ${cur && !isPreset ? 'selected' : ''}>${cur && !isPreset ? esc(shiftText(inV, outV)) + ' (custom)' : 'Custom…'}</option>
      </select>
      <span class="usual-custom" ${cur && !isPreset ? '' : 'hidden'}>
        ${timeSelect('u-in', cur && !isPreset ? inV : '', 'Usual time in')}<span>to</span>${timeSelect('u-out', cur && !isPreset ? outV : '', 'Usual time out')}
      </span>
    </span>`;
  }
  function bindUsualPicker(root, onChange) {
    const sel = $('.usual-preset', root), custom = $('.usual-custom', root);
    sel.addEventListener('change', () => { custom.hidden = sel.value !== 'custom'; if (sel.value !== 'custom') onChange?.(); });
    $$('.usual-custom select', root).forEach((x) => x.addEventListener('change', () => onChange?.()));
  }
  function readUsualPicker(root) {
    const v = $('.usual-preset', root).value;
    if (!v) return { usual_in: null, usual_out: null };
    if (v !== 'custom') { const [a, b] = v.split('-'); return { usual_in: a, usual_out: b }; }
    const a = $('.u-in', root).value, b = $('.u-out', root).value;
    if (!a || !b) return null;   // custom, not finished yet
    if (a === b) throw new Error('Usual time in and time out can’t be the same.');
    return { usual_in: a, usual_out: b };
  }

  // One row per block of time. A day can have several blocks (e.g. regular shift + Traffic OT).
  let segDuties = [];   // special duties this person can mark a block with
  function typeSelect(value) {
    if (!segDuties.length && !value) return '';
    const known = segDuties.some((d) => d.id === value);
    const extra = value && !known ? `<option value="${esc(value)}" selected>${esc(state.duties.find((d) => d.id === value)?.name || 'Special')}</option>` : '';
    return `<select class="t-type" aria-label="Type of time"><option value="">Regular</option>${extra}${segDuties.map((d) =>
      `<option value="${d.id}" ${d.id === value ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>`;
  }
  const monthDay = (iso) => { const d = parseDate(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
  function segRow(iso, e = {}, first = true) {
    return `<tr class="seg ${first ? 'seg-first' : 'seg-extra'}" data-date="${iso}" data-label="${esc(fmtShort(iso))}">
      <td class="day">${first
        ? `<span class="d-date"><span class="d-wd">${esc(fmtDay(iso))}</span> <strong>${esc(monthDay(iso))}</strong></span><button type="button" class="add-seg" title="Add another block of time on this day" aria-label="Add time on ${esc(fmtShort(iso))}">+</button>`
        : `<span class="seg-more">↳ more</span><button type="button" class="del-seg" title="Remove this block of time" aria-label="Remove this time">✕</button>`}</td>
      <td>${timeSelect('t-in', e.in || '', 'Time in', true)}</td>
      <td>${timeSelect('t-out', e.out || '', 'Time out', true)}</td>
      <td class="num t-hours"></td>
      <td class="note-cell"><button type="button" class="note-btn" title="Add a note" aria-label="Add a note for ${esc(fmtShort(iso))}">✎</button></td>
      <td class="expl-cell"><div class="expl-wrap">${typeSelect(e.duty_id || '')}<input class="t-expl" value="${esc(e.explanation || '')}" placeholder="Explanation (OT, absence…)" aria-label="Explanation"></div></td>
    </tr>`;
  }
  function buildRows(start, entries = []) {
    $('#ts-rows').innerHTML = periodDays(start).map((iso) => {
      const segs = entries.filter((x) => x.date === iso);
      return (segs.length ? segs : [{}]).map((e, i) => segRow(iso, e, i === 0)).join('');
    }).join('');
  }
  function segMinutes(i, o) {
    const [ih, im] = i.split(':').map(Number), [oh, om] = o.split(':').map(Number);
    const s = ih * 60 + im; let e = oh * 60 + om; if (e <= s) e += 1440;
    return [s, e];
  }

  function readExtras() {
    return Object.fromEntries(EXTRA_HOURS.map(([k]) => [k, round2(num($(`#x-${k}`).value))]));
  }

  function readDuties() {
    return $$('.duty-input').map((i) => ({ duty_id: i.dataset.duty, hours: round2(num(i.value)) }));
  }

  function recalc() {
    let worked = 0;
    const fromTimes = {};   // duty id -> hours from blocks marked with it
    $$('#ts-rows tr').forEach((tr) => {
      const h = calcHours($('.t-in', tr).value, $('.t-out', tr).value);
      const type = $('.t-type', tr)?.value || '';
      $('.t-hours', tr).textContent = h ? hrs(h) : '';
      tr.classList.toggle('is-duty', !!type);
      // on a phone the note box stays tucked away until it's needed
      if (type || $('.t-expl', tr).value) tr.classList.add('note-open');
      if (type) fromTimes[type] = (fromTimes[type] || 0) + round2(h);
      else worked += round2(h);
    });
    // A duty line with time blocks is filled in from those blocks
    $$('.duty-input').forEach((i) => {
      const auto = Object.prototype.hasOwnProperty.call(fromTimes, i.dataset.duty);
      if (auto) i.value = fromTimes[i.dataset.duty] || '';
      i.readOnly = auto;
      i.closest('tr').classList.toggle('from-times', auto);
    });
    const x = readExtras();
    // lines that aren't paid (e.g. Comp Time Earned) print but don't count toward hours to be paid
    const special = readDuties().filter((d) => $(`#d-${d.duty_id}`)?.dataset.paid !== 'false').reduce((a, d) => a + d.hours, 0);
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

  const TS_RECENT = 4;   // how many past timesheets to list before "Show all"
  views.timesheets = async (el) => {
    const [{ data: mine, error }, , assigned, dr] = await Promise.all([
      sb.from('timesheets').select('*').eq('user_id', me()).order('period_start', { ascending: false }),
      loadDuties(),
      loadAssignments(me()),
      sb.from('timesheet_drafts').select('period_start, data, updated_at')
    ]);
    if (error) throw error;
    const myIds = new Set(assigned.map((a) => a.duty_id));
    const myDuties = state.duties.filter((d) => d.active && (d.everyone || myIds.has(d.id)));
    // Paid holidays on the calendar (for pre-filling Holiday Hours)
    const opts = periodOptions(mine.map((t) => t.period_start));
    const hol = await sb.from('events').select('title, starts_at, holiday_hours').eq('kind', 'holiday')
      .gte('starts_at', new Date(`${opts[opts.length - 1]}T00:00`).toISOString())
      .lt('starts_at', new Date(`${periodEnd(opts[0])}T23:59`).toISOString());
    const holidays = (hol.error ? [] : hol.data).map((h) => ({ ...h, date: isoDate(new Date(h.starts_at)), hours: Number(h.holiday_hours ?? 8) }));
    const holidaysIn = (p) => { const days = new Set(periodDays(p)); return holidays.filter((h) => days.has(h.date)); };
    segDuties = myDuties;

    el.innerHTML = `
      <section class="card">
        <h2>Submit a timesheet</h2>
        <form id="ts-form" autocomplete="off">
          <div class="row">
            <label>Pay period${periodSelect('ts-period', state.tsPeriod || currentPeriod(), mine.map((t) => t.period_start))}</label>
          </div>
          <div class="usual-bar" id="ts-usual"><span class="usual-label">My usual hours</span>${usualPicker(state.profile.usual_in, state.profile.usual_out)}
            <span class="hint" id="ts-usual-hint">${hasUsual() ? 'Pick <strong>★</strong> in a Time in list to fill in your usual shift.' : 'Your usual shift will show at the top of each Time in list.'}</span></div>
          <div id="ts-status" class="notice hidden"></div>
          <div id="ts-draft-note" class="notice hidden"></div>
          <div id="ts-holiday" class="notice holiday-note hidden"></div>
          <div class="table-wrap"><table class="grid entry">
            <thead><tr><th>Date</th><th>Time in</th><th>Time out</th><th class="num">Hours</th><th>Explanation of overtime or absences</th></tr></thead>
            <tbody id="ts-rows"></tbody>
          </table></div>
          <p class="hint">Tap <strong>+</strong> by a date to add another block of time${segDuties.length ? ' (e.g. Traffic OT)' : ''}. Overnight shifts work automatically.</p>

          <div class="table-wrap"><table class="grid extras">
            <tbody>
              <tr class="total"><th>Total Hours Worked</th><td class="num" id="ts-total">0</td><td class="hint"></td></tr>
              ${EXTRA_HOURS.map(([k, label, hint]) => `<tr>
                <th><label for="x-${k}">${esc(label)}</label></th>
                <td><input type="number" id="x-${k}" min="0" step="0.25" placeholder="0" inputmode="decimal"></td>
                <td class="hint">${esc(hint)}</td></tr>`).join('')}
              ${myDuties.map((d) => `<tr class="duty-row${d.paid === false ? ' unpaid' : ''}">
                <th><label for="d-${d.id}">${esc(d.label)}</label> <span class="chip">${esc(d.name)}</span></th>
                <td><input type="number" id="d-${d.id}" class="duty-input" data-duty="${d.id}" data-paid="${d.paid === false ? 'false' : 'true'}" min="0" step="0.25" placeholder="0" inputmode="decimal"></td>
                <td class="hint">${esc(d.note)}${d.paid === false && !/not added/i.test(d.note || '') ? ' <em>Not added to Hours To Be Paid.</em>' : ''}<span class="auto-note">Filled in from your ${esc(d.name)} time blocks above.</span></td></tr>`).join('')}
              <tr class="total"><th>Total Hours To Be Paid</th><td class="num" id="ts-paid">0</td><td></td></tr>
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
          <div class="row submit-row"><button class="btn primary" type="submit" id="ts-submit">Sign &amp; submit</button>
            <span class="hint" id="ts-draft" aria-live="polite"></span></div>
        </form>
      </section>
      <section class="card"><h2>My timesheets <span class="count muted-count">${mine.length}</span></h2>
        <div id="ts-list">${timesheetTable(mine.slice(0, TS_RECENT), false)}</div>
        ${mine.length > TS_RECENT ? `<button class="btn small" type="button" id="ts-all">Show all ${mine.length}</button>` : ''}
      </section>`;

    bindTimesheetButtons(el, mine);
    state.tsPeriod = null;   // a banner's "Fill it out" picks the period once
    $('#ts-all')?.addEventListener('click', (e) => {
      $('#ts-list').innerHTML = timesheetTable(mine, false);
      labelTables($('#ts-list'));
      bindTimesheetButtons($('#ts-list'), mine);
      e.target.remove();
    });
    const pad = createSignaturePad($('#sig'));
    $('#sig-clear').onclick = () => pad.clear();
    // ★ usual: fill in the person's usual shift (both times from Time in; just the end from Time out)
    const applyUsual = (e) => {
      const sel = e.target;
      if (sel.value !== 'usual' || !hasUsual()) return;
      const tr = sel.closest('tr');
      if (sel.classList.contains('t-in')) {
        $('.t-in', tr).value = state.profile.usual_in;
        $('.t-out', tr).value = state.profile.usual_out;
      } else {
        sel.value = state.profile.usual_out;
      }
    };
    $('#ts-rows').addEventListener('input', applyUsual);
    $('#ts-rows').addEventListener('change', applyUsual);
    const isTimeField = (t) => !t.closest('.sign') && !t.closest('#ts-usual') && t.id !== 'ts-period';
    $('#ts-form').addEventListener('input', (e) => { if (isTimeField(e.target)) { recalc(); queueDraft(); } });
    $('#ts-form').addEventListener('change', (e) => { if (isTimeField(e.target)) queueDraft(); });
    bindUsualPicker($('#ts-usual'), async () => {
      try {
        const u = readUsualPicker($('#ts-usual'));
        if (!u) return;
        const { error } = await sb.from('profiles').update(u).eq('id', me());
        if (error) throw error;
        Object.assign(state.profile, u);
        // refresh the ★ choice at the top of every time list
        $$('#ts-rows select.t-in, #ts-rows select.t-out').forEach((x) => {
          $('option[value="usual"]', x)?.remove();
          if (hasUsual()) x.options[0].insertAdjacentHTML('afterend', usualOption(x.classList.contains('t-in') ? 't-in' : 't-out'));
        });
        $('#ts-usual-hint').innerHTML = hasUsual() ? 'Saved. Pick <strong>★</strong> at the top of a day’s Time in list to fill in your usual shift.' : 'Usual hours cleared.';
      } catch (err) { toast(err.message || String(err), true); }
    });
    $('#ts-rows').addEventListener('click', (e) => {
      const add = e.target.closest('.add-seg'), del = e.target.closest('.del-seg'), note = e.target.closest('.note-btn');
      if (note) {
        const tr = note.closest('tr');
        tr.classList.add('note-open');
        $('.t-expl', tr).focus();
      } else if (add) {
        const iso = add.closest('tr').dataset.date;
        const rowsOfDay = $$(`#ts-rows tr[data-date="${iso}"]`);
        const prev = rowsOfDay[rowsOfDay.length - 1];
        prev.insertAdjacentHTML('afterend', segRow(iso, { in: $('.t-out', prev).value || '' }, false));
        prev.nextElementSibling.querySelector('.t-out').focus();
        recalc();
        queueDraft();
      } else if (del) {
        del.closest('tr').remove();
        recalc();
        queueDraft();
      }
    });

    const periodInput = $('#ts-period');
    let existing = null;

    // Drafts: the form is saved as you type (not the signature), so nothing is lost if you're
    // signed out, close the page or switch devices. Deleted once the timesheet is submitted.
    const drafts = {};
    if (!dr.error) dr.data.forEach((r) => { drafts[r.period_start] = r; });   // no drafts table yet: carry on without
    let draftTimer = null, draftPeriod = null, draftSaving = Promise.resolve();
    const readDraft = () => ({
      entries: $$('#ts-rows tr').map((tr) => ({
        date: tr.dataset.date, in: $('.t-in', tr).value, out: $('.t-out', tr).value,
        explanation: $('.t-expl', tr).value, duty_id: $('.t-type', tr)?.value || ''
      })).filter((x) => x.in || x.out || x.explanation.trim() || x.duty_id),
      extras: Object.fromEntries(EXTRA_HOURS.map(([k]) => [k, $(`#x-${k}`).value])),
      duties: Object.fromEntries($$('.duty-input').map((i) => [i.dataset.duty, i.value]))
    });
    const draftState = (t) => { const x = $('#ts-draft'); if (x) x.textContent = t; };
    function queueDraft() {
      draftPeriod = periodInput.value;
      clearTimeout(draftTimer);
      draftTimer = setTimeout(flushDraft, 1200);
      draftState('Saving draft…');
    }
    function flushDraft() {
      clearTimeout(draftTimer);
      const p = draftPeriod;
      if (!p || !$('#ts-form')) return;
      draftPeriod = null;
      const data = readDraft();
      draftSaving = (async () => {
        const { data: row, error: err } = await sb.from('timesheet_drafts')
          .upsert({ user_id: me(), period_start: p, data }).select('period_start, data, updated_at').single();
        if (err) { draftState(''); return; }   // a draft is a convenience: never get in the way of the form
        drafts[p] = row;
        if (periodInput.value === p) draftState(`Draft saved ${fmtTime(row.updated_at)}`);
      })();
    }
    async function discardDraft(p) {
      clearTimeout(draftTimer);
      if (draftPeriod === p) draftPeriod = null;
      await draftSaving;
      delete drafts[p];
      await sb.from('timesheet_drafts').delete().eq('user_id', me()).eq('period_start', p);
    }
    state.flushDraft = flushDraft;

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
      // Paid holidays in this pay period
      const hs = holidaysIn(p), holNote = $('#ts-holiday');
      const holTotal = hs.reduce((s, h) => s + h.hours, 0);
      const holList = hs.map((h) => `${esc(h.title)} (${esc(fmtShort(h.date))}, ${hrs(h.hours)} hrs)`).join(', ');
      holNote.classList.toggle('hidden', !hs.length);
      if (hs.length && !existing) {
        $('#x-holiday_hours').value = holTotal || '';
        hs.forEach((h) => {
          const expl = $(`#ts-rows tr[data-date="${h.date}"] .t-expl`);
          if (expl && !expl.value) expl.value = `Holiday: ${h.title}`;
        });
        holNote.innerHTML = `🗓️ Paid holiday this pay period: ${holList}. <strong>${hrs(holTotal)} hours</strong> were added to Total Holiday Hours. Change it if your holiday pay is different.`;
      } else if (hs.length) {
        holNote.innerHTML = `🗓️ Paid holiday this pay period: ${holList}.${Number(existing.holiday_hours) !== holTotal ? ` Your timesheet has ${hrs(existing.holiday_hours)} holiday hours.` : ''}`;
      }
      myDuties.forEach((d) => {
        const saved = existing ? (existing.duty_hours || []).find((x) => x.duty_id === d.id) : null;
        const v = existing ? Number(saved?.hours) || 0 : Number(d.default_hours) || 0;  // new sheet: pre-fill automatic hours
        $(`#d-${d.id}`).value = v ? v : '';
      });
      // An unsubmitted draft newer than what was signed takes over the form
      const draft = drafts[p], draftNote = $('#ts-draft-note');
      draftNote.className = 'notice hidden';
      draftState('');
      if (draft && (existing?.status === 'approved' || (existing && new Date(draft.updated_at) <= new Date(existing.signed_at)))) {
        discardDraft(p);   // already signed or locked since it was saved
      } else if (draft) {
        const d = draft.data || {};
        buildRows(p, d.entries || []);
        EXTRA_HOURS.forEach(([k]) => { $(`#x-${k}`).value = d.extras?.[k] ?? ''; });
        $$('.duty-input').forEach((i) => { i.value = d.duties?.[i.dataset.duty] ?? ''; });
        draftNote.className = 'notice';
        draftNote.innerHTML = `Picked up where you left off (saved ${esc(fmtShort(isoDate(new Date(draft.updated_at))))} at ${esc(fmtTime(draft.updated_at))}).
          ${existing ? 'Your submitted timesheet hasn’t changed. These edits only count once you sign and submit again.' : 'Sign and submit when you’re done.'}
          <button type="button" class="btn-link" id="ts-discard">${existing ? 'Discard these edits' : 'Start over'}</button>`;
        $('#ts-discard').onclick = async () => {
          if (!confirm(existing ? 'Discard your unsubmitted edits and go back to the timesheet you submitted?' : 'Clear this timesheet and start over?')) return;
          await discardDraft(p);
          loadPeriod();
        };
      }
      recalc();
    };
    loadPeriod();
    periodInput.onchange = () => { flushDraft(); loadPeriod(); };

    $('#ts-form').onsubmit = (e) => {
      e.preventDefault();
      withBusy($('#ts-submit'), async () => {
        const entries = [];
        const blocksByDay = {};
        for (const tr of $$('#ts-rows tr')) {
          const i = $('.t-in', tr).value, o = $('.t-out', tr).value;
          const expl = $('.t-expl', tr).value.trim();
          const type = $('.t-type', tr)?.value || '';
          if ((i && !o) || (!i && o)) throw new Error(`Enter both time in and time out for ${tr.dataset.label}.`);
          if ((i && !isHalfHourTime(i)) || (o && !isHalfHourTime(o))) throw new Error(`Times must be in 15-minute steps (:00, :15, :30 or :45) — check ${tr.dataset.label}.`);
          if (!i && !expl) continue;
          if (!i && type) throw new Error(`Add times for the ${segDuties.find((d) => d.id === type)?.name || 'special'} block on ${tr.dataset.label}.`);
          const entry = { date: tr.dataset.date, in: i, out: o, hours: round2(calcHours(i, o)), explanation: expl };
          if (type) entry.duty_id = type;
          entries.push(entry);
          if (i) (blocksByDay[tr.dataset.date] ||= []).push({ label: tr.dataset.label, m: segMinutes(i, o) });
        }
        for (const blocks of Object.values(blocksByDay)) {
          blocks.sort((p, q) => p.m[0] - q.m[0]);
          for (let k = 1; k < blocks.length; k++) {
            if (blocks[k].m[0] < blocks[k - 1].m[1]) throw new Error(`Two time blocks overlap on ${blocks[k].label}. Check the times.`);
          }
        }
        const extras = readExtras();
        const duty_hours = readDuties();
        const badExtra = EXTRA_HOURS.find(([k]) => !isHalfStep(extras[k]));
        if (badExtra) throw new Error(`${badExtra[1]} must be in quarter-hour steps (for example 4, 4.25 or 4.5).`);
        const badDuty = duty_hours.find((d) => !isHalfStep(d.hours));
        if (badDuty) throw new Error(`${state.duties.find((x) => x.id === badDuty.duty_id)?.label || 'Special duty hours'} must be in quarter-hour steps (for example 4, 4.25 or 4.5).`);
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
        await discardDraft(row.period_start);
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
    const dutyName = (id) => (t.duty_hours || []).find((d) => d.duty_id === id)?.name || state.duties.find((d) => d.id === id)?.name || 'Special';
    const dayRows = periodDays(t.period_start).map((iso) => {
      const segs = (t.entries || []).filter((x) => x.date === iso);
      const timed = segs.filter((x) => x.in);
      const lines = (f) => timed.map(f).join('<br>');
      const expl = segs.map((x) => {
        const tag = x.duty_id ? `<strong>${esc(dutyName(x.duty_id))}${x.in ? ` ${esc(clock(x.in))}–${esc(clock(x.out))}` : ''}</strong>` : '';
        return [tag, esc(x.explanation || '')].filter(Boolean).join(' — ');
      }).filter(Boolean).join('; ');
      return `<tr class="d ${timed.length > 1 ? 'multi' : ''}">
        <td class="c-date">${esc(fmtShort(iso))}</td>
        <td class="c">${lines((x) => esc(clock(x.in)))}</td>
        <td class="c">${lines((x) => esc(clock(x.out)))}</td>
        <td class="c">${lines((x) => (x.duty_id ? `<span class="seg-duty">${hrs(x.hours)}*</span>` : hrs(x.hours)))}</td>
        <td class="c-expl">${expl}</td></tr>`;
    }).join('');
    const hasDutyBlocks = (t.entries || []).some((x) => x.duty_id);
    const sumRow = (label, value, note, cls = '') =>
      `<tr class="s ${cls}"><th colspan="3">${esc(label)}</th><td class="c">${value}</td><td class="s-note">${esc(note)}</td></tr>`;
    const duties = dutyLines(t);
    const special = duties.filter((d) => d.hours > 0);
    const extraLines = duties.length + (special.length ? 1 : 0) + (hasDutyBlocks ? 1 : 0);
    const compact = extraLines > 5 ? ' compact tight' : extraLines > 3 ? ' compact' : '';

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
      ${hasDutyBlocks ? '<div class="sheet-foot">* Special-duty hours (shown in the explanation). They are totaled on their own line above, not in Total Hours Worked.</div>' : ''}
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
      if (table === 'time_off_requests') notify('timeoff_decision', id);
      else if (status === 'rejected') notify('timesheet_returned', id);
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
  // What people can ask for now (older requests may have other types; typeLabel still names them)
  const requestTypes = () => [['vacation', 'Vacation'], ['sick', 'Sick'], ['comp', 'Comp time (use)']].filter(([k]) => k !== 'comp' || hasComp(state.profile));
  const isComp = (t) => t === 'comp' || t === 'comp_earned';
  const hoursText = (r) => r.hours == null
    ? `${dayCount(r.start_date, r.end_date)} day${dayCount(r.start_date, r.end_date) > 1 ? 's' : ''}`
    : `${r.type === 'comp_earned' ? '+' : r.type === 'comp' ? '−' : ''}${hrs(r.hours)} hrs`;
  async function compBalances() {
    const { data, error } = await sb.rpc('comp_balances');
    if (error) throw error;
    return data || [];
  }

  views.timeoff = async (el) => {
    const [reqs, bals, adj] = await Promise.all([
      sb.from('time_off_requests').select('*').eq('user_id', me()).order('start_date', { ascending: false }),
      compBalances(),
      sb.from('comp_adjustments').select('*').eq('user_id', me()).order('created_at', { ascending: false }),
      isManager() ? null : loadDirectory().catch(() => [])   // names of who approved, for printouts
    ]);
    if (reqs.error) throw reqs.error;
    if (adj.error) throw adj.error;
    const data = reqs.data;
    const b = bals.find((x) => x.user_id === me()) || { balance: 0, pending_earned: 0, pending_used: 0 };
    const balance = Number(b.balance) || 0, pEarn = Number(b.pending_earned) || 0, pUse = Number(b.pending_used) || 0;
    const available = balance - pUse;

    // Comp history: approved comp requests and manager adjustments, newest first, with a running balance
    const ledger = [
      ...data.filter((r) => isComp(r.type) && r.status === 'approved' && r.hours != null).map((r) => ({
        when: r.reviewed_at || r.created_at, date: r.start_date,
        what: r.type === 'comp_earned' ? `Earned${r.reason ? ': ' + r.reason : ''}` : `Used${r.start_date !== r.end_date ? ' (' + dateRange(r.start_date, r.end_date) + ')' : ''}`,
        hours: r.type === 'comp_earned' ? Number(r.hours) : -Number(r.hours) })),
      ...adj.data.map((a) => ({ when: a.created_at, date: isoDate(new Date(a.created_at)), what: `Adjustment: ${a.note}`, hours: Number(a.hours) }))
    ].sort((x, y) => String(x.when).localeCompare(String(y.when)));
    let run = 0;
    ledger.forEach((l) => { run += l.hours; l.after = run; });
    ledger.reverse();

    el.innerHTML = `${hasComp(state.profile) ? `
      <section class="card comp-card">
        <div class="comp-head">
          <div>
            <h2>Comp time</h2>
            <div class="comp-balance"><span class="comp-num">${hrs(balance)}</span> hrs available</div>
            <div class="hint" style="margin:0">${pEarn || pUse
              ? `Waiting for approval: ${pEarn ? `+${hrs(pEarn)} earned` : ''}${pEarn && pUse ? ', ' : ''}${pUse ? `−${hrs(pUse)} used` : ''}.`
              : ''}</div>
          </div>
        </div>
        ${ledger.length ? `<details class="fold">
          <summary><h3>Comp history</h3></summary>
          <div class="table-wrap"><table class="list">
            <thead><tr><th>Date</th><th>What</th><th class="num">Hours</th><th class="num">Balance</th></tr></thead>
            <tbody>${ledger.map((l) => `<tr><td>${esc(fmtShort(l.date))}</td><td>${esc(l.what)}</td>
              <td class="num">${l.hours > 0 ? '+' : '−'}${hrs(Math.abs(l.hours))}</td><td class="num">${hrs(l.after)}</td></tr>`).join('')}</tbody>
          </table></div>
        </details>` : ''}
      </section>` : ''}

      <section class="card">
        ${hasComp(state.profile) ? `<h2>What do you want to do?</h2>
        <div class="seg-toggle to-mode" role="group" aria-label="What do you want to do?">
          <button type="button" data-mode="off" class="on">Request time off</button><button type="button" data-mode="use">Use comp time</button><button type="button" data-mode="earn">Log comp time earned</button>
        </div>` : '<h2>Request time off</h2>'}
        <form id="to-form" autocomplete="off">
          <div class="row">
            <label class="m-off">Type<select name="type">${requestTypes().filter(([k]) => k !== 'comp').map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
            <label class="m-off m-use">First day<input type="date" name="start"></label>
            <label class="m-off m-use">Last day<input type="date" name="end"></label>
            <label class="m-earn" hidden>Day worked<input type="date" name="worked" max="${esc(localToday())}"></label>
            <label class="narrow"><span id="to-hours-label">Total hours</span><input type="number" name="hours" min="0.25" step="0.25" inputmode="decimal" required placeholder="e.g. 12"></label>
          </div>
          <p class="hint" id="to-hint" style="margin-top:-.4rem"></p>
          <label><span id="to-reason-label">Reason (optional)</span><textarea name="reason" rows="2"></textarea></label>
          <button class="btn primary" type="submit" id="to-submit">Submit request</button>
        </form>
      </section>
      <section class="card"><h2>My requests</h2>${timeOffTable(data, false)}</section>`;

    // One form, three things: request time off, use comp time, or log comp time earned
    const form = $('#to-form');
    const hint = $('#to-hint');
    let mode = 'off';
    const MODES = {
      off: { hours: 'Total hours', reason: 'Reason (optional)', placeholder: '', submit: 'Submit request' },
      use: { hours: 'Comp hours to use', reason: 'Reason (optional)', placeholder: '', submit: 'Request comp time off' },
      earn: { hours: 'Hours earned', reason: 'What for', placeholder: 'e.g. Court after shift, held over on a call', submit: 'Submit comp time earned' }
    };
    const updateHint = () => {
      hint.classList.remove('error-text');
      const want = Number(form.hours.value) || 0;
      if (mode === 'off') { hint.textContent = 'Total hours: 12 for one shift, 24 for two.'; return; }
      if (mode === 'earn') {
        hint.textContent = `Added to your balance once approved${want ? ` (${hrs(balance + want)} hrs after)` : ''}.`;
        return;
      }
      hint.textContent = `You have ${hrs(available)} comp hours you can use${pUse ? ` (${hrs(balance)} minus ${hrs(pUse)} already requested)` : ''}.${want && want <= available ? ` ${hrs(available - want)} left after this.` : ''}`;
      if (want > available) {
        hint.textContent += ` This request is ${hrs(want - available)} more than that.`;
        hint.classList.add('error-text');
      }
    };
    const setMode = (m) => {
      mode = m;
      $$('.to-mode button', el).forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
      $$('.m-off, .m-use, .m-earn', form).forEach((l) => { l.hidden = !l.classList.contains(`m-${m}`); });
      form.start.required = form.end.required = m !== 'earn';
      form.worked.required = m === 'earn';
      form.reason.required = m === 'earn';
      $('#to-hours-label').textContent = MODES[m].hours;
      $('#to-reason-label').textContent = MODES[m].reason;
      form.reason.placeholder = MODES[m].placeholder;
      $('#to-submit').textContent = MODES[m].submit;
      updateHint();
    };
    $$('.to-mode button', el).forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
    form.hours.oninput = updateHint;
    form.start.onchange = () => { if (!form.end.value || form.end.value < form.start.value) form.end.value = form.start.value; };
    form.onsubmit = (e) => {
      e.preventDefault();
      const hours = Number(form.hours.value);
      if (mode === 'use' && hours > available
          && !confirm(`You only have ${hrs(available)} comp hours available. Send the request for ${hrs(hours)} hours anyway?`)) return;
      withBusy($('#to-submit'), async () => {
        if (!(hours > 0) || !isHalfStep(hours)) throw new Error('Hours must be in quarter-hour steps (for example 4, 4.25 or 12).');
        let row;
        if (mode === 'earn') {
          if (!form.worked.value) throw new Error('Pick the day you worked.');
          if (!form.reason.value.trim()) throw new Error('Say what the comp time was earned for.');
          row = { type: 'comp_earned', start_date: form.worked.value, end_date: form.worked.value, hours, reason: form.reason.value.trim() };
        } else {
          if (!form.start.value) throw new Error('Pick the first day.');
          if (form.end.value && form.end.value < form.start.value) throw new Error('Last day must be on or after the first day.');
          row = { type: mode === 'use' ? 'comp' : form.type.value, start_date: form.start.value, end_date: form.end.value || form.start.value,
                  hours, reason: form.reason.value.trim() || null };
        }
        const { data: req, error } = await sb.from('time_off_requests').insert({ user_id: me(), ...row }).select('id').single();
        if (error) throw error;
        alertApprovers(req.id);
        toast(mode === 'earn' ? 'Comp time submitted for approval.' : 'Request submitted.');
        showView('timeoff');
      });
    };
    setMode('off');
    bindTimeOffButtons(el, data);
  };

  function timeOffTable(list, mgr) {
    if (!list.length) return '<p class="muted">Nothing here yet.</p>';
    return `<div class="table-wrap"><table class="list">
      <thead><tr>${mgr ? '<th>Employee</th>' : ''}<th>Dates</th><th class="num">Hours</th><th>Type</th><th>Status</th><th>Note</th><th></th></tr></thead>
      <tbody>${list.map((r) => {
        let action = '';
        if (mgr && r.status === 'pending' && canApproveTimeOff()) action = `<button class="btn small" data-to="${r.id}">Review</button>`;
        else if (mgr) action = `<button class="btn small" data-to="${r.id}">View</button>`;
        else action = `${r.status === 'pending' ? `<button class="btn small" data-cancel="${r.id}">Cancel</button> ` : ''}<button class="btn small" data-to="${r.id}">View</button>`;
        return `<tr class="${r.type === 'comp_earned' ? 'is-earned' : ''}">
          ${mgr ? `<td>${esc(personName(r.user_id, 'Unknown'))}</td>` : ''}
          <td>${esc(r.type === 'comp_earned' ? fmtDate(r.start_date) : dateRange(r.start_date, r.end_date))}</td>
          <td class="num">${esc(hoursText(r))}</td>
          <td>${esc(typeLabel(r.type))}</td>
          <td>${badge(r.status)}</td>
          <td class="note">${esc(r.manager_note || (mgr || r.type === 'comp_earned' ? r.reason : '') || '')}</td>
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

  // Printable one-page form for a time-off request or comp time earned
  function timeOffSheetHTML(r) {
    const earned = r.type === 'comp_earned';
    const days = dayCount(r.start_date, r.end_date);
    const decided = ['approved', 'denied'].includes(r.status) && r.reviewed_at;
    const row = (label, value) => `<tr><th>${esc(label)}</th><td>${value}</td></tr>`;
    return `<div class="sheet to-sheet">
      <div class="sheet-head">
        <div class="org">${esc(ORG)}</div>
        <div class="title">${earned ? 'COMP TIME EARNED' : 'TIME-OFF REQUEST'}</div>
        <div class="emp">${esc(personName(r.user_id, 'Employee').toUpperCase())}</div>
      </div>
      <table class="to-table"><tbody>
        ${row('Type', esc(typeLabel(r.type)))}
        ${row(earned ? 'Day worked' : 'Dates', esc(earned ? fmtDate(r.start_date) : dateRange(r.start_date, r.end_date)) + (earned ? '' : ` (${days} day${days > 1 ? 's' : ''})`))}
        ${row('Hours', r.hours == null ? '—' : esc(hrs(r.hours)))}
        ${row(earned ? 'What for' : 'Reason', esc(r.reason || '—'))}
        ${row('Requested', esc(fmtDateTime(r.created_at)))}
        ${row('Status', esc(r.status[0].toUpperCase() + r.status.slice(1)))}
        ${decided ? row(r.status === 'approved' ? 'Approved by' : 'Denied by', `${esc(personName(r.reviewed_by, 'Manager'))} on ${esc(fmtDateTime(r.reviewed_at))}`) : ''}
        ${r.manager_note ? row('Manager note', esc(r.manager_note)) : ''}
      </tbody></table>
      <div class="sheet-sign"><div class="sig-meta">Submitted electronically by ${esc(personName(r.user_id, 'the employee'))} through the Employee Portal on ${esc(fmtDateTime(r.created_at))}.${decided
        ? ` ${r.status === 'approved' ? 'Approved' : 'Denied'} electronically on ${esc(fmtDateTime(r.reviewed_at))}.` : ' Not yet approved.'}</div></div>
    </div>
    <div class="sheet-after">Printed ${esc(new Date().toLocaleString())}</div>`;
  }

  function openTimeOff(r) {
    openModal(`
      <div class="print-area print-only"><div class="sheet-page">${timeOffSheetHTML(r)}</div></div>
      <div class="doc no-print">
        <h2>${r.type === 'comp_earned' ? 'Comp time earned' : 'Time-off request'}</h2>
        <p><strong>${esc(personName(r.user_id, 'Employee'))}</strong> ${badge(r.status)}</p>
        <dl class="details">
          <dt>Type</dt><dd>${esc(typeLabel(r.type))}</dd>
          <dt>${r.type === 'comp_earned' ? 'Day worked' : 'Dates'}</dt><dd>${esc(r.type === 'comp_earned' ? fmtDate(r.start_date) : dateRange(r.start_date, r.end_date))}${r.type === 'comp_earned' ? '' : ` (${dayCount(r.start_date, r.end_date)} day${dayCount(r.start_date, r.end_date) > 1 ? 's' : ''})`}</dd>
          <dt>Hours</dt><dd>${r.hours == null ? '—' : esc(hrs(r.hours))}</dd>
          <dt>${r.type === 'comp_earned' ? 'What for' : 'Reason'}</dt><dd>${esc(r.reason || '—')}</dd>
          ${isComp(r.type) ? '<dt>Comp balance</dt><dd id="to-bal">…</dd>' : ''}
          <dt>Requested</dt><dd>${esc(fmtDateTime(r.created_at))}</dd>
        </dl>
        ${reviewInfo(r)}
      </div>
      ${r.status !== 'pending' || !isManager() ? '' : canApproveTimeOff() ? reviewControls('Deny')
        : `<p class="notice no-print">Waiting on ${esc(approverNames())} to approve or deny.</p>`}
      <div class="actions no-print"><button class="btn" id="print-btn">Print / Save PDF</button></div>`);
    $('#print-btn').onclick = () => window.print();
    if (r.status === 'pending' && canApproveTimeOff()) bindReview('time_off_requests', r.id, 'denied');
    if (isComp(r.type) && r.hours != null) {
      compBalances().then((list) => {
        const b = list.find((x) => x.user_id === r.user_id);
        const cell = $('#to-bal');
        if (!b || !cell) return;
        const bal = Number(b.balance) || 0, h = Number(r.hours) || 0;
        const after = r.type === 'comp_earned' ? bal + h : bal - h;
        cell.innerHTML = `${esc(hrs(bal))} hrs now${r.status === 'pending'
          ? ` → <strong${after < 0 ? ' class="error-text"' : ''}>${esc(hrs(after))} hrs</strong> if approved` : ''}`;
      }).catch(() => { const cell = $('#to-bal'); if (cell) cell.textContent = '?'; });
    }
  }

  /* ---------------- uniforms: yearly allowance for Galls orders ---------------- */
  const money = (n) => Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const fyLabel = (fy) => { const y = Number(String(fy || '').slice(0, 4)) || new Date().getFullYear(); return `Oct 1, ${y} – Sep 30, ${y + 1}`; };
  async function uniformBalances() {
    const { data, error } = await sb.rpc('uniform_balances');
    if (error) throw error;
    return data || [];
  }
  // Status shown for an order: approved ones move on to Ordered and Received
  const uniformStatus = (o) => (o.status === 'approved' ? (o.received_at ? 'Received' : o.ordered_at ? 'Ordered' : 'Approved')
    : o.status[0].toUpperCase() + o.status.slice(1));
  const uniformBadge = (o) => `<span class="badge badge-${o.status === 'approved' ? 'approved' : o.status === 'pending' ? 'pending' : o.status === 'denied' ? 'denied' : 'cancelled'}">${esc(uniformStatus(o))}</span>`;
  const uniformSummary = (o) => (o.items || []).map((x) => `${x.description}${x.qty > 1 ? ` ×${x.qty}` : ''}`).join(', ');
  const uniformAmount = (o) => (o.status === 'approved' ? o.approved_total : o.total);

  function uniformTable(list, mgr) {
    if (!list.length) return '<p class="muted">Nothing here yet.</p>';
    return `<div class="table-wrap"><table class="list">
      <thead><tr>${mgr ? '<th>Employee</th>' : ''}<th>Requested</th><th>Items</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.map((o) => `<tr>
        ${mgr ? `<td>${esc(personName(o.user_id, 'Unknown'))}</td>` : ''}
        <td>${esc(fmtShort(isoDate(new Date(o.created_at))))}</td>
        <td class="note">${esc(uniformSummary(o))}</td>
        <td class="num">${money(uniformAmount(o))}</td>
        <td>${uniformBadge(o)}</td>
        <td class="right">${!mgr && o.status === 'pending' ? `<button class="btn small" data-uo-cancel="${o.id}">Cancel</button> ` : ''}<button class="btn small" data-uo="${o.id}">${mgr && o.status === 'pending' && canApproveTimeOff() ? 'Review' : 'View'}</button></td>
      </tr>`).join('')}</tbody></table></div>`;
  }
  function bindUniformButtons(el, list) {
    $$('[data-uo]', el).forEach((b) => { b.onclick = () => openUniform(list.find((o) => o.id === b.dataset.uo)); });
    $$('[data-uo-cancel]', el).forEach((b) => {
      b.onclick = () => {
        if (!confirm('Cancel this uniform request?')) return;
        withBusy(b, async () => {
          const { error } = await sb.from('uniform_orders').update({ status: 'cancelled' }).eq('id', b.dataset.uoCancel);
          if (error) throw error;
          toast('Request cancelled.');
          showView(state.view);
        });
      };
    });
  }

  // One order: a printable form (for placing the Galls order), plus approve / track controls
  function uniformSheetHTML(o) {
    const isLink = (t) => /^https?:\/\//i.test(t || '');
    const rows = (o.items || []).map((x) => `<tr>
      <td>${isLink(x.item) ? `<a href="${esc(x.item)}" target="_blank" rel="noopener">Galls link</a>` : esc(x.item || '')}</td>
      <td>${esc(x.description)}</td><td>${esc(x.size || '')}</td><td class="c">${esc(x.qty)}</td>
      <td class="r">${money(x.price)}</td><td class="r">${money(x.qty * x.price)}</td></tr>`).join('');
    const decided = ['approved', 'denied'].includes(o.status) && o.reviewed_at;
    const row = (label, value) => `<tr><th>${esc(label)}</th><td>${value}</td></tr>`;
    return `<div class="sheet to-sheet uo-sheet">
      <div class="sheet-head">
        <div class="org">${esc(ORG)}</div>
        <div class="title">UNIFORM / EQUIPMENT ORDER</div>
        <div class="emp">${esc(personName(o.user_id, 'Employee').toUpperCase())}</div>
      </div>
      <table class="uo-items"><thead><tr><th>Galls item #</th><th>Description</th><th>Size</th><th class="c">Qty</th><th class="r">Price</th><th class="r">Total</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th colspan="5" class="r">Requested total</th><th class="r">${money(o.total)}</th></tr>
          ${o.status === 'approved' && Number(o.approved_total) !== Number(o.total) ? `<tr><th colspan="5" class="r">Approved amount</th><th class="r">${money(o.approved_total)}</th></tr>` : ''}</tfoot>
      </table>
      <table class="to-table"><tbody>
        ${o.note ? row('Note', esc(o.note)) : ''}
        ${row('Requested', esc(fmtDateTime(o.created_at)))}
        ${row('Status', esc(uniformStatus(o)))}
        ${decided ? row(o.status === 'approved' ? 'Approved by' : 'Denied by', `${esc(personName(o.reviewed_by, 'Manager'))} on ${esc(fmtDateTime(o.reviewed_at))}`) : ''}
        ${o.ordered_at ? row('Ordered', esc(fmtDateTime(o.ordered_at))) : ''}
        ${o.received_at ? row('Received', esc(fmtDateTime(o.received_at))) : ''}
        ${o.manager_note ? row('Manager note', esc(o.manager_note)) : ''}
        ${row('Allowance year', esc(fyLabel(o.fy_start)))}
      </tbody></table>
    </div>
    <div class="sheet-after">Printed ${esc(new Date().toLocaleString())}</div>`;
  }

  function openUniform(o) {
    const approver = canApproveTimeOff();
    openModal(`
      <div class="print-area"><div class="sheet-page">${uniformSheetHTML(o)}</div></div>
      ${o.status === 'pending' && approver ? `<div class="review no-print">
        <div class="row"><label class="narrow">Amount to take out<input type="number" id="uo-approved" min="0.01" step="0.01" value="${esc(Number(o.total).toFixed(2))}" inputmode="decimal"></label>
          <p class="hint" id="uo-bal" style="align-self:end">Checking their balance…</p></div>
        <label>Note to employee (optional)<textarea id="rv-note" rows="2"></textarea></label>
        <div class="actions"><button class="btn primary" id="rv-approve">Approve</button><button class="btn danger" id="rv-deny">Deny</button></div></div>` : ''}
      ${o.status === 'pending' && isManager() && !approver ? `<p class="notice no-print">Waiting on ${esc(approverNames())} to approve or deny.</p>` : ''}
      ${o.status === 'approved' && approver ? `<div class="review no-print">
        <div class="row end"><label class="narrow">Actual amount<input type="number" id="uo-amount" min="0.01" step="0.01" value="${esc(Number(o.approved_total).toFixed(2))}" inputmode="decimal"></label>
          <button class="btn" id="uo-amount-save" type="button">Update amount</button></div>
        <p class="hint" id="uo-amount-hint">Change this to the real Galls invoice total. Their balance updates to match.</p></div>
      <div class="actions no-print">
        <button class="btn" id="uo-ordered">${o.ordered_at ? 'Undo “ordered”' : 'Mark ordered from Galls'}</button>
        ${o.ordered_at ? `<button class="btn" id="uo-received">${o.received_at ? 'Undo “received”' : 'Mark received'}</button>` : ''}</div>` : ''}
      <div class="actions no-print"><button class="btn" id="print-btn">Print / Save PDF</button></div>`);
    $('#print-btn').onclick = () => window.print();
    if (o.status === 'pending' && approver) {
      uniformBalances().then((list) => {
        const b = list.find((x) => x.user_id === o.user_id), cell = $('#uo-bal');
        if (cell && b) cell.textContent = `${money(b.balance)} left in their allowance (this request isn’t taken out yet).`;
      }).catch(() => {});
      const act = (status, btn) => withBusy(btn, async () => {
        const upd = { status, manager_note: $('#rv-note').value.trim() || null };
        if (status === 'approved') {
          const amt = Number($('#uo-approved').value);
          if (!(amt > 0)) throw new Error('Enter the amount to take out of their allowance.');
          upd.approved_total = Math.round(amt * 100) / 100;
        }
        const { error } = await sb.from('uniform_orders').update(upd).eq('id', o.id);
        if (error) throw error;
        notify('uniform_decision', o.id);
        closeModal();
        toast(status === 'approved' ? 'Approved and taken out of their allowance.' : 'Denied.');
        showView(state.view);
      });
      $('#rv-approve').onclick = (e) => act('approved', e.target);
      $('#rv-deny').onclick = (e) => act('denied', e.target);
    }
    const track = (field, btn) => withBusy(btn, async () => {
      const upd = { [field]: o[field] ? null : new Date().toISOString() };
      if (field === 'ordered_at' && o.ordered_at) upd.received_at = null;   // undoing "ordered" undoes "received" too
      const { error } = await sb.from('uniform_orders').update(upd).eq('id', o.id);
      if (error) throw error;
      closeModal();
      toast('Saved.');
      showView(state.view);
    });
    $('#uo-ordered')?.addEventListener('click', (e) => track('ordered_at', e.target));
    $('#uo-amount-save')?.addEventListener('click', (e) => withBusy(e.target, async () => {
      const amt = Math.round(Number($('#uo-amount').value) * 100) / 100;
      if (!(amt > 0)) throw new Error('Enter the actual amount (more than $0).');
      if (amt === Number(o.approved_total)) { toast('That’s already the amount.'); return; }
      const { error } = await sb.from('uniform_orders').update({ approved_total: amt }).eq('id', o.id);
      if (error) throw error;
      notify('uniform_decision', o.id);   // tells them the amount taken out now
      closeModal();
      toast(`Amount updated to ${money(amt)}.`);
      showView(state.view);
    }));
    if ($('#uo-amount')) {
      uniformBalances().then((list) => {
        const b = list.find((x) => x.user_id === o.user_id), hint = $('#uo-amount-hint');
        if (hint && b) hint.textContent = `Change this to the real Galls invoice total. They can have up to ${money(Number(b.balance) + Number(o.approved_total))} for this order; their balance updates to match.`;
      }).catch(() => {});
    }
    $('#uo-received')?.addEventListener('click', (e) => track('received_at', e.target));
  }

  views.uniforms = async (el) => {
    const [bals, ordersR, adjR] = await Promise.all([
      uniformBalances(),
      sb.from('uniform_orders').select('*').eq('user_id', me()).order('created_at', { ascending: false }),
      sb.from('uniform_adjustments').select('*').eq('user_id', me()).order('created_at', { ascending: false }),
      isManager() ? null : loadDirectory().catch(() => [])   // names of who approved, for printouts
    ]);
    if (ordersR.error) throw ordersR.error;
    const b = bals.find((x) => x.user_id === me()) || { allowance: 500, balance: 500, pending: 0, spent: 0, adjusted: 0 };
    const fy = b.fy_start;
    const available = Math.max(0, Number(b.balance) - Number(b.pending));
    const adjThisYear = (adjR.data || []).filter((a) => a.fy_start === fy);
    const lineRow = () => `<tr>
      <td class="it"><input class="uo-item" placeholder="Galls item # or link" maxlength="300"></td>
      <td class="de"><input class="uo-desc" placeholder="Description &amp; color (e.g. Duty pants, black)" maxlength="200"></td>
      <td><input class="uo-size" placeholder="Size" maxlength="40"></td>
      <td><input class="uo-qty" type="number" min="1" max="99" step="1" value="1" inputmode="numeric" aria-label="Quantity"></td>
      <td><input class="uo-price" type="number" min="0" step="0.01" placeholder="Price each" inputmode="decimal" aria-label="Price each"></td>
      <td class="num uo-line"></td>
      <td><button type="button" class="btn-link uo-del" aria-label="Remove this item">✕</button></td></tr>`;

    el.innerHTML = `
      <section class="card comp-card">
        <h2>Uniform allowance</h2>
        <div class="comp-balance"><span class="comp-num">${money(b.balance)}</span> left of ${money(b.allowance)}</div>
        <div class="hint" style="margin:0">${esc(fyLabel(fy))}. Resets Oct 1.${Number(b.pending) ? ` ${money(b.pending)} is waiting for approval, so you can request up to ${money(available)} more.` : ''}</div>
        ${adjThisYear.length ? `<details class="fold"><summary><h3>Adjustments</h3></summary>
          <ul class="plain">${adjThisYear.map((a) => `<li>${Number(a.amount) > 0 ? '+' : '−'}${money(Math.abs(a.amount))} — ${esc(a.note)}</li>`).join('')}</ul></details>` : ''}
      </section>
      <section class="card">
        <h2>Request uniforms or equipment</h2>
        <p class="hint">One line per Galls item.</p>
        <form id="uo-form" autocomplete="off">
          <div class="table-wrap"><table class="grid uo-lines">
            <thead><tr><th>Galls item # or link</th><th>Description</th><th>Size</th><th>Qty</th><th>Price each</th><th class="num">Total</th><th></th></tr></thead>
            <tbody id="uo-rows">${lineRow()}</tbody>
          </table></div>
          <button type="button" class="btn small" id="uo-add">+ Add another item</button>
          <p class="uo-total">Total: <strong id="uo-total">${money(0)}</strong> <span class="hint" id="uo-left">You have ${money(available)} available.</span></p>
          <label>Note (optional)<textarea name="note" rows="2" maxlength="1000"></textarea></label>
          <button class="btn primary" type="submit" id="uo-submit">Submit request</button>
        </form>
      </section>
      <section class="card"><h2>My requests</h2><div id="uo-mine">${uniformTable(ordersR.data, false)}</div></section>`;

    bindUniformButtons($('#uo-mine'), ordersR.data);
    const f = $('#uo-form');
    const readLines = () => $$('#uo-rows tr').map((tr) => ({
      item: $('.uo-item', tr).value.trim(), description: $('.uo-desc', tr).value.trim(), size: $('.uo-size', tr).value.trim(),
      qty: Number($('.uo-qty', tr).value), price: $('.uo-price', tr).value === '' ? null : Number($('.uo-price', tr).value)
    }));
    const recalc = () => {
      let total = 0;
      $$('#uo-rows tr').forEach((tr) => {
        const q = Number($('.uo-qty', tr).value) || 0, pr = Number($('.uo-price', tr).value) || 0;
        $('.uo-line', tr).textContent = q && pr ? money(q * pr) : '';
        total += q * pr;
      });
      total = Math.round(total * 100) / 100;
      $('#uo-total').textContent = money(total);
      const over = total > available + 0.004;
      const left = $('#uo-left');
      left.textContent = over ? `That’s ${money(total - available)} more than the ${money(available)} you have available.` : `${money(available - total)} left after this.`;
      left.classList.toggle('error-text', over);
      $('#uo-submit').disabled = over;
    };
    f.addEventListener('input', recalc);
    $('#uo-add').onclick = () => { $('#uo-rows').insertAdjacentHTML('beforeend', lineRow()); $('#uo-rows tr:last-child .uo-item').focus(); };
    $('#uo-rows').addEventListener('click', (e) => {
      if (!e.target.closest('.uo-del')) return;
      if ($$('#uo-rows tr').length > 1) e.target.closest('tr').remove(); else $$('input', e.target.closest('tr')).forEach((i) => { i.value = i.classList.contains('uo-qty') ? 1 : ''; });
      recalc();
    });
    f.onsubmit = (e) => {
      e.preventDefault();
      withBusy($('#uo-submit'), async () => {
        const items = readLines().filter((x) => x.item || x.description || x.size || x.price != null);
        if (!items.length) throw new Error('Add at least one item.');
        for (const x of items) {
          if (!x.description) throw new Error('Each item needs a description.');
          if (!(x.qty >= 1 && x.qty <= 99 && Number.isInteger(x.qty))) throw new Error(`Check the quantity for “${x.description}” (1 to 99).`);
          if (!(x.price > 0)) throw new Error(`Enter the price for “${x.description}”.`);
        }
        const { data: o, error } = await sb.from('uniform_orders').insert({
          items: items.map((x) => ({ ...x, price: x.price.toFixed(2) })), note: f.note.value.trim() || null
        }).select('id').single();
        if (error) throw error;
        notifyQuiet('uniform_request', o.id);
        toast('Request sent for approval.');
        showView('uniforms');
      });
    };
    recalc();
  };

  // Email alert that shouldn't bother the person if it fails (the request is saved either way)
  async function notifyQuiet(type, id) {
    try {
      const { data, error } = await sb.functions.invoke('notify', { body: { type, id } });
      if (error) throw new Error(await functionError(error, 'notify'));
      if (data?.error) throw new Error(data.error);
    } catch (err) { console.warn('Email alert not sent:', err.message); }
  }

  /* ---------------- manager: approvals (only what's waiting) ---------------- */
  views.review = async (el) => {
    const people = await loadPeople();
    // Who still owes a timesheet: last pay period (once it's over), and the current one on its last day
    const cur = currentPeriod(), prev = previousPeriod(), today = isoDate(new Date());
    const due = [...(prev !== cur ? [prev] : []), ...(periodEnd(cur) === today ? [cur] : [])];
    const [ts, to, dueTs, uo] = await Promise.all([
      sb.from('timesheets').select('*').eq('status', 'submitted').order('period_start'),
      sb.from('time_off_requests').select('*').eq('status', 'pending').order('start_date'),
      due.length ? sb.from('timesheets').select('user_id, period_start, status').in('period_start', due) : { data: [] },
      on('uniforms') ? sb.from('uniform_orders').select('*').eq('status', 'pending').order('created_at') : { data: [] }
    ]);
    for (const r of [ts, to, dueTs, uo]) if (r.error) throw r.error;
    const missing = due.map((p) => {
      const status = Object.fromEntries(dueTs.data.filter((t) => t.period_start === p).map((t) => [t.user_id, t.status]));
      const joinedBy = (x) => !x.created_at || isoDate(new Date(x.created_at)) <= periodEnd(p);   // not people who started after it
      const list = people.filter((x) => x.active !== false && joinedBy(x) && !['submitted', 'approved'].includes(status[x.id]))
        .map((x) => ({ ...x, sentBack: status[x.id] === 'rejected' }));
      return { p, list };
    }).filter((g) => g.list.length);
    const missingCount = missing.reduce((n, g) => n + g.list.length, 0);
    el.innerHTML = `
      ${missingCount ? `<section class="card"><h2>Haven’t submitted a timesheet <span class="count">${missingCount}</span></h2>
        ${missing.map(({ p, list }) => `<h3 class="due-period">${esc(periodLabel(p))} <span class="muted">${periodEnd(p) === today ? 'due today' : `was due ${esc(fmtShort(periodEnd(p)))}`}</span></h3>
          <div class="due-people">${list.map((x) => `<span class="chip ${x.sentBack ? '' : 'muted-chip'}" title="${x.sentBack ? 'Sent back, not resubmitted yet' : 'Not submitted'}">${esc(x.full_name || x.email)}${x.sentBack ? ' (sent back)' : ''}</span>`).join(' ')}</div>`).join('')}
        
      </section>` : ''}
      <section class="card"><h2>Timesheets awaiting approval <span class="count">${ts.data.length}</span></h2>
        <div id="ts-pending">${ts.data.length ? timesheetTable(ts.data, true) : '<p class="muted">Nothing waiting.</p>'}</div></section>
      <section class="card"><h2>Time off awaiting approval <span class="count">${to.data.length}</span></h2>
        ${timeOffApprovers().length ? `<p class="hint">Approved or denied by ${esc(approverNames())}.</p>` : ''}
        <div id="to-pending">${to.data.length ? timeOffTable(to.data, true) : '<p class="muted">Nothing waiting.</p>'}</div></section>
      ${on('uniforms') ? `<section class="card"><h2>Uniform orders awaiting approval <span class="count">${uo.data.length}</span></h2>
        <div id="uo-pending">${uo.data.length ? uniformTable(uo.data, true) : '<p class="muted">Nothing waiting.</p>'}</div></section>` : ''}
      <p class="hint">Approved and denied history, comp time${on('uniforms') ? ' and uniform allowance' : ''} balances and payroll are on <button class="btn-link" type="button" id="go-payroll">Payroll &amp; History</button>.</p>`;
    bindTimesheetButtons($('#ts-pending'), ts.data);
    bindTimeOffButtons($('#to-pending'), to.data);
    if ($('#uo-pending')) bindUniformButtons($('#uo-pending'), uo.data);
    $('#go-payroll').onclick = () => showView('payroll');
  };

  /* ---------------- manager: payroll & history ---------------- */
  views.payroll = async (el) => {
    const people = await loadPeople();
    const who = state.people[state.filterUser] ? state.filterUser : '';
    state.filterUser = who;
    // When a person is picked, show only them and their full history
    const q = (table) => { let x = sb.from(table).select('*'); if (who) x = x.eq('user_id', who); return x; };
    const recent = (x) => who ? x : x.limit(25);
    const [tsDone, toDone, bals, uBals, uOpen, uDone] = await Promise.all([
      recent(q('timesheets').neq('status', 'submitted').order('period_start', { ascending: false })),
      recent(q('time_off_requests').neq('status', 'pending').order('start_date', { ascending: false })),
      compBalances(),
      on('uniforms') ? uniformBalances() : [],
      // approved orders still to place with Galls or still to arrive
      on('uniforms') ? q('uniform_orders').eq('status', 'approved').is('received_at', null).order('reviewed_at') : { data: [] },
      on('uniforms') ? recent(q('uniform_orders').neq('status', 'pending').order('created_at', { ascending: false })) : { data: [] }
    ]);
    for (const r of [tsDone, toDone, uOpen, uDone]) if (r.error) throw r.error;
    const uRows = uBals.filter((b) => (who ? b.user_id === who : b.active !== false));
    const compRows = bals.filter((b) => (who ? b.user_id === who : b.active !== false) && (!compPerPerson || state.people[b.user_id]?.comp_time));
    const forWho = who ? ` — ${esc(personName(who))}` : '';

    el.innerHTML = `
      <section class="card filter-bar">
        <label>Show person
          <select id="f-person">
            <option value="">Everyone</option>
            ${people.map((p) => `<option value="${p.id}" ${p.id === who ? 'selected' : ''}>${esc(p.full_name || p.email)}${p.active === false ? ' (deactivated)' : ''}</option>`).join('')}
          </select>
        </label>
        ${who ? '<button class="btn" id="f-clear">Show everyone</button>' : ''}
        <p class="hint">${who ? 'Showing all of this person’s timesheets and time off.' : 'Pick a person to see their full history. Tip: click the list and start typing a name.'}</p>
      </section>
      ${on('comp') && (!compPerPerson || compRows.length) ? `<section class="card">
        <details class="fold" ${who ? 'open' : ''}>
          <summary><h2>Comp time balances${forWho}</h2></summary>
          <p class="muted">Balance = approved comp earned − approved comp used + adjustments. Use <strong>Adjust</strong> to enter someone’s starting balance or fix a mistake.</p>
          <div class="table-wrap"><table class="list">
            <thead><tr><th>Name</th><th class="num">Balance</th><th class="num">Pending earned</th><th class="num">Pending used</th><th></th></tr></thead>
            <tbody>${compRows.map((b) => `<tr data-id="${b.user_id}"><td>${esc(b.full_name || personName(b.user_id))}</td>
              <td class="num"><strong>${hrs(b.balance)}</strong></td>
              <td class="num">${Number(b.pending_earned) ? '+' + hrs(b.pending_earned) : '—'}</td>
              <td class="num">${Number(b.pending_used) ? '−' + hrs(b.pending_used) : '—'}</td>
              <td class="right"><button class="btn small comp-adj">Adjust</button></td></tr>`).join('')}</tbody>
          </table></div>
          <button class="btn small" id="comp-csv" type="button">Download CSV</button>
        </details>
      </section>` : ''}
      ${on('uniforms') ? `<section class="card">
        <details class="fold" ${who ? 'open' : ''}>
          <summary><h2>Uniform allowance${forWho}</h2></summary>
          <p class="muted">${esc(fyLabel(uBals[0]?.fy_start))}. Everyone gets ${money(uBals[0]?.allowance ?? 500)}, reset every October 1. Use <strong>Adjust</strong> to enter what someone already spent on paper this year, or to fix a mistake.</p>
          <div class="table-wrap"><table class="list">
            <thead><tr><th>Name</th><th class="num">Left</th><th class="num">Spent</th><th class="num">Waiting</th><th class="num">Adjusted</th><th></th></tr></thead>
            <tbody>${uRows.map((b) => `<tr data-id="${b.user_id}"><td>${esc(b.full_name || personName(b.user_id))}</td>
              <td class="num"><strong>${money(b.balance)}</strong></td><td class="num">${money(b.spent)}</td>
              <td class="num">${Number(b.pending) ? money(b.pending) : '—'}</td><td class="num">${Number(b.adjusted) ? money(b.adjusted) : '—'}</td>
              <td class="right"><button class="btn small uo-adj">Adjust</button></td></tr>`).join('')}</tbody>
          </table></div>
          <button class="btn small" id="uo-csv" type="button">Download CSV</button>
        </details>
        <h3 style="margin-top:1rem">Approved orders to place or receive${forWho}</h3>
        <div id="uo-open">${uniformTable(uOpen.data, true)}</div>
        <details class="fold"><summary><h3>${who ? 'All uniform orders' : 'Recent uniform orders'}${forWho}</h3></summary>
          <div id="uo-done">${uniformTable(uDone.data, true)}</div></details>
      </section>` : ''}
      <section class="card"><h2>Payroll: print or export a pay period${forWho}</h2>
        <form id="exp" class="row end">
          <label>Pay period${periodSelect('exp-period', previousPeriod())}</label>
          <label>Include<select id="exp-status"><option value="approved">Approved only</option><option value="all">All statuses</option></select></label>
          <label>CSV layout<select id="exp-layout"><option value="summary">One row per person</option><option value="daily">One row per day</option></select></label>
        </form>
        <div class="actions">
          <button class="btn primary" id="exp-print">Print all timesheets</button>
          <button class="btn" id="exp-csv">Download CSV</button>
        </div></section>
      <section class="card"><h2>${who ? 'All timesheets' + forWho : 'Recent timesheets'}</h2><div id="ts-done">${timesheetTable(tsDone.data, true)}</div></section>
      <section class="card"><h2>${who ? 'All time off' + forWho : 'Recent time off'}</h2><div id="to-done">${timeOffTable(toDone.data, true)}</div></section>`;

    $('#f-person').onchange = (e) => { state.filterUser = e.target.value; showView('payroll'); };
    if (who) $('#f-clear').onclick = () => { state.filterUser = ''; showView('payroll'); };

    bindTimesheetButtons($('#ts-done'), tsDone.data);
    bindTimeOffButtons($('#to-done'), toDone.data);

    if (on('uniforms')) {
      bindUniformButtons($('#uo-open'), uOpen.data);
      bindUniformButtons($('#uo-done'), uDone.data);
      $('#uo-csv').onclick = () => downloadCSV(`uniform-allowance-${localToday()}.csv`, [
        ['Name', 'Allowance year starts', 'Allowance', 'Adjusted', 'Spent (approved)', 'Waiting for approval', 'Left'],
        ...uRows.map((b) => [b.full_name, b.fy_start, Number(b.allowance), Number(b.adjusted), Number(b.spent), Number(b.pending), Number(b.balance)])
      ]);
      $$('.uo-adj', el).forEach((btn) => {
        btn.onclick = () => {
          const b = uRows.find((x) => x.user_id === btn.closest('tr').dataset.id);
          openModal(`
            <h2 class="modal-head">Adjust uniform allowance — ${esc(b.full_name)}</h2>
            <p>Left this year: <strong>${money(b.balance)}</strong></p>
            <form id="uadj-form" autocomplete="off">
              <div class="row">
                <label class="narrow">Amount<input type="number" name="amount" step="0.01" inputmode="decimal" required placeholder="e.g. -120 or 50"></label>
                <label class="grow">Note<input name="note" required placeholder="e.g. Spent on paper in October"></label>
              </div>
              <p class="hint" id="uadj-hint">Negative takes money away (already spent), positive adds it. Adjustments can’t be edited or deleted — fix a mistake with another adjustment.</p>
              <div class="actions"><button class="btn primary" type="submit">Save adjustment</button><button class="btn" type="button" id="uadj-cancel">Cancel</button></div>
            </form>`);
          const af = $('#uadj-form');
          af.amount.oninput = () => { const a = Number(af.amount.value) || 0; $('#uadj-hint').textContent = a ? `They’ll have ${money(Number(b.balance) + a)} left.` : 'Negative takes money away (already spent), positive adds it.'; };
          $('#uadj-cancel').onclick = closeModal;
          af.onsubmit = (ev) => {
            ev.preventDefault();
            const amount = Math.round(Number(af.amount.value) * 100) / 100;
            withBusy(af.querySelector('[type=submit]'), async () => {
              if (!amount) throw new Error('Enter an amount that isn’t 0 (for example -120 or 50).');
              const { error } = await sb.from('uniform_adjustments').insert({ user_id: b.user_id, amount, note: af.note.value.trim() });
              if (error) throw error;
              closeModal();
              toast('Allowance adjusted.');
              showView('payroll');
            });
          };
        };
      });
    }
    if ($('#comp-csv')) $('#comp-csv').onclick = () => downloadCSV(`comp-balances-${localToday()}.csv`, [
      ['Name', 'Balance', 'Earned (approved)', 'Used (approved)', 'Adjustments', 'Pending earned', 'Pending used'],
      ...compRows.map((b) => [b.full_name, Number(b.balance), Number(b.earned), Number(b.used), Number(b.adjusted), Number(b.pending_earned), Number(b.pending_used)])
    ]);
    $$('.comp-adj', el).forEach((btn) => {
      btn.onclick = () => {
        const b = compRows.find((x) => x.user_id === btn.closest('tr').dataset.id);
        openModal(`
          <h2 class="modal-head">Adjust comp time — ${esc(b.full_name)}</h2>
          <p>Current balance: <strong>${esc(hrs(b.balance))} hrs</strong></p>
          <form id="adj-form" autocomplete="off">
            <div class="row">
              <label class="narrow">Hours<input type="number" name="hours" step="0.25" inputmode="decimal" required placeholder="e.g. 24 or -4"></label>
              <label class="grow">Note<input name="note" required placeholder="e.g. Starting balance from paper records"></label>
            </div>
            <p class="hint" id="adj-hint">Positive adds hours, negative takes them away. Adjustments can’t be edited or deleted — fix a mistake with another adjustment.</p>
            <div class="actions"><button class="btn primary" type="submit">Save adjustment</button><button class="btn" type="button" id="adj-cancel">Cancel</button></div>
          </form>`);
        const f = $('#adj-form');
        f.hours.oninput = () => { const h = Number(f.hours.value) || 0; $('#adj-hint').textContent = h ? `New balance will be ${hrs(Number(b.balance) + h)} hrs.` : 'Positive adds hours, negative takes them away.'; };
        $('#adj-cancel').onclick = closeModal;
        f.onsubmit = (e) => {
          e.preventDefault();
          const hours = Number(f.hours.value);
          withBusy(f.querySelector('[type=submit]'), async () => {
            if (!hours || !isHalfStep(Math.abs(hours))) throw new Error('Hours must be in quarter-hour steps and not 0 (for example 24, 2.5 or -4).');
            const { error } = await sb.from('comp_adjustments').insert({ user_id: b.user_id, hours, note: f.note.value.trim() });
            if (error) throw error;
            closeModal();
            toast('Comp balance adjusted.');
            showView('payroll');
          });
        };
      };
    });

    async function fetchPeriod() {
      const p = $('#exp-period').value;
      let q = sb.from('timesheets').select('*').eq('period_start', p);
      if (who) q = q.eq('user_id', who);
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
        rows = [['Employee', 'Email', 'Date', 'Time in', 'Time out', 'Hours', 'Type', 'Explanation', 'Status']];
        for (const t of data) {
          for (const en of t.entries || []) {
            const type = en.duty_id ? ((t.duty_hours || []).find((d) => d.duty_id === en.duty_id)?.name || 'Special') : 'Regular';
            rows.push([personName(t.user_id), state.people[t.user_id]?.email || '', en.date,
              en.in, en.out, en.hours, type, en.explanation || '', t.status]);
          }
        }
      }
      downloadCSV(`timesheets_${p}_to_${periodEnd(p)}.csv`, rows);
    });
  };

  // Turns a Supabase Edge Function error into a plain-English message
  async function functionError(error, name) {
    const res = error.context;
    if (res && typeof res.status === 'number') {
      let body = '';
      try { body = await res.clone().text(); } catch (_) { /* no body */ }
      let detail = body;
      try { const j = JSON.parse(body); detail = j.error || j.message || j.msg || body; } catch (_) { /* not JSON */ }
      if (res.status === 404) return `Supabase can’t find a function named “${name}”. Check it’s deployed with exactly that name.`;
      if (res.status === 401 && /jwt|authorization/i.test(detail)) return `Supabase blocked the request (“${detail}”). Turn off “Verify JWT” for the ${name} function.`;
      return `${detail || error.message} (status ${res.status})`;
    }
    // No response at all: network problem, wrong project URL, or function missing
    return `Couldn’t reach the “${name}” function (${error.message}). Check it’s deployed in the same Supabase project as SUPABASE_URL in config.js, and that “Verify JWT” is off.`;
  }

  /* ---------------- email alerts ---------------- */
  // Tells the "notify" Edge Function what happened; it looks up the details and sends the emails.
  // Never blocks the action itself — if alerts aren't set up yet, it says so once.
  let alertWarned = false;
  async function notify(type, id, extra = {}) {
    try {
      const { data, error } = await sb.functions.invoke('notify', { body: { type, id, ...extra } });
      if (error) throw new Error(await functionError(error, 'notify'));
      return data;
    } catch (err) {
      console.warn('Email alert not sent:', err.message);
      if (!alertWarned) { alertWarned = true; setTimeout(() => toast('Saved — but the email alert couldn’t be sent (see README: “Email alerts”).', true), 1200); }
    }
  }

  // Email the sheriff / chief deputy about a new time-off request. Quiet if it fails: the
  // request is saved and shows on their Approvals tab either way.
  async function alertApprovers(id) {
    try {
      const { data, error } = await sb.functions.invoke('timeoff-alert', { body: { id } });
      if (error) throw new Error(await functionError(error, 'timeoff-alert'));
      if (data?.error) throw new Error(data.error);
    } catch (err) { console.warn('Time-off alert not sent:', err.message); }
  }

  /* ---------------- shared: names, dates & times ---------------- */
  async function loadDirectory() {
    const { data, error } = await sb.rpc('people_directory');
    if (error) throw error;
    state.dir = Object.fromEntries((data || []).map((p) => [p.id, p]));
    return data || [];
  }
  const dirName = (id) => state.dir[id]?.full_name || state.people[id]?.full_name || 'Unknown';
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const fmtWhen = (s, e, allDay) => {
    const d = new Date(s);
    const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    if (allDay) return `${day} · All day`;
    if (!e) return `${day} · ${fmtTime(s)}`;
    const sameDay = isoDate(new Date(s)) === isoDate(new Date(e));
    return sameDay ? `${day} · ${fmtTime(s)} – ${fmtTime(e)}`
      : `${day} ${fmtTime(s)} – ${new Date(e).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${fmtTime(e)}`;
  };
  const toLocalInput = (ts) => { if (!ts) return ['', '']; const d = new Date(ts); return [isoDate(d), `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`]; };
  const fromLocalInput = (date, time) => date ? new Date(`${date}T${time || '00:00'}`).toISOString() : null;
  const multiline = (s) => esc(s || '').replace(/\n/g, '<br>');
  const EVENT_KINDS = [['training', 'Training'], ['court', 'Court'], ['holiday', 'Paid holiday'], ['other', 'Other']];
  const kindLabel = (k) => (k === 'personal' ? 'My event' : k === 'offduty' ? 'Off-duty' : (EVENT_KINDS.find(([x]) => x === k) || [k, k])[1]);
  function peoplePicker(list, selected = new Set()) {
    return `<div class="picker-tools"><button type="button" class="btn small" data-pick="all">Select all</button><button type="button" class="btn small" data-pick="none">Clear</button><span class="hint picker-count"></span></div>
    <div class="people-picker">${list.filter((p) => p.active !== false).map((p) =>
      `<label class="chip-check"><input type="checkbox" value="${p.id}" ${selected.has(p.id) ? 'checked' : ''}><span>${esc(p.full_name || 'Unnamed')}</span></label>`).join('')}</div>`;
  }

  /* ---------------- calendar & announcements ---------------- */
  views.calendar = async (el) => {
    const now = new Date();
    const m = state.month || new Date(now.getFullYear(), now.getMonth(), 1);
    state.month = m;
    const gridStart = addDays(m, -m.getDay());                    // Sunday before the 1st
    const gridEnd = addDays(gridStart, 42);
    const soonEnd = addDays(now, 15);
    const today = isoDate(now);

    const [people, ann, monthEv, soonEv] = await Promise.all([
      loadDirectory(),
      sb.from('announcements').select('*').or(`show_until.is.null,show_until.gte.${today}`)
        .order('pinned', { ascending: false }).order('created_at', { ascending: false }).limit(30),
      sb.from('events').select('*').gte('starts_at', gridStart.toISOString()).lt('starts_at', gridEnd.toISOString()).order('starts_at'),
      sb.from('events').select('*').gte('starts_at', new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString())
        .lt('starts_at', soonEnd.toISOString()).order('starts_at').limit(60)
    ]);
    for (const r of [ann, monthEv, soonEv]) if (r.error) throw r.error;
    const allEv = [...new Map([...monthEv.data, ...soonEv.data].map((e) => [e.id, e])).values()];
    const tags = {};
    if (allEv.length) {
      const { data, error } = await sb.from('event_people').select('event_id, user_id').in('event_id', allEv.map((e) => e.id));
      if (error) throw error;
      data.forEach((t) => (tags[t.event_id] ||= []).push(t.user_id));
    }
    // Off-duty jobs: shown while spots are open (and not past), or to the people approved to work them
    const jobFrom = new Date(Math.min(gridStart, new Date(now.getFullYear(), now.getMonth(), now.getDate())));
    const jobTo = new Date(Math.max(gridEnd, soonEnd));
    const jobsR = on('offduty') ? await sb.from('offduty_jobs').select('*').neq('status', 'cancelled')
      .gte('starts_at', jobFrom.toISOString()).lt('starts_at', jobTo.toISOString()).order('starts_at') : { data: [] };
    let jobEv = [];
    if (!jobsR.error && jobsR.data.length) {
      const reqR = await sb.from('offduty_requests').select('job_id, user_id, status').in('job_id', jobsR.data.map((j) => j.id));
      const reqs = reqR.error ? [] : reqR.data;
      jobEv = jobsR.data.map((j) => {
        const approved = reqs.filter((r) => r.job_id === j.id && r.status === 'approved');
        const left = Math.max(0, j.spots - approved.length);
        const mineJob = approved.some((r) => r.user_id === me());
        const open = j.status === 'open' && left > 0 && new Date(j.starts_at) > now;
        return (open || mineJob) && { id: `job:${j.id}`, kind: 'offduty', isJob: true, job: j, left, mineJob,
          title: j.title, starts_at: j.starts_at, ends_at: j.ends_at, all_day: false, location: j.location, details: j.details };
      }).filter(Boolean);
    }
    const inRange = (e, a, z) => new Date(e.starts_at) >= a && new Date(e.starts_at) < z;
    monthEv.data.push(...jobEv.filter((e) => inRange(e, gridStart, gridEnd)));
    soonEv.data.push(...jobEv.filter((e) => inRange(e, new Date(now.getFullYear(), now.getMonth(), now.getDate()), soonEnd)));
    soonEv.data.sort((x, y) => x.starts_at.localeCompare(y.starts_at));
    allEv.push(...jobEv);
    const mine = (e) => (e.isJob ? e.mineJob : e.owner_id === me() || (tags[e.id] || []).includes(me()));
    // Deputies only ever receive their own + "everyone" events (the database filters them).
    // Managers see all, and can switch to just their own.
    const justMine = isManager() && state.calMine;
    const show = (e) => !justMine || mine(e) || e.for_everyone;
    monthEv.data = monthEv.data.filter(show);
    soonEv.data = soonEv.data.filter(show);
    const byDay = {};
    monthEv.data.forEach((e) => (byDay[isoDate(new Date(e.starts_at))] ||= []).push(e));
    // holidays, then other all-day events, then by time
    Object.values(byDay).forEach((list) => list.sort((x, y) =>
      (y.kind === 'holiday') - (x.kind === 'holiday') || (y.all_day ? 1 : 0) - (x.all_day ? 1 : 0) || x.starts_at.localeCompare(y.starts_at)));

    const annCard = (x) => `<article class="ann ${x.pinned ? 'pinned' : ''} ann-${x.kind}">
        <div class="ann-head">
          ${x.kind === 'training' ? '<span class="tag tag-training">Training</span>' : ''}${x.pinned ? '<span class="tag tag-pin">Pinned</span>' : ''}
          <strong>${esc(x.title)}</strong>
          <span class="muted ann-date">${esc(new Date(x.created_at).toLocaleDateString())}</span>
          ${isManager() ? `<button class="btn-link small-link" data-ann="${x.id}">Edit</button>` : ''}
        </div>
        ${x.body ? `<div class="ann-body">${multiline(x.body)}</div>` : ''}
      </article>`;
    const general = ann.data;   // training announcements (older posts) show here too, tagged
    const monthName = m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    el.innerHTML = `
      <section class="card">
        <div class="card-head"><h2>Announcements</h2>${isManager() ? '<button class="btn small primary" id="ann-new">Post announcement</button>' : ''}</div>
        ${general.length ? general.map(annCard).join('') : '<p class="muted">No announcements right now.</p>'}
      </section>

      <section class="card">
        <div class="card-head cal-head">
          <div class="cal-nav">
            <button class="btn small" id="cal-prev" aria-label="Previous month">‹</button>
            <h2>${esc(monthName)}</h2>
            <button class="btn small" id="cal-next" aria-label="Next month">›</button>
            <button class="btn small" id="cal-today">Today</button>
          </div>
          <div class="cal-legend"><span class="lg"><span class="ev-dot ev-training"></span>Training</span><span class="lg"><span class="ev-dot ev-court"></span>Court</span><span class="lg"><span class="ev-dot ev-holiday"></span>Holiday</span><span class="lg"><span class="ev-dot ev-other"></span>Other</span><span class="lg"><span class="ev-dot ev-personal"></span>My events</span>${on('offduty') ? '<span class="lg"><span class="ev-dot ev-offduty"></span>Off-duty jobs</span>' : ''}<span class="lg"><span class="mine-dot"></span>You’re on it</span></div>
          <div class="cal-tools">
            ${isManager() ? `<div class="seg-toggle" role="group" aria-label="Whose events">
              <button class="${state.calMine ? '' : 'on'}" data-calmine="0">Everyone’s</button><button class="${state.calMine ? 'on' : ''}" data-calmine="1">Just mine</button>
            </div>` : ''}
            <button class="btn small${isManager() ? '' : ' primary'}" id="my-ev-new" title="A personal event only you can see">Add my event</button>
            ${isManager() ? '<button class="btn small primary" id="ev-new">Add event</button>' : ''}</div>
        </div>
        <div class="cal-grid">
          ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="cal-dow">${d}</div>`).join('')}
          ${[...Array(42)].map((_, i) => {
            const d = addDays(gridStart, i); const iso = isoDate(d);
            const evs = byDay[iso] || [];
            return `<div class="cal-day ${d.getMonth() !== m.getMonth() ? 'other-month' : ''} ${iso === today ? 'is-today' : ''} ${evs.some(mine) ? 'has-mine' : ''}" data-day="${iso}">
              <div class="cal-num">${d.getDate()}${evs.some(mine) ? '<span class="mine-dot" title="You’re on an event this day"></span>' : ''}</div>
              ${evs.slice(0, 3).map((e) => `<button class="ev ev-${e.kind} ${mine(e) ? 'ev-is-mine' : ''}" data-ev="${e.id}" title="${esc(e.title)}">${mine(e) ? '<span class="mine-dot"></span>' : ''}${e.all_day ? '' : `<span class="ev-time">${esc(fmtTime(e.starts_at).replace(':00', '').replace(' ', '').toLowerCase())}</span> `}${esc(e.title)}</button>`).join('')}
              ${evs.length > 3 ? `<button class="ev-more" data-more="${iso}">+${evs.length - 3} more</button>` : ''}
            </div>`;
          }).join('')}
        </div>
      </section>

      <section class="card">
        <h2>${isManager() && !state.calMine ? 'Coming up (next 15 days)' : 'Coming up for you (next 15 days)'}</h2>
                ${soonEv.data.length ? `<ul class="agenda">${soonEv.data.map((e) => `<li class="${mine(e) ? 'is-mine' : ''}">
            <button class="agenda-item" data-ev="${e.id}">
              <span class="tag tag-${e.kind}">${esc(kindLabel(e.kind))}</span>
              <span class="agenda-title">${esc(e.title)}${mine(e) && !e.owner_id ? ' <span class="tag tag-mine">You</span>' : ''}${e.isJob && !e.mineJob ? ` <span class="muted">${e.left} spot${e.left === 1 ? '' : 's'} open</span>` : ''}${e.for_everyone ? ' <span class="tag">Everyone</span>' : ''}</span>
              <span class="muted agenda-when">${esc(fmtWhen(e.starts_at, e.ends_at, e.all_day))}${e.location ? ` · ${esc(e.location)}` : ''}</span>
            </button></li>`).join('')}</ul>` : '<p class="muted">Nothing scheduled.</p>'}
      </section>`;

    const evById = Object.fromEntries(allEv.map((e) => [e.id, e]));
    $$('[data-ev]', el).forEach((b) => { b.onclick = () => openEvent(evById[b.dataset.ev], tags[b.dataset.ev] || [], people); });
    $$('[data-more]', el).forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); openDay(b.dataset.more, byDay[b.dataset.more], tags, people); }; });
    // On phones the events are just colored bars, so tapping anywhere in a day opens that day
    $$('.cal-day', el).forEach((d) => {
      d.onclick = (ev) => {
        const evs = byDay[d.dataset.day];
        if (!evs || !window.matchMedia('(max-width: 760px)').matches) return;
        ev.preventDefault(); ev.stopPropagation();
        openDay(d.dataset.day, evs, tags, people);
      };
    });
    $('#cal-prev').onclick = () => { state.month = new Date(m.getFullYear(), m.getMonth() - 1, 1); showView('calendar'); };
    $('#cal-next').onclick = () => { state.month = new Date(m.getFullYear(), m.getMonth() + 1, 1); showView('calendar'); };
    $('#cal-today').onclick = () => { state.month = null; showView('calendar'); };
    $$('[data-calmine]', el).forEach((b) => { b.onclick = () => { state.calMine = b.dataset.calmine === '1'; showView('calendar'); }; });
    $('#my-ev-new').onclick = () => editPersonal({ starts_at: fromLocalInput(today, '09:00') });
    if (isManager()) {
      $('#ann-new').onclick = () => editAnnouncement({ kind: 'general' });
      $('#ev-new').onclick = () => editEvent({ kind: 'court', starts_at: null }, [], people);
      $$('[data-ann]', el).forEach((b) => { b.onclick = () => editAnnouncement(ann.data.find((x) => x.id === b.dataset.ann)); });
      $$('.cal-day', el).forEach((d) => {
        d.ondblclick = (e) => { if (e.target.closest('.ev')) return; editEvent({ kind: 'court', starts_at: fromLocalInput(d.dataset.day, '09:00') }, [], people); };
      });
    }
  };

  function openDay(iso, evs, tags, people) {
    openModal(`<h2>${esc(fmtDate(iso))}</h2><ul class="agenda">${evs.map((e) => `<li>
      <button class="agenda-item" data-ev="${e.id}"><span class="tag tag-${e.kind}">${esc(kindLabel(e.kind))}</span>
      <span class="agenda-title">${esc(e.title)}</span><span class="muted agenda-when">${esc(fmtWhen(e.starts_at, e.ends_at, e.all_day))}</span></button></li>`).join('')}</ul>
      <div class="actions"><button class="btn small" id="day-my-ev">Add my event this day</button></div>`);
    $$('#modal-body [data-ev]').forEach((b) => { b.onclick = () => openEvent(evs.find((e) => e.id === b.dataset.ev), tags[b.dataset.ev] || [], people); });
    $('#day-my-ev').onclick = () => editPersonal({ starts_at: fromLocalInput(iso, '09:00') });
  }

  function openEvent(e, tagged, people) {
    if (e.isJob) return openJobPeek(e);
    const names = tagged.map(dirName).sort();
    openModal(`
      <div class="doc">
        <span class="tag tag-${e.kind}">${esc(kindLabel(e.kind))}</span>${e.for_everyone ? ' <span class="tag">Everyone</span>' : ''}${e.owner_id ? ' <span class="muted">Only you can see this.</span>' : ''}
        <h2 style="margin-top:.4rem">${esc(e.title)}</h2>
        <dl class="details">
          <dt>When</dt><dd>${esc(fmtWhen(e.starts_at, e.ends_at, e.all_day))}</dd>
          ${e.kind === 'holiday' ? `<dt>Paid</dt><dd>${hrs(e.holiday_hours ?? 8)} hours (added to timesheets automatically)</dd>` : ''}
          ${e.location ? `<dt>Where</dt><dd>${esc(e.location)}</dd>` : ''}
          ${names.length ? `<dt>${e.kind === 'court' ? 'Deputies' : 'People'}</dt><dd>${names.map((n) => `<span class="chip ${tagged.includes(me()) && n === dirName(me()) ? '' : 'muted-chip'}">${esc(n)}</span>`).join(' ')}</dd>` : ''}
          ${e.details ? `<dt>Details</dt><dd>${multiline(e.details)}</dd>` : ''}
        </dl>
        <div class="actions">
          <button class="btn primary" id="ev-ics" type="button">Add to my calendar</button>
          ${(e.owner_id ? e.owner_id === me() : isManager()) ? '<button class="btn" id="ev-edit">Edit</button>' : ''}
        </div>
      </div>`);
    $('#ev-ics').onclick = (ev) => withBusy(ev.currentTarget, () => addToPhoneCalendar(e));
    $('#ev-edit')?.addEventListener('click', () => (e.owner_id ? editPersonal(e) : editEvent(e, tagged, people)));
  }

  // "Add to my calendar": a standard calendar file (.ics) that the phone's or computer's calendar
  // app opens, with its own reminder (1 hour before; 9 AM the day before for all-day events).
  function icsFor(e) {
    const pad = (n) => String(n).padStart(2, '0');
    const utc = (ts) => { const d = new Date(ts); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`; };
    const day = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const text = (v) => String(v || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    const fold = (line) => { const out = []; let l = line; while (l.length > 60) { out.push(l.slice(0, 60)); l = ' ' + l.slice(60); } out.push(l); return out.join('\r\n'); };
    const when = e.all_day
      ? [`DTSTART;VALUE=DATE:${day(new Date(e.starts_at))}`, `DTEND;VALUE=DATE:${day(addDays(new Date(e.ends_at || e.starts_at), 1))}`]
      : [`DTSTART:${utc(e.starts_at)}`, `DTEND:${utc(e.ends_at || new Date(new Date(e.starts_at).getTime() + 3600000))}`];
    const title = e.kind === 'court' ? `Court: ${e.title}` : e.title;
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CCSO//Employee Portal//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT', `UID:${e.id}@${location.hostname || 'ccsoportal.com'}`, `DTSTAMP:${utc(new Date())}`, ...when,
      `SUMMARY:${text(title)}`, e.location ? `LOCATION:${text(e.location)}` : '', e.details ? `DESCRIPTION:${text(e.details)}` : '',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(title)}`, e.all_day ? 'TRIGGER:-PT15H' : 'TRIGGER:-PT1H', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).map(fold).join('\r\n') + '\r\n';
  }
  async function addToPhoneCalendar(e) {
    // iPhone / iPad: Safari only offers "Add to Calendar" for a calendar file loaded from a real web
    // address, so get a 10-minute pass for this event and open the event-ics function with it
    if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
      const { data: t, error } = await sb.rpc('calendar_ticket', { p_kind: e.isJob ? 'job' : 'event', p_id: e.isJob ? (e.job?.id || e.id) : e.id });
      if (error) throw new Error('Couldn’t add it to your calendar right now. Try again in a moment.');
      location.href = `${cfg.SUPABASE_URL}/functions/v1/event-ics?t=${encodeURIComponent(t)}`;
      return;
    }
    // Computers and Android: download the calendar file, which opens in the calendar app
    const ics = icsFor(e);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    a.download = `${(e.title || 'event').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'event'}.ics`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // An off-duty job on the calendar: details, and a way to the Off-Duty Jobs tab to request it
  function openJobPeek(e) {
    const j = e.job;
    openModal(`
      <div class="doc">
        <span class="tag tag-offduty">Off-duty job</span>${e.mineJob ? ' <span class="tag tag-mine">You’re working it</span>' : ''}
        <h2 style="margin-top:.4rem">${esc(j.title)}</h2>
        <dl class="details">
          <dt>When</dt><dd>${esc(fmtWhen(j.starts_at, j.ends_at, false))}</dd>
          ${j.location ? `<dt>Where</dt><dd>${esc(j.location)}</dd>` : ''}
          ${j.pay ? `<dt>Pay</dt><dd>${esc(j.pay)}</dd>` : ''}
          <dt>Spots</dt><dd>${e.left ? `${e.left} of ${j.spots} open` : `All ${j.spots} filled`}</dd>
          ${j.details ? `<dt>Details</dt><dd>${multiline(j.details)}</dd>` : ''}
        </dl>
        <div class="actions">
          <button class="btn primary" id="go-offduty" type="button">${e.mineJob ? 'View on Off-Duty Jobs' : 'Request it on Off-Duty Jobs'}</button>
          ${e.mineJob ? '<button class="btn" id="ev-ics" type="button">Add to my calendar</button>' : ''}
        </div>
      </div>`);
    $('#go-offduty').onclick = () => { closeModal(); showView('offduty'); };
    $('#ev-ics')?.addEventListener('click', (ev) => withBusy(ev.currentTarget, () => addToPhoneCalendar({ ...e, id: j.id, title: `Off-duty: ${j.title}` })));
  }

  // A personal event: only its owner can see it (the database enforces this). No emails.
  function editPersonal(e) {
    const [sd, st] = toLocalInput(e.starts_at);
    const [ed, et] = toLocalInput(e.ends_at);
    openModal(`
      <h2>${e.id ? 'Edit my event' : 'Add my event'}</h2>
      <p class="hint">Only you can see this.</p>
      <form id="pe-form" autocomplete="off">
        <label>Title<input name="title" required maxlength="200" value="${esc(e.title || '')}" placeholder="e.g. Training, Vacation, To-Do, etc."></label>
        <label class="check"><input type="checkbox" name="all_day" ${e.all_day ? 'checked' : ''}><span>All day</span></label>
        <div class="row">
          <label>Date<input type="date" name="sd" required value="${sd}"></label>
          <label class="time-f">Start time<input type="time" name="st" value="${e.all_day ? '' : st || '09:00'}"></label>
          <label>End date<input type="date" name="ed" value="${e.id ? ed : ''}"></label>
          <label class="time-f">End time<input type="time" name="et" value="${e.all_day ? '' : et}"></label>
        </div>
        <label>Location<input name="location" value="${esc(e.location || '')}"></label>
        <label>Notes<textarea name="details" rows="3">${esc(e.details || '')}</textarea></label>
        <div class="actions">
          <button class="btn primary" type="submit">${e.id ? 'Save' : 'Add to my calendar'}</button>
          ${e.id ? '<button class="btn danger" type="button" id="pe-del">Delete</button>' : ''}
        </div>
      </form>`);
    const f = $('#pe-form');
    const syncAllDay = () => { $$('.time-f', f).forEach((l) => l.classList.toggle('hidden', f.all_day.checked)); };
    f.all_day.onchange = syncAllDay; syncAllDay();
    f.onsubmit = (ev) => {
      ev.preventDefault();
      withBusy(f.querySelector('button[type=submit]'), async () => {
        const allDay = f.all_day.checked;
        const row = {
          title: f.title.value.trim(), all_day: allDay,
          starts_at: fromLocalInput(f.sd.value, allDay ? '00:00' : f.st.value),
          ends_at: f.ed.value || (!allDay && f.et.value) ? fromLocalInput(f.ed.value || f.sd.value, allDay ? '23:59' : (f.et.value || f.st.value)) : null,
          location: f.location.value.trim() || null, details: f.details.value.trim() || null
        };
        if (!row.title) throw new Error('Give it a title.');
        if (row.ends_at && row.ends_at < row.starts_at) throw new Error('The end is before the start.');
        const r = e.id
          ? await sb.from('events').update({ ...row, updated_at: new Date().toISOString() }).eq('id', e.id)
          : await sb.from('events').insert({ ...row, kind: 'personal', owner_id: me(), created_by: me() });
        if (r.error) throw r.error;
        closeModal();
        toast(e.id ? 'Saved.' : 'Added to your calendar.');
        showView('calendar');
      });
    };
    $('#pe-del')?.addEventListener('click', (ev) => {
      if (!confirm('Delete this event?')) return;
      withBusy(ev.currentTarget, async () => {
        const r = await sb.from('events').delete().eq('id', e.id);
        if (r.error) throw r.error;
        closeModal();
        toast('Deleted.');
        showView('calendar');
      });
    });
  }

  function editEvent(e, tagged, people) {
    const [sd, st] = toLocalInput(e.starts_at);
    const [ed, et] = toLocalInput(e.ends_at);
    openModal(`
      <h2>${e.id ? 'Edit event' : 'Add event'}</h2>
      <form id="ev-form" autocomplete="off">
        <div class="row">
          <label class="narrow-role">Type<select name="kind">${EVENT_KINDS.map(([k, l]) => `<option value="${k}" ${k === e.kind ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Title<input name="title" required value="${esc(e.title || '')}" placeholder="e.g. Circuit/District Court, Firearms qualification, etc."></label>
        </div>
        <label class="check not-holiday"><input type="checkbox" name="all_day" ${e.all_day ? 'checked' : ''}><span>All day</span></label>
        <div class="holiday-only notice"><label style="margin:0">Paid holiday hours<input type="number" name="holiday_hours" min="0" max="24" step="0.25" value="${e.holiday_hours ?? 8}" style="max-width:110px"></label>
          <p class="hint" style="margin:.4rem 0 0">Shows on everyone’s calendar. These hours are filled in automatically as Holiday Hours on timesheets for that pay period (deputies can adjust before signing).</p></div>
        <div class="row">
          <label>Date<input type="date" name="sd" required value="${sd}"></label>
          <label class="time-f">Start time<input type="time" name="st" value="${e.all_day ? '' : st || '09:00'}"></label>
          <label>End date<input type="date" name="ed" value="${ed}"></label>
          <label class="time-f">End time<input type="time" name="et" value="${e.all_day ? '' : et}"></label>
        </div>
        <p class="hint" style="margin-top:-.5rem">For court, use the case number in the title, not names.</p>
        <label>Location<input name="location" value="${esc(e.location || '')}" placeholder="e.g. Courthouse, Courtroom B"></label>
        <label>Details<textarea name="details" rows="3">${esc(e.details || '')}</textarea></label>
        <div class="not-holiday">
        <label class="check"><input type="checkbox" name="for_everyone" ${e.for_everyone ? 'checked' : ''}><span><strong>Show to everyone</strong> (office-wide training, meeting…)</span></label>
        <label>Deputies on this (court subpoena, required training…)</label>
        ${peoplePicker(people, new Set(tagged))}
        <p class="hint" id="ev-vis"></p>
        </div>
        <label class="check not-everyone-email"><input type="checkbox" name="email_people" checked><span>Email the deputies on this (when added, or if the time or place changes)</span></label>
        <label class="check everyone-email"><input type="checkbox" name="email_all" checked><span><strong>Email everyone about this</strong> (when added, or if the date, time or place changes)</span></label>
        <div class="actions">
          <button class="btn primary" type="submit">${e.id ? 'Save' : 'Add to calendar'}</button>
          ${e.id ? '<button class="btn danger" type="button" id="ev-del">Delete</button>' : ''}
        </div>
      </form>`);
    const f = $('#ev-form');
    const isHoliday = () => f.kind.value === 'holiday';
    const syncAllDay = () => { $$('.time-f', f).forEach((l) => l.classList.toggle('hidden', f.all_day.checked || isHoliday())); };
    const syncKind = () => {
      $$('.holiday-only', f).forEach((x) => x.classList.toggle('hidden', !isHoliday()));
      $$('.not-holiday', f).forEach((x) => x.classList.toggle('hidden', isHoliday()));
      if (isHoliday() && !f.title.value.trim()) f.title.placeholder = 'e.g. Labor Day';
      syncAllDay();   // (changing Type also fires the form's change event, which refreshes the email boxes)
    };
    f.all_day.onchange = syncAllDay; f.kind.addEventListener('change', syncKind); syncKind();
    $$('[data-pick]', f).forEach((b) => {
      b.onclick = () => {
        $$('.people-picker input', f).forEach((c) => { c.checked = b.dataset.pick === 'all'; });
        syncVis();
      };
    });
    const syncVis = () => {
      const all = f.for_everyone.checked && !isHoliday();   // paid holidays never email
      $$('.everyone-email', f).forEach((x) => x.classList.toggle('hidden', !all));
      $$('.not-everyone-email', f).forEach((x) => x.classList.toggle('hidden', isHoliday() || (all && !$$('.people-picker input:checked', f).length)));
      const n = $$('.people-picker input:checked', f).length;
      $('.picker-count', f).textContent = `${n} of ${$$('.people-picker input', f).length} selected`;
      $('#ev-vis').textContent = f.for_everyone.checked ? 'Everyone will see this on their calendar.'
        : n ? `Only the ${n === 1 ? 'deputy' : `${n} deputies`} checked (and managers) will see this.`
        : 'Nobody is checked — only managers will see this. Check deputies or “Show to everyone”.';
    };
    f.addEventListener('change', syncVis); syncVis();
    f.onsubmit = (ev) => {
      ev.preventDefault();
      withBusy(f.querySelector('button[type=submit]'), async () => {
        const allDay = f.all_day.checked || isHoliday();
        const row = {
          kind: f.kind.value, title: f.title.value.trim(), all_day: allDay, for_everyone: f.for_everyone.checked || isHoliday(),
          holiday_hours: isHoliday() ? (Number(f.holiday_hours.value) || 0) : 8,
          starts_at: fromLocalInput(f.sd.value, allDay ? '00:00' : f.st.value),
          ends_at: f.ed.value || (!allDay && f.et.value) ? fromLocalInput(f.ed.value || f.sd.value, allDay ? '23:59' : (f.et.value || f.st.value)) : null,
          location: f.location.value.trim() || null, details: f.details.value.trim() || null
        };
        if (row.ends_at && row.ends_at < row.starts_at) throw new Error('The end is before the start.');
        let id = e.id;
        if (id) {
          const r = await sb.from('events').update({ ...row, updated_at: new Date().toISOString() }).eq('id', id);
          if (r.error) throw r.error;
        } else {
          const r = await sb.from('events').insert({ ...row, created_by: me() }).select('id').single();
          if (r.error) throw r.error;
          id = r.data.id;
        }
        const want = new Set(isHoliday() ? [] : $$('.people-picker input:checked', f).map((c) => c.value));
        const had = new Set(tagged);
        const add = [...want].filter((u) => !had.has(u)), del = [...had].filter((u) => !want.has(u));
        if (add.length) { const r = await sb.from('event_people').insert(add.map((user_id) => ({ event_id: id, user_id }))); if (r.error) throw r.error; }
        if (del.length) { const r = await sb.from('event_people').delete().eq('event_id', id).in('user_id', del); if (r.error) throw r.error; }
        const moved = e.id && (row.starts_at !== new Date(e.starts_at).toISOString() || (row.ends_at || null) !== (e.ends_at ? new Date(e.ends_at).toISOString() : null)
          || row.all_day !== !!e.all_day || (row.location || null) !== (e.location || null));
        if (isHoliday()) {
          // paid holidays: no emails
        } else if (row.for_everyone && f.email_all.checked) {
          // everyone gets it (this covers the tagged deputies too, so no second email)
          if (!e.id || !e.for_everyone) notify('event_tagged', id, { everyone: true });   // new, or just switched to "everyone"
          else if (moved) notify('event_changed', id, { everyone: true });
        } else if (f.email_people.checked && !isHoliday()) {
          if (add.length) notify('event_tagged', id, { user_ids: add });
          if (moved && [...want].some((u) => had.has(u))) notify('event_changed', id, { exclude_ids: add });
        }
        closeModal(); toast('Saved to calendar.');
        state.month = new Date(new Date(row.starts_at).getFullYear(), new Date(row.starts_at).getMonth(), 1);
        showView('calendar');
      });
    };
    if (e.id) $('#ev-del').onclick = (btn) => {
      if (!confirm(`Delete “${e.title}” from the calendar?`)) return;
      const tellAll = e.for_everyone && e.kind !== 'holiday' && confirm('Email everyone that it was removed?\n\nOK = email everyone · Cancel = delete without emailing');
      withBusy(btn.target, async () => {
        if (tellAll) await notify('event_deleted', e.id, { everyone: true });
        else if (tagged.length && !e.for_everyone && e.kind !== 'holiday') await notify('event_deleted', e.id);
        const r = await sb.from('events').delete().eq('id', e.id);
        if (r.error) throw r.error;
        closeModal(); toast('Deleted.'); showView('calendar');
      });
    };
  }

  function editAnnouncement(x) {
    openModal(`
      <h2>${x.id ? 'Edit' : 'Post'} announcement</h2>
      <form id="ann-form" autocomplete="off">
        <div class="row">
          <input type="hidden" name="kind" value="${esc(x.kind || 'general')}">
          <label>Title<input name="title" required value="${esc(x.title || '')}"></label>
        </div>
        <label>Message<textarea name="body" rows="6">${esc(x.body || '')}</textarea></label>
        <div class="row">
          <label>Show until (optional)<input type="date" name="show_until" value="${esc(x.show_until || '')}"></label>
          <label class="check" style="align-self:center"><input type="checkbox" name="pinned" ${x.pinned ? 'checked' : ''}><span>Pin to the top</span></label>
        </div>
        ${x.id ? '' : '<label class="check"><input type="checkbox" name="email_all"><span>Also email this to everyone</span></label>'}
        <p class="hint">Trainings, court dates and holidays go on the calendar with <strong>Add event</strong>.</p>
        <div class="actions">
          <button class="btn primary" type="submit">${x.id ? 'Save' : 'Post'}</button>
          ${x.id ? '<button class="btn danger" type="button" id="ann-del">Delete</button>' : ''}
        </div>
      </form>`);
    const f = $('#ann-form');
    f.onsubmit = (ev) => {
      ev.preventDefault();
      withBusy(f.querySelector('button[type=submit]'), async () => {
        const row = { kind: f.kind.value, title: f.title.value.trim(), body: f.body.value.trim(),
          show_until: f.show_until.value || null, pinned: f.pinned.checked };
        const r = x.id
          ? await sb.from('announcements').update({ ...row, updated_at: new Date().toISOString() }).eq('id', x.id)
          : await sb.from('announcements').insert({ ...row, posted_by: me() }).select('id').single();
        if (r.error) throw r.error;
        if (!x.id && f.email_all?.checked) notify('announcement', r.data.id);
        closeModal(); toast(x.id ? 'Saved.' : 'Posted.'); showView('calendar');
      });
    };
    if (x.id) $('#ann-del').onclick = (btn) => {
      if (!confirm('Delete this announcement?')) return;
      withBusy(btn.target, async () => {
        const r = await sb.from('announcements').delete().eq('id', x.id);
        if (r.error) throw r.error;
        closeModal(); toast('Deleted.'); showView('calendar');
      });
    };
  }

  /* ---------------- off-duty jobs ---------------- */
  const REQ_LABEL = { requested: 'Requested', approved: 'Approved', declined: 'Declined', withdrawn: 'Withdrawn' };
  views.offduty = async (el) => {
    const since = addDays(new Date(), -1).toISOString();
    const [people, jobsR, reqR] = await Promise.all([
      loadDirectory(),
      sb.from('offduty_jobs').select('*').gte('starts_at', since).order('starts_at'),
      sb.from('offduty_requests').select('*')
    ]);
    if (jobsR.error) throw jobsR.error;
    if (reqR.error) throw reqR.error;
    const reqs = {};
    reqR.data.forEach((r) => (reqs[r.job_id] ||= []).push(r));
    const jobs = jobsR.data;
    const upcoming = jobs.filter((j) => j.status !== 'cancelled');

    const jobCard = (j) => {
      const rs = reqs[j.id] || [];
      const approved = rs.filter((r) => r.status === 'approved');
      const pending = rs.filter((r) => r.status === 'requested');
      const mineR = rs.find((r) => r.user_id === me());
      const full = approved.length >= j.spots;
      const past = new Date(j.starts_at) < new Date();
      let action = '';
      if (!mineR || mineR.status === 'withdrawn') {
        action = j.status === 'open' && !past ? `<button class="btn primary small" data-req="${j.id}">${full ? 'Request (waitlist)' : 'Request this job'}</button>` : '';
      } else if (mineR.status === 'requested' || mineR.status === 'approved') {
        action = `<button class="btn small" data-withdraw="${mineR.id}" data-approved="${mineR.status === 'approved' ? 1 : ''}">Withdraw</button>`;
      }
      return `<article class="job ${full ? 'is-full' : ''} ${j.status !== 'open' ? 'is-closed' : ''}">
        <div class="job-main">
          <div class="job-title"><strong>${esc(j.title)}</strong>
            ${j.status === 'closed' ? '<span class="tag">Closed</span>' : ''}${j.status === 'cancelled' ? '<span class="tag tag-danger">Cancelled</span>' : ''}
            ${mineR && mineR.status !== 'withdrawn' ? `<span class="badge badge-${mineR.status === 'requested' ? 'pending' : mineR.status === 'declined' ? 'denied' : 'approved'}">${REQ_LABEL[mineR.status]}</span>` : ''}</div>
          <div class="muted">${esc(fmtWhen(j.starts_at, j.ends_at, false))}${j.location ? ` · ${esc(j.location)}` : ''}${j.pay ? ` · <strong class="pay">${esc(j.pay)}</strong>` : ''}</div>
          ${j.details ? `<div class="job-details">${multiline(j.details)}</div>` : ''}
          <div class="job-spots"><span class="spots ${full ? 'full' : ''}">${approved.length} of ${j.spots} spot${j.spots === 1 ? '' : 's'} filled</span>
            ${approved.length ? ` · ${approved.map((r) => `<span class="chip muted-chip">${esc(dirName(r.user_id))}</span>`).join(' ')}` : ''}</div>
          ${isManager() && pending.length ? `<div class="job-requests"><strong>Requests (${pending.length}):</strong>
            ${pending.map((r) => `<div class="req-row"><span>${esc(dirName(r.user_id))}${r.note ? ` <span class="muted">— ${esc(r.note)}</span>` : ''} <span class="muted">· ${esc(new Date(r.created_at).toLocaleString())}</span></span>
              ${canApproveTimeOff() ? `<span><button class="btn small primary" data-decide="${r.id}" data-to="approved" ${full ? 'disabled title="All spots are filled"' : ''}>Approve</button>
              <button class="btn small danger" data-decide="${r.id}" data-to="declined">Decline</button></span>` : ''}</div>`).join('')}</div>` : ''}
          ${isManager() && approved.length ? `<div class="job-requests muted-block">${approved.map((r) => `<div class="req-row"><span>✓ ${esc(dirName(r.user_id))}</span>${canApproveTimeOff() ? `<button class="btn-link small-link" data-decide="${r.id}" data-to="requested">Undo approval</button>` : ''}</div>`).join('')}</div>` : ''}
        </div>
        <div class="job-actions">${action}${isManager() ? `<button class="btn small" data-editjob="${j.id}">Edit</button>` : ''}</div>
      </article>`;
    };

    const myReqs = reqR.data.filter((r) => r.user_id === me() && r.status !== 'withdrawn');
    const jobById = Object.fromEntries(jobs.map((j) => [j.id, j]));

    el.innerHTML = `
      <section class="card">
        <div class="card-head"><h2>Off-duty jobs</h2>${isManager() ? '<button class="btn small primary" id="job-new">Post a job</button>' : ''}</div>
        <p class="hint">You’ll see “Approved” once you’re on a job.</p>
        ${upcoming.length ? upcoming.map(jobCard).join('') : '<p class="muted">No off-duty jobs posted right now.</p>'}
      </section>
      ${myReqs.length ? `<section class="card"><h2>My requests</h2>
        <div class="table-wrap"><table class="list"><thead><tr><th>Job</th><th>When</th><th>Status</th></tr></thead><tbody>
        ${myReqs.filter((r) => jobById[r.job_id]).map((r) => `<tr><td>${esc(jobById[r.job_id].title)}</td><td>${esc(fmtWhen(jobById[r.job_id].starts_at, jobById[r.job_id].ends_at, false))}</td>
          <td><span class="badge badge-${r.status === 'requested' ? 'pending' : r.status === 'declined' ? 'denied' : 'approved'}">${REQ_LABEL[r.status]}</span></td></tr>`).join('')}
        </tbody></table></div></section>` : ''}`;

    $$('[data-req]', el).forEach((b) => {
      b.onclick = () => {
        const note = prompt('Optional note for the manager (or leave blank):', '');
        if (note === null) return;
        withBusy(b, async () => {
          const existing = (reqs[b.dataset.req] || []).find((r) => r.user_id === me());
          const r = existing
            ? await sb.from('offduty_requests').update({ status: 'requested', note: note.trim() || null }).eq('id', existing.id).select('id').single()
            : await sb.from('offduty_requests').insert({ job_id: b.dataset.req, user_id: me(), note: note.trim() || null }).select('id').single();
          if (r.error) throw r.error;
          notify('offduty_request', r.data.id);
          toast('Request sent.'); showView('offduty');
        });
      };
    });
    $$('[data-withdraw]', el).forEach((b) => {
      b.onclick = () => {
        if (!confirm(b.dataset.approved ? 'You’re approved for this job. Withdraw anyway? Let your supervisor know.' : 'Withdraw your request?')) return;
        withBusy(b, async () => {
          const r = await sb.from('offduty_requests').update({ status: 'withdrawn' }).eq('id', b.dataset.withdraw);
          if (r.error) throw r.error;
          toast('Withdrawn.'); showView('offduty');
        });
      };
    });
    $$('[data-decide]', el).forEach((b) => {
      b.onclick = () => withBusy(b, async () => {
        const r = await sb.from('offduty_requests').update({ status: b.dataset.to }).eq('id', b.dataset.decide);
        if (r.error) throw r.error;
        if (b.dataset.to === 'approved' || b.dataset.to === 'declined') notify('offduty_decision', b.dataset.decide);
        toast(b.dataset.to === 'approved' ? 'Approved.' : b.dataset.to === 'declined' ? 'Declined.' : 'Moved back to requests.');
        showView('offduty');
      });
    });
    if (isManager()) {
      $('#job-new').onclick = () => editJob({ spots: 1, status: 'open' });
      $$('[data-editjob]', el).forEach((b) => { b.onclick = () => editJob(jobById[b.dataset.editjob]); });
    }
  };

  function editJob(j) {
    const [sd, st] = toLocalInput(j.starts_at);
    const [ed, et] = toLocalInput(j.ends_at);
    openModal(`
      <h2>${j.id ? 'Edit off-duty job' : 'Post an off-duty job'}</h2>
      <form id="job-form" autocomplete="off">
        <label>Job<input name="title" required value="${esc(j.title || '')}" placeholder="e.g. Football game security — Cleburne County High"></label>
        <div class="row">
          <label>Date<input type="date" name="sd" required value="${sd}"></label>
          <label>Start<input type="time" name="st" required value="${st}"></label>
          <label>End date<input type="date" name="ed" value="${ed}"></label>
          <label>End<input type="time" name="et" value="${et}"></label>
        </div>
        <div class="row">
          <label>Location<input name="location" value="${esc(j.location || '')}"></label>
          <label class="narrow-role">Pay<input name="pay" value="${esc(j.pay || '')}" placeholder="$35/hr"></label>
          <label class="narrow-role">Spots<input type="number" name="spots" min="1" max="50" required value="${j.spots || 1}"></label>
        </div>
        <label>Details<textarea name="details" rows="3" placeholder="Uniform, contact person, parking…">${esc(j.details || '')}</textarea></label>
        ${j.id ? '' : '<label class="check"><input type="checkbox" name="email_all" checked><span>Email everyone about this job</span></label>'}
        ${j.id ? `<label class="narrow-role">Status<select name="status">
          <option value="open" ${j.status === 'open' ? 'selected' : ''}>Open for requests</option>
          <option value="closed" ${j.status === 'closed' ? 'selected' : ''}>Closed (no new requests)</option>
          <option value="cancelled" ${j.status === 'cancelled' ? 'selected' : ''}>Cancelled</option></select></label>` : ''}
        <div class="actions">
          <button class="btn primary" type="submit">${j.id ? 'Save' : 'Post job'}</button>
          ${j.id ? '<button class="btn danger" type="button" id="job-del">Delete</button>' : ''}
        </div>
      </form>`);
    const f = $('#job-form');
    f.onsubmit = (ev) => {
      ev.preventDefault();
      withBusy(f.querySelector('button[type=submit]'), async () => {
        const row = {
          title: f.title.value.trim(), location: f.location.value.trim() || null, pay: f.pay.value.trim() || null,
          spots: Number(f.spots.value) || 1, details: f.details.value.trim() || null,
          starts_at: fromLocalInput(f.sd.value, f.st.value),
          ends_at: f.et.value ? fromLocalInput(f.ed.value || f.sd.value, f.et.value) : null
        };
        if (row.ends_at && row.ends_at < row.starts_at) row.ends_at = new Date(new Date(row.ends_at).getTime() + 86400000).toISOString(); // overnight
        if (f.status) row.status = f.status.value;
        const r = j.id
          ? await sb.from('offduty_jobs').update({ ...row, updated_at: new Date().toISOString() }).eq('id', j.id)
          : await sb.from('offduty_jobs').insert({ ...row, posted_by: me() }).select('id').single();
        if (r.error) throw r.error;
        if (!j.id && f.email_all?.checked) notify('offduty_new_job', r.data.id);
        closeModal(); toast(j.id ? 'Saved.' : 'Job posted.'); showView('offduty');
      });
    };
    if (j.id) $('#job-del').onclick = (btn) => {
      if (!confirm('Delete this job and all its requests? (To keep a record, set Status to Cancelled instead.)')) return;
      withBusy(btn.target, async () => {
        const r = await sb.from('offduty_jobs').delete().eq('id', j.id);
        if (r.error) throw r.error;
        closeModal(); toast('Deleted.'); showView('offduty');
      });
    };
  }

  /* ---------------- case numbers ---------------- */
  const CASES_PER_PAGE = 30;
  const KINDS = ['A', 'I/O'];
  const localToday = () => isoDate(new Date());
  const myInitials = () => (state.profile.full_name || '').split(/\s+/).filter(Boolean)
    .map((w) => w[0]).filter((c) => /[a-z]/i.test(c)).slice(0, 3).join('').toUpperCase();
  const cleanSearch = (s) => s.replace(/[,()*%\\"'.:]/g, ' ').trim();
  const canEditCase = (c) => isManager() || c.reserved_by === me();

  function caseQuery(cs, withCount) {
    let q = sb.from('case_numbers').select('*', withCount ? { count: 'exact' } : undefined).eq('year', cs.year);
    const s = cleanSearch(cs.q);
    if (s) q = q.or(['case_number', 'victim_defendant', 'charge', 'initials'].map((c) => `${c}.ilike.*${s}*`).join(','));
    return q;
  }

  views.cases = async (el) => {
    const cs = state.cases;
    const thisYear = new Date().getFullYear();
    cs.year = cs.year || thisYear;
    const from = cs.page * CASES_PER_PAGE;
    const [list, counter] = await Promise.all([
      caseQuery(cs, true).order('seq', { ascending: false }).range(from, from + CASES_PER_PAGE - 1),
      sb.from('case_counters').select('next_seq').eq('year', thisYear).maybeSingle()
    ]);
    if (list.error) throw list.error;
    if (counter.error) throw counter.error;
    const total = list.count || 0;
    const pages = Math.max(1, Math.ceil(total / CASES_PER_PAGE));
    if (cs.page >= pages && cs.page > 0) { cs.page = pages - 1; return views.cases(el); }
    const nextSeq = counter.data?.next_seq || 1;
    const years = [...Array(thisYear - 2024)].map((_, i) => thisYear - i);

    el.innerHTML = `
      <section class="card">
        <h2>Reserve a case number</h2>
        <form id="case-form" class="case-form" autocomplete="off">
          <div class="row">
            <label>Date<input type="date" name="case_date" value="${localToday()}" required></label>
            <label class="narrow">INTS<input name="initials" value="${esc(myInitials())}" maxlength="4" required></label>
            <label class="narrow">A – I/O<select name="kind"><option value=""></option>${KINDS.map((k) => `<option>${k}</option>`).join('')}</select></label>
          </div>
          <div class="row">
            <label>Victim / Defendant<input name="victim_defendant"></label>
            <label>Charge<input name="charge"></label>
          </div>
          <div class="actions">
            <button class="btn primary" type="submit">Reserve next case number</button>
            <span class="hint">Next up: about <strong>${esc(localToday().replace(/-/g, ''))}${String(nextSeq).padStart(4, '0')}</strong>. You can fill in details later.</span>
          </div>
        </form>
        <div id="case-result"></div>
      </section>

      <section class="card">
        <div class="case-log-head">
          <h2>Case number log</h2>
          <form id="case-search" class="row end">
            <label class="narrow">Year<select name="year">${years.map((y) => `<option ${y === cs.year ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
            <label>Search<input name="q" value="${esc(cs.q)}" placeholder="Case #, name, charge or initials"></label>
            <button class="btn" type="submit">Search</button>
            ${cs.q ? '<button class="btn" type="button" id="case-clear">Clear</button>' : ''}
          </form>
        </div>
        ${caseTable(list.data)}
        <div class="pager">
          <button class="btn small" id="pg-prev" ${cs.page === 0 ? 'disabled' : ''}>‹ Newer</button>
          <span>Page ${cs.page + 1} of ${pages} · ${total} number${total === 1 ? '' : 's'}${cs.q ? ' found' : ''}</span>
          <button class="btn small" id="pg-next" ${cs.page + 1 >= pages ? 'disabled' : ''}>Older ›</button>
          <button class="btn small" id="case-print">Print log</button>
        </div>
      </section>

      ${isManager() ? `<section class="card">
        <h2>Case number settings</h2>
        <form id="case-next" class="row end">
          <label>Next count for ${thisYear}<input type="number" name="next" min="1" step="1" value="${nextSeq}"></label>
          <button class="btn" type="submit">Save</button>
        </form>
        <p class="hint">The last 4 digits of the next number reserved. Set this right before you go live so numbering continues from your paper log — e.g. if the last number used was …0933, enter 934. It can only move forward.</p>
      </section>` : ''}`;

    $('#case-form').onsubmit = (e) => {
      e.preventDefault();
      const f = e.target;
      withBusy(f.querySelector('button[type=submit]'), async () => {
        const { data, error } = await sb.rpc('reserve_case_number', {
          p_case_date: f.case_date.value || null, p_initials: f.initials.value,
          p_victim_defendant: f.victim_defendant.value, p_kind: f.kind.value, p_charge: f.charge.value
        });
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        cs.q = ''; cs.page = 0; cs.year = thisYear;
        await showView('cases');
        $('#case-result').innerHTML = `<div class="case-result">
          <div>Your case number</div>
          <div class="case-big">${esc(row.case_number)}</div>
          <button class="btn small" id="case-copy">Copy</button></div>`;
        $('#case-copy').onclick = () => navigator.clipboard?.writeText(row.case_number).then(() => toast('Copied.'));
        $('#case-result').scrollIntoView({ block: 'nearest' });
      });
    };
    $('#case-search').onsubmit = (e) => {
      e.preventDefault();
      cs.q = e.target.q.value.trim(); cs.year = Number(e.target.year.value); cs.page = 0;
      showView('cases');
    };
    $('#case-search').year.onchange = () => $('#case-search').requestSubmit();
    if (cs.q) $('#case-clear').onclick = () => { cs.q = ''; cs.page = 0; showView('cases'); };
    $('#pg-prev').onclick = () => { cs.page--; showView('cases'); };
    $('#pg-next').onclick = () => { cs.page++; showView('cases'); };
    $('#case-print').onclick = (e) => printCaseLog(e.target, total);
    $$('[data-case]', el).forEach((b) => { b.onclick = () => openCase(list.data.find((c) => c.id === b.dataset.case)); });
    if (isManager()) {
      $('#case-next').onsubmit = (e) => {
        e.preventDefault();
        withBusy(e.target.querySelector('button'), async () => {
          const { error } = await sb.rpc('set_next_case_seq', { p_year: thisYear, p_next: Number(e.target.next.value) });
          if (error) throw error;
          toast('Saved.');
          showView('cases');
        });
      };
    }
  };

  function caseTable(rows) {
    if (!rows.length) return '<p class="muted">No case numbers yet.</p>';
    return `<div class="table-wrap"><table class="list case-log">
      <thead><tr><th>Date</th><th>INTS</th><th>Victim / Defendant</th><th>A – I/O</th><th>Charge</th><th class="num">Case #</th><th></th></tr></thead>
      <tbody>${rows.map((c) => `<tr class="${c.void ? 'is-void' : ''}">
        <td>${esc(fmtShort(c.case_date))}</td>
        <td>${esc(c.initials)}</td>
        <td>${esc(c.victim_defendant || '')}</td>
        <td>${esc(c.kind || '')}</td>
        <td>${c.void ? `<span class="badge badge-denied">Void</span> ${esc(c.void_reason || '')}` : esc(c.charge || '')}</td>
        <td class="num case-no">${esc(c.case_number)}</td>
        <td class="right">${canEditCase(c) ? `<button class="btn small" data-case="${c.id}">${c.void && !isManager() ? 'View' : 'Edit'}</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  function openCase(c) {
    const locked = c.void && !isManager();
    const dis = locked ? 'disabled' : '';
    openModal(`
      <div class="doc">
        <h2>Case # ${esc(c.case_number)} ${c.void ? '<span class="badge badge-denied">Void</span>' : ''}</h2>
        <p class="muted">Reserved ${esc(fmtDateTime(c.reserved_at))}${isManager() ? ` by ${esc(personName(c.reserved_by, c.initials))}` : ''}${c.updated_at ? ` · last changed ${esc(fmtDateTime(c.updated_at))}` : ''}</p>
        ${c.void ? `<div class="notice warn">Voided${c.voided_at ? ` ${esc(fmtDateTime(c.voided_at))}` : ''}${isManager() && c.voided_by ? ` by ${esc(personName(c.voided_by))}` : ''}: ${esc(c.void_reason || '')}</div>` : ''}
        <form id="case-edit" autocomplete="off">
          <div class="row">
            <label>Date<input type="date" name="case_date" value="${esc(c.case_date)}" required ${dis}></label>
            <label class="narrow">INTS<input name="initials" value="${esc(c.initials)}" maxlength="4" ${dis}></label>
            <label class="narrow">A – I/O<select name="kind" ${dis}><option value=""></option>${KINDS.map((k) => `<option ${k === c.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
          </div>
          <label>Victim / Defendant<input name="victim_defendant" value="${esc(c.victim_defendant || '')}" ${dis}></label>
          <label>Charge<input name="charge" value="${esc(c.charge || '')}" ${dis}></label>
          ${locked ? '' : '<button class="btn primary" type="submit">Save changes</button>'}
        </form>
        ${!c.void ? `<div class="review">
          <label>Void this number — reason (required)<input id="void-reason" placeholder="e.g. Reserved by mistake / duplicate"></label>
          <button class="btn danger" id="case-void">Void case number</button>
          <p class="hint">Voided numbers stay in the log and are never reused.</p>
        </div>` : ''}
        ${c.void && isManager() ? '<div class="review"><button class="btn" id="case-restore">Restore (un-void)</button></div>' : ''}
      </div>`);
    const save = (patch, msg, btn) => withBusy(btn, async () => {
      const { error } = await sb.from('case_numbers').update(patch).eq('id', c.id);
      if (error) throw error;
      closeModal(); toast(msg); showView('cases');
    });
    const f = $('#case-edit');
    f.onsubmit = (e) => {
      e.preventDefault();
      if (locked) return;
      save({ case_date: f.case_date.value, initials: f.initials.value, kind: f.kind.value || null,
        victim_defendant: f.victim_defendant.value.trim() || null, charge: f.charge.value.trim() || null },
        'Saved.', f.querySelector('button[type=submit]'));
    };
    if (!c.void) $('#case-void').onclick = (e) => {
      const reason = $('#void-reason').value.trim();
      if (!reason) return toast('Give a reason for voiding.', true);
      if (!confirm(`Void case number ${c.case_number}? It stays in the log marked VOID and won’t be reused.`)) return;
      save({ void: true, void_reason: reason }, 'Case number voided.', e.target);
    };
    if (c.void && isManager()) $('#case-restore').onclick = (e) => save({ void: false }, 'Restored.', e.target);
  }

  // Printed log: 30 numbers per page, same columns as the paper sheet
  async function printCaseLog(btn, total) {
    const cs = state.cases;
    if (!total) return toast('Nothing to print.', true);
    if (total > 600 && !confirm(`That’s ${total} numbers (${Math.ceil(total / CASES_PER_PAGE)} pages). Print them all?`)) return;
    withBusy(btn, async () => {
      const rows = [];
      for (let from = 0; from < total; from += 1000) {
        const { data, error } = await caseQuery(cs, false).order('seq', { ascending: true }).range(from, from + 999);
        if (error) throw error;
        rows.push(...data);
      }
      const pages = [];
      for (let i = 0; i < rows.length; i += CASES_PER_PAGE) pages.push(rows.slice(i, i + CASES_PER_PAGE));
      const title = `${ORG} — CASE NUMBERS ${cs.year}${cs.q ? ` — “${cs.q}”` : ''}`;
      openModal(`
        <div class="modal-head no-print"><strong>Case number log ${cs.year}</strong> · ${rows.length} numbers · ${pages.length} page${pages.length === 1 ? '' : 's'}
          <div class="actions"><button class="btn primary" id="print-btn">Print</button></div></div>
        <div class="print-area">${pages.map((pg, n) => `<div class="sheet-page">
          <div class="case-sheet">
            <div class="case-sheet-title"><span>${esc(title)}</span><span>Page ${n + 1} of ${pages.length}</span></div>
            <table>
              <colgroup><col style="width:15%"><col style="width:6%"><col style="width:29%"><col style="width:5%"><col style="width:25%"><col style="width:20%"></colgroup>
              <thead><tr><th>DATE</th><th>INTS</th><th>VICTIM/<br>DEFENDANT</th><th>A<br>I/O</th><th>CHARGE</th><th>CASE #</th></tr></thead>
              <tbody>${pg.map((c) => `<tr class="${c.void ? 'is-void' : ''}">
                <td class="r">${esc(fmtShort(c.case_date))}</td><td class="c">${esc(c.initials)}</td>
                <td>${esc(c.victim_defendant || '')}</td><td class="c">${esc(c.kind || '')}</td>
                <td class="sm">${c.void ? `VOID — ${esc(c.void_reason || '')}` : esc(c.charge || '')}</td>
                <td class="r">${esc(c.case_number)}</td></tr>`).join('')}
                ${'<tr><td></td><td></td><td></td><td></td><td></td><td></td></tr>'.repeat(CASES_PER_PAGE - pg.length)}</tbody>
            </table>
          </div></div>`).join('')}</div>`);
      $('#print-btn').onclick = () => window.print();
    });
  }

  /* ---------------- patrol stats ---------------- */
  // Typed in at the end of each shift. I/O reports are counted from case numbers.
  const STAT_TYPED = [
    ['felony_warrants', 'Felony warrants', 'served'],
    ['misd_warrants', 'Misd. / traffic warrants', 'served'],
    ['civil_papers', 'Civil papers', 'served'],
    ['felony_arrests', 'On-view arrests', 'felony'],
    ['misd_arrests', 'On-view arrests', 'misdemeanor']
  ];
  const STAT_ALL = [...STAT_TYPED, ['io_reports', 'I/O reports', 'from case numbers']];
  const STAT_SHORT = {
    felony_warrants: 'Fel. warrants', misd_warrants: 'Misd./traffic warr.', civil_papers: 'Civil papers',
    felony_arrests: 'Fel. arrests', misd_arrests: 'Misd. arrests', io_reports: 'I/Os'
  };
  const SHIFTS = ['A', 'B'];
  const canSeeStats = () => isManager() || !!state.profile?.patrol || !!state.profile?.is_supervisor;
  const statTotal = (r) => STAT_ALL.reduce((a, [k]) => a + (Number(r?.[k]) || 0), 0);
  const monthIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  const addMonths = (iso, n) => { const d = parseDate(iso); return monthIso(new Date(d.getFullYear(), d.getMonth() + n, 1)); };
  const monthName = (iso, withYear = true) => parseDate(iso).toLocaleDateString(undefined, withYear ? { month: 'long', year: 'numeric' } : { month: 'long' });

  function statsHeadCells() { return STAT_ALL.map(([k]) => `<th class="num">${esc(STAT_SHORT[k])}</th>`).join('') + '<th class="num">Total</th>'; }
  function statsCells(r) { return STAT_ALL.map(([k]) => `<td class="num">${Number(r[k]) || 0}</td>`).join('') + `<td class="num"><strong>${statTotal(r)}</strong></td>`; }

  views.stats = async (el) => {
    if (!canSeeStats()) { el.innerHTML = '<div class="card"><p class="muted">Stats are for patrol deputies.</p></div>'; return; }
    const st = state.stats || (state.stats = {});
    const thisMonth = monthIso(new Date());
    st.month = st.month || thisMonth;
    st.date = st.date || localToday();
    const month = st.month;
    const patrol = !!state.profile.patrol;
    const sup = !!state.profile.is_supervisor;
    const mgr = isManager();
    const rpc = async (name, m) => { const { data, error } = await sb.rpc(name, { p_month: m }); if (error) throw error; return data || []; };
    const [cur, prev, prev2, shifts, logged] = await Promise.all([
      rpc('patrol_stats_month', month),
      patrol ? rpc('patrol_stats_month', addMonths(month, -1)) : [],
      patrol ? rpc('patrol_stats_month', addMonths(month, -2)) : [],
      rpc('patrol_shift_totals', month),
      patrol ? sb.from('patrol_stats').select('*').eq('user_id', me()).gte('shift_date', month).lt('shift_date', addMonths(month, 1))
        .order('shift_date', { ascending: false }).then(({ data, error }) => { if (error) throw error; return data; }) : []
    ]);
    const mine = (list) => list.find((r) => r.user_id === me()) || {};
    const myCur = mine(cur), myPrev = mine(prev);
    const months = [...Array(12)].map((_, i) => addMonths(thisMonth, -i));
    const nameOf = (id) => cur.find((r) => r.user_id === id)?.full_name || personName(id, '');
    const byTotal = (a, b) => statTotal(b) - statTotal(a) || String(a.full_name).localeCompare(b.full_name);
    const underMe = cur.filter((r) => r.reports_to === me()).sort(byTotal);
    const everyone = [...cur].sort(byTotal);
    const myShift = state.profile.shift;

    const tiles = STAT_ALL.map(([k, label, sub]) => {
      const a = Number(myCur[k]) || 0, b = Number(myPrev[k]) || 0, d = a - b;
      return `<div class="stat-tile stat-${k}">
        <div class="stat-label">${esc(k === 'felony_arrests' || k === 'misd_arrests' ? `${label} (${sub})` : label)}</div>
        <div class="stat-value">${a}</div>
        <div class="stat-diff ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '▲ ' + d : d < 0 ? '▼ ' + -d : 'same'} vs ${esc(monthName(addMonths(month, -1), false))}</div>
      </div>`;
    }).join('');

    const deputyTable = (rows, showSup) => rows.length ? `<div class="table-wrap"><table class="list stats-table">
      <thead><tr><th>Deputy</th><th>Shift</th>${showSup ? '<th>Supervisor</th>' : ''}${statsHeadCells()}</tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.user_id === me() ? 'is-me' : ''}"><td>${esc(r.full_name)}${r.active === false ? ' <span class="muted">(deactivated)</span>' : ''}</td>
        <td>${esc(r.usual_shift || '—')}</td>${showSup ? `<td>${esc(r.reports_to ? nameOf(r.reports_to) : '—')}</td>` : ''}${statsCells(r)}</tr>`).join('')}</tbody>
    </table></div>` : '<p class="muted">No one to show yet.</p>';

    el.innerHTML = `
      <div class="stats-top">
        <h1>Stats</h1>
        <label class="stats-month">Month<select id="st-month">${months.map((m) => `<option value="${m}" ${m === month ? 'selected' : ''}>${esc(monthName(m))}</option>`).join('')}</select></label>
      </div>

      ${patrol ? `<section class="card">
        <h2>Log my shift</h2>
        <form id="st-form" autocomplete="off">
          <div class="row">
            <label>Shift date<input type="date" name="shift_date" value="${esc(st.date)}" max="${esc(isoDate(addDays(new Date(), 1)))}" required></label>
            <label>Shift worked<select name="shift">${SHIFTS.map((s) => `<option value="${s}">${s} Shift</option>`).join('')}</select></label>
          </div>
          <div class="stat-counters">
            ${STAT_TYPED.map(([k, label, sub]) => `<div class="stat-counter">
              <div class="stat-counter-label">${esc(label)}<small>${esc(sub)}</small></div>
              <div class="stepper">
                <button type="button" class="btn small st-step" data-k="${k}" data-d="-1" aria-label="One fewer ${esc(label)} ${esc(sub)}">−</button>
                <input type="number" name="${k}" min="0" max="99" step="1" inputmode="numeric" value="0" aria-label="${esc(label)} ${esc(sub)}">
                <button type="button" class="btn small st-step" data-k="${k}" data-d="1" aria-label="One more ${esc(label)} ${esc(sub)}">+</button>
              </div>
            </div>`).join('')}
            <div class="stat-counter auto">
              <div class="stat-counter-label">I/O reports<small>counted from your case numbers <span class="auto-tag">Auto</span></small></div>
              <div class="stat-auto-value" id="st-io">…</div>
            </div>
          </div>
          <div class="actions">
            <button class="btn primary" type="submit" id="st-save">Save shift</button>
            <span class="hint" id="st-note"></span>
          </div>
        </form>
      </section>

      <section class="card">
        <h2>My ${esc(monthName(month))}</h2>
        <div class="stat-tiles">${tiles}</div>
        <p class="hint">Numbers count toward the shift you worked. To fix an I/O count, fix the case number (void it or change A – I/O).</p>
      </section>

      <section class="card">
        <h2>My last 3 months</h2>
        <div class="table-wrap"><table class="list stats-table">
          <thead><tr><th>Month</th>${statsHeadCells()}</tr></thead>
          <tbody>${[[month, myCur], [addMonths(month, -1), myPrev], [addMonths(month, -2), mine(prev2)]].map(([m, r]) =>
            `<tr><td>${esc(monthName(m))}</td>${statsCells(r)}</tr>`).join('')}</tbody>
        </table></div>
      </section>

      <section class="card">
        <h2>Shifts I logged in ${esc(monthName(month, false))} <span class="count muted-count">${logged.length}</span></h2>
        ${logged.length ? `<div class="table-wrap"><table class="list stats-table">
          <thead><tr><th>Date</th><th>Shift</th>${STAT_TYPED.map(([k]) => `<th class="num">${esc(STAT_SHORT[k])}</th>`).join('')}<th></th></tr></thead>
          <tbody>${logged.map((r) => `<tr data-date="${esc(r.shift_date)}" data-id="${esc(r.id)}"><td>${esc(fmtDay(r.shift_date))} ${esc(fmtShort(r.shift_date))}</td><td>${esc(r.shift)}</td>
            ${STAT_TYPED.map(([k]) => `<td class="num">${Number(r[k]) || 0}</td>`).join('')}
            <td class="right nowrap"><button class="btn small st-edit">Edit</button><button class="btn small danger st-del">Delete</button></td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted">Nothing logged this month yet.</p>'}
      </section>` : ''}

      ${shifts.length || mgr ? `<section class="card">
        <h2>${mgr ? 'By shift' : 'My shift'}, ${esc(monthName(month))}</h2>
        ${shifts.length ? `<div class="table-wrap"><table class="list stats-table">
          <thead><tr><th>Shift</th>${statsHeadCells()}</tr></thead>
          <tbody>${shifts.map((r) => `<tr class="${r.shift === myShift ? 'is-me' : ''}"><td>${esc(r.shift)} Shift${r.shift === myShift ? ' (yours)' : ''}</td>${statsCells(r)}</tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted">Nothing logged for this month yet.</p>'}
        ${!mgr ? '<p class="hint">Your whole shift’s totals. Other deputies’ numbers aren’t shown.</p>' : ''}
      </section>` : (patrol && !myShift ? `<section class="card"><p class="muted">Ask a manager to set your shift (A or B) on the Team tab to see your shift’s totals.</p></section>` : '')}

      ${sup && !mgr ? `<section class="card">
        <h2>Deputies under me, ${esc(monthName(month))}</h2>
        ${deputyTable(underMe, false)}
        <p class="hint">Managers choose who reports to you on the Team tab.</p>
      </section>` : ''}

      ${mgr ? `<section class="card">
        <div class="case-log-head">
          <h2>Patrol deputies, ${esc(monthName(month))}</h2>
          <button class="btn small" id="st-csv" type="button">Download CSV</button>
        </div>
        ${deputyTable(everyone, true)}
        <p class="hint">Only people marked Patrol on the Team tab are counted.</p>
      </section>` : ''}`;

    $('#st-month').onchange = (e) => { st.month = e.target.value; showView('stats'); };

    if (mgr) {
      $('#st-csv').onclick = () => downloadCSV(`patrol-stats-${month.slice(0, 7)}.csv`, [
        ['Month', 'Deputy', 'Shift', 'Supervisor', ...STAT_ALL.map(([k]) => STAT_SHORT[k]), 'Total'],
        ...everyone.map((r) => [month.slice(0, 7), r.full_name, r.usual_shift || '', r.reports_to ? nameOf(r.reports_to) : '',
          ...STAT_ALL.map(([k]) => Number(r[k]) || 0), statTotal(r)])
      ]);
    }

    if (!patrol) return;
    const f = $('#st-form');
    const note = $('#st-note');
    const byDate = Object.fromEntries(logged.map((r) => [r.shift_date, r]));

    async function loadDate(date) {
      st.date = date;
      let row = byDate[date];
      if (!row && date) {
        const { data, error } = await sb.from('patrol_stats').select('*').eq('user_id', me()).eq('shift_date', date).maybeSingle();
        if (error) throw error;
        row = data;
      }
      f.shift.value = row?.shift || myShift || 'A';
      STAT_TYPED.forEach(([k]) => { f[k].value = row ? Number(row[k]) || 0 : 0; });
      note.textContent = row ? 'Already saved for this date. Saving again replaces it.' : '';
      $('#st-io').textContent = '…';
      const { count, error } = await sb.from('case_numbers').select('id', { count: 'exact', head: true })
        .eq('reserved_by', me()).eq('case_date', date).eq('kind', 'I/O').eq('void', false);
      if (f.shift_date.value !== date) return;   // picked another date meanwhile
      $('#st-io').textContent = error ? '?' : String(count || 0);
    }
    const safeLoad = (date) => loadDate(date).catch((err) => toast(err.message || String(err), true));
    safeLoad(st.date);
    f.shift_date.onchange = () => { if (f.shift_date.value) safeLoad(f.shift_date.value); };

    $$('.st-step', f).forEach((b) => {
      b.onclick = () => {
        const inp = f[b.dataset.k];
        inp.value = Math.min(99, Math.max(0, (parseInt(inp.value, 10) || 0) + Number(b.dataset.d)));
      };
    });

    f.onsubmit = (e) => {
      e.preventDefault();
      const row = { user_id: me(), shift_date: f.shift_date.value, shift: f.shift.value };
      for (const [k, label, sub] of STAT_TYPED) {
        const v = Number(f[k].value);
        if (!Number.isInteger(v) || v < 0 || v > 99) { toast(`${label} (${sub}) must be a whole number from 0 to 99.`, true); return; }
        row[k] = v;
      }
      if (!row.shift_date) { toast('Pick the shift date.', true); return; }
      withBusy($('#st-save'), async () => {
        const { error } = await sb.from('patrol_stats').upsert(row, { onConflict: 'user_id,shift_date' });
        if (error) throw error;
        toast(`Saved ${fmtShort(row.shift_date)}.`);
        st.month = monthIso(parseDate(row.shift_date));
        st.date = row.shift_date;
        showView('stats');
      });
    };

    $$('.st-edit', el).forEach((b) => {
      b.onclick = () => {
        const date = b.closest('tr').dataset.date;
        f.shift_date.value = date;
        safeLoad(date);
        f.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });
    $$('.st-del', el).forEach((b) => {
      b.onclick = () => {
        const tr = b.closest('tr');
        if (!confirm(`Delete the stats you logged for ${fmtShort(tr.dataset.date)}?`)) return;
        withBusy(b, async () => {
          const { error } = await sb.from('patrol_stats').delete().eq('id', tr.dataset.id);
          if (error) throw error;
          toast('Deleted.');
          if (st.date === tr.dataset.date) st.date = localToday();
          showView('stats');
        });
      };
    });
  };

  /* ---------------- manager: audit log ---------------- */
  const AUDIT_AREAS = [
    ['timesheets', 'Timesheet'], ['time_off_requests', 'Time off'], ['case_numbers', 'Case number'],
    ['case_counters', 'Case number setting'], ['offduty_jobs', 'Off-duty job'], ['offduty_requests', 'Off-duty request'],
    ['events', 'Calendar event'], ['event_people', 'Calendar tag'], ['announcements', 'Announcement'],
    ['profiles', 'Person'], ['duties', 'Special duty'], ['profile_duties', 'Duty assignment'], ['patrol_stats', 'Patrol stats'],
    ['comp_adjustments', 'Comp adjustment']
  ];
  const AUDIT_PER_PAGE = 50;
  const areaLabel = (t) => (AUDIT_AREAS.find(([k]) => k === t) || [t, t])[1];
  const FIELD_LABELS = {
    status: 'Status', manager_note: 'Manager note', full_name: 'Name', role: 'Role', active: 'Active',
    entries: 'Time entries', total_hours: 'Hours worked', total_paid_hours: 'Hours to be paid', vacation_hours: 'Vacation',
    holiday_hours: 'Holiday', sick_hours: 'Sick', duty_hours: 'Special-duty hours', signed_name: 'Signed name',
    victim_defendant: 'Victim/Defendant', charge: 'Charge', kind: 'Type', case_date: 'Date', initials: 'INTS',
    void: 'Void', void_reason: 'Void reason', starts_at: 'Starts', ends_at: 'Ends', location: 'Location',
    title: 'Title', details: 'Details', spots: 'Spots', pay: 'Pay', next_seq: 'Next count', for_everyone: 'Show to everyone',
    start_date: 'First day', end_date: 'Last day', reason: 'Reason', note: 'Note', signature: 'Signature',
    shift_date: 'Shift date', shift: 'Shift', felony_warrants: 'Felony warrants', misd_warrants: 'Misd./traffic warrants',
    civil_papers: 'Civil papers', felony_arrests: 'On-view arrests (felony)', misd_arrests: 'On-view arrests (misd.)',
    patrol: 'Patrol', is_supervisor: 'Supervisor', reports_to: 'Reports to', user_id: 'Person', hours: 'Hours', type: 'Type'
  };
  const HIDDEN_FIELDS = ['id', 'created_at', 'reviewed_by', 'reviewed_at', 'decided_by', 'decided_at', 'voided_by', 'voided_at',
    'signed_at', 'reserved_at', 'year', 'seq', 'sort', 'posted_by', 'created_by', 'k9_hours', 'traffic_ot_hours', 'notes'];
  function auditValue(v) {
    if (v === null || v === undefined || v === '') return '<span class="muted">—</span>';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (Array.isArray(v)) {
      if (v.length && v[0] && v[0].date) return esc(v.map((e) => `${fmtShort(e.date)} ${clock(e.in) || ''}${e.out ? '–' + clock(e.out) : ''}${e.explanation ? ' (' + e.explanation + ')' : ''}`).join('; '));
      if (v.length && v[0] && 'hours' in v[0]) return esc(v.map((d) => `${d.name}: ${hrs(d.hours)}`).join(', '));
      return esc(JSON.stringify(v));
    }
    if (typeof v === 'object') return esc(JSON.stringify(v));
    const s = String(v);
    if (/^\d{4}-\d\d-\d\dT/.test(s)) return esc(fmtDateTime(s));
    if (state.people[s]) return esc(personName(s));
    return esc(s.length > 300 ? s.slice(0, 300) + '…' : s);
  }
  function auditSummary(r) {
    const c = r.changes || {};
    const what = areaLabel(r.table_name);
    const lbl = r.label ? ` “${r.table_name === 'timesheets' ? periodLabel(r.label) : r.label}”` : '';
    if (r.action === 'insert') return `Created ${what.toLowerCase()}${lbl}`;
    if (r.action === 'delete') return `Deleted ${what.toLowerCase()}${lbl}`;
    if (c.status) return `${what}${lbl}: ${c.status.old} → ${c.status.new}`;
    if (c.void) return `${what}${lbl}: ${c.void.new ? 'voided' : 'restored'}`;
    if (c.active) return `${what}${lbl}: ${c.active.new ? 'reactivated' : 'deactivated'}`;
    if (c.role) return `${what}${lbl}: role ${c.role.old} → ${c.role.new}`;
    const fields = Object.keys(c).filter((k) => !HIDDEN_FIELDS.includes(k)).map((k) => FIELD_LABELS[k] || k);
    return `Changed ${what.toLowerCase()}${lbl}${fields.length ? ': ' + fields.join(', ') : ''}`;
  }
  function auditDetails(r) {
    const c = r.changes || {};
    const keys = Object.keys(c).filter((k) => !HIDDEN_FIELDS.includes(k));
    if (!keys.length) return '<p class="muted">No other details.</p>';
    if (r.action === 'update') {
      return `<table class="audit-diff"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>${keys.map((k) =>
        `<tr><td>${esc(FIELD_LABELS[k] || k)}</td><td>${auditValue(c[k].old)}</td><td>${auditValue(c[k].new)}</td></tr>`).join('')}</tbody></table>`;
    }
    return `<table class="audit-diff"><thead><tr><th>Field</th><th>${r.action === 'delete' ? 'Value when deleted' : 'Value'}</th></tr></thead><tbody>${keys.map((k) =>
      `<tr><td>${esc(FIELD_LABELS[k] || k)}</td><td>${auditValue(c[k])}</td></tr>`).join('')}</tbody></table>`;
  }

  views.audit = async (el) => {
    const f = state.audit;
    const people = await loadPeople();
    let q = sb.from('audit_log').select('*', { count: 'exact' });
    if (f.actor) q = f.actor === 'system' ? q.is('actor', null) : q.eq('actor', f.actor);
    if (f.subject) q = q.eq('subject', f.subject);
    if (f.area) q = q.eq('table_name', f.area);
    if (f.from) q = q.gte('at', new Date(`${f.from}T00:00`).toISOString());
    if (f.to) q = q.lt('at', addDays(parseDate(f.to), 1).toISOString());
    const from = f.page * AUDIT_PER_PAGE;
    const { data, error, count } = await q.order('at', { ascending: false }).range(from, from + AUDIT_PER_PAGE - 1);
    if (error) throw error;
    const total = count || 0, pages = Math.max(1, Math.ceil(total / AUDIT_PER_PAGE));
    const personOpts = (sel, extra = '') => `<option value="">Anyone</option>${extra}${people.map((p) =>
      `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.full_name || p.email)}${p.active === false ? ' (deactivated)' : ''}</option>`).join('')}`;

    el.innerHTML = `
      <section class="card">
        <h2>Database setup</h2>
        <p class="muted">Download every table, function and security rule as one SQL file, as a backup or to share for review. It contains no records.</p>
        <button class="btn" type="button" id="db-export">Download database setup</button>
      </section>
      <section class="card">
        <h2>Audit log</h2>
        <p class="muted">Every change made in the portal, recorded by the database. Entries can’t be edited or deleted.</p>
        <form id="audit-f" class="row end audit-filters">
          <label>Done by<select name="actor">${personOpts(f.actor, `<option value="system" ${f.actor === 'system' ? 'selected' : ''}>Supabase dashboard / system</option>`)}</select></label>
          <label>About person<select name="subject">${personOpts(f.subject)}</select></label>
          <label>Area<select name="area"><option value="">All areas</option>${AUDIT_AREAS.map(([k, l]) => `<option value="${k}" ${k === f.area ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>From<input type="date" name="from" value="${esc(f.from)}"></label>
          <label>To<input type="date" name="to" value="${esc(f.to)}"></label>
          <button class="btn" type="submit">Filter</button>
          ${f.actor || f.subject || f.area || f.from || f.to ? '<button class="btn" type="button" id="audit-clear">Clear</button>' : ''}
        </form>
        ${data.length ? `<div class="table-wrap"><table class="list audit">
          <thead><tr><th>When</th><th>Done by</th><th>About</th><th>What happened</th><th></th></tr></thead>
          <tbody>${data.map((r) => `<tr class="audit-row">
            <td class="nowrap">${esc(fmtDateTime(r.at))}</td>
            <td>${r.actor ? esc(r.actor_name || personName(r.actor, 'Unknown')) : '<span class="muted">Dashboard / system</span>'}</td>
            <td>${r.subject ? esc(personName(r.subject, '—')) : '<span class="muted">—</span>'}</td>
            <td class="audit-what"><span class="tag tag-${r.action}">${esc(r.action)}</span> ${esc(auditSummary(r))}</td>
            <td class="right"><button class="btn small" data-audit="${r.id}">Details</button></td>
          </tr><tr class="audit-detail hidden" id="ad-${r.id}"><td colspan="5">${auditDetails(r)}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted">Nothing found.</p>'}
        <div class="pager">
          <button class="btn small" id="au-prev" ${f.page === 0 ? 'disabled' : ''}>‹ Newer</button>
          <span>Page ${f.page + 1} of ${pages} · ${total} entr${total === 1 ? 'y' : 'ies'}</span>
          <button class="btn small" id="au-next" ${f.page + 1 >= pages ? 'disabled' : ''}>Older ›</button>
        </div>
      </section>`;

    const form = $('#audit-f');
    form.onsubmit = (e) => {
      e.preventDefault();
      Object.assign(f, { actor: form.actor.value, subject: form.subject.value, area: form.area.value,
        from: form.from.value, to: form.to.value, page: 0 });
      showView('audit');
    };
    ['actor', 'subject', 'area'].forEach((n) => { form[n].onchange = () => form.requestSubmit(); });
    if ($('#audit-clear')) $('#audit-clear').onclick = () => { Object.assign(f, { actor: '', subject: '', area: '', from: '', to: '', page: 0 }); showView('audit'); };
    $('#db-export').onclick = (e) => withBusy(e.currentTarget, async () => {
      const { data: sql, error: err } = await sb.rpc('export_db_setup');
      if (err) throw err;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([sql], { type: 'text/plain' }));
      a.download = `database-setup-${new Date().toISOString().slice(0, 10)}.sql`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('#au-prev').onclick = () => { f.page--; showView('audit'); };
    $('#au-next').onclick = () => { f.page++; showView('audit'); };
    $$('[data-audit]', el).forEach((b) => {
      b.onclick = () => {
        const row = $(`#ad-${b.dataset.audit}`);
        row.classList.toggle('hidden');
        b.textContent = row.classList.contains('hidden') ? 'Details' : 'Hide';
      };
    });
  };

  /* ---------------- manager: team & special duties ---------------- */
  views.team = async (el) => {
    const [people, duties, assigns] = await Promise.all([loadPeople(), loadDuties(), loadAssignments()]);
    const has = new Set(assigns.map((a) => `${a.user_id}|${a.duty_id}`));
    const active = duties.filter((d) => d.active);
    const current = people.filter((p) => p.active !== false);
    const former = people.filter((p) => p.active === false);
    const supervisors = current.filter((p) => p.is_supervisor);
    const tf = state.teamFilter || (state.teamFilter = { q: '', show: '' });
    const nameOf = (id) => state.people[id]?.full_name || state.people[id]?.email || '';

    const dutyChipsFor = (p) => active.filter((d) => !d.everyone && has.has(`${p.id}|${d.id}`))
      .map((d) => `<span class="chip">${esc(d.name)}</span>`).join(' ');
    const patrolText = (p) => p.patrol
      ? `<span>${p.shift ? esc(p.shift) + ' Shift' : '<span class="error-text">No shift</span>'}${p.reports_to ? ` · <span class="muted">${esc(nameOf(p.reports_to))}</span>` : ''}</span>`
      : '<span class="muted">—</span>';
    const roleText = (p) => `<span>${p.role === 'manager' ? 'Manager' : 'Employee'}${on('stats') && p.is_supervisor ? ' <span class="chip muted-chip">Supervisor</span>' : ''}</span>`;
    const matches = (p) => {
      const q = tf.q.trim().toLowerCase();
      if (q && !`${p.full_name} ${p.email}`.toLowerCase().includes(q)) return false;
      if (tf.show === 'patrol') return !!p.patrol;
      if (tf.show === 'nonpatrol') return !p.patrol;
      if (tf.show === 'supervisor') return !!p.is_supervisor;
      if (tf.show === 'manager') return p.role === 'manager';
      if (tf.show === 'nosup') return p.patrol && !p.reports_to;
      return true;
    };
    const SHOW = on('stats') ? [['', 'Everyone'], ['patrol', 'Patrol'], ['nonpatrol', 'Not patrol'], ['supervisor', 'Supervisors'],
                  ['manager', 'Managers'], ['nosup', 'Patrol with no supervisor']] : [['', 'Everyone'], ['manager', 'Managers']];

    el.innerHTML = `
      <section class="card">
        <details class="fold">
          <summary><h2>Invite someone</h2></summary>
          <form id="invite-form" class="row end" autocomplete="off">
            <label>Full name<input name="full_name" required placeholder="e.g. John Doe"></label>
            <label>Email<input type="email" name="email" required placeholder="name@example.com"></label>
            <label class="narrow-role">Role<select name="role"><option value="employee">Employee</option><option value="manager">Manager</option></select></label>
            <button class="btn primary" type="submit">Send invite</button>
          </form>
          <p class="hint">They’ll get an email to set their password. Then click <strong>Edit</strong> next to their name to set duties, patrol and shift.</p>
        </details>
      </section>

      <section class="card">
        <h2>Team <span class="count muted-count">${current.length}</span></h2>
        <div class="filter-bar team-filter">
          <label>Find<input id="tm-q" type="search" placeholder="Name or email" value="${esc(tf.q)}"></label>
          <label>Show<select id="tm-show">${SHOW.map(([k, l]) => `<option value="${k}" ${tf.show === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>
        <div class="table-wrap"><table class="list team-list">
          <thead><tr><th>Name</th><th>Role</th>${on('stats') ? '<th>Patrol</th>' : ''}<th>Special duties</th><th></th></tr></thead>
          <tbody>${current.map((p) => `<tr data-id="${p.id}">
            <td><div class="tm-name">${esc(p.full_name || '(no name)')}</div><div class="tm-email">${esc(p.email)}</div></td>
            <td>${roleText(p)}</td>
            ${on('stats') ? `<td>${patrolText(p)}</td>` : ''}
            <td class="tm-duties">${dutyChipsFor(p) || '<span class="muted">—</span>'}</td>
            <td class="right"><button class="btn small p-edit">Edit</button></td>
          </tr>`).join('')}</tbody>
        </table></div>
        <p class="muted hint" id="tm-none" hidden>No one matches.</p>
        <p class="hint">When someone leaves, open <strong>Edit</strong> and click <strong>Deactivate</strong> (don’t delete them in Supabase — that would lose their records).</p>
      </section>

      ${former.length ? `<section class="card">
        <details class="fold">
          <summary><h2>Deactivated <span class="count muted-count">${former.length}</span></h2></summary>
          <p class="muted">These people can’t sign in to see or submit anything. Their timesheets and time off are kept — find them on the Approvals tab with <strong>Show person</strong>.</p>
          <div class="table-wrap"><table class="list">
            <thead><tr><th>Name</th><th>Email</th><th>Deactivated</th><th></th></tr></thead>
            <tbody>${former.map((p) => `<tr data-id="${p.id}">
              <td>${esc(p.full_name)}</td><td class="muted">${esc(p.email)}</td>
              <td>${esc(fmtDateTime(p.deactivated_at))}</td>
              <td class="right"><button class="btn small p-reactivate" data-name="${esc(p.full_name || p.email)}">Reactivate</button></td>
            </tr>`).join('')}</tbody>
          </table></div>
        </details>
      </section>` : ''}

      <section class="card">
        <details class="fold">
          <summary><h2>Special duties setup</h2></summary>
          <p class="muted">Grant and automatic overtime lines such as K9, DEA or Supervisor. <strong>Timesheet line</strong> and <strong>Note</strong> print on the timesheet. <strong>Auto hours</strong> are filled in for the person each pay period (they can change them). <strong>Everyone</strong> shows the line on every timesheet. Untick <strong>Paid</strong> for lines that print but aren’t added to Total Hours To Be Paid (like Comp Time Earned). Turn off <strong>Active</strong> to retire a duty — past timesheets keep it. Give people a duty with <strong>Edit</strong> next to their name.</p>
          <div class="table-wrap"><table class="list duties">
            <thead><tr><th>Short name</th><th>Timesheet line</th><th>Note</th><th>Auto hours</th><th>Everyone</th><th>Paid</th><th>Active</th><th></th></tr></thead>
            <tbody>
              ${duties.map((d) => dutyRow(d)).join('')}
              ${dutyRow({ id: '', name: '', label: '', note: '', default_hours: 0, everyone: false, paid: true, active: true })}
            </tbody>
          </table></div>
        </details>
      </section>`;

    // Search / filter without reloading
    const applyFilter = () => {
      let shown = 0;
      $$('.team-list tbody tr', el).forEach((tr) => {
        const ok = matches(state.people[tr.dataset.id] || {});
        tr.hidden = !ok;
        if (ok) shown++;
      });
      $('#tm-none').hidden = shown > 0;
    };
    $('#tm-q').oninput = (e) => { tf.q = e.target.value; applyFilter(); };
    $('#tm-show').onchange = (e) => { tf.show = e.target.value; applyFilter(); };
    applyFilter();

    $('#invite-form').onsubmit = (e) => {
      e.preventDefault();
      const f = e.target;
      withBusy(f.querySelector('button'), async () => {
        const { data, error } = await sb.functions.invoke('invite-user', {
          body: { email: f.email.value, full_name: f.full_name.value, role: f.role.value,
                  redirect_to: location.origin + location.pathname }
        });
        if (error) throw new Error(await functionError(error, 'invite-user'));
        if (data?.error) throw new Error(data.error);
        toast(`Invite sent to ${f.email.value}.`);
        showView('team');
      });
    };

    // One person's settings, in a pop-up
    const editPerson = (p) => {
      const self = p.id === me();
      const dutyBoxes = active.length ? active.map((d) => d.everyone
        ? `<span class="chip muted-chip" title="Shown on everyone’s timesheet">${esc(d.name)} (all)</span>`
        : `<label class="chip-check"><input type="checkbox" data-duty="${d.id}" ${has.has(`${p.id}|${d.id}`) ? 'checked' : ''}><span>${esc(d.name)}</span></label>`).join('')
        : '<span class="muted">None set up yet (see Special duties setup).</span>';
      const lockApprover = !!p.timeoff_approver && !canSetApprovers();   // e.g. a clerk editing the sheriff
      openModal(`
        <h2 class="modal-head">${esc(p.full_name || p.email)}</h2>
        <form id="person-form" autocomplete="off">
          <div class="row">
            <label>Name (prints on timesheets)<input name="full_name" value="${esc(p.full_name)}" required></label>
            <label>Role<select name="role" ${self ? 'disabled title="You can’t change your own role"' : lockApprover ? 'disabled title="Only the sheriff or chief deputy can change this"' : ''}>
              <option value="employee" ${p.role === 'employee' ? 'selected' : ''}>Employee</option>
              <option value="manager" ${p.role === 'manager' ? 'selected' : ''}>Manager</option>
            </select></label>
          </div>
          <p class="muted" style="margin-top:-.4rem">${esc(p.email)}</p>

          <fieldset class="person-set" id="person-usual">
            <legend>Usual hours</legend>
            ${usualPicker(p.usual_in, p.usual_out)}
            <p class="hint">Shows at the top of the Time in list on their timesheet, so one pick fills in their shift. They can change it too.</p>
          </fieldset>

          <fieldset class="person-set">
            <legend>Special duties</legend>
            <div class="duty-checks">${dutyBoxes}</div>
          </fieldset>

          ${compPerPerson && 'comp_time' in p ? `<fieldset class="person-set">
            <legend>Comp time</legend>
            <label class="check"><input type="checkbox" name="comp_time" ${p.comp_time ? 'checked' : ''}> <span><strong>Has comp time</strong> — can log comp time earned, see their balance and use comp time off.</span></label>
          </fieldset>` : ''}

          ${'timeoff_approver' in p ? `<fieldset class="person-set">
            <legend>Time off</legend>
            <label class="check"><input type="checkbox" name="timeoff_approver" ${p.timeoff_approver ? 'checked' : ''} ${canSetApprovers() ? '' : 'disabled'}> <span><strong>Approves time off</strong> — gets an email for every time-off request and every off-duty job request. When anyone is ticked, only they can approve or deny time off (e.g. the sheriff and chief deputy). Managers only.${canSetApprovers() ? '' : ' <em>Only the sheriff or chief deputy can change this.</em>'}</span></label>
          </fieldset>` : ''}

          <fieldset class="person-set" ${on('stats') ? '' : 'hidden'}>
            <legend>Patrol stats</legend>
            <label class="check"><input type="checkbox" name="patrol" ${p.patrol ? 'checked' : ''}> <span><strong>Patrol</strong> — logs stats and shows up in them</span></label>
            <div class="row">
              <label>Shift<select name="shift"><option value="">No shift</option>${SHIFTS.map((x) => `<option value="${x}" ${p.shift === x ? 'selected' : ''}>${x} Shift</option>`).join('')}</select></label>
              <label>Supervisor<select name="reports_to"><option value="">No supervisor</option>${supervisors.filter((x) => x.id !== p.id).map((x) =>
                `<option value="${x.id}" ${p.reports_to === x.id ? 'selected' : ''}>${esc(x.full_name || x.email)}</option>`).join('')}</select></label>
            </div>
            <label class="check"><input type="checkbox" name="is_supervisor" ${p.is_supervisor ? 'checked' : ''}> <span><strong>Supervisor</strong> — sees the stats of deputies who report to them</span></label>
          </fieldset>

          <div class="actions">
            <button class="btn primary" type="submit">Save</button>
            <button class="btn" type="button" id="person-cancel">Cancel</button>
            ${self || lockApprover ? '' : `<button class="btn danger" type="button" id="person-deactivate" style="margin-left:auto">Deactivate</button>`}
          </div>
        </form>`);

      const f = $('#person-form');
      bindUsualPicker($('#person-usual'));
      $('#person-cancel').onclick = closeModal;
      f.onsubmit = (e) => {
        e.preventDefault();
        const update = {
          full_name: f.full_name.value.trim(),
          patrol: f.patrol.checked,
          shift: f.shift.value || null,
          is_supervisor: f.is_supervisor.checked,
          reports_to: f.reports_to.value || null
        };
        if (!self && !lockApprover) update.role = f.role.value;
        if (f.comp_time) update.comp_time = f.comp_time.checked;
        if (f.timeoff_approver && !f.timeoff_approver.disabled) {
          update.timeoff_approver = f.timeoff_approver.checked;
          if (update.timeoff_approver && (update.role || p.role) !== 'manager') { toast('Only managers can approve time off. Change their role to Manager first.', true); return; }
        }
        let usual;
        try { usual = readUsualPicker($('#person-usual')); } catch (err) { toast(err.message, true); return; }
        if (!usual) { toast('Pick both times for the custom usual hours, or choose None.', true); return; }
        Object.assign(update, usual);
        const checks = $$('input[data-duty]', f);
        const add = checks.filter((c) => c.checked && !has.has(`${p.id}|${c.dataset.duty}`)).map((c) => c.dataset.duty);
        const remove = checks.filter((c) => !c.checked && has.has(`${p.id}|${c.dataset.duty}`)).map((c) => c.dataset.duty);
        withBusy(f.querySelector('[type=submit]'), async () => {
          if (!update.full_name) throw new Error('Name can’t be empty.');
          const { error } = await sb.from('profiles').update(update).eq('id', p.id);
          if (error) throw error;
          if (add.length) {
            const r = await sb.from('profile_duties').insert(add.map((duty_id) => ({ user_id: p.id, duty_id })));
            if (r.error) throw r.error;
          }
          if (remove.length) {
            const r = await sb.from('profile_duties').delete().eq('user_id', p.id).in('duty_id', remove);
            if (r.error) throw r.error;
          }
          if (p.is_supervisor && !update.is_supervisor) {
            // no longer a supervisor: their deputies now report to no one
            const r = await sb.from('profiles').update({ reports_to: null }).eq('reports_to', p.id);
            if (r.error) throw r.error;
          }
          if (self) Object.assign(state.profile, update);
          closeModal();
          toast('Saved.');
          showView('team');
        });
      };
      $('#person-deactivate')?.addEventListener('click', (e) => setActive(e.target, p, false));
    };

    const setActive = (b, p, activeFlag) => {
      const name = p.full_name || p.email;
      const msg = activeFlag
        ? `Reactivate ${name}? They’ll be able to sign in and submit timesheets again.`
        : `Deactivate ${name}?\n\nThey’ll be locked out right away. Their timesheets and time off are kept. Any timesheet or time off they already submitted stays in Approvals so you can still approve their final pay.`;
      if (!confirm(msg)) return;
      withBusy(b, async () => {
        const { error } = await sb.from('profiles').update({ active: activeFlag }).eq('id', p.id);
        if (error) throw error;
        closeModal();
        toast(activeFlag ? 'Reactivated.' : 'Deactivated.');
        showView('team');
      });
    };

    $$('.p-edit', el).forEach((b) => { b.onclick = () => editPerson(state.people[b.closest('tr').dataset.id]); });
    $$('.p-reactivate', el).forEach((b) => { b.onclick = () => setActive(b, state.people[b.closest('tr').dataset.id], true); });

    $$('.d-save', el).forEach((b) => {
      b.onclick = () => {
        const tr = b.closest('tr');
        const row = {
          name: $('.d-name', tr).value.trim(),
          label: $('.d-label', tr).value.trim(),
          note: $('.d-note', tr).value.trim(),
          default_hours: round2(num($('.d-default', tr).value)),
          everyone: $('.d-everyone', tr).checked,
          active: $('.d-active', tr).checked,
          paid: $('.d-paid', tr).checked
        };
        withBusy(b, async () => {
          if (!row.name) throw new Error('Give the duty a short name, like K9.');
          if (!isHalfStep(row.default_hours)) throw new Error('Auto hours must be in quarter-hour steps (for example 0.25, 0.5 or 4).');
          if (!row.label) row.label = row.name + ' Hours';
          const res = tr.dataset.id
            ? await sb.from('duties').update(row).eq('id', tr.dataset.id)
            : await sb.from('duties').insert(row);
          if (res.error) throw res.error.code === '23505' ? new Error('There’s already a duty with that short name.') : res.error;
          toast(tr.dataset.id ? 'Duty saved.' : 'Duty added.');
          state.teamOpenDuties = true;
          showView('team');
        });
      };
    });
    if (state.teamOpenDuties) { const d = $$('details.fold', el).pop(); if (d) d.open = true; state.teamOpenDuties = false; }
  };

  function dutyRow(d) {
    return `<tr data-id="${esc(d.id)}" class="${d.id ? '' : 'new-duty'}">
      <td><input class="d-name" value="${esc(d.name)}" placeholder="${d.id ? '' : 'New, e.g. DEA'}"></td>
      <td><input class="d-label" value="${esc(d.label)}" placeholder="e.g. DEA Overtime Hours"></td>
      <td><input class="d-note" value="${esc(d.note)}" placeholder="Optional"></td>
      <td><input class="d-default" type="number" min="0" step="0.25" value="${Number(d.default_hours) || ''}" placeholder="0"></td>
      <td class="center"><input type="checkbox" class="d-everyone" ${d.everyone ? 'checked' : ''}></td>
      <td class="center"><input type="checkbox" class="d-paid" ${d.paid !== false ? 'checked' : ''} title="Add these hours to Total Hours To Be Paid"></td>
      <td class="center"><input type="checkbox" class="d-active" ${d.active ? 'checked' : ''}></td>
      <td class="right"><button class="btn small ${d.id ? '' : 'primary'} d-save">${d.id ? 'Save' : 'Add'}</button></td>
    </tr>`;
  }
})();
