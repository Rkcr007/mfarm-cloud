/**
 * `mfarm run` against a real control plane on an ephemeral port, driving the real binary.
 *
 * Every test in here exists because of a specific way a device gets leaked. The device is the
 * product: one that is never released is billed to the customer and removed from the pool until the
 * reaper collects it, so "did we DELETE the session" is asserted on every path, including the ones
 * where the run itself failed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startControlPlane, runCli, envDumper, API_KEY, POLLED_ENDPOINT, POLLED_TOKEN,
} from './harness.ts';

const REGION = 'us-east';
const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const DEVICE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** `node -e <script>` as the child command, so tests do not depend on anything installed. */
const child = (script: string) => ['node', '-e', script];

describe('mfarm run', () => {
  test('passes the child exit code through verbatim and releases the device', async () => {
    const api = await startControlPlane();
    try {
      const r = await runCli([
        'run', '--api', api.url, '--region', REGION, '--',
        ...child('process.stdout.write("suite output\\n"); process.exit(3)'),
      ]);

      // 3, not 1 and not 0. CI branches on this number and a remap would silently turn a failing
      // suite green — or a passing one red.
      assert.equal(r.code, 3);
      assert.match(r.stdout, /suite output/);
      assert.equal(api.of('DELETE', `/v1/sessions/${SESSION_ID}`).length, 1);
    } finally {
      await api.close();
    }
  });

  test('releases the device when the child dies from a signal', async () => {
    const api = await startControlPlane();
    try {
      const r = await runCli([
        'run', '--api', api.url, '--region', REGION, '--',
        ...child('process.abort()'),
      ]);

      // 128 + SIGABRT(6): what a shell would have reported for the same crash.
      assert.equal(r.code, 134);
      assert.equal(api.of('DELETE', '/v1/sessions/').length, 1);
    } finally {
      await api.close();
    }
  });

  test('releases the device on SIGINT and exits 130', async () => {
    const api = await startControlPlane();
    try {
      const r = await runCli(
        ['run', '--api', api.url, '--region', REGION, '--', ...child('setInterval(() => {}, 1000)')],
        {
          // Wait for the child to actually be running before interrupting — otherwise the test
          // proves nothing about forwarding, only about failing early.
          onStderr(chunk, kill) {
            if (chunk.includes('is ready — running')) kill('SIGINT');
          },
        },
      );

      assert.equal(r.code, 130);
      assert.equal(api.of('DELETE', '/v1/sessions/').length, 1);
      assert.match(r.stderr, /SIGINT received/);
    } finally {
      await api.close();
    }
  });

  test('releases the device on SIGTERM and exits 130', async () => {
    const api = await startControlPlane();
    try {
      const r = await runCli(
        ['run', '--api', api.url, '--region', REGION, '--', ...child('setInterval(() => {}, 1000)')],
        {
          onStderr(chunk, kill) {
            if (chunk.includes('is ready — running')) kill('SIGTERM');
          },
        },
      );

      assert.equal(r.code, 130);
      assert.equal(api.of('DELETE', '/v1/sessions/').length, 1);
    } finally {
      await api.close();
    }
  });

  test('a second signal kills a child that ignored the first, without waiting out the grace period', async () => {
    const api = await startControlPlane();
    try {
      let sent = 0;
      const r = await runCli(
        [
          'run', '--api', api.url, '--region', REGION, '--',
          // Announces readiness only AFTER trapping SIGINT. Signalling on mfarm's own "running"
          // line would race the child's startup and test the default disposition instead.
          ...child("process.on('SIGINT', () => {}); setInterval(() => {}, 1000); console.log('trapped')"),
        ],
        {
          onStdout(chunk, kill) {
            if (sent === 0 && chunk.includes('trapped')) { sent = 1; kill('SIGINT'); }
          },
          onStderr(chunk, kill) {
            if (sent === 1 && chunk.includes('SIGINT received')) { sent = 2; kill('SIGINT'); }
          },
        },
      );

      // Without the escalation this test would sit in the 10s grace period. Passing quickly is the
      // assertion; the exit code proves the release path still ran.
      assert.equal(r.code, 130);
      assert.equal(api.of('DELETE', '/v1/sessions/').length, 1);
      assert.match(r.stderr, /second signal/);
    } finally {
      await api.close();
    }
  });

  test('a signal during the release window is handled, not a hard kill', async () => {
    // The release is the longest window in the program: a DELETE that 5xxs is retried three times
    // at a 30s timeout each, so a run can spend minutes here. Without a handler installed across
    // it, ^C is the default disposition — the process dies mid-DELETE and the child's exit code,
    // already earned, is thrown away and replaced by a signal death.
    const api = await startControlPlane({ deleteDelayMs: 30_000 });
    const started = Date.now();
    try {
      const r = await runCli(
        ['run', '--api', api.url, '--region', REGION, '--', ...child('process.exit(6)')],
        {
          onStderr(chunk, kill) {
            if (chunk.includes('releasing session')) kill('SIGINT');
          },
        },
      );

      // Exited on its own terms, not killed. ADR-0002 decision 5: what happens to the release
      // never changes the exit code, and that holds for a release the operator abandoned.
      assert.equal(r.signal, null, '^C during release must not hard-kill the process');
      assert.equal(r.code, 6, "the child's exit code survives an abandoned release");

      // Visible, and not a silent no-op: the operator is told the wait was dropped and who picks
      // the session up instead.
      assert.match(r.stderr, /SIGINT received while releasing/);
      assert.match(r.stderr, /reaper will collect session/);

      // And it actually stopped waiting. Announcing "not waiting any longer" while the pending
      // socket holds the event loop open for another 30s would be the same hang in a nicer coat.
      assert.ok(Date.now() - started < 15_000, `still exited promptly (took ${Date.now() - started}ms)`);
      assert.equal(api.of('DELETE', '/v1/sessions/').length, 1, 'the release was attempted');
    } finally {
      await api.close();
    }
  });

  test('polls a 202-queued session until it reaches ACTIVE, then runs the child', async () => {
    const api = await startControlPlane({ createStatuses: [202], pollStates: ['QUEUED', 'ACTIVE'] });
    try {
      const r = await runCli([
        'run', '--api', api.url, '--region', REGION, '--wait', '30', '--',
        ...child('process.exit(0)'),
      ]);

      assert.equal(r.code, 0);
      assert.equal(api.of('GET', '/v1/sessions/').length, 2, 'polled until the state changed');
      assert.equal(api.of('DELETE', '/v1/sessions/').length, 1);
      assert.match(r.stderr, /queued/);
    } finally {
      await api.close();
    }
  });

  test('a promoted session hands the child the coordinates it could not have at creation', async () => {
    // Known issue 9. POST answered 202 — no device, so no endpoint and no token — and the CLI used
    // to run the child with neither variable set whenever it had waited in the queue, and with both
    // whenever it had not. Identical commands, different environments, decided by whether the farm
    // happened to be busy. Anything speaking the raw data plane simply did not work after a wait.
    const api = await startControlPlane({ createStatuses: [202], pollStates: ['QUEUED', 'ACTIVE'] });
    const dir = await mkdtemp(join(tmpdir(), 'mfarm-cli-'));
    const dump = join(dir, 'env.json');
    try {
      const r = await runCli([
        'run', '--api', api.url, '--region', REGION, '--wait', '30', '--',
        'node', ...envDumper(dump),
      ]);
      assert.equal(r.code, 0);

      const env = JSON.parse(await readFile(dump, 'utf8'));
      assert.equal(env.MFARM_DEVICE_ID, DEVICE_ID);
      // The POLLED values, not the ones POST returns. They differ in the harness precisely so this
      // assertion can tell which response the environment was built from.
      assert.equal(env.MFARM_DATA_PLANE_ENDPOINT, POLLED_ENDPOINT);
      assert.equal(env.MFARM_SESSION_TOKEN, POLLED_TOKEN);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await api.close();
    }
  });

  test('a control plane that sends no coordinates leaves the variables unset, not empty', async () => {
    // An older control plane, or a host with no endpoint registered. WebDriver still works — it
    // gets its coordinates from the hub — so the run must not fail. What it must not do is set the
    // variables to "", which a client reads as a configured endpoint that then never connects.
    const api = await startControlPlane({
      createStatuses: [202], pollStates: ['QUEUED', 'ACTIVE'], omitPolledDataPlane: true,
    });
    const dir = await mkdtemp(join(tmpdir(), 'mfarm-cli-'));
    const dump = join(dir, 'env.json');
    try {
      const r = await runCli([
        'run', '--api', api.url, '--region', REGION, '--wait', '30', '--',
        'node', ...envDumper(dump),
      ]);
      assert.equal(r.code, 0, r.stderr);

      const env = JSON.parse(await readFile(dump, 'utf8'));
      assert.ok(!('MFARM_DATA_PLANE_ENDPOINT' in env), 'absent, not empty');
      assert.ok(!('MFARM_SESSION_TOKEN' in env), 'absent, not empty');
      assert.ok(env.MFARM_WEBDRIVER_URL, 'the WebDriver path is unaffected');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await api.close();
    }
  });

  test('--wait 0 fails immediately with 75 and still releases the queued session', async () => {
    const api = await startControlPlane({ createStatuses: [202] });
    try {
      const r = await runCli([
        'run', '--api', api.url, '--region', REGION, '--wait', '0', '--',
        ...child('process.exit(0)'),
      ]);

      // EX_TEMPFAIL. A queued session is a capacity problem, not a test failure, and CI should be
      // able to retry the job without a human deciding whether the suite is broken.
      assert.equal(r.code, 75);
      assert.equal(api.of('GET', '/v1/sessions/').length, 0, 'wait 0 must not poll at all');
      assert.equal(api.of('DELETE', '/v1/sessions/').length, 1, 'the queued session is still a session');
    } finally {
      await api.close();
    }
  });

  test('never retries a 4xx, and quotes the requestId', async () => {
    const api = await startControlPlane({ createStatuses: [400] });
    try {
      const r = await runCli([
        'run', '--api', api.url, '--region', REGION, '--', ...child('process.exit(0)'),
      ]);

      assert.equal(r.code, 1);
      assert.equal(api.of('POST', '/v1/sessions').length, 1, 'a 400 is the caller\'s fault; retrying only adds load');
      assert.equal(api.of('DELETE', '/v1/sessions/').length, 0, 'nothing was allocated, so nothing to release');
      assert.match(r.stderr, /region is required/);
      assert.match(r.stderr, /req-400/);
    } finally {
      await api.close();
    }
  });

  test('retries a 5xx with the same Idempotency-Key and then runs the child', async () => {
    const api = await startControlPlane({ createStatuses: [503, 503, 201] });
    try {
      const r = await runCli([
        'run', '--api', api.url, '--region', REGION, '--', ...child('process.exit(7)'),
      ]);

      assert.equal(r.code, 7);
      const posts = api.of('POST', '/v1/sessions');
      assert.equal(posts.length, 3);

      // The retry that matters is the one for a request the server already processed. A fresh key
      // per attempt would allocate — and bill — a device per retry.
      const keys = new Set(posts.map((p) => p.headers['idempotency-key']));
      assert.equal(keys.size, 1, 'all attempts must carry one key');
      assert.match([...keys][0]!, /^[0-9a-f-]{36}$/);
    } finally {
      await api.close();
    }
  });

  test('gives up after the retry budget and reports the transport failure', async () => {
    const api = await startControlPlane({ createStatuses: [503] });
    try {
      const r = await runCli([
        'run', '--api', api.url, '--region', REGION, '--', ...child('process.exit(0)'),
      ]);

      assert.equal(r.code, 1);
      assert.equal(api.of('POST', '/v1/sessions').length, 4, 'first attempt plus three retries');
      assert.match(r.stderr, /req-503/);
    } finally {
      await api.close();
    }
  });

  test('injects the session coordinates, with a correctly formed MFARM_WEBDRIVER_URL', async () => {
    const api = await startControlPlane();
    const dir = await mkdtemp(join(tmpdir(), 'mfarm-cli-'));
    const dump = join(dir, 'env.json');
    try {
      const r = await runCli([
        'run', '--api', api.url, '--region', REGION, '--', 'node', ...envDumper(dump),
      ]);
      assert.equal(r.code, 0);

      const env = JSON.parse(await readFile(dump, 'utf8'));
      assert.equal(env.MFARM_SESSION_ID, SESSION_ID);
      assert.equal(env.MFARM_DEVICE_ID, DEVICE_ID);
      assert.equal(env.MFARM_REGION, REGION);
      assert.equal(env.MFARM_DATA_PLANE_ENDPOINT, 'wss://worker-1.mfarm.dev/ws');
      assert.equal(env.MFARM_SESSION_TOKEN, 'v1.signed.token');

      // The whole adoption story is this one string: an Appium client reads it and needs no other
      // change. Basic-auth userinfo, hub path at the origin, nothing else appended.
      //
      // The session id in the password half is what stops the hub allocating a SECOND device for
      // the same run and billing for it (ADR-0002 D1). Without it this URL is still valid and the
      // suite still passes — it just quietly costs twice — so this assertion is the only thing
      // standing between that defect and a green build.
      assert.equal(
        env.MFARM_WEBDRIVER_URL,
        `http://${API_KEY}:${SESSION_ID}@127.0.0.1:${new URL(api.url).port}/wd/hub`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
      await api.close();
    }
  });

  test('never prints the API key, in any output stream', async () => {
    const api = await startControlPlane();
    try {
      const r = await runCli([
        'run', '--api', api.url, '--region', REGION, '--json', '--',
        ...child('process.exit(0)'),
      ]);

      assert.equal(r.code, 0);
      assert.doesNotMatch(r.stdout, /mfk_/, 'stdout leaked a credential');
      assert.doesNotMatch(r.stderr, /mfk_/, 'stderr leaked a credential');
    } finally {
      await api.close();
    }
  });

  test('--json emits one machine-readable object with the masked hub URL', async () => {
    const api = await startControlPlane();
    try {
      const r = await runCli([
        'run', '--api', api.url, '--region', REGION, '--json', '--quiet', '--',
        ...child('process.exit(4)'),
      ]);

      assert.equal(r.code, 4);
      assert.equal(r.stderr, '', '--quiet means no progress chatter');
      const summary = JSON.parse(r.stdout.trim());
      assert.equal(summary.sessionId, SESSION_ID);
      assert.equal(summary.deviceId, DEVICE_ID);
      assert.equal(summary.exitCode, 4);
      assert.match(summary.webdriverUrl, /^http:\/\/\*\*\*@/);
    } finally {
      await api.close();
    }
  });

  test('a failed release is logged but does not change the exit code', async () => {
    // 500 on DELETE: the release is retried, fails, and the run still reports what the suite did.
    const api = await startControlPlane({ deleteStatus: 500 });
    try {
      const r = await runCli([
        'run', '--api', api.url, '--region', REGION, '--', ...child('process.exit(0)'),
      ]);

      assert.equal(r.code, 0, 'a cleanup hiccup must never mask a green run');
      assert.match(r.stderr, /could not release session/);
    } finally {
      await api.close();
    }
  });

  test('a session that ends before a device is attached is reported, not waited out', async () => {
    const api = await startControlPlane({ createStatuses: [202], pollStates: ['FAILED'] });
    try {
      const r = await runCli([
        'run', '--api', api.url, '--region', REGION, '--wait', '30', '--',
        ...child('process.exit(0)'),
      ]);

      assert.equal(r.code, 1);
      assert.match(r.stderr, /FAILED/);
      assert.match(r.stderr, /no_capacity/);
      assert.equal(api.of('DELETE', '/v1/sessions/').length, 1);
    } finally {
      await api.close();
    }
  });

  test('a command that does not exist is a configuration failure, and releases the device', async () => {
    const api = await startControlPlane();
    try {
      const r = await runCli([
        'run', '--api', api.url, '--region', REGION, '--', 'mfarm-no-such-binary-9f3a',
      ]);

      assert.equal(r.code, 1);
      assert.match(r.stderr, /could not start mfarm-no-such-binary-9f3a/);
      assert.equal(api.of('DELETE', '/v1/sessions/').length, 1);
    } finally {
      await api.close();
    }
  });
});
