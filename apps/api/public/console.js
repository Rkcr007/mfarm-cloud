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
  apps: [],
  actions: [],
  poll: null,
  /**
   * The session whose Release button is armed, and when it was armed.
   *
   * Kept HERE rather than on the button, which is where it was first written: this view re-renders
   * every five seconds from the poll, `replaceChildren` throws the old node away, and the armed
   * state went with it — so the confirmation could not survive long enough to confirm. Anything a
   * user is halfway through has to live in state, not in the DOM the poll is free to replace.
   */
  armedRelease: null,
};

/**
 * How long a destructive button stays armed before it disarms itself.
 *
 * Ten seconds, because the first value tried was six and that is genuinely too short: the button
 * changes to a sentence, and someone who stops to READ the sentence before deciding can find their
 * second click has re-armed rather than confirmed. Long enough to read and decide, short enough
 * that a button left armed on an abandoned tab is not still dangerous a minute later.
 */
const ARM_WINDOW_MS = 10_000;

function isArmed(sessionId) {
  return state.armedRelease?.id === sessionId
    && Date.now() - state.armedRelease.at < ARM_WINDOW_MS;
}

/** Sessions that still hold a device. Anything else cannot be acted on. */
const LIVE_SESSION_STATES = new Set(['ALLOCATING', 'ACTIVE']);

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
    if (tab.dataset.view === 'apps') refreshApps();
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
      // `POST /v1/sessions` answers `{ session: {...}, dataPlane: {...} }`. Reading id/state/deviceId
      // off the top level produced "Session undefine on  is undefined" — a toast that survived
      // because nobody read it closely and every code path around it worked.
      const { session } = await api('/v1/sessions', {
        method: 'POST',
        body: { region: d.region, platform: d.platform, tier: d.tier },
      });
      const got = session.deviceId ? ` on ${String(session.deviceId).slice(0, 8)}` : '';
      toast(`Session ${String(session.id).slice(0, 8)}${got} is ${String(session.state).toLowerCase()}`, 'good');
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

    /**
     * The FULL session id, with a copy button.
     *
     * It used to be truncated to eight characters, which looked tidy and made this table useless:
     * the id is what `mfarm app install --session` needs and what the WebDriver URL carries in its
     * password half, and neither accepts a prefix. A console that shows you a value you cannot use
     * is worse than one that does not show it.
     */
    const idCell = document.createElement('td');
    const wrap = document.createElement('div');
    wrap.className = 'idcell';
    const code = document.createElement('code');
    code.textContent = s.id;
    const copy = document.createElement('button');
    copy.className = 'copyid';
    copy.type = 'button';
    copy.textContent = 'copy';
    copy.title = 'Copy the full session id';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(s.id); toast('Session id copied', 'good'); }
      catch { toast('Could not copy — select the text instead', 'bad'); }
    });
    wrap.append(code, copy);
    idCell.append(wrap);
    tr.append(idCell);

    const cells = [
      s.device || '—',
      s.endReason ? `${s.state.toLowerCase()} · ${s.endReason}` : s.state.toLowerCase(),
      s.startedAt ? new Date(s.startedAt).toLocaleString() : new Date(s.createdAt).toLocaleString(),
      duration(s.startedAt, s.endedAt),
    ];
    for (const value of cells) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    }

    // Releasing from the list, because this is where someone notices they are still holding one.
    const act = document.createElement('td');
    act.className = 'right';
    if (LIVE_SESSION_STATES.has(s.state) && s.deviceId) {
      const group = document.createElement('div');
      group.className = 'rowactions';
      const armed = isArmed(s.id);
      group.append(button(
        armed ? 'Confirm' : 'Release',
        armed ? 'ghost is-armed' : 'ghost',
        () => releaseHeld(s.id),
      ));
      act.append(group);
    }
    tr.append(act);

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


/* ---------------------------------------------------------------------------- apps */

/**
 * The app library.
 *
 * Three things happen on this view and only one of them is obvious. Uploading a build is a plain
 * transfer. Installing it is a JOB — the control plane cannot dial a worker, so the request queues
 * and a heartbeat carries it down, which is why every button here polls rather than awaiting a
 * result. And holding a device is a PREREQUISITE, not a side effect: an app exists on a device only
 * for the life of the session, because releasing one snapshot-restores it.
 */

const KIND_LABEL = { install: 'Install', launch: 'Launch', uninstall: 'Uninstall' };

/** The session this org is holding that we can act through, or null. */
function heldSession() {
  return state.sessions.find((s) => LIVE_SESSION_STATES.has(s.state) && s.deviceId) || null;
}

function bytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/* ------------------------------------------------------------------ holding a device */

function renderHold() {
  const held = heldSession();
  const actions = $('hold-actions');
  actions.replaceChildren();

  if (held) {
    $('hold-state').textContent =
      `Holding ${held.device || held.deviceId?.slice(0, 8) || 'a device'} · session ${held.id.slice(0, 8)} · ${held.state.toLowerCase()}`;
    const armed = isArmed(held.id);
    const rel = button(
      armed ? 'Confirm — this wipes the device' : 'Release device',
      armed ? 'ghost is-armed' : 'ghost',
      () => releaseHeld(held.id),
    );
    actions.append(rel);
  } else {
    const ready = state.devices.filter((d) => d.state === 'READY');
    $('hold-state').textContent = ready.length
      ? `Not holding a device. ${ready.length} ready.`
      : 'Not holding a device, and none are ready.';
    const hold = button('Hold a device', '', () => holdDevice());
    hold.disabled = ready.length === 0;
    actions.append(hold);
  }
}

/**
 * Allocate a device for this browser session.
 *
 * Deliberately the same call the Devices tab makes: `POST /v1/sessions` names a region, platform and
 * tier and the ALLOCATOR chooses, atomically. A UI that let someone pick "cf-2" would be describing
 * a feature the control plane does not have.
 */
async function holdDevice() {
  const ready = state.devices.find((d) => d.state === 'READY');
  if (!ready) { toast('No device is ready.', 'bad'); return; }
  try {
    const { session } = await api('/v1/sessions', {
      method: 'POST',
      body: { region: ready.region, platform: ready.platform, tier: ready.tier },
    });
    // 202 with no device is a real answer, not a failure: the session is queued and the reaper
    // promotes it when one frees up. Said differently from the held case so nobody reads "queued"
    // as "ready".
    toast(
      session.deviceId
        ? `Holding a device — session ${String(session.id).slice(0, 8)}`
        : 'No device free — queued, and it will start automatically',
      session.deviceId ? 'good' : '',
    );
  } catch (err) {
    toast(err.message, 'bad');
  }
  await Promise.all([refreshSessions(), refreshDevices()]);
  renderAppsView();
}

/**
 * Release, in two clicks.
 *
 * The second click is a real guard, not ceremony: releasing snapshot-restores the device, so this
 * is the button that deletes the app someone just installed, and the word "release" does not say
 * that. It is an INLINE confirmation rather than `confirm()` — a modal dialog blocks the page, and
 * on a console that polls in the background that means the fleet stops updating behind it.
 */
async function releaseHeld(sessionId) {
  if (!isArmed(sessionId)) {
    state.armedRelease = { id: sessionId, at: Date.now() };
    renderAppsView();
    renderSessions();
    // Disarms itself, so a button left armed by a wandering click does not stay dangerous.
    setTimeout(() => {
      if (state.armedRelease?.id !== sessionId) return;
      state.armedRelease = null;
      renderAppsView();
      renderSessions();
    }, ARM_WINDOW_MS);
    return;
  }
  state.armedRelease = null;
  try {
    await api(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    toast('Device released and restoring', 'good');
  } catch (err) {
    toast(err.message, 'bad');
  }
  await Promise.all([refreshSessions(), refreshDevices()]);
  renderAppsView();
}

/* ------------------------------------------------------------------ upload */

/**
 * Upload with XMLHttpRequest rather than fetch, for one reason: fetch cannot report UPLOAD progress.
 *
 * An APK is tens to hundreds of megabytes and a farm is often on the other end of a slow link, so a
 * button that goes quiet for two minutes is indistinguishable from one that is broken. Everything
 * else — the credential rules, the CSRF header — is repeated here explicitly because this is the one
 * call site that does not go through `api()`.
 */
function uploadApk(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/v1/apps?filename=${encodeURIComponent(file.name)}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', 'application/vnd.android.package-archive');
    if (state.csrf) xhr.setRequestHeader('x-mfarm-csrf', state.csrf);

    const bar = $('upload-bar');
    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      bar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
    });
    xhr.addEventListener('load', () => {
      const data = safeJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) resolve({ ...data, status: xhr.status });
      else reject(new Error(data?.error?.message || `Upload failed (${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('The upload did not reach the server.')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
    xhr.send(file);
  });
}

async function handleFile(file) {
  if (!file) return;
  const err = $('upload-error');
  err.hidden = true;
  $('upload-progress').hidden = false;
  $('upload-bar').style.width = '0%';
  $('drop-main').textContent = `Uploading ${file.name}…`;

  try {
    const out = await uploadApk(file);
    // 200 means the org already had these exact bytes. Saying so is the difference between "my
    // upload did nothing" and "there was nothing to do", and only one of those sends someone
    // looking for a bug.
    toast(
      out.deduplicated
        ? `${out.app.packageName} was already in the library`
        : `Uploaded ${out.app.packageName} ${out.app.versionName || ''}`.trim(),
      'good',
    );
    await refreshApps();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    $('upload-progress').hidden = true;
    $('drop-main').textContent = 'Drop an .apk here, or choose a file';
    $('apk-input').value = '';
  }
}

/* ------------------------------------------------------------------ the library */

function renderApps() {
  const body = $('apps-body');
  body.replaceChildren();

  if (state.apps.length === 0) {
    $('apps-table').hidden = true;
    $('apps-empty').hidden = false;
    return;
  }
  $('apps-table').hidden = false;
  $('apps-empty').hidden = true;

  for (const a of state.apps) {
    const tr = document.createElement('tr');

    const pkg = document.createElement('td');
    pkg.className = 'mono';
    pkg.textContent = a.packageName;
    if (a.label) {
      const sub = document.createElement('div');
      sub.className = 'muted small';
      sub.textContent = a.label;
      pkg.append(sub);
    }

    const version = document.createElement('td');
    version.textContent = a.versionName || (a.versionCode == null ? '—' : `code ${a.versionCode}`);

    const size = document.createElement('td');
    size.textContent = bytes(a.sizeBytes);

    const uploaded = document.createElement('td');
    uploaded.textContent = when(a.createdAt);

    const act = document.createElement('td');
    act.className = 'right';
    const group = document.createElement('div');
    group.className = 'rowactions';
    for (const kind of ['install', 'launch', 'uninstall']) {
      const b = button(KIND_LABEL[kind], kind === 'install' ? '' : 'ghost', () => runAction(a, kind));
      // Every verb needs a device, and the reason it is disabled is stated rather than implied.
      b.disabled = !heldSession();
      b.title = heldSession() ? '' : 'Hold a device first';
      group.append(b);
    }
    act.append(group);

    tr.append(pkg, version, size, uploaded, act);
    body.append(tr);
  }
}

/**
 * Queue one verb and follow it to an outcome.
 *
 * The poll is the honest shape of this: the API answers 202 because nothing has reached a device
 * yet — the worker picks the job up on its next heartbeat, up to ten seconds later — so a button
 * that claimed success on the 202 would be lying for the most interesting part of the wait.
 */
async function runAction(app, kind) {
  const held = heldSession();
  if (!held) { toast('Hold a device first.', 'bad'); return; }

  let action;
  try {
    const out = await api(`/v1/sessions/${encodeURIComponent(held.id)}/app-actions`, {
      method: 'POST',
      body: { appId: app.id, kind },
    });
    action = out.action;
    toast(`${KIND_LABEL[kind]} queued for ${app.packageName}`);
  } catch (err) {
    toast(err.message, 'bad');
    return;
  }

  await refreshActions();
  const deadline = Date.now() + 300_000;
  while (action.state === 'PENDING' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      action = (await api(`/v1/app-actions/${encodeURIComponent(action.id)}`)).action;
    } catch {
      break; // the periodic refresh will still show where it got to
    }
    renderActions();
  }

  if (action.state === 'DONE') toast(`${KIND_LABEL[kind]}ed ${app.packageName}`, 'good');
  else if (action.state === 'FAILED') toast(`${KIND_LABEL[kind]} failed: ${action.error || 'no reason reported'}`, 'bad');
  else toast(`${KIND_LABEL[kind]} is still pending — the worker has not picked it up`, 'bad');
  await refreshActions();
}

function renderActions() {
  const body = $('actions-body');
  body.replaceChildren();
  const has = state.actions.length > 0;
  $('actions-head').hidden = !has;
  $('actions-table').hidden = !has;
  if (!has) return;

  const byId = new Map(state.apps.map((a) => [a.id, a]));
  for (const a of state.actions.slice(0, 20)) {
    const tr = document.createElement('tr');
    const kind = document.createElement('td');
    kind.textContent = KIND_LABEL[a.kind] || a.kind;

    const pkg = document.createElement('td');
    pkg.className = 'mono';
    pkg.textContent = byId.get(a.appId)?.packageName || a.appId.slice(0, 8);

    const st = document.createElement('td');
    st.textContent = a.state.toLowerCase();
    st.className = a.state === 'FAILED' ? 'bad-text' : a.state === 'DONE' ? 'ok-text' : 'muted';
    if (a.error) {
      const why = document.createElement('div');
      why.className = 'muted small';
      // The worker's own words, rendered as TEXT. This string came off a device via adb and is the
      // single most attacker-influenced value on the page.
      why.textContent = a.error;
      st.append(why);
    }

    const at = document.createElement('td');
    at.textContent = when(a.finishedAt || a.requestedAt);

    tr.append(kind, pkg, st, at);
    body.append(tr);
  }
}

async function refreshActions() {
  try {
    state.actions = (await api('/v1/app-actions?limit=20')).actions || [];
    renderActions();
  } catch (err) {
    if (state.me) toast(err.message, 'bad');
  }
}

/** The strip and the library are one view: both are derived from what device is held. */
function renderAppsView() {
  renderHold();
  renderApps();
}

async function refreshApps() {
  try {
    state.apps = (await api('/v1/apps')).apps || [];
    renderAppsView();
    await refreshActions();
  } catch (err) {
    if (state.me) toast(err.message, 'bad');
  }
}

$('apk-input').addEventListener('change', (e) => handleFile(e.target.files?.[0]));

for (const [event, over] of [['dragenter', true], ['dragover', true], ['dragleave', false], ['drop', false]]) {
  $('drop').addEventListener(event, (e) => {
    e.preventDefault();
    $('drop').classList.toggle('is-over', over);
    if (event === 'drop') handleFile(e.dataTransfer?.files?.[0]);
  });
}

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

  await Promise.all([refreshDevices(), refreshSessions(), refreshApps()]);

  // Polling rather than a socket: the fleet is small, the page is open on a desk, and a poll cannot
  // get stuck half-connected the way a socket can. Paused while the tab is hidden so a forgotten
  // tab does not bill the API all weekend.
  if (state.poll) clearInterval(state.poll);
  state.poll = setInterval(() => {
    if (document.hidden || !state.me) return;
    refreshDevices();
    if ($('view-runs').classList.contains('is-active')) refreshSessions();
    if ($('view-apps').classList.contains('is-active')) {
      // Sessions too, not just the library: the held-device strip is derived from them, and a
      // device released in another tab has to stop offering Install here.
      refreshSessions().then(renderAppsView);
      refreshActions();
    }
  }, 5000);
}

boot().catch(() => showSignin());
