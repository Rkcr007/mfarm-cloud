/**
 * MFARM console.
 *
 * No framework and no build step: the API serves this file as-is under a CSP that forbids any
 * external origin, so what runs here is exactly what is in this file.
 *
 * Four rules worth keeping if this grows:
 *
 *   1. NOTHING IS RENDERED WITH innerHTML from server data. Device models, package ids and worker
 *      error strings all originate outside the browser, and `textContent` is what makes the CSP's
 *      script-src the second line of defence rather than the only one. `h()` below only ever
 *      creates text nodes, so a call site cannot opt out by accident.
 *   2. Every unsafe request carries the CSRF token. `api()` does it centrally.
 *   3. NOTHING IS RENDERED THAT THE API CANNOT ANSWER FOR. Where the design has a screen the
 *      control plane has no endpoint behind — team, activity, settings, evidence, live view,
 *      logcat, device vitals — this file states the gap in words instead of inventing the data.
 *      Each such omission is commented where it would otherwise be.
 *   4. NO OPTIMISTIC UI ON DEVICE ACTIONS. The control plane cannot dial a worker; every app
 *      action is a job a heartbeat carries down. Nothing reports success before the worker does.
 */

const $ = (id) => document.getElementById(id);
const root = document.documentElement;

/**
 * Element builder.
 *
 * Children that are strings become TEXT NODES — never markup. That is rule 1 made structural: there
 * is no argument to this function that can introduce an element from a string.
 */
function h(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = String(v);
    else if (k === 'html') throw new Error('h() does not accept html');
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'disabled' || k === 'hidden' || k === 'checked') n[k] = Boolean(v);
    // Written through CSSOM, never `setAttribute('style', …)`: the console's CSP is
    // `style-src 'self'` with no `'unsafe-inline'`, which kills the style ATTRIBUTE silently — it
    // parses and computes to nothing. Assigning properties on `n.style` is not blocked. Reserved
    // for values that actually change at runtime; everything static is a class in console.css.
    else if (k === 'style') Object.assign(n.style, v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, String(v));
  }
  add(n, kids);
  return n;
}

function add(parent, kids) {
  for (const k of kids.flat(4)) {
    if (k === null || k === undefined || k === false) continue;
    parent.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

/* ---------------------------------------------------------------------------- state */

const state = {
  csrf: null,
  me: null,
  devices: [],
  available: 0,
  sessions: [],
  apps: [],
  actions: [],
  /** GET /sessions/:id for the session we hold — the only source of expiresAt and dataPlane. */
  held: null,
  heldFetchedAt: 0,
  /** The action the cockpit / apps view is currently following to an outcome. */
  action: null,
  upload: null,
  /** GET /sessions/:id for whatever session the cockpit is showing — held or long ended. */
  detail: null,
  /** The build the cockpit's tool picker has selected, kept across re-renders. */
  pickedApp: null,
  route: { name: 'devices', id: null },
  poll: null,
  tick: null,
  palIndex: 0,
  error: null,
};

/** Sessions that still hold a device. Anything else cannot be acted on. */
const LIVE_SESSION_STATES = new Set(['ALLOCATING', 'ACTIVE']);

/**
 * Device state → how it reads in the UI.
 *
 * The enum is the API's vocabulary, not a person's. Every entry pairs a word with a tone, and the
 * markup always adds a dot and a piece of context beside it — colour never carries the state.
 */
const DEVICE_STATE = {
  READY:          { label: 'Available', tone: 'ok',     note: 'Allocatable now' },
  RESERVED:       { label: 'Reserved',  tone: 'accent', note: 'Allocated, session not live yet' },
  SESSION_ACTIVE: { label: 'In use',    tone: 'accent', note: 'A session is holding it' },
  BOOTING:        { label: 'Booting',   tone: 'warn',   note: 'Coming up from snapshot' },
  CLEANING:       { label: 'Restoring', tone: 'warn',   note: 'Snapshot restore in progress' },
  QUARANTINED:    { label: 'Quarantined', tone: 'bad',  note: 'Failed health checks; never scheduled' },
  OFFLINE:        { label: 'Offline',   tone: '',       note: 'The host has not reported it' },
  EVICTED:        { label: 'Evicted',   tone: '',       note: 'Removed from the fleet' },
};

const SESSION_STATE = {
  QUEUED:     { label: 'Queued',     tone: 'warn' },
  ALLOCATING: { label: 'Allocating', tone: 'accent' },
  ACTIVE:     { label: 'Active',     tone: 'ok' },
  ENDING:     { label: 'Ending',     tone: 'warn' },
  ENDED:      { label: 'Ended',      tone: '' },
  FAILED:     { label: 'Failed',     tone: 'bad' },
};

const ACTION_STATE = {
  PENDING: { label: 'Queued',    tone: 'warn' },
  DONE:    { label: 'Succeeded', tone: 'ok' },
  FAILED:  { label: 'Failed',    tone: 'bad' },
};

const KIND_LABEL = { install: 'Install', launch: 'Launch', uninstall: 'Uninstall' };

/**
 * The capability vocabulary the control plane actually reads.
 *
 * Rendered as present-or-absent rather than present-or-hidden: `app-install` is checked by
 * POST /sessions/:id/app-actions before it will queue anything, so a device without it needs to say
 * so in the UI or the disabled Install button has no explanation.
 */
const KNOWN_CAPS = ['app-install', 'webdriver', 'snapshot-reset', 'screen-stream'];

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
  if (!res.ok) throw new Error(data?.error?.message || `Request failed (${res.status})`);
  return data;
}

function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }

/* ---------------------------------------------------------------------------- formatting */

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

/** Relative time, coarse on purpose: nobody needs "1m 43s ago" in a list. */
function ago(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/** mm:ss, for anything that ticks. Tabular numerals stop it reflowing. */
function clock(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '00:00';
  const s = Math.floor(ms / 1000);
  const hr = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hr > 0 ? `${hr}:${mm}:${ss}` : `${mm}:${ss}`;
}

function duration(from, to) {
  if (!from) return '—';
  return clock((to ? new Date(to) : new Date()) - new Date(from));
}

const short = (id) => (id ? String(id).slice(0, 8) : '—');

/* ---------------------------------------------------------------------------- live counters */

/**
 * A counter the 1s tick rewrites IN PLACE.
 *
 * The first version of this file re-rendered the whole page every second to move these numbers, and
 * that is a real bug rather than a waste: a rebuild between a person's mousedown and their mouseup
 * destroys the node the click was headed for, and the click is simply lost. Buttons on this console
 * release devices, so silently dropping one is not acceptable. The tick now repaints these spans
 * and nothing else, and `render()` refuses to run while a pointer is down.
 *
 * `kind` is 'until' (counts down to an instant) or 'since' (counts up from one).
 */
function ticker(kind, iso, { prefix = '', suffix = '', cls = '' } = {}) {
  const n = h('span', { class: `tnum ${cls}`.trim() });
  n.dataset.tick = kind;
  n.dataset.at = iso || '';
  n.dataset.prefix = prefix;
  n.dataset.suffix = suffix;
  paintTicker(n);
  return n;
}

function paintTicker(n) {
  const at = n.dataset.at;
  const body = !at ? '—'
    : clock(n.dataset.tick === 'until' ? new Date(at) - Date.now() : Date.now() - new Date(at));
  n.textContent = `${n.dataset.prefix}${body}${n.dataset.suffix}`;
}

/**
 * A lease bar that drains without a re-render.
 *
 * The width is written through CSSOM (`el.style.width`), which the CSP permits — unlike a `style`
 * attribute, which it drops on the floor.
 */
function leaseBar(fromIso, untilIso) {
  const i = h('i');
  i.dataset.from = fromIso || '';
  i.dataset.until = untilIso || '';
  paintBar(i);
  return h('div', { class: 'bar lease' }, i);
}

function paintBar(i) {
  const until = new Date(i.dataset.until).getTime();
  const from = new Date(i.dataset.from).getTime();
  const total = until - from;
  if (!Number.isFinite(total) || total <= 0) { i.style.width = '0%'; return; }
  i.style.width = `${Math.max(0, Math.min(100, ((until - Date.now()) / total) * 100))}%`;
}

/* ---------------------------------------------------------------------------- primitives */

function pill(label, tone, opts = {}) {
  return h('span', { class: `pill ${tone || ''}`.trim(), title: opts.title || null },
    opts.dot === false ? null : h('span', { class: `dot ${tone || ''} ${opts.live ? 'live' : ''}`.trim() }),
    label,
  );
}

function chip(label, present) {
  return h('span', { class: present === undefined ? 'chip' : `chip ${present ? 'yes' : 'no'}` }, label);
}

function kv(pairs) {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v, mono] of pairs) {
    dl.append(h('dt', { text: k }), h('dd', { class: mono ? 'mono' : '', text: v ?? '—' }));
  }
  return dl;
}

/** A mono value with a Copy button that says "Copied" for 1.6s and then stops saying it. */
function copyrow(value, label = 'Copy') {
  const btn = h('button', {
    class: 'btn tiny ghost',
    type: 'button',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(value);
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = label; }, 1600);
      } catch {
        toast('Could not copy', 'Select the text instead — the clipboard was refused.', 'bad');
      }
    },
  }, label);
  return h('div', { class: 'copyrow' }, h('code', { text: value }), btn);
}

function btn(label, cls, onclick, opts = {}) {
  return h('button', {
    class: `btn ${cls || ''}`.trim(),
    type: 'button',
    onclick,
    disabled: opts.disabled,
    title: opts.title || null,
  }, label, opts.kbd ? h('kbd', { text: opts.kbd }) : null);
}

function card(title, opts = {}, ...kids) {
  const head = title
    ? h('div', { class: 'card-head' },
        h('p', { class: opts.micro === false ? 'card-title' : 'micro', text: title }),
        opts.aside || null)
    : null;
  return h('section', { class: `card ${opts.class || ''}`.trim() }, head, ...kids);
}

function empty(title, body) {
  return h('p', { class: 'empty' }, h('strong', { text: title }), body || null);
}

function timeline(items) {
  return h('ul', { class: 'timeline' }, items.map((it) =>
    h('li', { class: it.tone || '' },
      h('p', { class: 'tl-title', text: it.title }),
      it.note ? h('p', { class: 'tl-note', text: it.note }) : null,
    )));
}

/* ---------------------------------------------------------------------------- toasts */

/**
 * Always a title AND a body, and the body is always specific.
 *
 * "Success" tells nobody anything; "Install queued — waiting for the device worker · com.acme.finance"
 * tells them what to expect and how long it might take.
 */
function toast(title, body, kind = '') {
  const box = $('toasts');
  while (box.children.length >= 3) box.firstElementChild.remove();
  const el = h('div', { class: `toast ${kind}`.trim() },
    h('p', { class: 't-title', text: title }),
    body ? h('p', { class: 't-body', text: body }) : null,
  );
  box.append(el);
  setTimeout(() => el.remove(), 4200);
}

/* ---------------------------------------------------------------------------- dialog */

let dialogOpen = false;

/** Never `confirm()`: a modal dialog blocks the page, and this console polls behind it. */
function confirmDialog({ title, lead, removes, keeps, cancel = 'Cancel', confirm, onConfirm }) {
  const d = $('dialog');
  d.replaceChildren(
    h('h2', { id: 'dialog-title', text: title }),
    h('p', { class: 'help mt-xs', text: lead }),
    removes?.length ? h('div', { class: 'inset mt-lg' },
      h('p', { class: 'micro', text: 'This will remove' }),
      h('ul', { class: 'mt-xs' }, removes.map((r) =>
        h('li', { class: 'help' }, '— ', r))),
    ) : null,
    keeps ? h('p', { class: 'ok-text help mt-md', text: keeps }) : null,
    h('div', { class: 'row end mt-xl' },
      btn(cancel, 'ghost', closeOverlays),
      btn(confirm, 'danger-solid', async () => { closeOverlays(); await onConfirm(); }),
    ),
  );
  d.hidden = false;
  $('scrim').hidden = false;
  dialogOpen = true;
  d.querySelector('.btn.ghost')?.focus();
}

function closeOverlays() {
  $('dialog').hidden = true;
  $('palette').hidden = true;
  $('scrim').hidden = true;
  dialogOpen = false;
}

$('scrim').addEventListener('click', closeOverlays);

/* ---------------------------------------------------------------------------- derived state */

/** The session this org is holding that we can act through, or null. */
function heldSession() {
  return state.sessions.find((s) => LIVE_SESSION_STATES.has(s.state) && s.deviceId) || null;
}

const deviceById = (id) => state.devices.find((d) => d.id === id) || null;
const appById = (id) => state.apps.find((a) => a.id === id) || null;
const queuedSessions = () => state.sessions.filter((s) => s.state === 'QUEUED');

/** Actions belonging to one session, newest first (the API already orders them that way). */
const actionsFor = (sessionId) => state.actions.filter((a) => a.sessionId === sessionId);

/**
 * The build currently on a device, as far as anything can honestly say.
 *
 * Derived from the action log rather than asserted: the newest DONE install with no later DONE
 * uninstall for the same package. If the worker never confirmed it, it is not on the device.
 */
function installedOn(sessionId) {
  const acts = actionsFor(sessionId).filter((a) => a.state === 'DONE');
  const seen = new Set();
  for (const a of acts) {
    if (seen.has(a.appId)) continue;
    seen.add(a.appId);
    // A confirmed launch is as good a proof of presence as a confirmed install; only an uninstall
    // takes a build off the device, and that is what `seen` skips past.
    if (a.kind === 'install' || a.kind === 'launch') return appById(a.appId) || { id: a.appId, packageName: short(a.appId) };
  }
  return null;
}

function lease(sess) {
  if (!sess?.expiresAt) return null;
  const ms = new Date(sess.expiresAt) - Date.now();
  const total = sess.startedAt ? new Date(sess.expiresAt) - new Date(sess.startedAt) : null;
  return { ms, pct: total > 0 ? Math.max(0, Math.min(100, (ms / total) * 100)) : null };
}

const webdriverUrl = () => `${location.origin}/wd/hub`;

/* ---------------------------------------------------------------------------- data */

async function refreshDevices() {
  const out = await api('/v1/devices');
  state.devices = out.devices || [];
  state.available = out.available ?? 0;
}

async function refreshSessions() {
  state.sessions = (await api('/v1/sessions?limit=50')).sessions || [];
}

async function refreshApps() {
  state.apps = (await api('/v1/apps')).apps || [];
}

async function refreshActions() {
  state.actions = (await api('/v1/app-actions?limit=100')).actions || [];
}

/**
 * The held session's detail, which is the ONLY source of `expiresAt` and the data-plane
 * coordinates — the list endpoint deliberately returns neither.
 *
 * Throttled to 10s rather than folded into the 5s poll because this endpoint MINTS a session token
 * on every call. Doing that twice a minute to drive a countdown is reasonable; doing it twelve
 * times a minute to drive the same countdown is issuing credentials to animate a clock. The 1s tick
 * counts down locally from `expiresAt` in between.
 */
async function refreshHeld(force = false) {
  const held = heldSession();
  if (!held) { state.held = null; return; }
  if (!force && state.held?.id === held.id && Date.now() - state.heldFetchedAt < 10_000) return;
  try {
    const out = await api(`/v1/sessions/${encodeURIComponent(held.id)}`);
    state.held = { ...out.session, dataPlane: out.dataPlane || null };
    state.heldFetchedAt = Date.now();
  } catch {
    /* The list still renders; a failed detail must not blank the page. */
  }
}

async function refreshAll() {
  await Promise.all([refreshDevices(), refreshSessions(), refreshApps(), refreshActions()]);
  await refreshHeld();
}

/* ---------------------------------------------------------------------------- router */

const ROUTES = new Set(['devices', 'apps', 'sessions', 'queue', 'health']);

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, id] = raw.split('/');
  if (name === 'devices' && id) return { name: 'device', id };
  if (name === 'sessions' && id) return { name: 'cockpit', id };
  return { name: ROUTES.has(name) ? name : 'devices', id: null };
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

window.addEventListener('hashchange', () => {
  state.route = parseHash();
  state.action = null;
  closeOverlays();
  render();
  if (state.route.name === 'cockpit') loadSessionDetail(state.route.id).then(render);
});

for (const item of document.querySelectorAll('.navitem')) {
  item.addEventListener('click', () => go(`#/${item.dataset.route}`));
}

/* ---------------------------------------------------------------------------- chrome render */

function renderChrome() {
  const held = heldSession();

  $('fs-devices').textContent = `${state.available}/${state.devices.length}`;
  $('fs-dot').className = `dot ${state.available > 0 ? 'ok' : 'warn'} live`;
  $('fs-queue').textContent = String(queuedSessions().length);
  $('fs-held').textContent = held ? (held.device || short(held.deviceId)) : 'nothing';
  $('fs-holding').hidden = !held;

  // Nav highlight. The two detail routes keep their parent lit rather than lighting nothing.
  const parent = { device: 'devices', cockpit: 'sessions' }[state.route.name] || state.route.name;
  for (const item of document.querySelectorAll('.navitem')) {
    item.classList.toggle('is-active', item.dataset.route === parent);
  }

  // The sidebar session card, and its collapsed 38px stand-in.
  const sideCard = $('sessioncard');
  const stub = $('sessionstub');
  sideCard.hidden = !held;
  stub.hidden = !held;
  if (held) {
    $('sc-device').textContent = held.device || short(held.deviceId);
    const l = lease(state.held?.id === held.id ? state.held : null);
    const text = l ? `lease ${clock(l.ms)} left` : `${(SESSION_STATE[held.state]?.label || held.state).toLowerCase()}`;
    $('sc-lease').textContent = text;
    stub.title = `${held.device || short(held.deviceId)} · ${text}`;
  }
}

$('sc-open').addEventListener('click', () => { const s = heldSession(); if (s) go(`#/sessions/${s.id}`); });
$('sessionstub').addEventListener('click', () => { const s = heldSession(); if (s) go(`#/sessions/${s.id}`); });
$('farmstat').addEventListener('click', () => go('#/health'));

$('navtoggle').addEventListener('click', () => {
  const icons = root.dataset.nav === 'icons';
  root.dataset.nav = icons ? 'labels' : 'icons';
  try { localStorage.setItem('mf-nav', root.dataset.nav); } catch { /* private mode; not important */ }
  $('navtoggle').firstElementChild.textContent = icons ? '«' : '»';
});

/* ---------------------------------------------------------------------------- page header */

function pageHead(crumbs, title, sub, actions) {
  return h('div', null,
    crumbs?.length ? h('p', { class: 'crumb' }, crumbs.map((c, i) => [
      i ? ' / ' : null,
      c.to ? h('button', { type: 'button', text: c.label, onclick: () => go(c.to) }) : c.label,
    ])) : null,
    h('div', { class: 'page-head' },
      h('h1', { class: 'page-title', text: title }),
      sub ? h('p', { class: 'page-sub', text: sub }) : null,
      actions ? [h('span', { class: 'spacer' }), actions] : null,
    ),
  );
}

/* ---------------------------------------------------------------------------- actions */

/**
 * Allocate a device.
 *
 * `POST /v1/sessions` names a REGION, PLATFORM and TIER — the allocator chooses which device,
 * atomically. There is no field for "this one", so the button says what it does and the toast names
 * what was actually given. A "reserve this device" button would be describing a feature the control
 * plane does not have.
 */
async function startSession(d) {
  try {
    const { session } = await api('/v1/sessions', {
      method: 'POST',
      body: { region: d.region, platform: d.platform, tier: d.tier },
    });
    // 202 with no device is a real answer, not a failure: the session is queued and the reaper
    // promotes it when one frees up. Said differently so nobody reads "queued" as "ready".
    if (session.deviceId) {
      toast('Session started', `${short(session.id)} on ${short(session.deviceId)} · ${String(session.state).toLowerCase()}`, 'ok');
    } else {
      toast('Queued for a device', `Nothing is free on tier ${d.tier}. It starts automatically when one is.`, 'warn');
    }
    await Promise.all([refreshDevices(), refreshSessions()]);
    await refreshHeld(true);
    render();
    if (session.deviceId) go(`#/sessions/${session.id}`);
  } catch (err) {
    toast('Could not start a session', err.message, 'bad');
  }
}

/**
 * Release, behind a dialog.
 *
 * The second step is a real guard, not ceremony: releasing snapshot-restores the device, so this is
 * the button that deletes the build someone just installed, and the word "release" does not say so.
 */
function askRelease(sess) {
  const name = sess.device || short(sess.deviceId);
  confirmDialog({
    title: `Release ${name}?`,
    lead: 'The device will be restored to its clean snapshot.',
    removes: [
      'the app and its data',
      'session state, and anything typed or cached',
      'the WebDriver session, if a suite is attached',
    ],
    // The design's reassurance names screenshots, video and logcat. None of those are captured
    // anywhere in this system, so promising they survive would be a comforting lie. The action log
    // is what genuinely outlives the session, so that is what this says.
    keeps: 'The action log for this session stays available.',
    confirm: 'Release & reset',
    onConfirm: () => releaseSession(sess.id),
  });
}

async function releaseSession(sessionId) {
  try {
    await api(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    toast('Release requested', 'The device is restoring its clean snapshot.', 'ok');
  } catch (err) {
    toast('Could not release', err.message, 'bad');
  }
  state.held = null;
  await Promise.all([refreshDevices(), refreshSessions()]);
  render();
}

/**
 * Queue one app verb and follow it to an outcome.
 *
 * The API answers 202 because nothing has reached a device yet, so a button that claimed success on
 * the 202 would be lying for the most interesting part of the wait. This polls the action and only
 * speaks when the worker has.
 */
async function runAction(app, kind) {
  const held = heldSession();
  if (!held) { toast('No device held', 'Start a session before installing anything.', 'bad'); return; }

  let action;
  try {
    const out = await api(`/v1/sessions/${encodeURIComponent(held.id)}/app-actions`, {
      method: 'POST',
      body: { appId: app.id, kind },
    });
    action = out.action;
  } catch (err) {
    toast(`${KIND_LABEL[kind]} refused`, err.message, 'bad');
    return;
  }

  state.action = { ...action, app, kind };
  render();
  toast(`${KIND_LABEL[kind]} queued`, `Waiting for the device worker · ${app.packageName}`, 'warn');

  const deadline = Date.now() + 300_000;
  while (action.state === 'PENDING' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      action = (await api(`/v1/app-actions/${encodeURIComponent(action.id)}`)).action;
    } catch {
      break; // the periodic refresh still shows where it got to
    }
    state.action = { ...action, app, kind };
    render();
  }

  if (action.state === 'DONE') {
    toast(`${KIND_LABEL[kind]} completed`, `${app.packageName} ${app.versionName || ''} · ${held.device || short(held.deviceId)}`.replace(/\s+/g, ' '), 'ok');
  } else if (action.state === 'FAILED') {
    toast(`${KIND_LABEL[kind]} failed`, action.error || 'The worker reported no reason.', 'bad');
  } else {
    toast(`${KIND_LABEL[kind]} still queued`, 'The worker has not picked it up. It is not lost — it runs on the next heartbeat.', 'warn');
  }
  await refreshActions();
  render();
}

/* ---------------------------------------------------------------------------- screen: devices */

function leaseBlock(sess) {
  return h('div', { class: 'inset stack tight' },
    h('div', { class: 'row between' },
      h('span', { class: 'row tight' }, h('span', { class: 'dot ok live' }), 'Lease active'),
      sess?.expiresAt
        ? ticker('until', sess.expiresAt, { suffix: ' remaining', cls: 'secondary' })
        : h('span', { class: 'caption', text: 'no expiry reported' }),
    ),
    sess?.expiresAt && sess?.startedAt ? leaseBar(sess.startedAt, sess.expiresAt) : null,
  );
}

function deviceCard(d) {
  const st = DEVICE_STATE[d.state] || { label: d.state, tone: '', note: '' };
  const held = heldSession();
  const mine = held && held.deviceId === d.id;
  const detail = mine && state.held?.id === held.id ? state.held : null;
  const app = mine ? installedOn(held.id) : null;

  return card(null, { class: 'stack' },
    h('div', { class: 'row between' },
      h('span', { class: 'row tight' },
        h('span', { class: 'card-title', text: d.model || 'Device' }),
        h('code', { class: 'caption', text: short(d.id) }),
      ),
      pill(st.label, st.tone, { live: d.state === 'READY' }),
    ),

    // Dot + word + context. Never the dot alone.
    h('p', { class: 'help row tight' }, h('span', { class: `dot ${st.tone}` }), st.note),

    h('div', { class: 'device-meta' },
      [['Platform', d.platform], ['OS', d.osVersion], ['Tier', d.tier], ['Region', d.region]].map(([k, v]) =>
        h('div', null, h('p', { class: 'micro', text: k }), h('p', { class: 'v', text: v || '—' }))),
    ),

    h('div', { class: 'stack tight' },
      h('p', { class: 'micro', text: 'Capabilities' }),
      h('div', { class: 'caps' },
        KNOWN_CAPS.map((c) => chip(c, (d.capabilities || []).includes(c))),
        (d.capabilities || []).filter((c) => !KNOWN_CAPS.includes(c)).map((c) => chip(c, true)),
      ),
    ),

    mine ? [
      leaseBlock(detail),
      h('div', { class: 'stack tight' },
        h('p', { class: 'micro', text: 'Session-only app' }),
        app
          ? h('p', { class: 'secondary', text: `${app.label || app.packageName} ${app.versionName || ''}`.trim() })
          : h('p', { class: 'help', text: 'Nothing installed in this session yet.' }),
        h('p', { class: 'caption', text: 'Releasing restores the clean snapshot and removes the app and its data. The action log is kept.' }),
      ),
      h('div', { class: 'row tight' },
        btn('View session', 'primary', () => go(`#/sessions/${held.id}`)),
        btn('Release', 'danger', () => askRelease(held)),
      ),
    ] : h('div', { class: 'row tight' },
      d.state === 'READY'
        ? btn(`Start a session on tier ${d.tier}`, 'primary', () => startSession(d))
        : null,
      btn('Details', 'ghost', () => go(`#/devices/${d.id}`)),
    ),

    d.state === 'READY' && !mine
      ? h('p', { class: 'caption', text: 'The allocator picks a ready device on this tier; it cannot be pinned to one.' })
      : null,
  );
}

function queueCard() {
  const q = queuedSessions();
  return card('Queue', { aside: pill(q.length ? `${q.length} waiting` : 'clear', q.length ? 'warn' : 'ok', { dot: false }) },
    q.length
      ? h('div', { class: 'stack' },
          q.map((s, i) => h('div', { class: 'stack tight' },
            h('div', { class: 'row between' },
              h('span', { class: 'secondary', text: `#${i + 1} ${s.region} · ${s.state.toLowerCase()}` }),
              ticker('since', s.createdAt, { prefix: 'waiting ', cls: 'caption' }),
            ),
            h('p', { class: 'caption', text: `Session ${short(s.id)} · requested ${s.region}` }),
          )),
          // No estimate. Producing one needs every holder's expiresAt, and the list endpoint does
          // not return it — a number invented from nothing is worse than an honest absence.
          h('p', { class: 'caption', text: 'A queued session starts automatically when a device frees up. There is no estimate here because the API does not report other sessions’ lease times.' }),
        )
      : empty('All devices are available.', 'Nobody is waiting.'),
    q.length ? h('div', { class: 'mt-md' }, btn('Open queue', 'ghost wide', () => go('#/queue'))) : null,
  );
}

function activityCard(filter) {
  const acts = (filter ? state.actions.filter(filter) : state.actions).slice(0, 8);
  return card('Recent activity', {},
    acts.length
      ? timeline(acts.map((a) => {
          const meta = ACTION_STATE[a.state] || { label: a.state, tone: '' };
          const app = appById(a.appId);
          return {
            tone: meta.tone,
            title: `${KIND_LABEL[a.kind] || a.kind} ${app?.packageName || short(a.appId)} — ${meta.label.toLowerCase()}`,
            note: `${ago(a.finishedAt || a.requestedAt)}${a.error ? ` · ${a.error}` : ''}`,
          };
        }))
      : empty('Nothing has happened yet.', 'App actions appear here as workers confirm them.'),
  );
}

function screenDevices() {
  const n = state.devices.length;
  return [
    pageHead([{ label: 'Farm' }], 'Devices',
      `${n} device${n === 1 ? '' : 's'} · ${state.available} ready to allocate`),
    h('div', { class: 'split' },
      h('div', { class: 'content' },
        n
          ? h('div', { class: 'autogrid' }, state.devices.map(deviceCard))
          : card(null, {}, empty('No devices are registered in this region yet.',
              'Start a worker and it appears here within a heartbeat.')),
      ),
      h('div', { class: 'rail' }, queueCard(), activityCard()),
    ),
  ];
}

/* ------------------------------------------------------------------ screen: device detail */

function screenDevice(id) {
  const d = deviceById(id);
  if (!d) {
    return [
      pageHead([{ label: 'Farm' }, { label: 'Devices', to: '#/devices' }], 'Device', null),
      card(null, {}, empty('That device is not in this fleet.',
        'It may have been evicted, or it belongs to another org — the API answers those the same way, on purpose.')),
    ];
  }
  const st = DEVICE_STATE[d.state] || { label: d.state, tone: '', note: '' };

  return [
    pageHead(
      [{ label: 'Farm' }, { label: 'Devices', to: '#/devices' }],
      d.model || 'Device',
      st.note,
      h('div', { class: 'row tight' },
        pill(st.label, st.tone, { live: d.state === 'READY' }),
        d.state === 'READY' ? btn('Start session', 'primary', () => startSession(d)) : null,
      ),
    ),
    h('div', { class: 'split' },
      h('div', { class: 'content' },
        card('Metadata', {},
          kv([
            ['Device id', d.id, true],
            ['Region', d.region],
            ['Platform', d.platform],
            ['OS', d.osVersion],
            ['Tier', d.tier],
            ['State', st.label],
            ['Dedicated', d.dedicated ? 'yes — reserved to this org' : 'no — shared pool'],
            ['Last reset', d.lastResetAt ? `${when(d.lastResetAt)} (${ago(d.lastResetAt)})` : 'not reported'],
          ]),
          h('p', { class: 'micro mt-lg', text: 'WebDriver' }),
          h('div', { class: 'mt-xs' }, copyrow(webdriverUrl())),
          h('p', { class: 'caption mt-xs' },
            'Authenticate with an org API key as the user half: ',
            h('code', { text: `https://<api-key>@${location.host}/wd/hub` }),
          ),
        ),
        card('Capabilities', {},
          h('div', { class: 'caps' },
            KNOWN_CAPS.map((c) => chip(c, (d.capabilities || []).includes(c))),
            (d.capabilities || []).filter((c) => !KNOWN_CAPS.includes(c)).map((c) => chip(c, true)),
          ),
          h('p', { class: 'caption mt-md', text: 'A capability the device does not declare is shown struck out rather than hidden — it is why a control that needs it is missing.' }),
        ),
      ),
      h('div', { class: 'rail' }, activityCard((a) => a.deviceId === d.id)),
    ),
  ];
}

/* ---------------------------------------------------------------------------- screen: cockpit */

/**
 * One session's detail, for the cockpit.
 *
 * Separate from `state.held` because the cockpit is URL-addressable and an ENDED session is a
 * perfectly good thing to open — it is where someone goes to read what happened.
 */
async function loadSessionDetail(id) {
  try {
    const out = await api(`/v1/sessions/${encodeURIComponent(id)}`);
    state.detail = { ...out.session, dataPlane: out.dataPlane || null, fetchedAt: Date.now() };
  } catch (err) {
    state.detail = { id, missing: true, message: err.message };
  }
}

/**
 * The stage.
 *
 * The design puts a live device view here, with a control rail, a logcat dock and a vitals panel.
 * None of the four exist: there is no media path from a worker to a browser (ADR-0005 chose a TURN
 * relay and it is not deployed), and the API has no logcat, screenshot or telemetry endpoint. So
 * this states the gap in words and names what DOES reach the device, rather than rendering a frame
 * that will never show a pixel or buttons that cannot fire.
 */
function stagePanel(sess) {
  return h('div', { class: 'stage' },
    h('div', { class: 'phone' },
      h('div', { class: 'phone-screen' },
        h('div', { class: 'stack tight' },
          h('p', { class: 'micro', text: 'No live view' }),
          h('p', { class: 'help', text: 'Nothing streams this device to a browser yet — the media relay is not deployed.' }),
          h('p', { class: 'caption', text: 'Drive it with WebDriver, or install and launch a build from the panel beside this one.' }),
        ),
      ),
    ),
    h('p', { class: 'caption', text: `${sess.region || '—'} · session ${short(sess.id)} · no screen stream, no logcat, no device telemetry` }),
  );
}

function actionStatusStrip() {
  const a = state.action;
  if (!a) return null;
  const meta = ACTION_STATE[a.state] || { label: a.state, tone: '' };
  const running = a.state === 'PENDING';
  return h('div', { class: 'inset actionstrip' },
    h('div', { class: 'row tight' },
      h('span', { class: `dot ${meta.tone} ${running ? 'live' : ''}`.trim() }),
      h('span', { class: 'secondary', text: `${KIND_LABEL[a.kind] || a.kind} — ${meta.label.toLowerCase()}` }),
    ),
    h('p', { class: 'meta', text: `${a.app?.packageName || short(a.appId)} · ${ago(a.requestedAt)}` }),
    running
      ? h('div', { class: 'bar indet' }, h('i'))
      : h('p', { class: a.state === 'FAILED' ? 'meta bad-text' : 'meta ok-text', text: a.error || (a.state === 'DONE' ? 'The worker confirmed it.' : '') }),
    running ? h('p', { class: 'meta', text: 'Accepted by the API. No worker has claimed it yet.' }) : null,
  );
}

function toolsCard(sess, live) {
  const device = deviceById(sess.deviceId);
  const canInstall = (device?.capabilities || []).includes('app-install');
  const picked = state.apps.find((a) => a.id === state.pickedApp) || state.apps[0] || null;

  return card('Tools', {},
    !live
      ? h('p', { class: 'help', text: 'This session has ended. Nothing can be sent to the device.' })
      : !state.apps.length
        ? empty('No builds yet.', 'Upload an APK on the Apps screen first.')
        : !canInstall
          // Not a disabled button with a tooltip: the API refuses this with `capability_missing`,
          // so the honest UI is a sentence and a route to the thing that does work.
          ? h('p', { class: 'help', text: 'This device does not declare the app-install capability, so the API will refuse install, launch and uninstall. WebDriver still reaches it.' })
          : [
              h('select', {
                class: 'field',
                onchange: (e) => { state.pickedApp = e.target.value; render(); },
              }, state.apps.map((a) => h('option', {
                value: a.id,
                selected: picked?.id === a.id,
                text: `${a.label || a.packageName} ${a.versionName || ''}`.trim(),
              }))),
              h('div', { class: 'toolgrid mt-sm' },
                btn('Install', 'primary', () => picked && runAction(picked, 'install')),
                btn('Launch', '', () => picked && runAction(picked, 'launch')),
                btn('Uninstall', 'ghost', () => picked && runAction(picked, 'uninstall')),
                btn('Open Apps', 'ghost', () => go('#/apps')),
              ),
              h('p', { class: 'caption mt-sm', text: 'Every verb is queued and carried down on the worker’s next heartbeat — usually within 10 seconds.' }),
              actionStatusStrip(),
            ],
    // Screenshot, record, rotate, clear-app-data, send-text and pull-logcat are in the design and
    // have no endpoint. They are absent rather than disabled: a greyed button implies a permission
    // problem, when the truth is the feature does not exist.
  );
}

function connectCard(sess) {
  const dp = sess.dataPlane;
  return card('Connect to this device', {},
    h('div', { class: 'stack tight' },
      h('p', { class: 'micro', text: 'WebDriver' }),
      copyrow(webdriverUrl()),
      h('p', { class: 'micro mt-xs', text: 'Session id' }),
      copyrow(sess.id),
      dp ? [
        h('p', { class: 'micro mt-xs', text: 'Data plane' }),
        copyrow(dp.endpoint),
        h('p', { class: 'caption', text: `Token issued for ${dp.expiresInSeconds}s. Re-open this page to mint a fresh one.` }),
      ] : h('p', { class: 'caption mt-xs', text: 'No data-plane coordinates: the session holds no device, or its host has not reported an endpoint.' }),
      h('p', { class: 'caption' },
        'Bind a suite to this exact session with ',
        h('code', { text: `mfarm:bindSessionId = ${short(sess.id)}…` }),
      ),
    ),
  );
}

function screenCockpit(id) {
  const sess = state.detail?.id === id ? state.detail : state.sessions.find((s) => s.id === id);
  if (!sess || sess.missing) {
    return [
      pageHead([{ label: 'Farm' }, { label: 'Sessions', to: '#/sessions' }], 'Session', null),
      card(null, {}, empty('That session is not visible to this org.',
        'An id that belongs to another org answers exactly like one that never existed — that is the disclosure boundary, not a bug.')),
    ];
  }

  const live = LIVE_SESSION_STATES.has(sess.state) && sess.deviceId;
  const st = SESSION_STATE[sess.state] || { label: sess.state, tone: '' };
  const device = deviceById(sess.deviceId);
  const app = installedOn(sess.id);
  const acts = actionsFor(sess.id);

  return [
    pageHead(
      [{ label: 'Farm' }, { label: 'Sessions', to: '#/sessions' }],
      `Session ${short(sess.id)}`,
      null,
      h('div', { class: 'row tight' },
        pill(st.label, st.tone, { live: sess.state === 'ACTIVE' }),
        live ? btn('Release', 'danger', () => askRelease(sess), { kbd: 'R' }) : null,
      ),
    ),

    h('div', { class: 'card mb-gap' },
      h('div', { class: 'row' },
        h('span', { class: 'secondary', text: `${device?.model || sess.device || short(sess.deviceId) || 'no device'} · ${sess.region || '—'}` }),
        app ? pill(`${app.label || app.packageName} ${app.versionName || ''}`.trim(), 'warn plain', {
          dot: false,
          title: 'Session-only. Releasing restores the clean snapshot and removes it.',
        }) : null,
        h('span', { class: 'spacer' }),
        live
          ? ticker('since', sess.startedAt || sess.createdAt, { prefix: 'running ', cls: 'caption' })
          : h('span', { class: 'caption tnum', text: `ran ${duration(sess.startedAt || sess.createdAt, sess.endedAt)}` }),
        copyrow(sess.id, 'Copy id'),
      ),
      live && sess.expiresAt ? h('div', { class: 'mt-md' }, leaseBlock(sess)) : null,
      // No Extend button: there is no endpoint that moves `expires_at`, and a button that silently
      // does nothing is worse than its absence.
      sess.endReason ? h('p', { class: 'caption mt-sm', text: `Ended: ${sess.endReason}` }) : null,
    ),

    h('div', { class: 'split' },
      h('div', { class: 'content' },
        stagePanel(sess),
        card('Actions on this session', { aside: h('span', { class: 'caption', text: `${acts.length} total` }) },
          acts.length
            ? h('div', { class: 'tablewrap' }, h('table', { class: 'table narrow' },
                h('thead', null, h('tr', null, ['What', 'Build', 'State', 'When'].map((t) => h('th', { text: t })))),
                h('tbody', null, acts.map((a) => {
                  const meta = ACTION_STATE[a.state] || { label: a.state, tone: '' };
                  return h('tr', null,
                    h('td', { text: KIND_LABEL[a.kind] || a.kind }),
                    h('td', { class: 'mono', text: appById(a.appId)?.packageName || short(a.appId) }),
                    h('td', null,
                      h('span', { class: 'row tight' }, h('span', { class: `dot ${meta.tone}` }), meta.label),
                      // The worker's own words, rendered as TEXT. This string came off a device via
                      // adb and is the most attacker-influenced value on the page.
                      a.error ? h('p', { class: 'caption bad-text', text: a.error }) : null,
                    ),
                    h('td', { class: 'caption', text: `${ago(a.finishedAt || a.requestedAt)}` }),
                  );
                })),
              ))
            : empty('Nothing has been sent to this device.', 'Install a build from the panel beside this one.'),
        ),
      ),
      h('div', { class: 'rail' },
        toolsCard(sess, live),
        connectCard(sess),
        card('Activity', {},
          acts.length
            ? timeline(acts.slice(0, 10).map((a) => {
                const meta = ACTION_STATE[a.state] || { label: a.state, tone: '' };
                return {
                  tone: meta.tone,
                  title: `${KIND_LABEL[a.kind] || a.kind} — ${meta.label.toLowerCase()}`,
                  note: `${appById(a.appId)?.packageName || short(a.appId)} · ${ago(a.finishedAt || a.requestedAt)}`,
                };
              }))
            : h('p', { class: 'help', text: 'Nothing yet.' }),
        ),
      ),
    ),
  ];
}

/* ---------------------------------------------------------------------------- screen: apps */

/**
 * Upload with XMLHttpRequest rather than fetch, for one reason: fetch cannot report UPLOAD progress.
 *
 * An APK is tens to hundreds of megabytes and a farm is often on the other end of a slow link, so a
 * control that goes quiet for two minutes is indistinguishable from one that is broken. The
 * credential rules are repeated here explicitly because this is the one call site that does not go
 * through `api()`.
 */
function uploadApk(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/v1/apps?filename=${encodeURIComponent(file.name)}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', 'application/vnd.android.package-archive');
    if (state.csrf) xhr.setRequestHeader('x-mfarm-csrf', state.csrf);

    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable || !state.upload) return;
      state.upload.pct = Math.round((e.loaded / e.total) * 100);
      // Written straight to the node rather than through render(): a re-render per progress event
      // would rebuild the page sixty times a second for a number that only moves a bar.
      const bar = $('upload-bar');
      if (bar) bar.style.width = `${state.upload.pct}%`;
      const stage = $('upload-stage');
      if (stage && state.upload.pct >= 100) {
        state.upload.stage = 'Processing on farm';
        stage.textContent = state.upload.stage;
      }
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
  state.upload = { name: file.name, pct: 0, stage: 'Uploading', error: null };
  render();
  try {
    const out = await uploadApk(file);
    state.upload.stage = 'Ready to install';
    // 200 means the org already had these exact bytes. Saying so is the difference between "my
    // upload did nothing" and "there was nothing to do", and only one of those sends someone
    // looking for a bug.
    toast(
      out.deduplicated ? 'Already in the library' : 'Build uploaded',
      `${out.app.packageName} ${out.app.versionName || ''} · ${bytes(out.app.sizeBytes)}`.replace(/\s+/g, ' '),
      'ok',
    );
    await refreshApps();
  } catch (e) {
    state.upload.error = e.message;
    toast('Upload failed', e.message, 'bad');
  }
  setTimeout(() => { state.upload = null; render(); }, 2500);
  render();
}

function dropZone() {
  const input = h('input', {
    type: 'file',
    id: 'apk-input',
    accept: '.apk,application/vnd.android.package-archive',
    hidden: true,
    onchange: (e) => handleFile(e.target.files?.[0]),
  });

  const zone = h('label', { class: 'drop', for: 'apk-input' },
    h('span', { class: 'drop-icon', text: '↑' }),
    h('div', { class: 'stack tight' },
      h('p', { class: 'buildname', text: 'Drop an APK here' }),
      h('p', { class: 'help', text: 'Package, version and size are read on the farm before the build becomes installable. Re-uploading the same file is free — builds are keyed on their checksum.' }),
    ),
    h('span', { class: 'spacer' }),
    h('span', { class: 'btn primary', text: 'Select file' }),
    input,
  );

  for (const [event, over] of [['dragenter', true], ['dragover', true], ['dragleave', false], ['drop', false]]) {
    zone.addEventListener(event, (e) => {
      e.preventDefault();
      zone.classList.toggle('is-over', over);
      if (event === 'drop') handleFile(e.dataTransfer?.files?.[0]);
    });
  }
  return zone;
}

function uploadCard() {
  const u = state.upload;
  if (!u) return null;
  const done = u.stage === 'Ready to install';
  return card(null, { class: 'stack tight' },
    h('div', { class: 'row between' },
      h('code', { class: 'secondary', text: u.name }),
      h('span', { class: u.error ? 'bad-text' : done ? 'ok-text' : 'warn-text', id: 'upload-stage', text: u.error ? 'Failed' : done ? 'Ready to install' : `${u.stage} ${u.pct}%` }),
    ),
    h('div', { class: `bar ${u.error ? 'bad' : done ? 'ok' : ''}`.trim() },
      h('i', { id: 'upload-bar', style: { width: `${u.error || done ? 100 : u.pct}%` } })),
    u.error ? h('p', { class: 'error-text', text: u.error }) : null,
  );
}

function holdStrip() {
  const held = heldSession();
  const ready = state.devices.filter((d) => d.state === 'READY');
  return card('Device', {},
    held
      ? h('div', { class: 'row between' },
          h('div', { class: 'stack tight' },
            h('p', { class: 'row tight' }, h('span', { class: 'dot ok live' }),
              h('span', { class: 'secondary', text: `Holding ${held.device || short(held.deviceId)} · session ${short(held.id)}` })),
            h('p', { class: 'caption', text: 'An app lives on a device only while you hold it. Releasing restores the clean snapshot, which is what makes the next session trustworthy — and what removes your build.' }),
          ),
          h('div', { class: 'row tight' },
            btn('Cockpit', 'ghost', () => go(`#/sessions/${held.id}`)),
            btn('Release', 'danger', () => askRelease(held)),
          ),
        )
      : h('div', { class: 'row between' },
          h('div', { class: 'stack tight' },
            h('p', { class: 'row tight' }, h('span', { class: 'dot' }),
              h('span', { class: 'secondary', text: ready.length ? `Not holding a device. ${ready.length} ready.` : 'Not holding a device, and none are ready.' })),
            h('p', { class: 'caption', text: 'Installing needs a live session — the build goes onto the device you are holding, and nowhere else.' }),
          ),
          btn('Go to Devices', 'ghost', () => go('#/devices')),
        ),
  );
}

function buildRow(a) {
  const held = heldSession();
  const device = held ? deviceById(held.deviceId) : null;
  const canInstall = (device?.capabilities || []).includes('app-install');
  const on = held && installedOn(held.id)?.id === a.id;

  return h('div', { class: 'buildrow' },
    h('div', { class: 'idc stack tight' },
      h('p', null, h('span', { class: 'buildname', text: a.label || a.packageName }), ' ',
        h('span', { class: 'secondary', text: a.versionName || (a.versionCode == null ? '' : `code ${a.versionCode}`) })),
      h('p', { class: 'caption', text: `${a.packageName} · ${bytes(a.sizeBytes)}${a.minSdk ? ` · minSdk ${a.minSdk}` : ''}` }),
    ),
    h('span', { class: 'caption', text: ago(a.createdAt) }),
    on
      ? h('span', { class: 'row tight' }, h('span', { class: 'dot ok' }), h('span', { class: 'ok-text', text: `Installed · ${held.device || short(held.deviceId)}` }))
      : h('span', { class: 'caption', text: 'Not installed' }),
    h('span', { class: 'spacer' }),
    h('div', { class: 'rowactions' },
      on
        ? [btn('Launch', 'primary', () => runAction(a, 'launch'), { disabled: !canInstall }),
           btn('Uninstall', 'ghost', () => runAction(a, 'uninstall'), { disabled: !canInstall })]
        : btn('Install', 'primary', () => runAction(a, 'install'), {
            disabled: !held || !canInstall,
            title: !held ? 'Hold a device first' : !canInstall ? 'This device does not declare app-install' : '',
          }),
      held ? btn('Session', 'ghost', () => go(`#/sessions/${held.id}`)) : null,
    ),
  );
}

/** The most recent failure, shown as its own card rather than a red word in a row. */
function failureCard() {
  const f = state.actions.find((a) => a.state === 'FAILED');
  // Scoped to the last half hour. The action list holds 100 rows, and without this a failure from
  // last Tuesday would sit at the top of Apps forever, looking like it had just happened.
  if (!f || Date.now() - new Date(f.finishedAt || f.requestedAt) > 1_800_000) return null;
  const app = appById(f.appId);
  return card(null, { class: 'stack tight' },
    h('div', { class: 'row tight' }, h('span', { class: 'dot bad' }),
      h('span', { class: 'card-title bad-text', text: `${KIND_LABEL[f.kind] || f.kind} failed` })),
    h('p', { class: 'help', text: `The worker could not ${f.kind} ${app?.packageName || short(f.appId)} on ${deviceById(f.deviceId)?.model || short(f.deviceId)}.` }),
    h('div', { class: 'inset stack tight' },
      h('p', { class: 'micro', text: 'Reason' }),
      // Straight from the worker, as text.
      h('code', { class: 'mono-bad', text: f.error || 'The worker reported no reason.' }),
    ),
    h('div', { class: 'row tight' },
      app ? btn('Retry', '', () => runAction(app, f.kind), { disabled: !heldSession() }) : null,
      btn('Open session', 'ghost', () => go(`#/sessions/${f.sessionId}`)),
    ),
    h('p', { class: 'caption', text: `${ago(f.finishedAt || f.requestedAt)} · session ${short(f.sessionId)}` }),
  );
}

/**
 * The action lifecycle, as the system actually has it.
 *
 * The design shows four stages — queued, picked up, running, succeeded/failed. The schema has
 * three, and deliberately: a worker reports the OUTCOME and never the start, so "running" would be
 * a state nothing could ever leave if that worker died. This renders the real three and says why
 * the middle one is missing, which is more reassuring than a stage that never lights.
 */
function lifecycleCard() {
  return card('Action lifecycle', {},
    timeline([
      { tone: 'warn', title: 'Queued', note: 'Accepted by the API. No worker has claimed it yet.' },
      { tone: 'ok', title: 'Succeeded', note: 'Reported only after the worker confirms it.' },
      { tone: 'bad', title: 'Failed', note: 'The worker’s own error, verbatim.' },
    ]),
    h('p', { class: 'caption mt-md', text: 'A worker picks up queued work on its next heartbeat — usually within 10 seconds. Nothing here reports success before the worker confirms it.' }),
    h('p', { class: 'caption mt-sm', text: 'There is no “running” state to show: a worker reports the outcome, never the start, so a stage between the two could never be left if that worker stopped answering.' }),
  );
}

function screenApps() {
  return [
    pageHead([{ label: 'Farm' }], 'Apps', 'Builds live on the farm; installs live only inside a session.'),
    h('div', { class: 'split' },
      h('div', { class: 'content' },
        holdStrip(),
        dropZone(),
        uploadCard(),
        failureCard(),
        card('Build library', {
          aside: h('span', { class: 'caption', text: `${state.apps.length} build${state.apps.length === 1 ? '' : 's'}` }),
          class: 'flush',
        },
          state.apps.length
            ? h('div', null, state.apps.map(buildRow))
            : empty('No builds yet.', 'Upload an APK to start testing.'),
        ),
      ),
      h('div', { class: 'rail' }, lifecycleCard(), activityCard()),
    ),
  ];
}

/* ---------------------------------------------------------------------------- screen: sessions */

function screenSessions() {
  const rows = state.sessions;
  return [
    pageHead([{ label: 'Farm' }], 'Sessions',
      'Every session this org has opened, newest first. A WebDriver suite creates these too.'),
    card(null, { class: 'flush' },
      rows.length
        ? h('div', { class: 'tablewrap' }, h('table', { class: 'table wide' },
            h('thead', null, h('tr', null,
              ['State', 'Session', 'Device', 'Region', 'Started', 'Duration', ''].map((t) => h('th', { text: t })))),
            h('tbody', null, rows.map((s) => {
              const st = SESSION_STATE[s.state] || { label: s.state, tone: '' };
              return h('tr', null,
                h('td', null, pill(st.label, st.tone, { live: s.state === 'ACTIVE' })),
                h('td', null, h('div', { class: 'row tight' },
                  h('code', { text: s.id }),
                  btn('copy', 'tiny ghost', async () => {
                    try { await navigator.clipboard.writeText(s.id); toast('Session id copied', s.id, 'ok'); }
                    catch { toast('Could not copy', 'Select the text instead.', 'bad'); }
                  }),
                )),
                h('td', { text: s.device || short(s.deviceId) }),
                h('td', { text: s.region || '—' }),
                h('td', { class: 'caption', text: s.startedAt ? ago(s.startedAt) : ago(s.createdAt), title: when(s.startedAt || s.createdAt) }),
                h('td', null, s.startedAt && !s.endedAt
                  ? ticker('since', s.startedAt)
                  : h('span', { class: 'tnum', text: duration(s.startedAt, s.endedAt) })),
                h('td', { class: 'right' }, btn('Open', 'tiny ghost', () => go(`#/sessions/${s.id}`))),
              );
            })),
          ))
        : empty('No sessions yet.', 'Start one from Devices, or point a WebDriver suite at the hub.'),
    ),
    // The full id, never a prefix: it is what `mfarm app install --session` needs and what the
    // WebDriver URL carries in its password half, and neither accepts eight characters.
    h('p', { class: 'caption mt-md', text: 'Ids are shown in full because that is the form every client needs.' }),
  ];
}

/* ---------------------------------------------------------------------------- screen: queue */

function screenQueue() {
  const waiting = queuedSessions();
  const holding = state.sessions.filter((s) => LIVE_SESSION_STATES.has(s.state) && s.deviceId);
  const mine = heldSession();

  return [
    pageHead([{ label: 'Operations' }], 'Queue',
      `${holding.length} device${holding.length === 1 ? '' : 's'} held · ${waiting.length} waiting`),
    h('div', { class: 'split' },
      h('div', { class: 'content' },
        card('Leases', {},
          holding.length
            ? h('div', { class: 'stack' }, holding.map((s) => {
                const isMine = mine?.id === s.id;
                const detail = isMine && state.held?.id === s.id ? state.held : null;
                return h('div', { class: 'inset stack tight' },
                  h('div', { class: 'row between' },
                    h('span', { class: 'row tight' }, h('span', { class: 'dot accent' }),
                      h('span', { class: 'secondary', text: `${s.device || short(s.deviceId)}${isMine ? ' (yours)' : ''}` })),
                    ticker('since', s.startedAt || s.createdAt, { prefix: 'held ', cls: 'caption' }),
                  ),
                  h('p', { class: 'caption', text: `Session ${short(s.id)} · ${s.region}` }),
                  detail ? leaseBlock(detail) : h('p', { class: 'caption', text: 'Lease time is only reported for your own session.' }),
                );
              }))
            : empty('Nobody is using the farm right now.', 'Every device is on its clean snapshot.'),
        ),
        card('Waiting', {},
          waiting.length
            ? h('div', { class: 'stack' }, waiting.map((s, i) => h('div', { class: 'row between' },
                h('div', { class: 'stack tight' },
                  h('span', { class: 'row tight' },
                    h('span', { class: 'dot warn live' }),
                    h('span', { class: 'secondary', text: `#${i + 1} · session ${short(s.id)}` })),
                  h('p', { class: 'caption', text: `Requested ${s.region}` }),
                ),
                ticker('since', s.createdAt, { prefix: 'waiting ', cls: 'secondary' }),
              )))
            : empty('Nobody is waiting.', 'All devices are available.'),
          waiting.length
            ? h('p', { class: 'caption mt-md', text: 'No estimated availability is shown: it would need every holder’s remaining lease, and the API reports that only for your own session. A guess dressed as a number is worse than nothing.' })
            : null,
        ),
      ),
      h('div', { class: 'rail' }, activityCard()),
    ),
  ];
}

/* ---------------------------------------------------------------------------- screen: health */

function screenHealth() {
  const byState = {};
  for (const d of state.devices) byState[d.state] = (byState[d.state] || 0) + 1;
  const dayAgo = Date.now() - 86_400_000;
  const failures = state.actions.filter((a) => a.state === 'FAILED' && new Date(a.finishedAt || a.requestedAt) > dayAgo);
  const active = state.sessions.filter((s) => LIVE_SESSION_STATES.has(s.state)).length;

  const stat = (label, value, tone, note) => card(null, { class: 'stat stack tight' },
    h('p', { class: 'micro', text: label }),
    h('p', { class: 'row tight' }, h('span', { class: `dot ${tone || ''}`.trim() }), h('span', { class: 'val', text: value })),
    h('p', { class: 'caption', text: note }),
  );

  return [
    pageHead([{ label: 'Operations' }], 'Farm health', 'What the control plane can see from here.'),
    h('div', { class: 'statgrid mb-gap' },
      stat('Devices ready', `${state.available}/${state.devices.length}`, state.available ? 'ok' : 'warn', state.available ? 'Allocatable now' : 'Nothing can be allocated'),
      stat('Sessions active', String(active), active ? 'accent' : '', 'Holding a device'),
      stat('Queue', String(queuedSessions().length), queuedSessions().length ? 'warn' : 'ok', 'Waiting for capacity'),
      stat('Builds', String(state.apps.length), '', 'In the library'),
      stat('Failed actions', String(failures.length), failures.length ? 'bad' : 'ok', 'Last 24 hours'),
    ),
    h('div', { class: 'split' },
      h('div', { class: 'content' },
        card('Device health', { class: 'flush' },
          state.devices.length
            ? h('div', null, state.devices.map((d) => {
                const st = DEVICE_STATE[d.state] || { label: d.state, tone: '' };
                return h('div', { class: 'buildrow' },
                  h('span', { class: 'row tight idc' },
                    h('span', { class: `dot ${st.tone} ${d.state === 'READY' ? 'live' : ''}`.trim() }),
                    h('span', { class: 'secondary', text: d.model || short(d.id) }),
                    h('code', { class: 'caption', text: short(d.id) }),
                  ),
                  h('span', { class: 'caption', text: `${d.platform} ${d.osVersion} · ${d.tier} · ${d.region}` }),
                  h('span', { class: 'spacer' }),
                  pill(st.label, st.tone, { dot: false }),
                );
              }))
            : empty('No devices registered.', 'Start a worker and it appears within a heartbeat.'),
        ),
        card('Recent failures', {},
          failures.length
            ? timeline(failures.slice(0, 8).map((a) => ({
                tone: 'bad',
                title: `${KIND_LABEL[a.kind] || a.kind} ${appById(a.appId)?.packageName || short(a.appId)}`,
                note: `${a.error || 'no reason reported'} · ${ago(a.finishedAt || a.requestedAt)}`,
              })))
            : empty('Nothing has failed in the last day.', null),
        ),
      ),
      h('div', { class: 'rail' },
        card('Worker', {},
          // The heartbeat is the number this screen most wants, and POST /v1/workers/heartbeat is
          // the only route that touches it — worker-authenticated and write-only. There is no read
          // endpoint for host state, so this says so instead of showing a dot that means nothing.
          h('p', { class: 'help', text: 'Worker heartbeat and host state are not readable from the console: the only heartbeat route is the workers’ own write path, and the API exposes no host read endpoint.' }),
          h('p', { class: 'caption mt-sm', text: 'A host that stops heartbeating still shows here indirectly — its devices leave READY, so “Devices ready” drops.' }),
        ),
        activityCard(),
      ),
    ),
  ];
}

/* ---------------------------------------------------------------------------- palette */

function commands() {
  const held = heldSession();
  const list = [
    { glyph: '■', label: 'Open Devices', group: 'Go', run: () => go('#/devices') },
    { glyph: '✚', label: 'Open Apps', group: 'Go', run: () => go('#/apps') },
    { glyph: '☰', label: 'Open Sessions', group: 'Go', run: () => go('#/sessions') },
    { glyph: '⋮', label: 'Open Queue', group: 'Go', run: () => go('#/queue') },
    { glyph: '◎', label: 'Open Farm health', group: 'Go', run: () => go('#/health') },
  ];
  if (held) {
    list.unshift({ glyph: '▶', label: 'Open your session cockpit', group: 'Session', run: () => go(`#/sessions/${held.id}`) });
    list.push({ glyph: '⏻', label: 'Release your device', group: 'Session', run: () => askRelease(held) });
  }
  for (const d of state.devices) {
    if (d.state === 'READY') {
      list.push({ glyph: '＋', label: `Start a session on ${d.model || short(d.id)} (tier ${d.tier})`, group: 'Device', run: () => startSession(d) });
    }
    list.push({ glyph: '□', label: `Open ${d.model || short(d.id)}`, group: 'Device', run: () => go(`#/devices/${d.id}`) });
  }
  list.push({ glyph: '⇧', label: 'Upload an APK', group: 'Apps', run: () => { go('#/apps'); setTimeout(() => $('apk-input')?.click(), 60); } });
  list.push({
    glyph: '⧉', label: 'Copy the WebDriver URL', group: 'Apps',
    run: async () => {
      try { await navigator.clipboard.writeText(webdriverUrl()); toast('Copied', webdriverUrl(), 'ok'); }
      catch { toast('Could not copy', 'The clipboard was refused.', 'bad'); }
    },
  });
  list.push({ glyph: '«', label: 'Toggle the sidebar', group: 'View', run: () => $('navtoggle').click() });
  return list;
}

function paletteMatches() {
  const q = $('palette-input').value.trim().toLowerCase();
  const all = commands();
  return q ? all.filter((c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)) : all;
}

function renderPalette() {
  const items = paletteMatches();
  if (state.palIndex >= items.length) state.palIndex = Math.max(0, items.length - 1);
  const ul = $('palette-list');
  ul.replaceChildren(...items.map((c, i) => h('li', null,
    h('button', {
      class: `cmd ${i === state.palIndex ? 'is-sel' : ''}`.trim(),
      type: 'button',
      onclick: () => { closeOverlays(); c.run(); },
    },
      h('span', { class: 'glyph', text: c.glyph }),
      h('span', { text: c.label }),
      h('span', { class: 'grp', text: c.group }),
    ))));
  if (!items.length) ul.replaceChildren(h('li', null, h('p', { class: 'empty', text: 'Nothing matches.' })));
}

function openPalette() {
  state.palIndex = 0;
  $('palette-input').value = '';
  $('palette').hidden = false;
  $('scrim').hidden = false;
  renderPalette();
  $('palette-input').focus();
}

$('palette-btn').addEventListener('click', openPalette);
$('palette-input').addEventListener('input', () => { state.palIndex = 0; renderPalette(); });
$('palette-input').addEventListener('keydown', (e) => {
  const items = paletteMatches();
  if (e.key === 'ArrowDown') { e.preventDefault(); state.palIndex = Math.min(state.palIndex + 1, items.length - 1); renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); state.palIndex = Math.max(state.palIndex - 1, 0); renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); const c = items[state.palIndex]; if (c) { closeOverlays(); c.run(); } }
});

/* ---------------------------------------------------------------------------- keyboard */

/**
 * The keyboard layer.
 *
 * Every handler bails on events originating in a field — otherwise typing "r" into the palette
 * filter would arm a device release, which is exactly the class of accident this console must not
 * have. `S` (screenshot) and `L` (logcat) from the design are absent: there is nothing to bind them
 * to.
 */
let gPending = 0;
const G_ROUTES = { d: 'devices', a: 'apps', r: 'sessions', q: 'queue', h: 'health' };

function inField(e) {
  const t = e.target;
  return t instanceof HTMLElement
    && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeOverlays(); return; }
  if (!state.me) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if ($('palette').hidden) openPalette(); else closeOverlays();
    return;
  }
  if (inField(e) || e.metaKey || e.ctrlKey || e.altKey) return;

  const k = e.key.toLowerCase();

  if (Date.now() - gPending < 900 && G_ROUTES[k]) {
    gPending = 0;
    e.preventDefault();
    go(`#/${G_ROUTES[k]}`);
    return;
  }
  if (k === 'g') { gPending = Date.now(); return; }
  gPending = 0;

  // Release, only from the cockpit and only for a session that holds a device — the same guard the
  // button has, because a shortcut that is more powerful than the control it mirrors is a trap.
  if (k === 'r' && state.route.name === 'cockpit') {
    const sess = state.sessions.find((s) => s.id === state.route.id);
    if (sess && LIVE_SESSION_STATES.has(sess.state) && sess.deviceId) { e.preventDefault(); askRelease(sess); }
  }
});

/* ---------------------------------------------------------------------------- render */

const SCREENS = {
  devices: () => screenDevices(),
  device: () => screenDevice(state.route.id),
  apps: () => screenApps(),
  sessions: () => screenSessions(),
  cockpit: () => screenCockpit(state.route.id),
  queue: () => screenQueue(),
  health: () => screenHealth(),
};

/**
 * A render is deferred while a pointer is held down, and resumed on release.
 *
 * `replaceChildren` throws away the node a click is travelling to, and the browser then has no
 * common target for mousedown and mouseup — so the click never happens. Polling every five seconds
 * makes that a routine occurrence rather than a rare one, and the button it eats might be Release.
 */
let pointerDown = false;
let renderQueued = false;

document.addEventListener('pointerdown', () => { pointerDown = true; });
for (const ev of ['pointerup', 'pointercancel']) {
  document.addEventListener(ev, () => {
    pointerDown = false;
    if (renderQueued) { renderQueued = false; setTimeout(render, 0); }
  });
}

function render() {
  if (!state.me) return;
  if (pointerDown) { renderQueued = true; return; }
  renderChrome();
  const main = $('main');
  main.replaceChildren();
  add(main, [(SCREENS[state.route.name] || SCREENS.devices)()]);
}

/**
 * The 1s tick. It repaints counters and touches nothing else.
 *
 * Deliberately NOT a re-render: see `ticker()`. Rebuilding the page under a person's cursor loses
 * clicks, and on this console a lost click is a device that did not get released.
 */
function startTick() {
  if (state.tick) clearInterval(state.tick);
  state.tick = setInterval(() => {
    if (!state.me || document.hidden) return;
    for (const n of document.querySelectorAll('[data-tick]')) paintTicker(n);
    for (const i of document.querySelectorAll('.bar.lease > i')) paintBar(i);
    renderChrome();
  }, 1000);
}

/**
 * Polling rather than a socket: the fleet is small, the page is open on a desk, and a poll cannot
 * get stuck half-connected the way a socket can. Paused while the tab is hidden so a forgotten tab
 * does not bill the API all weekend.
 */
function startPoll() {
  if (state.poll) clearInterval(state.poll);
  state.poll = setInterval(async () => {
    if (document.hidden || !state.me) return;
    try {
      await Promise.all([refreshDevices(), refreshSessions(), refreshActions()]);
      if (state.route.name === 'apps') await refreshApps();
      await refreshHeld();
      if (state.route.name === 'cockpit' && state.detail?.id === state.route.id
          && Date.now() - (state.detail.fetchedAt || 0) > 10_000) {
        await loadSessionDetail(state.route.id);
      }
      state.error = null;
      render();
    } catch (err) {
      // A failed poll must not blank a working page or spam a toast every five seconds.
      if (state.error !== err.message) { state.error = err.message; toast('Lost contact with the API', err.message, 'bad'); }
    }
  }, 5000);
}

/**
 * Coming back to a tab that was left in the background.
 *
 * Both the poll and the tick stop while the page is hidden, deliberately — a forgotten tab should
 * not bill the API all weekend. The cost is that everything on screen is as old as the moment it
 * was hidden, so the first thing a returning person sees is a stale lease and a stale fleet. This
 * catches up immediately instead of showing yesterday's numbers for up to five seconds.
 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.me) return;
  for (const n of document.querySelectorAll('[data-tick]')) paintTicker(n);
  refreshAll().then(render).catch(() => { /* the poll will try again in five seconds */ });
});

/* ---------------------------------------------------------------------------- sign in */

function showSignin(message) {
  $('signin').hidden = false;
  $('console').hidden = true;
  const err = $('signin-error');
  if (message) { err.textContent = message; err.hidden = false; } else { err.hidden = true; }
}

function signedOut() {
  state.me = null;
  state.csrf = null;
  state.detail = null;
  state.held = null;
  if (state.poll) { clearInterval(state.poll); state.poll = null; }
  if (state.tick) { clearInterval(state.tick); state.tick = null; }
  closeOverlays();
  showSignin('Your session ended. Please sign in again.');
}

$('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = $('signin-btn');
  b.disabled = true;
  b.textContent = 'Signing in…';
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
    b.disabled = false;
    b.replaceChildren(document.createTextNode('Enter the farm '), h('kbd', { text: '↵' }));
  }
});

$('signout').addEventListener('click', async () => {
  try { await api('/v1/auth/logout', { method: 'POST' }); } catch { /* leaving anyway */ }
  state.me = null;
  state.csrf = null;
  if (state.poll) { clearInterval(state.poll); state.poll = null; }
  if (state.tick) { clearInterval(state.tick); state.tick = null; }
  showSignin();
});

$('copy-hub-pre').addEventListener('click', async () => {
  const v = $('hub-preview').textContent;
  try { await navigator.clipboard.writeText(v); toast('Copied', v, 'ok'); }
  catch { toast('Could not copy', 'Select the text instead.', 'bad'); }
});

/**
 * The FARM UP pill, and the only network call this page makes before anyone signs in.
 *
 * `/health` is genuinely public. The four live stat cards the design puts beside it are not
 * possible without breaking the boundary that makes this page safe to serve to anyone, so they are
 * absent rather than faked.
 */
async function checkReach() {
  const dot = $('reach-pill').querySelector('.dot');
  try {
    const res = await fetch('/health', { credentials: 'omit' });
    const ok = res.ok;
    $('reach-pill').className = `pill ${ok ? 'ok' : 'bad'}`;
    dot.className = `dot ${ok ? 'ok live' : 'bad'}`;
    $('reach-text').textContent = ok ? 'farm up' : 'farm unreachable';
  } catch {
    $('reach-pill').className = 'pill bad';
    dot.className = 'dot bad';
    $('reach-text').textContent = 'farm unreachable';
  }
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
  $('who-avatar').textContent = (me.user.email || '?').slice(0, 1).toUpperCase();
  $('who-avatar').title = `${me.user.email} · ${me.org.name} · ${me.role}`;
  $('palette-kbd').textContent = navigator.platform?.startsWith('Mac') ? '⌘K' : 'Ctrl K';

  state.route = parseHash();
  await refreshAll();
  if (state.route.name === 'cockpit') await loadSessionDetail(state.route.id);
  render();
  startPoll();
  startTick();
}

// Restore the sidebar width before first paint so it does not flash open then collapse.
try {
  const nav = localStorage.getItem('mf-nav');
  if (nav === 'icons') { root.dataset.nav = 'icons'; $('navtoggle').firstElementChild.textContent = '»'; }
} catch { /* private mode */ }

$('hub-preview').textContent = `https://<api-key>@${location.host}/wd/hub`;
checkReach();
boot().catch(() => showSignin());
