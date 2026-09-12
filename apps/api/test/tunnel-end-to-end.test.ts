/**
 * A device reaches a private staging host — the WHOLE path, over real sockets (migration 052).
 *
 * WHAT THIS COVERS AND WHY IT IS ONE FILE. The feature is four hops and each one is somebody else's
 * code:
 *
 *     a device's HTTP client   ->  the agent's DeviceProxy          (workers/agent)
 *       ->  the agent tunnel, kind `proxy`                          (workers/agent + apps/api)
 *       ->  the router: device -> session -> org -> tunnel name     (apps/api)
 *       ->  the customer's client                                   (apps/cli)
 *       ->  a private http server the farm knows nothing about
 *
 * Testing them separately proves each hop and nothing about the joins, and the joins are where this
 * kind of feature actually fails. So every hop here is the real one: a real `http.request` playing
 * the device, the real `DeviceProxy`, a real WebSocket to a real listening control plane, the real
 * `runTunnel` from the CLI, and a real server on a random port playing staging.
 *
 * THE ONE THING THAT IS NOT REAL is the device's proxy SETTING — `adb shell settings put global
 * http_proxy` on an actual Android guest. That needs hardware and is recorded as such; everything
 * it would exercise downstream is exercised here by pointing an HTTP client at the same port.
 */
process.env.RATE_LIMIT_MAX = '10000';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { TUNNEL_PATH, isTunnelFrame, TUNNEL_CH_AGENT_BASE, TUNNEL_CH_STEP,
  isProxyFrame, type ProxyFrame, type TunnelFrame } from '@mfarm/protocol';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { createApiKey, generateWorkerToken } from '../src/auth.ts';
import { routeFor } from '../src/http/proxy-router.ts';
import { DeviceProxy } from '../../../workers/agent/src/device-proxy.ts';
import { runTunnel, parseAllowRule } from '../../cli/src/tunnel.ts';

const REGION = 'e2e-tunnel-test';
const LOCAL_ID = 'cf-e2e-1';

let app: FastifyInstance;
let base: string;
let orgA: string, orgB: string, hostId: string, deviceId: string;
let keyA: string, workerToken: string;
let staging: Server, stagingUrl: string;
let stagingHits: string[] = [];

/* ------------------------------------------------------------------ the customer's private host */

function startStaging(): Promise<string> {
  staging = createServer((req, res) => {
    stagingHits.push(`${req.method} ${req.url}`);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url, method: req.method, body }));
    });
  });
  return new Promise((resolve) => {
    staging.listen(0, '127.0.0.1', () => {
      const a = staging.address();
      resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`);
    });
  });
}

/* --------------------------------------------------------------------------- a real agent tunnel
 *
 * Hand-rolled the way `automation-tunnel.test.ts` does, and for the same reason: what is under test
 * is the CONTROL PLANE's half of the contract, so the far side has to be something that follows the
 * protocol rather than something that shares its code. It allocates ODD channel ids, which is the
 * parity rule this feature introduced — a bug there is a collision with a browser's channel.
 */
class FakeAgent {
  private ws!: WebSocket;
  private nextCh = TUNNEL_CH_AGENT_BASE;
  readonly sinks = new Map<number, { onFrame(f: ProxyFrame): void; onClose(r: string): void }>();

  async connect(): Promise<void> {
    this.ws = new WebSocket(`${base.replace('http', 'ws')}${TUNNEL_PATH}`, {
      headers: { authorization: `Bearer ${workerToken}` },
    });
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    this.ws.on('message', (raw) => {
      let f: unknown;
      try { f = JSON.parse(raw.toString()); } catch { return; }
      if (!isTunnelFrame(f)) return;
      const frame = f as TunnelFrame;
      const sink = this.sinks.get(frame.ch);
      if (!sink) return;
      if (frame.t === 'data') {
        let inner: unknown;
        try { inner = JSON.parse(frame.d); } catch { return; }
        if (isProxyFrame(inner)) sink.onFrame(inner);
        return;
      }
      if (frame.t === 'close') { this.sinks.delete(frame.ch); sink.onClose(frame.reason ?? 'closed'); }
    });
  }

  /** Exactly `ProxyTransport`, so `DeviceProxy` cannot tell this from the real agent. */
  open(localId: string, sink: { onFrame(f: ProxyFrame): void; onClose(r: string): void }) {
    if (this.ws.readyState !== WebSocket.OPEN) return undefined;
    const ch = this.nextCh;
    this.nextCh += TUNNEL_CH_STEP;
    this.sinks.set(ch, sink);
    this.send({ ch, t: 'open', kind: 'proxy', ref: localId });
    return {
      send: (f: ProxyFrame) => this.send({ ch, t: 'data', d: JSON.stringify(f) }),
      close: () => { if (this.sinks.delete(ch)) this.send({ ch, t: 'close' }); },
    };
  }

  private send(f: TunnelFrame): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(f));
  }

  close(): void { try { this.ws.close(); } catch { /* gone */ } }
}

/* ------------------------------------------------------------------------------- a device's GET */

/** An ordinary HTTP client using the proxy the way an Android device does: absolute-form request. */
function throughProxy(port: number, url: string, opts: { method?: string; body?: string } = {}): Promise<{
  status: number; body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: url, headers: { host: new URL(url).host } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/* ----------------------------------------------------------------------------------- fixtures */

let sessionId: string | null = null;

async function giveDeviceASession(orgId: string, caps: Record<string, unknown>): Promise<string> {
  return withSystem(async (c) => {
    if (sessionId) await c.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    const { rows } = await c.query(
      `INSERT INTO sessions (org_id, device_id, state, region, started_at, requested)
       VALUES ($1,$2,'ACTIVE',$3, now(), $4::jsonb) RETURNING id`,
      [orgId, deviceId, REGION, JSON.stringify(caps)],
    );
    sessionId = rows[0].id;
    return rows[0].id as string;
  });
}

const clearSession = () => withSystem(async (c) => {
  if (sessionId) await c.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  sessionId = null;
});

async function startCustomer(name: string, allow: string[], key = keyA): Promise<() => void> {
  let ready: () => void;
  const isReady = new Promise<void>((r) => { ready = r; });
  const lines: string[] = [];
  void runTunnel({
    baseUrl: base, apiKey: key, name, allow: allow.map(parseAllowRule),
    out: (l) => lines.push(l), onReady: () => ready(), maxRetries: 0,
  }).catch(() => { /* refusal is a tested outcome elsewhere */ });
  await Promise.race([
    isReady,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`no tunnel: ${lines.join(' | ')}`)), 5000)),
  ]);
  return () => app.customerTunnels.closeAll();
}

let agent: FakeAgent;
let proxyPort: number;
let deviceProxy: DeviceProxy;

before(async () => {
  stagingUrl = await startStaging();
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'E2E Tunnel') ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgA = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,'E2E A',50) RETURNING id`,
      [`e2e-a-${randomUUID().slice(0, 8)}`])).rows[0].id;
    orgB = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,'E2E B',50) RETURNING id`,
      [`e2e-b-${randomUUID().slice(0, 8)}`])).rows[0].id;
    const wt = generateWorkerToken();
    workerToken = wt.plaintext;
    hostId = (await c.query(
      `INSERT INTO hosts (region,hostname,state,token_prefix,token_hash,last_heartbeat_at)
       VALUES ($1,$2,'UP',$3,$4, now()) RETURNING id`,
      [REGION, `e2e-host-${randomUUID().slice(0, 8)}`, wt.prefix, wt.hash])).rows[0].id;
    deviceId = (await c.query(
      `INSERT INTO devices (host_id,region,platform,tier,model,os_version,state,capabilities,local_id)
       VALUES ($1,$2,'android','cuttlefish','MFARM X1 Pro','17','READY','[]'::jsonb,$3) RETURNING id`,
      [hostId, REGION, LOCAL_ID])).rows[0].id;
  });
  keyA = (await createApiKey(orgA, 'e2e tunnel')).plaintext;

  app = await buildServer({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  agent = new FakeAgent();
  await agent.connect();
  deviceProxy = new DeviceProxy({ localId: LOCAL_ID, transport: agent });
  ({ port: proxyPort } = await deviceProxy.start());
});

after(async () => {
  await deviceProxy?.stop();
  agent?.close();
  app.customerTunnels.closeAll();
  await app?.close();
  await new Promise((r) => staging.close(r));
  await closePools();
});

// ---------------------------------------------------------------------------------------------

describe('the whole path', () => {
  test('a device reaches the customer’s private host and gets its answer back', async () => {
    stagingHits = [];
    await giveDeviceASession(orgA, { 'mfarm:tunnel': 'staging' });
    const stop = await startCustomer('staging', ['127.0.0.1']);
    try {
      const res = await throughProxy(proxyPort, `${stagingUrl}/orders/42`);
      assert.equal(res.status, 200, res.body);
      assert.ok(res.body.length > 0, 'a 200 with an empty body means the response head arrived and its bytes did not');
      const body = JSON.parse(res.body);
      assert.equal(body.path, '/orders/42');
      assert.deepEqual(stagingHits, ['GET /orders/42'],
        'the private host must have been reached exactly once, and only through the client');
    } finally { stop(); await clearSession(); }
  });

  test('a POST body survives all four hops', async () => {
    stagingHits = [];
    await giveDeviceASession(orgA, { 'mfarm:tunnel': 'staging' });
    const stop = await startCustomer('staging', ['127.0.0.1']);
    try {
      const res = await throughProxy(proxyPort, `${stagingUrl}/login`,
        { method: 'POST', body: '{"user":"ada"}' });
      assert.equal(res.status, 200, res.body);
      // A proxy that only carried GETs would fail on the second screen of every app.
      assert.equal(JSON.parse(res.body).body, '{"user":"ada"}');
      assert.equal(JSON.parse(res.body).method, 'POST');
    } finally { stop(); await clearSession(); }
  });
});

// ---------------------------------------------------------------------------------------------

describe('what the device is refused, and how it is told', () => {
  /**
   * THE SECURITY PROPERTY OF THE WHOLE FEATURE. A device between tenants — freshly reset, or
   * waiting in the pool — must reach nothing at all. Otherwise whatever the last tenant left
   * running on it could phone home into the NEXT tenant's private network.
   */
  test('a device with no live session reaches nothing, and is told why', async () => {
    stagingHits = [];
    await clearSession();
    const stop = await startCustomer('staging', ['*']);
    try {
      const res = await throughProxy(proxyPort, `${stagingUrl}/anything`);
      assert.equal(res.status, 503);
      assert.match(res.body, /not holding a session/);
      assert.deepEqual(stagingHits, [], 'not one byte may leave a device between tenants');
    } finally { stop(); }
  });

  test('a session that did not ask for a tunnel does not silently get one', async () => {
    stagingHits = [];
    await giveDeviceASession(orgA, {});
    const stop = await startCustomer('staging', ['*']);
    try {
      const res = await throughProxy(proxyPort, `${stagingUrl}/anything`);
      assert.equal(res.status, 503);
      assert.match(res.body, /did not ask for a tunnel/);
      assert.deepEqual(stagingHits, []);
    } finally { stop(); await clearSession(); }
  });

  /**
   * CROSS-TENANT, THROUGH THE WHOLE STACK. The unit test in `customer-tunnel.test.ts` proves the
   * registry keys by org; this proves the ROUTER derives that org from the session row rather than
   * from anything the agent said — the agent names a device and the device is the same one.
   */
  test('a device held by org B cannot reach org A’s tunnel, even by naming it', async () => {
    stagingHits = [];
    await giveDeviceASession(orgB, { 'mfarm:tunnel': 'staging' });
    const stop = await startCustomer('staging', ['*'], keyA); // org A's tunnel
    try {
      const res = await throughProxy(proxyPort, `${stagingUrl}/secrets`);
      assert.equal(res.status, 503, res.body);
      assert.match(res.body, /no tunnel called "staging" is connected/);
      assert.deepEqual(stagingHits, [], 'not one byte may cross a tenant boundary');
    } finally { stop(); await clearSession(); }
  });

  test('a tunnel nobody started names itself and says how to start it', async () => {
    await giveDeviceASession(orgA, { 'mfarm:tunnel': 'nowhere' });
    try {
      const res = await throughProxy(proxyPort, `${stagingUrl}/x`);
      assert.equal(res.status, 503);
      assert.match(res.body, /no tunnel called "nowhere"/);
      assert.match(res.body, /npx @mfarm\/cli tunnel --name nowhere/,
        'the sentence has to end on the machine that can fix it, which is theirs');
    } finally { await clearSession(); }
  });

  test('a host outside the customer’s own allow rules is a 403, not a farm error', async () => {
    stagingHits = [];
    await giveDeviceASession(orgA, { 'mfarm:tunnel': 'staging' });
    const stop = await startCustomer('staging', ['staging.acme.internal']);
    try {
      const res = await throughProxy(proxyPort, `${stagingUrl}/nope`);
      assert.equal(res.status, 403, res.body);
      assert.match(res.body, /--allow/);
      assert.deepEqual(stagingHits, []);
    } finally { stop(); await clearSession(); }
  });

  test('an https target is refused with a sentence rather than a broken tunnel', async () => {
    await giveDeviceASession(orgA, { 'mfarm:tunnel': 'staging' });
    const stop = await startCustomer('staging', ['*']);
    try {
      const res = await throughProxy(proxyPort, 'http://127.0.0.1:1/');
      // Reaches the client, which cannot connect — the honest failure, distinguished from a refusal.
      assert.equal(res.status, 502, res.body);
    } finally { stop(); await clearSession(); }
  });

  test('a plain request to the proxy port is not mistaken for a proxied one', async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: proxyPort, path: '/health' }, (r) => {
        let body = '';
        r.on('data', (c) => { body += c; });
        r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 400);
    assert.match(res.body, /not a web server/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('the routing chain, directly', () => {
  test('it resolves a device to its session’s org and named tunnel', async () => {
    const id = await giveDeviceASession(orgA, { 'mfarm:tunnel': 'staging' });
    try {
      const r = await routeFor(hostId, LOCAL_ID);
      assert.ok(!('refusal' in r), JSON.stringify(r));
      assert.equal(r.orgId, orgA);
      assert.equal(r.tunnel, 'staging');
      assert.equal(r.sessionId, id);
    } finally { await clearSession(); }
  });

  test('a device this host does not own resolves to nothing', async () => {
    await giveDeviceASession(orgA, { 'mfarm:tunnel': 'staging' });
    try {
      const r = await routeFor(hostId, 'a-device-on-someone-elses-host');
      assert.ok('refusal' in r);
    } finally { await clearSession(); }
  });

  test('an empty device name resolves to nothing rather than to the first row', async () => {
    await giveDeviceASession(orgA, { 'mfarm:tunnel': 'staging' });
    try {
      assert.ok('refusal' in (await routeFor(hostId, '')));
      assert.ok('refusal' in (await routeFor('', LOCAL_ID)));
    } finally { await clearSession(); }
  });
});
