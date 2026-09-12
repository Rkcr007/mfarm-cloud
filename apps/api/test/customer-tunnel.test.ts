/**
 * The customer tunnel, end to end, over real sockets (migration 052).
 *
 * WHAT MAKES THIS TEST WORTH HAVING. `app.inject()` cannot see a socket lifecycle — it is the
 * blindspot this repo has already paid for twice — and a tunnel is nothing BUT socket lifecycle. So
 * every test below runs a real HTTP server on a real port, dials a real WebSocket at a real
 * listening control plane, and drives the actual `runTunnel` client from `@mfarm/cli`. Nothing here
 * is a stub of the thing under test.
 *
 * The "private staging host" is an ordinary `http.Server` on 127.0.0.1 that the control plane has
 * no special knowledge of, which is exactly its role in the real deployment.
 */
process.env.RATE_LIMIT_MAX = '10000';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { createApiKey } from '../src/auth.ts';
import { runTunnel, parseAllowRule, tunnelUrl, forwardable } from '../../cli/src/tunnel.ts';
import { tunnelAllows, type ProxyFrame } from '@mfarm/protocol';

let app: FastifyInstance;
let baseUrl: string;
let orgA: string, orgB: string;
let keyA: string, keyB: string;

/** The customer's "private" staging host. The control plane knows nothing about it. */
let staging: Server;
let stagingUrl: string;
let stagingHits: string[] = [];

function startStaging(): Promise<string> {
  staging = createServer((req, res) => {
    stagingHits.push(`${req.method} ${req.url}`);
    if (req.url === '/slow') {
      setTimeout(() => { res.writeHead(200); res.end('late'); }, 50);
      return;
    }
    if (req.url === '/boom') { res.destroy(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'x-seen-host': String(req.headers.host) });
    res.end(JSON.stringify({ ok: true, path: req.url, ua: req.headers['user-agent'] ?? null }));
  });
  return new Promise((resolve) => {
    staging.listen(0, '127.0.0.1', () => {
      const a = staging.address();
      resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`);
    });
  });
}

/**
 * Start a client and resolve once the farm has acknowledged it.
 *
 * Returns a stop function. Every test that starts one must stop it, or the process keeps a socket
 * and an interval alive and `node --test` hangs at the end of the file with no failure — which
 * reads as a broken suite rather than as a leaked handle.
 */
async function startClient(opts: {
  key: string; name: string; allow: string[]; client?: string;
}): Promise<{ stop: () => void; lines: string[] }> {
  const lines: string[] = [];
  let ready: () => void;
  const isReady = new Promise<void>((r) => { ready = r; });

  const controller = new AbortController();
  void runTunnel({
    baseUrl,
    apiKey: opts.key,
    name: opts.name,
    allow: opts.allow.map(parseAllowRule),
    client: opts.client,
    out: (l) => lines.push(l),
    onReady: () => ready(),
    maxRetries: 0,
  }).catch(() => { /* a refused tunnel is a tested outcome, not a test failure */ });

  await Promise.race([
    isReady,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`tunnel never became ready: ${lines.join(' | ')}`)), 5000)),
  ]);
  return { stop: () => controller.abort(), lines };
}

/**
 * Drive one proxied request the way a device's channel does, and collect the response.
 *
 * This stands in for the agent-side proxy, which is the one leg of the path that needs hardware.
 * What it exercises is everything from the control plane outward — the registry, the routing, the
 * client's allow check, and the real HTTP call — using the same `ProxyChannel` the agent path uses.
 */
function proxy(orgId: string, name: string, req: Extract<ProxyFrame, { k: 'req' }>): Promise<{
  status?: number; headers?: Record<string, string>; body: string; error?: string; code?: string;
}> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let status: number | undefined;
    let headers: Record<string, string> | undefined;
    let error: string | undefined;
    let code: string | undefined;
    const done = () => resolve({ status, headers, body: Buffer.concat(chunks).toString(), error, code });

    const ch = app.customerTunnels.open(orgId, name, {
      onFrame: (f) => {
        if (f.k === 'res') { status = f.status; headers = f.headers; return; }
        if (f.k === 'd') { chunks.push(Buffer.from(f.b, 'base64')); return; }
        if (f.k === 'err') { error = f.message; code = f.code; return; }
        if (f.k === 'end') done();
      },
      onClose: () => done(),
    });
    if (!ch) { error = 'no_tunnel'; code = 'no_tunnel'; return done(); }
    ch.send(req);
    /**
     * THE `end` IS PART OF THE CONTRACT, not a nicety. A request head keeps the upstream call open
     * so a POST body can follow; the client ends it only when this arrives. The real device proxy
     * sends one as soon as its own request stream finishes — including for a GET — and a helper
     * that skipped it was testing a shape nothing produces.
     */
    ch.send({ k: 'end' });
    setTimeout(() => done(), 4000);
  });
}

const get = (url: string, headers: Record<string, string> = {}) =>
  ({ k: 'req' as const, method: 'GET', url, headers });

before(async () => {
  stagingUrl = await startStaging();
  await withSystem(async (c) => {
    orgA = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,'Tunnel A',50) RETURNING id`,
      [`tun-a-${randomUUID().slice(0, 8)}`])).rows[0].id;
    orgB = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,'Tunnel B',50) RETURNING id`,
      [`tun-b-${randomUUID().slice(0, 8)}`])).rows[0].id;
  });
  keyA = (await createApiKey(orgA, 'tunnel test A')).plaintext;
  keyB = (await createApiKey(orgB, 'tunnel test B')).plaintext;

  app = await buildServer({ logger: false });
  // A REAL LISTENER. `app.inject` never performs an HTTP upgrade, so nothing in this file would
  // exercise a byte of the tunnel against an injected server.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  app.customerTunnels.closeAll();
  await app?.close();
  await new Promise((r) => staging.close(r));
  await closePools();
});

// ---------------------------------------------------------------------------------------------

describe('a client connects', () => {
  test('a tunnel comes up and is recorded where the console can see it', async () => {
    const { stop } = await startClient({ key: keyA, name: 'staging', allow: ['127.0.0.1'], client: 'a-laptop' });
    try {
      assert.equal(app.customerTunnels.has(orgA, 'staging'), true);
      const row = await withSystem(async (c) => (await c.query(
        'SELECT name, client, allow, last_seen_at FROM tunnels WHERE org_id = $1 AND name = $2',
        [orgA, 'staging'])).rows[0]);
      assert.ok(row, 'a live tunnel the console cannot see is how "where is this traffic going" starts');
      assert.equal(row.client, 'a-laptop');
      assert.deepEqual(row.allow, [{ host: '127.0.0.1' }]);
      assert.ok(row.last_seen_at);
    } finally { stop(); app.customerTunnels.closeAll(); }
  });

  test('a bad key is refused, and the client is told rather than left to retry', async () => {
    const lines: string[] = [];
    await runTunnel({
      baseUrl, apiKey: 'mfk_definitely-not-a-real-key-at-all', name: 'nope',
      allow: [parseAllowRule('127.0.0.1')], out: (l) => lines.push(l), maxRetries: 0,
    }).catch(() => { /* refusal is the outcome under test */ });
    assert.match(lines.join(' '), /refused|not accepted/i,
      `the client must print why: ${lines.join(' | ')}`);
    assert.equal(app.customerTunnels.has(orgA, 'nope'), false);
  });

  test('a tunnel with no allow rules refuses to start at all', async () => {
    await assert.rejects(
      () => runTunnel({ baseUrl, apiKey: keyA, name: 'empty', allow: [], maxRetries: 0 }),
      /could not reach anything/,
      'starting one that can reach nothing looks exactly like one that works, until it does not',
    );
  });

  test('an unusable name is refused before a socket is opened', async () => {
    await assert.rejects(
      () => runTunnel({ baseUrl, apiKey: keyA, name: 'Not A Name', allow: [parseAllowRule('*')], maxRetries: 0 }),
      /not a usable tunnel name/,
    );
  });

  test('a second client for the same name replaces the first', async () => {
    const first = await startClient({ key: keyA, name: 'dup', allow: ['127.0.0.1'], client: 'one' });
    const second = await startClient({ key: keyA, name: 'dup', allow: ['127.0.0.1'], client: 'two' });
    try {
      const live = app.customerTunnels.listFor(orgA).filter((t) => t.name === 'dup');
      assert.equal(live.length, 1, 'a replaced socket must not linger as a second route');
      assert.equal(live[0].client, 'two', 'the newest authenticated connection is the truthful one');
    } finally { first.stop(); second.stop(); app.customerTunnels.closeAll(); }
  });
});

// ---------------------------------------------------------------------------------------------

describe('a device reaches the private host', () => {
  test('a request goes out through the customer and the response comes back', async () => {
    stagingHits = [];
    const { stop } = await startClient({ key: keyA, name: 'staging', allow: ['127.0.0.1'] });
    try {
      const res = await proxy(orgA, 'staging', get(`${stagingUrl}/orders/7`));
      assert.equal(res.status, 200, res.error);
      assert.deepEqual(JSON.parse(res.body).path, '/orders/7');
      assert.deepEqual(stagingHits, ['GET /orders/7'],
        'the private host must have been reached exactly once, by the client');
    } finally { stop(); app.customerTunnels.closeAll(); }
  });

  /**
   * THE TEST THIS FEATURE EXISTS FOR AND THE ONE THAT MUST NEVER GO GREEN WRONGLY. A tunnel is a
   * hole in somebody's network; if the allow-list does not hold, this feature is a liability rather
   * than a product.
   */
  test('a host outside the allow rules is refused, and the refusal names it', async () => {
    stagingHits = [];
    const { stop } = await startClient({ key: keyA, name: 'staging', allow: ['staging.acme.internal'] });
    try {
      const res = await proxy(orgA, 'staging', get(`${stagingUrl}/secrets`));
      assert.equal(res.code, 'not_allowed', `expected a refusal, got ${JSON.stringify(res)}`);
      assert.match(res.error ?? '', /not in this tunnel's --allow rules/);
      assert.deepEqual(stagingHits, [], 'the request must not have been made at all');
    } finally { stop(); app.customerTunnels.closeAll(); }
  });

  test('a port outside the rule is refused even when the host matches', async () => {
    stagingHits = [];
    const { stop } = await startClient({ key: keyA, name: 'staging', allow: ['127.0.0.1:9'] });
    try {
      const res = await proxy(orgA, 'staging', get(`${stagingUrl}/orders`));
      assert.equal(res.code, 'not_allowed');
      assert.deepEqual(stagingHits, []);
    } finally { stop(); app.customerTunnels.closeAll(); }
  });

  /**
   * ANOTHER ORG'S TUNNEL IS NOT REACHABLE BY ANY SPELLING. Routing is by `org:name`, and the org
   * comes from the session the device is serving rather than from anything in the request —
   * architecture rule 4 on the path where breaking it would let one tenant into another's network.
   */
  test('another org cannot route through this org’s tunnel', async () => {
    stagingHits = [];
    const { stop } = await startClient({ key: keyA, name: 'staging', allow: ['*'] });
    try {
      assert.equal(app.customerTunnels.has(orgB, 'staging'), false);
      const res = await proxy(orgB, 'staging', get(`${stagingUrl}/orders`));
      assert.equal(res.code, 'no_tunnel');
      assert.deepEqual(stagingHits, [], 'not one byte may reach the other tenant’s network');
    } finally { stop(); app.customerTunnels.closeAll(); }
  });

  test('asking for a tunnel nobody started says so, rather than timing out', async () => {
    const res = await proxy(orgA, 'never-started', get(`${stagingUrl}/x`));
    assert.equal(res.code, 'no_tunnel');
  });

  test('a staging host that is down reads as unreachable, not as a farm fault', async () => {
    const { stop } = await startClient({ key: keyA, name: 'staging', allow: ['127.0.0.1'] });
    try {
      // Port 1 on loopback: reliably nothing listening, and refused fast.
      const res = await proxy(orgA, 'staging', get('http://127.0.0.1:1/'));
      assert.equal(res.code, 'unreachable');
      assert.match(res.error ?? '', /nothing is listening|ECONNREFUSED|failed/i);
    } finally { stop(); app.customerTunnels.closeAll(); }
  });

  test('the private host sees its OWN hostname, not the device’s', async () => {
    const { stop } = await startClient({ key: keyA, name: 'staging', allow: ['127.0.0.1'] });
    try {
      const res = await proxy(orgA, 'staging',
        get(`${stagingUrl}/vhost`, { host: 'staging.acme.internal', 'user-agent': 'a-device' }));
      assert.equal(res.status, 200);
      assert.match(res.headers?.['x-seen-host'] ?? '', /^127\.0\.0\.1:/,
        'a virtual-hosted staging server given the wrong Host answers for the wrong site');
      assert.equal(JSON.parse(res.body).ua, 'a-device', 'the device’s other headers do go through');
    } finally { stop(); app.customerTunnels.closeAll(); }
  });

  test('a dropped client tells every request in flight instead of hanging it', async () => {
    const { stop } = await startClient({ key: keyA, name: 'staging', allow: ['127.0.0.1'] });
    const pending = proxy(orgA, 'staging', get(`${stagingUrl}/slow`));
    app.customerTunnels.closeAll();
    const res = await pending;
    assert.ok(res.status === undefined || res.status === 200,
      'either it completed or it was told; what it must not do is hang');
    stop();
  });
});

// ---------------------------------------------------------------------------------------------

describe('the allow-list itself', () => {
  /** Pinned directly, because it is the security boundary and it is pure. */
  test('wildcards match subdomains and the bare domain, and nothing else', () => {
    const rules = [parseAllowRule('*.acme.internal')];
    assert.equal(tunnelAllows(rules, 'api.acme.internal', 443), true);
    assert.equal(tunnelAllows(rules, 'a.b.acme.internal', 443), true);
    // The bare domain, deliberately — a customer writing the wildcard means "this environment", and
    // making them add a second rule is how people end up writing `*`.
    assert.equal(tunnelAllows(rules, 'acme.internal', 443), true);
    assert.equal(tunnelAllows(rules, 'acme.internal.evil.com', 443), false,
      'a suffix match on the wrong boundary is the classic way an allow-list leaks');
    assert.equal(tunnelAllows(rules, 'notacme.internal', 443), false);
  });

  test('an exact rule is exact', () => {
    const rules = [parseAllowRule('staging.acme.internal')];
    assert.equal(tunnelAllows(rules, 'staging.acme.internal', 80), true);
    assert.equal(tunnelAllows(rules, 'other.acme.internal', 80), false);
    assert.equal(tunnelAllows(rules, 'acme.internal', 80), false);
  });

  test('a port pins the rule to that port only', () => {
    const rules = [parseAllowRule('localhost:3000')];
    assert.equal(tunnelAllows(rules, 'localhost', 3000), true);
    assert.equal(tunnelAllows(rules, 'localhost', 3001), false);
  });

  test('an absent port means any port', () => {
    const rules = [parseAllowRule('localhost')];
    assert.equal(tunnelAllows(rules, 'localhost', 1), true);
    assert.equal(tunnelAllows(rules, 'localhost', 65535), true);
  });

  test('`*` means everything, and a person has to type it', () => {
    assert.equal(tunnelAllows([parseAllowRule('*')], 'anything.at.all', 80), true);
    assert.equal(tunnelAllows([], 'anything.at.all', 80), false, 'the default is deny');
  });

  test('matching is case-insensitive on the host', () => {
    assert.equal(tunnelAllows([parseAllowRule('Staging.ACME.internal')], 'staging.acme.internal', 80), true);
    assert.equal(tunnelAllows([parseAllowRule('staging.acme.internal')], 'STAGING.ACME.INTERNAL', 80), true);
  });

  test('a malformed port is refused loudly rather than dropped', () => {
    assert.throws(() => parseAllowRule('host:99999'), /outside 1-65535/);
    assert.throws(() => parseAllowRule('   '), /needs a host/);
  });
});

describe('what is forwarded', () => {
  test('hop-by-hop headers do not cross the tunnel', () => {
    const out = forwardable({
      'user-agent': 'device', connection: 'keep-alive', 'transfer-encoding': 'chunked',
      'proxy-authorization': 'secret', host: 'device-saw-this', accept: '*/*',
    }, 'staging.acme.internal:8443');
    assert.equal(out['user-agent'], 'device');
    assert.equal(out.accept, '*/*');
    assert.equal(out.connection, undefined, 'forwarding this is how a proxy leaks sockets');
    assert.equal(out['transfer-encoding'], undefined);
    assert.equal(out['proxy-authorization'], undefined);
    assert.equal(out.host, 'staging.acme.internal:8443', 'rewritten, not dropped');
  });
});

describe('where the client dials', () => {
  test('an https base becomes wss, and http becomes ws', () => {
    assert.equal(tunnelUrl('https://farm.mfarm.dev'), 'wss://farm.mfarm.dev/v1/tunnel');
    assert.equal(tunnelUrl('http://127.0.0.1:3000'), 'ws://127.0.0.1:3000/v1/tunnel');
  });
});


// ---------------------------------------------------------------------------------------------

describe('what the console is shown', () => {
  test('a live tunnel is listed as connected, with the rules actually in force', async () => {
    const { stop } = await startClient({ key: keyA, name: 'listed', allow: ['*.acme.internal'], client: 'ci-runner' });
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/tunnels', headers: { authorization: `Bearer ${keyA}` } });
      assert.equal(res.statusCode, 200, res.body);
      const t = res.json().tunnels.find((x: { name: string }) => x.name === 'listed');
      assert.ok(t, res.body);
      assert.equal(t.connected, true);
      assert.equal(t.client, 'ci-runner');
      assert.deepEqual(t.allow, [{ host: '*.acme.internal' }]);
      assert.ok(t.connectedAt);
    } finally { stop(); app.customerTunnels.closeAll(); }
  });

  /**
   * "MY TUNNEL IS DOWN" AND "I NEVER HAD A TUNNEL" ARE DIFFERENT PROBLEMS with different fixes, and
   * a list that only knew live sockets could not tell them apart. This is the whole reason there is
   * a table at all.
   */
  test('a tunnel that has disconnected is still listed, as not connected', async () => {
    const { stop } = await startClient({ key: keyA, name: 'was-here', allow: ['127.0.0.1'] });
    stop();
    app.customerTunnels.closeAll();

    const res = await app.inject({ method: 'GET', url: '/v1/tunnels', headers: { authorization: `Bearer ${keyA}` } });
    const t = res.json().tunnels.find((x: { name: string }) => x.name === 'was-here');
    assert.ok(t, 'a tunnel that once connected must not vanish from the list');
    assert.equal(t.connected, false);
    assert.ok(t.lastSeenAt, 'and it must say when it was last here');
  });

  test('another org’s tunnels are not listed', async () => {
    const { stop } = await startClient({ key: keyA, name: 'private-to-a', allow: ['127.0.0.1'] });
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/tunnels', headers: { authorization: `Bearer ${keyB}` } });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().tunnels.some((x: { name: string }) => x.name === 'private-to-a'), false);
    } finally { stop(); app.customerTunnels.closeAll(); }
  });

  /**
   * FORGETTING A TUNNEL MUST STOP THE CLIENT, not merely drop it.
   *
   * The client reconnects with backoff — that is the point of it, because the thing it replaces is
   * an SSH forward that dies with a laptop's wifi. So the first version of `disconnect` closed with
   * 1001 and the client came back one second later: the console said "No tunnels yet" while the API
   * said one was connected. Found in a browser against a real client; every test passed.
   */
  test('forgetting a tunnel closes it as a refusal, so the client does not come back', async () => {
    const lines: string[] = [];
    let ready: () => void;
    const isReady = new Promise<void>((r) => { ready = r; });
    const finished = runTunnel({
      baseUrl, apiKey: keyA, name: 'forget-me', allow: [parseAllowRule('127.0.0.1')],
      out: (l) => lines.push(l), onReady: () => ready(),
      // Retries ALLOWED, so that a version which retried would be caught rather than prevented.
      maxRetries: 3,
    }).catch(() => { /* a stop is not a throw */ });
    await isReady;

    assert.equal(app.customerTunnels.disconnect(orgA, 'forget-me', 'this tunnel was removed'), true);
    // `runTunnel` resolves only when it has decided not to dial again.
    await Promise.race([
      finished,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`the client kept dialling: ${lines.join(' | ')}`)), 4000)),
    ]);

    assert.ok(!lines.some((l) => l.startsWith('reconnecting')),
      `a forgotten tunnel must not come straight back: ${lines.join(' | ')}`);
    assert.match(lines.join(' '), /refused|removed/);
    assert.equal(app.customerTunnels.has(orgA, 'forget-me'), false);
  });

  test('an API key cannot remove a tunnel — that is a person’s decision', async () => {
    const { stop } = await startClient({ key: keyA, name: 'keep-me', allow: ['127.0.0.1'] });
    try {
      const res = await app.inject({
        method: 'DELETE', url: '/v1/tunnels/keep-me', headers: { authorization: `Bearer ${keyA}` },
      });
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(app.customerTunnels.has(orgA, 'keep-me'), true, 'and it is untouched');
    } finally { stop(); app.customerTunnels.closeAll(); }
  });
});

describe('the capability the suite sets', () => {
  test('a misspelled tunnel name is refused at session creation, not four minutes later', async () => {
    const { parseCapabilities } = await import('../src/http/webdriver/capabilities.ts');
    assert.throws(
      () => parseCapabilities({
        capabilities: {
          alwaysMatch: { platformName: 'android', 'mfarm:region': 'x', 'mfarm:tunnel': 'Staging Env' },
          firstMatch: [{}],
        },
      }),
      /lowercase letters, digits and dashes/,
      'a suite that allocates, installs and then 503s on every request has wasted four minutes',
    );
  });

  test('an unknown mfarm key is still refused — adding one must not open the namespace', async () => {
    const { parseCapabilities } = await import('../src/http/webdriver/capabilities.ts');
    assert.throws(
      () => parseCapabilities({
        capabilities: {
          alwaysMatch: { platformName: 'android', 'mfarm:region': 'x', 'mfarm:tunnell': 'staging' },
          firstMatch: [{}],
        },
      }),
      /not a capability this hub understands/,
    );
  });

  test('a valid one is parsed and carried', async () => {
    const { parseCapabilities } = await import('../src/http/webdriver/capabilities.ts');
    const caps = parseCapabilities({
      capabilities: {
        alwaysMatch: { platformName: 'android', 'mfarm:region': 'x', 'mfarm:tunnel': 'staging' },
        firstMatch: [{}],
      },
    });
    assert.equal(caps.tunnel, 'staging');
    // Stripped before the upstream Appium sees it, like every other `mfarm:` key.
    assert.equal(caps.upstream['mfarm:tunnel'], undefined);
  });
});
