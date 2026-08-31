// Drive every execution-model capability against a REAL device — §4.1 to §4.5.
//
// WHY THIS EXISTS, separately from `verify-webdriver.mjs`. That one proves the hub, the grant, the
// gateway, Appium and Cuttlefish agree about a plain session. These two capabilities added hops it
// never touches: a build resolved out of `app_builds` under RLS, an `app_actions` install queued on
// the heartbeat and AWAITED before Appium is called, and a run row that several sessions join. All
// of that was tested with a loop in a test file playing the worker — the only thing it has never
// done is talk to a real `adb install`.
//
// The check that actually matters is `current_package`. Everything else can pass while the app is
// absent: the hub sets `appium:appPackage` and does NOT set `appium:appActivity`, on the theory that
// UiAutomator2 resolves the launchable activity from the package by itself. If that theory is
// wrong, the session still opens, the capabilities still come back correct, and the device sits on
// the launcher — which is precisely the silent failure `mfarm:appId` exists to prevent.
//
//   MFARM_API_KEY=mfk_... node deploy/verify-runs.mjs
//   MFARM_API_KEY=... HUB=http://127.0.0.1:3000 REGION=lab APP=com.way2automation.medishop node deploy/verify-runs.mjs

const HUB = process.env.HUB ?? 'http://127.0.0.1:3000';
const REGION = process.env.REGION ?? 'lab';
const APP = process.env.APP ?? 'com.way2automation.medishop';
const KEY = process.env.MFARM_API_KEY;
if (!KEY) {
  console.error('MFARM_API_KEY is required (deploy/.state/api_key)');
  process.exit(2);
}

const basic = 'Basic ' + Buffer.from(`${KEY}:`).toString('base64');
const bearer = `Bearer ${KEY}`;
// Unique per invocation, so a re-run does not join the run the last one made and then disagree
// about how many sessions it should have.
const RUN = `verify-${Date.now()}`;

const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let failed = 0;
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad  = (m) => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${m}`); };
const note = (m) => console.log(`    ${m}`);
const say  = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

async function hub(method, path, body) {
  const res = await fetch(`${HUB}/wd/hub${path}`, {
    method,
    headers: { authorization: basic, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* not every error page is JSON */ }
  return { status: res.status, json, text };
}

async function api(path, body) {
  const res = await fetch(`${HUB}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: bearer, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* ditto */ }
  return { status: res.status, json, text };
}

const caps = (extra) => ({
  capabilities: {
    alwaysMatch: {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:newCommandTimeout': 300,
      'mfarm:region': REGION,
      ...extra,
    },
    firstMatch: [{}],
  },
});

/** The W3C error `value.message`, which is where the hub's own wording lands. */
const why = (r) => r.json?.value?.message ?? r.text?.slice(0, 200) ?? '';

const open = (extra) => hub('POST', '/session', caps(extra));
const quit = (id) => hub('DELETE', `/session/${id}`).catch(() => {});
const sessionIdOf = (r) => r.json?.value?.sessionId ?? r.json?.sessionId;
const capsOf = (r) => r.json?.value?.capabilities ?? {};

console.log(`hub    ${HUB}`);
console.log(`region ${REGION}`);
console.log(`run    ${RUN}`);

// ---------------------------------------------------------------- 1. refusals, which cost nothing

say('Capabilities the hub must refuse');

const free = async () => (await api('/v1/devices')).json?.available ?? -1;
const before = await free();
note(`${before} device(s) free before the refusal checks`);

const typo = await open({ 'mfarm:appid': 'whatever' });
typo.status >= 400 && /not a capability this hub understands/.test(why(typo))
  ? ok('a misspelled `mfarm:appid` is refused, naming the key')
  : bad(`a misspelled vendor key was NOT refused (${typo.status}): ${why(typo)}`);

const both = await open({ 'mfarm:appId': APP, 'appium:app': '/tmp/x.apk' });
both.status >= 400 && /both name the app/.test(why(both))
  ? ok('`mfarm:appId` beside `appium:app` is refused rather than one being picked')
  : bad(`setting both was NOT refused (${both.status}): ${why(both)}`);

const nope = await open({ 'mfarm:appId': 'com.nope.nothing@9.9.9' });
nope.status >= 400 && /app library/.test(why(nope))
  ? ok('an unknown build is refused, and the message points at the library')
  : bad(`an unknown build was NOT refused (${nope.status}): ${why(nope)}`);

const after = await free();
after === before
  ? ok(`no device was spent on any refusal (${after} still free)`)
  : bad(`a refusal consumed a device lease: ${before} free before, ${after} after`);

// ---------------------------------------------------------------- 2. the real thing

say(`Installing ${APP}@latest on a real device, and joining run "${RUN}"`);

const t1 = Date.now();
const first = await open({ 'mfarm:appId': `${APP}@latest`, 'mfarm:runId': RUN });
if (first.status !== 200) {
  bad(`session not created (${first.status}): ${why(first)}`);
  console.log(`\n\x1b[31mCannot continue without a session.\x1b[0m`);
  process.exit(1);
}
const s1 = sessionIdOf(first);
const c1 = capsOf(first);
ok(`session ${s1} opened in ${((Date.now() - t1) / 1000).toFixed(1)}s (install included)`);

/^[0-9a-f-]{36}$/.test(c1['mfarm:appId'] ?? '')
  ? ok(`@latest resolved to a build id: ${c1['mfarm:appId']}`)
  : bad(`the resolved build id did not come back: ${JSON.stringify(c1['mfarm:appId'])}`);

c1['mfarm:runId'] === RUN
  ? ok(`the run came back on the capabilities: ${c1['mfarm:runId']}`)
  : bad(`the run id did not come back: ${JSON.stringify(c1['mfarm:runId'])}`);

// THE CHECK THAT MATTERS. Everything above can pass with the device on the launcher.
const pkg = await hub('GET', `/session/${s1}/appium/device/current_package`);
const running = pkg.json?.value;
if (running === APP) {
  ok(`the device is actually running ${running} — appPackage alone was enough for UiAutomator2`);
} else if (pkg.status >= 400) {
  bad(`could not read current_package (${pkg.status}): ${why(pkg)}`);
  note('inconclusive: the install may be fine and the endpoint unsupported.');
} else {
  bad(`the foreground app is ${JSON.stringify(running)}, not ${APP}`);
  note('THIS IS THE appActivity QUESTION. The build installed but did not come up.');
  note('Fix: suites set `appium:appActivity`, and the hub docs say so. Not a code change.');
}

const shot = await hub('GET', `/session/${s1}/screenshot`);
typeof shot.json?.value === 'string' && shot.json.value.length > 1000
  ? ok(`a screenshot came back (${shot.json.value.length} base64 chars) — the session is real`)
  : bad(`no screenshot: ${why(shot)}`);

// ---------------------------------------------------------------- 3. a second session, same run

say('A second session joining the same run');

const second = await open({ 'mfarm:appId': `${APP}@latest`, 'mfarm:runId': RUN });
const s2 = sessionIdOf(second);
second.status === 200 && capsOf(second)['mfarm:runId'] === RUN
  ? ok(`session ${s2} joined run "${RUN}"`)
  : bad(`the second session did not join (${second.status}): ${why(second)}`);

// ---------------------------------------------------------------- 4. outcomes

say('Before anything reports, the run must read as UNMEASURED');

const quiet = await api(`/v1/runs/${encodeURIComponent(RUN)}`);
if (quiet.status === 200) {
  const t = quiet.json.run.tests;
  t.total === 0 && t.sessionsReporting === 0
    ? ok('no results yet, and the run says so rather than showing zero failures')
    : bad(`expected an unmeasured run, got ${JSON.stringify(t)}`);
} else {
  bad(`could not read the run before reporting (${quiet.status})`);
}

say('Reporting outcomes, the way an afterEach does');

// Deliberately mixed, and deliberately including a retry: the same name failing then passing is
// the flakiness signal, and the farm must record both rather than deduplicate one away.
const reports = [
  [s1, { name: 'the app opens', status: 'passed', durationMs: 1400 }],
  [s1, { name: 'checkout applies a promo', status: 'failed', failure: 'AssertionError: expected 8, got 10\n    at checkout.spec.js:42' }],
  [s1, { name: 'a pending case', status: 'skipped' }],
  [s2, { name: 'flaky thing', status: 'failed', failure: 'timed out after 10000ms' }],
  [s2, { name: 'flaky thing', status: 'passed', durationMs: 900 }],
];
let posted = 0;
for (const [session, body] of reports) {
  const r = await api(`/v1/sessions/${session}/result`, body);
  if (r.status === 201) posted++;
  else bad(`reporting "${body.name}" failed (${r.status}): ${r.text.slice(0, 160)}`);
}
posted === reports.length
  ? ok(`${posted} results accepted`)
  : bad(`only ${posted} of ${reports.length} results were accepted`);

// ---------------------------------------------------------------- 5. what the run reports

say('What the API says about the run');

const byName = await api(`/v1/runs/${encodeURIComponent(RUN)}`);
if (byName.status !== 200) {
  bad(`GET /v1/runs/${RUN} returned ${byName.status}: ${byName.text.slice(0, 200)}`);
} else {
  const { run, sessions } = byName.json;
  ok(`the run resolves by the NAME the suite gave it, not just by uuid (${run.id})`);
  run.sessions.total === 2
    ? ok(`it has both sessions (${run.sessions.total})`)
    : bad(`expected 2 sessions, got ${run.sessions.total}`);
  run.buildCount === 1 && run.build?.packageName === APP
    ? ok(`one build across the run, named: ${run.build.packageName}@${run.build.versionName}`)
    : bad(`build rollup wrong: buildCount=${run.buildCount} build=${JSON.stringify(run.build)}`);
  sessions.every((s) => s.build?.packageName === APP)
    ? ok('every session records the build it ran')
    : bad(`a session is missing its build: ${JSON.stringify(sessions.map((s) => s.build))}`);
  run.sessions.live > 0
    ? ok(`${run.sessions.live} session(s) reported live`)
    : bad(`nothing reported live while two sessions are open`);

  // The outcome rollup. 5 results across 2 sessions — and the session count must survive the
  // results join, which a plain three-way join would multiply to 10.
  const t = run.tests;
  t.total === 5 && t.passed === 2 && t.failed === 2 && t.skipped === 1
    ? ok(`outcomes counted: ${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped`)
    : bad(`outcome counts wrong: ${JSON.stringify(t)}`);
  t.sessionsReporting === 2
    ? ok('both sessions are recorded as having reported')
    : bad(`sessionsReporting is ${t.sessionsReporting}, expected 2`);
  run.sessions.total === 2
    ? ok('the session count survived the results join, rather than being multiplied by it')
    : bad(`session count is ${run.sessions.total} — the results join multiplied it`);

  // The link that makes a failure actionable: the session id is what its logcat and screenshot
  // hang off, so this is one click from the evidence.
  const failures = byName.json.failures ?? [];
  failures.length === 2
    ? ok(`both failures listed, each naming its session`)
    : bad(`expected 2 failures, got ${failures.length}`);
  const promo = failures.find((f) => f.name === 'checkout applies a promo');
  promo && promo.sessionId === s1 && /expected 8/.test(promo.failure ?? '')
    ? ok('a failure carries its message and the session that produced it')
    : bad(`the failure is missing its message or its session: ${JSON.stringify(promo)}`);

  // A retry is two results on purpose. Collapsing them would discard the flakiness signal.
  failures.some((f) => f.name === 'flaky thing') && t.passed === 2
    ? ok('a retry is recorded as both a failure and a pass, not deduplicated')
    : bad('the retry was collapsed');
}

const list = await api('/v1/runs?limit=5');
list.status === 200 && list.json.runs.some((r) => r.runId === RUN)
  ? ok('the run appears in GET /v1/runs')
  : bad(`the run is missing from the list (${list.status})`);

// The link back, which is what makes the Sessions screen navigable.
const sess = await api(`/v1/sessions/${s1}`);
sess.json?.session?.run?.runId === RUN
  ? ok('the session names its run, so both directions are navigable')
  : bad(`the session does not name its run: ${JSON.stringify(sess.json?.session?.run)}`);

// ---------------------------------------------------------------- 6. an on-demand screenshot

say('Capturing a screenshot while the app is still on screen (§4.5)');

// The whole reason this verb exists: the release-time screenshot is taken after Appium has
// force-stopped the app, so it shows the launcher. This one is taken with the suite still holding
// the device and the app under test in the foreground.
const shotReq = await api(`/v1/sessions/${s1}/app-actions`, { kind: 'screenshot' });
if (shotReq.status !== 202) {
  bad(`queueing a screenshot failed (${shotReq.status}): ${shotReq.text.slice(0, 200)}`);
} else {
  ok('queued with no appId — the first verb in this pipeline that names no build');
  const actionId = shotReq.json.action.id;

  // Delivered on the next heartbeat, like every other action. The old INNER JOIN on app_builds
  // would have left this PENDING forever with no error anywhere, so a timeout here is the loudest
  // symptom that regression has.
  const deadline = Date.now() + 90_000;
  let state = 'PENDING';
  let err = null;
  while (Date.now() < deadline) {
    const a = await api(`/v1/app-actions/${actionId}`);
    state = a.json?.action?.state ?? 'PENDING';
    err = a.json?.action?.error ?? null;
    if (state !== 'PENDING') break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  state === 'DONE'
    ? ok('the worker captured it')
    : bad(`the screenshot action ended ${state}${err ? `: ${err}` : ''}`);

  const arts = await api(`/v1/sessions/${s1}/artifacts`);
  const shots = (arts.json?.artifacts ?? []).filter((a) => a.kind === 'screenshot');
  shots.length > 0
    ? ok(`it reached the artifact store (${shots[0].sizeBytes} bytes), not just a DONE row`)
    : bad('the action reported DONE but no screenshot artifact exists');
}

// ---------------------------------------------------------------- 7. give the devices back

say('Releasing');
for (const id of [s1, s2].filter(Boolean)) {
  const r = await quit(id);
  r && r.status < 400 ? ok(`released ${id}`) : bad(`could not release ${id}`);
}

// ---------------------------------------------------------------- 8. the timeline (migration 030)
//
// AFTER the release, deliberately: `session-ended` is emitted on quit, so checking before it would
// assert on a timeline that is genuinely still being written and would pass or fail on timing.
//
// Resolved by the NAME the suite chose rather than by a uuid, because that is the path a CI job
// actually has — it passed `mfarm:runId` and never saw a uuid.

say('Reading the execution timeline');
const tl = await api(`/v1/runs/${encodeURIComponent(RUN)}/timeline`);
if (tl.status !== 200) {
  bad(`the timeline did not resolve by name: ${tl.status}`);
} else {
  const events = tl.json?.events ?? [];
  const kinds = events.map((e) => e.kind);
  note(kinds.join(' → ') || '(no events)');

  kinds.includes('run-created')
    ? ok('the run records its own creation')
    : bad('no run-created event');

  // Two sessions joined this run, so two allocations and two activations. A timeline that recorded
  // one would be describing a different run than the one that just executed.
  const allocated = kinds.filter((k) => k === 'device-allocated').length;
  allocated === 2
    ? ok('both sessions recorded an allocation')
    : bad(`expected 2 device-allocated events, found ${allocated}`);

  const ended = kinds.filter((k) => k === 'session-ended').length;
  ended === 2
    ? ok('both sessions recorded their end')
    : bad(`expected 2 session-ended events, found ${ended}`);

  // ORDER IS THE POINT. A set of kinds is not a timeline; if these arrive out of sequence the
  // table is recording facts but not history, and every "why was this slow" answer built on it
  // would be wrong.
  const firstAlloc = kinds.indexOf('device-allocated');
  const firstEnd = kinds.indexOf('session-ended');
  kinds.indexOf('run-created') === 0 && firstAlloc < firstEnd
    ? ok('the events are in the order they happened')
    : bad(`out of order: ${kinds.join(', ')}`);

  // Every event must name the run's own sessions, never a stray one. `sessionId` is read off the
  // session row inside the INSERT, so a mismatch here would mean the attribution itself is broken.
  const stray = events.filter((e) => e.sessionId && ![s1, s2].includes(e.sessionId));
  stray.length === 0
    ? ok('every event is attributed to one of this run\'s sessions')
    : bad(`${stray.length} event(s) named a session outside this run`);
}

say(failed === 0 ? `\x1b[32mAll checks passed\x1b[0m (${since()})` : `\x1b[31m${failed} check(s) failed\x1b[0m (${since()})`);
process.exit(failed === 0 ? 0 : 1);
