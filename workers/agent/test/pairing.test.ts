import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { pairForToken, PairingError } from '../src/pairing.ts';

/**
 * The agent's half of pairing — ADR-0014.
 *
 * A REAL SERVER ON A REAL SOCKET, because here the agent is the CLIENT. `app.inject()` tests the
 * control plane; nothing it can do exercises a polling loop, and a polling loop is exactly the
 * shape that fails in ways static reading misses — giving up on the expected `pending`, treating a
 * lapsed code as fatal, dying on a network blip, hammering an endpoint that asked for patience.
 *
 * The clock is injected so a ten-minute TTL and a five-second interval cost nothing to test. The
 * WAITS ARE STILL ASSERTED rather than stubbed away: a loop that polls without waiting passes every
 * behavioural test here and is a denial-of-service against our own control plane.
 */

/** A scripted control plane. Each entry answers one request, in order. */
type Reply = { status: number; body?: unknown };

let server: Server;
let base: string;
let script: Reply[];
let seen: Array<{ path: string; body: any }>;

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : undefined });
      const next = script.shift() ?? { status: 500, body: { error: 'script exhausted' } };
      const payload = JSON.stringify(next.body ?? {});
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(payload);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(() => { script = []; seen = []; });

const started = (userCode = 'ABCD-2345', deviceCode = 'd'.repeat(43)) => ({
  status: 201,
  body: { deviceCode, userCode, expiresAt: new Date(Date.now() + 600_000).toISOString(), intervalSeconds: 5 },
});
const pending = { status: 200, body: { status: 'pending', intervalSeconds: 5 } };
const approved = (token = 'mae_a-real-looking-token') => ({ status: 200, body: { status: 'approved', token, orgId: 'org-1' } });
const gone = { status: 410, body: { error: { code: 'pairing_gone' } } };

/** Collects what the window would render, and every wait the loop asked for. */
function harness() {
  const shown: Array<{ userCode: string; status: string; attempt: number }> = [];
  const waits: number[] = [];
  return {
    shown, waits,
    opts: {
      controlPlaneUrl: base,
      hostname: 'ravi-macbook',
      agentVersion: '0.1.0',
      onProgress: (p: { userCode: string; status: string; attempt: number }) =>
        shown.push({ userCode: p.userCode, status: p.status, attempt: p.attempt }),
      sleep: async (ms: number) => { waits.push(ms); },
    },
  };
}

describe('pairing, from the agent side', () => {
  test('shows a code, waits, and returns the token once approved', async () => {
    script = [started(), pending, pending, approved()];
    const h = harness();
    const token = await pairForToken(h.opts);

    assert.equal(token, 'mae_a-real-looking-token');
    assert.deepEqual(h.shown, [
      { userCode: 'ABCD-2345', status: 'waiting', attempt: 1 },
      { userCode: 'ABCD-2345', status: 'approved', attempt: 1 },
    ]);
    // Waited before every poll, never before showing the code — the code has to be on screen first
    // or the person is being asked to wait for something they cannot see.
    assert.deepEqual(h.waits, [5000, 5000, 5000]);
  });

  test('tells the control plane what machine this is, so a human can recognise it', async () => {
    script = [started(), approved()];
    await pairForToken(harness().opts);
    assert.equal(seen[0].path, '/v1/pair');
    assert.equal(seen[0].body.hostname, 'ravi-macbook');
    assert.equal(seen[0].body.agentVersion, '0.1.0');
    assert.match(seen[0].body.platform, /^(darwin|linux|win32)-/);
  });

  test('the device code goes to the poll and is never shown to a person', async () => {
    script = [started('WXYZ-6789', 'the-device-secret-'.repeat(3)), approved()];
    const h = harness();
    await pairForToken(h.opts);

    assert.equal(seen[1].path, '/v1/pair/poll');
    assert.equal(seen[1].body.deviceCode, 'the-device-secret-'.repeat(3));
    // THE POINT. The two secrets do different jobs and only one belongs on a screen.
    const rendered = JSON.stringify(h.shown);
    assert.ok(!rendered.includes('the-device-secret'), 'the device code must never reach the window');
    assert.ok(rendered.includes('WXYZ-6789'));
  });

  test('a lapsed code is replaced, not fatal', async () => {
    /**
     * Ten minutes is short by design, and the person who just downloaded this may be reading the
     * setup page or finding their phone. Giving up would mean restarting the agent for a reason
     * that is entirely ours, told to somebody who has been told the software is running.
     */
    script = [started('AAAA-2222'), pending, gone, started('BBBB-3333'), pending, approved()];
    const h = harness();
    const token = await pairForToken(h.opts);

    assert.match(token, /^mae_/);
    assert.deepEqual(h.shown.map((s) => `${s.userCode}:${s.status}:${s.attempt}`), [
      'AAAA-2222:waiting:1',
      'BBBB-3333:waiting:2',
      'BBBB-3333:approved:2',
    ]);
  });

  test('a network blip keeps the code on screen and tries again', async () => {
    // The farm restarting is not a reason to abandon a code somebody may be typing right now.
    let firstPoll = true;
    const flaky: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/v1/pair/poll') && firstPoll) {
        firstPoll = false;
        throw new Error('ECONNREFUSED');
      }
      return fetch(url as string, init);
    };
    script = [started(), approved()];
    const h = harness();
    const token = await pairForToken({ ...h.opts, fetchImpl: flaky });
    assert.match(token, /^mae_/);
    assert.equal(h.shown.filter((s) => s.status === 'waiting').length, 1, 'the same code stayed up');
  });

  test('a 429 is a wait, not a failure', async () => {
    script = [started(), { status: 429, body: { error: { code: 'rate_limited' } } }, approved()];
    const token = await pairForToken(harness().opts);
    assert.match(token, /^mae_/);
  });

  test('gives up after a bounded number of lapsed codes', async () => {
    // An unattended agent must not poll somebody's control plane forever.
    script = [started(), gone, started(), gone, started(), gone];
    const h = harness();
    await assert.rejects(
      () => pairForToken({ ...h.opts, maxAttempts: 3 }),
      (e: Error) => e instanceof PairingError && /no one approved this machine/.test(e.message),
    );
    assert.equal(h.shown.length, 3);
  });

  test('a control plane that cannot start a pairing says so in words', async () => {
    script = [{ status: 404, body: {} }];
    await assert.rejects(
      () => pairForToken(harness().opts),
      (e: Error) => e instanceof PairingError && /refused to start a pairing \(404\)/.test(e.message)
        && /CONTROL_PLANE_URL/.test(e.message),
    );
  });

  test('an unreadable approval is refused rather than guessed at', async () => {
    script = [started(), { status: 200, body: { status: 'approved' } }];   // no token
    await assert.rejects(() => pairForToken(harness().opts), PairingError);
  });

  test('an abort stops it between polls', async () => {
    const ac = new AbortController();
    script = [started(), pending, pending, pending, pending];
    const h = harness();
    let polls = 0;
    const opts = {
      ...h.opts,
      signal: ac.signal,
      sleep: async () => { polls += 1; if (polls === 2) ac.abort(); },
    };
    await assert.rejects(() => pairForToken(opts), (e: Error) => /cancelled/.test(e.message));
  });

  test('a nonsense interval cannot become a busy loop or a stall', async () => {
    // Never trust the server's pacing blindly: 0 would spin, and 86400 would look like a hang.
    for (const [given, expected] of [[0, 1000], [-5, 1000], [999999, 60_000], [undefined, 5000]] as const) {
      script = [
        { status: 201, body: {
          deviceCode: 'd'.repeat(43), userCode: 'ABCD-2345',
          expiresAt: new Date(Date.now() + 600_000).toISOString(), intervalSeconds: given,
        } },
        approved(),
      ];
      const h = harness();
      await pairForToken(h.opts);
      assert.deepEqual(h.waits, [expected], `interval ${String(given)}`);
    }
  });

  test('a trailing slash on the control plane url does not double it', async () => {
    script = [started(), approved()];
    await pairForToken({ ...harness().opts, controlPlaneUrl: `${base}/` });
    assert.equal(seen[0].path, '/v1/pair');
  });
});
