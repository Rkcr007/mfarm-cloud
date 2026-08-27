import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  TOKEN_ALG, TUNNEL_PATH, automationPath, isAutomationFrame, isTunnelFrame,
  type AutomationFrame, type SessionClaims, type TunnelFrame,
} from '@mfarm/protocol';
import { AutomationGateway, type GrantAuthority } from '../src/gateway.ts';
import { AgentTunnel } from '../src/tunnel.ts';
import type { Agent } from '../src/agent.ts';
import type { DataPlane } from '../src/dataplane.ts';

/**
 * Automation over the tunnel — ADR-0011, worker half, end to end over real sockets.
 *
 * EVERY HOP HERE IS REAL except the control plane, which is hand-rolled because the framing is a
 * dozen lines and importing the API workspace into this one would be a bigger lie than writing it
 * out. A real WebSocket, the real `AgentTunnel`, the real `AutomationGateway`, and an HTTP server
 * standing in for Appium — because the bugs this transport can have are socket-lifetime bugs, and
 * this repo has already shipped a green test suite over a feature that worked 0% of the time by
 * testing everything except the socket.
 *
 * THE LOAD-BEARING CLAIM is that the tunnel adds a transport and no second opinion about who may
 * drive a device: a tunnelled request is replayed against the host's OWN gateway, so ADR-0004's
 * checks still run, still in one place. `refuses a request with no grant` and `the grant never
 * reaches Appium` are that claim; if either stops holding, the tunnel has become a way around the
 * boundary rather than a way to it.
 */

const kp = generateKeyPairSync('ed25519');
const PRIVATE_PEM = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_PEM = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_1 = '22222222-2222-4222-8222-222222222222';
const LOCAL_ID = 'phone-RZCX61ANKGE';

function mint(claims: Partial<SessionClaims> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const full: SessionClaims = {
    sid: 'session-1', did: DEVICE_1, org: 'org-1', fence: 1, aud: HOST_ID,
    iat: now, exp: now + 120,
    ...claims,
  };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  const payload = `${TOKEN_ALG}.${body}`;
  return `${payload}.${sign(null, Buffer.from(payload), createPrivateKey(PRIVATE_PEM)).toString('base64url')}`;
}

interface Seen {
  method: string;
  url: string;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
}

/** What one tunnelled exchange produced, as the control plane would have assembled it. */
interface Exchange {
  status?: number;
  headers?: Record<string, string>;
  body: string;
  error?: string;
  /** Whether the agent closed the channel, and why it said it did. */
  closed?: string;
}

describe('automation over the tunnel', () => {
  let appium: Server;
  let appiumPort: number;
  let seen: Seen | undefined;
  let reply: { status: number; body: string } = { status: 200, body: '{"value":{"ok":true}}' };

  let gateway: AutomationGateway;
  let gatewayPort: number;

  let wss: WebSocketServer;
  let cpServer: Server;
  let cpUrl: string;
  /** The agent's socket, as the control plane holds it. */
  let agentSocket: WebSocket | undefined;
  let tunnel: AgentTunnel | undefined;
  let nextCh = 1;

  before(async () => {
    appium = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen = {
          method: req.method ?? '', url: req.url ?? '', headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        };
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body);
      });
    });
    await new Promise<void>((r) => appium.listen(0, '127.0.0.1', () => r()));
    appiumPort = (appium.address() as { port: number }).port;

    const authority: GrantAuthority = {
      hostId: HOST_ID,
      sessionPublicKey: PUBLIC_PEM,
      deviceIdFor: (localId) => (localId === LOCAL_ID ? DEVICE_1 : undefined),
      acceptFence: () => true,
    };
    gateway = new AutomationGateway({
      agent: authority,
      targets: new Map([[LOCAL_ID, appiumPort]]),
    });
    // Loopback, which is the ADR-0011 deployment: the only client is the agent's own tunnel.
    gatewayPort = await gateway.listen(0, '127.0.0.1');

    cpServer = createServer((_req, res) => { res.writeHead(426); res.end(); });
    wss = new WebSocketServer({ noServer: true });
    cpServer.on('upgrade', (req, socket, head) => {
      if ((req.url ?? '').split('?')[0] !== TUNNEL_PATH) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => { agentSocket = ws; wss.emit('connection', ws); });
    });
    await new Promise<void>((r) => cpServer.listen(0, '127.0.0.1', () => r()));
    cpUrl = `http://127.0.0.1:${(cpServer.address() as { port: number }).port}`;
  });

  after(async () => {
    tunnel?.stop();
    await gateway.close();
    await new Promise<void>((r) => { wss.close(() => r()); });
    await new Promise<void>((r) => { cpServer.close(() => r()); });
    await new Promise<void>((r) => { appium.close(() => r()); });
  });

  beforeEach(() => {
    seen = undefined;
    reply = { status: 200, body: '{"value":{"ok":true}}' };
  });

  /** Bring up a real AgentTunnel and wait for the control plane to see it arrive. */
  async function connect(automationTarget: { host: string; port: number } | undefined): Promise<void> {
    tunnel?.stop();
    agentSocket = undefined;
    const arrived = new Promise<void>((resolve) => wss.once('connection', () => resolve()));
    tunnel = new AgentTunnel({
      controlPlaneUrl: cpUrl,
      // Only `workerToken` is read on this path; the rest of Agent is not part of the transport.
      agent: { workerToken: 'mwk_test' } as unknown as Agent,
      // A data-plane channel is never opened in this file, so an accept() that throws is the
      // strongest available assertion that automation frames never reach the data plane.
      dataPlane: { accept: () => { throw new Error('an automation channel reached the data plane'); } } as unknown as DataPlane,
      automationTarget,
      minBackoffMs: 5,
    });
    tunnel.start();
    await arrived;
  }

  /**
   * Play the control plane for one command: open an automation channel, frame the request, and
   * assemble whatever comes back.
   */
  function exchange(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<Exchange> {
    const ch = nextCh++;
    const ws = agentSocket!;
    return new Promise<Exchange>((resolve, reject) => {
      const out: Exchange = { body: '' };
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => { cleanup(); reject(new Error('the agent never answered')); }, 5_000);
      const cleanup = () => { clearTimeout(timer); ws.off('message', onMessage); };
      const done = () => { out.body = Buffer.concat(chunks).toString('utf8'); cleanup(); resolve(out); };

      const onMessage = (raw: Buffer) => {
        let frame: unknown;
        try { frame = JSON.parse(raw.toString()); } catch { return; }
        if (!isTunnelFrame(frame) || frame.ch !== ch) return;
        if (frame.t === 'close') { out.closed = frame.reason ?? ''; return done(); }
        if (frame.t !== 'data') return;
        const inner: unknown = JSON.parse(frame.d);
        if (!isAutomationFrame(inner)) return reject(new Error(`not an automation frame: ${frame.d}`));
        if (inner.k === 'res') { out.status = inner.status; out.headers = inner.headers; return; }
        if (inner.k === 'd') { chunks.push(Buffer.from(inner.b, 'base64')); return; }
        if (inner.k === 'err') { out.error = inner.message; return; }
        // `end` is not the last thing on the wire — the close that follows it is — so the exchange
        // is resolved there, which is also what proves the channel is actually torn down.
      };
      ws.on('message', onMessage);

      const send = (f: TunnelFrame) => ws.send(JSON.stringify(f));
      send({ ch, t: 'open', kind: 'automation' });
      const frame = (f: AutomationFrame) => send({ ch, t: 'data', d: JSON.stringify(f) });
      frame({ k: 'req', method, path, headers });
      if (body !== undefined) frame({ k: 'd', b: Buffer.from(body).toString('base64') });
      frame({ k: 'end' });
    });
  }

  const grantHeaders = (token = mint()) => ({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  });

  test('a WebDriver command reaches Appium and its answer comes back', async () => {
    await connect({ host: '127.0.0.1', port: gatewayPort });
    reply = { status: 200, body: '{"value":{"sessionId":"abc"}}' };

    const res = await exchange(
      'POST',
      `${automationPath(LOCAL_ID)}/session`,
      grantHeaders(),
      '{"capabilities":{}}',
    );

    assert.equal(res.status, 200);
    assert.equal(res.body, '{"value":{"sessionId":"abc"}}');
    assert.equal(seen?.method, 'POST');
    // Path-transparent through both hops: what the hub addressed is what Appium sees.
    assert.equal(seen?.url, '/session');
    assert.equal(seen?.body, '{"capabilities":{}}');
    assert.equal(res.closed, '');
  });

  test('a query string survives both hops', async () => {
    await connect({ host: '127.0.0.1', port: gatewayPort });
    const res = await exchange('GET', `${automationPath(LOCAL_ID)}/status?verbose=1`, grantHeaders());
    assert.equal(res.status, 200);
    assert.equal(seen?.url, '/status?verbose=1');
  });

  test('refuses a request with no grant, and Appium is never reached', async () => {
    await connect({ host: '127.0.0.1', port: gatewayPort });
    const res = await exchange('GET', `${automationPath(LOCAL_ID)}/status`, { 'content-type': 'application/json' });

    // 401 from the GATEWAY, relayed verbatim. The tunnel is a transport; it did not decide this.
    assert.equal(res.status, 401);
    assert.match(res.body, /automation grant is required/i);
    assert.equal(seen, undefined);
  });

  test('a grant for another device on this host is refused', async () => {
    await connect({ host: '127.0.0.1', port: gatewayPort });
    const res = await exchange(
      'GET',
      `${automationPath(LOCAL_ID)}/status`,
      grantHeaders(mint({ did: '44444444-4444-4444-8444-444444444444' })),
    );
    assert.equal(res.status, 403);
    assert.equal(seen, undefined);
  });

  test('the grant never reaches Appium', async () => {
    await connect({ host: '127.0.0.1', port: gatewayPort });
    await exchange('GET', `${automationPath(LOCAL_ID)}/status`, grantHeaders());
    // Stripped by the gateway, which is only true because the replay goes THROUGH it.
    assert.equal(seen?.headers.authorization, undefined);
  });

  test('a body larger than one chunk arrives whole', async () => {
    await connect({ host: '127.0.0.1', port: gatewayPort });
    // Two chunks and a bit, so the reassembly is exercised rather than the boundary case.
    const payload = JSON.stringify({ data: 'x'.repeat(1_200_000) });
    const res = await exchange('POST', `${automationPath(LOCAL_ID)}/session/s/appium/device/push_file`, grantHeaders(), payload);
    assert.equal(res.status, 200);
    assert.equal(seen?.body.length, payload.length);
    assert.equal(seen?.body, payload);
  });

  test('a response larger than one chunk arrives whole', async () => {
    await connect({ host: '127.0.0.1', port: gatewayPort });
    // A screenshot: one large base64 string, delivered by the socket as one buffer.
    reply = { status: 200, body: JSON.stringify({ value: 'A'.repeat(1_500_000) }) };
    const res = await exchange('GET', `${automationPath(LOCAL_ID)}/session/s/screenshot`, grantHeaders());
    assert.equal(res.status, 200);
    assert.equal(res.body.length, reply.body.length);
    assert.equal(res.body, reply.body);
  });

  test('an upstream error status is relayed verbatim, not rewritten', async () => {
    await connect({ host: '127.0.0.1', port: gatewayPort });
    reply = { status: 404, body: '{"value":{"error":"no such element"}}' };
    const res = await exchange('GET', `${automationPath(LOCAL_ID)}/session/s/element/x`, grantHeaders());
    assert.equal(res.status, 404);
    assert.match(res.body, /no such element/);
  });

  test('a host that serves no automation refuses the channel with a reason', async () => {
    await connect(undefined);
    const res = await exchange('GET', `${automationPath(LOCAL_ID)}/status`, grantHeaders());
    assert.equal(res.closed, 'this host serves no automation');
    assert.equal(res.status, undefined);
    assert.equal(seen, undefined);
  });

  test('a second request on one channel is refused rather than served', async () => {
    await connect({ host: '127.0.0.1', port: gatewayPort });
    const ch = nextCh++;
    const ws = agentSocket!;
    const frames: AutomationFrame[] = [];
    const settled = new Promise<void>((resolve) => {
      ws.on('message', (raw: Buffer) => {
        const f: unknown = JSON.parse(raw.toString());
        if (!isTunnelFrame(f) || f.ch !== ch) return;
        if (f.t === 'close') return resolve();
        if (f.t === 'data') {
          const inner: unknown = JSON.parse(f.d);
          if (isAutomationFrame(inner)) frames.push(inner);
        }
      });
    });
    const send = (f: TunnelFrame) => ws.send(JSON.stringify(f));
    send({ ch, t: 'open', kind: 'automation' });
    const head: AutomationFrame = {
      k: 'req', method: 'GET', path: `${automationPath(LOCAL_ID)}/status`, headers: grantHeaders(),
    };
    send({ ch, t: 'data', d: JSON.stringify(head) });
    send({ ch, t: 'data', d: JSON.stringify(head) });
    await settled;

    assert.ok(frames.some((f) => f.k === 'err' && /second request/.test(f.message)));
  });

  test('a dropped tunnel does not leave the channel waiting for an answer', async () => {
    await connect({ host: '127.0.0.1', port: gatewayPort });
    // Nothing asserts on the agent's internals here: the observable claim is that the agent
    // reconnects and serves the next command, which it cannot do if teardown left state behind.
    const reconnected = new Promise<void>((resolve) => wss.once('connection', () => resolve()));
    agentSocket!.close();
    await reconnected;

    const res = await exchange('GET', `${automationPath(LOCAL_ID)}/status`, grantHeaders());
    assert.equal(res.status, 200);
  });
});
