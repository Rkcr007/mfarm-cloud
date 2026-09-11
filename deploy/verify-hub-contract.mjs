// Does the hub contract from migration 048 work against a REAL device?
//
// ADR-0033 added four things a suite arriving from LambdaTest needs: `mfarm:name` (the test, at
// creation), `mfarm:runName` (the readable half of a run), `mfarm:deviceClass` (which KIND of
// device), and `executeScript("mfarm-status=…")` (the outcome, through the driver a teardown
// already holds). All of it shipped with tests, and all of those tests ran against a hub built
// in-process by `app.inject()` with no device anywhere near it.
//
// A capability probe against the deployed hub — which is what verified this on 2026-09-09 — proves
// the PARSER accepts the words. It cannot prove a named session reaches a device, that a class
// request lands on that class, or that a teardown hook writes a row. Those are the claims here, and
// the register's rule is that they are not closed until a real device has done them.
//
//   MFARM_API_KEY=$(cat ~/mfarm/deploy/.state/api_key) node deploy/verify-hub-contract.mjs
//
// RUNS ON THE CONTROL PLANE, like `verify-execution.mjs` and for its reason: it needs the hub on
// loopback and the API key that lives there, and it drives devices through the hub rather than
// touching the device host at all.
//
// It takes TWO devices at once, on purpose — "the first session names the run and later ones do not
// move it" is a claim about two sessions and cannot be checked with one. Both are released on every
// exit path, including a crash.

const HUB = process.env.HUB ?? 'http://127.0.0.1:3000';
const REGION = process.env.REGION ?? 'lab';
const KEY = process.env.MFARM_API_KEY;
if (!KEY) { console.error('MFARM_API_KEY is required'); process.exit(2); }

/** The class this farm actually has, and the one a mixed-fleet suite would pin itself to. */
const CLASS = process.env.DEVICE_CLASS ?? 'mfarm-x1-pro';
/** A class no farm has. Deliberately plausible: the failure must name it, not shrug. */
const ABSENT_CLASS = 'mfarm-x9-ultra';

const bearer = `Bearer ${KEY}`;
const stamp = new Date().toISOString().replace(/[-:T]/g, '_').slice(0, 19);
const RUN_ID = `verify-hub-${Date.now()}`;
/** Shaped like the thing it replaces: `TestHooks.xmlPath` from a LambdaTest suite. */
const RUN_NAME = `Android_UAE_Expenses_${stamp}`;
const RUN_NAME_LATER = `${RUN_NAME}_SECOND_ATTEMPT`;
const TEST_ONE = 'Expenses: a cardholder submits a claim';
const TEST_TWO = 'Expenses: a claim over the limit is refused';

let passed = 0, failed = 0;
const ok   = (m) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const bad  = (m) => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${m}`); };
const say  = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const note = (m) => console.log(`  \x1b[33m·\x1b[0m ${m}`);
const check = (cond, m, detail = '') => (cond ? ok(m) : bad(`${m}${detail ? ` — ${detail}` : ''}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  const res = await fetch(`${HUB}${path}`, {
    ...init,
    headers: { authorization: bearer, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not json; the caller decides */ }
  return { status: res.status, body, text };
}

/** Open a WebDriver session through the hub, with whatever `mfarm:` capabilities are asked for. */
function openSession(mfarm, { queueTimeoutSeconds = 180 } = {}) {
  return api('/wd/hub/session', {
    method: 'POST',
    body: JSON.stringify({
      capabilities: {
        alwaysMatch: {
          platformName: 'android',
          'appium:automationName': 'UiAutomator2',
          'mfarm:region': REGION,
          'mfarm:queueTimeoutSeconds': queueTimeoutSeconds,
          ...mfarm,
        },
      },
    }),
  });
}

/** `executeScript`, spelled the way a W3C client spells it. */
const script = (id, s, args = []) =>
  api(`/wd/hub/session/${id}/execute/sync`, { method: 'POST', body: JSON.stringify({ script: s, args }) });

const open = [];
async function release() {
  for (const id of open.splice(0)) {
    try { await api(`/wd/hub/session/${id}`, { method: 'DELETE' }); } catch { /* best effort */ }
  }
}

async function until(label, fn, { timeoutMs = 45_000, everyMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) { note(`gave up waiting for ${label} after ${timeoutMs / 1000}s`); return null; }
    await sleep(everyMs);
  }
}

async function main() {
  // ------------------------------------------------------------------ the named session

  say(`A — a session says which test it is, at creation (run ${RUN_ID})`);

  const first = await openSession({
    'mfarm:runId': RUN_ID,
    'mfarm:runName': RUN_NAME,
    'mfarm:name': TEST_ONE,
    'mfarm:deviceClass': CLASS,
  });
  if (first.status !== 200) {
    bad(`could not open the first session: ${first.status} ${first.text.slice(0, 400)}`);
    return;
  }
  const one = first.body.value.sessionId;
  open.push(one);
  ok(`session ${one} on a real device`);

  /**
   * THE D37 ASSERTION, and the reason the whole feature exists. Nothing has posted a result yet —
   * this is the window a person is actually looking at the console in, and before 048 it showed a
   * uuid. Read it back over the API rather than trusting the create response, because the create
   * response is written by the code under test.
   */
  const detail = await api(`/v1/sessions/${one}`);
  check(detail.status === 200, 'the session reads back', `status ${detail.status}`);
  const s1 = detail.body?.session ?? detail.body;
  check(s1?.name === TEST_ONE,
    'the session carries the TEST NAME before any result is posted', JSON.stringify(s1?.name));
  // `session.run.name`, NOT `session.runName` — the endpoint nests the run as an object so that a
  // session can carry the CI id and the readable name at once. Worth stating: the first version of
  // this script guessed the flat spelling and reported a working farm as broken.
  check(s1?.run?.name === RUN_NAME,
    'the run carries the readable name the suite chose', JSON.stringify(s1?.run?.name));
  check(s1?.run?.runId === RUN_ID,
    'and the CI id it will be joined back on', JSON.stringify(s1?.run?.runId));

  // ------------------------------------------------------------------ the class

  say(`B — the farm hands over the CLASS that was asked for (${CLASS})`);

  const requested = s1?.requestedProfile ?? s1?.requested_profile;
  check(requested === CLASS, 'the session records what was asked for', JSON.stringify(requested));

  const deviceId = s1?.deviceId ?? s1?.device_id;
  if (!deviceId) {
    bad('the session has no device — everything below is about a device');
  } else {
    const dev = await api(`/v1/devices/${deviceId}`);
    const profile = dev.body?.device?.profile ?? dev.body?.profile;
    check(profile === CLASS,
      `the device it actually allocated is of that class (${JSON.stringify(profile)})`);
    const model = dev.body?.device?.model ?? dev.body?.model;
    note(`device ${deviceId} — ${model}`);
  }

  say('C — a class this farm does not have fails NAMING the class');

  // Zero queue timeout: an absent class must fail rather than wait, because waiting works for a
  // busy class and never for one that does not exist.
  const absent = await openSession({ 'mfarm:deviceClass': ABSENT_CLASS }, { queueTimeoutSeconds: 0 });
  check(absent.status >= 400, 'the request is refused', `status ${absent.status}`);
  check(absent.text.includes(ABSENT_CLASS),
    'the refusal quotes the class back, so the typo is visible', absent.text.slice(0, 200));
  if (absent.status === 200) { open.push(absent.body.value.sessionId); }

  // ------------------------------------------------------------------ the teardown hook

  say('D — an ordinary script still reaches Appium (the hook declines everything else)');

  /**
   * THE REGRESSION THIS FEATURE COULD HAVE CAUSED. Every `executeScript` a suite makes for its own
   * purposes passes through `runScriptHook`, and a hook that mishandled an unfamiliar payload would
   * break ordinary automation to serve a convenience. `mobile: getDeviceTime` is a real
   * UiAutomator2 command with a checkable answer, so this proves the command reached the device
   * rather than merely not erroring.
   */
  const time = await script(one, 'mobile: getDeviceTime');
  check(time.status === 200, 'a non-mfarm script round-trips to the device', `status ${time.status}`);
  const when = time.body?.value;
  check(typeof when === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(when),
    'and comes back with the device\'s own clock', JSON.stringify(when));

  say('E — a misspelled status is refused rather than forwarded');

  const typo = await script(one, 'mfarm-status=pased');
  check(typo.status >= 400, 'the typo is refused', `status ${typo.status}`);
  check(/passed/.test(typo.text) && /failed/.test(typo.text),
    'the refusal lists the vocabulary, so the fix is obvious', typo.text.slice(0, 200));

  const alive = await api(`/wd/hub/session/${one}/screenshot`);
  check(alive.status === 200, 'AND THE SESSION SURVIVED IT — a refused hook is not a dead driver',
    `status ${alive.status}`);

  say('F — the teardown reports through the driver it already holds');

  const reported = await script(one, 'mfarm-status=passed');
  check(reported.status === 200, 'the hook is accepted', `status ${reported.status} ${reported.text.slice(0, 200)}`);

  const results = await until('the result row', async () => {
    const r = await api(`/v1/sessions/${one}/results`);
    return r.body?.results?.length ? r.body.results : null;
  }, { timeoutMs: 15_000 });

  if (!results) {
    bad('no result row was written — the hook answered 200 and did nothing');
  } else {
    ok(`${results.length} result row(s)`);
    check(results[0].status === 'passed', 'recorded as passed', results[0].status);
    /**
     * THE HALF THAT MAKES THE HOOK USABLE. The script carries a status and no name, so the row is
     * named from `mfarm:name` — without that a passing test's row would be "session 4f3c…", which
     * is exactly the uuid problem 048 set out to remove.
     */
    check(results[0].name === TEST_ONE,
      'and NAMED FROM THE SESSION, not from a uuid fallback', JSON.stringify(results[0].name));
  }

  // ------------------------------------------------------------------ the second session

  say('G — a second session joins the run and does NOT rename it');

  const second = await openSession({
    'mfarm:runId': RUN_ID,
    'mfarm:runName': RUN_NAME_LATER,
  });
  if (second.status !== 200) {
    bad(`could not open the second session: ${second.status} ${second.text.slice(0, 300)}`);
  } else {
    const two = second.body.value.sessionId;
    open.push(two);
    ok(`session ${two} on a second device`);

    const run = await api(`/v1/runs/${RUN_ID}`);
    const runName = run.body?.run?.name;
    check(runName === RUN_NAME,
      'the run keeps the FIRST session\'s name', `${JSON.stringify(runName)} vs ${JSON.stringify(RUN_NAME_LATER)}`);
    check((run.body?.sessions ?? []).length >= 2, 'both sessions are in one run',
      `${(run.body?.sessions ?? []).length} session(s)`);

    /** The other half of the hook: a suite that names its test in the teardown instead. */
    const named = await script(two, `mfarm-name=${TEST_TWO}`);
    check(named.status === 200, 'the `mfarm-name=` hook is accepted', `status ${named.status}`);

    const renamed = await api(`/v1/sessions/${two}`);
    const s2 = renamed.body?.session ?? renamed.body;
    check(s2?.name === TEST_TWO, 'and the session takes that name', JSON.stringify(s2?.name));

    const failedHook = await script(two, 'mfarm-status=failed');
    check(failedHook.status === 200, 'a failing teardown reports too', `status ${failedHook.status}`);

    const failRows = await until('the failed result row', async () => {
      const r = await api(`/v1/sessions/${two}/results`);
      return r.body?.results?.length ? r.body.results : null;
    }, { timeoutMs: 15_000 });
    check(failRows?.[0]?.status === 'failed' && failRows?.[0]?.name === TEST_TWO,
      'recorded as a FAILURE, under the test\'s name', JSON.stringify(failRows?.[0]));
  }

  // ------------------------------------------------------------------ what the run screen has

  say('H — what a person actually sees on the run (the gap, measured rather than claimed)');

  const run = await api(`/v1/runs/${RUN_ID}`);
  const sessions = run.body?.sessions ?? [];
  check(sessions.some((s) => s.name === TEST_ONE),
    'the run\'s session list carries the test names — this is what Runs renders');

  const failures = run.body?.failures ?? [];
  check(failures.some((f) => f.name === TEST_TWO), 'the FAILING test is a row on the run');

  /**
   * NOT A DEFECT — A MEASUREMENT. `GET /runs/:id` returns per-session counts and a failures list,
   * so the passing test's name is now written down (F proved the row exists) and has nowhere to be
   * rendered. This assertion is deliberately written to PASS while that is true, so that the day
   * somebody adds test rows it fails and this comment gets read.
   */
  const passingRow = failures.some((f) => f.name === TEST_ONE);
  check(!passingRow,
    'and the PASSING test is not among them — a run still lists only failures (known gap)');
  note('the passing row exists in test_results and the run payload has nowhere to put it');

  // `session.tests.{total,passed,…}`, nested — the same guessing mistake as the run name above.
  const counts = sessions.find((s) => s.id === open[0])?.tests;
  check((counts?.passed ?? 0) >= 1,
    'the session\'s own counts do include it — so the run knows it passed, and cannot name it',
    JSON.stringify(counts));
}

const started = Date.now();
main()
  .catch((e) => { bad(`threw: ${e?.stack ?? e}`); })
  .finally(async () => {
    say('Releasing');
    await release();
    ok('every device released');

    const secs = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m  (${secs}s)\n`);
    process.exit(failed ? 1 : 0);
  });
