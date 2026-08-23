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
 *      control plane has no endpoint behind — team, activity, settings, evidence — this file states
 *      the gap in words instead of inventing the data. Each such omission is commented where it
 *      would otherwise be. The live view, logcat and screenshots left that list with ADR-0007 and
 *      are now driven by a real socket to a real device; every one of them is still gated on the
 *      device DECLARING the capability, which is the same rule under a different name.
 *   4. NO OPTIMISTIC UI ON DEVICE ACTIONS. The control plane cannot dial a worker; every app
 *      action is a job a heartbeat carries down. Nothing reports success before the worker does.
 */

import { ATTACHED, LiveSession, parseLogLine, parseHierarchy, nodeAt, selectorsFor } from '/live.js';

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

/**
 * Exported ONLY so the screen smoke test can seed it and call each screen (see
 * `apps/api/test/console-screens.test.ts`). Nothing in the browser imports this module, so the
 * export costs nothing at runtime and is not an invitation to reach in from elsewhere.
 */
export const state = {
  csrf: null,
  me: null,
  devices: [],
  available: 0,
  sessions: [],
  apps: [],
  actions: [],
  /**
   * Runs — one row per CI job, not per test. The rollup is entirely server-side (`GET /v1/runs`):
   * counts, the window, and the build, which is named only when every session in the run installed
   * the same one. Nothing here derives a status, because a run has no end signal to derive one
   * from — a sequential suite ends every session before starting the next.
   */
  runs: [],
  /** `GET /runs/:id` for the run detail screen: the rollup plus every session in it. */
  runDetail: null,
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

  /**
   * The live view for the cockpit's current session.
   *
   * One at a time, deliberately. Two open viewers means two peer connections relaying video for the
   * same person, and on a relayed path that is twice the egress for nothing — so navigating away
   * tears the old one down before anything else opens.
   */
  live: null,
  liveState: 'idle',
  liveDetail: null,
  liveStats: { fps: 0, kbps: 0, rtt: null, ice: null },
  /** Ring buffer of parsed logcat lines, plus what the dock is filtering to. */
  log: { lines: [], filter: '', level: 'ALL', follow: true, dropped: 0 },
  /** Screenshots taken this session. Data urls, in memory only — nothing persists them yet. */
  shots: [],
  /**
   * The ORGANISATION screens. Loaded on demand rather than with the fleet: this changes when a
   * person changes it, not every five seconds, and polling it would spend requests on nothing.
   *
   * `newKey` holds a freshly minted secret for exactly as long as the page shows it. It is never
   * written anywhere else, because the server cannot return it a second time.
   */
  org: { members: [], keys: [], loaded: false, newKey: null },
  /**
   * Artifacts for the session detail screen, keyed by session id.
   *
   * Per session rather than one org-wide list: a session's evidence is only ever looked at from
   * that session, and a farm that has been running for a fortnight has more artifacts than anyone
   * wants delivered to a page that shows six of them.
   */
  artifacts: { sessionId: null, items: [], loaded: false },
  /**
   * The element inspector. `nodes` is the last dump, `picked` the node under the last click.
   *
   * A dump is a snapshot, not a subscription: the screen moves and the tree goes stale, so `at`
   * records when it was taken and the panel says so rather than quietly describing a screen that
   * is no longer there.
   */
  inspect: { on: false, nodes: [], picked: null, at: null, loading: false, error: null },
  /**
   * The device panel's live DOM, kept across renders so the <video> is never destroyed.
   * See `stagePanel`. Cleared only when the viewer closes.
   */
  stage: null,

  /** What the launch screen has selected, kept across re-renders and across a queued wait. */
  launch: { appId: null, deviceId: null, ttlMinutes: 60, launchAfterInstall: true },
  /** The bring-up in progress: `{ sessionId, steps, appId, error }`. */
  bringup: null,

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
const KNOWN_CAPS = ['app-install', 'webdriver', 'snapshot-reset', 'screen-stream', 'logcat', 'screenshot'];

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
    // `labelId` makes the text paintable. Anything that changes every second belongs in a painter,
    // not in a render — see `renderIfChanged`.
    opts.labelId ? h('span', { id: opts.labelId, text: label }) : label,
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

/**
 * A dialog that collects something, as opposed to `confirmDialog` which only asks permission.
 *
 * Same element and same scrim, so Escape and the backdrop close it the way they close the other one.
 * The submit button is primary rather than `danger-solid`: these dialogs add access, they do not
 * remove it, and reusing the destructive styling for both teaches people to ignore red.
 */
function formDialog({ title, lead, fields, submit, onSubmit }) {
  const d = $('dialog');
  const go = async () => { closeOverlays(); await onSubmit(); };
  d.replaceChildren(
    h('h2', { id: 'dialog-title', text: title }),
    lead ? h('p', { class: 'help mt-xs', text: lead }) : null,
    h('div', { class: 'stack mt-lg' }, fields),
    h('div', { class: 'row end mt-xl' },
      btn('Cancel', 'ghost', closeOverlays),
      btn(submit, 'primary', go),
    ),
  );
  d.hidden = false;
  $('scrim').hidden = false;
  dialogOpen = true;
  // Focus the first thing a person has to type into, not the cancel button.
  (d.querySelector('input:not([disabled])') || d.querySelector('.btn.ghost'))?.focus();
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

/**
 * Load the team and the key list together.
 *
 * Both screens need both: Settings shows who can mint a key, Team shows nothing without members.
 * One round trip pair on navigation is cheaper than two screens each fetching on mount.
 */
async function loadArtifacts(sessionId) {
  if (state.artifacts.sessionId === sessionId && state.artifacts.loaded) return;
  state.artifacts = { sessionId, items: [], loaded: false };
  try {
    const out = await api(`/v1/sessions/${encodeURIComponent(sessionId)}/artifacts`);
    // Guard against a slower request for a session the person has already navigated away from
    // landing on top of a newer one.
    if (state.artifacts.sessionId !== sessionId) return;
    state.artifacts = { sessionId, items: out.artifacts || [], loaded: true };
  } catch {
    state.artifacts = { sessionId, items: [], loaded: true };
  }
}

async function refreshOrg() {
  const [members, keys] = await Promise.all([
    api('/v1/account/members'),
    api('/v1/account/api-keys'),
  ]);
  state.org.members = members.members || [];
  state.org.keys = keys.keys || [];
  state.org.loaded = true;
}

async function refreshApps() {
  state.apps = (await api('/v1/apps')).apps || [];
}

async function refreshActions() {
  state.actions = (await api('/v1/app-actions?limit=100')).actions || [];
}

async function refreshRuns() {
  state.runs = (await api('/v1/runs?limit=50')).runs || [];
}

/**
 * One run and its sessions.
 *
 * Fetched on navigation rather than folded into the 5s poll: a run's session list is bounded by the
 * suite that made it, not by the fleet, and re-fetching every run anyone has ever opened would grow
 * the poll without bound. The stale check guards the case a person clicks through three runs
 * quickly — a slower request for the first must not land on top of the third.
 */
async function loadRunDetail(id) {
  if (state.runDetail?.id !== id) state.runDetail = { id, run: null, sessions: [], loaded: false };
  try {
    const out = await api(`/v1/runs/${encodeURIComponent(id)}`);
    if (state.runDetail?.id !== id) return;
    state.runDetail = { id, run: out.run, sessions: out.sessions || [], loaded: true };
  } catch {
    if (state.runDetail?.id !== id) return;
    state.runDetail = { id, run: null, sessions: [], loaded: true };
  }
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
  await Promise.all([refreshDevices(), refreshSessions(), refreshApps(), refreshActions(), refreshRuns()]);
  await refreshHeld();
}

/* ---------------------------------------------------------------------------- router */

const ROUTES = new Set(['devices', 'apps', 'sessions', 'runs', 'queue', 'health', 'launch', 'team', 'settings']);

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, id] = raw.split('/');
  if (name === 'devices' && id) return { name: 'device', id };
  if (name === 'sessions' && id) return { name: 'cockpit', id };
  // `#/runs/<id>` takes either half of a run's identity — the uuid, or the name the suite gave it.
  // The API resolves both, so a person can paste a CI build number straight into the URL.
  if (name === 'runs' && id) return { name: 'run', id: decodeURIComponent(id) };
  // `#/launch` picks; `#/launch/<sessionId>` watches one come up. The session id is in the URL so
  // that a reload mid-bring-up rejoins the same session rather than allocating a second device.
  if (name === 'launch' && id) return { name: 'launching', id };
  return { name: ROUTES.has(name) ? name : 'devices', id: null };
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

window.addEventListener('hashchange', () => {
  const previous = state.route;
  state.route = parseHash();
  state.action = null;
  closeOverlays();
  // Leaving the cockpit — or opening a DIFFERENT session's cockpit — closes the socket and the peer
  // connection. Without this a person who clicks through three sessions is relaying three video
  // streams, and on the TURN path that is billed egress for two screens nobody is looking at.
  if (previous.name === 'cockpit' && (state.route.name !== 'cockpit' || state.route.id !== previous.id)) {
    closeLive();
  }
  render();
  if (state.route.name === 'cockpit') loadSessionDetail(state.route.id).then(render);
  if (state.route.name === 'run') loadRunDetail(state.route.id).then(render);
  if (state.route.name === 'launching') watchBringup(state.route.id);
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
  const parent = { device: 'devices', cockpit: 'sessions', run: 'runs', launching: 'launch' }[state.route.name] || state.route.name;
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

/* ------------------------------------------------------------------ the live device connection */

/**
 * Open — or reuse — the viewer for a session.
 *
 * Idempotent, because both the bring-up screen and the cockpit call it on every render and a render
 * happens every five seconds. Re-opening a working connection would restart the negotiation under
 * someone's finger.
 *
 * The connection deliberately OUTLIVES the bring-up screen: the same socket that proves the device
 * is up is the one the cockpit then draws from, so arriving at the cockpit does not mean waiting for
 * a second negotiation to show the first frame.
 */
function ensureLive(sess) {
  if (!sess?.dataPlane || !LIVE_SESSION_STATES.has(sess.state)) return null;
  if (state.live && state.live.sessionId === sess.id) return state.live;
  if (state.live) closeLive();

  const url = sess.dataPlane.browserEndpoint;
  if (!url) {
    // Configuration, not a device fault, and worth naming exactly: `hosts.endpoint` is where a
    // program on the farm's network dials, and a browser cannot use it.
    state.liveState = 'unrouted';
    state.liveDetail = 'This control plane publishes no browser route to the data plane (DATA_PLANE_PUBLIC_BASE is unset), so nothing can stream to a browser.';
    return null;
  }

  const live = new LiveSession({
    url,
    token: sess.dataPlane.token,
    iceServers: sess.ice?.iceServers,
    onState: (s, detail) => {
      state.liveState = s;
      state.liveDetail = detail || null;

      /**
       * THE LOG FOLLOWS BY DEFAULT. Opening a device and finding an empty pane with a "Follow"
       * button gets the default backwards: a log is for watching something happen, and the moment
       * worth seeing is usually the one just before you thought to press start. Everything that
       * scrolled past while the pane sat idle is simply gone — logcat here is a live stream, not a
       * buffer that gets replayed.
       *
       * Keyed on ATTACHED rather than on video: the log rides the data-plane socket, so it works on
       * a device whose screen never publishes at all — which is exactly the device someone most
       * needs a log from.
       *
       * `paused` is the person's own decision and outranks this. Without it, every reconnect and
       * every state change would restart a stream they deliberately stopped.
       */
      if (ATTACHED.has(s) && !state.log.streaming && !state.log.paused) {
        live.startLogcat();
        state.log.streaming = true;
      }

      scheduleRender();
    },
    onStream: (stream) => { state.liveStream = stream; scheduleRender(); },
    onLog: (lines) => {
      for (const raw of lines) state.log.lines.push(parseLogLine(raw));
      // Bounded in the browser too, and for the same reason it is bounded in the worker: a device
      // left logging overnight must not grow this tab until it is killed.
      if (state.log.lines.length > 5000) state.log.lines.splice(0, state.log.lines.length - 5000);
      paintLog();
    },
    onScreenshot: (shot) => {
      state.shots.unshift({ ...shot, url: `data:${shot.contentType};base64,${shot.data}` });
      if (state.shots.length > 12) state.shots.pop();
      scheduleRender();
    },
    onNotice: (message) => toast('Device', message, 'warn'),
    onInspectPick: (x, y) => inspectPick(x, y),
  });
  live.sessionId = sess.id;
  state.live = live;
  state.liveStream = null;
  state.liveState = 'connecting';
  state.liveDetail = null;
  live.connect();

  // The stats sampler runs inside LiveSession; this is what moves its numbers onto the page. It is
  // a paint, not a render: rebuilding the cockpit once a second would drop taps (see `render`).
  if (state.liveStatsTimer) clearInterval(state.liveStatsTimer);
  state.liveStatsTimer = setInterval(() => {
    if (!state.live) return;
    state.liveStats = state.live.stats;
    paintVitals();
  }, 1000);
  return live;
}

function closeLive() {
  state.live?.close();
  state.live = null;
  state.liveStream = null;
  state.liveState = 'idle';
  state.liveDetail = null;
  // `streaming` and `paused` reset with the connection: a new device starts following again, and a
  // pause on the last one is not an instruction about this one.
  state.log = { lines: [], filter: '', level: 'ALL', follow: true, dropped: 0, streaming: false, paused: false };
  state.shots = [];
  state.inspect = { on: false, nodes: [], picked: null, at: null, loading: false, error: null };
  // The panel goes with the connection. Keeping it would re-show the last frame of a device
  // somebody else now holds, which is a stale screen presented as a live one.
  state.stage = null;
  if (state.liveStatsTimer) clearInterval(state.liveStatsTimer);
  state.liveStatsTimer = null;
}

/**
 * Put the stream into whichever <video> is on the page now.
 *
 * Called on every render because `render()` replaces the DOM wholesale, so the element that had the
 * stream a moment ago is gone. `srcObject` is a property, never an attribute, so this cannot be
 * expressed in the element builder.
 */
function attachVideo() {
  const video = state.stage?.video;
  if (!video || !state.liveStream) return;
  if (video.srcObject !== state.liveStream) {
    // A property, not an attribute. Autoplay of a stream with an audio track is blocked unless the
    // element is muted, and `h()` writes unknown props with setAttribute — which browsers honour at
    // parse time but not reliably on an element created after the fact.
    video.muted = true;
    video.srcObject = state.liveStream;
    video.play?.().catch(() => { /* autoplay is muted, so this only fires on a detached element */ });
    state.live?.attachInput(video);
  }
}

/* ------------------------------------------------------------------ the launch screen */

/**
 * Device PROFILES rather than individual devices.
 *
 * `POST /v1/sessions` names a region, a platform and a tier — the allocator chooses which physical
 * device, atomically, and there is no field for "that one". Listing individual devices to click
 * would therefore be a control that does not exist. Grouping identical devices into a profile says
 * exactly what the API accepts, and it is also how a person thinks about it: they want an Android
 * 17 phone, not serial number two.
 */
function deviceProfiles() {
  const by = new Map();
  for (const d of state.devices) {
    const key = `${d.platform}|${d.tier}|${d.region}|${d.model}|${d.osVersion}`;
    let p = by.get(key);
    if (!p) {
      p = {
        key, platform: d.platform, tier: d.tier, region: d.region,
        model: d.model, osVersion: d.osVersion,
        total: 0, free: 0, devices: [],
        // The INTERSECTION, not the union: a profile can only promise what every device in it can
        // do, because the allocator may hand over any of them.
        capabilities: null,
      };
      by.set(key, p);
    }
    p.total += 1;
    if (d.state === 'READY') p.free += 1;
    p.devices.push(d);
    const caps = d.capabilities || [];
    p.capabilities = p.capabilities === null ? [...caps] : p.capabilities.filter((c) => caps.includes(c));
  }
  return [...by.values()].sort((a, b) => b.free - a.free || a.model.localeCompare(b.model));
}

function profileRow(p) {
  const picked = state.launch.profileKey === p.key;
  const live = (p.capabilities || []).includes('screen-stream');
  return h('button', {
    class: `pickrow${picked ? ' picked' : ''}`,
    onclick: () => { state.launch.profileKey = p.key; render(); },
  },
    h('span', { class: 'pick-main' },
      h('span', { class: 'pick-title', text: p.model }),
      h('span', { class: 'pick-sub mono', text: `${p.platform} ${p.osVersion} · ${p.tier} · ${p.region}` }),
    ),
    h('span', { class: 'pick-side' },
      p.free
        ? pill(`${p.free} free`, 'ok', { dot: false })
        : pill(`${p.total} busy`, 'warn', { dot: false }),
      live ? null : h('span', { class: 'caption', text: 'no live view' }),
    ),
  );
}

function buildPickRow(a) {
  const picked = state.launch.appId === a.id;
  return h('button', {
    class: `pickrow${picked ? ' picked' : ''}`,
    onclick: () => { state.launch.appId = a.id; render(); },
  },
    h('span', { class: 'pick-main' },
      h('span', { class: 'pick-title', text: a.label || a.packageName }),
      h('span', { class: 'pick-sub mono', text: `${a.packageName} · ${a.versionName || '—'} · ${bytes(a.sizeBytes || 0)}` }),
    ),
    h('span', { class: 'pick-side' }, h('span', { class: 'caption', text: ago(a.createdAt) })),
  );
}

function screenLaunch() {
  const profiles = deviceProfiles();

  // One profile is the normal case on a small farm, and making someone click the only option
  // before the button turns on is a step that teaches nothing. Chosen here rather than in state
  // setup because the list arrives with the fleet, after the screen first renders.
  if (!state.launch.profileKey && profiles.length === 1) state.launch.profileKey = profiles[0].key;

  const profile = profiles.find((p) => p.key === state.launch.profileKey) || null;
  const app = state.apps.find((a) => a.id === state.launch.appId) || null;

  /**
   * Only meaningful once a profile is actually chosen.
   *
   * This used to be `!app || (profile?.capabilities || []).includes('app-install')`, which is false
   * whenever NOTHING IS SELECTED — so picking a build and not yet a device produced "These devices
   * do not declare app-install", a flat statement about the hardware that was untrue. The farm's
   * devices declare it; the person simply had not clicked one yet. An error message that blames the
   * fleet for the reader's next step is worse than no message.
   */
  const canInstall = !app || !profile || (profile.capabilities || []).includes('app-install');
  const ready = Boolean(profile) && canInstall;

  return [
    pageHead(
      [{ label: 'Farm' }],
      'Launch a device',
      app
        ? `Launching ${app.label || app.packageName} ${app.versionName || ''} on ${profile ? profile.model : 'a device'}`.replace(/\s+/g, ' ')
        : 'Pick a device. Add a build if you want one installed before you get there.',
      h('div', { class: 'row tight' },
        profile && !profile.free
          ? h('span', { class: 'caption', text: 'nothing free — you will be queued' })
          : null,
        btn(ready ? 'Start' : 'Pick a device', 'primary lg', () => ready && startLaunch(), { disabled: !ready }),
      ),
    ),

    h('div', { class: 'launchgrid' },
      card('Build', {
        aside: btn('Upload an APK', 'tiny ghost', () => go('#/apps')),
      },
        h('div', { class: 'picklist' },
          h('button', {
            class: `pickrow${state.launch.appId === null ? ' picked' : ''}`,
            onclick: () => { state.launch.appId = null; render(); },
          },
            h('span', { class: 'pick-main' },
              h('span', { class: 'pick-title', text: 'No build' }),
              h('span', { class: 'pick-sub', text: 'Just the device, as the clean snapshot left it' }),
            ),
          ),
          state.apps.map(buildPickRow),
        ),
        !state.apps.length
          ? h('p', { class: 'caption mt-sm', text: 'No builds uploaded yet. A device on its own is still useful — you can install one from the cockpit later.' })
          : h('p', { class: 'caption mt-sm', text: 'Installed for this session only. Releasing the device restores the clean snapshot and removes it.' }),
        app ? h('label', { class: 'row tight mt-md checkline' },
          h('input', {
            type: 'checkbox',
            checked: state.launch.launchAfterInstall,
            onchange: (e) => { state.launch.launchAfterInstall = e.target.checked; },
          }),
          h('span', { class: 'secondary', text: 'Open the app once it is installed' }),
        ) : null,
      ),

      card('Device', { aside: h('span', { class: 'caption', text: `${state.available} free` }) },
        profiles.length
          ? h('div', { class: 'picklist' }, profiles.map(profileRow))
          : empty('No devices are registered.', 'A worker has to register a host before anything can be launched. Check Health.'),
        h('p', { class: 'caption mt-sm', text: 'The allocator picks a free device matching this profile — there is no way to reserve a particular one, so nothing here pretends otherwise.' }),
        !canInstall
          ? h('p', { class: 'help mt-sm', text: `This profile does not declare app-install, so the API would refuse to install ${app?.packageName ?? 'a build'} on it. Choose “No build”, or another profile.` })
          : null,
      ),
    ),

    card('Advanced', {},
      h('div', { class: 'row tight' },
        h('span', { class: 'micro', text: 'Lease' }),
        h('select', {
          class: 'field narrow',
          onchange: (e) => { state.launch.ttlMinutes = Number(e.target.value); },
        }, [15, 30, 60, 120, 240].map((m) => h('option', {
          value: String(m), selected: state.launch.ttlMinutes === m, text: `${m} minutes`,
        }))),
        h('span', { class: 'caption', text: 'The reaper releases the device when the lease expires, whether or not anyone is watching.' }),
      ),
    ),
  ];
}

/* ------------------------------------------------------------------ bring-up */

/**
 * Start a session and go and watch it come up.
 *
 * The navigation happens on the FIRST answer, queued or not, because a queued session is a real
 * session holding a real place in line — sending someone back to the picker to try again is how two
 * devices get allocated to one person.
 */
async function startLaunch() {
  const profiles = deviceProfiles();
  const profile = profiles.find((p) => p.key === state.launch.profileKey);
  if (!profile) return;
  const appId = state.launch.appId;

  try {
    const out = await api('/v1/sessions', {
      method: 'POST',
      body: {
        region: profile.region,
        platform: profile.platform,
        tier: profile.tier,
        ttlMinutes: state.launch.ttlMinutes,
        // Asked for only when a build is going to be installed. Demanding it unconditionally would
        // make a device that can stream but not sideload unschedulable for someone who only wants
        // to look at it.
        ...(appId ? { requireCapabilities: ['app-install'] } : {}),
      },
    });
    state.bringup = {
      sessionId: out.session.id,
      appId,
      launchAfter: state.launch.launchAfterInstall,
      install: null,
      launch: null,
      error: null,
      startedAt: Date.now(),
    };
    await Promise.all([refreshDevices(), refreshSessions()]);
    go(`#/launch/${out.session.id}`);
  } catch (err) {
    toast('Could not start a session', err.message, 'bad');
  }
}

/**
 * Follow one session from allocation to a usable device.
 *
 * A loop rather than a chain of callbacks because every step here is genuinely a poll: the control
 * plane cannot dial a worker, so "is it installed yet" has exactly one honest answer shape — ask
 * again. It exits when the session is usable, when something fails, or when the person navigates
 * away.
 */
async function watchBringup(sessionId) {
  if (!state.bringup || state.bringup.sessionId !== sessionId) {
    // A reload, or a link someone was sent. Rejoin rather than allocate: the session already exists.
    state.bringup = { sessionId, appId: null, launchAfter: false, install: null, launch: null, error: null, startedAt: Date.now() };
  }
  const b = state.bringup;

  const deadline = Date.now() + 15 * 60_000;
  while (state.route.name === 'launching' && state.route.id === sessionId && Date.now() < deadline) {
    await loadSessionDetail(sessionId);
    const sess = state.detail;
    if (!sess || sess.missing) { b.error = sess?.message || 'That session is not visible.'; render(); return; }

    if (!LIVE_SESSION_STATES.has(sess.state) && sess.state !== 'QUEUED') {
      b.error = `The session ended before it was usable (${(sess.endReason || sess.state).toLowerCase()}).`;
      render();
      return;
    }

    if (sess.deviceId && LIVE_SESSION_STATES.has(sess.state)) {
      ensureLive(sess);
      // Re-read the queued actions from the shared list EVERY tick, not just when they are queued.
      // Without this the checklist held whatever the POST returned — PENDING, forever — while the
      // worker had long since finished. `state.actions` is the same list the cockpit and the Apps
      // screen read, refreshed by the ordinary poll: one source, not a private poll per screen.
      await refreshActions();
      for (const kind of ['install', 'launch']) {
        if (b[kind]?.id) b[kind] = state.actions.find((a) => a.id === b[kind].id) || b[kind];
      }

      // Queued once, on the first tick where a device exists. Queuing earlier means queuing against
      // a session with no device, which the API refuses.
      if (b.appId && !b.install) await queueBringupAction(b, 'install');
      else if (b.appId && b.install?.state === 'DONE' && b.launchAfter && !b.launch) await queueBringupAction(b, 'launch');
    }

    render();
    if (bringupDone(sess)) {
      // Straight into the cockpit. The socket opened above is not torn down on the way — the first
      // frame is already on screen by the time the cockpit renders.
      go(`#/sessions/${sessionId}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function queueBringupAction(b, kind) {
  const app = appById(b.appId);
  if (!app) return;
  try {
    const out = await api(`/v1/sessions/${encodeURIComponent(b.sessionId)}/app-actions`, {
      method: 'POST', body: { appId: app.id, kind },
    });
    b[kind] = out.action;
  } catch (err) {
    b[kind] = { state: 'FAILED', error: err.message };
  }
  // From here the action's progress is read off the periodic /v1/app-actions refresh, which is the
  // same list the cockpit and the Apps screen read — one source, not a private poll per screen.
  await refreshActions();
  const seen = state.actions.find((a) => a.id === b[kind]?.id);
  if (seen) b[kind] = seen;
}

function bringupStep(key, label, st, note) {
  return { key, label, state: st, note };
}

/**
 * The checklist, derived entirely from state the API and the socket already report.
 *
 * Nothing here is timed or faked. A step is `done` because a session row says so, an action row says
 * so, or a peer connection is carrying frames — which is why the last step can sit at `active` for
 * a while on a cold device and why that is the truth rather than a stalled animation.
 */
function bringupSteps(sess) {
  const b = state.bringup;
  const app = b?.appId ? appById(b.appId) : null;
  const device = sess?.deviceId ? deviceById(sess.deviceId) : null;
  const canStream = !device || (device.capabilities || []).includes('screen-stream');
  const steps = [];

  const queued = sess?.state === 'QUEUED';
  steps.push(bringupStep('acquire', 'Acquiring a device from the farm',
    sess?.deviceId ? 'done' : (queued ? 'active' : 'active'),
    queued ? queueNote() : (sess?.deviceId ? (device?.model || short(sess.deviceId)) : null)));

  steps.push(bringupStep('ready', 'Device ready',
    sess?.state === 'ACTIVE' ? 'done' : (sess?.deviceId ? 'active' : 'pending'),
    sess?.state === 'ALLOCATING' ? 'Restoring the clean snapshot' : null));

  /**
   * Attaching is its OWN step, separate from streaming, and the separation was earned.
   *
   * The socket is what makes a session ACTIVE (migration 017) and what carries logcat, so it matters
   * on a device that cannot stream at all. When the two were one step, a device with no
   * `screen-stream` marked it `skipped` — and a socket that was being refused outright, on a real
   * failure with a real message, was silently hidden behind that word.
   */
  const attachFailed = state.liveState === 'failed' || state.liveState === 'unrouted';
  const attached = ATTACHED.has(state.liveState);
  steps.push(bringupStep('attach', 'Attaching to the device',
    attached ? 'done' : attachFailed ? 'failed' : sess?.deviceId ? 'active' : 'pending',
    attachFailed ? state.liveDetail : null));

  if (canStream) {
    const noVideo = state.liveState === 'nostream' || state.liveState === 'nodisplay';
    steps.push(bringupStep('stream', 'Connecting the live view',
      state.liveState === 'streaming' ? 'done'
        : (attachFailed || noVideo) ? 'failed'
        : sess?.deviceId ? 'active' : 'pending',
      noVideo ? state.liveDetail : null));
  } else {
    steps.push(bringupStep('stream', 'Live view', 'skipped',
      'This device does not declare screen-stream — everything else still works'));
  }

  if (b?.appId) {
    const ins = b.install;
    steps.push(bringupStep('install', `Installing ${app?.label || app?.packageName || 'the build'}`,
      ins?.state === 'DONE' ? 'done' : ins?.state === 'FAILED' ? 'failed' : ins ? 'active' : 'pending',
      ins?.state === 'FAILED' ? ins.error : ins ? 'Queued for the worker’s next heartbeat' : null));

    if (b.launchAfter) {
      const la = b.launch;
      steps.push(bringupStep('launch', `Opening ${app?.packageName || 'the app'}`,
        la?.state === 'DONE' ? 'done' : la?.state === 'FAILED' ? 'failed' : la ? 'active' : 'pending',
        la?.state === 'FAILED' ? la.error : null));
    }
  }
  return steps;
}

function queueNote() {
  const q = queuedSessions();
  const i = q.findIndex((s) => s.id === state.bringup?.sessionId);
  if (i < 0) return 'Waiting for a device to free up';
  return `Position ${i + 1} of ${q.length} in the queue`;
}

/**
 * "Done" is deliberately not "every step is green".
 *
 * A device that cannot stream, or a live view that failed to connect, is still a device somebody can
 * install onto and drive with WebDriver — holding them on this screen would be refusing to hand over
 * something that works. What genuinely gates the cockpit is the session being ACTIVE and any app
 * work having finished one way or the other.
 */
function bringupDone(sess) {
  if (sess?.state !== 'ACTIVE') return false;
  const b = state.bringup;
  // `settled` means "queued AND finished". An action that has not been queued yet is NOT settled —
  // treating it as settled is how the launch step got skipped entirely: the tick that saw the
  // install turn DONE also saw `b.launch` undefined, read that as nothing left to wait for, and
  // handed over the cockpit before the app was ever opened.
  const settled = (a) => Boolean(a) && (a.state === 'DONE' || a.state === 'FAILED');
  if (b?.appId && !settled(b.install)) return false;
  // Only gate on the launch where one is actually expected: a failed install means no launch is
  // ever queued, and waiting for it would strand the person on this screen.
  if (b?.appId && b.launchAfter && b.install?.state === 'DONE' && !settled(b.launch)) return false;
  // The socket has to have SETTLED either way — attached or refused with a reason. Handing over a
  // cockpit while the attach is still in flight means the person arrives to a blank stage and no
  // explanation, which is the one thing this screen exists to prevent.
  const settledSocket = ATTACHED.has(state.liveState) || state.liveState === 'failed' || state.liveState === 'unrouted';
  if (!settledSocket) return false;
  const device = sess?.deviceId ? deviceById(sess.deviceId) : null;
  const canStream = device && (device.capabilities || []).includes('screen-stream');
  // A streamable device gets a little longer: 'negotiating' means frames are seconds away, and
  // arriving mid-negotiation shows a ring in the cockpit rather than a screen.
  if (canStream && state.liveState === 'negotiating') return false;
  // `nodisplay` is settled, not pending: the negotiation finished and the answer was "no video".
  // Waiting past it strands someone on the bring-up screen holding a device that works.
  return true;
}

const STEP_TONE = { done: 'ok', active: 'accent', failed: 'bad', skipped: '', pending: '' };

function screenLaunching(id) {
  const sess = state.detail?.id === id ? state.detail : null;
  const steps = bringupSteps(sess);
  const counted = steps.filter((s) => s.state !== 'skipped');
  const done = counted.filter((s) => s.state === 'done').length;
  const pct = counted.length ? Math.round((done / counted.length) * 100) : 0;
  const failed = steps.find((s) => s.state === 'failed');
  const device = sess?.deviceId ? deviceById(sess.deviceId) : null;

  return [
    pageHead(
      [{ label: 'Farm' }, { label: 'Launch', to: '#/launch' }],
      device ? device.model : 'Bringing up a device',
      sess ? `Session ${short(id)} · ${(SESSION_STATE[sess.state] || {}).label || sess.state}` : 'Asking the control plane for a device',
      h('div', { class: 'row tight' },
        btn('Cancel', 'ghost', () => cancelBringup(id)),
      ),
    ),

    h('div', { class: 'bringup' },
      h('div', { class: 'bringup-stage' },
        h('div', { class: 'phone big' },
          h('div', { class: 'phone-screen' },
            // The video is mounted from the first moment there is a session, not once every step is
            // green: the frames start arriving before the install does, and watching the app appear
            // on the device is the most convincing thing this screen can show.
            // The same persistent element the cockpit uses, so arriving at the cockpit does not
            // restart the stream that is already playing here.
            state.liveState === 'streaming' && state.stage?.video
              ? state.stage.video
              : progressRing(pct),
          ),
        ),
        h('p', { class: 'caption', text: device ? `${device.model} · Android ${device.osVersion} · ${device.tier}` : 'no device yet' }),
      ),

      h('div', { class: 'bringup-steps' },
        h('p', { class: 'micro', text: `Launching ${device ? device.model : 'a device'}` }),
        h('ul', { class: 'steplist' }, steps.map((s) => h('li', { class: `step ${s.state}` },
          h('span', { class: 'step-mark' },
            s.state === 'done' ? '✓' : s.state === 'failed' ? '!' : s.state === 'skipped' ? '–' : '',
          ),
          h('span', { class: 'stack tight' },
            h('span', { class: 'step-label', text: s.label }),
            s.note ? h('span', { class: 'caption', text: s.note }) : null,
          ),
        ))),

        failed
          ? h('div', { class: 'inset mt-md' },
              h('p', { class: 'micro bad-text', text: 'This step did not complete' }),
              h('p', { class: 'help', text: failed.note || 'The worker reported no reason.' }),
              h('p', { class: 'caption mt-sm', text: 'The device is yours either way — open the cockpit and try from there, or release it.' }),
              h('div', { class: 'row tight mt-sm' },
                btn('Open cockpit', 'primary', () => go(`#/sessions/${id}`)),
                btn('Release', 'danger', () => cancelBringup(id)),
              ),
            )
          : h('p', { class: 'caption mt-md', text: 'Every line above is a real state change reported by the control plane or the device — nothing here is on a timer.' }),

        state.bringup?.error
          ? h('p', { class: 'error-text mt-md', text: state.bringup.error })
          : null,
      ),
    ),
  ];
}

/**
 * A ring, drawn as an SVG rather than as a spinner.
 *
 * The percentage is real — steps completed over steps that apply — so it is worth showing. A spinner
 * would say "something is happening" for up to a minute of cold boot without saying what.
 */
function progressRing(pct) {
  const r = 54;
  const c = 2 * Math.PI * r;
  const svg = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  };
  const wrap = h('div', { class: 'ring' });
  const s = svg('svg', { viewBox: '0 0 128 128', class: 'ring-svg' });
  s.appendChild(svg('circle', { cx: 64, cy: 64, r, class: 'ring-track' }));
  s.appendChild(svg('circle', {
    cx: 64, cy: 64, r, class: 'ring-fill',
    'stroke-dasharray': `${c}`, 'stroke-dashoffset': `${c * (1 - pct / 100)}`,
    transform: 'rotate(-90 64 64)',
  }));
  wrap.appendChild(s);
  wrap.appendChild(h('span', { class: 'ring-num tnum' }, String(pct), h('small', { text: '%' })));
  return wrap;
}

async function cancelBringup(id) {
  closeLive();
  state.bringup = null;
  try {
    await api(`/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('Released', 'The device is restoring its clean snapshot.', 'ok');
  } catch (err) {
    toast('Could not release', err.message, 'bad');
  }
  await Promise.all([refreshDevices(), refreshSessions()]);
  go('#/launch');
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
    // `ice` is carried, and forgetting it was a real bug with an almost undiagnosable symptom. The
    // relay credentials live BESIDE `session` in the response, not inside it, so spreading
    // `out.session` alone silently produced a viewer with no TURN — which works perfectly on the
    // farm's own network and fails from anywhere else with an empty peer connection, no error, and
    // not a single line in the relay's log to say nobody ever called.
    state.detail = {
      ...out.session,
      dataPlane: out.dataPlane || null,
      ice: out.ice || null,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    state.detail = { id, missing: true, message: err.message };
  }
}

/* ------------------------------------------------------------------ the device panel */

/**
 * SVG, built through the DOM rather than from a string.
 *
 * The console's CSP has no `unsafe-inline` and `h()` refuses an `html` prop, so every icon here is
 * constructed element by element. That is not a workaround — it is what keeps rule 1 structural:
 * there is no path by which a string from anywhere becomes markup on this page.
 */
function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  return el;
}

/**
 * The toolbar icon set, drawn to read at 20px.
 *
 * Back, home and overview are deliberately Android's own shapes — triangle, circle, square — rather
 * than invented glyphs, because a person coming from a device toolbar already knows them and any
 * cleverness here costs recognition for nothing.
 */
const ICONS = {
  power: (g) => { g.appendChild(svgEl('path', { d: 'M12 3v9', 'stroke-linecap': 'round' })); g.appendChild(svgEl('path', { d: 'M6.6 6.6a7.5 7.5 0 1 0 10.8 0', 'stroke-linecap': 'round' })); },
  volup: (g) => { g.appendChild(svgEl('path', { d: 'M4 9.5h3.5L12 6v12L7.5 14.5H4z', 'stroke-linejoin': 'round' })); g.appendChild(svgEl('path', { d: 'M16 9a4.5 4.5 0 0 1 0 6', 'stroke-linecap': 'round' })); g.appendChild(svgEl('path', { d: 'M18.5 6.5a8 8 0 0 1 0 11', 'stroke-linecap': 'round' })); },
  voldown: (g) => { g.appendChild(svgEl('path', { d: 'M4 9.5h3.5L12 6v12L7.5 14.5H4z', 'stroke-linejoin': 'round' })); g.appendChild(svgEl('path', { d: 'M16 9a4.5 4.5 0 0 1 0 6', 'stroke-linecap': 'round' })); },
  rotl: (g) => { g.appendChild(svgEl('path', { d: 'M4 12a8 8 0 1 1 2.4 5.7', 'stroke-linecap': 'round' })); g.appendChild(svgEl('path', { d: 'M4 6.5V12h5.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })); },
  rotr: (g) => { g.appendChild(svgEl('path', { d: 'M20 12a8 8 0 1 0-2.4 5.7', 'stroke-linecap': 'round' })); g.appendChild(svgEl('path', { d: 'M20 6.5V12h-5.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })); },
  back: (g) => { const p = svgEl('path', { d: 'M15 5 7 12l8 7z', 'stroke-linejoin': 'round' }); p.setAttribute('fill', 'currentColor'); g.appendChild(p); },
  home: (g) => { const c = svgEl('circle', { cx: 12, cy: 12, r: 7 }); c.setAttribute('fill', 'currentColor'); g.appendChild(c); },
  overview: (g) => { const r = svgEl('rect', { x: 5.5, y: 5.5, width: 13, height: 13, rx: 1.5 }); r.setAttribute('fill', 'currentColor'); g.appendChild(r); },
  camera: (g) => { g.appendChild(svgEl('path', { d: 'M3 8.5h3.5L8 6h8l1.5 2.5H21v11H3z', 'stroke-linejoin': 'round' })); g.appendChild(svgEl('circle', { cx: 12, cy: 13.5, r: 3.5 })); },
  refresh: (g) => { g.appendChild(svgEl('path', { d: 'M20 12a8 8 0 1 1-2.4-5.7', 'stroke-linecap': 'round' })); g.appendChild(svgEl('path', { d: 'M20 4v5h-5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })); },
  zoomin: (g) => { g.appendChild(svgEl('circle', { cx: 11, cy: 11, r: 6.5 })); g.appendChild(svgEl('path', { d: 'M15.8 15.8 21 21M8.5 11h5M11 8.5v5', 'stroke-linecap': 'round' })); },
  zoomout: (g) => { g.appendChild(svgEl('circle', { cx: 11, cy: 11, r: 6.5 })); g.appendChild(svgEl('path', { d: 'M15.8 15.8 21 21M8.5 11h5', 'stroke-linecap': 'round' })); },
  fit: (g) => { g.appendChild(svgEl('path', { d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })); },
  // A cursor over a box: pick a thing on the screen. Reads as "inspect" the way a magnifier reads
  // as "zoom", and the bar already has two magnifiers doing that job.
  inspect: (g) => {
    g.appendChild(svgEl('rect', { x: 3.5, y: 3.5, width: 11, height: 11, rx: 1.5, 'stroke-dasharray': '3 2.2' }));
    const p = svgEl('path', { d: 'M12.5 12.5 21 16l-3.4 1.4L16 21z', 'stroke-linejoin': 'round' });
    p.setAttribute('fill', 'currentColor');
    g.appendChild(p);
  },
};

function icon(name) {
  const s = svgEl('svg', { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'aria-hidden': 'true' });
  (ICONS[name] || ICONS.fit)(s);
  return s;
}

/**
 * One toolbar button. `enabled` is passed rather than inferred, because every control on this bar
 * is gated on something different — a capability, an open data channel, a live session — and a
 * button that looks available and does nothing is the thing this console refuses to ship.
 */
function toolBtn(name, label, enabled, onclick, opts = {}) {
  return h('button', {
    class: `devbtn${opts.active ? ' on' : ''}`,
    title: label + (opts.kbd ? ` (${opts.kbd})` : ''),
    disabled: !enabled,
    onclick,
  }, icon(name), h('span', { class: 'sr', text: label }));
}

/**
 * The device panel, kept ALIVE across renders.
 *
 * This is the one part of the console that is not rebuilt on every poll, and the reason is
 * measurable rather than stylistic: `render()` replaces the whole page every five seconds, and a
 * `<video>` element that is destroyed and recreated drops its stream, re-attaches `srcObject` and
 * re-decodes — a visible stutter twice a minute on the one surface where smoothness is the product.
 *
 * So the root node, the frame and the video are created once and cached on `state.stage`. Renders
 * re-append the same node and repaint only the parts that actually changed: the toolbar's disabled
 * states, the overlay, and the caption. Moving a live `<video>` between parents keeps its stream.
 */
function stagePanel(sess, live) {
  const device = deviceById(sess.deviceId);
  const caps = device?.capabilities || [];

  if (!state.stage) {
    const video = h('video', {
      id: 'device-video', class: 'dev-video',
      autoplay: true, playsinline: true, tabindex: '0',
    });
    const overlay = h('div', { class: 'dev-overlay' });
    // Local echo of your own taps. `pointer-events: none`, so it can never intercept a gesture.
    const taps = h('div', { class: 'dev-taps' });
    const frame = h('div', { class: 'dev-frame' }, video, overlay, taps);
    const screenWrap = h('div', { class: 'dev-fit' }, frame);
    const toolbar = h('div', { class: 'devbar' });

    /**
     * The keyboard hint lives BELOW the phone, never on it.
     *
     * It was briefly drawn inside the bezel, and that was wrong twice over: it covered Android's
     * own navigation bar, and it sat exactly in the swipe-up gesture zone — so the one affordance
     * added to explain input was standing on top of the input. Nothing overlays the device screen;
     * the screen is the thing being tested and it has to be seen exactly as the device draws it.
     *
     * A sibling of the caption rather than a child, because the caption is written with
     * `textContent` on every paint and would wipe it out.
     */
    const caption = h('p', { class: 'caption dev-caption-text' });
    const kbd = h('span', { class: 'dev-kbd', text: 'keyboard → device' });
    const captionRow = h('div', { class: 'dev-caption' }, caption, kbd);

    const root = h('div', { class: 'devpanel' },
      toolbar,
      h('div', { class: 'dev-stage' }, screenWrap),
    );
    state.stage = { root, video, overlay, frame, toolbar, caption, zoom: 1 };
    root.appendChild(captionRow);
  }

  const st = state.stage;
  paintToolbar(sess, live, caps);
  paintOverlay(sess, live, caps);
  paintFrame(device);

  st.caption.textContent = device
    ? `${device.model}${screenOf(device)} · Android ${device.osVersion} · ${sess.region || 'lab'}`
    : 'no device';
  return st.root;
}

/** Aspect ratio and zoom, written as CSS custom properties so resizing costs no layout thrash. */
function paintFrame(device) {
  const st = state.stage;
  const s = state.live?.screen || device?.screen;
  const ratio = s?.width && s?.height ? s.width / s.height : 0.5625;
  st.frame.style.setProperty('--dev-aspect', String(ratio));
  st.frame.style.setProperty('--dev-zoom', String(st.zoom));
}

function setZoom(z) {
  const st = state.stage;
  if (!st) return;
  st.zoom = Math.min(2.5, Math.max(0.4, Number(z.toFixed(2))));
  st.frame.style.setProperty('--dev-zoom', String(st.zoom));
  paintToolbar(state.detail, true, deviceById(state.detail?.deviceId)?.capabilities || []);
}

/**
 * The control bar, in Android's own order: system buttons together, hardware keys above them.
 *
 * Every entry is present only where it can work. `power`, `back`, `home` and `overview` ride the
 * WebRTC `device-control` channel, so they need an open peer connection; volume and rotate go
 * through the data plane because Cuttlefish exposes no control-channel command for them; screenshot
 * needs the capability. Nothing here is rendered disabled-with-a-tooltip as a stand-in for a
 * feature that does not exist.
 */
function paintToolbar(sess, live, caps) {
  const st = state.stage;
  if (!st) return;
  const streaming = state.liveState === 'streaming';
  const attached = ATTACHED.has(state.liveState);
  const ctrl = streaming && state.live?.control?.readyState === 'open';

  const press = (cmd) => () => {
    if (!state.live?.pressButton(cmd)) toast('Not connected', 'The device control channel is not open yet.', 'warn');
  };
  const send = (msg) => () => state.live?.sendControl(msg);

  st.toolbar.replaceChildren(
    toolBtn('power', 'Power', ctrl, press('power')),
    toolBtn('volup', 'Volume up', attached, send({ t: 'key', name: 'volume_up' })),
    toolBtn('voldown', 'Volume down', attached, send({ t: 'key', name: 'volume_down' })),
    h('span', { class: 'devbar-sep' }),
    toolBtn('rotl', 'Rotate left', attached, send({ t: 'rotate', dir: 'left' })),
    toolBtn('rotr', 'Rotate right', attached, send({ t: 'rotate', dir: 'right' })),
    h('span', { class: 'devbar-sep' }),
    toolBtn('back', 'Back', ctrl, press('back')),
    toolBtn('home', 'Home', ctrl, press('home')),
    toolBtn('overview', 'Overview', ctrl, press('menu')),
    h('span', { class: 'devbar-sep' }),
    caps.includes('screenshot')
      ? toolBtn('camera', 'Screenshot', Boolean(live), () => void takeScreenshot(), { kbd: 'S' })
      : null,
    caps.includes('ui-hierarchy')
      ? toolBtn('inspect', state.inspect.on ? 'Stop inspecting' : 'Inspect elements',
          streaming, () => void toggleInspect(), { active: state.inspect.on })
      : null,
    toolBtn('refresh', 'Reconnect', Boolean(live), () => reconnectLive()),
    h('span', { class: 'devbar-sep' }),
    toolBtn('zoomin', 'Zoom in', streaming, () => setZoom(st.zoom + 0.15)),
    toolBtn('zoomout', 'Zoom out', streaming, () => setZoom(st.zoom - 0.15)),
    toolBtn('fit', 'Fit to panel', streaming, () => setZoom(1)),
  );
}

/**
 * Whatever is covering the screen right now — a progress ring, a reason, or nothing.
 *
 * Separate from the video so that reaching `streaming` is one class change rather than a rebuild.
 */
function paintOverlay(sess, live, caps) {
  const st = state.stage;
  const canStream = caps.includes('screen-stream');
  const show = (...kids) => { st.overlay.replaceChildren(...kids.filter(Boolean)); st.overlay.hidden = false; st.root.dataset.live = 'off'; };

  if (state.liveState === 'streaming') {
    st.overlay.replaceChildren();
    st.overlay.hidden = true;
    st.root.dataset.live = 'on';
    return;
  }

  if (!live) {
    return show(
      h('p', { class: 'micro', text: 'Session ended' }),
      h('p', { class: 'help', text: 'This device was released and restored to its clean snapshot.' }),
    );
  }
  if (!canStream) {
    return show(
      h('p', { class: 'micro', text: 'No live view' }),
      h('p', { class: 'help', text: 'This device does not declare screen-stream. WebDriver and installs still work.' }),
    );
  }

  switch (state.liveState) {
    case 'nodisplay':
      return show(
        h('p', { class: 'micro warn-text', text: 'Connected, but no display' }),
        h('p', { class: 'help', text: state.liveDetail || 'The device is not publishing a display.' }),
        caps.includes('screenshot')
          ? h('div', { class: 'row tight mt-sm' }, btn('Take a screenshot', 'primary', () => takeScreenshot()))
          : null,
      );
    case 'nostream':
      return show(
        h('p', { class: 'micro', text: 'No live view' }),
        h('p', { class: 'help', text: state.liveDetail || 'This device tier does not negotiate a media stream.' }),
      );
    case 'failed':
    case 'unrouted':
      return show(
        h('p', { class: 'micro bad-text', text: 'The live view did not connect' }),
        h('p', { class: 'help', text: state.liveDetail || 'No reason was reported.' }),
        h('div', { class: 'row tight mt-sm' }, btn('Try again', 'primary', () => reconnectLive())),
      );
    default:
      return show(
        progressRing(state.liveState === 'connecting' ? 25 : state.liveState === 'authenticated' ? 55 : 80),
        h('p', { class: 'caption', text:
          state.liveState === 'connecting' ? 'Opening the data plane'
            : state.liveState === 'authenticated' ? 'Asking the device to stream'
            : 'Negotiating the media connection' }),
      );
  }
}

/** ` · 720 × 1280`, or nothing at all when neither side has reported a panel size. */
function screenOf(device) {
  const s = state.live?.screen || device?.screen;
  return s?.width ? ` · ${s.width} × ${s.height}` : '';
}

function reconnectLive() {
  closeLive();
  render();
  loadSessionDetail(state.route.id).then(() => { ensureLive(state.detail); render(); });
}

async function takeScreenshot() {
  if (!state.live) { toast('Not connected', 'Open the live view first.', 'warn'); return; }
  try {
    await state.live.screenshot();
    toast('Screenshot taken', 'It is in “Captured this session”, in the panel on the right.', 'ok');
  } catch (err) {
    toast('Screenshot failed', err.message, 'bad');
  }
}

/* ------------------------------------------------------------------ logcat dock */

const LOG_LEVELS = ['ALL', 'E', 'W', 'I', 'D'];
/** Which levels each filter admits. Choosing E shows only errors and fatals, not "E and above". */
const LEVEL_SET = { E: ['E', 'F'], W: ['W'], I: ['I'], D: ['D', 'V'] };

function visibleLog() {
  const { lines, filter, level } = state.log;
  const needle = filter.trim().toLowerCase();
  return lines.filter((l) => {
    if (level !== 'ALL' && !(LEVEL_SET[level] || []).includes(l.level)) return false;
    if (!needle) return true;
    return l.raw.toLowerCase().includes(needle);
  });
}

/**
 * Repaint the log without re-rendering the page.
 *
 * The log arrives five times a second. Putting it through `render()` would rebuild the cockpit — and
 * every rebuild under a pointer costs a click (see `render`), which on this screen could be the
 * Release button. So the dock owns its own node and this writes into it directly.
 */
function paintLog() {
  const body = $('logbody');
  if (!body) return;
  const rows = visibleLog().slice(-600);
  body.replaceChildren(...rows.map((l) => h('div', { class: `logline l${l.level || 'X'}` },
    h('span', { class: 'log-t', text: l.time }),
    h('span', { class: 'log-l', text: l.level }),
    h('span', { class: 'log-g', text: l.tag }),
    h('span', { class: 'log-m', text: l.message }),
  )));
  const count = $('logcount');
  if (count) count.textContent = `${rows.length} / ${state.log.lines.length} lines`;
  if (state.log.follow) body.scrollTop = body.scrollHeight;
}

function logcatDock(sess, live) {
  const device = deviceById(sess.deviceId);
  if (!(device?.capabilities || []).includes('logcat')) {
    // Absent rather than empty: this device genuinely produces no log through this path, and an
    // empty pane would read as a quiet device.
    return card('Logcat', {}, h('p', { class: 'help', text: 'This device does not declare the logcat capability, so nothing here would ever fill.' }));
  }

  const following = Boolean(state.log.streaming);
  return card('Logcat', {
    aside: h('div', { class: 'row tight' },
      h('span', { class: 'caption tnum', id: 'logcount', text: `0 / ${state.log.lines.length} lines` }),
      // `Pause` / `Resume`, never `Follow`: `state.log.follow` is the SCROLL behaviour, turned on and
      // off by scrolling the pane, and having two different things called follow in one card is how
      // someone ends up pressing this expecting the scroll to stick.
      btn(following ? 'Pause' : 'Resume', 'tiny ghost', () => toggleLogcat(), { disabled: !live }),
      btn('Clear', 'tiny ghost', () => { state.log.lines = []; paintLog(); }),
    ),
  },
    h('div', { class: 'row tight logbar' },
      h('input', {
        class: 'field', id: 'logfilter', placeholder: 'Filter', value: state.log.filter,
        oninput: (e) => { state.log.filter = e.target.value; paintLog(); },
      }),
      h('div', { class: 'row tight' }, LOG_LEVELS.map((lv) => h('button', {
        class: `levelchip${state.log.level === lv ? ' on' : ''}`,
        onclick: () => { state.log.level = lv; paintLog(); },
      }, lv))),
    ),
    h('div', {
      class: 'logbody mono', id: 'logbody',
      // Following is turned off by scrolling up and back on by scrolling to the bottom, which is
      // what every log viewer does and what a person expects without being told.
      onscroll: (e) => {
        const el = e.target;
        state.log.follow = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      },
    }),
    // Both halves changed when artifacts landed (019). THIS DOCK still keeps nothing — it is a live
    // stream to one tab — but the log itself is no longer lost, because the worker dumps the whole
    // buffer as an artifact when the device is released. Saying "nothing was kept" now would send
    // someone away from the evidence sitting further down the same page.
    !live
      ? h('p', { class: 'caption mt-sm', text: 'The session has ended, so nothing more will arrive here. The full log was captured when the device was released — see Evidence below.' })
      : h('p', { class: 'caption mt-sm', text: 'Streamed straight off the device over the same connection as the screen. This dock stores nothing, but the whole log is kept as an artifact when the device is released.' }),
  );
}

function toggleLogcat() {
  if (!state.live) { toast('Not connected', 'Open the live view first.', 'warn'); return; }
  if (state.log.streaming) {
    state.live.stopLogcat();
    state.log.streaming = false;
    // Recorded, so the auto-start above does not immediately undo this on the next state change.
    state.log.paused = true;
  } else {
    state.live.startLogcat();
    state.log.streaming = true;
    state.log.paused = false;
  }
  render();
}

/* ------------------------------------------------------------------ vitals and captures */

/**
 * The measured numbers, painted rather than rendered — same reason as the log.
 *
 * Frame rate is measured off `getStats`, never assumed. Snapshot/restore forces software rendering,
 * so the honest answer is single digits, and a UI implying otherwise would be selling the product on
 * something it does not do.
 */
function paintVitals() {
  const s = state.liveStats;
  const set = (id, text) => { const n = $(id); if (n) n.textContent = text; };
  set('vit-fps', s.fps ? `${s.fps} fps` : '—');
  set('vit-kbps', s.kbps ? `${s.kbps} kbit/s` : '—');
  set('vit-rtt', s.rtt == null ? '—' : `${s.rtt} ms`);
  set('vit-path', s.ice ? (s.ice === 'relay' ? 'relayed (TURN)' : `direct (${s.ice})`) : '—');
  // The header pill, painted for the same reason the rows above are: it changes every second, and
  // re-rendering the screen to move one number is what made the cockpit hitch.
  set('live-fps-pill', `LIVE · ${s.fps || '—'} fps`);
}

function vitalsCard() {
  if (state.liveState !== 'streaming') return null;
  const row = (label, id) => h('div', { class: 'row between vit' },
    h('span', { class: 'caption', text: label }),
    h('span', { class: 'secondary tnum', id, text: '—' }),
  );
  return card('Stream', {},
    row('Frame rate', 'vit-fps'),
    row('Bitrate', 'vit-kbps'),
    row('Round trip', 'vit-rtt'),
    row('Path', 'vit-path'),
    // MEASURED, and it corrected an assumption this project had carried for months. The plan said
    // to expect single digits because snapshot-restore forces SwiftShader; a cold-booted Cuttlefish
    // on an n2-standard-16 actually streams at ~49 fps over a direct path. Say what the numbers are
    // for, not what they were predicted to be.
    h('p', { class: 'caption mt-sm', text: 'Rendering is software (SwiftShader), so frame rate depends on how busy the host is. `relayed (TURN)` means media is going through the relay, which costs egress; `direct` means it is not.' }),
  );
}

function capturesCard() {
  if (!state.shots.length) return null;
  return card('Captured this session', { aside: h('span', { class: 'caption', text: `${state.shots.length}` }) },
    h('div', { class: 'shotstrip' }, state.shots.map((s) => h('a', {
      class: 'shot', href: s.url, download: `mfarm-${s.takenAt.replace(/[:.]/g, '-')}.png`,
      title: `${s.takenAt} — click to download`,
    }, h('img', { src: s.url, alt: `Screenshot at ${s.takenAt}` })))),
    h('p', { class: 'caption mt-sm', text: 'Held in this tab only. There is no artifact store yet, so a reload loses them — download anything worth keeping.' }),
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
    // Text goes down the WebRTC input channel as key events, so it needs no endpoint and no
    // capability beyond the live view being open — which is exactly when it is shown.
    live && state.liveState === 'streaming'
      ? h('div', { class: 'stack tight mt-md' },
          h('p', { class: 'micro', text: 'Type on the device' }),
          h('form', {
            class: 'row tight',
            onsubmit: (e) => { e.preventDefault(); sendTypedText(e.target.elements.txt); },
          },
            h('input', { class: 'field', name: 'txt', placeholder: 'Text to type', autocomplete: 'off' }),
            btn('Send', '', null, {}),
          ),
          h('p', { class: 'caption', text: 'Sent as key events, the same as typing with the device focused. Clicking the screen and typing works too.' }),
        )
      : null,
    // Record, rotate and clear-app-data are in the design and have no implementation. They are
    // absent rather than disabled: a greyed button implies a permission problem, when the truth is
    // that no worker method exists behind them.
  );
}

/**
 * Type a string on the device.
 *
 * Goes through the WebRTC input channel one key at a time rather than through the data plane's
 * `text` verb, and the difference is not stylistic: `text` shells out to `adb shell input text`,
 * which costs a round trip per call and mangles anything with a space or a quote. Key events are
 * what a keyboard produces, so the device treats them identically to real typing.
 */
function sendTypedText(input) {
  const value = input?.value || '';
  if (!value || !state.live) return;
  const channel = state.live.input;
  if (channel?.readyState !== 'open') { toast('Not connected', 'The device input channel is not open.', 'warn'); return; }
  for (const ch of value) {
    // DOM `code` values, which is what Cuttlefish's input handler expects — it maps the code, not
    // the character. Anything outside this map is skipped rather than sent as something else.
    const code = /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}`
      : /[0-9]/.test(ch) ? `Digit${ch}`
      : ch === ' ' ? 'Space'
      : ch === '.' ? 'Period'
      : ch === ',' ? 'Comma'
      : ch === '-' ? 'Minus'
      : ch === '@' ? 'Digit2'
      : null;
    if (!code) continue;
    channel.send(JSON.stringify({ type: 'keyboard', keycode: code, event_type: 'keydown' }));
    channel.send(JSON.stringify({ type: 'keyboard', keycode: code, event_type: 'keyup' }));
  }
  input.value = '';
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

/**
 * What the finished run left behind (migration 019).
 *
 * IN THE COCKPIT, not on a screen of its own, because `#/sessions/<id>` already routes here — the
 * cockpit IS the session detail view and has always handled an ended session, which is exactly when
 * evidence exists.
 *
 * The capture happens when the device is RELEASED AND RESET: the worker takes a final screenshot
 * and dumps the log just before wiping it. So a live session legitimately has nothing here yet, and
 * saying that is different from saying there is nothing — an empty card during a running session
 * would read as a loss.
 */
function evidenceCard(sess, live) {
  const id = sess.id;
  if (state.artifacts.sessionId !== id || !state.artifacts.loaded) {
    void loadArtifacts(id).then(scheduleRender);
  }
  const mine = state.artifacts.sessionId === id;
  const loaded = mine && state.artifacts.loaded;
  const arts = mine ? state.artifacts.items : [];

  return card('Evidence', {
    aside: h('span', { class: 'caption', text: loaded ? `${arts.length} item${arts.length === 1 ? '' : 's'}` : 'loading…' }),
  },
    !loaded
      ? h('p', { class: 'caption', text: 'Loading…' })
      : arts.length
        ? h('div', { class: 'stack tight' }, arts.map((a) => h('div', { class: 'row between' },
            h('div', { class: 'stack tight' },
              h('span', { class: 'row tight' },
                pill(a.kind, a.kind === 'screenshot' ? 'accent' : 'warn plain', { dot: false }),
                h('span', { class: 'caption', text: bytes(a.sizeBytes) })),
              h('p', { class: 'caption', text: `kept until ${when(a.expiresAt)}` }),
            ),
            // A plain link rather than a fetch: the blob route streams and sets its own
            // content-disposition, so the browser renders a PNG and a log correctly without this
            // file learning the difference between them.
            h('a', {
              class: 'btn tiny', href: `/v1/artifacts/${a.id}/blob`,
              target: '_blank', rel: 'noopener', text: 'Open',
            }),
          )))
        : h('p', { class: 'caption' }, live
            ? 'The log and a final screenshot are collected when this device is released and reset.'
            : 'Nothing was captured — either the worker could not reach the device, or these have passed their retention window.'),
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
  // Opening the viewer from the render is safe because `ensureLive` is idempotent, and it is the
  // only place that has both the session detail and the knowledge that the cockpit is on screen.
  // Arriving from the bring-up screen finds a connection already open and reuses it.
  if (live) ensureLive(sess);
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
        state.liveState === 'streaming'
          // Never a hard-coded "LIVE · 60 fps". The number is sampled off the peer connection, and
          // on a software-rendered device it is honestly small.
          ? pill(`LIVE · ${state.liveStats.fps || '—'} fps`, 'bad',
              { live: true, title: 'Measured from the media stream', labelId: 'live-fps-pill' })
          : null,
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
        stagePanel(sess, live),
        logcatDock(sess, live),
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
        evidenceCard(sess, live),
      ),
      h('div', { class: 'rail' },
        // First in the rail while it is on: the inspector is a mode you are actively working in,
        // and hunting for its panel under four others is the opposite of the point.
        inspectorCard(device?.capabilities || []),
        toolsCard(sess, live),
        vitalsCard(),
        capturesCard(),
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
              ['State', 'Session', 'Run', 'Device', 'Region', 'Started', 'Duration', ''].map((t) => h('th', { text: t })))),
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
                // Both directions are navigable: a run lists its sessions, and a session names its
                // run. Without this the flat list is still flat — you can find a run only if you
                // already knew to look for it.
                h('td', null, s.run
                  ? btn(s.run.runId, 'tiny ghost', () => go(`#/runs/${encodeURIComponent(s.run.runId)}`))
                  : h('span', { class: 'caption', text: '—' })),
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



/* ---------------------------------------------------------------------------- runs */

/**
 * How a run's build reads, and it deliberately refuses to guess.
 *
 * `buildCount` is what separates the three real cases. A run whose sessions installed nothing is
 * not the same as one that installed two different builds, and `build: null` alone cannot tell
 * them apart — so the middle case says so in words rather than showing an em-dash that reads as
 * "no build" for a run that had two.
 */
function runBuild(run) {
  if (run.build) {
    return h('span', { class: 'row tight' },
      h('code', { text: run.build.packageName }),
      run.build.versionName ? h('span', { class: 'caption', text: run.build.versionName }) : null,
    );
  }
  if (run.buildCount > 1) {
    return h('span', { class: 'caption', text: `${run.buildCount} builds`,
      title: 'The sessions in this run installed different builds, so there is no single one to name.' });
  }
  return h('span', { class: 'caption', text: '—' });
}

/** One tile on the run detail header, in the shape the health screen already uses. */
function runStat(label, value, note) {
  return card(null, { class: 'stat stack tight' },
    h('p', { class: 'micro', text: label }),
    h('p', { class: 'row tight' }, value),
    h('p', { class: 'caption', text: note }),
  );
}

function screenRuns() {
  const rows = state.runs;
  return [
    pageHead([{ label: 'Farm' }], 'Runs',
      'One row per CI job, not per test. A suite joins a run by setting the mfarm:runId capability.'),
    card(null, { class: 'flush' },
      rows.length
        ? h('div', { class: 'tablewrap' }, h('table', { class: 'table wide' },
            h('thead', null, h('tr', null,
              ['Run', 'Build', 'Sessions', 'Live', 'Started', 'Last activity', ''].map((t) => h('th', { text: t })))),
            h('tbody', null, rows.map((r) => h('tr', null,
              h('td', null, h('code', { text: r.runId })),
              h('td', null, runBuild(r)),
              h('td', { class: 'tnum', text: String(r.sessions.total) }),
              // Live is the ONLY honest "still going" signal: a run has no end of its own, and a
              // sequential suite has no live session at all between two tests. So this is reported
              // as a count of sessions rather than dressed up as a run status.
              h('td', null, r.sessions.live > 0
                ? pill(`${r.sessions.live} live`, 'ok', { live: true })
                : h('span', { class: 'caption', text: '—' })),
              h('td', { class: 'caption', text: r.firstSessionAt ? ago(r.firstSessionAt) : ago(r.createdAt),
                title: when(r.firstSessionAt || r.createdAt) }),
              h('td', { class: 'caption', text: r.lastActivityAt ? ago(r.lastActivityAt) : '—',
                title: r.lastActivityAt ? when(r.lastActivityAt) : '' }),
              h('td', { class: 'right' }, btn('Open', 'tiny ghost', () => go(`#/runs/${encodeURIComponent(r.runId)}`))),
            ))),
          ))
        : empty('No runs yet.',
            'Add mfarm:runId to your suite\'s capabilities — any id your CI already has will do.'),
    ),
    h('p', { class: 'caption mt-md',
      text: 'A run has no pass or fail yet: WebDriver has no concept of an assertion, so the farm '
        + 'sees sessions open and close and cannot tell a passing test from a failing one.' }),
  ];
}

function screenRun(id) {
  const d = state.runDetail;

  // Two different empty states, because they mean opposite things to the person reading them. A
  // fetch that has not landed is a spinner's worth of nothing; a fetch that came back with nothing
  // is a wrong id, and telling someone "loading" forever for a typo is the worse of the two.
  if (!d || d.id !== id || !d.loaded) {
    return [pageHead([{ label: 'Farm' }, { label: 'Runs', to: '#/runs' }], id, 'Loading…')];
  }
  if (!d.run) {
    return [
      pageHead([{ label: 'Farm' }, { label: 'Runs', to: '#/runs' }], id),
      card(null, {}, empty('No run by that name.',
        'Runs are scoped to this org, so an id from someone else\'s farm will not resolve here.')),
    ];
  }

  const run = d.run;
  return [
    pageHead([{ label: 'Farm' }, { label: 'Runs', to: '#/runs' }], run.runId,
      `${run.sessions.total} session${run.sessions.total === 1 ? '' : 's'}, `
      + `${run.sessions.live} still live.`),
    h('div', { class: 'statgrid mb-gap' },
      runStat('Build', runBuild(run),
        run.buildCount > 1 ? 'The sessions did not agree' : 'Installed before each session'),
      runStat('Sessions', h('span', { class: 'val tnum', text: String(run.sessions.total) }),
        `${run.sessions.ended} ended, ${run.sessions.live} live`),
      runStat('Started', h('span', { class: 'val',
        text: run.firstSessionAt ? ago(run.firstSessionAt) : ago(run.createdAt) }),
        when(run.firstSessionAt || run.createdAt)),
      // SPAN, not duration. It is the gap between the first session and the last thing that
      // happened, and a run has no end — so calling it a duration would invite reading it as one.
      runStat('Span', h('span', { class: 'val tnum',
        text: run.firstSessionAt ? duration(run.firstSessionAt, run.lastActivityAt) : '—' }),
        'First session to last activity'),
    ),
    card('Sessions', { class: 'flush' },
      d.sessions.length
        ? h('div', { class: 'tablewrap' }, h('table', { class: 'table wide' },
            h('thead', null, h('tr', null,
              ['State', 'Session', 'Device', 'Build', 'Started', 'Duration', ''].map((t) => h('th', { text: t })))),
            h('tbody', null, d.sessions.map((sn) => {
              const st = SESSION_STATE[sn.state] || { label: sn.state, tone: '' };
              return h('tr', null,
                h('td', null, pill(st.label, st.tone, { live: sn.state === 'ACTIVE' })),
                h('td', null, h('code', { text: sn.id })),
                h('td', { text: sn.device || '—' }),
                h('td', null, sn.build
                  ? h('code', { text: `${sn.build.packageName}${sn.build.versionName ? `@${sn.build.versionName}` : ''}` })
                  : h('span', { class: 'caption', text: '—' })),
                h('td', { class: 'caption', text: sn.startedAt ? ago(sn.startedAt) : ago(sn.createdAt),
                  title: when(sn.startedAt || sn.createdAt) }),
                h('td', null, sn.startedAt && !sn.endedAt
                  ? ticker('since', sn.startedAt)
                  : h('span', { class: 'tnum', text: duration(sn.startedAt, sn.endedAt) })),
                h('td', { class: 'right' }, btn('Open', 'tiny ghost', () => go(`#/sessions/${sn.id}`))),
              );
            })),
          ))
        : empty('This run has no sessions.',
            'It was named by a session that never got a device — every one of its allocations failed.'),
    ),
  ];
}


/* ---------------------------------------------------------------------------- element inspector */

/**
 * Turn the inspector on, and take the first dump.
 *
 * Off by default and never automatic: reading the tree costs an adb round trip on the device
 * someone is using, and a mode that silently swallows taps must be one you chose.
 */
async function toggleInspect() {
  if (state.inspect.on) {
    state.inspect = { on: false, nodes: [], picked: null, at: null, loading: false, error: null };
    if (state.live) state.live.inspectMode = false;
    paintHighlight();
    render();
    return;
  }
  state.inspect.on = true;
  if (state.live) state.live.inspectMode = true;
  render();
  await refreshHierarchy();
}

async function refreshHierarchy() {
  if (!state.live) { toast('Not connected', 'Open the live view first.', 'warn'); return; }
  state.inspect.loading = true;
  state.inspect.error = null;
  render();
  try {
    const out = await state.live.uiDump();
    state.inspect.nodes = parseHierarchy(out.xml);
    state.inspect.at = out.takenAt || new Date().toISOString();
    // The old pick describes the old screen. Keep it only if the same node is still there.
    if (state.inspect.picked) {
      const again = state.inspect.nodes.find((n) =>
        n.cls === state.inspect.picked.cls && n.x1 === state.inspect.picked.x1 && n.y1 === state.inspect.picked.y1);
      state.inspect.picked = again || null;
    }
  } catch (e) {
    state.inspect.error = e.message;
    state.inspect.nodes = [];
  } finally {
    state.inspect.loading = false;
    render();
    paintHighlight();
  }
}

/** A click on the device while inspecting: pick the smallest node under it. */
function inspectPick(x, y) {
  if (!state.inspect.on) return;
  if (!state.inspect.nodes.length) { void refreshHierarchy(); return; }
  state.inspect.picked = nodeAt(state.inspect.nodes, x, y);
  render();
  paintHighlight();
}

/**
 * Draw the selection box over the video.
 *
 * In the taps layer, which is `pointer-events: none`, and ONLY while inspecting — the standing rule
 * is that nothing overlays the device screen, and this is the one deliberate exception: showing you
 * which rectangle you picked is the entire feature, it exists only in a mode you turned on, and it
 * disappears the moment you turn it off.
 *
 * Painted rather than rendered, so a poll cannot make the box flicker.
 */
function paintHighlight() {
  const st = state.stage;
  if (st?.root) st.root.dataset.inspect = state.inspect.on ? 'on' : 'off';
  const layer = st?.frame?.querySelector('.dev-taps');
  if (!layer) return;
  layer.querySelector('.insp-box')?.remove();

  const n = state.inspect.on ? state.inspect.picked : null;
  const video = st.video;
  if (!n || !video?.videoWidth) return;

  // Device pixels -> rendered pixels. `videoWidth` is the device's own panel, and the element is
  // whatever the zoom left it at, so the ratio is the only honest way to place this.
  const k = video.offsetWidth / video.videoWidth;
  const box = h('div', { class: 'insp-box' },
    h('span', { class: 'insp-tag', text: n.cls.split('.').pop() }));
  Object.assign(box.style, {
    left: `${n.x1 * k}px`, top: `${n.y1 * k}px`,
    width: `${(n.x2 - n.x1) * k}px`, height: `${(n.y2 - n.y1) * k}px`,
  });
  layer.append(box);
}

const QUALITY = {
  stable:  { label: 'stable',  tone: 'ok' },
  ok:      { label: 'usable',  tone: 'warn plain' },
  brittle: { label: 'brittle', tone: 'bad' },
};

function copyRow(text, label) {
  return h('div', { class: 'insp-copy' },
    h('code', { class: 'insp-val', text }),
    btn('Copy', 'tiny ghost', async () => {
      try { await navigator.clipboard.writeText(text); toast('Copied', label || text); }
      catch { toast('Could not copy', 'Select the text and copy it manually.', 'bad'); }
    }),
  );
}

/**
 * The inspector panel.
 *
 * Deliberately NOT a tree view. The question is "what is under my finger and how do I name it in a
 * test", which is a hit test and a selector — a scrolling tree of every node is what inspectors add
 * and nobody reads. Tap the thing; get the handle.
 */
function inspectorCard(caps) {
  if (!caps.includes('ui-hierarchy')) return null;
  if (!state.inspect.on) return null;
  const { picked, nodes, loading, error, at } = state.inspect;

  const head = h('div', { class: 'row tight' },
    h('span', { class: 'caption', text: loading ? 'reading…' : `${nodes.length} elements` }),
    btn('Re-read', 'tiny ghost', () => void refreshHierarchy(), { disabled: loading }),
  );

  if (error) {
    return card('Inspector', { aside: head },
      h('p', { class: 'help', text: error }),
      h('p', { class: 'caption mt-sm', text: 'Re-read once the screen settles, or end any Appium session driving this device.' }));
  }
  if (!picked) {
    return card('Inspector', { aside: head },
      h('p', { class: 'help', text: loading ? 'Reading the screen…' : 'Tap anything on the device to inspect it. Taps select while the inspector is on — nothing reaches the app.' }),
      at && !loading ? h('p', { class: 'caption mt-sm', text: `Snapshot taken ${ago(at)}. Re-read after the screen changes.` }) : null,
    );
  }

  const attr = (k, v) => (v ? h('div', { class: 'row between insp-attr' },
    h('span', { class: 'caption', text: k }),
    h('span', { class: 'mono insp-attrv', text: v })) : null);

  const sels = selectorsFor(picked, nodes);
  return card('Inspector', { aside: head },
    h('div', { class: 'insp-head' },
      h('span', { class: 'insp-cls mono', text: picked.cls }),
      picked.clickable ? pill('clickable', 'ok', { dot: false }) : null,
      picked.scrollable ? pill('scrollable', 'warn plain', { dot: false }) : null,
      picked.enabled ? null : pill('disabled', 'bad', { dot: false }),
    ),
    h('div', { class: 'insp-attrs' },
      attr('text', picked.text),
      attr('content-desc', picked.desc),
      attr('resource-id', picked.id),
      attr('bounds', `${picked.x1},${picked.y1} → ${picked.x2},${picked.y2}`),
    ),
    h('p', { class: 'micro mt-md', text: 'SELECTORS — best first' }),
    sels.length
      ? h('div', { class: 'stack tight' }, sels.map((sel) => {
          const q = QUALITY[sel.quality] || QUALITY.ok;
          return h('div', { class: 'insp-sel' },
            h('div', { class: 'row tight' },
              h('span', { class: 'micro', text: sel.strategy }),
              pill(q.label, q.tone, { dot: false }),
            ),
            copyRow(sel.value, sel.strategy),
            sel.note ? h('p', { class: 'caption', text: sel.note }) : null,
          );
        }))
      : h('p', { class: 'help', text: 'This element carries no id, no description and no text, so nothing here would identify it. Pick its parent, or ask for a testTag on it.' }),
  );
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
    { glyph: '▶', label: 'Launch a device', group: 'Go', run: () => go('#/launch') },
    { glyph: '■', label: 'Open Devices', group: 'Go', run: () => go('#/devices') },
    { glyph: '✚', label: 'Open Apps', group: 'Go', run: () => go('#/apps') },
    { glyph: '☰', label: 'Open Sessions', group: 'Go', run: () => go('#/sessions') },
    { glyph: '▤', label: 'Open Runs', group: 'Go', run: () => go('#/runs') },
    { glyph: '⋮', label: 'Open Queue', group: 'Go', run: () => go('#/queue') },
    { glyph: '◎', label: 'Open Farm health', group: 'Go', run: () => go('#/health') },
  ];
  if (held) {
    list.unshift({ glyph: '▶', label: 'Open your session cockpit', group: 'Session', run: () => go(`#/sessions/${held.id}`) });
    list.push({ glyph: '⏻', label: 'Release your device', group: 'Session', run: () => askRelease(held) });
  }
  // Offered only where they would work. A palette entry for a capability the device lacks is the
  // same lie as a button for one.
  if (state.route.name === 'cockpit' && state.live) {
    const dev = deviceById(state.detail?.deviceId);
    const caps = dev?.capabilities || [];
    if (caps.includes('screenshot')) list.push({ glyph: '⧉', label: 'Take a screenshot', group: 'Session', run: () => void takeScreenshot() });
    if (caps.includes('logcat')) list.push({ glyph: '≡', label: state.log.streaming ? 'Pause logcat' : 'Resume logcat', group: 'Session', run: () => toggleLogcat() });
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
// `r` was already Sessions when Runs arrived, and rebinding it would have broken the one shortcut
// people here use most. `u` is what "run" has left once r, n and s are taken.
const G_ROUTES = { d: 'devices', a: 'apps', r: 'sessions', u: 'runs', q: 'queue', h: 'health', l: 'launch', t: 'team', s: 'settings' };

/**
 * Is this keystroke meant for something that takes typing, rather than for the console?
 *
 * THE DEVICE SCREEN COUNTS, and leaving it out was a real bug. A focused `<video>` is not an INPUT,
 * a TEXTAREA or a SELECT, so every character typed at a live device also ran the console's
 * single-letter shortcuts: an email address contains `r` (release), `s` (screenshot), `l` (logcat)
 * and `g`+letter (navigate away). The first of those to fire moved focus off the video and the rest
 * of the typing vanished, which read as "the keyboard does not work".
 *
 * `live.js` also stops propagation at the source. Both exist deliberately: that one is the fix,
 * this one is the guard for any future path that reaches the device without going through it.
 */
function inField(e) {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return true;
  // The mirrored device: anything typed here belongs to Android, not to this page.
  return t.classList.contains('dev-video');
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

  // The design's `S` and `L`. Both are cockpit-only and both check the same capability the button
  // does — the shortcut is never a way to reach a control the device does not have.
  if (state.route.name === 'cockpit' && state.live) {
    const device = deviceById(state.detail?.deviceId);
    const caps = device?.capabilities || [];
    if (k === 's' && caps.includes('screenshot')) { e.preventDefault(); void takeScreenshot(); }
    if (k === 'l' && caps.includes('logcat')) { e.preventDefault(); toggleLogcat(); }
  }
});

/* ---------------------------------------------------------------------------- render */


/* ---------------------------------------------------------------------------- organisation */

/** Owner and admin may change access; a member may look. Mirrors `requireOrgAdmin` on the server. */
function isOrgAdmin() { return state.me?.role === 'owner' || state.me?.role === 'admin'; }

/**
 * A screen that needs `state.org` renders a skeleton on first paint and fills in.
 *
 * The alternative — awaiting the fetch before rendering — leaves the person looking at the previous
 * screen while a request is in flight, which reads as a dead click.
 */
function orgGate() {
  if (state.org.loaded) return null;
  void refreshOrg().then(render).catch((e) => toast('Could not load the organisation', e.message, 'bad'));
  return h('p', { class: 'empty' }, h('strong', { text: 'Loading…' }));
}

function roleBadge(role) {
  return h('span', { class: `pill ${role === 'owner' ? 'accent' : ''}`.trim(), text: role });
}

function screenTeam() {
  const pending = orgGate();
  const admin = isOrgAdmin();

  return [
    pageHead([{ label: 'Organisation' }], 'Team',
      `${state.org.members.length} ${state.org.members.length === 1 ? 'person' : 'people'} can sign in`,
      admin ? btn('Add someone', 'primary', () => addMemberDialog()) : null),
    h('div', { class: 'split' },
      h('div', { class: 'content' },
        card('People', {},
          pending || (state.org.members.length
            ? h('div', { class: 'stack' }, state.org.members.map((m) => h('div', { class: 'inset row between' },
                h('div', { class: 'stack tight' },
                  h('span', { class: 'row tight' },
                    h('span', { class: 'secondary', text: m.email }),
                    roleBadge(m.role),
                    m.email === state.me?.user?.email ? h('span', { class: 'caption', text: '(you)' }) : null),
                  h('p', { class: 'caption', text: m.lastSeenAt ? `last signed in ${when(m.lastSeenAt)}` : 'has never signed in' }),
                ),
                admin && m.email !== state.me?.user?.email
                  ? h('div', { class: 'row tight' },
                      btn('Reset password', 'tiny ghost', () => addMemberDialog(m)),
                      btn('Remove', 'tiny danger', () => removeMember(m)))
                  : null,
              )))
            : empty('Nobody else yet.', 'Add a teammate so they can run suites without SSH to the box.'))),
      ),
      h('div', { class: 'rail' },
        card('How access works', {},
          h('p', { class: 'caption' },
            'There is no email on this farm, so adding someone does not send an invite. You choose '
            + 'their password here and it is shown once — pass it on yourself, and they can change '
            + 'it by having an admin reset it.'),
          h('p', { class: 'caption mt-sm' },
            'Removing someone ends their browser sessions immediately. It does not revoke API keys, '
            + 'which belong to the organisation rather than to a person — revoke those in Settings.'),
        ),
      ),
    ),
  ];
}

function screenSettings() {
  const pending = orgGate();
  const admin = isOrgAdmin();
  const live = state.org.keys.filter((k) => !k.revokedAt);
  const dead = state.org.keys.filter((k) => k.revokedAt);

  return [
    pageHead([{ label: 'Organisation' }], 'Settings',
      `${live.length} active API ${live.length === 1 ? 'key' : 'keys'}`,
      admin ? btn('New API key', 'primary', () => createKey()) : null),
    h('div', { class: 'split' },
      h('div', { class: 'content' },
        state.org.newKey ? card('Your new key', { class: 'highlight' },
          h('p', { class: 'caption' },
            'Copy this now. It is not stored anywhere and cannot be shown again — if you lose it, '
            + 'revoke it and make another.'),
          h('p', { class: 'mono selectable keyplain', text: state.org.newKey }),
          h('div', { class: 'row tight mt-sm' },
            btn('Copy', 'tiny', async () => {
              try {
                await navigator.clipboard.writeText(state.org.newKey);
                toast('Copied', 'The key is on your clipboard.');
              } catch { toast('Could not copy', 'Select the text and copy it manually.', 'bad'); }
            }),
            btn('Done', 'tiny ghost', () => { state.org.newKey = null; render(); }),
          ),
        ) : null,

        card('API keys', {},
          pending || (state.org.keys.length
            ? h('div', { class: 'stack' }, [...live, ...dead].map((k) => h('div', { class: 'inset row between' },
                h('div', { class: 'stack tight' },
                  h('span', { class: 'row tight' },
                    h('span', { class: 'mono secondary', text: `${k.prefix}…` }),
                    k.revokedAt ? h('span', { class: 'pill', text: 'revoked' }) : null),
                  h('p', { class: 'caption', text: k.revokedAt ? `revoked ${when(k.revokedAt)}` : `created ${when(k.createdAt)}` }),
                ),
                admin && !k.revokedAt ? btn('Revoke', 'tiny danger', () => revokeKey(k)) : null,
              )))
            : empty('No API keys yet.', 'A key is what a CI job or an Appium suite authenticates with.'))),
      ),
      h('div', { class: 'rail' },
        card('Using a key', {},
          h('p', { class: 'caption' }, 'Point an existing Appium suite at the farm by changing one URL:'),
          h('p', { class: 'mono selectable caption mt-sm', text: `${location.origin}/wd/hub` }),
          h('p', { class: 'caption mt-sm' },
            'Send the key as HTTP Basic — the key is the username and the password half stays empty '
            + '— or as `Authorization: Bearer <key>` against /v1.'),
          h('p', { class: 'caption mt-sm' },
            'A key belongs to the organisation, not to you. Revoking one breaks every job using it, '
            + 'so give CI its own.'),
        ),
      ),
    ),
  ];
}

/**
 * Add a person, or reset one's password.
 *
 * One dialog for both because the endpoint is one upsert, and because the difference a person cares
 * about — "this address already exists, so this is a reset" — is something the server decides, not
 * the form. Generating the password rather than asking for one keeps a farm from filling up with
 * `password123`; it stays editable because sometimes you want to hand over something sayable.
 */
function addMemberDialog(existing) {
  const generated = randomPassword();
  const emailInput = h('input', {
    class: 'field', type: 'email', placeholder: 'someone@company.com',
    value: existing?.email || '', disabled: Boolean(existing), autocomplete: 'off',
  });
  const passInput = h('input', { class: 'field mono', type: 'text', value: generated, autocomplete: 'off' });
  const roleSelect = h('select', { class: 'field' },
    ['member', 'admin', 'owner'].map((r) =>
      h('option', { value: r, selected: (existing?.role || 'member') === r, text: r })));

  formDialog({
    title: existing ? `Reset password for ${existing.email}` : 'Add someone',
    lead: existing
      ? 'Their existing browser sessions end immediately. Tell them the new password yourself — there is no email on this farm.'
      : 'No invite is sent. Copy the password and pass it on yourself.',
    fields: [
      existing ? null : h('label', { class: 'stack tight' }, h('span', { class: 'micro', text: 'Email' }), emailInput),
      h('label', { class: 'stack tight' }, h('span', { class: 'micro', text: 'Password' }), passInput),
      h('label', { class: 'stack tight' }, h('span', { class: 'micro', text: 'Role' }), roleSelect),
    ],
    submit: existing ? 'Reset password' : 'Add',
    onSubmit: async () => {
      const email = (existing?.email || emailInput.value).trim();
      const password = passInput.value;
      const role = roleSelect.value;
      try {
        const out = await api('/v1/account/members', { method: 'POST', body: { email, password, role } });
        await refreshOrg();
        render();
        toast(out.created ? 'Added' : 'Password reset',
          `${email} · ${role} · password ${password}`);
      } catch (e) {
        toast(existing ? 'Could not reset' : 'Could not add', e.message, 'bad');
      }
    },
  });
}

function removeMember(m) {
  confirmDialog({
    title: `Remove ${m.email}?`,
    lead: 'They are signed out immediately and lose access to this farm.',
    removes: ['Their sign-in to this organisation', 'Every browser session they currently hold'],
    keeps: 'API keys are unaffected — they belong to the organisation, not to a person.',
    confirm: 'Remove',
    onConfirm: async () => {
      try {
        await api(`/v1/account/members/${m.userId}`, { method: 'DELETE' });
        await refreshOrg();
        render();
        toast('Removed', `${m.email} can no longer sign in.`);
      } catch (e) {
        toast('Could not remove', e.message, 'bad');
      }
    },
  });
}

async function createKey() {
  try {
    const { key } = await api('/v1/account/api-keys', { method: 'POST' });
    // Held in memory only, and only until the person dismisses it. The server keeps a hash.
    state.org.newKey = key.plaintextShownOnce;
    await refreshOrg();
    render();
  } catch (e) {
    toast('Could not create a key', e.message, 'bad');
  }
}

function revokeKey(k) {
  confirmDialog({
    title: `Revoke ${k.prefix}…?`,
    lead: 'Every job authenticating with this key stops working at once.',
    removes: ['Any CI job or Appium suite using this key'],
    keeps: 'Sessions already running are not interrupted; the key just cannot start new ones.',
    confirm: 'Revoke',
    onConfirm: async () => {
      try {
        await api(`/v1/account/api-keys/${k.prefix}`, { method: 'DELETE' });
        await refreshOrg();
        render();
        toast('Revoked', `${k.prefix}… no longer authenticates.`);
      } catch (e) {
        toast('Could not revoke', e.message, 'bad');
      }
    },
  });
}

/** Readable, and long enough that the scrypt cost is not the only defence. */
function randomPassword() {
  const words = ['harbour', 'granite', 'lantern', 'meadow', 'compass', 'thicket', 'cobalt',
    'juniper', 'kettle', 'marble', 'orchid', 'pewter', 'quarry', 'saffron', 'tundra', 'walnut'];
  const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 90 + 10;
  return `${pick()}-${pick()}-${pick()}-${n}`;
}

/** Exported for the same reason `state` is: the smoke test builds every one of these. */
export const SCREENS = {
  launch: () => screenLaunch(),
  launching: () => screenLaunching(state.route.id),
  devices: () => screenDevices(),
  device: () => screenDevice(state.route.id),
  apps: () => screenApps(),
  sessions: () => screenSessions(),
  runs: () => screenRuns(),
  run: () => screenRun(state.route.id),
  cockpit: () => screenCockpit(state.route.id),
  queue: () => screenQueue(),
  health: () => screenHealth(),
  team: () => screenTeam(),
  settings: () => screenSettings(),
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

  /**
   * WAS THE PERSON TYPING ON THE DEVICE?
   *
   * `replaceChildren` below detaches every child, and detaching a focused element BLURS it. The
   * device video survives a render — `state.stage` keeps the node and its stream alive — but its
   * focus does not, so the keyboard silently stopped being routed to Android on whatever render
   * happened next. With a five-second poll that means typing worked only in the gap between
   * renders: the first few characters of an email address landed, the rest went nowhere, and the
   * screen gave no sign which was which.
   *
   * Checked before and restored after, rather than always focusing the video — stealing focus from
   * someone filling in a dialog would be a worse bug than the one this fixes.
   */
  const wasTypingOnDevice = document.activeElement?.classList?.contains('dev-video');

  main.replaceChildren();
  add(main, [(SCREENS[state.route.name] || SCREENS.devices)()]);
  // Everything below re-attaches live state to the nodes that were just created. A render throws
  // the previous DOM away wholesale, so a <video> loses its stream, the log dock comes back empty,
  // and the vitals reset to em-dashes — none of which is a state change, so none of it belongs in
  // the tree the screen functions build.
  attachVideo();
  paintLog();
  paintVitals();
  paintHighlight();

  // Put the keyboard back where it was. `preventScroll` because the device panel may sit below the
  // fold on a short window, and yanking the page to it every five seconds is its own bug.
  if (wasTypingOnDevice) {
    document.querySelector('.dev-video')?.focus({ preventScroll: true });
  }
}

/**
 * A render on the next turn of the loop.
 *
 * Used by everything the live connection calls back into. `ensureLive` runs DURING a render (the
 * cockpit is what knows a viewer is wanted), and `connect()` reports its first state change
 * synchronously — so calling `render()` from there would re-enter a render that is still building
 * the tree it is about to discard.
 */
function scheduleRender() { setTimeout(render, 0); }

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
/**
 * What the POLL is allowed to change, reduced to a comparable string.
 *
 * The five-second poll used to call `render()` unconditionally, and `render()` throws the whole
 * screen away and rebuilds it. On the cockpit that meant a full teardown every five seconds while
 * someone watched video and read a log — the source of the periodic hitch, of the focus loss fixed
 * earlier, and of the pointer-down guard that exists because a render can eat the click travelling
 * to a button.
 *
 * Almost every poll changes nothing: two devices, the same session, the same actions. So compare
 * first and skip.
 *
 * SCOPED TO THE POLL'S OWN WRITES, deliberately, and that is what makes this safe rather than
 * clever. `refreshDevices`, `refreshSessions`, `refreshActions`, `refreshApps`, `refreshHeld` and
 * `loadSessionDetail` write exactly these fields and nothing else. Every OTHER thing the screen
 * depends on — the route, the live connection state, the org screens, a dialog — is changed by code
 * that calls `render()` itself, so none of it can go stale behind this check. A general "did
 * anything change" over all of `state` would be both slower and wrong: it would keep re-rendering
 * for `liveStats`, which is sampled every second and is painted, not rendered.
 *
 * `fetchedAt` and the data-plane token are excluded: both change on every fetch and neither is
 * drawn. Including them would make the signature differ every time and quietly disable this.
 */
function pollSignature() {
  const stable = (o) => {
    if (!o) return null;
    const { fetchedAt, dataPlane, ice, ...rest } = o;
    return { ...rest, dp: dataPlane?.browserEndpoint ?? null };
  };
  return JSON.stringify({
    devices: state.devices,
    available: state.available,
    sessions: state.sessions,
    apps: state.apps,
    actions: state.actions,
    held: stable(state.held),
    detail: stable(state.detail),
    error: state.error,
  });
}

function startPoll() {
  if (state.poll) clearInterval(state.poll);
  state.poll = setInterval(async () => {
    if (document.hidden || !state.me) return;
    try {
      const before = pollSignature();
      await Promise.all([refreshDevices(), refreshSessions(), refreshActions()]);
      if (state.route.name === 'apps') await refreshApps();
      await refreshHeld();
      if (state.route.name === 'cockpit' && state.detail?.id === state.route.id
          && Date.now() - (state.detail.fetchedAt || 0) > 10_000) {
        await loadSessionDetail(state.route.id);
      }
      state.error = null;
      // Only rebuild the screen when the poll actually brought something new. The header counters
      // and every elapsed-time field are repainted by the one-second tick regardless, so a skipped
      // render leaves nothing stale — it just leaves the DOM alone.
      if (pollSignature() !== before) render();
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

/**
 * The running release, in the header.
 *
 * Deliberately fails quiet — an API too old to know `/v1/version` still serves a perfectly good
 * console, and a dash is a truthful answer to "which build is this?" when nothing said so.
 */
async function showBuild() {
  const el = $('build');
  try {
    const v = await api('/v1/version');
    el.textContent = v.short;
    el.title = [
      `commit ${v.sha}`,
      v.builtAt ? `built ${new Date(v.builtAt).toLocaleString()}` : 'built locally',
      `api up since ${new Date(v.startedAt).toLocaleString()}`,
      v.migration ? `schema ${v.migration}` : 'schema unknown',
    ].join('\n');
  } catch {
    el.textContent = '—';
    el.title = 'this API does not report a build';
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
  void showBuild();

  state.route = parseHash();
  await refreshAll();
  if (state.route.name === 'cockpit') await loadSessionDetail(state.route.id);
  // A run URL is the one people paste to each other — "what happened on 4471" — so a cold load of
  // it has to fetch before the first paint, exactly like the cockpit. `hashchange` does not fire on
  // load, and without this the screen renders its own empty state for a run that has plenty in it.
  if (state.route.name === 'run') await loadRunDetail(state.route.id);
  render();
  startPoll();
  startTick();
  // A reload of a bring-up URL has to rejoin the session it names. `hashchange` does not fire on
  // load, so without this the checklist renders from nothing and the viewer is never opened — and
  // the person is left staring at a screen that will never advance while their device sits
  // allocated behind it.
  if (state.route.name === 'launching') void watchBringup(state.route.id);
}

// Restore the sidebar width before first paint so it does not flash open then collapse.
try {
  const nav = localStorage.getItem('mf-nav');
  if (nav === 'icons') { root.dataset.nav = 'icons'; $('navtoggle').firstElementChild.textContent = '»'; }
} catch { /* private mode */ }

$('hub-preview').textContent = `https://<api-key>@${location.host}/wd/hub`;
checkReach();
boot().catch(() => showSignin());
