/**
 * The hub's end of an automation channel — ADR-0011, control-plane half.
 *
 * REAL SOCKETS, for the reason `tunnel.test.ts` states and this file inherits: `app.inject()`
 * cannot upgrade a connection, so a transport tested through it is a transport whose lifetime bugs
 * are all still in front of you. The agent is hand-rolled here — it answers frames the way
 * `workers/agent/src/automation-tunnel.ts` does — and the two halves are held together by the frame
 * types in `packages/protocol`, which neither side may reinterpret.
 *
 * What is NOT proven here, and cannot be: that a real Appium agrees. That is
 * `deploy/verify-webdriver.mjs` against hardware.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import {
  TUNNEL_PATH, automationPath, isAutomationFrame, isTunnelFrame,
  type AutomationFrame, type TunnelFrame,
} from '@mfarm/protocol';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { generateWorkerToken } from '../src/auth.ts';
import { callOverTunnel } from '../src/http/automation-tunnel.ts';

const REGION = 'automation-tunnel-test';
const LOCAL_ID = 'phone-RZCX61ANKGE';
const PATH = `${automationPath(LOCAL_ID)}/session`;

let app: FastifyInstance;
let hostId: string;
let workerToken: string;
let base: string;

before(async () => {
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Automation Tunnel Test')
                   ON CONFLICT (code) DO NOTHING`, [REGION]);
    const wt = generateWorkerToken();
    workerToken = wt.plaintext;
    hostId = (await c.query(
      `INSERT INTO hosts (region,hostname,state,protocol_version,cores,memory_mb,endpoint,
                          token_prefix,token_hash,last_heartbeat_at)
       VALUES ($1,'automation-tunnel-host','UP',2,8,16384,'wss://at-worker.example:8443',$2,$3, now())
       RETURNING id`,
      [REGION, wt.prefix, wt.hash])).rows[0].id;
  });
  app = await buildServer({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  await app.close();
  await withSystem(async (c) => {
    await c.query('DELETE FROM hosts WHERE id = $1', [hostId]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await closePools();
});

/** Dial the tunnel as the agent would, and wait until the control plane has it registered. */
async function connectAgent(): Promise<WebSocket> {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + TUNNEL_PATH, {
    headers: { authorization: `Bearer ${workerToken}` },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  // The socket is open before `attach` has necessarily run on the server's turn of the loop.
  for (let i = 0; i < 100 && !app.tunnels.has(hostId); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(app.tunnels.has(hostId), 'the control plane never registered the tunnel');
  return ws;
}

/**
 * Answer one automation channel the way the agent does.
 *
 * `onRequest` gets the request as it arrived, so a test can assert on what the hub actually framed,
 * and returns what to answer with.
 */
function serveOnce(
  ws: WebSocket,
  onRequest: (req: { method: string; path: string; headers: Record<string, string>; body: string })
    => { status: number; headers: Record<string, string>; body: string } | { error: string },
): void {
  let ch: number | undefined;
  let head: Extract<AutomationFrame, { k: 'req' }> | undefined;
  const chunks: Buffer[] = [];

  ws.on('message', (raw: Buffer) => {
    const frame: unknown = JSON.parse(raw.toString());
    if (!isTunnelFrame(frame)) return;
    if (frame.t === 'open') {
      // Viewers ride the same socket and open `dp` channels on it, so this latches onto the
      // automation one rather than asserting that every open is one. That the hub names the kind
      // at all is asserted where an automation channel is the only thing being opened.
      if (frame.kind === 'automation') ch = frame.ch;
      return;
    }
    if (frame.ch !== ch || frame.t !== 'data') return;
    const inner: unknown = JSON.parse(frame.d);
    if (!isAutomationFrame(inner)) return;

    const send = (f: AutomationFrame) => ws.send(JSON.stringify({ ch: ch!, t: 'data', d: JSON.stringify(f) } as TunnelFrame));
    if (inner.k === 'req') { head = inner; return; }
    if (inner.k === 'd') { chunks.push(Buffer.from(inner.b, 'base64')); return; }
    if (inner.k !== 'end') return;

    const answer = onRequest({
      method: head!.method, path: head!.path, headers: head!.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    if ('error' in answer) { send({ k: 'err', message: answer.error }); }
    else {
      send({ k: 'res', status: answer.status, headers: answer.headers });
      const body = Buffer.from(answer.body);
      // Deliberately chunked small, so reassembly is exercised on every test that uses this.
      for (let i = 0; i < body.length; i += 64 * 1024) {
        send({ k: 'd', b: body.subarray(i, i + 64 * 1024).toString('base64') });
      }
      send({ k: 'end' });
    }
    ws.send(JSON.stringify({ ch: ch!, t: 'close' } as TunnelFrame));
  });
}

describe('automation over the tunnel (hub side)', () => {
  test('a command goes out and its answer comes back', async () => {
    const ws = await connectAgent();
    let got: { method: string; path: string; headers: Record<string, string>; body: string } | undefined;
    let openKind: string | undefined;
    ws.on('message', (raw: Buffer) => {
      const f: unknown = JSON.parse(raw.toString());
      if (isTunnelFrame(f) && f.t === 'open') openKind ??= f.kind;
    });
    serveOnce(ws, (req) => {
      got = req;
      return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"value":{"sessionId":"abc"}}' };
    });

    const reply = await callOverTunnel(
      app.tunnels, hostId, PATH,
      { method: 'POST', headers: { authorization: 'Bearer grant', 'content-type': 'application/json' }, body: '{"capabilities":{}}' },
      5_000,
    );

    assert.equal(reply.status, 200);
    assert.equal(reply.headers['content-type'], 'application/json');
    assert.equal(reply.text, '{"value":{"sessionId":"abc"}}');
    assert.equal(got?.method, 'POST');
    assert.equal(got?.path, PATH);
    assert.equal(got?.body, '{"capabilities":{}}');
    // The grant travels to the agent — it is the agent's gateway that checks it, and stripping it
    // here would leave the boundary with nothing to verify.
    assert.equal(got?.headers.authorization, 'Bearer grant');
    // The kind is what makes the agent route this to its gateway instead of to the data plane.
    assert.equal(openKind, 'automation');
    ws.close();
  });

  test('a request body larger than one chunk arrives whole', async () => {
    const ws = await connectAgent();
    let got = '';
    serveOnce(ws, (req) => {
      got = req.body;
      return { status: 200, headers: {}, body: '{}' };
    });

    const payload = JSON.stringify({ apk: 'x'.repeat(1_400_000) });
    await callOverTunnel(app.tunnels, hostId, PATH, { method: 'POST', headers: {}, body: payload }, 10_000);
    assert.equal(got.length, payload.length);
    assert.equal(got, payload);
    ws.close();
  });

  test('a response larger than one chunk arrives whole', async () => {
    const ws = await connectAgent();
    const big = JSON.stringify({ value: 'A'.repeat(1_500_000) });
    serveOnce(ws, () => ({ status: 200, headers: {}, body: big }));

    const reply = await callOverTunnel(app.tunnels, hostId, PATH, { method: 'GET', headers: {} }, 10_000);
    assert.equal(reply.text.length, big.length);
    assert.equal(reply.text, big);
    ws.close();
  });

  test('an agent-side failure becomes a rejection carrying its message', async () => {
    const ws = await connectAgent();
    serveOnce(ws, () => ({ error: 'automation gateway unreachable: ECONNREFUSED' }));

    await assert.rejects(
      () => callOverTunnel(app.tunnels, hostId, PATH, { method: 'GET', headers: {} }, 5_000),
      /ECONNREFUSED/,
    );
    ws.close();
  });

  test('a host with no tunnel rejects rather than hanging', async () => {
    // No agent connected for this id at all.
    await assert.rejects(
      () => callOverTunnel(app.tunnels, '99999999-9999-4999-8999-999999999999', PATH, { method: 'GET', headers: {} }, 5_000),
      /no agent tunnel is connected/,
    );
  });

  test('a tunnel that drops mid-command fails the command instead of stranding it', async () => {
    const ws = await connectAgent();
    // Accepts the channel and answers nothing, then goes away — the laptop-closed-its-lid case.
    ws.on('message', (raw: Buffer) => {
      const frame: unknown = JSON.parse(raw.toString());
      if (isTunnelFrame(frame) && frame.t === 'open') setTimeout(() => ws.close(), 10);
    });

    await assert.rejects(
      // A deadline far longer than the drop, so a pass here cannot be the timeout in disguise.
      () => callOverTunnel(app.tunnels, hostId, PATH, { method: 'GET', headers: {} }, 30_000),
      /automation channel .* closed/,
    );
  });

  test('viewers cannot exhaust the budget WebDriver commands are drawn from', async () => {
    const ws = await connectAgent();
    serveOnce(ws, () => ({ status: 200, headers: {}, body: '{"value":null}' }));

    // 32 unauthenticated viewers — the whole `/dp/*` cap — arriving before any automation does.
    const viewers = await Promise.all(Array.from({ length: 32 }, async () => {
      const v = new WebSocket(`${base.replace(/^http/, 'ws')}/dp/${hostId}`);
      await new Promise<void>((resolve, reject) => { v.once('open', () => resolve()); v.once('error', reject); });
      return v;
    }));

    // The paid path still works. Sharing one budget would have made this the 33rd channel.
    const reply = await callOverTunnel(app.tunnels, hostId, PATH, { method: 'GET', headers: {} }, 5_000);
    assert.equal(reply.status, 200);

    for (const v of viewers) v.close();
    ws.close();
  });

  test('a silent agent trips the deadline, and it is named a TimeoutError', async () => {
    const ws = await connectAgent();
    // Opens nothing, answers nothing. The hub's own clock is the only thing that can end this.
    const started = Date.now();
    await assert.rejects(
      () => callOverTunnel(app.tunnels, hostId, PATH, { method: 'GET', headers: {} }, 300),
      // The proxy route reads `e.name` to tell a timeout from a dead host, so the NAME is the
      // contract here, not the message.
      (e: Error) => e.name === 'TimeoutError',
    );
    assert.ok(Date.now() - started < 5_000);
    ws.close();
  });
});
