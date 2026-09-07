// Does the execution engine's evidence chain actually work on a real device?
//
// `docs/EXECUTION_ROADMAP.md` S2, S3, S4 and S6 all shipped with tests — API tests against a real
// Postgres, and agent tests against a real control plane with a faked Android. None of that can see
// the thing this asks: **on a real Cuttlefish, driven by a real Appium, does a failed test leave
// evidence a person can open?**
//
// The register's rule is that a defect leaves `DEFECTS.md` when it is verified on the deployed
// farm, not when CI is green — twice this month a fix was reasoned, unit-tested, merged and
// completely inert. This is that check for the execution work.
//
//   MFARM_API_KEY=$(cat ~/mfarm/deploy/.state/api_key) node deploy/verify-execution.mjs
//
// RUNS ON THE CONTROL PLANE, like `verify-queue.mjs` and for the same reason: it needs the hub on
// loopback and the API key that lives there, and it drives a device through the hub rather than
// touching the device host at all.
//
// It is READ-MOSTLY and self-cleaning: one session, one deliberate failure, and the device is
// released on every exit path. Nothing here quarantines a device or restarts a service.

const HUB = process.env.HUB ?? 'http://127.0.0.1:3000';
const REGION = process.env.REGION ?? 'lab';
const KEY = process.env.MFARM_API_KEY;
if (!KEY) { console.error('MFARM_API_KEY is required'); process.exit(2); }

const bearer = `Bearer ${KEY}`;
const RUN_ID = `verify-exec-${Date.now()}`;

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

/**
 * Poll until `fn()` returns something truthy, or give up.
 *
 * EVERYTHING HERE IS EVENTUALLY CONSISTENT BY DESIGN and the intervals are not guesses: the command
 * trace flushes on a 250ms timer, and evidence is requested by the control plane and collected by
 * the worker on its ten-second beat. A check that asserted immediately would be asserting the
 * timers, not the feature.
 */
async function until(label, fn, { timeoutMs = 45_000, everyMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) { note(`gave up waiting for ${label} after ${timeoutMs / 1000}s`); return null; }
    await sleep(everyMs);
  }
}

let hubSession = null;

async function main() {
  say(`Opening a WebDriver session (run ${RUN_ID})`);
  const opened = await api('/wd/hub/session', {
    method: 'POST',
    body: JSON.stringify({
      capabilities: {
        alwaysMatch: {
          platformName: 'android',
          'appium:automationName': 'UiAutomator2',
          'mfarm:region': REGION,
          'mfarm:runId': RUN_ID,
        },
      },
    }),
  });
  if (opened.status !== 200) {
    bad(`could not open a session: ${opened.status} ${opened.text.slice(0, 300)}`);
    return;
  }
  hubSession = opened.body.value.sessionId;
  ok(`session ${hubSession} on a real device`);

  // ---------------------------------------------------------------- S3: the command trace

  say('S3 — the hub writes down what it forwards (migration 041)');

  // A command that SUCCEEDS, and one that FAILS. Both have to appear, and only one may be red.
  const shot = await api(`/wd/hub/session/${hubSession}/screenshot`);
  check(shot.status === 200, 'a real screenshot command round-trips', `status ${shot.status}`);

  const missing = await api(`/wd/hub/session/${hubSession}/element`, {
    method: 'POST',
    body: JSON.stringify({ using: 'id', value: 'no-such-element-on-any-screen' }),
  });
  check(missing.status >= 400, 'a lookup for an element that does not exist fails', `status ${missing.status}`);

  const trace = await until('the command trace to flush', async () => {
    const r = await api(`/v1/sessions/${hubSession}/commands`);
    return r.body?.commands?.length >= 2 ? r.body.commands : null;
  }, { timeoutMs: 15_000 });

  if (!trace) {
    bad('no commands were recorded — the trace is the source a step list is built from');
  } else {
    ok(`${trace.length} step(s) recorded`);

    const seqs = trace.map((c) => c.seq);
    check(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'steps are numbered in order', seqs.join(','));

    const red = trace.filter((c) => c.failed);
    check(red.length >= 1, 'the failed lookup is marked failed — this is the step that renders red');
    if (red.length) {
      check(typeof red[0].error === 'string' && red[0].error.length > 0,
        `the W3C error code is stored: ${JSON.stringify(red[0].error)}`);
    }

    check(trace.every((c) => typeof c.durationMs === 'number' || c.durationMs === null),
      'every step carries how long it took');

    /**
     * THE PRIVACY ASSERTION, and the one worth running on real hardware rather than a fixture.
     * The selector above is a string only this script knows. If it appears anywhere in the trace,
     * the hub is storing request bodies — which is customer test data, and on a `POST
     * /element/:id/value` would be a password.
     */
    check(!JSON.stringify(trace).includes('no-such-element-on-any-screen'),
      'NO REQUEST BODY IS STORED — the selector this script sent appears nowhere in the trace');
  }

  // ---------------------------------------------------------------- S2 + S4: evidence and timeline

  say('S2 — a failed test asks for its own evidence (migration 040)');

  const reported = await api(`/v1/sessions/${hubSession}/result`, {
    method: 'POST',
    body: JSON.stringify({
      status: 'failed',
      name: 'verify-execution: a deliberate failure',
      failure: 'AssertionError: this failure is synthetic and expected',
      failureReason: 'assertion-failure',
    }),
  });
  check(reported.status === 201, 'the failure was recorded', `status ${reported.status}`);
  const resultId = reported.body?.result?.id;

  const actions = await until('the capture requests to appear', async () => {
    const r = await api(`/v1/sessions/${hubSession}/app-actions`);
    const caps = (r.body?.actions ?? []).filter((a) => a.kind === 'screenshot' || a.kind === 'logcat');
    return caps.length >= 2 ? caps : null;
  }, { timeoutMs: 15_000 });

  check(Boolean(actions), 'the control plane queued a screenshot AND a logcat, unasked');

  /**
   * The beat is ten seconds and a capture runs after it, so this is the slow part of the script and
   * the wait is generous on purpose. A tighter one would make a working farm look broken.
   */
  const evidence = await until('the worker to collect the evidence', async () => {
    const r = await api(`/v1/sessions/${hubSession}/artifacts`);
    const arts = r.body?.artifacts ?? [];
    const forFailure = arts.filter((a) => a.context?.source === 'test-failure');
    return forFailure.length >= 2 ? forFailure : null;
  }, { timeoutMs: 90_000, everyMs: 3_000 });

  if (!evidence) {
    bad('no failure-triggered evidence arrived — the worker never captured it');
  } else {
    ok(`${evidence.length} artifact(s) captured because a test failed`);
    const kinds = [...new Set(evidence.map((a) => a.kind))].sort();
    check(kinds.includes('screenshot') && kinds.includes('logcat'),
      'both halves — the screen, and what the app was saying', kinds.join('+'));
    check(evidence.every((a) => a.sizeBytes > 0), 'each carries bytes, not just a row');
    check(evidence.every((a) => a.context?.testResultId === resultId),
      'each NAMES the failure it was taken for — otherwise it is a mystery file');

    // The whole point of S2. A release-time screenshot shows the launcher; this one was taken while
    // the suite still held the device.
    const png = evidence.find((a) => a.kind === 'screenshot');
    if (png) {
      const blob = await fetch(`${HUB}/v1/artifacts/${png.id}/blob`, { headers: { authorization: bearer } });
      const buf = Buffer.from(await blob.arrayBuffer());
      check(buf.length > 1000 && buf.subarray(0, 4).toString('hex') === '89504e47',
        `the screenshot downloads as a real PNG (${buf.length} bytes)`);
    }
  }

  say('S4 — the timeline learns about tests (migration 042)');

  const events = await until('the run timeline', async () => {
    const r = await api(`/v1/runs/${RUN_ID}/timeline`);
    const evs = r.body?.events ?? [];
    return evs.some((e) => e.kind === 'test-failed') ? evs : null;
  }, { timeoutMs: 30_000, everyMs: 2_000 });

  if (!events) {
    bad('the timeline has no test-failed entry — the line somebody opens the page for');
  } else {
    ok(`${events.length} timeline event(s)`);
    const tf = events.find((e) => e.kind === 'test-failed');
    check(tf?.detail?.test === 'verify-execution: a deliberate failure', 'the entry names the test');
    check(typeof tf?.detail?.message === 'string' && !tf.detail.message.includes('\n'),
      'it carries a one-line headline, not the whole stack');
    check(events.some((e) => e.kind === 'artifact-created'),
      'evidence landing is on the timeline too, as a link');
    check(events.some((e) => e.kind === 'device-allocated'),
      'and the farm-side events are still there beside them');
  }

  // ---------------------------------------------------------------- S6: the queue says where you stand

  say('S6 — a queued caller is told where they stand (migration 043)');

  /**
   * FILLS THE FARM, which is the only honest way to reach the queued path — `verify-queue.mjs`
   * makes the same argument. Every session opened here is released in the `finally` below.
   */
  const held = [];
  try {
    for (let i = 0; i < 6; i++) {
      const r = await api('/v1/sessions', {
        method: 'POST',
        body: JSON.stringify({ region: REGION, platform: 'android' }),
      });
      if (r.status === 201) { held.push(r.body.session.id); continue; }
      if (r.status === 202) {
        held.push(r.body.session.id);
        ok('a full farm queues rather than refusing');
        const q = r.body.session.queue;
        check(q && typeof q.position === 'number' && q.position >= 1,
          `the POST says where you stand: position ${q?.position}, ${q?.ahead} ahead`);
        check(typeof r.body.message === 'string' && /queue/i.test(r.body.message),
          `and says it in a sentence: "${String(r.body.message).slice(0, 120)}"`);
        if (q?.estimatedStartAt) {
          ok(`an estimate could be proved: ${q.estimatedStartAt}`);
        } else {
          // Not a failure. Null is the honest answer where no lease can be read, and reporting it
          // as null rather than guessing is the whole design.
          note('no estimate — no readable lease on a matching device, which is reported as absent');
        }

        // The polling endpoint matters more than the POST: `mfarm run` reads it every few seconds.
        const polled = await api(`/v1/sessions/${r.body.session.id}`);
        check(polled.body?.session?.queue?.position >= 1,
          'the polling endpoint carries it too, which is what mfarm run reads');
        break;
      }
      note(`session ${i} answered ${r.status}: ${r.text.slice(0, 160)}`);
      break;
    }
    if (!held.length) bad('could not open any session to fill the farm');
  } finally {
    for (const id of held) {
      await api(`/v1/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    note(`released ${held.length} session(s) opened to fill the farm`);
  }
}

main()
  .catch((e) => { bad(`unhandled: ${e.stack ?? e.message}`); })
  .finally(async () => {
    // ALWAYS, on every exit path. A verifier that strands a device on a four-device farm has taken
    // a quarter of the fleet out of service to prove a point about evidence.
    if (hubSession) {
      await api(`/wd/hub/session/${hubSession}`, { method: 'DELETE' }).catch(() => {});
      note(`released ${hubSession}`);
    }
    console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
    process.exit(failed ? 1 : 0);
  });
