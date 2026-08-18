/**
 * MFARM console.
 *
 * No framework and no build step: the API serves this file as-is and the CSP forbids any external
 * origin, so what runs here is exactly what is in this file.
 *
 * Two rules worth keeping if this grows:
 *
 *   1. NOTHING IS RENDERED WITH innerHTML from server data. Device names, package ids and end
 *      reasons all originate outside the browser, and `textContent` is what makes the CSP's
 *      script-src the second line of defence rather than the only one.
 *   2. Every unsafe request carries the CSRF token. `api()` does it centrally, so a new call site
 *      cannot forget.
 */

const $ = (id) => document.getElementById(id);

const state = {
  csrf: null,
  me: null,
  devices: [],
  sessions: [],
  poll: null,
};

/* ---------------------------------------------------------------------------- transport */

/**
 * One call site for every request, so the credential rules live in one place.
 *
 * `credentials: same-origin` is what sends the session cookie. The CSRF header is attached to
 * anything that is not a safe method, and a 401 anywhere means the session died underneath us —
 * password changed, removed from the org, logged out in another tab — so the console returns to the
 * sign-in screen rather than rendering half a page of stale data.
 */
async function api(path, { method = 'GET', body, raw } = {}) {
  const headers = {};
  if (body !== undefined && !raw) headers['content-type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD' && state.csrf) headers['x-mfarm-csrf'] = state.csrf;

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
  });

  if (res.status === 401 && state.me) {
    signedOut();
    throw new Error('Your session ended. Please sign in again.');
  }

  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    throw new Error(data?.error?.message || `Request failed (${res.status})`);
  }
  return data;
}

function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }

/* ---------------------------------------------------------------------------- chrome */

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = message;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}

function showSignin(message) {
  $('signin').hidden = false;
  $('console').hidden = true;
  const err = $('signin-error');
  if (message) { err.textContent = message; err.hidden = false; } else { err.hidden = true; }
}

function signedOut() {
  state.me = null;
  state.csrf = null;
  if (state.poll) { clearInterval(state.poll); state.poll = null; }
  closeDrawer();
  showSignin('Your session ended. Please sign in again.');
}

/* ---------------------------------------------------------------------------- sign in */

$('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('signin-btn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const out = await api('/v1/auth/login', {
      method: 'POST',
      body: { email: $('email').value.trim(), password: $('password').value },
    });
    state.csrf = out.csrfToken;
    $('password').value = '';
    await boot();
  } catch (err) {
    showSignin(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

$('signout').addEventListener('click', async () => {
  try { await api('/v1/auth/logout', { method: 'POST' }); } catch { /* leaving anyway */ }
  state.me = null;
  state.csrf = null;
  if (state.poll) { clearInterval(state.poll); state.poll = null; }
  showSignin();
});

/* ---------------------------------------------------------------------------- tabs */

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('is-active', t === tab);
    for (const v of document.querySelectorAll('.view')) {
      v.classList.toggle('is-active', v.id === `view-${tab.dataset.view}`);
    }
    if (tab.dataset.view === 'runs') refreshSessions();
  });
}

/* ---------------------------------------------------------------------------- devices */

const KEY_CAPS = new Set(['snapshot-reset', 'webdriver', 'screen-stream']);

function renderDevices() {
  const grid = $('device-grid');
  grid.replaceChildren();

  if (state.devices.length === 0) {
    $('devices-empty').hidden = false;
    return;
  }
  $('devices-empty').hidden = true;

  for (const d of state.devices) {
    const card = document.createElement('button');
    card.className = 'device';
    card.type = 'button';

    const top = document.createElement('div');
    top.className = 'device-top';
    const name = document.createElement('span');
    name.className = 'device-name';
    name.textContent = d.model || 'device';
    const st = document.createElement('span');
    st.className = `state ${d.state}`;
    st.textContent = d.state.replace('_', ' ').toLowerCase();
    top.append(name, st);

    const meta = document.createElement('div');
    meta.className = 'device-meta';
    meta.textContent = `${d.platform} ${d.osVersion} · ${d.tier} · ${d.region}`;

    const caps = document.createElement('div');
    caps.className = 'caps';
    for (const c of d.capabilities || []) {
      const chip = document.createElement('span');
      chip.className = KEY_CAPS.has(c) ? 'cap is-key' : 'cap';
      chip.textContent = c;
      caps.append(chip);
    }

    card.append(top, meta, caps);
    card.addEventListener('click', () => openDrawer(d));
    grid.append(card);
  }
}

async function refreshDevices() {
  try {
    const out = await api('/v1/devices');
    state.devices = out.devices || [];
    const pill = $('fleet-pill');
    $('fleet-count').textContent = String(out.available ?? 0);
    pill.classList.toggle('is-empty', !out.available);
    $('devices-sub').textContent =
      `${state.devices.length} device${state.devices.length === 1 ? '' : 's'} registered · ` +
      `${out.available ?? 0} ready to allocate`;
    renderDevices();
  } catch (err) {
    if (state.me) toast(err.message, 'bad');
  }
}

/* ---------------------------------------------------------------------------- drawer */

function row(dl, label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value ?? '—';
  dl.append(dt, dd);
}

function openDrawer(d) {
  $('drawer-title').textContent = d.model || 'device';
  $('drawer-sub').textContent = `${d.platform} ${d.osVersion} · ${d.tier}`;

  const body = $('drawer-body');
  body.replaceChildren();

  const dl = document.createElement('dl');
  dl.className = 'kv';
  row(dl, 'Device id', d.id);
  row(dl, 'Region', d.region);
  row(dl, 'State', d.state);
  row(dl, 'Dedicated', d.dedicated ? 'yes' : 'no');
  row(dl, 'Capabilities', (d.capabilities || []).join(', '));
  body.append(dl);

  const actions = document.createElement('div');
  actions.className = 'actions';

  // Interactive control is deliberately absent rather than disabled-with-a-tooltip: the media path
  // has no route to a browser yet (ADR-0005 chose a TURN relay; it is not built). A button that
  // cannot work is worse than no button.
  const note = document.createElement('p');
  note.className = 'muted small';
  note.textContent = d.capabilities?.includes('screen-stream')
    ? 'This device can stream, but interactive viewing needs the media relay from ADR-0005, which is not deployed yet.'
    : 'This device does not advertise screen streaming.';

  // Says what it does. `POST /v1/sessions` asks for a device MATCHING a region, platform and tier —
  // the allocator picks which one, atomically, and pinning a specific device is not something it
  // supports today. A button labelled "reserve this device" would be describing a feature that does
  // not exist, so this one describes the one that does and the toast names what was actually given.
  const hold = document.createElement('button');
  hold.textContent = 'Start a session on this tier';
  hold.disabled = d.state !== 'READY';
  hold.addEventListener('click', async () => {
    hold.disabled = true;
    hold.textContent = 'Allocating…';
    try {
      const out = await api('/v1/sessions', {
        method: 'POST',
        body: { region: d.region, platform: d.platform, tier: d.tier },
      });
      const got = out.deviceId ? ` on ${String(out.deviceId).slice(0, 8)}` : '';
      toast(`Session ${String(out.id).slice(0, 8)}${got} is ${String(out.state).toLowerCase()}`, 'good');
      closeDrawer();
      refreshDevices();
      refreshSessions();
    } catch (err) {
      toast(err.message, 'bad');
      hold.disabled = false;
      hold.textContent = 'Start a session on this tier';
    }
  });

  const pinNote = document.createElement('p');
  pinNote.className = 'muted small';
  pinNote.textContent = 'The allocator chooses a ready device on this tier; it cannot yet be pinned to one.';

  actions.append(hold);
  body.append(actions, pinNote, note);

  $('drawer').hidden = false;
  $('scrim').hidden = false;
}

function closeDrawer() {
  $('drawer').hidden = true;
  $('scrim').hidden = true;
}

$('drawer-close').addEventListener('click', closeDrawer);
$('scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

/* ---------------------------------------------------------------------------- runs */

function duration(from, to) {
  if (!from) return '—';
  const ms = (to ? new Date(to) : new Date()) - new Date(from);
  if (ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function renderSessions() {
  const body = $('runs-body');
  body.replaceChildren();

  if (state.sessions.length === 0) {
    $('runs-table').hidden = true;
    $('runs-empty').hidden = false;
    return;
  }
  $('runs-table').hidden = false;
  $('runs-empty').hidden = true;

  for (const s of state.sessions) {
    const tr = document.createElement('tr');
    const cells = [
      String(s.id).slice(0, 8),
      s.device || '—',
      s.endReason ? `${s.state.toLowerCase()} · ${s.endReason}` : s.state.toLowerCase(),
      s.startedAt ? new Date(s.startedAt).toLocaleString() : new Date(s.createdAt).toLocaleString(),
      duration(s.startedAt, s.endedAt),
    ];
    for (const [i, value] of cells.entries()) {
      const td = document.createElement('td');
      td.textContent = value;
      if (i === 0) td.className = 'mono';
      tr.append(td);
    }
    body.append(tr);
  }
}

async function refreshSessions() {
  try {
    const out = await api('/v1/sessions?limit=50');
    state.sessions = out.sessions || [];
    renderSessions();
  } catch (err) {
    if (state.me) toast(err.message, 'bad');
  }
}

$('copy-hub').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('hub-url').textContent);
    toast('Copied', 'good');
  } catch {
    toast('Could not copy — select the text instead', 'bad');
  }
});

/* ---------------------------------------------------------------------------- boot */

async function boot() {
  const me = await api('/v1/auth/me');
  state.me = me;
  // Recovered here rather than kept only from login: the cookie survives a page reload and an
  // in-memory token does not, so without this every refresh would break the first unsafe request.
  if (me.csrfToken) state.csrf = me.csrfToken;

  $('signin').hidden = true;
  $('console').hidden = false;
  $('who-email').textContent = me.user.email;
  $('who-org').textContent = me.org.name;

  $('hub-url').textContent = `${location.origin}/wd/hub`;
  $('hub-note').textContent =
    `Authenticate with an org API key: https://<api-key>@${location.host}/wd/hub. ` +
    `Concurrency for ${me.org.name} is capped at ${me.org.maxConcurrent}.`;

  await Promise.all([refreshDevices(), refreshSessions()]);

  // Polling rather than a socket: the fleet is small, the page is open on a desk, and a poll cannot
  // get stuck half-connected the way a socket can. Paused while the tab is hidden so a forgotten
  // tab does not bill the API all weekend.
  if (state.poll) clearInterval(state.poll);
  state.poll = setInterval(() => {
    if (document.hidden || !state.me) return;
    refreshDevices();
    if ($('view-runs').classList.contains('is-active')) refreshSessions();
  }, 5000);
}

boot().catch(() => showSignin());
