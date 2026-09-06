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
import {
  geometryText, hasChrome, widthDp, classBlurb,
  deviceName, deviceClass, capacityText, freeText as classFreeText,
} from '/profiles.js';
import { iconSvg } from '/icons.js';
import { frameFor, buildFrame, applyFrame, staticFrame } from '/frame.js';

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
  /** `GET /devices/:id/quarantine-log` for the device detail screen. One device at a time. */
  quarantineLog: null,
  /**
   * `GET /devices/:id` — the DETAIL read, which is a strictly larger row than the list's.
   *
   * The device screen used to draw from `state.devices`, the 5s fleet poll, and that is where its
   * "Last reset" row came from: the list projection did not carry `last_reset_at`, so the field
   * read "not reported" on every device in the fleet, forever, and looked exactly like a farm that
   * had never reset anything.
   *
   * `last_reset_at` IS IN THE LIST NOW — Health needs it per device (D1), which makes it a fleet
   * fact rather than a one-screen one. `hostLastSeenAt` and `resetAttempts` stay list-absent for
   * the original reason: a fleet poll should not carry what only one screen reads.
   *
   * The poll row stays the FALLBACK, so the screen paints immediately on navigation and fills in
   * rather than showing a skeleton over facts it already has.
   */
  deviceDetail: null,
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
  /**
   * The session whose handover substitution the person has acknowledged.
   *
   * Per-session and in memory only: "I know, keep it" is a fact about this session and this sitting.
   * Persisting it would silence the notice for a DIFFERENT session that made the same substitution,
   * which is the one place it most needs to be said.
   */
  acceptedHandover: null,
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
  /**
   * `scope` is 'app' or 'all'. It defaults to 'app' the moment a build is installed on the session,
   * because §17 of the product direction is explicit: do not dump raw logcat into the main UI.
   * Measured on a real session, 37% of the lines were one system service retrying a connection.
   */
  /**
   * `scope: 'all'` — D23, and the default is the whole defect.
   *
   * It was `'app'`. On the lab, with the build installed, launched and visibly on screen, that
   * matched **0 of 270 lines**: every tag a Cuttlefish instance emits is a system one (`adbd`,
   * `logd`, `WifiService`, `SatelliteController`), and there is no `ActivityManager` line at all —
   * which is precisely the fallback `visibleLog`'s comment says the name match relies on. So the
   * first thing anybody saw on a healthy session was an empty pane reading "0 / 260 lines".
   *
   * The scope stays, because on a device that DOES tag its lines it is the right lens. It is now
   * something you turn on, not something that turns your log off before you have seen it.
   */
  log: { lines: [], filter: '', level: 'ALL', follow: true, dropped: 0, scope: 'all' },
  /**
   * Which kind of device the fleet screen is showing (spec §25).
   *
   * View state, not a query: the fleet is already in memory and small, so filtering here costs
   * nothing and — unlike a server-side filter — cannot disagree with the counts in the page head.
   */
  deviceKind: 'all',
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
   * The pairing screen's own state — ADR-0014.
   *
   * `machine` is what the agent SAID about itself, held between the two halves of an approval:
   * inspect, look at it, then confirm. That gap is the whole mitigation for the flow's one real
   * weakness — somebody talked into typing a code they were sent — so it is a deliberate stop
   * rather than an extra click to be optimised away later.
   *
   * The code lives here rather than in the input element because a poll-driven re-render replaces
   * the DOM underneath it, and half-typed input that vanishes is worse than no screen at all.
   */
  pair: { code: '', machine: null, busy: false, error: null, enrollments: [], loaded: false },
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
  /**
   * Which lens the Fleet is showing. DERIVED from the route by `parseHash`, never set on its own —
   * two places holding "which lens" is how the URL and the highlighted tab come to disagree the
   * first time somebody presses back.
   */
  lens: 'capacity',
  error: null,
  /**
   * When the data on screen was last known to be true.
   *
   * Read only by the API-loss toast, and it is what turns "the connection is down" into something
   * somebody can act on: a fleet page from forty seconds ago is worth trusting, one from twenty
   * minutes ago is not, and the console has no business deciding that on the reader's behalf.
   */
  lastGoodAt: null,
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
  // Not "Recovering", which reads as something happening TO the device by itself. An operator
  // authorised this and is waiting on the answer; "Preparing" is what the device is doing for them.
  PREPARING:      { label: 'Preparing', tone: 'warn',   note: 'Recovering from quarantine — it is not available until it passes a health check' },
  QUARANTINED:    { label: 'Quarantined', tone: 'bad',  note: 'Out of the pool; needs somebody to look at it' },
  OFFLINE:        { label: 'Offline',   tone: '',       note: 'The host has not reported it' },
  EVICTED:        { label: 'Evicted',   tone: '',       note: 'Removed from the fleet' },
};

/**
 * States a device comes back from ON ITS OWN — the ones "busy" honestly describes.
 *
 * Deliberately a set of the states that RESOLVE, not the complement of READY. `QUARANTINED`,
 * `OFFLINE` and `EVICTED` need somebody to do something, and grouping them under "busy" on the
 * Launch screen told a tester to wait for a device that was never coming. Found by exploratory
 * testing on 2026-08-31: the Launch screen said `1 busy` for a handset the Health screen — reading
 * the same API — correctly called `Quarantined`.
 */
const BUSY_STATES = new Set(['RESERVED', 'SESSION_ACTIVE', 'CLEANING', 'BOOTING', 'PREPARING']);

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
// The three resets are mutually exclusive and all three are listed, so a device shows which one it
// has and which it does not. Leaving `install-reset` out did not hide it — unknown capabilities
// still render below — but it greyed out `session-reset` beside it, which reads as "this phone has
// no reset" when it has a different one, on purpose (ADR-0012).
const KNOWN_CAPS = ['app-install', 'webdriver', 'snapshot-reset', 'session-reset', 'install-reset', 'screen-stream', 'logcat', 'screenshot'];

/**
 * Failure classification (spec §18).
 *
 * The point of showing this at all is that "failed" has meant two unrelated things — your app is
 * broken, and our farm is broken — and a report that cannot tell them apart teaches people to
 * ignore red. So the class is what gets the colour: `test` is the only one that is the product's
 * fault, and the other two are visually the farm admitting something.
 */
const FAILURE_CLASS_LABEL = {
  'test': 'Test',
  'infrastructure': 'Infrastructure',
  'device-health': 'Device health',
};

const FAILURE_REASON_LABEL = {
  'assertion-failure': 'an assertion failed',
  'application-crash': 'the app under test crashed',
  'adb-failure': 'adb stopped responding',
  'appium-failure': 'the automation server failed',
  'device-disconnected': 'the device disconnected',
  'usb-failure': 'the USB connection failed',
  'agent-failure': 'the MFARM agent failed',
  'network-failure': 'the network failed',
  'low-storage': 'the device ran out of storage',
  'low-battery': 'the device battery was too low',
  'device-locked': 'the device was locked',
  'device-unresponsive': 'the device stopped responding',
};

/**
 * One tag naming a failure's class, with the specific reason as its tooltip.
 *
 * Class in the label and reason in the title rather than both inline: a list of twelve failures is
 * scanned for the SHAPE of the problem, and twelve different reason strings defeat that. The reason
 * is one hover away for the row that turns out to matter.
 */
function failureTag(cls, reason) {
  const label = FAILURE_CLASS_LABEL[cls] || cls;
  return h('span', {
    // `test` is the product's problem and stays neutral — it is the ordinary case a red pill
    // already covers. The farm's own faults are marked, because those are the ones a person is
    // being asked to discount.
    class: `failtag ${cls === 'test' ? '' : 'farm'}`.trim(),
    title: reason ? `${label}: ${FAILURE_REASON_LABEL[reason] || reason}` : label,
    text: label,
  });
}

/**
 * Real device or virtual one (spec §25).
 *
 * Derived from `tier` rather than stored, because the tier is already the truth and a second field
 * saying the same thing is a second field that can disagree with it. Everything that is not a
 * handset is virtual — a new virtual tier should appear as VIRTUAL without anyone remembering to
 * add it here, while a new PHYSICAL tier is a decision someone must make deliberately.
 */
const isRealDevice = (d) => d.tier === 'physical';
const deviceKindOf = (d) => (isRealDevice(d) ? 'real' : 'virtual');

const DEVICE_KINDS = [
  ['all', 'All'],
  ['virtual', 'Virtual'],
  ['real', 'Real'],
];

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

/**
 * `2 September` — a DAY, for a headline.
 *
 * `when()` is a full locale datetime, which is right in a metadata row where somebody may be
 * correlating with a log, and wrong in a sentence: "Out of the pool since 02/09/2026, 02:03:48"
 * asks a reader to parse a timestamp to learn a fact that is three days old. The precise value is
 * still one row away, in Metadata, and the pill beside this carries the relative age.
 */
function day(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    // The year only when it is not this one. On a farm where almost everything happened this year
    // it is four characters of noise, and on the one row where it matters its absence would be a
    // lie by omission.
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
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

/**
 * A LENGTH IN WORDS — "20 minutes", not "20:00".
 *
 * `clock()` is mm:ss and it is right where a number is TICKING: a lease counting down wants a
 * stable, monospaced shape that changes every second. It is wrong in a sentence. "Released by you
 * at 14:29, after 20:00" reads as two clock times, and the second one is a duration — a person has
 * to stop and work out that 20:00 is twenty minutes rather than eight in the evening.
 *
 * Coarse on purpose, like `ago`. Nobody reading "how long did I hold that device" needs the
 * seconds, and offering them invites the same misreading in a smaller way.
 */
function lengthInWords(from, to) {
  if (!from) return '—';
  const ms = (to ? new Date(to) : new Date()) - new Date(from);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  /**
   * FLOORED, NOT ROUNDED — D25, and it is about agreement rather than accuracy.
   *
   * `clock()` truncates, so a 6.5-second session rendered "00:06 held for" beside a sentence
   * reading "after 7 seconds": one card stating one fact as two numbers. Prose that rounds up is
   * marginally friendlier on its own and contradicts the figure printed next to it, which is worse.
   * Both now count the same whole seconds.
   */
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const hr = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${hr}h ${rest}m` : `${hr} hour${hr === 1 ? '' : 's'}`;
}

function duration(from, to) {
  if (!from) return '—';
  return clock((to ? new Date(to) : new Date()) - new Date(from));
}

const short = (id) => (id ? String(id).slice(0, 8) : '—');

/**
 * WHAT A SESSION'S DEVICE IS CALLED — the copy deck's naming rule, applied to the last places that
 * were still leaking an internal name.
 *
 * `session.device` is the worker's LOCAL ID: `dd-cf-1`, `cf-2`, `scale-7`. It is a real handle and
 * it belongs in a details panel or a copyable field, but the copy deck is explicit that a device is
 * addressed by WHAT IT IS — and six places were putting the local id in a heading, a sidebar and a
 * toast. The top bar already did this correctly, which is exactly why it took a screenshot of the
 * SIDEBAR to notice that "dd-cf-1" was sitting under "YOUR SESSION" while "MFARM X1 Pro" sat above
 * it in the header.
 *
 * Falls back to the local id rather than to nothing: a session whose device has since been evicted
 * still has to say something, and the raw handle is more use than an em-dash.
 */
function deviceLabel(sess) {
  const d = sess?.deviceId ? deviceById(sess.deviceId) : null;
  return d ? deviceName(d) : (sess?.device || short(sess?.deviceId));
}

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

/**
 * Status pill: a dot, a label, and — where we genuinely know it — WHEN.
 *
 * THE RULE THE WHOLE PALETTE RESTS ON is that colour never carries meaning alone. Delete every hue
 * from this console and each state still reads as a word and a time. That is what lets the light
 * theme re-derive every hex without a state becoming ambiguous, and it is why the dot is not
 * optional on a state pill.
 *
 * `at` RENDERS ADJACENT, NEVER INSIDE, and both halves of that matter. A pill that grows to hold
 * "2 minutes ago" stops being the fixed-width token you can scan down a column of; and the pill
 * states a CONDITION while the timestamp states WHEN IT WAS OBSERVED — two facts that age
 * differently, because a stale poll invalidates the second without touching the first.
 *
 * WHY `at` IS NOT REQUIRED HERE, which the handover asks for and this deliberately does not do.
 * Requiring it would only be honest if every state had a truthful timestamp to give, and this
 * control plane does not have one for a device's state: `devices.updated_at` moves on capability
 * and automation-endpoint changes too, so rendering it as "READY since" would put a precise wrong
 * number under a status — the exact failure the rule exists to prevent. Where a real timestamp
 * exists — quarantine, recovery, lease, session start — it is passed and shown. Closing the gap
 * properly needs a `state_changed_at` column, which is a migration and not a stylesheet.
 *
 * So: passed where it is true, absent where it would be invented. A missing timestamp is a gap
 * somebody can see; a fabricated one is not.
 */
function pill(label, tone, opts = {}) {
  const el = h('span', { class: `pill ${tone || ''}`.trim(), title: opts.title || null },
    opts.dot === false ? null : h('span', { class: `dot ${tone || ''} ${opts.live ? 'live' : ''}`.trim() }),
    // `labelId` makes the text paintable. Anything that changes every second belongs in a painter,
    // not in a render — see `renderIfChanged`.
    opts.labelId ? h('span', { id: opts.labelId, text: label }) : label,
  );
  if (!opts.at) return el;
  return h('span', { class: 'pill-row' }, el, h('span', { class: 'pill-at', text: ago(opts.at) }));
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

/**
 * A device drawn small — a card, a table row, a picker, a palette result.
 *
 * THE SAME COMPONENT AS THE COCKPIT, at a different width. That is the point of stage 3 rather than
 * a nicety: a device is recognisable by its SHAPE before its name is read, and a shape is only
 * recognisable if it is the same shape everywhere. A 720×1280 device is visibly stubbier than a
 * 1080×2340 one at 24px, so somebody scanning a fleet list can see which panel they are about to
 * get without reading a geometry string.
 *
 * `tiny` drops the cast shadow, the contact ellipse and the rails. Below about 56px those are three
 * pixels of grey that make a row look dirty rather than deep — the aspect and the corner radius
 * still carry every bit of the information.
 */
function deviceThumb(device, height = 44) {
  const el = staticFrame(device, height);
  if (height <= 64) el.dataset.scale = 'tiny';
  return el;
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
function toast(title, body, kind = '', opts = {}) {
  const box = $('toasts');

  /**
   * `key` REPLACES rather than stacks.
   *
   * Without it, a condition that re-reports — the API being unreachable, which is re-checked every
   * five seconds — produces a column of identical toasts, and the third one pushes the first out of
   * a box that holds three. A keyed toast is one toast whose body is rewritten in place, which is
   * also what lets it be REMOVED when the condition clears.
   */
  if (opts.key) box.querySelector(`[data-toast-key="${opts.key}"]`)?.remove();
  while (box.children.length >= 3) box.firstElementChild.remove();

  const el = h('div', { class: `toast ${kind}`.trim() },
    h('p', { class: 't-title', text: title }),
    body ? h('p', { class: 't-body', text: body }) : null,
  );
  if (opts.key) el.dataset.toastKey = opts.key;

  /**
   * SUCCESS AUTO-DISMISSES; A WARNING OR AN ERROR STAYS.
   *
   * A toast that says something went well has done its whole job in four seconds. A toast that says
   * something is wrong has not: it is describing a condition that is still true, and taking it away
   * on a timer leaves the reader looking at a page that appears fine. So the failing kinds get a
   * dismiss control instead of a timer, and the caller can take them down when the condition
   * actually resolves.
   */
  if (kind === 'warn' || kind === 'bad') {
    el.append(h('button', {
      class: 'toast-x', type: 'button', title: 'Dismiss',
      onclick: () => el.remove(),
    }, icon('x', 14)));
  } else {
    setTimeout(() => el.remove(), 4200);
  }
  box.append(el);
  return el;
}

/** Take down a keyed toast, if it is up. Used when the condition it describes has cleared. */
function clearToast(key) {
  $('toasts').querySelector(`[data-toast-key="${key}"]`)?.remove();
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
/**
 * One device's quarantine history.
 *
 * Fetched on navigation rather than folded into the 5s poll, exactly like `loadRunDetail`: this is
 * an append-only log that changes when a person does something, and re-fetching it for every device
 * anyone has ever opened would grow the poll for no new information. The stale check guards a
 * person clicking through several devices quickly.
 */
async function loadQuarantineLog(id) {
  if (state.quarantineLog?.id !== id) state.quarantineLog = { id, events: [], loaded: false };
  try {
    const out = await api(`/v1/devices/${encodeURIComponent(id)}/quarantine-log`);
    if (state.quarantineLog?.id !== id) return;
    state.quarantineLog = { id, events: out.events || [], loaded: true };
  } catch {
    // Loaded with nothing rather than left spinning. The card says "no history" and the device's
    // own state — which the poll already has — is still on screen; a failed audit read must not
    // hide the quarantine reason next to it.
    if (state.quarantineLog?.id === id) state.quarantineLog = { id, events: [], loaded: true };
  }
}

/**
 * One device, read from the endpoint that knows the most about it.
 *
 * Same shape and same reasoning as `loadQuarantineLog` above, including the stale check: a person
 * clicking through three quarantined devices must not have the first one's answer land on the
 * third one's screen.
 */
async function loadDevice(id) {
  if (state.deviceDetail?.id !== id) state.deviceDetail = { id, device: null, loaded: false };
  try {
    const out = await api(`/v1/devices/${encodeURIComponent(id)}`);
    if (state.deviceDetail?.id !== id) return;
    state.deviceDetail = { id, device: out.device || null, loaded: true };
  } catch {
    // Loaded with nothing, and the screen falls back to the poll's row. A failed detail read costs
    // the four fields only this endpoint carries; it must not blank a page that can already say
    // what the device is and why it is out of the pool.
    if (state.deviceDetail?.id === id) state.deviceDetail = { id, device: null, loaded: true };
  }
}

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
  // When the data on screen was last known to be true. The API-loss toast reads it to say how
  // stale the page is, which is the only thing that makes "the connection is down" actionable.
  state.lastGoodAt = Date.now();
}

/* ---------------------------------------------------------------------------- router */

const ROUTES = new Set(['fleet', 'devices', 'apps', 'sessions', 'runs', 'queue', 'health', 'launch', 'agents', 'team', 'settings']);

/**
 * THE OLD ROUTES ARE NOT DELETED, THEY ARE LENSES.
 *
 * `#/devices`, `#/sessions` and `#/queue` were three pages answering one question, and the Fleet
 * surface merges them — but a bookmark, a `G` shortcut, a link in somebody's runbook and eight
 * months of muscle memory all still point at the old names. Each lands on the lens that used to be
 * that page, so nothing a current user knows stops working. That is also why the lens lives in the
 * URL rather than in component state: a lens you cannot link to is a tab, not a route.
 *
 * `#/devices/<id>` is untouched. Device detail is a different job — the operator's page — and it
 * was never one of the three.
 */
const LENS_FOR_ROUTE = { devices: 'capacity', sessions: 'live', queue: 'waiting' };

/**
 * A hash to a route. EXPORTED AND TAKES ITS INPUT, rather than reading `location` — the redirect
 * table below is the promise that makes merging three routes into one safe for anybody with a
 * bookmark, and a promise nothing can test is a promise somebody tidies away.
 */
export function parseHash(hash = location.hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const [name, id] = raw.split('/');
  if (name === 'devices' && id) return { name: 'device', id };
  if (name === 'sessions' && id) return { name: 'cockpit', id };
  // `#/fleet/<lens>`; a bare `#/fleet` is capacity.
  if (name === 'fleet') return { name: 'fleet', id: null, lens: LENSES.some(([k]) => k === id) ? id : 'capacity' };
  // The three merged routes, each arriving on the lens it used to be.
  if (LENS_FOR_ROUTE[name] && !id) return { name: 'fleet', id: null, lens: LENS_FOR_ROUTE[name] };
  // `#/runs/<id>` takes either half of a run's identity — the uuid, or the name the suite gave it.
  // The API resolves both, so a person can paste a CI build number straight into the URL.
  if (name === 'runs' && id) return { name: 'run', id: decodeURIComponent(id) };
  // `#/launch` picks; `#/launch/<sessionId>` watches one come up. The session id is in the URL so
  // that a reload mid-bring-up rejoins the same session rather than allocating a second device.
  if (name === 'launch' && id) return { name: 'launching', id };
  return { name: ROUTES.has(name) ? name : 'fleet', id: null, lens: 'capacity' };
}

/**
 * Set the route AND the lens it implies, together.
 *
 * Two call sites parse the hash — `boot()` on a cold load and the `hashchange` listener afterwards
 * — and `hashchange` does not fire on load. Assigning them separately meant a cold load of
 * `#/fleet/catalogue` rendered capacity, because only one of the two places knew about the lens.
 * One function, so they cannot drift.
 */
function setRoute() {
  state.route = parseHash();
  state.lens = state.route.lens || null;
  return state.route;
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

/**
 * THE FETCHES A ROUTE NEEDS BEFORE IT CAN DRAW ITSELF.
 *
 * ONE FUNCTION, because there are two callers — `boot()` on a cold load and the `hashchange`
 * listener afterwards — and `hashchange` DOES NOT FIRE ON LOAD. Keeping the list in both places
 * means a route added to one and not the other works when you click to it and is empty when you
 * open its URL, which is the half nobody exercises by hand.
 *
 * That is not hypothetical: `device` was in the listener and missing from `boot`, so the device
 * screen's quarantine history said "Loading…" forever for anybody who opened a device link, hit
 * refresh, or came back to a bookmark — every path except clicking through from the Fleet. It
 * shipped that way and no test could see it, because the console tests render a screen from state
 * they seeded themselves and never ask who was supposed to fill it.
 *
 * Returns a promise, so a caller can await it before the first paint (a cold load, where the
 * alternative is a flash of empty state) or let it land on a later render (a navigation, where the
 * screen already has the poll's data to draw).
 *
 * EXPORTED so a test can assert what a route asks for. The defect this replaces was not a wrong
 * request — it was an ABSENT one, and no assertion about a rendered screen can see that: the tests
 * seed the state a screen draws from, which is exactly the work this function does.
 */
export function loadForRoute() {
  const { name, id } = state.route;
  if (name === 'cockpit') return loadSessionDetail(id);
  if (name === 'run') return loadRunDetail(id);
  // Two reads for one screen, deliberately: the device row and its audit log are different
  // endpoints with different lifetimes, and the screen renders correctly with either one missing.
  if (name === 'device') return Promise.all([loadDevice(id), loadQuarantineLog(id)]);
  return Promise.resolve();
}

window.addEventListener('hashchange', () => {
  const previous = state.route;
  setRoute();
  state.action = null;
  closeOverlays();
  // Leaving the cockpit — or opening a DIFFERENT session's cockpit — closes the socket and the peer
  // connection. Without this a person who clicks through three sessions is relaying three video
  // streams, and on the TURN path that is billed egress for two screens nobody is looking at.
  if (previous.name === 'cockpit' && (state.route.name !== 'cockpit' || state.route.id !== previous.id)) {
    closeLive();
  }
  render();
  loadForRoute().then(render);
  if (state.route.name === 'launching') watchBringup(state.route.id);
});

for (const item of document.querySelectorAll('.navitem')) {
  item.addEventListener('click', () => go(`#/${item.dataset.route}`));
}

/* ---------------------------------------------------------------------------- chrome render */

/**
 * Fill every `data-icon` slot in the static markup with its Lucide glyph.
 *
 * ONCE, AT BOOT, not on every render. These nodes are in `index.html` rather than built by `h()`,
 * so they survive every re-render — which means painting them repeatedly would be pure allocation
 * for a tree that never changes. `renderChrome` runs on every poll; this does not.
 *
 * The markup names the icon and this draws it, rather than the HTML carrying ten inline `<svg>`
 * blocks. That is not a style preference: an external sprite referenced by `<use>` is a fetch, and
 * this console's CSP is `default-src 'none'`.
 */
function paintNavIcons() {
  for (const slot of document.querySelectorAll('[data-icon]')) {
    slot.replaceChildren(icon(slot.dataset.icon, Number(slot.dataset.iconSize) || 16));
  }
}

function renderChrome() {
  const held = heldSession();

  /**
   * THE MOST-READ ELEMENT IN THE CONSOLE, and it used to be written in the shortest possible form
   * rather than the clearest: `4/4 ready · Queue 0 · Holding fake-2`.
   *
   * Three problems, one per segment. `4/4` is a fraction with no units, so it is only legible to
   * somebody who already knows what is being counted. `Queue 0` makes the reader translate a zero
   * into "nobody is waiting" every time they glance at it, which is the work a label is supposed
   * to do for them. And `fake-2` is a host-local id — the name of a slot on a machine, not the
   * name of the device somebody is holding.
   */
  $('fs-devices').textContent = `${state.available} of ${state.devices.length}`;
  $('fs-dot').className = `dot ${state.available > 0 ? 'ok' : 'warn'} live`;

  const waiting = queuedSessions().length;
  $('fs-queue').textContent = waiting === 0 ? 'nobody waiting'
    : waiting === 1 ? '1 waiting'
      : `${waiting} waiting`;

  // The one place that already resolved the name correctly, now through the shared helper so it
  // cannot drift from the six that did not.
  $('fs-held').textContent = held ? deviceLabel(held) : 'nothing';
  $('fs-holding').hidden = !held;

  // Nav highlight. The two detail routes keep their parent lit rather than lighting nothing.
  // Detail routes light their parent rather than lighting nothing. `device` and `cockpit` both
  // belong to Fleet now, because the three pages they came from are lenses on it.
  const parent = { device: 'fleet', cockpit: 'fleet', run: 'runs', launching: 'launch' }[state.route.name] || state.route.name;
  for (const item of document.querySelectorAll('.navitem')) {
    item.classList.toggle('is-active', item.dataset.route === parent);
  }

  // The sidebar session card, and its collapsed 38px stand-in.
  const sideCard = $('sessioncard');
  const stub = $('sessionstub');
  sideCard.hidden = !held;
  stub.hidden = !held;
  if (held) {
    $('sc-device').textContent = deviceLabel(held);
    const l = lease(state.held?.id === held.id ? state.held : null);
    const text = l ? `lease ${clock(l.ms)} left` : `${(SESSION_STATE[held.state]?.label || held.state).toLowerCase()}`;
    $('sc-lease').textContent = text;
    stub.title = `${deviceLabel(held)} · ${text}`;
  }
}

$('sc-open').addEventListener('click', () => { const s = heldSession(); if (s) go(`#/sessions/${s.id}`); });
$('sessionstub').addEventListener('click', () => { const s = heldSession(); if (s) go(`#/sessions/${s.id}`); });
$('farmstat').addEventListener('click', () => go('#/health'));

$('navtoggle').addEventListener('click', () => {
  const icons = root.dataset.nav === 'icons';
  root.dataset.nav = icons ? 'labels' : 'icons';
  try { localStorage.setItem('mf-nav', root.dataset.nav); } catch { /* private mode; not important */ }
  setNavToggleIcon(root.dataset.nav === 'icons');
});

/* ============================================================ appearance (document 01, stage 8) ==
 *
 * THREE STATES, NOT TWO. "Dark" and "light" are choices; "system" is the ABSENCE of one, and it is
 * the only one that can keep following an OS that changes at sunset. A two-way toggle silently
 * converts "I have not decided" into a decision on first click and there is then no way back —
 * which is the thing people notice a week later and cannot explain.
 *
 * The stored value is the CHOICE, never the resolved theme. Persisting "dark" for somebody on
 * system-dark would freeze them there when their OS flips.
 */
const THEMES = ['system', 'dark', 'light'];

function themeChoice() {
  try {
    const v = localStorage.getItem('mf-theme');
    return THEMES.includes(v) ? v : 'system';
  } catch {
    // A browser with site data blocked THROWS on read rather than returning null, and the console
    // must still render for that viewer — they simply get the OS's answer every time.
    return 'system';
  }
}

/** Resolve a choice against the OS, and write it where CSS can see it. */
function applyTheme(choice) {
  const dark = choice === 'dark'
    || (choice === 'system' && !window.matchMedia?.('(prefers-color-scheme: light)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
}

function setTheme(choice) {
  try { localStorage.setItem('mf-theme', choice); } catch { /* private mode; the OS still decides */ }
  applyTheme(choice);
  render();
}

/**
 * FOLLOW THE OS WHILE "SYSTEM" IS THE CHOICE, and stop the moment it is not.
 *
 * Without this the console picks the OS theme once at boot and then ignores it, so a desk that
 * goes dark at sunset leaves a bright console open until the next reload — the one moment the
 * setting exists for.
 */
window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  if (themeChoice() === 'system') applyTheme('system');
});

/**
 * The collapse chevron, which points the way the rail will go.
 *
 * A helper rather than two call sites, because the OTHER call site runs before first paint from a
 * restored preference — and the two used to disagree: the boot path wrote a raw `»` character into
 * the span while the click path wrote `«`, so a console restored into the collapsed state showed
 * the toggle for expanding it drawn as the toggle for collapsing it.
 */
function setNavToggleIcon(collapsed) {
  const slot = $('navtoggle').querySelector('[data-icon]');
  if (!slot) return;
  slot.dataset.icon = collapsed ? 'expand' : 'collapse';
  slot.replaceChildren(icon(slot.dataset.icon, 16));
}

/* ---------------------------------------------------------------------------- page header */

/**
 * `subNode` is for a subtitle that has to be MARKED UP rather than said flatly — the Fleet's
 * headline sets its waiting clause apart, because the half that changes what you do next should not
 * read like the half that does not. Every other screen passes a plain `sub` and gets a plain
 * paragraph; a screen may pass one or the other, never both.
 */
function pageHead(crumbs, title, sub, actions, subNode) {
  return h('div', null,
    crumbs?.length ? h('p', { class: 'crumb' }, crumbs.map((c, i) => [
      i ? ' / ' : null,
      c.to ? h('button', { type: 'button', text: c.label, onclick: () => go(c.to) }) : c.label,
    ])) : null,
    h('div', { class: 'page-head' },
      h('h1', { class: 'page-title', text: title }),
      subNode || (sub ? h('p', { class: 'page-sub', text: sub }) : null),
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
/**
 * Start a session on the class of device the button names.
 *
 * `matchProfile` IS WHAT MAKES THE LABEL TRUE. Until migration 037 this sent region, platform and
 * tier and nothing else, while the button said "Start MFARM X1 Pro" — and the allocator has never
 * matched on profile, so on a farm whose devices share a tier that button could hand you an X1, or
 * an unprofiled 720x1280 device, and say nothing about it. The old label named the tier and was at
 * least accurate; naming the device without constraining the allocation was a promise the control
 * plane could not keep.
 *
 * `d.profile` is UNDEFINED for an unprofiled device, and `?? null` is load-bearing rather than
 * defensive: with `matchProfile` true, null means "one of the devices that have no profile", which
 * is exactly what "Start Unprofiled device" is offering. Sending nothing there would allocate any
 * device on the tier and quietly break the same promise in the one case that looks hardest to
 * notice.
 */
/**
 * Start a session on a device class, optionally with a build already chosen.
 *
 * THE BUILD IS THE SECOND ARGUMENT, and adding it is D3. Preinstall existed only behind `#/launch`
 * — so a person standing on the Fleet, looking at the device they want, had to leave the surface
 * where they were choosing, re-choose the same class from a picker, and only then name a build.
 * The capability was one route away from every place anyone actually decides.
 *
 * `requireCapabilities` is asked for ONLY when a build is coming, and that is the same rule
 * `startLaunch` follows: demanding `app-install` unconditionally would make a device that can
 * stream but not sideload unschedulable for somebody who only wants to look at it.
 */
async function startSession(d, { appId = null, launchAfter = false } = {}) {
  try {
    const { session } = await api('/v1/sessions', {
      method: 'POST',
      body: {
        region: d.region,
        platform: d.platform,
        tier: d.tier,
        profile: d.profile ?? null,
        matchProfile: true,
        ...(appId ? { requireCapabilities: ['app-install'] } : {}),
      },
    });
    // 202 with no device is a real answer, not a failure: the session is queued and the reaper
    // promotes it when one frees up. Said differently so nobody reads "queued" as "ready".
    if (session.deviceId) {
      toast('Session started', `${short(session.id)} on ${short(session.deviceId)} · ${String(session.state).toLowerCase()}`, 'ok');
    } else {
      toast('Queued for a device',
        `${capacityText(state.devices, d)} — so you are in line. It starts automatically when one frees up.`,
        'warn');
    }
    /**
     * THE BRING-UP STATE IS SET BEFORE NAVIGATING, not after, because `watchBringup` treats a
     * missing `state.bringup` as "somebody followed a link to a session already in flight" and
     * rejoins it with `appId: null`. Setting it afterwards would race that rejoin and silently drop
     * the build on exactly the fast path this was added for.
     */
    state.bringup = {
      sessionId: session.id,
      appId,
      launchAfter: Boolean(appId) && launchAfter,
      install: null,
      launch: null,
      error: null,
      startedAt: Date.now(),
    };

    await Promise.all([refreshDevices(), refreshSessions()]);
    await refreshHeld(true);
    render();

    /**
     * THE BRING-UP SCREEN, ALWAYS — not the cockpit.
     *
     * This jumped straight to `#/sessions/<id>` whenever the allocator came back with a device, and
     * that is most of the time on a farm whose devices are already booted. The consequence, found by
     * watching a real Start on the lab: the six-beat choreography played only when a request QUEUED
     * or when somebody used `#/launch`. On a warm farm nobody ever saw the device arrive — the
     * animation was correct and unseen.
     *
     * A QUEUED SESSION LANDS HERE TOO, and always did. That is the same screen doing the same job:
     * beat 0 is the unresolved frame, and it firms up when the allocator hands one over.
     *
     * IT IS NOT A DELAY. `watchBringup` moves to the cockpit the moment the last beat lands, so on
     * an instant allocation this is a second or two of watching a device resolve out of blur, wake,
     * and take on depth — which is the thing the sequence is for. On a cold device or a handset it
     * is the difference between a progress screen and a blank one.
     */
    go(`#/launch/${session.id}`);
  } catch (err) {
    toast('Could not start a session', err.message, 'bad');
  }
}

/**
 * "Start with a build" — D3, offered where a person is CHOOSING a device.
 *
 * A DIALOG RATHER THAN A SECOND PICKER SCREEN. `#/launch` asks two questions in sequence: which
 * class, then which build. On the Fleet the first question is already answered — the reader is
 * looking at the device — so the only thing left to ask is the second one, and a full screen to ask
 * it would send somebody away from the surface that already had what they wanted.
 *
 * OFFERED ONLY WHERE IT CAN WORK, which is the rule this console keeps relearning: no builds in the
 * library means no dialog, because a picker with nothing in it is a control on a false premise. The
 * caller checks `state.apps.length` before drawing the button at all.
 *
 * IT IS NOT THE ROW'S SECOND ROUTE TO ONE PLACE. D5 removed a `Details` button that went where the
 * device's name already went; this is a different ACTION, not a duplicate destination, and the two
 * are only superficially "a second control on the row".
 */
function startWithBuild(d) {
  const apps = state.apps;
  if (!apps.length) return;

  const pick = h('select', { class: 'field' }, apps.map((a) => h('option', {
    value: a.id,
    selected: state.launch.appId === a.id,
    text: `${a.label || a.packageName} ${a.versionName || ''}`.trim(),
  })));
  const after = h('input', { type: 'checkbox', checked: state.launch.launchAfterInstall });

  formDialog({
    title: `Start ${deviceName(d)} with a build`,
    lead: 'The farm allocates the device, then the build is queued for the worker’s next heartbeat. You will watch both on the bring-up screen.',
    fields: [
      h('label', { class: 'stack tight' }, h('span', { class: 'micro', text: 'Build' }), pick),
      h('label', { class: 'row tight' }, after,
        h('span', { class: 'secondary', text: 'Open it once the worker confirms the install' })),
      /**
       * SAID BEFORE IT HAPPENS, not discovered afterwards. Asking for a build narrows the
       * allocation to devices declaring `app-install`, so a farm whose only free device cannot
       * sideload will queue this request where a plain Start would have handed a device over.
       */
      h('p', { class: 'caption', text: 'A build needs a device that declares app-install, so this asks for a narrower device than Start alone. If none is free you will be queued.' }),
    ],
    submit: 'Start with this build',
    onSubmit: async () => {
      // Remembered for the next one: the launch screen reads the same two values, and somebody
      // installing the same build twice should not re-pick it twice.
      state.launch.appId = pick.value;
      state.launch.launchAfterInstall = after.checked;
      await startSession(d, { appId: pick.value, launchAfter: after.checked });
    },
  });
}

/**
 * Release, behind a dialog.
 *
 * The second step is a real guard, not ceremony: releasing snapshot-restores the device, so this is
 * the button that deletes the build someone just installed, and the word "release" does not say so.
 */
function askRelease(sess) {
  const name = deviceLabel(sess);
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
  /**
   * D24 — AND THE DETAIL, or the cockpit repaints the session you just ended as a live one.
   *
   * `screenCockpit` prefers `state.detail` over the polled row, and nothing here refreshed it. So
   * the confirm ran, the toast said the device was restoring, and `render()` below faithfully
   * redrew a live session with fourteen enabled controls — Power, Home, Screenshot, Install —
   * aimed at a device being wiped. The poll corrected it only once the detail passed its 10s
   * staleness threshold: measured on the farm as `mode=session` at t+2s and t+7s, `mode=ended` at
   * t+12s.
   *
   * Awaited before the render rather than fired alongside it: the whole defect was a render that
   * happened with data it had not waited for.
   */
  if (state.detail?.id === sessionId) await loadSessionDetail(sessionId);
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
    toast(`${KIND_LABEL[kind]} completed`, `${app.packageName} ${app.versionName || ''} · ${deviceLabel(held)}`.replace(/\s+/g, ' '), 'ok');
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
        // The device, at 34px. Its shape is the fastest thing on this card to read.
        deviceThumb(d, 46),
        h('span', { class: 'stack none' },
          h('span', { class: 'card-title', text: deviceName(d) }),
          h('code', { class: 'caption', text: short(d.id) }),
        ),
      ),
      pill(st.label, st.tone, { live: d.state === 'READY' }),
    ),

    /**
     * REAL or VIRTUAL, said outright rather than left to be inferred from the tier (spec §25).
     *
     * `cuttlefish` means nothing to someone who did not build this, and the difference is the one
     * thing about a device a tester most needs to know before trusting a result — a render bug that
     * reproduces on a handset and not on an emulator is the whole reason the real one is there.
     * The tier stays visible below; this is the word for it, not a replacement.
     */
    h('div', { class: 'row tight' },
      h('span', {
        class: `kindtag ${deviceKindOf(d)}`,
        title: isRealDevice(d)
          ? 'A physical handset on an agent host. Pinned to your organisation — it is never shared.'
          : 'A virtual device. Reset to a clean snapshot between tenants.',
        text: isRealDevice(d) ? 'REAL DEVICE' : 'VIRTUAL DEVICE',
      }),
    ),

    // Dot + word + context. Never the dot alone.
    //
    // A QUARANTINED device says why IT is quarantined, not what the state generally means. The
    // generic line was "Failed health checks; never scheduled" for every one of them, including the
    // handset whose host had simply stopped beating — a sentence that sends somebody to the lab to
    // look at a phone that is fine. Same rule as the Launch screen's "busy" fix: two screens must
    // not describe one device differently, and neither may describe it wrongly.
    h('p', { class: 'help row tight' }, h('span', { class: `dot ${st.tone}` }),
      d.quarantine?.reason || d.recovery?.fromReason || st.note),

    h('div', { class: 'device-meta' },
      // Screen joins the four facts that were always here, and it is the one a tester reads first:
      // a result is only meaningful if you know what panel it was taken on. Omitted entirely rather
      // than shown as "—" when the worker sent no geometry — see `geometryText`.
      [['Platform', d.platform], ['OS', d.osVersion], ['Tier', d.tier], ['Region', d.region],
        ...(geometryText(d) ? [['Screen', geometryText(d)]] : [])].map(([k, v]) =>
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
        ? btn(`Start ${deviceName(d)}`, 'primary', () => startSession(d))
        : null,
      btn('Details', 'ghost', () => go(`#/devices/${d.id}`)),
    ),

    /**
     * WHAT PRESSING THAT BUTTON ACTUALLY DOES, in the reader's terms.
     *
     * The sentence this replaces — "the allocator picks a ready device on this tier; it cannot be
     * pinned to one" — is accurate and answers a question nobody asked. It names a component
     * ("the allocator"), an internal grouping ("tier") and a capability the reader never expected
     * to have ("pinned"), and it leaves out the one consequence they will actually meet: that
     * pressing this when nothing is free puts them in a queue.
     *
     * Allocation is CLASS-ONLY and that fact stays — it is just stated as what will happen to you
     * rather than as what the system is.
     */
    d.state === 'READY' && !mine
      ? h('p', { class: 'caption', text: `The farm picks a free ${deviceName(d)}. If none is free when you press this, you will be queued.` })
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
          /**
           * NO ESTIMATE — and the REASON changed, so the sentence had to.
           *
           * This used to say the API does not report other sessions' lease times. It does now:
           * `GET /v1/sessions` returns `expiresAt` (entry 51). The absence is no longer a missing
           * field, it is that the soonest expiry is only an UPPER BOUND on the wait — a holder can
           * release early, and a queued session ahead of you takes the device first. Same answer,
           * and a reason that is still true, which is the difference between a decision and a
           * leftover. `fleetHeadline` carries the same reasoning; the two must not drift.
           */
          h('p', { class: 'caption', text: 'A queued session starts automatically when a device frees up. There is no estimate here because the soonest lease to expire is only an upper bound — a holder can release early, and anyone ahead of you takes the device first.' }),
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

/* ============================================================================ the fleet =======
 *
 * ONE SURFACE, FOUR LENSES — direction B in document 03, chosen 2026-09-04.
 *
 * Devices, Sessions and Queue were three routes answering one question: CAN I GET A DEVICE RIGHT
 * NOW, AND IF NOT, WHY NOT. The free count was on Devices, the wait was on Queue, and who was
 * holding what was on Sessions — so the engineer arriving mid-incident had to visit three pages and
 * assemble the answer themselves. They also all read the same allocator state, which meant three
 * places to keep consistent and three chances to disagree on a refresh.
 *
 * The lens is a VIEW, not a filter: one data source, one poll, four questions.
 *
 *   capacity   everything, ordered by whether you can have it. The default, because it is the
 *              question that brought you here.
 *   catalogue  the same fleet as products — for choosing a screen size, and for a buyer.
 *   live       the sessions that hold a device right now.
 *   waiting    the queue, with positions.
 *
 * LAUNCH IS NOT A LENS AND NOT A ROUTE. Launching is something you DO, and it always begins from a
 * device you are already looking at — so Start lives on every row instead. That is also what makes
 * the substitution problem addressable at all: on one surface the thing you clicked and the thing
 * you got are the same object, and the console can say so when they differ.
 */

const LENSES = [
  ['capacity', 'Capacity'],
  ['catalogue', 'Catalogue'],
  ['live', 'Live'],
  ['waiting', 'Waiting'],
];

/**
 * The one line at the top that answers the arriving engineer.
 *
 * It states the WORST TRUE THING first — fully booked before free counts — because somebody who
 * cannot get a device needs to know that before they read anything else, and somebody who can will
 * find out by the button being there.
 */
/**
 * WHEN THE NEXT DEVICE IS GUARANTEED FREE — D4, and the whole difference is the word "guaranteed".
 *
 * Document 03 wants "the next X1 Pro frees in about 12 minutes" and its own CONFIRM note says the
 * line "needs lease-expiry-derived ETA". The data is there — every live session carries `expiresAt`
 * — and the reason this stayed unbuilt is that the soonest expiry is an UPPER BOUND on two counts:
 * a holder can release early, and a queued session ahead of you takes the device first.
 *
 * Both objections are about "about". Neither touches the statement the bound actually supports:
 * this device WILL be free by then, because the reaper enforces the lease. So the sentence says
 * "in at most 12 minutes" rather than "in about 12 minutes" — a fact instead of an estimate, and
 * the reader can tell the difference between a promise and a guess.
 *
 * IT IS ABOUT THE DEVICE, NOT ABOUT YOUR WAIT, which is the design's framing too. Saying "you get
 * one in 12 minutes" would be false with anybody ahead of you; saying when the device frees is true
 * whoever ends up with it, and the queue length is stated one clause earlier.
 */
function nextGuaranteedFree() {
  const now = Date.now();
  let best = null;
  for (const s of state.sessions) {
    if (!LIVE_SESSION_STATES.has(s.state) || !s.deviceId || !s.expiresAt) continue;
    const at = new Date(s.expiresAt).getTime();
    // A lease already past its expiry is one the reaper has not swept yet. Rendering it as "in 0
    // seconds" would put a countdown on the page that has already finished.
    if (!Number.isFinite(at) || at <= now) continue;
    if (!best || at < best.at) best = { at, deviceId: s.deviceId };
  }
  if (!best) return null;
  const device = deviceById(best.deviceId);
  return {
    name: device ? deviceName(device) : 'device',
    inWords: lengthInWords(new Date(now).toISOString(), new Date(best.at).toISOString()),
  };
}

function fleetHeadline() {
  const free = state.devices.filter((d) => d.state === 'READY').length;
  const waiting = queuedSessions().length;
  const held = state.sessions.filter((x) => LIVE_SESSION_STATES.has(x.state) && x.deviceId).length;

  if (!state.devices.length) {
    return { capacity: 'No devices are registered. Start a worker and one appears within a heartbeat.', queue: '', waiting: 0 };
  }

  const capacity = free === 0
    ? 'Every device is in use.'
    : `${free} of ${state.devices.length} device${state.devices.length === 1 ? '' : 's'} free.`;

  /**
   * THE ETA, ONLY WHERE IT ANSWERS SOMETHING. With a device free the question is not "when" — it is
   * already "now" — so the bound is computed for a full farm and for nothing else.
   */
  const eta = free === 0 ? nextGuaranteedFree() : null;
  const frees = eta
    ? `the next ${eta.name} frees in at most ${eta.inWords}.`
    // The design's own fallback, for a farm whose held sessions carry no lease to derive from.
    : 'the farm hands over the moment a lease ends.';

  const queue = waiting === 0
    // Worth saying on a full farm: "nobody is waiting" plus a bound is the difference between
    // "come back later" and a number somebody can decide on.
    ? (held ? (eta ? `Nobody is waiting — ${frees}` : 'Nobody is waiting.') : '')
    : `${waiting === 1 ? 'One person is' : `${waiting} people are`} waiting — ${frees}`;

  return { capacity, queue, waiting };
}

/** `you`, a colleague's email, a CI run, or nothing — in that order of usefulness. */
function holderOf(sess) {
  if (!sess) return null;
  const mine = state.me?.user?.email;
  if (sess.holder && mine && sess.holder === mine) return 'you';
  if (sess.holder) return sess.holder;
  // An API key opened it. The run id is the only handle its owner would recognise.
  if (sess.run?.runId) return `CI run ${sess.run.runId}`;
  return null;
}

/** The live session holding this device, if any. */
function sessionHolding(deviceId) {
  return state.sessions.find((x) => x.deviceId === deviceId && LIVE_SESSION_STATES.has(x.state)) || null;
}

/**
 * CAPACITY — everything, ordered by whether you can have it.
 *
 * Free first, then in use (they come back on their own), then out of the pool (they do not). That
 * ordering IS the answer to the page's question, so it is not configurable and there is no sort
 * control: a table you have to sort before it tells you anything has not told you anything.
 */
/**
 * "THE ONLY FREE DEVICE IS NOT THE ONE YOU WANTED" — document 03's substitution notice.
 *
 * The one moment the Fleet surface exists to make honest, and the last piece of it to be built. It
 * fires on a narrow, checkable condition:
 *
 *   1. something IS free, so there is a real choice to describe;
 *   2. the class you have been working on is NOT free;
 *   3. the free device is a different SHAPE, not merely a different name.
 *
 * THE THIRD CLAUSE IS THE ONE THAT MATTERS. Two classes with the same geometry are interchangeable
 * for the thing this warns about — a layout that will not match — so warning about them would be
 * noise, and noise here trains people to dismiss the notice that is real (ADR-0016: geometry is why
 * somebody picked a device).
 *
 * WHAT "THE ONE YOU WANTED" MEANS, precisely: the class of the most recent session this org
 * opened. Not a preference anybody typed — inferring intent from a stored setting nobody set would
 * be worse than saying nothing. If the org has never run a session there is no expectation to
 * violate, and this returns null.
 *
 * NO ETA, for the reason `fleetHeadline` and the queue card both give. The design's mockup reads
 * "in about 12 minutes"; its own CONFIRM note says that line needs lease-expiry-derived ETA and
 * that "without it the copy becomes 'next free when a lease ends'". We do not have it, so it does.
 */
function substitutionNotice() {
  const free = state.devices.filter((d) => d.state === 'READY');
  if (!free.length) return null;

  // The class most recently worked on, from the newest session that named a device.
  const recent = state.sessions.find((x) => x.deviceId);
  const wanted = recent ? deviceById(recent.deviceId) : null;
  if (!wanted) return null;

  const wantedClass = deviceClass(wanted);
  if (free.some((d) => deviceClass(d) === wantedClass)) return null;

  // A different NAME is not a warning; a different SHAPE is.
  const sameShape = (a, b) => a?.screen?.width === b?.screen?.width
    && a?.screen?.height === b?.screen?.height;
  const different = free.filter((d) => !sameShape(d, wanted));
  if (!different.length) return null;

  const alt = different[0];
  const shape = geometryText(alt) ? `a ${alt.screen.width} \u00d7 ${alt.screen.height} screen` : 'a different screen';

  return h('section', { class: 'card gate waiting mt-gap' },
    h('p', { class: 'card-title', text: 'The only free device is not the one you wanted' }),
    h('p', { class: 'help' },
      `${deviceName(alt)} has ${shape} \u2014 a different shape from the ${deviceName(wanted)} you `
      + 'have been testing on. Starting it is fine, but layout will not match.'),
    h('div', { class: 'row tight mt-lg' },
      btn(`Queue for ${deviceName(wanted)}`, 'primary', () => startSession(wanted)),
      btn(`Start ${deviceName(alt)} anyway`, 'ghost', () => startSession(alt))),
    h('p', { class: 'caption mt-md', text:
      'Queueing hands you the class you asked for the moment a lease ends \u2014 there is no estimate '
      + 'here, because the soonest expiry is only an upper bound.' }),
  );
}

function fleetCapacity() {
  const rank = (d) => (d.state === 'READY' ? 0 : BUSY_STATES.has(d.state) ? 1 : 2);
  const rows = [...state.devices].sort((a, b) =>
    rank(a) - rank(b) || deviceName(a).localeCompare(deviceName(b)));

  if (!rows.length) {
    return card(null, {}, empty('No devices are registered in this region yet.',
      'Start a worker and it appears here within a heartbeat.'));
  }

  /**
   * D17 — WHICH OF THE TWO IS THIS?
   *
   * Two unprofiled Cuttlefish devices are genuinely interchangeable to the allocator and render as
   * two identical rows: same name, same geometry, same everything the farm knows. That is honest —
   * they ARE two devices of one kind — but a person looking at a row and asking "is this the one I
   * quarantined" had nothing to answer with except eight characters of id set in caption grey,
   * sized and coloured to be ignored.
   *
   * NOTHING IS INVENTED HERE. There is no second fact to show: no serial, no instance number, no
   * host (ADR-0026 keeps that off tenant surfaces deliberately). The id IS the distinguishing fact,
   * so the fix is to stop styling it as an afterthought on the rows where it is doing the work —
   * and to say why it matters, in a title, on exactly those rows. A device whose name is unique
   * keeps the quiet caption, because there the id is genuinely incidental.
   */
  const twins = new Map();
  for (const d of rows) twins.set(deviceName(d), (twins.get(deviceName(d)) || 0) + 1);

  return card(null, { class: 'flat' }, h('table', { class: 'table fleet-table' },
    h('thead', null, h('tr', null,
      h('th', { text: 'Device' }),
      h('th', { text: 'Screen' }),
      h('th', { text: 'State' }),
      h('th', { text: 'Holder' }),
      h('th', { class: 'right', text: '' }),
    )),
    h('tbody', null, rows.map((d) => {
      const st = DEVICE_STATE[d.state] || { label: d.state, tone: '', note: '' };
      const sess = sessionHolding(d.id);
      const who = holderOf(sess);
      const mine = sess && heldSession()?.id === sess.id;

      return h('tr', null,
        /**
         * NAME, ID — AND THE FRAME, which I removed once and was wrong to.
         *
         * Entry 51 took the thumbnail out of this table with a reason that was true about the
         * SIZE I had given it: at 14px a device frame is a dark smudge and the SCREEN column beside
         * it already states the geometry in words. But document 03's fleet mockup has a frame on
         * every row, and the answer to "too small to read" is a taller row, not an absent
         * component. It is what makes this table read as a rack of devices rather than as a
         * spreadsheet about devices — and a 720x1280 row is visibly stubbier than a 1080x2340 one,
         * which is a fact you can see before you have read anything.
         */
        /**
         * THE NAME IS THE LINK, so the row can carry ONE button — document 03's fleet rows have
         * exactly one, and the second was costing more than it bought. "Details" sat on every row
         * including the three that already had the action you actually wanted, so the column read
         * as two choices where there was really one plus a footnote.
         *
         * The whole name block is the target rather than the text alone: a 40px-tall row with a
         * device drawn in it is a much easier thing to hit than eleven characters of it.
         */
        h('td', null, h('button', {
          class: 'row tight fleet-open', type: 'button',
          title: `Open ${deviceName(d)}`,
          onclick: () => go(`#/devices/${d.id}`),
        },
          deviceThumb(d, 40),
          (() => {
            const shared = (twins.get(deviceName(d)) || 0) > 1;
            return h('span', { class: 'stack none' },
              h('span', { class: 'fleet-name', text: deviceName(d) }),
              h('code', {
                class: shared ? 'fleet-id shared' : 'caption',
                text: short(d.id),
                title: shared
                  ? `${twins.get(deviceName(d))} devices share this name. The id is what tells them apart.`
                  : null,
              }),
            );
          })(),
          isRealDevice(d) ? h('span', { class: 'kindtag real', text: 'REAL' }) : null,
        )),

        // Geometry, in the register it came from. The dp width is the number a layout bug is
        // actually expressed in, so it earns its place beside the pixels.
        h('td', null, geometryText(d)
          ? h('span', { class: 'stack none' },
              h('code', { class: 'caption', text: `${d.screen.width} × ${d.screen.height}` }),
              // DENSITY AND WIDTH, both. They answer different questions: dpi is what an asset is
              // rasterised for, dp is the number a layout bug is expressed in. Document 03 shows
              // the pair; this column used to show only the second.
              h('span', { class: 'caption mono', text: [
                d.screen.density ? `${d.screen.density}dpi` : null,
                widthDp(d).replace(' dp', 'dp'),
              ].filter(Boolean).join(' \u00b7 ') }))
          // D2 — a blank geometry says WHY it is blank when the answer is "nobody has asked lately".
          : h('span', { class: 'stack none' },
              h('span', { class: 'caption', text: 'not reported' }),
              heardFrom(d) ? h('span', { class: 'caption warn-text', text: heardFrom(d) }) : null)),

        h('td', null, h('span', { class: 'stack none' },
          pill(st.label, st.tone, { live: d.state === 'READY' }),
          // WHEN, beside the state and never inside it — a lease that is ticking down, or how long
          // a quarantine has stood. Both are facts the state alone does not carry.
          sess?.expiresAt
            ? ticker('until', sess.expiresAt, { suffix: ' left', cls: 'caption' })
            : d.quarantine?.at
              ? h('span', { class: 'caption', text: ago(d.quarantine.at) })
              : null,
        )),

        /**
         * WHO HAS IT — and for a free device, nobody, said as an em-dash.
         *
         * The obvious filler here is the state's own note ("Allocatable now"), and it is wrong: it
         * restates the pill one column to the left, so the row says the same thing twice and the
         * column stops meaning "holder". A quarantine reason is different — that IS what occupies
         * the device, and it is the operator's first question.
         */
        /**
         * AND AN ESCALATED DEVICE SAYS SO HERE — D21 on the Fleet.
         *
         * `st.note` for CLEANING is "Snapshot restore in progress", which is exactly wrong once the
         * budget is spent: nothing is in progress and nothing will be until somebody resumes it.
         * Seen on the live farm, on a row whose pill read RESTORING for twenty minutes.
         */
        h('td', null, who
          ? h('span', { class: 'stack none' },
              h('span', { class: 'secondary', text: who }),
              sess?.startedAt ? h('span', { class: 'caption', text: `since ${when(sess.startedAt).split(', ').pop()}` }) : null)
          : d.resetEscalation?.at
            ? h('span', { class: 'stack none' },
                h('span', { class: 'caption bad-text', text: 'its reset gave up' }),
                h('span', { class: 'caption', text: `${ago(d.resetEscalation.at)} — open it to resume` }))
            : h('span', { class: 'caption', text: d.quarantine?.reason || (d.state === 'READY' ? '—' : st.note) })),

        /**
         * ONE ACTION PER ROW, and it is the one that applies to THIS device in THIS state. Start
         * where it is free, the cockpit where you already hold it, recovery where it is out of the
         * pool — and Details as the fallback, because every device has something to say.
         */
        h('td', { class: 'right' }, h('div', { class: 'rowactions' },
          mine
            ? btn('Open cockpit', 'tiny primary', () => go(`#/sessions/${sess.id}`))
            : d.state === 'READY'
              ? btn(`Start ${deviceName(d)}`, 'tiny primary', () => startSession(d))
              : d.state === 'QUARANTINED'
                ? btn('Recover', 'tiny ghost', () => askReleaseQuarantine(d))
                : null,
          /**
           * D3 — THE BUILD, FROM THE ROW YOU ARE ALREADY LOOKING AT.
           *
           * Only on a free device this org does not already hold, and only when the library has
           * something to install: a build picker for an empty library is a control whose premise is
           * false, and one on a busy row would queue a session against a device somebody else has.
           */
          !mine && d.state === 'READY' && state.apps.length
            ? btn('With a build…', 'tiny ghost', () => startWithBuild(d))
            : null,
          /**
           * NO Details BUTTON AT ALL — the device's name is the link.
           *
           * The condition here used to keep one for the in-between states, which meant every in-use
           * row carried two controls to the same destination: the name I had just made a link, and
           * a button beside it. Found by clicking every control on the screen and reading where
           * each one went. A row with one action reads as a decision; a row with two reads as a
           * menu, which is what removing the button was for.
           */
        )),
      );
    })),
  ));
}

/**
 * CATALOGUE — the fleet advertised as products.
 *
 * The buyer's page, and also the page an engineer uses to CHOOSE A SCREEN SIZE. It answers "what
 * can I test on" before "what is free right now", which is why it is grouped by class rather than
 * listing devices: a class is what the allocator hands over (ADR-0025), so it is the only unit a
 * card here can honestly promise.
 *
 * The free count is a FRACTION on every card, because "2 of 2 free" and "0 of 2 free" are the same
 * card with different consequences and the denominator is what tells them apart.
 */
function fleetCatalogue() {
  const classes = new Map();
  for (const d of state.devices) {
    const key = deviceClass(d);
    if (!classes.has(key)) classes.set(key, []);
    classes.get(key).push(d);
  }
  if (!classes.size) {
    return card(null, {}, empty('Nothing to show yet.', 'No device has registered with this farm.'));
  }

  /**
   * Free first, then flagship before standard.
   *
   * Free is the primary key because this is a catalogue of things you may be about to take, and one
   * you cannot have belongs below one you can. Within that, the order is the CLASS RANK rather than
   * the name — sorting alphabetically put "MFARM X1" above "MFARM X1 Pro", so the flagship led with
   * its cheaper sibling, which is the wrong first impression on the one page that is also a sales
   * surface.
   */
  const rank = (d) => ({ FLAGSHIP: 0, STANDARD: 1, 'NO PROFILE': 2, 'REAL DEVICE': 3 }[classBlurb(d).badge] ?? 4);
  const groups = [...classes.entries()].sort((a, b) => {
    const freeA = a[1].some((d) => d.state === 'READY') ? 0 : 1;
    const freeB = b[1].some((d) => d.state === 'READY') ? 0 : 1;
    return freeA - freeB || rank(a[1][0]) - rank(b[1][0]) || deviceName(a[1][0]).localeCompare(deviceName(b[1][0]));
  });

  /**
   * PHYSICAL HANDSETS GET A STRIP, NOT A CARD — document 05 §02 puts them in a full-width row under
   * the grid rather than beside the virtual classes.
   *
   * The reason is that they are different IN KIND, not merely a fourth product: they cannot be
   * reset from a snapshot (only apps are cleared between sessions), they are named by their own
   * model number rather than an MFARM class, and there is generally one of each. A peer card
   * invites the comparison "which of these four should I pick", and for a handset that is the wrong
   * question — you take the handset because it is that phone, or you do not.
   */
  const physical = groups.filter(([, m]) => isRealDevice(m[0]));
  const virtual = groups.filter(([, m]) => !isRealDevice(m[0]));

  return [
    h('div', { class: 'catgrid' }, virtual.map(([, members]) => {
    const d = members[0];
    const free = members.filter((x) => x.state === 'READY').length;
    // COMING BACK vs NEVER COMING BACK. A device somebody else is using frees up on its own; a
    // quarantined or offline one does not, and the allocator only ever promotes onto READY.
    const coming = members.some((x) => BUSY_STATES.has(x.state));
    const { badge, blurb } = classBlurb(d);
    /**
     * THE INTERSECTION, not the union. A class can only promise what EVERY device in it can do,
     * because the allocator may hand over any of them — advertising a capability that two of three
     * devices declare is advertising a coin toss.
     */
    const caps = members.reduce(
      (acc, x) => acc.filter((c) => (x.capabilities || []).includes(c)),
      [...(d.capabilities || [])]);

    return card(null, { class: 'stack cat-card' },
      h('div', { class: 'row between' },
        h('span', { class: `kindtag ${isRealDevice(d) ? 'real' : 'virtual'}`, text: badge }),
        h('span', { class: `caption${free ? '' : ' warn-text'}`, text: `${free} of ${members.length} free` }),
      ),

      /**
       * THE DEVICE IS THE HERO, on the right, at full card height — document 05 §02. It was a 108px
       * thumbnail tucked beside the title, which makes the card a text block with a picture in it;
       * the design makes it a product card, where the shape is the first thing read and the specs
       * explain it. On a page whose whole job is "choose a screen size", the screen should be the
       * largest thing on the card.
       *
       * And when the class has nothing free, the panel says so INSIDE the glass rather than in a
       * caption below — the panel is what is unavailable.
       */
      h('div', { class: 'cat-body' },
        h('div', { class: 'stack tight' },
          h('span', { class: 'card-title', text: deviceName(d) }),
          h('p', { class: 'help cat-blurb', text: blurb }),
        ),
        h('div', { class: 'cat-hero' },
          staticFrame(d, 230, 'off', free ? null : 'all in use'),
        ),
      ),

      h('div', { class: 'device-meta' },
        [['Screen', geometryText(d) ? `${d.screen.width} × ${d.screen.height}` : null],
          ['Density', d.screen?.density ? `${d.screen.density} dpi` : null],
          ['Layout width', widthDp(d)],
          ['Android', d.osVersion]]
          .filter(([, v]) => v)
          .map(([k, v]) => h('div', null,
            h('p', { class: 'micro', text: k }),
            h('p', { class: 'v mono', text: v }))),
      ),

      caps.length
        ? h('div', { class: 'caps' }, caps.map((c) => chip(c, true)))
        : h('p', { class: 'caption', text: 'The devices in this class declare no capabilities in common.' }),

      /**
       * THREE CASES, AND THE THIRD IS THE ONE THAT MATTERS.
       *
       * Free: start it. Busy: join the queue — a real and often correct choice, and the reason
       * ADR-0025 makes the allocator queue rather than hand over a different class.
       *
       * BUT A CLASS WITH NOTHING COMING BACK MUST NOT OFFER A QUEUE. Every device quarantined or
       * offline means the queue is one nothing will ever serve: the allocator only promotes onto a
       * READY device, so pressing it buys a session that waits forever. The first draft offered it
       * anyway, because it only asked whether anything was FREE — the same "busy versus
       * unavailable" distinction the launch picker already makes, missed one screen over.
       */
      /**
       * SHORT LABELS, because the card already says the name — document 05 §02 has "Start one" and
       * "Join queue · 2 ahead". Repeating "MFARM X1 Pro" in a button eighteen pixels under a
       * heading that says "MFARM X1 Pro" is words the reader has to check rather than read.
       *
       * The QUEUE LENGTH is on the button, though, and it is the one number that changes the
       * decision: "join a queue" and "join a queue with four people in it" are different offers.
       * Counted from the sessions already waiting, not invented.
       */
      h('div', { class: 'row tight' },
        free
          ? btn('Start one', 'primary', () => startSession(d))
          : coming
            ? btn(queuedSessions().length
              ? `Join queue \u00b7 ${queuedSessions().length} ahead`
              : 'Join queue', 'ghost', () => startSession(d))
            : null,
        // D3 again, on the surface whose whole job is choosing: this card is where somebody picks a
        // screen size, and "with the build I am testing" is part of that choice, not a later step.
        free && state.apps.length
          ? btn('With a build…', 'ghost', () => startWithBuild(d))
          : null,
        btn('Full specification', 'ghost', () => go(`#/devices/${d.id}`)),
      ),

      free || coming
        ? null
        : h('p', { class: 'caption', text: members.length === 1
            ? 'Out of the pool. Nothing is queued for it, because a queue here would never be served.'
            : 'Every device in this class is out of the pool. A queue here would never be served.' }),
    );
    })),

    physical.length ? physicalStrip(physical) : null,
  ];
}

/**
 * The handsets, summarised in one row — document 05 §02.
 *
 * States the two things that make a real phone different from a class, both of which are facts
 * about the hardware rather than opinions: it cannot be snapshot-reset, and it is named by its own
 * model number. The count and the names come from the fleet, so a farm with none of them shows
 * nothing at all rather than an empty section explaining an absence.
 */
function physicalStrip(groups) {
  const all = groups.flatMap(([, m]) => m);
  const free = all.filter((d) => d.state === 'READY');
  const names = [...new Set(all.map((d) => deviceName(d)))];

  return card(null, { class: 'phystrip mt-gap' },
    h('div', { class: 'row tight' },
      staticFrame(all[0], 92),
      h('div', { class: 'stack tight' },
        h('div', { class: 'row tight' },
          h('span', { class: 'card-title', text: 'Physical handsets' }),
          h('span', { class: 'kindtag real', text: `${all.length} in the farm` })),
        h('p', { class: 'help cat-blurb' },
          'Real phones plugged into a real machine. They cannot be reset from a snapshot \u2014 only '
          + 'apps are cleared between sessions \u2014 and they are named by their own model number, '
          + 'not an MFARM class. ',
          // The specific ones, and their state, because "we have handsets" is not actionable and
          // "one SM-S918B, out of the pool" is.
          h('span', { class: 'secondary', text: names.join(', ') }),
          free.length ? `, ${free.length} free.` : ', all out of the pool.'),
      ),
      h('span', { class: 'spacer' }),
      btn(free.length ? 'Start one' : 'See it', free.length ? 'primary' : 'ghost',
        () => (free.length ? startSession(free[0]) : go(`#/devices/${all[0].id}`))),
    ),
  );
}

/**
 * THE FLEET, and the four lenses over it.
 *
 * The old routes still work — `#/devices`, `#/sessions`, `#/queue` land here on the lens that used
 * to be that page — so no bookmark, no `G` shortcut and no muscle memory breaks. That is the whole
 * reason the lens is in the URL rather than in local state.
 */
function screenFleet() {
  const lens = state.lens || 'capacity';
  const waiting = queuedSessions().length;
  const live = liveSessions().length;
  const counts = { live, waiting };

  return [
    /**
     * THE HEADLINE IS A NODE, NOT A STRING — document 03 sets the waiting clause apart in amber.
     *
     * It was one flat sentence, and the half that changes what you do next ("two people are
     * waiting") read exactly like the half that does not ("every device is in use"). Emphasis here
     * is not decoration: it is the difference between a fact and a fact you have to act on. The
     * WORDS still carry it on their own, so nothing is conveyed by colour alone.
     */
    pageHead([{ label: 'Farm' }], 'Fleet', null, null, (() => {
      const hl = fleetHeadline();
      return h('p', { class: 'page-sub' },
        hl.capacity,
        hl.queue ? ' ' : null,
        hl.queue
          ? h('span', { class: hl.waiting ? 'warn-text' : '', text: hl.queue })
          : null);
    })()),

    h('div', { class: 'row tight mb-gap lensrow' }, LENSES.map(([key, label]) => h('button', {
      class: `lens${lens === key ? ' on' : ''}`,
      onclick: () => go(`#/fleet/${key}`),
    },
      label,
      // A count only where a count is the point. "Capacity 5" would be a second, worse copy of the
      // headline; "Waiting 2" is the number somebody is looking for.
      counts[key] ? h('span', { class: 'lens-n', text: String(counts[key]) }) : null,
    ))),

    lens === 'catalogue' ? fleetCatalogue()
      // D22 — the same predicate the badge above is counted from, so the tab and the table cannot
      // describe different sets again.
      : lens === 'live' ? screenSessionsBody(liveSessions())
        : lens === 'waiting' ? screenQueueBody()
          // FULL WIDTH, and no rail. The rail carried a queue card that said "All devices are
          // available / Nobody is waiting" — which the headline four lines above already said, in
          // the same words. Two panels stating one fact is exactly the duplication this surface was
          // built to remove, and the queue has its own lens.
          : [fleetCapacity(), substitutionNotice()],
  ];
}

function screenDevices() {
  const n = state.devices.length;
  const kind = state.deviceKind;
  const shown = kind === 'all' ? state.devices : state.devices.filter((d) => deviceKindOf(d) === kind);
  // Only offered once there is something to choose between. A filter on a fleet with one kind in it
  // is a control that can only ever produce an empty screen.
  const mixed = new Set(state.devices.map(deviceKindOf)).size > 1;

  return [
    pageHead([{ label: 'Farm' }], 'Devices',
      `${n} device${n === 1 ? '' : 's'} · ${state.available} ready to allocate`),
    h('div', { class: 'split' },
      h('div', { class: 'content' },
        mixed
          ? h('div', { class: 'row tight mb-gap' }, DEVICE_KINDS.map(([k, label]) => h('button', {
              class: `levelchip${kind === k ? ' on' : ''}`,
              onclick: () => { state.deviceKind = k; render(); },
            }, k === 'all' ? label : `${label} (${state.devices.filter((d) => deviceKindOf(d) === k).length})`)))
          : null,
        n
          ? (shown.length
              ? h('div', { class: 'autogrid' }, shown.map(deviceCard))
              // Reachable only by filtering, so it says which filter and offers the way back —
              // rather than the "no devices are registered" copy below, which would be a lie.
              : card(null, {}, empty(`No ${kind} devices in this region.`,
                  'Every device here is of the other kind. Clear the filter to see them.')))
          : card(null, {}, empty('No devices are registered in this region yet.',
              'Start a worker and it appears here within a heartbeat.')),
      ),
      h('div', { class: 'rail' }, queueCard(), activityCard()),
    ),
  ];
}

/* --------------------------------------------------------- quarantine: the gated way back */

/**
 * Why this device is out of the pool, in words rather than in an enum.
 *
 * The API sends a source and the reason the farm recorded; this pairs them, because the source is
 * what tells an operator WHERE TO LOOK and the reason alone does not. A handset whose host stopped
 * beating and a handset that failed its own health check both read "Quarantined" on every screen
 * this console has ever had, and they need completely different people to do completely different
 * things.
 */
const QUARANTINE_SOURCE = {
  host:     'Its host was quarantined. It comes back on its own when the host beats again.',
  operator: 'An operator took it out of service.',
  health:   'It failed a health check.',
};

/**
 * Release, spelled out.
 *
 * The dialog is deliberately not a yes/no about "recovering the device". The one thing an operator
 * must not believe when they click this is that the device is now available — that is precisely the
 * button ADR-0024 exists to refuse to build — so the copy states what actually happens, in the
 * order it happens, before the confirm.
 */
function askReleaseQuarantine(d) {
  confirmDialog({
    title: 'Release this quarantine?',
    lead: 'This authorises a recovery attempt. It does not make the device available.',
    removes: [
      'the host is asked to reset the device',
      'the device reports a health check when the reset finishes',
      'only a passing check puts it back in the pool',
      'a failure returns it to quarantine, with the new reason',
    ],
    keeps: 'Nothing is handed to a tenant until the check passes.',
    confirm: 'Authorise recovery',
    onConfirm: () => releaseQuarantine(d.id),
  });
}

async function releaseQuarantine(id) {
  try {
    const out = await api(`/v1/devices/${encodeURIComponent(id)}/release-quarantine`, { method: 'POST' });
    // The API's own sentence, not one written here. Two places wording the same guarantee is how a
    // console ends up promising something the control plane does not do.
    toast(out.released ? 'Recovery authorised' : 'Nothing changed', out.detail, out.released ? '' : 'warn');
    await refreshDevices();
    await loadQuarantineLog(id);
    render();
  } catch (e) {
    toast('Could not release the quarantine', e.message, 'bad');
  }
}

function askQuarantine(d) {
  const reason = h('input', {
    class: 'input', id: 'q-reason', placeholder: 'e.g. adb keeps dropping mid-session',
    maxlength: '500',
  });
  formDialog({
    title: `Take ${deviceName(d)} out of service?`,
    lead: 'It leaves the allocation pool immediately, and any session on it ends. Getting it back '
      + 'needs a release and a passing health check.',
    fields: [
      h('label', { class: 'stack tight' },
        h('span', { class: 'micro', text: 'Reason' }),
        reason,
        // Required by the API, and the reason it is required is worth saying at the point of entry:
        // the person who finds this device next week has only this sentence to go on.
        h('span', { class: 'caption', text: 'Whoever triages this device next sees only this.' })),
    ],
    submit: 'Quarantine',
    onSubmit: () => quarantineDevice(d.id, reason.value.trim()),
  });
}

async function quarantineDevice(id, reason) {
  if (!reason) { toast('A reason is required', 'A quarantine with no reason cannot be triaged.', 'warn'); return; }
  try {
    const out = await api(`/v1/devices/${encodeURIComponent(id)}/quarantine`,
      { method: 'POST', body: { reason } });
    toast(out.quarantined ? 'Device quarantined' : 'Nothing changed', out.detail,
      out.quarantined ? '' : 'warn');
    await refreshDevices();
    await loadQuarantineLog(id);
    render();
  } catch (e) {
    toast('Could not quarantine the device', e.message, 'bad');
  }
}

/**
 * WHAT AUTHORISING RECOVERY WILL AND WILL NOT DO — one arrow and three crosses.
 *
 * On the page rather than only behind the confirm dialog, which is where it used to live alone.
 * The dialog is read by somebody who has already decided; the page is read by somebody deciding,
 * and this list is the thing that changes the decision. It is also the list most likely to be
 * remembered wrongly — every one of these three crosses is a thing an operator reasonably expects
 * a "release" button to do, and none of them is true (ADR-0024).
 *
 * The DOES row is green and the DOES-NOT rows are red, and the words "one", "not", "not" carry the
 * emphasis rather than the colour: a person who cannot see the difference between the arrow and
 * the cross still reads three sentences that begin "It does not".
 *
 * TWO STORIES, BECAUSE THERE ARE TWO KINDS OF QUARANTINE and only one of them is the operator's to
 * fix. See `hostQuarantineConsequences` below — that distinction was found on the live farm, not
 * in a fixture.
 */
function csqLine(mark, tone, ...body) {
  return h('li', { class: `csq ${tone}` },
    h('span', { class: 'csq-mark', text: mark, 'aria-hidden': 'true' }),
    h('span', { class: 'csq-body' }, ...body));
}

function recoveryConsequences() {
  return h('div', { class: 'consequence' },
    h('p', { class: 'csq-head', text: 'Authorising recovery does one thing' }),
    h('ul', { class: 'csq-list' },
      csqLine('\u2192', 'yes', 'Permits ', h('strong', { text: 'one' }),
        ' recovery attempt: the host restarts the device and runs a health check.'),
      csqLine('\u00d7', 'no', 'It does ', h('strong', { text: 'not' }),
        ' return the device to the pool. Only a passing health check does that.'),
      csqLine('\u00d7', 'no', 'It does ', h('strong', { text: 'not' }),
        ' clear the quarantine note or its history.'),
      csqLine('\u00d7', 'no', 'If the check fails, the device stays out and the failure is recorded below.'),
    ),
    h('p', { class: 'csq-note row tight' },
      h('span', { class: 'dot ok' }),
      'No session can be started on this device until a check passes.'),
  );
}

/**
 * A HOST QUARANTINE IS NOT THE OPERATOR'S TO FIX, and the page used to offer it as though it were.
 *
 * Found on the deployed farm rather than in any fixture. `quarantine_host` takes every device on a
 * silent host out of the pool, and migration 016's `clear_silence_quarantine` puts them back on the
 * host's next beat — automatically, with no button pressed. The page already printed that sentence
 * ("It comes back on its own when the host beats again") and then, directly underneath, offered
 * "Authorise one recovery attempt" above a list explaining that only a health check can return it.
 * Two true sentences that contradict each other, one of them attached to a red button.
 *
 * And the button is worse than redundant here. Releasing sets the device PREPARING and asks its
 * host to reset it — the same host that is not answering, which is the entire reason the device is
 * out. The request reaches nobody, migration 035's timeout fires, and the device is quarantined
 * again with a new reason. An operator would have turned "waiting for a host" into "failed a
 * recovery" and learned nothing.
 *
 * So the action stays — an admin may know the host is coming back, and removing a control an admin
 * might need is the mistake stage 5 exists to correct — but it is DEMOTED out of the solid
 * destructive variant and the copy says what pressing it costs. The deciding fact, when the farm
 * last heard from that host, is put beside it.
 */
function hostQuarantineConsequences(hostLastSeenAt) {
  return h('div', { class: 'consequence' },
    h('p', { class: 'csq-head', text: 'This one comes back on its own' }),
    h('ul', { class: 'csq-list' },
      csqLine('\u2192', 'yes', 'The device returns to the pool ',
        h('strong', { text: 'automatically' }), ', the moment its host beats again.'),
      csqLine('\u00d7', 'no', 'Authorising recovery does ', h('strong', { text: 'not' }),
        ' speed that up. It asks the host to reset the device \u2014 and this host is not answering, '
        + 'which is why the device is out.'),
      csqLine('\u00d7', 'no', 'An attempt that goes unanswered times out and quarantines the device '
        + 'again, with a new reason. Nothing is learned and the history is longer.'),
    ),
    h('p', { class: 'csq-note row tight' },
      h('span', { class: 'dot ok' }),
      hostLastSeenAt
        ? `The farm last heard from that host ${ago(hostLastSeenAt)}. Nothing to do until that changes.`
        : 'The farm has no heartbeat recorded for that host at all.'),
  );
}

/**
 * Who took this device out, from the audit log rather than from a new API field.
 *
 * `GET /devices/:id` carries the quarantine's reason, time and SOURCE but not its actor — and the
 * actor is already recorded, on the `quarantined` event in the quarantine log this screen loads
 * beside it. Reading it here rather than widening the device payload keeps one writer for that
 * fact. Null while the log is still loading, and null for a quarantine older than the audit log,
 * which is why every caller below has a sentence that works without it.
 */
function quarantineActor(id) {
  const log = state.quarantineLog?.id === id ? state.quarantineLog : null;
  return (log?.events || []).find((e) => e.event === 'quarantined')?.actor || null;
}

/** The card that carries the whole gate: why it is out, and the one action that is offered. */
function quarantineCard(d) {
  const admin = isOrgAdmin();

  if (d.state === 'PREPARING') {
    return card('Recovering', { aside: pill('Preparing', 'warn', { at: d.recovery?.startedAt }) },
      kv([
        ['Recovering from', d.recovery?.fromReason || 'a quarantine recorded before this was kept'],
        ['Started', d.recovery?.startedAt ? `${when(d.recovery.startedAt)} (${ago(d.recovery.startedAt)})` : '\u2014'],
      ]),
      h('p', { class: 'help mt-md', text:
        'Its host has been asked to reset it and report a health check. It becomes available only '
        + 'if the check passes; a failure puts it straight back into quarantine with the new '
        + 'reason. If the host never answers, the farm gives up and quarantines it again.' }),
    );
  }

  if (d.state === 'QUARANTINED') {
    const actor = quarantineActor(d.id);
    const note = d.quarantine?.reason;
    const since = d.quarantine?.at;

    /**
     * ONE SENTENCE, ASSEMBLED FROM WHAT IS ACTUALLY KNOWN. The design's line reads "Taken out by
     * admin@mfarm.local with the note ..." and both halves are optional in real data: a health
     * check has no actor, and a quarantine older than the audit log has neither. Building this as
     * a template with holes would produce "Taken out by with the note" on the fleet's oldest rows,
     * which is exactly the sort of thing that only ever appears on the device somebody is already
     * confused about.
     */
    /**
     * A HOST QUARANTINE'S NOTE RESTATES ITS OWN SOURCE, so it is not shown twice.
     *
     * `quarantine_host` writes both fields from the same fact, so the page read: "Its host was
     * quarantined. It comes back on its own when the host beats again. The note reads 'its host was
     * quarantined: no heartbeat for 90s'." Seen on the live farm; invisible in a fixture, because a
     * fixture's note is one somebody wrote by hand.
     *
     * The rule is about WHO WROTE IT, not about matching the strings: an operator's note and a
     * health check's detail are independent facts and always worth showing; a host quarantine's is
     * machine-derived from the source sentence beside it.
     */
    const derivedNote = d.quarantine?.source === 'host';
    const showNote = Boolean(note) && !derivedNote;

    const took = actor
      ? ['Taken out by ', h('code', { text: actor }), showNote ? ' with the note ' : '.']
      : [(QUARANTINE_SOURCE[d.quarantine?.source] || 'The farm did not record who took it out.'),
        showNote ? ' The note reads ' : ''];

    /**
     * NO SECOND STATE PILL. The page head already carries "Quarantined", and a card that is red,
     * headed "Out of the pool" and offering a recovery button is not ambiguous about the state —
     * repeating the pill here spent the reader's attention restating what they had just read. The
     * age is the part that was doing work, so the age is what stays.
     */
    return h('section', { class: 'card gate' },
      h('div', { class: 'card-head' },
        h('p', { class: 'card-title',
          text: since ? `Out of the pool since ${day(since)}` : 'Out of the pool' }),
        since ? h('span', { class: 'pill-at', text: ago(since) }) : null),
      h('p', { class: 'help' },
        ...took,
        showNote ? h('q', { text: note }) : null,
        showNote ? '. ' : ' ',
        'The allocator will not hand this device to anybody while it is quarantined.'),
      admin
        ? [
          derivedNote ? hostQuarantineConsequences(d.hostLastSeenAt) : recoveryConsequences(),
          h('div', { class: 'row tight mt-lg' },
            /**
             * "Release quarantine" describes a state change the operator cannot actually make.
             * Releasing does NOT return the device to the pool — it permits the host one restart
             * and one health check, and only a passing check returns it. The old label promised
             * the outcome; this one names the authorisation, which is the thing being granted.
             *
             * `danger-solid`, and it stays `danger-solid` in the light theme too — see the note
             * under document 05 section 03. A destructive action softened into a quiet variant
             * reads as reversible, and this one authorises a device restart.
             */
            /**
             * The solid variant is for the action that is the right one to take. On a host
             * quarantine it is not — the device comes back on its own — so the same action is
             * offered in the outline variant and named for what it actually is. Kept rather than
             * removed: an admin may know the host is back, and a control an admin might need is
             * not the console's to delete (stage 5).
             */
            /**
             * THE PANEL IS THE CONFIRM — document 05 §03 draws Authorise and Cancel inline, not a
             * modal on top of them.
             *
             * Two documents disagree and the specific one wins: document 06's primitive table says
             * the filled destructive button belongs "only inside a confirm dialog", and §03 puts
             * one on this page. §03 is right, because the panel above IS the confirm surface — it
             * carries the same four consequences the dialog was listing, only larger and without
             * having to be opened. A modal that repeats the list verbatim asks somebody to read it
             * twice and teaches them to skip it the second time.
             *
             * SAFE TO INLINE because of what the action is: releasing authorises ONE reset and one
             * health check. It destroys nothing, it does not return the device to the pool, and the
             * panel says both. A confirm step exists to slow down an irreversible thing, and this
             * is not one.
             */
            derivedNote
              ? btn('Ask for a recovery attempt anyway', 'danger', () => releaseQuarantine(d.id))
              : btn('Authorise one recovery attempt', 'danger-solid', () => releaseQuarantine(d.id)),
            // Cancel leaves the page rather than closing something — there is no overlay to close.
            btn('Cancel', 'ghost', () => go('#/fleet'))),
        ]
        // Said rather than silently absent: a member who cannot find the button should learn why
        // instead of concluding the console has none.
        : h('p', { class: 'caption mt-lg', text: 'Only an owner or an admin can release a quarantine. Releasing authorises one reset and one health check; only a passing check returns the device to the pool.' }),
    );
  }

  if (!admin) return null;
  return card('Take out of service', {},
    h('p', { class: 'help', text:
      'Quarantining removes this device from allocation immediately and ends any session on it. '
      + 'Use it when the device itself is the problem \u2014 a test that fails is not.' }),
    h('div', { class: 'row tight mt-lg' },
      btn('Quarantine device', 'danger', () => askQuarantine(d))),
  );
}

/** Who did what to this device, and what it proved. Section 30's audit, read back. */
const QUARANTINE_EVENT = {
  quarantined:       { tone: 'bad',  verb: 'Quarantined' },
  released:          { tone: 'warn', verb: 'Quarantine released — recovery authorised' },
  recovered:         { tone: 'ok',   verb: 'Recovered — health check passed, back in the pool' },
  'recovery-failed': { tone: 'bad',  verb: 'Recovery failed — quarantined again' },
};

function quarantineHistoryCard(id) {
  const log = state.quarantineLog?.id === id ? state.quarantineLog : null;
  const events = log?.events || [];
  return card('Quarantine history', {},
    events.length
      ? timeline(events.map((e) => {
          const meta = QUARANTINE_EVENT[e.event] || { tone: '', verb: e.event };
          // The actor on a release, the reason on everything else. A release has no reason of its
          // own — the reason it names is the one it is recovering FROM, and showing that here would
          // read as a second quarantine.
          const note = e.event === 'released'
            ? `${e.actor ? `by ${e.actor}` : 'by an operator'}${e.fromReason ? ` · from: ${e.fromReason}` : ''}`
            : (e.reason || '');
          return { tone: meta.tone, title: meta.verb, note: `${ago(e.occurredAt)}${note ? ` · ${note}` : ''}` };
        }))
      : (log?.loaded
          ? empty('Nothing has happened to this device.', 'Quarantines, releases and recovery outcomes appear here.')
          : h('p', { class: 'help', text: 'Loading…' })),
  );
}

/* ------------------------------------------------------------------ screen: device detail */

/**
 * WHICH OF THE THREE RESETS THIS DEVICE HAS — ADR-0012's distinction, said in one line.
 *
 * The three are mutually exclusive and they are not interchangeable: a snapshot restore returns the
 * whole disk, a session reset clears app state, and an install reset only removes what was
 * installed. "This device resets" is not the useful sentence; which one it does is, because it
 * decides what the next tenant inherits.
 *
 * Reported as absent rather than assumed, because a device with none of the three is a real and
 * important thing to see: it is never handed out (`workers.ts` registers it OFFLINE), and this row
 * is where an operator finds out why.
 */
const RESET_STORY = {
  'snapshot-reset': 'snapshot-reset',
  'session-reset': 'session-reset',
  'install-reset': 'install-reset',
};
function resetStory(d) {
  const found = Object.keys(RESET_STORY).filter((c) => (d.capabilities || []).includes(c));
  if (!found.length) return 'none declared';
  // More than one is a device describing itself in a way ADR-0012 says cannot be true. Shown rather
  // than resolved by picking a favourite: the console is not the place that decides which reset a
  // device really has.
  return found.join(' + ');
}

/**
 * HOW OLD IS WHAT THIS ROW IS TELLING YOU — D2.
 *
 * "Screen: not reported" was filed as a worker defect. It is not: the agent has read a handset's
 * panel with `wm size` / `wm density` since 2026-08-24 and cannot register one without a geometry.
 * The farm's SM-S918B shows nothing because its row has not been written since its host last beat
 * on 2026-08-29 — nine days of the console saying "not reported" about a question nobody had asked
 * the device in over a week.
 *
 * A SILENT HOST AND A DEVICE THAT REPORTS NOTHING ARE OPPOSITE PROBLEMS: one is fixed by plugging a
 * machine back in, the other by looking at the device. A blank field cannot tell them apart, so
 * this says which one it is wherever a field is blank.
 *
 * The threshold is the FARM'S OWN definition of a host that is not beating (90s, `HOST_SILENCE`),
 * not a number invented here — the same fact the reaper acts on, so the console cannot disagree
 * with the scheduler about whether a host is present.
 */
const HOST_SILENT_MS = 90_000;
function heardFrom(d) {
  if (!d?.hostLastSeenAt) return null;
  const age = Date.now() - new Date(d.hostLastSeenAt).getTime();
  if (!Number.isFinite(age) || age < HOST_SILENT_MS) return null;
  return `last heard from this device ${ago(d.hostLastSeenAt)}`;
}

/** `1440 x 3088`, from the device's own report and never from the profile table (ADR-0016). */
function screenSize(d) {
  const sc = d.screen;
  return sc?.width && sc?.height ? `${sc.width} \u00d7 ${sc.height}` : 'not reported';
}

/**
 * A DEVICE WHOSE RESET BUDGET IS SPENT — D21, and until now the console could not see this at all.
 *
 * Migration 032 has carried `resetEscalation` on both projections since it shipped. Nothing rendered
 * it anywhere except the Health line added for D1, and NOT on this page — the one somebody opens to
 * do something about a device. So a device sat on `RESTORING` forever, the fleet quietly lost a
 * slot, and the only way back was `curl`: recovering `cf-4` twice on 2026-09-05 needed exactly that.
 *
 * IT IS NOT A QUARANTINE AND MUST NOT LOOK LIKE ONE. The device stays CLEANING on purpose — 032 is
 * explicit that quarantining would ALSO stop the reset offers that are the only thing which could
 * fix it. So this is its own panel, in the same amber register the console uses for "read this
 * before you look at anything else", and it says the one thing the state pill cannot: that nothing
 * is coming unless somebody acts.
 *
 * ADMIN ONLY, because `clear-reset-escalation` is an admin route and a member pressing it gets a
 * 403 — the same gate device detail already puts on the quarantine recovery directly below.
 */
function resetEscalationCard(d) {
  const esc = d.resetEscalation;
  if (!esc?.at) return null;
  const admin = isOrgAdmin();

  return h('section', { class: 'card gate waiting mb-gap' },
    h('div', { class: 'card-head' },
      h('p', { class: 'card-title', text: 'Out of the pool — its reset gave up' }),
      h('span', { class: 'pill-at', text: ago(esc.at) })),
    h('p', { class: 'help' },
      esc.reason || 'The farm stopped retrying this device\u2019s reset.',
      esc.attempts ? ` It was attempted ${esc.attempts} time${esc.attempts === 1 ? '' : 's'}.` : ''),
    /**
     * WHY IT STILL SAYS `CLEANING`, said here rather than left as a contradiction between this card
     * and the state pill six lines above it.
     */
    h('p', { class: 'caption mt-sm', text: 'The device still reads CLEANING because it is not clean — it may hold the last session\u2019s data, so the farm will not hand it to anybody. It is not quarantined: quarantining would also stop the resets that are the only thing which could fix it.' }),
    /**
     * A SILENT HOST IS A DIFFERENT STORY, and worth naming here because migration 038 makes it a
     * different one going forward. An escalation recorded while the host was away is about the
     * outage, not about the device.
     */
    h('p', { class: 'caption mt-sm', text: 'Nothing will be offered to it until somebody resumes recovery. A reset that will genuinely never work escalates again on the next attempt, so this is safe to press once and watch.' }),
    admin
      ? h('div', { class: 'row tight mt-lg' },
          btn('Resume recovery', 'primary', () => askResumeRecovery(d)))
      : h('p', { class: 'caption mt-lg', text: 'Resuming recovery needs an admin.' }),
  );
}

/**
 * Behind a dialog, like every other write on this page — and the consequences are the API’s own,
 * not a second description of them written here.
 */
function askResumeRecovery(d) {
  confirmDialog({
    title: `Resume recovery for ${deviceName(d)}?`,
    lead: 'This puts the device back in the queue for a reset. It does not make it available.',
    removes: [
      'the reset budget is returned to full',
      'the next heartbeat offers this device a reset again',
      'only a completed reset puts it back in the pool',
      'a reset that fails again escalates it again, with a fresh count',
    ],
    keeps: 'Nothing is handed to a tenant until a reset completes.',
    /**
     * NAMES WHAT IS BEING GRANTED, not what the button behind it said. The quarantine dialog does
     * the same thing for the same reason — "Release quarantine" described a state change the
     * operator cannot make, and this one would just repeat the panel's own label back. What is
     * actually authorised here is one more trip through the reset queue.
     */
    confirm: 'Queue a reset',
    onConfirm: () => resumeRecovery(d.id),
  });
}

async function resumeRecovery(id) {
  try {
    const out = await api(`/v1/devices/${encodeURIComponent(id)}/clear-reset-escalation`, { method: 'POST' });
    // The API’s sentence, not one written here — two places wording one guarantee is how a console
    // ends up promising something the control plane does not do.
    toast(out.cleared ? 'Recovery resumed' : 'Nothing changed', out.detail, out.cleared ? '' : 'warn');
    await refreshDevices();
    await loadDevice(id);
    render();
  } catch (e) {
    toast('Could not resume recovery', e.message, 'bad');
  }
}

function screenDevice(id) {
  /**
   * THE DETAIL READ FIRST, THE POLL ROW AS A FALLBACK.
   *
   * `state.devices` comes from `GET /v1/devices`, whose projection did not carry `last_reset_at` —
   * so this screen's "Last reset" row read "not reported" on every device in the fleet for as long
   * as it had existed, and looked like a farm that had never reset anything rather than like a
   * field the list does not send. That one is in the list now (D1); `hostLastSeenAt` and
   * `resetAttempts` are still detail-only and would have arrived the same way.
   *
   * Merged rather than swapped, so navigation paints the name, the state and the quarantine reason
   * from the poll immediately and the four detail-only fields fill in a moment later. A skeleton
   * over facts already in hand would be slower for no gain.
   */
  const polled = deviceById(id);
  const fetched = state.deviceDetail?.id === id ? state.deviceDetail.device : null;
  const d = fetched || polled ? { ...(polled || {}), ...(fetched || {}) } : null;

  if (!d) {
    // Only once the detail read has answered. Before that this is an unknown id on a page that has
    // not finished loading, and "not in this fleet" is a much stronger claim than the console can
    // make yet.
    if (!state.deviceDetail?.loaded) {
      return [
        pageHead([{ label: 'Fleet', to: '#/fleet' }], 'Device', null),
        card(null, {}, h('p', { class: 'help', text: 'Loading\u2026' })),
      ];
    }
    return [
      pageHead([{ label: 'Fleet', to: '#/fleet' }], 'Device', null),
      card(null, {}, empty('That device is not in this fleet.',
        'It may have been evicted, or it belongs to another org \u2014 the API answers those the same way, on purpose.')),
    ];
  }
  const st = DEVICE_STATE[d.state] || { label: d.state, tone: '', note: '' };
  const inPool = d.state === 'READY';

  return [
    pageHead(
      [{ label: 'Fleet', to: '#/fleet' }, { label: 'Device' }],
      deviceName(d),
      null,
      h('div', { class: 'row tight' },
        pill(st.label, st.tone, { live: inPool, title: st.note }),
        inPool ? btn('Start session', 'primary', () => startSession(d)) : null,
        inPool && state.apps.length
          ? btn('Start with a build…', 'ghost', () => startWithBuild(d))
          : null,
      ),
    ),
    /**
     * IDENTITY UNDER THE NAME, in the farm's own vocabulary and in one line.
     *
     * A class badge, then `<short id> · <tier> · <region>`. The short id is what appears in a log
     * line and in a support message, so it is the half of the uuid worth showing at a glance; the
     * whole of it is a click away in Metadata, where it can be copied.
     */
    h('div', { class: 'ident' },
      h('span', { class: 'badge', text: d.tier === 'physical' ? 'Real device' : 'Virtual device' }),
      h('span', { class: 'mono', text: `${String(d.id).slice(0, 8)} \u00b7 ${d.tier} \u00b7 ${d.region}` }),
    ),
    h('div', { class: 'split' },
      h('div', { class: 'content' },
        // FIRST, above the metadata. A device that is out of the pool has exactly one thing a
        // person opened this screen to find out, and it is not its OS version.
        // Above the quarantine card: a device can only be in one of the two states, and this is the
        // one nothing else in the console has ever been able to show.
        resetEscalationCard(d),
        quarantineCard(d),
        card('Metadata', {},
          kv([
            ['Platform', `${d.platform} ${d.osVersion}`],
            /**
             * D2 — and here the staleness is one row away from "Host last seen" below, which is
             * exactly why it was so easy to read "not reported" as a fact about the device. Said in
             * place, because a reader looking at a blank geometry should not have to notice a
             * timestamp four rows down and do the subtraction themselves.
             */
            ['Screen', heardFrom(d) && screenSize(d) === 'not reported'
              ? `not reported — ${heardFrom(d)}`
              : screenSize(d), true],
            ['Reset story', resetStory(d), true],
            ['Tier', d.tier],
            ['Region', d.region],
            /**
             * THE HOST'S BEAT, NOT THE DEVICE'S. Named for what it measures — a device can be
             * unplugged from a host that is beating perfectly, and the row would then be
             * reassuring about the wrong machine.
             *
             * The design package puts `Host lab-host-02` beside this and that field is
             * deliberately absent (ADR-0026): a hostname is a stable identifier that maps the
             * farm's topology and confirms which of your devices sit beside somebody else's,
             * while a timestamp only sharpens a fact the tenant can already infer from the
             * device going OFFLINE.
             */
            ['Host last seen', d.hostLastSeenAt ? `${ago(d.hostLastSeenAt)} (${when(d.hostLastSeenAt)})` : 'never'],
            ['Dedicated', d.dedicated ? 'yes \u2014 reserved to this org' : 'no \u2014 shared pool'],
            // Relative first, absolute in the bracket — the same order as the row above it. A
            // person reads "9d ago" and stops; the timestamp is there for whoever is correlating
            // this with a log, and putting it first made two adjacent rows read in two directions.
            ['Last reset', d.lastResetAt ? `${ago(d.lastResetAt)} (${when(d.lastResetAt)})` : 'not reported'],
          ]),
          h('p', { class: 'micro mt-lg', text: 'Device id' }),
          h('div', { class: 'mt-xs' }, copyrow(d.id)),
        ),
        card('Capabilities', {},
          h('div', { class: 'caps' },
            KNOWN_CAPS.map((c) => chip(c, (d.capabilities || []).includes(c))),
            (d.capabilities || []).filter((c) => !KNOWN_CAPS.includes(c)).map((c) => chip(c, true)),
          ),
          /**
           * THIS SENTENCE WAS FALSE FOR A DAY. It used to end "it is why a control that needs it is
           * missing", which described the rail before stage 5 — and stage 5 made those controls
           * visible and struck through instead of removing them, so the explanation on this page
           * went on pointing at an absence that no longer happens. A caption about another screen
           * is a claim about another screen, and it goes stale silently when that screen changes.
           */
          h('p', { class: 'caption mt-md', text: 'Struck-through capabilities are declared absent by the device. A control that depends on one is visible and disabled in the session rail, never removed \u2014 so the rail can say why it will not work.' }),
        ),
      ),
      h('div', { class: 'rail' },
        quarantineHistoryCard(d.id),
        /**
         * ITS OWN CARD, and it says when it works.
         *
         * This url used to sit at the bottom of Metadata with no note, on a page whose whole
         * purpose is a device that is out of the pool — so the one screen most likely to be read
         * about a quarantined device offered a WebDriver endpoint and said nothing about the fact
         * that it cannot currently reach this device. The endpoint is the farm's, not the
         * device's: it stays correct, it just has nothing to hand out.
         */
        card('WebDriver endpoint', {},
          copyrow(webdriverUrl()),
          h('p', { class: 'caption mt-xs' },
            inPool
              ? 'Authenticate with an org API key as the user half: '
              : 'This device is not allocatable, so a session naming its class will queue rather than start here. Authenticate with an org API key as the user half: ',
            h('code', { text: `https://<api-key>@${location.host}/wd/hub` }),
          )),
        activityCard((a) => a.deviceId === d.id)),
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
    // Defensive only. The API composes a same-origin `/dp/<hostId>` when nothing is configured, so
    // there is no ordinary path to this branch any more — it fires only for a control plane older
    // than that change, or a response that lost the field in transit. The old copy blamed an unset
    // DATA_PLANE_PUBLIC_BASE, which is now the NORMAL configuration and no longer a fault.
    state.liveDetail = 'This session came back without a browser route to the data plane, so nothing can stream. Check the control plane version and that the ingress proxies /dp/*.';
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
        total: 0, free: 0, coming: 0, devices: [],
        // The INTERSECTION, not the union: a profile can only promise what every device in it can
        // do, because the allocator may hand over any of them.
        capabilities: null,
      };
      by.set(key, p);
    }
    p.total += 1;
    if (d.state === 'READY') p.free += 1;
    // COMING BACK vs NEVER COMING BACK, and the distinction is the whole point of counting twice.
    // A device someone else is using frees up on its own; a quarantined or offline one does not,
    // and calling it "busy" invites a tester to wait for something that is never arriving.
    else if (BUSY_STATES.has(d.state)) p.coming += 1;
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
    // A frame at 40px, drawn from a representative device in the class. Every device in a profile
    // row shares a panel and a profile, which is exactly what the frame is derived from — so any of
    // them draws the same shape, and the row shows you what you are choosing.
    deviceThumb(p.devices[0], 44),
    h('span', { class: 'pick-main' },
      h('span', { class: 'pick-title', text: deviceName(p.devices[0]) }),
      h('span', { class: 'pick-sub mono', text: `${p.platform} ${p.osVersion} · ${p.tier} · ${p.region}` }),
    ),
    h('span', { class: 'pick-side' },
      /**
       * A FRACTION, NOT A BARE COUNT.
       *
       * "3 free" answers "can I get one" and nothing else. "3 of 4" also answers "is this farm
       * nearly full", which is the question behind it and the one that decides whether somebody
       * starts now or waits — the denominator is not decoration.
       */
      p.free
        ? pill(`${p.free} of ${p.total} free`, 'ok', { dot: false })
        : p.coming
          ? pill(`${p.coming} of ${p.total} busy`, 'warn', { dot: false })
          // Nothing free and nothing on its way back. Said in the strongest terms the row has,
          // because picking this profile queues a session that will never be served.
          : pill(`${p.total} unavailable`, 'bad', { dot: false }),
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
          ? h('span', { class: 'caption', text: profile.coming
              ? 'nothing free — you will be queued'
              : 'no device here can be scheduled — a session would wait forever' })
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

      card('Device', { aside: h('span', { class: 'caption', text: `${state.available} of ${state.devices.length} free` }) },
        profiles.length
          ? h('div', { class: 'picklist' }, profiles.map(profileRow))
          : empty('No devices are registered.', 'A worker has to register a host before anything can be launched. Check Health.'),
        /**
         * The same fact as the device card's note, in the place a person is choosing.
         *
         * It said "the allocator picks a free device matching this profile", which names a
         * component and a grouping the reader never asked about. The constraint it is really
         * stating — you are choosing a KIND of device, not a particular one — is worth keeping,
         * because it is what makes the substitution notice at handover unsurprising rather than a
         * broken promise.
         */
        h('p', { class: 'caption mt-sm', text: 'You are choosing a kind of device, not a particular one — the farm hands over whichever of them is free.' }),
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

/**
 * `confirm` MARKS THE TWO BEATS THE WORKER ANSWERS FOR — document 04, and D16.
 *
 * "Steps 5 and 6 are different, and look different… The worker reports an outcome, never a start,
 * and its heartbeat is up to ten seconds away. There is nothing to fill, so these beats breathe —
 * the amber mark pulses on the 2.2s system loop and the note says exactly what is being waited on."
 *
 * The first four are transitions the CONTROL PLANE observes and can report as they happen; install
 * and launch are jobs handed to a machine that will answer when it answers. A spinning ring says
 * "something is turning"; nothing is turning, and on the two steps where the wait is longest that
 * was the closest thing on the screen to a progress animation with nothing behind it.
 */
function bringupStep(key, label, st, note, confirm = false) {
  return { key, label, state: st, note, confirm };
}

/**
 * The checklist, derived entirely from state the API and the socket already report.
 *
 * Nothing here is timed or faked. A step is `done` because a session row says so, an action row says
 * so, or a peer connection is carrying frames — which is why the last step can sit at `active` for
 * a while on a cold device and why that is the truth rather than a stalled animation.
 */
/**
 * WHICH BEAT THE BRING-UP IS ON — document 04's six events, resolved from CONFIRMED state only.
 *
 * Each beat is a transition between two things the farm has actually told us, never a timer. The
 * numbers are the document's own, so a reader can hold the spec beside the code:
 *
 *   0  nothing claimed      the frame is unresolved — blurred, dim, flat
 *   1  a device is ours     chassis resolves out of blur. Screen stays off
 *   2  device ready         the screen wakes: the restore glow
 *   3  attached             DEPTH LANDS. This is where the device becomes a physical object
 *   4  live view            real pixels cross-fade up, the sheen with them
 *   5  installing           the build waits outside the frame, breathing, until the worker confirms
 *   6  opened               nothing is drawn; the app arriving IS the animation
 *
 * BEAT 3 IS THE ONE THAT MOVED. Depth used to land on `data-state="live"` — the stream — so a
 * device that declares no `screen-stream` never became physical at all, and one whose negotiation
 * was slow stayed flat while it was already fully attached and driveable. The socket is what makes
 * the session real (migration 017); the video is a nicety on top of it.
 */
function bringupBeat(sess, steps) {
  // `key`, not `id` — `bringupStep(key, ...)` is the shape, and looking for the wrong field made
  // every beat resolve to 1 while looking entirely reasonable.
  const at = (key) => steps.find((x) => x.key === key);
  const done = (key) => at(key)?.state === 'done';

  if (!sess?.deviceId) return 0;
  if (done('launch')) return 6;
  if (at('install') && at('install').state !== 'pending') return 5;
  if (done('stream')) return 4;
  if (done('attach')) return 3;
  if (done('ready')) return 2;
  return 1;
}

/**
 * The persistent frame, positioned for the bring-up screen and told which beat it is on.
 *
 * Everything below is an ATTRIBUTE, not a rebuild: `data-beat` drives the CSS transitions and
 * `paintFrame` writes the geometry, so the element a person is watching is never replaced while
 * they watch it.
 */
function bringupStage(sess, device, steps) {
  const st = ensureStage();
  st.root.dataset.mode = 'bringup';
  const beat = bringupBeat(sess, steps);
  st.root.dataset.beat = String(beat);
  // `data-resolved` belongs to the COCKPIT's queued state, which is a different screen making the
  // same point. Setting both here meant two rules fighting over the same blur with different
  // opacities, and the loser was whichever the cascade happened to put second.
  delete st.root.dataset.resolved;

  // The panel interior follows the same rules it does in the cockpit — `stageState` already knows
  // about a device that declares no stream, and beat 4 is exactly its `live`.
  paintFrame(device);

  /**
   * THE BUILD'S TILE, WAITING OUTSIDE THE FRAME.
   *
   * Document 04's beat 05 travels the tile down into the screen as bytes arrive, and says plainly
   * what to do without byte progress: *"the tile waits outside the frame and lands on
   * confirmation"*. No worker reports install bytes today, so the fallback IS the design — and it
   * is honest in a way the travelling version could not be, because there is nothing to map travel
   * to. It breathes on the system loop while queued and lands when the worker confirms.
   */
  const install = steps.find((x) => x.key === 'install');
  st.tile.hidden = !install || install.state === 'pending';
  if (install) {
    st.tile.dataset.state = install.state;
    st.tile.textContent = install.label.replace(/^Installing /, '');
  }

  st.overlay.hidden = true;
  st.overlay.replaceChildren();
  return st.root;
}

function bringupSteps(sess) {
  const b = state.bringup;
  const app = b?.appId ? appById(b.appId) : null;
  const device = sess?.deviceId ? deviceById(sess.deviceId) : null;
  const canStream = !device || (device.capabilities || []).includes('screen-stream');
  const steps = [];

  const queued = sess?.state === 'QUEUED';
  steps.push(bringupStep('acquire', 'Acquiring a device from the farm',
    sess?.deviceId ? 'done' : (queued ? 'active' : 'active'),
    queued ? queueNote() : (sess?.deviceId ? (device ? deviceName(device) : short(sess.deviceId)) : null)));

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
      ins?.state === 'FAILED' ? ins.error : ins ? 'Queued for the worker’s next heartbeat' : null,
      true));

    if (b.launchAfter) {
      const la = b.launch;
      steps.push(bringupStep('launch', `Opening ${app?.packageName || 'the app'}`,
        la?.state === 'DONE' ? 'done' : la?.state === 'FAILED' ? 'failed' : la ? 'active' : 'pending',
        la?.state === 'FAILED' ? la.error : null,
        true));
    }
  }
  return steps;
}

/**
 * What being queued actually means for the person reading it.
 *
 * "Queue 4" and "Position 4 of 6" are the same sentence in different clothes: both state a rank and
 * leave the reader to work out whether they should keep the tab open. Three things answer that, and
 * the wording below says all three — where you are, that the handover is automatic, and that this
 * page moves on by itself.
 *
 * NO ETA, and its absence is deliberate rather than an omission. Producing one needs every current
 * holder's `expiresAt`, and the sessions list does not return other tenants' lease times — so a
 * number here would be invented, which is exactly the failure every sentence in this console is
 * written to avoid. Position without an estimate still works. What would not work is neither.
 */
function queueNote() {
  const q = queuedSessions();
  const i = q.findIndex((s) => s.id === state.bringup?.sessionId);
  const place = i < 0 ? null
    : i === 0 ? 'Next in line'
      : i === 1 ? 'Second in line'
        : `Number ${i + 1} in line`;
  return place
    ? `${place}. The farm hands over the moment a lease ends — this page moves on by itself.`
    : 'Waiting for a device to free up. This page moves on by itself when one does.';
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
  /**
   * `missing` IS NOT A SESSION. `loadSessionDetail` stores `{ id, missing: true, message }` when the
   * read 404s, and this used to accept that object as a session because it has the right `id` — so
   * the header rendered "Session d946ed62 · undefined", the `undefined` being
   * `SESSION_STATE[undefined]?.label || sess.state`. A person sent a stale bring-up link saw a
   * screen that looked half-loaded rather than one that said what had happened.
   */
  const detail = state.detail?.id === id ? state.detail : null;
  const sess = detail && !detail.missing ? detail : null;
  const steps = bringupSteps(sess);
  const counted = steps.filter((s) => s.state !== 'skipped');
  const done = counted.filter((s) => s.state === 'done').length;
  const pct = counted.length ? Math.round((done / counted.length) * 100) : 0;
  const failed = steps.find((s) => s.state === 'failed');
  const device = sess?.deviceId ? deviceById(sess.deviceId) : null;

  return [
    pageHead(
      [{ label: 'Farm' }, { label: 'Launch', to: '#/launch' }],
      device ? `Bringing up ${deviceName(device)}` : 'Bringing up a device',
      sess
        ? `Session ${short(id)} \u00b7 ${(SESSION_STATE[sess.state] || {}).label || sess.state}`
        : detail?.missing
          // The bring-up screen is the one people are SENT a link to, so this is the sentence a
          // stale link lands on. It says which session and that it is gone, rather than looking
          // like a page still loading.
          ? `Session ${short(id)} is not visible to this org`
          : 'Asking the control plane for a device',
      h('div', { class: 'row tight' },
        btn('Cancel', 'ghost', () => cancelBringup(id)),
      ),
    ),

    state.acceptedHandover === id ? null : handoverNotice(sess),

    h('div', { class: 'bringup' },
      h('div', { class: 'bringup-stage' },
        /**
         * THE SAME FRAME THE COCKPIT WILL SHOW — document 04's continuity rule.
         *
         * This screen used to draw its own `.phone.big` div and mount the cockpit's `<video>`
         * inside it once the stream arrived, which meant a different element, a different shape and
         * a hard cut between the two screens at the exact moment the sequence was supposed to pay
         * off. `bringupStage` returns the one persistent element; appending it here MOVES it rather
         * than rebuilding it, so nothing is remounted and the decoder never restarts.
         *
         * THE PROGRESS RING IS GONE, and it is the same deletion as the cockpit's indeterminate
         * bar. `done / steps` is not a measurement of the wait: acquiring takes a second and
         * installing takes minutes, so "60%" implied a proportion the console has no basis for.
         * The frame's own state and the checklist beside it say exactly what is confirmed and what
         * is still waiting, which is everything a percentage was pretending to summarise.
         */
        bringupStage(sess, device, steps),
        h('p', { class: 'caption', text: device ? `${deviceName(device)} · Android ${device.osVersion}${geometryText(device) ? ` · ${geometryText(device)}` : ''}` : 'no device yet' }),
      ),

      h('div', { class: 'bringup-steps' },
        h('p', { class: 'micro', text: `Launching ${device ? deviceName(device) : 'a device'}` }),
        h('ul', { class: 'steplist' }, steps.map((s) => h('li', { class: `step ${s.state}${s.confirm ? ' confirm' : ''}` },
          /**
           * The outcome mark. 01 maps these three to `check`, `x` and `minus`.
           *
           * `pending` AND `waiting` DRAW NOTHING, which is the honest part. There is no glyph for
           * "we have not heard yet", and a spinner here would be a depiction of progress the
           * console cannot observe — the step's own pulse says it is waiting, and the words beside
           * it say what for.
           */
          h('span', { class: 'step-mark' },
            s.state === 'done' ? icon('check', 14)
              : s.state === 'failed' ? icon('x', 14)
                : s.state === 'skipped' ? icon('minus', 14)
                  : null,
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
 * One icon, at a size.
 *
 * THE GEOMETRY MOVED OUT. This used to be nineteen hand-drawn path strings in this file, and the
 * sidebar and the palette used Unicode characters instead — ▶ ■ ✚ ☰ ▤ ⋮ ◎ ☍ ● ⚙ — which is most of
 * why the chrome read as unfinished: those glyphs come from whatever font the platform picked, at
 * whatever weight and baseline it felt like, so the same nav looked different on every machine and
 * matched nothing else on the screen. `icons.js` is Lucide, generated and committed, on one 24px
 * grid at one stroke weight (ADR note in `build-icon-sprite.mjs`).
 *
 * 16px in nav and rails, 14px inline with label text, 20px in empty states. The default is the nav
 * size because that is where most of the calls are.
 */
function icon(name, size = 16) {
  return iconSvg(name, size);
}

/**
 * One toolbar button. `enabled` is passed rather than inferred, because every control on this bar
 * is gated on something different — a capability, an open data channel, a live session — and a
 * button that looks available and does nothing is the thing this console refuses to ship.
 */
function toolBtn(name, label, enabled, onclick, opts = {}) {
  /**
   * THE CAPABILITY GATE LIVES HERE, not at the call site — which is the whole of `RailControl`'s
   * contract: a control "cannot be constructed in an enabled state without the capability".
   *
   * It used to live at the call sites, as `caps.includes('screenshot') ? toolBtn(…) : null`, and
   * that had two failure modes rather than one. The control DISAPPEARED, so a person on a device
   * without `screenshot` saw a rail with a gap in it and no way to learn why — the same lie by
   * omission as filtering an absent capability out of the chip list, which this console has been
   * careful never to do. And because the gate was a ternary at the call site, the next control
   * added could simply forget it.
   *
   * `requires` + `declared` are passed instead, and the answer is computed once, here.
   */
  const missing = opts.requires && !(opts.declared || []).includes(opts.requires);
  const live = Boolean(enabled) && !missing;

  /**
   * TWO KINDS OF UNAVAILABLE, and the tooltip is the only thing that separates them.
   *
   * A missing capability is a PERMANENT PROPERTY of the device — no amount of waiting produces a
   * screenshot on a device that does not declare one — while a control waiting on the stream will
   * come good in a moment. Rendering both as "dimmed" and saying nothing leaves the reader unable
   * to tell "not yet" from "not ever", which is the distinction they most need.
   */
  const why = missing
    ? `${label} — this device does not declare ${opts.requires}. That is a property of the device, not a fault.`
    : enabled
      ? label + (opts.kbd ? ` (${opts.kbd})` : '')
      : `${label} — not available until the live view is connected.`;

  return h('button', {
    class: `devbtn${opts.active ? ' on' : ''}${missing ? ' undeclared' : ''}`,
    title: why,
    disabled: !live,
    onclick,
  },
    icon(name, 20),
    // The rail is icons, and an icon is not a name. This span is the only thing a screen reader
    // has to read, so it carries the REASON as well as the label when there is one.
    h('span', { class: 'sr', text: why }),
  );
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
/**
 * THE ONE CONTINUITY RULE — document 04.
 *
 * *"The stage element is never unmounted between bring-up and session. If it reloads, the illusion
 * that you watched THIS device arrive is gone, and with it most of the value of the sequence."*
 *
 * So the frame is built ONCE, here, and both screens append the same element. Appending a node that
 * already has a parent MOVES it — it is not recreated — so the device a person watched resolve out
 * of blur on the bring-up screen is the identical DOM element, with the identical `<video>` and its
 * identical decoder state, that they then drive in the cockpit.
 *
 * This used to be inlined in `stagePanel`, and the bring-up screen drew its own `.phone.big` div
 * instead: a different element, a different shape, and a hard cut between the two screens at the
 * exact moment the sequence was supposed to pay off.
 */
function ensureStage() {
  if (!state.stage) {
    /**
     * The video IS the frame's panel — it is passed into `buildFrame` rather than created by it.
     *
     * That is the continuity requirement, and it is the reason this element is created once here
     * and never again: a `<video>` that is destroyed and recreated drops its stream, re-attaches
     * `srcObject` and re-decodes. `render()` replaces the whole page every five seconds, so a
     * rebuilt panel is a visible stutter twice a minute on the one surface where smoothness is the
     * product. It also has to survive the transition from bring-up into the session, which is why
     * `DeviceStage` must not unmount between the two.
     *
     * It keeps `dev-video` alongside `mf-panel`: `live.js` finds the tap layer through this
     * element's parent, and the keyboard-routing checks match on that class.
     */
    const video = h('video', {
      id: 'device-video', class: 'dev-video mf-panel',
      autoplay: true, playsinline: true, tabindex: '0',
    });

    const dom = buildFrame(video);
    const overlay = h('div', { class: 'dev-overlay' });
    // Local echo of your own taps. `pointer-events: none`, so it can never intercept a gesture.
    // Inside the glass beside the video, because `live.js` reaches it as `video.parentElement`.
    const taps = h('div', { class: 'dev-taps' });
    dom.glass.append(overlay, taps);

    const toolbar = h('div', { class: 'devbar' });

    /**
     * The keyboard hint lives BELOW the phone, never on it.
     *
     * It was briefly drawn inside the bezel, and that was wrong twice over: it covered Android's
     * own navigation bar, and it sat exactly in the swipe-up gesture zone — so the one affordance
     * added to explain input was standing on top of the input. The punch-hole is the single
     * exception to that rule and is narrow on purpose; this hint is not in its category.
     *
     * A sibling of the caption rather than a child, because the caption is written with
     * `textContent` on every paint and would wipe it out.
     */
    const caption = h('p', { class: 'caption dev-caption-text' });
    const kbd = h('span', { class: 'dev-kbd', text: 'keyboard → device' });
    const captionRow = h('div', { class: 'dev-caption' }, caption, kbd);

    /**
     * The build's tile — beat 05. Created once with the frame rather than per render, for the same
     * reason as everything else in here: this element sits beside a `<video>` that must never be
     * rebuilt, and a node created on a five-second poll is a node destroyed on a five-second poll.
     */
    /**
     * D15 — IT IS A CHILD OF THE FRAME'S WRAPPER, and that is what makes "outside the frame" true.
     *
     * It used to be a sibling of `.dev-fit`, positioned `top: 6px` against the STAGE. The stage is
     * a flexible box and the frame is centred in it, so how far the frame's top edge sat below the
     * stage's depended on the viewport: roomy on a short screen, and on a tall one only about
     * twenty pixels — at which point a tile six pixels down overlapped the bezel it was supposed to
     * be waiting above. Seen on the lab, where it read as half-attached to the device.
     *
     * Anchored to `.dev-fit` — whose box IS the frame's box — `bottom: 100%` means "above the
     * frame" in every viewport, and the landing travel is measured from the same edge. Document 04
     * beat 05 is unambiguous that the two positions are outside and inside: "the tile waits outside
     * the frame — it does not enter until the worker confirms".
     */
    const tile = h('div', { class: 'dev-tile', hidden: true });
    const screenWrap = h('div', { class: 'dev-fit' }, dom.root, tile);

    const root = h('div', { class: 'devpanel' },
      toolbar,
      h('div', { class: 'dev-stage' }, screenWrap),
    );
    state.stage = {
      root, video, overlay, toolbar, caption, tile, zoom: 1,
      dom,
      // `frame` is the glass box: the inspector places its overlay against it, and it is the
      // element whose bounds are the device's own panel.
      frame: dom.glass,
      // Per-viewer, and remembered: someone comparing a screenshot against the device wants the
      // chrome gone, and wants it to stay gone on the next device they open. Wrapped because a
      // browser with site data blocked THROWS on read rather than returning null, and the panel
      // must still render for that viewer.
      chrome: readChromePref(),
      sheen: readSheenPref(),
    };
    root.appendChild(captionRow);
  }
  return state.stage;
}

function stagePanel(sess, live) {
  const device = deviceById(sess.deviceId);
  const caps = device?.capabilities || [];
  ensureStage();

  const st = state.stage;
  /**
   * A THIRD MODE, AND IT IS NOT COSMETIC — document 04 S4, and D10/D11.
   *
   * `session` and `bringup` were the only two, so a finished session was drawn exactly like a
   * running one: a full-height stage under a rail of controls, with the accounting — held for,
   * actions, artifacts, reset — pushed below the fold underneath a full-screen dead phone. The
   * design puts those numbers BESIDE the frame, and it says why: "the frame stays, dimmed and dark,
   * at flat elevation… keeping it is what makes the ended session read as a device you gave back
   * instead of a page that expired."
   *
   * QUEUED IS NOT ENDED. It has its own unresolved-frame treatment through `data-resolved`, and
   * conflating the two is the mistake `paintOverlay` above already had to be corrected for — a
   * person waiting in line was told their session had ended. The condition is the same one
   * `endedSummary` uses, deliberately, so the two cannot disagree about which sessions are over.
   */
  const ended = !live && sess.state !== 'QUEUED';
  st.root.dataset.mode = ended ? 'ended' : 'session';
  /**
   * THE BEAT DOES NOT FOLLOW THE ELEMENT INTO THE COCKPIT.
   *
   * This is the cost of the continuity rule: the frame is deliberately never unmounted, so every
   * attribute the bring-up screen put on it is still there when the cockpit takes it over. A
   * leftover `data-beat="2"` would hold the chassis flat and the contact ellipse at zero on a
   * session that is fully attached — the device would arrive in the cockpit looking like it had not
   * finished arriving.
   */
  delete st.root.dataset.beat;
  /**
   * AND NEITHER DOES THE TILE FOLLOW THE ELEMENT IN, for the same reason as the beat above it.
   *
   * `bringupStage` unhides the build's tile and nothing hid it again, so the element the cockpit
   * takes over could arrive still carrying the label from beat 05. Document 04's beat 06 settles
   * "the whole composition into the session layout", and a tile pinned above the frame is not part
   * of that layout — the installed build is already named by the chip in the header.
   */
  st.tile.hidden = true;
  paintToolbar(sess, live, caps);
  paintOverlay(sess, live, caps);
  paintFrame(device);

  st.caption.textContent = device
    ? `${deviceName(device)}${screenOf(device)} · Android ${device.osVersion} · ${sess.region || 'lab'}`
    : 'no device';
  return st.root;
}

/**
 * Shape, chrome and state, written as CSS custom properties so resizing costs no layout thrash.
 *
 * GEOMETRY COMES FROM THE DEVICE and the frame comes from the profile, and the two are never mixed.
 * The live socket's `screen` wins over the registered one because it is the panel the stream is
 * actually being encoded from; the registered one is what a card has before a session exists. If
 * the two ever disagree the DEVICE is right — drawing a shape the device is not is the one thing a
 * device-mirroring panel must never do.
 *
 * `frameFor` returns ONE SHAPE for all four cases, so there is no per-device branch left in here.
 * Adding a profile row gives a new device a correct frame with no change to this function at all —
 * which is the entire reason the resolver exists.
 */
function paintFrame(device) {
  const st = state.stage;
  applyFrame(st.dom, frameFor(device, state.live?.screen), {
    state: stageState(device),
    zoom: st.zoom,
    // Chrome off flattens the frame to a bare panel: one attribute, no re-layout of the video.
    sheen: st.chrome ? st.sheen : 0,
  });

  st.dom.root.dataset.chrome = st.chrome ? 'on' : 'off';
  st.root.dataset.chrome = st.chrome ? 'on' : 'off';
  st.root.dataset.hasChrome = hasChrome(device) ? 'yes' : 'no';
}

/**
 * Which of the four panel states this device is in.
 *
 * DEPTH IS A STATE VARIABLE, so this is not cosmetic: the shadow is shallow until the data plane
 * attaches and lands when it does, which is what makes the device visibly become physical at the
 * moment it becomes real. Get this wrong and the frame is merely a picture of a phone.
 *
 * IT READS `state.liveState`, NOT `state.live`. The first version tested for the LiveSession
 * OBJECT, which exists from the moment a socket is opened and says nothing about whether anything
 * is on the screen — so a cockpit mid-negotiation reported `off`, the shadow never landed, and the
 * whole mechanic silently did nothing while looking implemented. `liveState` is the actual state
 * machine and it is what the overlay beside this already reads.
 *
 * `nosignal` is decided by the DEVICE'S DECLARATION, never by a failure to connect. A device
 * without `screen-stream` is not broken and must not be drawn as though it were — input, logcat,
 * install and WebDriver all still work on it, and the panel says so in words. A negotiation that
 * FAILED is a different thing again, and it falls back to `off`: the overlay explains it, and
 * dressing a transient failure as a permanent property of the device would be the same lie in the
 * other direction.
 */
function stageState(device) {
  if (device && !(device.capabilities || []).includes('screen-stream')) return 'nosignal';
  if (state.liveState === 'streaming') return 'live';
  // The device declared a stream and the negotiation settled on there being no video after all.
  if (state.liveState === 'nostream' || state.liveState === 'nodisplay') return 'nosignal';
  // Opening the socket, authenticating, negotiating: alive, and nothing to show yet. The only
  // state in the system with a pulse, because it is the only one with no observable interior.
  if (state.liveState && state.liveState !== 'idle' && state.liveState !== 'failed'
      && state.liveState !== 'unrouted') return 'waking';
  return 'off';
}

/** Chrome preference, defaulting to shown, and never throwing on a browser that blocks site data. */
function readChromePref() {
  try {
    return localStorage.getItem('mfarm.chrome') !== 'off';
  } catch {
    return true;
  }
}

/**
 * The glass sheen, as a NUMBER the viewer can take to zero.
 *
 * It tints real pixels by 7% at the top edge, which is most of what makes the frame read as glass
 * rather than as a hole cut in a card — and which is unacceptable to anyone doing visual-comparison
 * work, where any tint over the framebuffer invalidates the comparison. A value rather than a
 * boolean so it is one property write and no branch.
 */
function readSheenPref() {
  try {
    const raw = localStorage.getItem('mfarm.sheen');
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.07;
  } catch {
    return 0.07;
  }
}

function setChromePref(on) {
  const st = state.stage;
  if (!st) return;
  st.chrome = on;
  try {
    localStorage.setItem('mfarm.chrome', on ? 'on' : 'off');
  } catch {
    // A viewer with site data blocked keeps the setting for this panel only. Losing a preference is
    // not worth failing the click over.
  }
  const device = deviceById(state.detail?.deviceId);
  paintFrame(device);
  paintToolbar(state.detail, true, device?.capabilities || []);
}

function setZoom(z) {
  const st = state.stage;
  if (!st) return;
  st.zoom = Math.min(2.5, Math.max(0.4, Number(z.toFixed(2))));
  // One property on the frame root; the six elements derive from it. No re-render, and no transform
  // on the video — which would pull the decoded frame onto the chassis's compositor layer.
  st.dom.root.style.setProperty('--f-zoom', String(st.zoom));
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
  /**
   * D11 — GONE, NOT DISABLED, and the distinction is the whole point.
   *
   * Every control below is drawn "visible and inert" when the device cannot honour it, and that is
   * right for a CAPABILITY gap: a struck-through Screenshot answers "why can I not screenshot
   * this?" with something the reader can see. It is wrong here. None of these will ever work again
   * for this session, whatever the device can do — the session is over — so a rail of eleven dimmed
   * buttons offers a menu of things that cannot happen and invites somebody to hunt for the reason
   * they are greyed out. Document 04 S4 is explicit: "the live view and controls are gone".
   *
   * Emptied rather than left stale, because the toolbar is a persistent element like everything
   * else on this stage: a rail painted for the last live session would otherwise survive into the
   * ended one.
   */
  if (!live && sess?.state !== 'QUEUED') { st.toolbar.replaceChildren(); return; }
  const streaming = state.liveState === 'streaming';
  const attached = ATTACHED.has(state.liveState);
  /**
   * Power/Back/Home/Overview need a device to send to, NOT a picture of it.
   *
   * This used to be `streaming && control.readyState === 'open'`, which tied four buttons to the
   * WebRTC datachannel — and a physical handset never negotiates one. The result was a phone whose
   * Volume and Rotate worked, beside a Home button that did nothing, because those two groups were
   * written against different transports and only one of them was gated on video.
   *
   * `pressButton` now falls back to the data-plane socket, so the honest gate is the same one
   * Volume and Rotate use: is this session attached to a device.
   */
  const ctrl = attached;

  const press = (cmd) => () => {
    if (!state.live?.pressButton(cmd)) toast('Not connected', 'The device control channel is not open yet.', 'warn');
  };
  const send = (msg) => () => state.live?.sendControl(msg);

  /**
   * `.filter(Boolean)` because the last entry is CONDITIONAL, and `replaceChildren` is not `add()`.
   *
   * `add()` skips null; the DOM does not — `replaceChildren(null)` appends the literal text "null".
   * The chrome toggle at the end of this list is `… : null` on an unprofiled device, so every
   * session on `cf-1`, `cf-2` or a physical handset drew the word `null` under the toolbar. Seen on
   * a real session 2026-08-31.
   *
   * Same shape as the crash in issue 37: a helper that handles the edge case, bypassed at one call
   * site. `paintOverlay` already carries this exact filter, which means somebody hit it once and
   * fixed only the site in front of them.
   */
  st.toolbar.replaceChildren(...[
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
    /**
     * VISIBLE AND INERT, never removed. A control the device cannot honour is drawn dashed and
     * dimmed with a tooltip naming the capability, so the absence is explained by something you can
     * SEE — document 04's rule, and the same reasoning that keeps an undeclared capability in the
     * chip list rather than filtering it out.
     */
    toolBtn('camera', 'Screenshot', Boolean(live), () => void takeScreenshot(),
      { kbd: 'S', requires: 'screenshot', declared: caps }),
    toolBtn('inspect', state.inspect.on ? 'Stop inspecting' : 'Inspect elements',
      streaming, () => void toggleInspect(),
      { active: state.inspect.on, requires: 'ui-hierarchy', declared: caps }),
    toolBtn('refresh', 'Reconnect', Boolean(live), () => reconnectLive()),
    h('span', { class: 'devbar-sep' }),
    /**
     * ZOOM AND FIT NEED THE STREAM, so they are gated on the CAPABILITY as well as the transport.
     *
     * Document 04 S2 names them alongside screenshot — "screenshot, zoom and fullscreen are struck
     * through in the rail because they need the stream" — and gating them on `streaming` alone gets
     * the wrong half of that. On a device that declares no `screen-stream` these can never work, and
     * a transport gate says "not available until the live view is connected": "not yet" for
     * something that is "not ever".
     *
     * That inaccuracy was INTRODUCED by the commit before this one. The buttons were dimmed with a
     * bare "Zoom in" title, which claimed nothing; adding a reason made them claim something false
     * on the one device where it matters. A better tooltip is worse than none if it is wrong.
     */
    toolBtn('zoomin', 'Zoom in', streaming, () => setZoom(st.zoom + 0.15),
      { requires: 'screen-stream', declared: caps }),
    toolBtn('zoomout', 'Zoom out', streaming, () => setZoom(st.zoom - 0.15),
      { requires: 'screen-stream', declared: caps }),
    toolBtn('fit', 'Fit to panel', streaming, () => setZoom(1),
      { requires: 'screen-stream', declared: caps }),
    /**
     * Hide the phone body — and with it the punch-hole, which is the only thing this console draws
     * over the device screen.
     *
     * OFFERED ONLY ON A DEVICE THAT HAS CHROME, and this is NOT the rule two controls above being
     * broken. The screenshot and inspector controls stay visible because a missing capability is a
     * fact about the device the reader needs told — "why can I not screenshot this?" is a question
     * somebody will otherwise ask the wrong person. There is no equivalent question here: an
     * unprofiled device has no body to hide, so the control's absence explains nothing because
     * there is nothing to explain. A struck-through "hide the body it does not have" would be
     * noise dressed as honesty.
     *
     * It is not gated on the stream: the body is drawn whether or not video has negotiated, so
     * hiding it has to work in exactly the state where someone is squinting at a black rectangle
     * wondering what is covering it.
     */
    hasChrome(deviceById(sess?.deviceId))
      ? toolBtn('phone', st.chrome ? 'Hide device body' : 'Show device body',
          true, () => setChromePref(!st.chrome), { active: st.chrome })
      : null,
  ].filter(Boolean));
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

  /**
   * A SESSION THAT ENDED SAYS WHO ENDED IT, WHEN, AND HOW LONG IT RAN.
   *
   * "Session ended" is the state, and the state is the least useful thing to tell somebody who is
   * looking at a screen that has stopped: they can see it stopped. What they cannot see is whether
   * they released it or the farm expired it, how much of their lease they used, and whether the
   * device came back clean. Every one of those is a fact the API already returns.
   *
   * The end reason is rendered from `endReason` rather than assumed — a lease that expired and a
   * device somebody released are different stories, and reading "released by you" about an expiry
   * would be a small lie in the one place a person is trying to work out what happened.
   */
  /**
   * WAITING IS NOT ENDING, and this branch used to call them the same thing.
   *
   * `live` is false for a QUEUED session — it has no device yet — so a queued session opened at
   * `#/sessions/<id>` was told "Session ended" about a session that has not started. The frame is
   * present but UNRESOLVED here, per document 04's queued state: it has not been allocated, so it
   * is not yet a real object and nothing about it firms up until a device is claimed.
   */
  if (!live && sess.state === 'QUEUED') {
    /**
     * THE COPY GOES OUTSIDE THE BLUR, and finding out why cost a screenshot.
     *
     * `filter: blur()` applies to every descendant, and the overlay lives inside the frame's glass
     * — so the first version of this put the sentence explaining the unresolved frame INSIDE the
     * unresolved frame, and rendered nine pixels of blur over its own explanation. The design
     * agrees and always did: its queued state draws the copy as a block BESIDE the frame, not on
     * it, because there is nothing on the panel to annotate yet.
     */
    st.root.dataset.resolved = 'no';
    st.overlay.replaceChildren();
    st.overlay.hidden = true;
    return;
  }
  st.root.dataset.resolved = 'yes';

  /**
   * THE SENTENCE MOVED OUT OF THE GLASS — D10's other half.
   *
   * It used to be rendered here, over the panel, and that was survivable while the ended stage was
   * full height. It is not now: the frame settles to about a third of that, and a paragraph
   * explaining who released the session and how long it ran does not belong inside a 300px-wide
   * phone whatever the height. Document 04 S4 draws it BESIDE the frame, with the numbers, and
   * `endedSummary` renders it there.
   *
   * The panel keeps the two words that label what you are looking at, which is all a dark screen
   * needs — the frame is a memento at this point, not a surface carrying an explanation.
   */
  if (!live) {
    return show(h('p', { class: 'micro', text: 'Session ended' }));
  }
  /**
   * NO LIVE VIEW IS A PROPERTY OF THE DEVICE, NOT A FAULT.
   *
   * This panel is otherwise identical to the ones above it that report a failure, so the words are
   * the only thing that separates "this cannot happen here" from "this went wrong". Naming what
   * DOES still work is the half that stops somebody abandoning a device that would have served
   * them perfectly well.
   */
  if (!canStream) {
    return show(
      // Amber, not grey: document 04 marks this state. It is not a fault, but it IS the reason the
      // panel is empty, and a grey line reads as a caption rather than as the answer.
      h('p', { class: 'micro warn-text', text: 'No live view' }),
      /**
       * `screen-stream` IS STRUCK WHERE IT IS NAMED, exactly as the capability chips on device
       * detail are struck and for the same reason: the strike is what makes "declares no" a thing
       * you can see rather than a sentence you have to parse. Three surfaces now use one visual for
       * one fact — the chip, the rail control, and this.
       */
      h('p', { class: 'help' },
        'This device declares no ',
        h('s', { class: 'mono', text: 'screen-stream' }),
        '. That is a property of the device, not a fault.'),
      /**
       * NAMED IN FULL, because the half-list was doing the opposite of its job. It read "Input,
       * logcat, install and WebDriver still work" and left out keyboard and launch — so a person
       * deciding whether this device was worth keeping read a shorter list of capabilities than the
       * device actually has. Document 04 S2 heads this "Everything else works" for that reason: the
       * point is not that some things work, it is that only the three needing pixels do not.
       */
      // A panel, not two more lines of the same paragraph — document 04 gives this its own box,
      // because it is the half that decides whether the device is worth keeping.
      h('div', { class: 'worksbox' },
        h('p', { class: 'worksbox-h', text: 'Everything else works' }),
        h('p', { class: 'caption', text: 'Input, keyboard, install, launch, logcat and WebDriver are all live. Screenshot, zoom and fullscreen are struck through in the rail because they need the stream.' })),
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
        h('p', { class: 'help', text: state.liveDetail || 'This device declares no screen-stream. That is a property of the device, not a fault.' }),
        h('p', { class: 'caption', text: 'Input, logcat, install and WebDriver still work.' }),
      );
    case 'failed':
    case 'unrouted':
      return show(
        h('p', { class: 'micro bad-text', text: 'The live view did not connect' }),
        h('p', { class: 'help', text: state.liveDetail || 'No reason was reported.' }),
        h('div', { class: 'row tight mt-sm' }, btn('Try again', 'primary', () => reconnectLive())),
      );
    /**
     * IDLE IS NOT PROGRESS, and this branch used to draw it as 80% of some.
     *
     * `ensureLive` returns without starting anything when the session carries no browser route to
     * the data plane, leaving `liveState` at its initial `idle` — and this switch's default arm
     * caught that alongside the three real negotiation states, so the panel showed a ring at 80%
     * and "Negotiating the media connection" for a connection that had not been attempted and
     * never would be. A bar that fills for something nobody is doing is precisely the motion this
     * console refuses to ship, and it contradicted the panel beside it, which was already saying
     * there were no data-plane coordinates.
     *
     * Named explicitly rather than left to the default, so the next state added to the machine
     * fails loudly here instead of being quietly reported as 80% done.
     */
    case 'idle':
      return show(
        h('p', { class: 'micro', text: 'No live view yet' }),
        h('p', { class: 'help', text: 'This session has no route to the data plane, so nothing is being negotiated. The device itself is held and WebDriver still works.' }),
      );

    /**
     * THE HANDSHAKE, AS TEXT — and the third invented percentage removed.
     *
     * This drew `progressRing(25 | 55 | 80)`: three hardcoded numbers standing in for socket
     * stages that have no extent to be a fraction of. Nothing measures how far through a WebRTC
     * negotiation you are — a candidate pair either forms or it does not — so "80%" was a picture
     * of a quantity that does not exist, and it sat on the one surface whose entire value is that
     * it does not do that.
     *
     * Document 04 beat 04 says how these belong: *"Sub-states (ICE, codec) read as a line of
     * machine text under the step, not as motion."* A breathing mark says the page is alive and the
     * words say what it is waiting for, which is the whole of what is known.
     */
    case 'connecting':
    case 'authenticated':
    case 'negotiating':
      return show(
        h('p', { class: 'row tight' },
          h('span', { class: 'dot warn breathe' }),
          h('span', { class: 'micro', text: 'Connecting the live view' })),
        h('p', { class: 'caption', text:
          state.liveState === 'connecting' ? 'Opening the data plane'
            : state.liveState === 'authenticated' ? 'Asking the device to stream'
            : 'Negotiating the media connection' }),
        h('p', { class: 'mono meta', text: `state: ${state.liveState}` }),
      );

    /**
     * An unrecognised state. It cannot be drawn as progress, because the one thing known about it
     * is that this file does not know what it means.
     */
    default:
      return show(
        h('p', { class: 'micro', text: 'Connecting' }),
        h('p', { class: 'help', text: state.liveDetail || `The live view reported "${state.liveState}", which this console does not have words for yet.` }),
      );
  }
}

/**
 * What happened to this session, in one sentence, from what the API actually reported.
 *
 * Three facts, and each is dropped rather than guessed when it is missing: who ended it, when, and
 * how long it ran. The device's fate is stated only for a virtual device, because it is only true
 * of one — a physical handset has no snapshot to be restored from, and telling somebody their
 * borrowed phone was "reset from its clean snapshot" would be inventing a reset that never
 * happened on the one kind of device where that matters most.
 */
function endedSentence(sess) {
  const device = deviceById(sess?.deviceId);
  /**
   * KEYED ON THE REASONS THE CONTROL PLANE ACTUALLY WRITES, not on a plausible set.
   *
   * Every string below is a literal passed to `release()` in `allocator.ts`, `sessions.ts` and
   * `webdriver.ts`, or set directly by a migration's sweep. A key that is merely likely — `expired`
   * rather than `timeout` — silently falls through to the generic word, and the panel then explains
   * nothing while looking as though it did.
   *
   * The unmapped case says "Ended" rather than printing the raw reason: a reader who meets
   * `session_not_created` learns nothing from it, and it is on the session's details table anyway,
   * as machine text, where it belongs.
   */
  const cause = {
    client_request: 'Released by you',
    webdriver_quit: 'Ended when your driver quit',
    timeout: 'The lease ran out',
    idle_timeout: 'Reclaimed by the farm after going idle',
    device_quarantined: 'Ended because the device was taken out of service',
    client_disconnect: 'Ended when the connection dropped',
    no_capacity: 'Ended before it started — no device was free',
    no_endpoint: 'Ended before it started — the device had no automation endpoint',
    session_not_created: 'Ended before it started — the device refused the session',
  }[sess?.endReason] || 'Ended';

  const at = sess?.endedAt ? new Date(sess.endedAt) : null;
  const clockAt = at && !Number.isNaN(at.getTime())
    ? ` at ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : '';
  const ran = sess?.startedAt && sess?.endedAt ? `, after ${lengthInWords(sess.startedAt, sess.endedAt)}` : '';

  // Virtual devices reset from a snapshot between tenants; a handset does not have one.
  const fate = !device || isRealDevice(device)
    ? 'The device is back in the pool.'
    : 'The device was reset from its clean snapshot and is back in the pool.';

  return `${cause}${clockAt}${ran}. ${fate}`;
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

/**
 * The package whose lines the 'app' scope keeps, or null when nothing is installed.
 *
 * Read from the session's own confirmed actions rather than held separately, so it cannot disagree
 * with what the Tools panel says is on the device.
 */
function scopedPackage() {
  const id = state.route.name === 'cockpit' ? state.route.id : state.held?.id;
  return id ? (installedOn(id)?.packageName ?? null) : null;
}

/**
 * Exported for the same reason `state` is: the log pane paints itself into a node rather than
 * through `render()`, so a screen-level test cannot see which lines survived. This IS the decision
 * worth testing — a filter that quietly hides an error is worse than no filter — and it is a pure
 * function of `state.log`, which makes it the right seam.
 */
export function visibleLog() {
  const { lines, filter, level, scope } = state.log;
  const needle = filter.trim().toLowerCase();
  const pkg = scope === 'app' ? scopedPackage()?.toLowerCase() : null;

  return lines.filter((l) => {
    if (level !== 'ALL' && !(LEVEL_SET[level] || []).includes(l.level)) return false;
    /**
     * SCOPE IS A NAME MATCH, AND IT IS NOT A PERFECT APP FILTER — which is why the control says
     * "This app" and the help text says what it really does.
     *
     * Android's log carries no package on a line; it carries a pid and a tag. Resolving the pid
     * would mean the worker reporting it and the protocol carrying it, and a pid changes every time
     * the app restarts. Matching the package name catches the framework's own lines about the app
     * (`ActivityManager`, `JobInfo`, install and launch) and any log the app tags with its own id;
     * it MISSES a line the app writes under a bare tag like `OkHttp`.
     *
     * ERRORS AND FATALS ARE NEVER HIDDEN by the scope, whoever wrote them. A crash in a system
     * service is very often the reason the app under test is misbehaving, and a filter that buries
     * it would make this control worse than no control.
     */
    if (pkg && l.level !== 'E' && l.level !== 'F' && !l.raw.toLowerCase().includes(pkg)) return false;
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
  /**
   * AN EMPTY PANE SAYS WHY IT IS EMPTY — D23's other half.
   *
   * The counter above already admits it is filtering ("260 hidden"), and that was not enough: the
   * thing a person looks at is the pane, and a blank pane reads as a broken feed however honest the
   * number beside it. This names the package, says no line mentions it, and points at the control
   * that fixes it — rather than leaving somebody to discover the scope buttons by accident.
   */
  const scopedOut = rows.length === 0 && state.log.lines.length > 0;
  body.replaceChildren(...(scopedOut
    ? [h('p', { class: 'help logempty' },
        state.log.scope === 'app'
          ? `No line in this log names ${scopedPackage() || 'the installed build'}. Many devices tag their lines with a class name rather than a package, so "Everything" is usually the one to read.`
          : 'Nothing in the log matches this filter.')]
    : rows.map((l) => h('div', { class: `logline l${l.level || 'X'}` },
        h('span', { class: 'log-t', text: l.time }),
        h('span', { class: 'log-l', text: l.level }),
        h('span', { class: 'log-g', text: l.tag }),
        h('span', { class: 'log-m', text: l.message }),
      ))));
  const count = $('logcount');
  if (count) {
    const total = state.log.lines.length;
    const hidden = total - rows.length;
    // Say how many lines are NOT on screen. A filtered pane that does not admit it is filtering is
    // how somebody concludes their app logged nothing.
    count.textContent = hidden > 0
      ? `${rows.length} / ${total} lines · ${hidden} hidden`
      : `${rows.length} / ${total} lines`;
  }
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
  const pkg = scopedPackage();
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
      /**
       * Scope, offered ONLY when there is a build to scope to. A "This app" button on a session
       * with nothing installed is a control that cannot do anything, and §27 does not allow one.
       */
      pkg ? h('div', { class: 'row tight' }, [['app', 'This app'], ['all', 'Everything']].map(([v, label]) => h('button', {
        class: `levelchip${state.log.scope === v ? ' on' : ''}`,
        title: v === 'app'
          ? `Lines mentioning ${pkg}, plus every error and fatal whoever wrote it`
          : 'Every line the device produced',
        onclick: () => { state.log.scope = v; paintLog(); },
      }, label))) : null,
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

/**
 * AN ACTION IN FLIGHT — document 04 S3, and the bar that had to go.
 *
 * THIS PANEL USED TO DRAW AN INDETERMINATE PROGRESS BAR while an action was queued, two lines
 * underneath its own caption promising "You will see the outcome, not a progress bar". The page
 * contradicted itself, and the bar was the half that was lying: the control plane cannot dial a
 * worker, so an app verb has exactly two reportable states — queued, and finished. A 32% sliver
 * sweeping left to right depicted progress that nobody had reported and nobody could report.
 *
 * Document 04 is explicit about it: *"There is no running state for this. The worker reports an
 * outcome when it is done, so the console shows you a queued verb and then a result — never a bar.
 * A filling bar here would be the one lie that discredits the other five."*
 *
 * WHAT REPLACES IT IS A BREATHING MARK, not a smaller bar. Something has to say the page is alive
 * and waiting rather than stuck — but it must not imply a position along a journey. A pulse has no
 * extent, so it cannot be read as 40% done.
 *
 * A REAL PERCENTAGE IS STILL WELCOME. If a byte count ever arrives on the action, the bar comes
 * back and is legitimate the moment it is measuring something. That is the whole rule: not "no
 * bars", but "no bar without a number behind it".
 */
/**
 * "YOU ASKED FOR AN X1 PRO. YOU HAVE AN UNPROFILED DEVICE." — document 08's handover panel.
 *
 * The other half of the substitution story. The Fleet's notice fires BEFORE you start, when the
 * only free device is the wrong shape and you still have a choice; this one fires AFTER, when a
 * session already holds a device that is not the class it asked for.
 *
 * WHEN IT CAN ACTUALLY HAPPEN, because a panel that cannot appear is worse than no panel. Since
 * ADR-0025 the console always constrains, so a console-started session cannot land here — the
 * allocator queues instead of substituting. What CAN: a session started by the CLI, a WebDriver
 * suite, or any caller that named a class and accepted a substitute, then opened in the console.
 * The data is `constraints->>'profile'`, which the API now returns as `requestedProfile`.
 *
 * NO NOTICE WITHOUT AN ASK. A caller that named no class asked for nothing in particular and
 * cannot have been disappointed, so `matchedProfile` gates the whole thing.
 */
function handoverNotice(sess) {
  if (!sess?.matchedProfile || !sess.deviceId) return null;
  const got = deviceById(sess.deviceId);
  if (!got) return null;

  const asked = sess.requestedProfile ?? null;
  const gotClass = got.profile ?? null;
  if (asked === gotClass) return null;

  // Name the class that was asked for, from any device that is in it — the profile id alone
  // ("mfarm-x1-pro") is an internal handle and the copy deck forbids it in prose.
  const exemplar = state.devices.find((d) => (d.profile ?? null) === asked);
  const askedName = exemplar ? deviceName(exemplar) : (asked || 'an unprofiled device');

  const gotShape = geometryText(got) ? `${got.screen.width} \u00d7 ${got.screen.height}` : 'a different screen';
  const askedShape = exemplar && geometryText(exemplar)
    ? `${exemplar.screen.width} \u00d7 ${exemplar.screen.height}` : null;

  return h('section', { class: 'card gate waiting' },
    h('p', { class: 'card-title', text: `You asked for ${askedName}. You have ${deviceName(got)}.` }),
    h('p', { class: 'help' },
      'Its screen is ', h('code', { text: gotShape }),
      askedShape ? [', not ', h('code', { text: askedShape })] : null,
      '. Everything works, but any layout you are testing will render differently.'),
    h('div', { class: 'row tight mt-lg' },
      // "Keep it" dismisses nothing — the session is already yours. It acknowledges, and the
      // acknowledgement is per-session so it does not come back on the next render.
      btn('Keep it', 'ghost', () => { state.acceptedHandover = sess.id; render(); }),
      btn(`Release and queue for ${askedName}`, 'primary', () => releaseAndRequeue(sess, exemplar)),
    ),
  );
}

/**
 * Give the wrong device back and ask again for the right class.
 *
 * TWO CALLS, IN THIS ORDER, and the order is the whole of it: release first, so the device this
 * person is not using goes back to the pool where somebody else can have it, and only then queue.
 * Queueing first would hold two devices' worth of capacity for one person.
 */
async function releaseAndRequeue(sess, exemplar) {
  try {
    await api(`/v1/sessions/${encodeURIComponent(sess.id)}`, { method: 'DELETE' });
    await refreshAll();
    if (exemplar) startSession(exemplar);
    else toast('Released', 'The class you asked for is not in this fleet any more.', 'warn');
  } catch (e) {
    toast('Could not release the device', e.message, 'bad');
  }
}

/**
 * WAITING, EXPLAINED — document 04's queued state.
 *
 * Beside the frame rather than on it: the frame is deliberately unresolved here, and a blur applies
 * to every descendant, so a sentence placed inside it would be blurred along with the thing it is
 * explaining. That is not a CSS accident to work around, it is the design's own arrangement — there
 * is nothing on the panel to annotate until a device is claimed.
 *
 * A POSITION, AND NO ESTIMATE. The rank is real: it is this session's place in the queue the
 * console already lists. The ETA is not, for the reason `fleetHeadline` and the queue card both
 * give — the soonest lease to expire is only an upper bound, because a holder can release early and
 * anyone ahead of you takes the device first. Three places now carry that reasoning and they must
 * not drift.
 */
function queuedNote(sess) {
  if (sess.state !== 'QUEUED') return null;
  const q = queuedSessions();
  const at = q.findIndex((x) => x.id === sess.id);
  const ahead = at > 0 ? at : 0;

  return h('section', { class: 'card gate waiting' },
    h('div', { class: 'card-head' },
      h('p', { class: 'card-title', text: at < 0
        ? 'Waiting for a device'
        : at === 0 ? 'Next in line' : `${ordinal(at + 1)} in line` }),
      h('span', { class: 'pill-at', text: `asked ${ago(sess.createdAt)}` })),
    h('p', { class: 'help' },
      ahead
        ? `${ahead} ${ahead === 1 ? 'session is' : 'sessions are'} ahead of you. `
        : 'You are first. ',
      'The farm hands a device over the moment a lease ends, and this page moves on by itself \u2014 '
      + 'there is nothing to press and nothing to watch for.'),
    h('p', { class: 'caption mt-md', text:
      'No estimate: the soonest lease to expire is only an upper bound, because a holder can '
      + 'release early and anyone ahead of you takes the device first.' }),
  );
}

/** `1st`, `2nd`, `3rd`. Small, and the alternative is "Position 3", which reads like a rank in a table. */
function ordinal(n) {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
}

/**
 * WHAT THE SESSION LEFT BEHIND — document 04 S4.
 *
 * Four numbers under a frame that stays exactly where it was. The frame not being replaced is the
 * point of the state, and it already behaves that way (`state.stage` is never unmounted); what was
 * missing is the accounting, and it is the accounting somebody actually wants: how much of the
 * lease they used, what they sent, what was kept, and whether the device came back clean.
 *
 * "reset from snapshot" IS NOT ASSUMED. Every device declares which of ADR-0012's three resets it
 * has, and a device with none is a real thing on this farm — writing "reset from snapshot" under a
 * session on an install-reset handset would be a sentence about a mechanism that did not run.
 *
 * And the offer at the end names the CLASS, not the device: ADR-0025 constrains allocation to a
 * class and promises nothing about which unit, so "Start another MFARM X1 Pro" is exactly the
 * promise the allocator can keep.
 */
function endedSummary(sess, live) {
  if (live || sess.state === 'QUEUED') return null;
  const device = deviceById(sess.deviceId);
  const acts = actionsFor(sess.id);
  const arts = state.artifacts.sessionId === sess.id ? state.artifacts.items : [];
  const reset = device ? resetStory(device) : 'not reported';

  const stat = (value, label) => h('div', { class: 'endstat' },
    h('span', { class: 'endstat-v tnum', text: value }),
    h('span', { class: 'endstat-l', text: label }));

  return h('section', { class: 'card ended' },
    /**
     * WHO ENDED IT, WHEN, AND HOW LONG IT RAN — document 04 S4's own copy, and it leads.
     *
     * "Session ended" is the state, and the state is the least useful thing to tell somebody
     * looking at a screen that has stopped: they can see it stopped. What they cannot see is
     * whether they released it or the farm expired it, how much of the lease they used, and whether
     * the device came back clean. It reads over the numbers rather than under them because it is
     * the sentence that makes them mean something.
     */
    h('p', { class: 'help ended-lead', text: endedSentence(sess) }),
    h('div', { class: 'endstats' },
      stat(duration(sess.startedAt || sess.createdAt, sess.endedAt), 'held for'),
      stat(String(acts.length), acts.length === 1 ? 'action' : 'actions'),
      stat(String(arts.length), arts.length === 1 ? 'artifact' : 'artifacts'),
      stat(reset === 'none declared' ? 'none' : reset.replace('-reset', ''),
        reset === 'none declared' ? 'no reset declared' : 'reset'),
    ),
    device && device.state === 'READY'
      ? h('div', { class: 'row tight mt-lg' },
          btn(`Start another ${deviceName(device)}`, 'primary', () => startSession(device)))
      // Not offered when the class has nothing free: the button would queue somebody who has just
      // finished, which is the "Join the queue" mistake from entry 51 in a different place.
      : device
        ? h('p', { class: 'caption mt-lg', text: `No ${deviceName(device)} is free right now. Starting one from the Fleet will queue you.` })
        : null,
  );
}

/** What a finished action is called, in the tense it finished in. */
const OUTCOME_VERB = { install: 'Installed', launch: 'Launched', uninstall: 'Uninstalled' };

function actionStatusStrip() {
  const a = state.action;
  if (!a) return null;
  const meta = ACTION_STATE[a.state] || { label: a.state, tone: '' };
  const queued = a.state === 'PENDING';

  // Only when the worker actually reports bytes. `bytesTotal` is not sent by any worker today, and
  // the panel above is the design until one does — see document 04 S3's "WITH BYTE PROGRESS".
  const measured = queued && a.bytesTotal > 0 && a.bytesDone >= 0;
  const pct = measured ? Math.round((a.bytesDone / a.bytesTotal) * 100) : null;

  /**
   * "confirmed by worker · 00:14 · 8.2s after queueing".
   *
   * The gap between asking and hearing back is the number worth showing: it is the heartbeat
   * interval a person is learning to expect, and it turns "that felt slow" into a figure. Computed
   * only when both timestamps exist — an action that finished without a `requestedAt` is a row
   * from before the column existed, and inventing a duration for it would be worse than omitting.
   */
  const gap = a.finishedAt && a.requestedAt
    ? (new Date(a.finishedAt) - new Date(a.requestedAt)) / 1000
    : null;

  return h('div', { class: 'inset actionstrip' },
    h('div', { class: 'row tight' },
      // `breathe` on a queued action, `live` never: `live` is the pulse that means "a stream is
      // arriving", and this is the opposite — nothing is arriving, and that is expected.
      h('span', { class: `dot ${meta.tone} ${queued ? 'breathe' : ''}`.trim() }),
      h('span', { class: 'secondary', text: queued
        ? `${KIND_LABEL[a.kind] || a.kind}ing ${a.app?.label || a.app?.packageName || short(a.appId)}`.replace(/^Installing/, 'Installing')
        : `${KIND_LABEL[a.kind] || a.kind} — ${meta.label.toLowerCase()}` }),
    ),
    queued
      ? [
        h('p', { class: 'meta', text: "Queued for the worker's next heartbeat." }),
        measured
          ? h('div', { class: 'stack tight mt-xs' },
              h('div', { class: 'bar' }, h('i', { style: { width: `${pct}%` } })),
              h('p', { class: 'meta tnum', text: `${bytes(a.bytesDone)} / ${bytes(a.bytesTotal)} · ${pct}%` }))
          : null,
      ]
      : [
        // The past-tense verb is the headline — "Installed", "Launched" — with the machine detail
        // underneath. Document 04's outcome block leads with what happened, not with who said so.
        h('p', { class: a.state === 'FAILED' ? 'meta bad-text' : 'meta ok-text',
          text: a.error || (a.state === 'DONE' ? `${OUTCOME_VERB[a.kind] || 'Done'}` : '') }),
        h('p', { class: 'meta tnum', text: [
          a.finishedAt ? new Date(a.finishedAt).toLocaleTimeString() : null,
          gap !== null ? `${gap.toFixed(1)}s after queueing` : null,
        ].filter(Boolean).join(' \u00b7 ') }),
      ],
    h('p', { class: 'meta', text: a.app?.packageName || short(a.appId) }),
  );
}

function toolsCard(sess, live) {
  const device = deviceById(sess.deviceId);
  const canInstall = (device?.capabilities || []).includes('app-install');
  const picked = state.apps.find((a) => a.id === state.pickedApp) || state.apps[0] || null;

  return card('Tools', {},
    // Three states, not two. `!live` was standing in for "ended" here exactly as it was in the
    // stage overlay, so a person waiting in the queue was told their session had ended.
    sess.state === 'QUEUED'
      ? h('p', { class: 'help', text: 'No device has been allocated yet, so there is nothing to send to. These become available the moment the farm hands one over.' })
      : !live
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
              /**
               * The second sentence is the one that earns its place.
               *
               * "You will see the outcome, not a progress bar" sets the expectation this console
               * is built around: the control plane cannot dial a worker, so an app verb has
               * exactly two reportable states — queued, and finished. A spinner between them would
               * be depicting progress nobody reported, which is the failure mode every other
               * sentence in this product is written to avoid.
               */
              h('p', { class: 'caption mt-sm', text: 'Each verb is queued and carried down on the worker’s next heartbeat, usually within 10 seconds. You will see the outcome, not a progress bar.' }),
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
      // The same crumb the found path uses. Two branches of one screen disagreeing about where
      // they live is a small thing that reads as the console not knowing where it is.
      pageHead([{ label: 'Fleet', to: '#/fleet' }, { label: 'Session' }], 'Session', null),
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
    /**
     * THE DEVICE IS THE TITLE, not the session's uuid — document 04 S1.
     *
     * "Session 3b97a8de" names the row in a table; the person on this screen is holding an MFARM X1
     * Pro and every decision they make here is about that device. The uuid does not disappear, it
     * moves one line down into the identity strip beside the OS and the geometry, which is where a
     * support message or a log line needs it anyway.
     *
     * Geometry comes from the DEVICE'S OWN REPORT via `geometryText` (ADR-0016), so a class whose
     * members disagreed would show it here rather than average it away.
     */
    pageHead(
      [{ label: 'Fleet', to: '#/fleet' }, { label: 'Session' }],
      device ? deviceName(device) : (sess.device || `Session ${short(sess.id)}`),
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

    h('div', { class: 'ident' },
      h('span', { class: 'mono', text: [
        short(sess.id),
        device ? `${device.platform} ${device.osVersion}` : null,
        device ? geometryText(device) : null,
        sess.region,
      ].filter(Boolean).join(' \u00b7 ') }),
    ),

    h('div', { class: 'card mb-gap' },
      h('div', { class: 'row' },
        app ? pill(`${app.label || app.packageName} ${app.versionName || ''}`.trim(), 'warn plain', {
          dot: false,
          title: 'Session-only. Releasing restores the clean snapshot and removes it.',
        }) : null,
        h('span', { class: 'spacer' }),
        live
          ? ticker('since', sess.startedAt || sess.createdAt, { prefix: 'running ', cls: 'caption' })
          // "ran 20 minutes", not "ran 20:00" — this sits beside a wall-clock time and the two
          // were indistinguishable.
          : h('span', { class: 'caption', text: `ran ${lengthInWords(sess.startedAt || sess.createdAt, sess.endedAt)}` }),
        copyrow(sess.id, 'Copy id'),
      ),
      live && sess.expiresAt ? h('div', { class: 'mt-md' }, leaseBlock(sess)) : null,
      // No Extend button: there is no endpoint that moves `expires_at`, and a button that silently
      // does nothing is worse than its absence.
      sess.endReason ? h('p', { class: 'caption mt-sm', text: `Ended: ${sess.endReason}` }) : null,
    ),

    h('div', { class: 'split' },
      h('div', { class: 'content' },
        queuedNote(sess),
        state.acceptedHandover === sess.id ? null : handoverNotice(sess),
        /**
         * D10 — THE STAGE AND THE ACCOUNTING, SIDE BY SIDE ON AN ENDED SESSION.
         *
         * Sequenced one under the other for a live session, which is right: there the stage is the
         * thing and nothing competes with it. On an ended one the numbers ARE the content and the
         * frame is the memento, so the two share a row and both are above the fold — which is what
         * document 04 S4 draws.
         */
        (() => {
          const stage = stagePanel(sess, live);
          const summary = endedSummary(sess, live);
          return summary ? h('div', { class: 'endedwrap' }, stage, summary) : stage;
        })(),
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
    h('span', { class: 'drop-icon' }, icon('upload', 20)),
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
              h('span', { class: 'secondary', text: `Holding ${deviceLabel(held)} · session ${short(held.id)}` })),
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
          btn('Go to the Fleet', 'ghost', () => go('#/fleet')),
        ),
  );
}

function appsSubtitle() {
  const n = state.apps.length;
  const builds = `${n} build${n === 1 ? '' : 's'}`;
  const held = heldSession();
  if (!held) {
    return `${builds}. Installs live only inside a session, so hold a device before any of these can go anywhere.`;
  }
  const device = deviceById(held.deviceId);
  if (device && !(device.capabilities || []).includes('app-install')) {
    // Said here rather than discovered one disabled button at a time.
    return `${builds}. You are holding ${deviceLabel(held)}, which does not declare app-install — the API will refuse install, launch and uninstall on it.`;
  }
  return `${builds}. You are holding ${deviceLabel(held)}, so any of these can be installed now.`;
}

function buildRow(a) {
  const held = heldSession();
  const device = held ? deviceById(held.deviceId) : null;
  const canInstall = (device?.capabilities || []).includes('app-install');
  const on = held && installedOn(held.id)?.id === a.id;

  /**
   * A BUILD THAT FAILED TO INSTALL SAID "NOT INSTALLED" AND OFFERED "INSTALL" — document 05 §04's
   * third row, which is the one that carries information the other two do not.
   *
   * The failure was on the page, in `failureCard`, and that card is deliberately scoped to the last
   * thirty minutes so a failure from last Tuesday does not sit at the top of Apps forever. The
   * consequence nobody had noticed: after thirty minutes the failure vanished entirely and the row
   * beneath it looked exactly like a build nobody had ever tried. "Not installed" and "tried, and
   * the worker refused it" are different facts, and only one of them tells you to read the error
   * before pressing the button again.
   *
   * The ROW is the right home for it because the row is per-build and survives; the card is
   * per-event and should not.
   */
  const lastForBuild = state.actions.find((x) => x.appId === a.id && x.kind === 'install');
  const failed = lastForBuild?.state === 'FAILED' ? lastForBuild : null;

  return h('div', { class: 'buildrow' },
    h('div', { class: 'idc stack tight' },
      h('p', null, h('span', { class: 'buildname', text: a.label || a.packageName }), ' ',
        h('span', { class: 'secondary', text: a.versionName || (a.versionCode == null ? '' : `code ${a.versionCode}`) })),
      h('p', { class: 'caption', text: `${a.packageName} · ${bytes(a.sizeBytes)}${a.minSdk ? ` · minSdk ${a.minSdk}` : ''}` }),
    ),
    h('span', { class: 'caption', text: ago(a.createdAt) }),
    on
      ? h('span', { class: 'row tight' }, h('span', { class: 'dot ok' }), h('span', { class: 'ok-text', text: `Installed · ${deviceLabel(held)}` }))
      : failed
        ? h('span', { class: 'stack tight' },
            h('span', { class: 'row tight' },
              h('span', { class: 'dot bad' }),
              h('span', { class: 'bad-text', text: `Install failed ${ago(failed.finishedAt || failed.requestedAt)}` })),
            // The worker's own words, rendered as TEXT — this string came off a device via adb and
            // is the most attacker-influenced value on the page.
            failed.error ? h('span', { class: 'caption', text: failed.error }) : null)
        : h('span', { class: 'caption', text: 'Not installed' }),
    h('span', { class: 'spacer' }),
    h('div', { class: 'rowactions' },
      on
        ? [btn('Launch', 'primary', () => runAction(a, 'launch'), { disabled: !canInstall }),
           btn('Uninstall', 'ghost', () => runAction(a, 'uninstall'), { disabled: !canInstall })]
        // "Retry", not "Install", when the last attempt failed: the label is the difference between
        // a first try and a second one, and a person who has read the error deserves a button that
        // acknowledges they have.
        : btn(failed ? 'Retry' : 'Install', 'primary', () => runAction(a, 'install'), {
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
    h('p', { class: 'help', text: `The worker could not ${f.kind} ${app?.packageName || short(f.appId)} on ${deviceById(f.deviceId) ? deviceName(deviceById(f.deviceId)) : short(f.deviceId)}.` }),
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
    /**
     * The sub names the ACTIONABLE fact — document 05 §04 heads this screen "4 builds · you are
     * holding MFARM X1 Pro, so any of these can be installed now". Whether you are holding a device
     * decides whether every button below is live, so it is the first thing worth saying.
     */
    pageHead([{ label: 'Farm' }], 'Apps', appsSubtitle()),
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

/**
 * The Sessions route, which is now the Fleet's `live` lens with a page header on it.
 *
 * SPLIT RATHER THAN COPIED. A lens that reimplemented this table would be a second thing to keep
 * correct, and the two would disagree the first time somebody fixed a column in one of them — which
 * is precisely the four-places-to-keep-consistent problem the Fleet surface exists to end.
 */
function screenSessions() {
  return [
    pageHead([{ label: 'Farm' }], 'Sessions',
      'Every session this org has opened, newest first. A WebDriver suite creates these too.'),
    screenSessionsBody(),
  ];
}

/**
 * THE SESSIONS THIS FARM IS ACTUALLY RUNNING — one predicate, used by the Fleet's Live badge AND by
 * its table (D22).
 *
 * They disagreed. The badge counted live sessions; the table rendered `state.sessions` entire, so
 * the Live lens listed fifty ENDED rows under a tab showing no number. Two answers to one question,
 * derived from two places, which is the shape this console keeps having to fix — and the fix is
 * always to make the second one impossible rather than to correct it.
 */
const liveSessions = () => state.sessions.filter((s) => LIVE_SESSION_STATES.has(s.state) && s.deviceId);

/**
 * `rows` defaults to every session, because `#/sessions` IS the history and should stay so. Only
 * the Fleet's Live lens narrows it — that lens answers "what is running right now", and the page it
 * shares a body with answers something else.
 */
function screenSessionsBody(rows = state.sessions) {
  return [
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
                h('td', { text: deviceLabel(s) }),
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
/**
 * How a run's outcome reads, and the one distinction it must never blur.
 *
 * A run with no reported tests has NOT passed. Nobody measured it. WebDriver has no concept of an
 * assertion, so unless the suite called `POST /v1/sessions/:id/result` the farm knows only that
 * some sessions opened and closed — and rendering that as a green "0 failed" would put a
 * reassuring number on a run that was never checked, which is the exact inference the whole
 * outcome-reporting design refuses to make.
 *
 * So: "Not reported", in words, with the link to how to fix it.
 */
function runOutcome(run) {
  const t = run.tests || { total: 0, passed: 0, failed: 0, skipped: 0, sessionsReporting: 0 };
  if (t.total === 0) {
    return h('span', {
      class: 'caption', text: 'Not reported',
      title: 'Your suite has not reported any outcomes. The farm does not run your tests and '
        + 'cannot judge them — add a POST /v1/sessions/:id/result call to your afterEach.',
    });
  }
  return h('span', { class: 'row tight' },
    t.failed > 0 ? pill(`${t.failed} failed`, 'bad') : pill('all passed', 'ok'),
    h('span', { class: 'caption tnum', text: `${t.passed}/${t.total}` }),
    t.skipped > 0 ? h('span', { class: 'caption', text: `${t.skipped} skipped` }) : null,
  );
}

/**
 * The caveat that belongs next to any partially-reported run.
 *
 * Reported only when it is true and interesting: some sessions spoke and others did not, so the
 * counts describe part of the run. Silence about that would make a partial pass look like a whole
 * one.
 */
function runPartialNote(run) {
  const t = run.tests || {};
  const reporting = t.sessionsReporting ?? 0;
  const total = run.sessions?.total ?? 0;
  if (!t.total || reporting === 0 || reporting >= total) return null;
  return h('p', { class: 'caption',
    text: `Only ${reporting} of ${total} sessions reported results — these counts cover part of the run.` });
}

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
              ['Run', 'Tests', 'Build', 'Sessions', 'Live', 'Started', 'Last activity', ''].map((t) => h('th', { text: t })))),
            h('tbody', null, rows.map((r) => h('tr', null,
              h('td', null, h('code', { text: r.runId })),
              h('td', null, runOutcome(r)),
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
            'Add mfarm:runId to your suite\'s capabilities — any id your CI already has will do. '
            + 'The farm groups sessions by it; it does not run your tests and cannot judge them.'),
    ),
    h('p', { class: 'caption mt-md',
      text: 'Pass and fail come from the suite, never from the farm — WebDriver has no concept of '
        + 'an assertion. A run reading "Not reported" ran, but nothing told us how it went: post to '
        + '/v1/sessions/:id/result from an afterEach.' }),
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
      runStat('Tests', runOutcome(run),
        run.tests?.total
          ? `${run.tests.sessionsReporting} of ${run.sessions.total} sessions reported`
          : 'The suite has to tell us; the farm cannot see assertions'),
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
    runPartialNote(run),

    // Failures first, above the session list. The reason somebody opened this page is on this card,
    // and each row carries the session that produced it — which is where its logcat and screenshot
    // live. That link is the whole payoff of runs plus outcomes.
    d.failures?.length
      ? card(`Failures (${d.failures.length})`, { class: 'mb-gap' },
          h('div', { class: 'stack' }, d.failures.map((f) => h('div', { class: 'stack tight' },
            h('p', { class: 'row tight' },
              pill('failed', 'bad'),
              h('strong', { text: f.name }),
              // What KIND of failure, when the suite said (spec §18). Absent when it did not, and
              // absent is NOT the same as "the product's fault" — see `failureLabel`.
              f.failureClass ? failureTag(f.failureClass, f.failureReason) : null,
            ),
            f.failure
              ? h('pre', { class: 'failtext', text: f.failure })
              : h('p', { class: 'caption', text: 'No message was reported with this failure.' }),
            h('p', { class: 'row tight' },
              h('span', { class: 'caption', text: 'Evidence:' }),
              btn('Open the session', 'tiny ghost', () => go(`#/sessions/${f.sessionId}`)),
            ),
          ))))
      : null,

    /**
     * What the FARM saw, as its own card (spec §18).
     *
     * SEPARATE FROM THE FAILURES ABOVE, deliberately. Merging them would mean attaching each
     * incident to whichever test happened to be running and calling that test infrastructure —
     * a claim the farm cannot support, and wrong often enough to matter: a test can genuinely fail
     * an assertion during a session that also had a cable glitch. Side by side, a person reads
     * "eleven failures, and the phone dropped off USB twice" and draws their own conclusion.
     *
     * It renders even when there are no failures at all, because "nothing failed but the farm had
     * three incidents" is a real and important state — it is a run that should be re-read with
     * suspicion rather than trusted.
     */
    d.incidents?.length
      ? card(`What the farm saw (${d.incidents.length})`, { class: 'mb-gap' },
          h('p', { class: 'help' },
            'Problems MFARM detected with the device or the harness during this run. These are not '
            + 'test failures, and they are not counted as any. A failure above that overlaps one of '
            + 'these is worth re-running before it is believed.'),
          h('div', { class: 'stack mt-md' }, d.incidents.map((i) => h('div', { class: 'row tight' },
            failureTag(i.class, i.reason),
            h('span', { class: 'caption mono', text: i.device || '—' }),
            h('span', { class: 'caption', text: i.detail || FAILURE_REASON_LABEL[i.reason] || i.reason }),
            h('span', { class: 'caption', text: ago(i.occurredAt) }),
          ))))
      : null,

    card('Sessions', { class: 'flush' },
      d.sessions.length
        ? h('div', { class: 'tablewrap' }, h('table', { class: 'table wide' },
            h('thead', null, h('tr', null,
              ['State', 'Session', 'Tests', 'Device', 'Build', 'Started', 'Duration', ''].map((t) => h('th', { text: t })))),
            h('tbody', null, d.sessions.map((sn) => {
              const st = SESSION_STATE[sn.state] || { label: sn.state, tone: '' };
              return h('tr', null,
                h('td', null, pill(st.label, st.tone, { live: sn.state === 'ACTIVE' })),
                h('td', null, h('code', { text: sn.id })),
                h('td', null, sn.tests?.total
                  ? h('span', { class: 'row tight' },
                      sn.tests.failed > 0
                        ? pill(`${sn.tests.failed} failed`, 'bad')
                        : pill('passed', 'ok'),
                      h('span', { class: 'caption tnum', text: `${sn.tests.passed}/${sn.tests.total}` }))
                  : h('span', { class: 'caption', text: 'Not reported' })),
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

/** The Queue route, which is the Fleet's `waiting` lens with a page header on it. */
function screenQueue() {
  const waiting = queuedSessions();
  const holding = state.sessions.filter((s) => LIVE_SESSION_STATES.has(s.state) && s.deviceId);
  return [
    pageHead([{ label: 'Operations' }], 'Queue',
      `${holding.length} device${holding.length === 1 ? '' : 's'} held · ${waiting.length} waiting`),
    screenQueueBody(),
  ];
}

function screenQueueBody() {
  const waiting = queuedSessions();
  const holding = state.sessions.filter((s) => LIVE_SESSION_STATES.has(s.state) && s.deviceId);
  const mine = heldSession();

  return [
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

/**
 * WHAT THE FARM LAST CONFIRMED ABOUT THIS DEVICE, AND WHEN — D1, and document 05 §06's per-device
 * line: "MFARM X1 Pro · check passed 4m ago", "SM-S918B · check failed 2d ago".
 *
 * THE WORDS ARE NOT THE DESIGN'S, AND THAT IS THE POINT. "Check passed" would overclaim: this farm
 * runs a health check in exactly one place — `complete_recovery`, when a released quarantine is
 * asked to prove itself (migration 035) — and not on a periodic sweep of healthy devices. What it
 * DOES record for every device is `last_reset_at`, stamped both by that passing check and by a
 * worker confirming a snapshot restore. Both mean the same thing to a reader of this page: the last
 * moment the farm was willing to hand this device to somebody. So the age is the design's, and the
 * verb is the one the farm can stand behind.
 *
 * THE FAILING SIDE IS THE DESIGN'S, VERBATIM, because there it is exactly true: a device carrying
 * `quarantine.source === 'health'` failed a check, and that is what the row says.
 *
 * "No check recorded" is a real answer and not a gap. A device registered and never reset — the
 * handset whose host stopped beating on 2026-08-29 is one — has nothing to report, and saying so is
 * more use than a dash.
 */
function lastCheck(d) {
  if (d.quarantine?.at && d.quarantine.source === 'health') {
    return { text: `check failed ${ago(d.quarantine.at)}`, tone: 'bad' };
  }
  // Quarantined by a host or an operator is not a failed check, and calling it one would send
  // somebody to look at a device that is fine — the same mistake the fleet already had to unlearn.
  if (d.quarantine?.at) {
    return {
      text: `${d.quarantine.source === 'host' ? 'host stopped beating' : 'taken out of service'} ${ago(d.quarantine.at)}`,
      tone: 'bad',
    };
  }
  if (d.resetEscalation?.at) {
    return { text: `reset gave up ${ago(d.resetEscalation.at)}`, tone: 'bad' };
  }
  if (d.lastResetAt) return { text: `reset confirmed ${ago(d.lastResetAt)}`, tone: 'ok' };
  return { text: 'no check recorded', tone: '' };
}

function screenHealth() {
  const byState = {};
  for (const d of state.devices) byState[d.state] = (byState[d.state] || 0) + 1;
  const dayAgo = Date.now() - 86_400_000;
  const failures = state.actions.filter((a) => a.state === 'FAILED' && new Date(a.finishedAt || a.requestedAt) > dayAgo);
  const active = state.sessions.filter((s) => LIVE_SESSION_STATES.has(s.state)).length;

  /**
   * A COUNT THAT IS BAD NEWS CARRIES THE BORDER — document 05 §06 draws the failed-actions card
   * with a red edge and the other two plain.
   *
   * The dot alone put the severity inside the card, where it competes with the number; the edge
   * puts it on the card, so a page of five stats says which one to read first from across the room.
   * Only when the count is non-zero: a red border around "0 failed" would be the alarm that cries
   * wolf, which is the thing this console keeps deleting.
   */
  const stat = (label, value, tone, note) => card(null, {
    class: `stat stack tight${tone === 'bad' && value !== '0' ? ' stat-bad' : ''}`,
  },
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
                  /**
                   * D9 — THE NAME IS A LINK HERE TOO.
                   *
                   * This page named a device whose health check had failed and then offered no way
                   * to reach it: the reader had to memorise a short id, go to the Fleet, and find
                   * it again. The Fleet solved this by making the whole name block the target
                   * (`fleet-open`), and there is no reason for the operator's page to be the one
                   * surface where a named device is not openable — so it is the same control, not
                   * a second design.
                   */
                  h('button', {
                    class: 'row tight idc fleet-open', type: 'button',
                    title: `Open ${deviceName(d)}`,
                    onclick: () => go(`#/devices/${d.id}`),
                  },
                    h('span', { class: `dot ${st.tone} ${d.state === 'READY' ? 'live' : ''}`.trim() }),
                    h('span', { class: 'secondary', text: deviceName(d) }),
                    h('code', { class: 'caption', text: short(d.id) }),
                  ),
                  h('span', { class: 'caption', text: `${d.platform} ${d.osVersion} · ${d.tier} · ${d.region}` }),
                  h('span', { class: 'spacer' }),
                  /**
                   * D1 — THE OUTCOME AND ITS AGE, which is what document 05 §06 puts on this row and
                   * the one thing a state pill cannot carry. "Available" says a device can be
                   * handed over; it does not say whether the farm has confirmed that in the last
                   * four minutes or has not heard from it since August.
                   */
                  (() => {
                    const c = lastCheck(d);
                    return h('span', { class: `caption${c.tone === 'bad' ? ' bad-text' : c.tone === 'ok' ? ' ok-text' : ''}`, text: c.text });
                  })(),
                  /**
                   * AND THE ONE ACTION THIS PAGE CAN HONESTLY OFFER — with both of its gates.
                   *
                   * ADMIN, because `release-quarantine` is an admin route: a member pressing this
                   * gets a 403, which is a control offered on a premise that is false for them.
                   * Device detail has always gated it this way; the Fleet row does not, and that is
                   * a separate row to fix rather than a pattern to copy.
                   *
                   * NOT ON A HOST-SOURCED QUARANTINE, which is entry 54's defect and the reason
                   * this is a condition and not a button. That device comes back on its own when
                   * its host beats again; authorising a recovery asks the host that is not
                   * answering, and migration 035's timeout then re-quarantines it with a new
                   * reason. Device detail draws the whole nuanced panel for that case, so this row
                   * sends nobody down a path it cannot explain in one word.
                   */
                  d.state === 'QUARANTINED' && d.quarantine?.source !== 'host' && isOrgAdmin()
                    ? btn('Recover', 'tiny ghost', () => askReleaseQuarantine(d))
                    : null,
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
        /**
         * NAMED AND MARKED — document 05 §06: *"Health's most valuable panel is the one that says
         * what the console cannot see... Keeping this panel is the point. An observability page
         * that implies it sees everything is worse than one that names its blind spot."*
         *
         * It was a plain card called "Worker", which reads as one more section. The design gives it
         * the amber edge every other "read this" surface in the console has, and a title that says
         * what it is for rather than what it is about.
         */
        card('What this page cannot see', { class: 'gate waiting' },
          // The heartbeat is the number this screen most wants, and POST /v1/workers/heartbeat is
          // the only route that touches it — worker-authenticated and write-only. There is no read
          // endpoint for host state, so this says so instead of showing a dot that means nothing.
          h('p', { class: 'help', text: 'Worker heartbeat and host state are not readable from the console: the only heartbeat route is the workers’ own write path, and the API exposes no host read endpoint.' }),
          /**
           * HOW TO RECOGNISE IT ANYWAY, which is the half that makes naming the blind spot useful.
           *
           * "Its devices leave READY" is true of a quarantine too, so on its own it does not tell
           * anybody which of the two they are looking at. The distinguishing clause is that nobody
           * quarantined them — a fleet losing devices with an empty quarantine history is a dead
           * host, and that is a diagnosis somebody can act on from this screen.
           */
          h('p', { class: 'caption mt-sm', text: 'A dead host shows up indirectly, as devices leaving READY without anybody quarantining them.' }),
        ),
        activityCard(),
      ),
    ),
  ];
}

/* ---------------------------------------------------------------------------- palette */

/**
 * Everything the palette can do, in two groups and never interleaved.
 *
 * GO TO is a destination and DO is a verb, and 06 is firm that they do not mix: a list where
 * "Open Devices" sits between "Start a device" and "Release your device" makes Enter a keystroke
 * you have to read before pressing. `group` is what `renderPalette` sorts on.
 */
function commands() {
  const held = heldSession();
  const list = [
    { icon: 'launch',   label: 'Launch a device', group: 'Go to', run: () => go('#/launch') },
    { icon: 'devices',  label: 'Open Devices', group: 'Go to', run: () => go('#/devices') },
    { icon: 'apps',     label: 'Open Apps', group: 'Go to', run: () => go('#/apps') },
    { icon: 'sessions', label: 'Open Sessions', group: 'Go to', run: () => go('#/sessions') },
    { icon: 'runs',     label: 'Open Runs', group: 'Go to', run: () => go('#/runs') },
    { icon: 'queue',    label: 'Open Queue', group: 'Go to', run: () => go('#/queue') },
    { icon: 'health',   label: 'Open Farm health', group: 'Go to', run: () => go('#/health') },
  ];
  if (held) {
    list.unshift({ icon: 'sessions', label: 'Open your session cockpit', group: 'Go to', run: () => go(`#/sessions/${held.id}`) });
    list.push({ icon: 'power', label: 'Release your device', group: 'Do', run: () => askRelease(held) });
  }
  // Offered only where they would work. A palette entry for a capability the device lacks is the
  // same lie as a button for one.
  if (state.route.name === 'cockpit' && state.live) {
    const dev = deviceById(state.detail?.deviceId);
    const caps = dev?.capabilities || [];
    if (caps.includes('screenshot')) list.push({ icon: 'camera', label: 'Take a screenshot', group: 'Do', run: () => void takeScreenshot() });
    if (caps.includes('logcat')) list.push({ icon: 'logcat', label: state.log.streaming ? 'Pause logcat' : 'Resume logcat', group: 'Do', run: () => toggleLogcat() });
  }
  /**
   * Device results carry a FRAME rather than an icon — the same component at its smallest size.
   *
   * 12px is small enough to sit inside a result row and large enough that the aspect ratio reads,
   * which is all it has to do: it identifies WHICH device visually, beside a name that identifies
   * which one verbally.
   */
  for (const d of state.devices) {
    if (d.state === 'READY') {
      list.push({ frame: d, label: `Start ${deviceName(d)}`, note: classFreeText(state.devices, d), group: 'Do', run: () => startSession(d) });
    }
    list.push({ frame: d, label: `Open ${deviceName(d)}`, note: geometryText(d), group: 'Go to', run: () => go(`#/devices/${d.id}`) });
  }
  /**
   * LAUNCH LIVES HERE NOW, not in the nav — document 06: the palette is *"the fastest path to
   * everything, and the reason Launch does not need to be a route"*.
   *
   * The nav item is gone, the ROUTE is not. Typing a device name already offers to start it, and
   * that covers the ordinary case; what it does not cover is the one thing the Launch screen
   * uniquely does — choose a build so it is installed BEFORE you arrive at the cockpit. Deleting
   * the nav item without relocating that would have removed a capability rather than moved it,
   * which is the objection that kept the item for three weeks.
   */
  list.push({
    icon: 'launch', label: 'Start a device with a build installed', group: 'Do',
    note: 'picks the class and the APK, then hands you the cockpit',
    run: () => go('#/launch'),
  });
  list.push({ icon: 'upload', label: 'Upload an APK', group: 'Do', run: () => { go('#/apps'); setTimeout(() => $('apk-input')?.click(), 60); } });
  list.push({
    icon: 'copy', label: 'Copy the WebDriver URL', group: 'Do',
    run: async () => {
      try { await navigator.clipboard.writeText(webdriverUrl()); toast('Copied the WebDriver URL', webdriverUrl(), 'ok'); }
      catch { toast('Could not copy', 'The clipboard was refused. Select the text instead.', 'bad'); }
    },
  });
  list.push({ icon: 'collapse', label: 'Toggle the sidebar', group: 'Do', run: () => $('navtoggle').click() });
  return list;
}

/**
 * The matching commands, IN THE ORDER THEY ARE DRAWN.
 *
 * The grouping happens here rather than in `renderPalette`, and that is the whole point: the arrow
 * keys walk this array by index, so a palette that sorted only for display would highlight one row
 * and run another. One order, produced once, read by both.
 *
 * `.sort` is stable in every engine this console runs in, so within a group the commands keep the
 * order `commands()` built them in — which is the order they were reasoned about.
 */
function paletteMatches() {
  const q = $('palette-input').value.trim().toLowerCase();
  const all = commands();
  const hits = q
    ? all.filter((c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q))
    : all;
  return hits.sort((a, b) => PALETTE_GROUPS.indexOf(a.group) - PALETTE_GROUPS.indexOf(b.group));
}

/**
 * TWO GROUPS, AND THEY DO NOT INTERLEAVE.
 *
 * `GO TO` is a destination, `DO` is a verb, and 06 is firm about keeping them apart: in a flat list,
 * "Open Devices" sits between "Start a device" and "Release your device", so Enter becomes a
 * keystroke you have to READ before pressing. Separated, the shape of the list tells you which kind
 * of thing you are about to do before you have read a word of it.
 *
 * Destinations first, because they are the safe half — an accidental Enter navigates rather than
 * allocating hardware.
 */
const PALETTE_GROUPS = ['Go to', 'Do'];

function renderPalette() {
  const items = paletteMatches();
  if (state.palIndex >= items.length) state.palIndex = Math.max(0, items.length - 1);
  const ul = $('palette-list');

  if (!items.length) {
    ul.replaceChildren(h('li', null, empty('Nothing matches that.', 'Try a device name, a session id, or a verb like "start".')));
    return;
  }

  // `items` is ALREADY in this order — see `paletteMatches`. Walking the groups here only decides
  // where the headings go; it never reorders anything, so `indexOf` below is the same index the
  // arrow keys move through.
  const rows = [];
  for (const group of PALETTE_GROUPS) {
    const inGroup = items.filter((c) => c.group === group);
    if (!inGroup.length) continue;
    rows.push(h('li', { class: 'cmd-group' }, h('p', { class: 'micro', text: group.toUpperCase() })));
    for (const c of inGroup) {
      const i = items.indexOf(c);
      rows.push(h('li', null,
        h('button', {
          class: `cmd ${i === state.palIndex ? 'is-sel' : ''}`.trim(),
          type: 'button',
          onclick: () => { closeOverlays(); c.run(); },
        },
          h('span', { class: 'glyph' }, c.frame ? deviceThumb(c.frame, 22) : icon(c.icon, 14)),
          h('span', { class: 'cmd-label', text: c.label }),
          // The free count, or the geometry, inline on the result itself. 06's reason: the top
          // result is an ACTION, so Enter has to be a safe keystroke — and it is only safe if what
          // you get is on the row you are about to press.
          c.note ? h('span', { class: 'cmd-note mono', text: c.note }) : null,
        )));
    }
  }
  ul.replaceChildren(...rows);
  // Group headings make the list taller than it was, so the selection can now walk off the bottom
  // of a scrolling palette. `nearest` rather than `center`, which would jump the list on every
  // keystroke.
  ul.querySelector('.cmd.is-sel')?.scrollIntoView({ block: 'nearest' });
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
/**
 * `G` then a letter. THE THREE MERGED ROUTES KEEP THEIR LETTERS — `d`, `r` and `q` still resolve,
 * through `parseHash`, onto the Fleet lens that used to be that page. A shortcut somebody has in
 * their fingers is not a thing to reclaim for tidiness.
 */
const G_ROUTES = { f: 'fleet', d: 'devices', a: 'apps', r: 'sessions', u: 'runs', q: 'queue', h: 'health', l: 'launch', g: 'agents', t: 'team', s: 'settings' };

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

/**
 * The same skeleton-then-fill rule as `orgGate`, over the enrollment list.
 *
 * Its own gate rather than reusing `orgGate`, because this screen needs neither members nor API
 * keys — loading them to render a pairing box would be two requests for data nothing on the page
 * shows.
 */
function pairGate() {
  if (state.pair.loaded) return null;
  void refreshPairings().then(render).catch((e) => toast('Could not load paired machines', e.message, 'bad'));
  return h('p', { class: 'empty' }, h('strong', { text: 'Loading…' }));
}

function roleBadge(role) {
  return h('span', { class: `pill ${role === 'owner' ? 'accent' : ''}`.trim(), text: role });
}

/* ---------------------------------------------------------------------------- agents (ADR-0014) */

/**
 * Pair a machine — the console half of the device authorization grant.
 *
 * The agent shows a code; somebody signed in here types it. THE ORG COMES FROM THIS SESSION, never
 * from anything the agent said, which is the whole reason the code travels in this direction: it
 * proves possession of a machine and nothing else, and the identity it is attached to is the
 * identity of whoever is looking at this screen.
 *
 * TWO STEPS ON PURPOSE. Inspect names the machine; approving is a separate press. The flow's one
 * genuine weakness is a person talked into typing a code that was sent to them, and the only
 * defence is showing them what they are about to admit before they admit it.
 */
function screenAgents() {
  const pending = pairGate();
  const admin = isOrgAdmin();
  const p = state.pair;

  const codeInput = h('input', {
    class: 'field mono tall', type: 'text', placeholder: 'XXXX-XXXX',
    value: p.code, autocomplete: 'off', spellcheck: 'false', maxlength: '20',
    // Straight into state, so the five-second poll cannot swallow half a typed code.
    oninput: (e) => { state.pair.code = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter' && !p.busy) inspectCode(); },
  });

  const enterCode = card('Pair a machine', {},
    h('p', { class: 'caption' },
      'Run the MFARM agent on the machine your phone is plugged into. It opens a window showing a '
      + 'code — type it here.'),
    h('div', { class: 'row tight mt-md' },
      codeInput,
      btn(p.busy ? 'Checking…' : 'Find machine', 'primary', () => inspectCode(), { disabled: p.busy || !admin })),
    p.error ? h('p', { class: 'error-text mt-sm', text: p.error }) : null,
    admin ? null : h('p', { class: 'caption mt-sm', text: 'Only an owner or admin can pair a machine.' }),
  );

  // What the agent said about itself. Self-reported and labelled as such — it is a description for
  // a person to recognise, never an identifier the farm relies on.
  const confirm = p.machine ? card('Is this your machine?', { class: 'highlight' },
    h('p', { class: 'caption' },
      'This is what the machine says about itself. If you do not recognise it, do not approve it — '
      + 'a code you were sent by someone else would look exactly like this.'),
    h('dl', { class: 'facts mt-md' },
      h('dt', { text: 'Hostname' }), h('dd', { class: 'mono', text: p.machine.hostname || 'unnamed' }),
      h('dt', { text: 'Platform' }), h('dd', { class: 'mono', text: p.machine.platform || 'unknown' }),
      h('dt', { text: 'Agent' }), h('dd', { class: 'mono', text: p.machine.agentVersion || 'unknown' }),
      h('dt', { text: 'Asked to pair' }), h('dd', { text: when(p.machine.requestedAt) }),
    ),
    h('div', { class: 'row tight mt-lg' },
      btn(p.busy ? 'Pairing…' : 'Yes, pair this machine', 'primary', () => approveCode(), { disabled: p.busy }),
      btn('Cancel', 'ghost', () => { state.pair.machine = null; state.pair.error = null; render(); }),
    ),
  ) : null;

  const paired = card('Machines paired here', {},
    pending || (p.enrollments.length
      ? h('div', { class: 'stack' }, p.enrollments.map((e) => h('div', { class: 'inset row between' },
          h('div', { class: 'stack tight' },
            h('span', { class: 'row tight' },
              h('span', { class: 'secondary', text: e.label || 'unnamed machine' }),
              e.revokedAt ? h('span', { class: 'pill', text: 'revoked' })
                : e.usedAt ? h('span', { class: 'pill', text: 'in use' })
                  : h('span', { class: 'pill', text: 'not yet used' })),
            h('p', { class: 'caption', text: e.usedAt ? `paired ${when(e.usedAt)}` : `created ${when(e.createdAt)}` }),
          ),
          h('span', { class: 'mono caption', text: `${e.prefix}…` }),
        )))
      : empty('No machines paired yet.',
          'Run the agent on a laptop with a phone on it, and the code it shows goes in the box above.')));

  return [
    pageHead([{ label: 'Organisation' }], 'Agents',
      'Machines that put devices into this farm'),
    h('div', { class: 'split' },
      h('div', { class: 'content' }, enterCode, confirm, paired),
      h('div', { class: 'rail' },
        card('How pairing works', {},
          h('p', { class: 'caption' },
            'The agent asks this farm for a code and shows it. You type it here, and because you '
            + 'are signed in, the machine joins THIS organisation — the code itself carries no '
            + 'identity, only proof that somebody is standing in front of that machine.'),
          h('p', { class: 'caption mt-sm' },
            'Codes last ten minutes. If one lapses the agent shows a new one automatically, so the '
            + 'window always has a code that currently works.'),
          h('p', { class: 'caption mt-sm' },
            'Pairing happens once per machine. Afterwards it holds its own credential and rejoins '
            + 'on its own after a restart.'),
        ),
      ),
    ),
  ];
}

async function inspectCode() {
  const code = state.pair.code.trim();
  /**
   * AN EMPTY FIELD GETS AN ANSWER, not silence.
   *
   * This returned early and said nothing: a person clicked Find machine with nothing typed and the
   * console did not move, error, or hint. Found by clicking every control on every screen — no test
   * covers "what happens when you press the button before filling the field", and it is the first
   * thing a person actually does.
   */
  if (!code) {
    state.pair.error = 'Type the code the agent window is showing, then press Find machine.';
    render();
    return;
  }
  state.pair.busy = true;
  state.pair.error = null;
  state.pair.machine = null;
  render();
  try {
    const { pairing } = await api('/v1/pair/inspect', { method: 'POST', body: { userCode: code } });
    state.pair.machine = pairing;
    if (pairing.approved) {
      state.pair.machine = null;
      state.pair.error = 'That code has already been approved — the agent should have paired. Check its window.';
    }
  } catch (e) {
    state.pair.error = e.message;
  } finally {
    state.pair.busy = false;
    render();
  }
}

async function approveCode() {
  state.pair.busy = true;
  state.pair.error = null;
  render();
  try {
    const { pairing } = await api('/v1/pair/approve', { method: 'POST', body: { userCode: state.pair.code.trim() } });
    state.pair.machine = null;
    state.pair.code = '';
    await refreshPairings();
    toast('Paired', `${pairing.hostname || 'That machine'} is joining the farm — its window should say so.`);
  } catch (e) {
    state.pair.error = e.message;
  } finally {
    state.pair.busy = false;
    render();
  }
}

/**
 * Which machines were paired, from the enrollment list this already had.
 *
 * Reusing `agent_enrollments` rather than adding a listing over `agent_pairings`: the enrollment IS
 * the durable record of a machine having joined, and pairings are a ten-minute holding area whose
 * rows mean nothing to a person once they are collected.
 */
async function refreshPairings() {
  const { enrollments } = await api('/v1/account/agent-enrollments');
  state.pair.enrollments = enrollments || [];
  state.pair.loaded = true;
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

/**
 * APPEARANCE — the one setting in this console that is purely the reader's.
 *
 * IN SETTINGS AND NOT IN THE HEADER. A theme switch in the top bar is one mis-click away at all
 * times and is pressed by accident far more often than on purpose; this is a preference somebody
 * sets once. The three-way choice is explained rather than implied, because "System" is the only
 * option whose behaviour is not obvious from its name.
 *
 * DENSITY AND MOTION ARE HERE TOO, and they were already real: `data-density` and `data-liveness`
 * have driven the token scales since stage 1 and nothing in the console could set either. A setting
 * the design specifies, the CSS implements, and no control reaches is indistinguishable from one
 * that does not exist.
 */
function appearanceCard() {
  const pick = (label, value, current, onpick, why) => h('button', {
    class: `btn tiny${value === current ? ' primary' : ' ghost'}`,
    type: 'button',
    title: why || label,
    onclick: () => onpick(value),
  }, label);

  const theme = themeChoice();
  const density = root.dataset.density || 'comfortable';
  const liveness = root.dataset.liveness || 'calm';

  const setAttr = (name, key, value) => {
    root.dataset[name] = value;
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
    render();
  };

  return card('Appearance', {},
    h('p', { class: 'micro', text: 'Theme' }),
    h('div', { class: 'row tight mt-xs' },
      pick('System', 'system', theme, setTheme, 'Follow the operating system, and keep following it when it changes'),
      pick('Dark', 'dark', theme, setTheme),
      pick('Light', 'light', theme, setTheme)),
    h('p', { class: 'caption mt-xs', text: theme === 'system'
      ? 'Following this device. It changes when your system does, including while this page is open.'
      : `Always ${theme}, whatever the system is set to.` }),

    h('p', { class: 'micro mt-lg', text: 'Density' }),
    h('div', { class: 'row tight mt-xs' },
      // `airy`, not `dense` — the three modes in `design-tokens.css` are comfortable/compact/airy,
      // and a fourth name here would be a button that sets an attribute no rule matches. A control
      // that silently does nothing is worse than an absent one.
      pick('Compact', 'compact', density, (v) => setAttr('density', 'mf-density', v)),
      pick('Comfortable', 'comfortable', density, (v) => setAttr('density', 'mf-density', v)),
      pick('Airy', 'airy', density, (v) => setAttr('density', 'mf-density', v))),
    // The constraint is what makes density safe to offer at all, so it is stated rather than left
    // for somebody to discover: the three modes scale padding and gap, never type size.
    h('p', { class: 'caption mt-xs', text: 'Padding and spacing only — text never gets smaller.' }),

    h('p', { class: 'micro mt-lg', text: 'Motion' }),
    h('div', { class: 'row tight mt-xs' },
      pick('Calm', 'calm', liveness, (v) => setAttr('liveness', 'mf-liveness', v)),
      pick('Still', 'still', liveness, (v) => setAttr('liveness', 'mf-liveness', v))),
    h('p', { class: 'caption mt-xs', text:
      'Nothing here is conveyed by motion alone, so Still loses no information \u2014 a step that '
      + 'was pulsing still says what it is waiting for in words. Your system\u2019s '
      + '“reduce motion” setting already does this on its own.' }),
  );
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
        appearanceCard(),
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
  fleet: () => screenFleet(),
  devices: () => screenDevices(),
  device: () => screenDevice(state.route.id),
  apps: () => screenApps(),
  sessions: () => screenSessions(),
  runs: () => screenRuns(),
  run: () => screenRun(state.route.id),
  cockpit: () => screenCockpit(state.route.id),
  queue: () => screenQueue(),
  health: () => screenHealth(),
  agents: () => screenAgents(),
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
      if (state.error) clearToast('api-down');
      state.error = null;
      state.lastGoodAt = Date.now();
      // Only rebuild the screen when the poll actually brought something new. The header counters
      // and every elapsed-time field are repainted by the one-second tick regardless, so a skipped
      // render leaves nothing stale — it just leaves the DOM alone.
      if (pollSignature() !== before) render();
    } catch (err) {
      /**
       * A FAILED POLL MUST NOT BLANK A WORKING PAGE. Never a skeleton, never an empty state — the
       * console keeps its last-known data and says how old it is.
       *
       * The age is the half that makes this useful. "Connection lost" tells somebody something is
       * wrong and leaves them unable to judge whether what is on screen is worth acting on; "from
       * 40 seconds ago" lets them decide for themselves. The toast is KEYED, so it is rewritten in
       * place every five seconds as that number grows rather than stacking, and it is removed the
       * moment a poll succeeds.
       */
      state.error = err.message;
      const stale = state.lastGoodAt ? ago(new Date(state.lastGoodAt).toISOString()) : null;
      toast(
        'Lost the connection to the farm',
        stale
          ? `Showing what we last knew, from ${stale}. Retrying.`
          : 'Showing what we last knew. Retrying.',
        'bad',
        { key: 'api-down' },
      );
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

  /**
   * WHICH ORG THIS IS, said out loud.
   *
   * Everything on every screen belongs to one tenant, and until now the only place that named it
   * was the avatar's tooltip. A person in two orgs sees their sessions and builds "disappear" when
   * the login picks the other one — which is what happened during the exploratory pass, for an hour,
   * to somebody who knew the system.
   *
   * The count is included ONLY when there is more than one, because "Acme" is the answer and
   * "Acme · 1 of 1" is noise. Where there are several it is the whole point.
   */
  const orgs = me.orgs || [];
  $('who-org').textContent = orgs.length > 1
    ? `${me.org.name} · 1 of ${orgs.length} orgs`
    : me.org.name;
  $('who-org').title = orgs.length > 1
    ? `You belong to ${orgs.length} organisations: ${orgs.map((o) => o.name).join(', ')}. `
      + 'Everything on this console belongs to the one named here. Sign out and back in to change it.'
    : `${me.role} of ${me.org.name}`;
  $('palette-kbd').textContent = navigator.platform?.startsWith('Mac') ? '⌘K' : 'Ctrl K';
  void showBuild();

  setRoute();
  await refreshAll();
  /**
   * BEFORE THE FIRST PAINT, not after it. A run URL is the one people paste to each other — "what
   * happened on 4471" — and a device URL is the one an operator is sent when something is wrong;
   * both render their own empty state if nothing has fetched yet, and an empty state that resolves
   * a moment later reads as "there is nothing here" for exactly as long as somebody is looking at
   * it. `hashchange` does not fire on load, so this is the only chance.
   */
  await loadForRoute();
  render();
  startPoll();
  startTick();
  // A reload of a bring-up URL has to rejoin the session it names. `hashchange` does not fire on
  // load, so without this the checklist renders from nothing and the viewer is never opened — and
  // the person is left staring at a screen that will never advance while their device sits
  // allocated behind it.
  if (state.route.name === 'launching') void watchBringup(state.route.id);
}

// The chrome's icons, before anything else draws — the nav is in the static markup, so its glyph
// slots are empty until this runs.
paintNavIcons();

// Restore the sidebar width before first paint so it does not flash open then collapse.
try {
  const nav = localStorage.getItem('mf-nav');
  if (nav === 'icons') root.dataset.nav = 'icons';
} catch { /* private mode */ }

/**
 * And the theme, for the same reason and more urgently: `index.html` ships `data-theme="dark"` so
 * that a page with no JavaScript yet is not a white flash, and this is the first chance to correct
 * it for somebody whose choice — or whose OS — says otherwise.
 */
applyTheme(themeChoice());
try {
  const d = localStorage.getItem('mf-density');
  if (d === 'compact' || d === 'airy') root.dataset.density = d;
  if (localStorage.getItem('mf-liveness') === 'still') root.dataset.liveness = 'still';
} catch { /* private mode */ }
setNavToggleIcon(root.dataset.nav === 'icons');

$('hub-preview').textContent = `https://<api-key>@${location.host}/wd/hub`;
checkReach();
boot().catch(() => showSignin());
