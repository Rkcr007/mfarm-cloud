/**
 * The live status stream — over a REAL SOCKET, because that is the only place it exists.
 *
 * `app.inject` hands a route a fake request and collects one response body. An event stream is a
 * response that never ends and whose value is entirely in WHEN bytes arrive, so injecting it would
 * assert that a function was called and nothing about the feature. Every test below opens a genuine
 * connection to a genuine listener and reads frames off it as they come.
 *
 * THREE PROPERTIES, and each is the reason a specific thing in `infra/stream.ts` is written the way
 * it is:
 *
 *   AN OPERATION IS FELT IMMEDIATELY. The stream's tick is two seconds; a drain must push before
 *   that, or the push buys nothing over the poll it accelerates.
 *
 *   A QUIET FARM DOES NOT RE-RENDER. A frame on every tick would make the console rebuild the
 *   screen under somebody's cursor twice a second — the exact failure `pollSignature` exists to
 *   prevent on the polling path.
 *
 *   A CLOSED TAB STOPS COSTING. The payload is a database probe, five grouped queries and a
 *   fortnight of interval arithmetic; a stream that keeps computing it for a client that has gone
 *   is a leak that only shows up on a busy day.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.HOST_HOURLY_COST = '65';
/**
 * THE TICK IS WOUND OUT TO HALF A MINUTE, which is what makes the push assertion mean anything.
 *
 * At the production two seconds, a test claiming "the drain arrived faster than the tick" passes
 * whether or not `infraChanged()` is wired up — the tick lands inside the window by luck. At thirty
 * seconds the ONLY way a frame can arrive within three is the signal, so removing it fails the test
 * deterministically. Verified by removing it.
 */
process.env.INFRA_STREAM_TICK_MS = '30000';
/**
 * And the keepalive is wound the other way, to half a second.
 *
 * They are separate timers on purpose — see `keepaliveMs` — and separating them is what this file
 * forced: with one timer, winding the tick out to thirty seconds also silenced the keepalive, which
 * on a real deployment would mean a proxy quietly reaping a healthy connection.
 */
process.env.INFRA_STREAM_KEEPALIVE_MS = '500';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { upsertUser, cookieValue } from '../src/users.ts';
import { streamListeners, infraChanged, sseFrame } from '../src/infra/stream.ts';

let app: FastifyInstance;
let base: string;
let cookie: string, csrf: string;
let memberCookie: string;
let hostId: string;

const REGION = `stream-${randomUUID().slice(0, 8)}`;
const OPERATOR = `op-${randomUUID()}@example.test`;
const MEMBER = `member-${randomUUID()}@example.test`;
const PASSWORD = 'correct horse battery staple';

async function signIn(email: string) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PASSWORD } });
  assert.equal(res.statusCode, 200, res.body);
  const raw = String(res.headers['set-cookie']);
  return {
    cookie: `mfarm_session=${cookieValue(raw.replace(/; /g, '; '), 'mfarm_session')}`,
    csrf: res.json().csrfToken as string,
  };
}

/**
 * Read SSE frames off a live connection until `want` of them have arrived or the deadline passes.
 *
 * Returns the frames AND the abort handle, because half of what is under test here is what happens
 * when the client goes away.
 */
async function openStream(who = cookie) {
  const ac = new AbortController();
  const res = await fetch(`${base}/v1/infra/stream`, {
    headers: { cookie: who }, signal: ac.signal,
  });
  const frames: Array<{ event: string; data: unknown }> = [];
  let keepalives = 0;

  const pump = (async () => {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        // Frames are separated by a blank line — SSE's own framing, and the reason `sseFrame`
        // guarantees its payload is one line.
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (chunk.startsWith(':')) { keepalives++; continue; }
          const event = /^event: (.+)$/m.exec(chunk)?.[1] ?? '';
          const data = /^data: (.*)$/m.exec(chunk)?.[1] ?? 'null';
          frames.push({ event, data: JSON.parse(data) });
        }
      }
    } catch { /* aborted, which is how every one of these ends */ }
  })();

  return {
    status: res.status,
    frames,
    keepalives: () => keepalives,
    close: async () => { ac.abort(); await pump; },
    /** Wait for at least `n` frames, or give up. Returns how many actually arrived. */
    async waitFor(n: number, ms: number) {
      const deadline = Date.now() + ms;
      while (frames.length < n && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return frames.length;
    },
  };
}

before(async () => {
  app = await buildServer({ logger: false, loginRateLimitMax: 10_000 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  let orgId = '';
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Stream Test') ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgId = (await c.query(
      `INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,'Stream',50) RETURNING id`,
      [`stream-${randomUUID()}`])).rows[0].id;
    hostId = (await c.query(
      `INSERT INTO hosts (region, hostname, state, protocol_version, up_since, last_heartbeat_at,
                          cores, memory_mb)
       VALUES ($1,$2,'UP',2, now() - interval '1 hour', now(), 8, 32768) RETURNING id`,
      [REGION, `stream-host-${randomUUID().slice(0, 6)}`])).rows[0].id;
  });
  await upsertUser(OPERATOR, PASSWORD, orgId, 'admin');
  await upsertUser(MEMBER, PASSWORD, orgId, 'member');
  await withSystem((c) =>
    c.query('UPDATE users SET operator = true WHERE lower(email) = lower($1)', [OPERATOR]));
  ({ cookie, csrf } = await signIn(OPERATOR));
  ({ cookie: memberCookie } = await signIn(MEMBER));
});

after(async () => {
  await withSystem(async (c) => {
    await c.query('ALTER TABLE infra_operations DISABLE TRIGGER infra_operations_append_only');
    await c.query(`DELETE FROM infra_operations WHERE target_id IN
                     (SELECT id::text FROM hosts WHERE region = $1)`, [REGION]);
    await c.query('ALTER TABLE infra_operations ENABLE TRIGGER infra_operations_append_only');
    await c.query('DELETE FROM hosts WHERE region = $1', [REGION]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await app.close();
  await closePools();
});

describe('the stream', () => {
  test('it opens as an event stream and sends the state straight away', async () => {
    const s = await openStream();
    try {
      assert.equal(s.status, 200);
      assert.ok(await s.waitFor(1, 3000) >= 1, 'no frame arrived within three seconds');
      assert.equal(s.frames[0].event, 'infra');
      const payload = s.frames[0].data as { health: { overall: string }; hosts: unknown[] };
      assert.ok(payload.health.overall, 'the first frame is not an overview payload');
      assert.ok(Array.isArray(payload.hosts));
    } finally {
      await s.close();
    }
  });

  test('A QUIET FARM SENDS KEEPALIVES, NOT REDRAWS', async () => {
    const s = await openStream();
    try {
      await s.waitFor(1, 3000);
      const after = s.frames.length;
      // Nothing about this farm changes in this window, and with a thirty-second tick nothing is
      // due to be recomputed either — so any frame here is a redundant one.
      await new Promise((r) => setTimeout(r, 3000));
      assert.equal(s.frames.length, after,
        `the stream pushed ${s.frames.length - after} redundant frames — the console would rebuild `
        + 'the screen under somebody\'s cursor twice a second');
      assert.ok(s.keepalives() > 0,
        'nothing was sent at all; a silent connection is indistinguishable from a dead one');
    } finally {
      await s.close();
    }
  });

  test('AN OPERATION IS PUSHED FASTER THAN THE TICK', async () => {
    const s = await openStream();
    try {
      await s.waitFor(1, 3000);
      const before = s.frames.length;
      const started = Date.now();

      const res = await fetch(`${base}/v1/infra/hosts/${hostId}/drain`, {
        method: 'POST',
        headers: { cookie, 'x-mfarm-csrf': csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'stream test' }),
      });
      assert.equal(res.status, 200, await res.text());

      await s.waitFor(before + 1, 3000);
      assert.ok(s.frames.length > before, 'the drain never reached the stream');
      const latency = Date.now() - started;
      // The tick is thirty seconds here (see the top of this file). Anything close to it means the
      // push did nothing and the frame was carried by a tick that happened to land.
      assert.ok(latency < 3000, `the change took ${latency}ms to arrive — the push is not working`);

      const payload = s.frames[s.frames.length - 1].data as {
        hosts: Array<{ id: string; maintenance: { drained: boolean } }>;
      };
      assert.equal(payload.hosts.find((h) => h.id === hostId)?.maintenance.drained, true);
    } finally {
      await s.close();
      await fetch(`${base}/v1/infra/hosts/${hostId}/resume`, {
        method: 'POST', headers: { cookie, 'x-mfarm-csrf': csrf },
      });
    }
  });

  test('a closed client stops being computed for', async () => {
    const before = streamListeners();
    const s = await openStream();
    await s.waitFor(1, 3000);
    await s.close();

    // The listener is dropped when the socket closes, which aborts the wait immediately — it does
    // NOT have to sit out the tick, and with a thirty-second tick here a version that did would
    // fail this rather than passing slowly.
    const deadline = Date.now() + 4000;
    while (streamListeners() > before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(streamListeners(), before,
      'a stream kept recomputing an expensive payload for a client that had gone');
  });

  test('a member cannot open it', async () => {
    const res = await fetch(`${base}/v1/infra/stream`, { headers: { cookie: memberCookie } });
    assert.equal(res.status, 403);
    await res.text();
  });

  test('an anonymous caller cannot open it', async () => {
    const res = await fetch(`${base}/v1/infra/stream`);
    assert.equal(res.status, 401);
    await res.text();
  });
});

describe('the frame format', () => {
  test('a payload is one line, whatever is in it', () => {
    const frame = sseFrame('infra', { note: 'a\nb', deep: { c: 'd\ne' } });
    const body = frame.split('\n').filter((l) => l.startsWith('data: '));
    assert.equal(body.length, 1,
      'a multi-line payload would terminate the frame early and truncate the state');
    assert.ok(frame.endsWith('\n\n'), 'a frame that does not end in a blank line never dispatches');
  });

  test('the event is named, so a future kind cannot arrive as a state update', () => {
    assert.match(sseFrame('operation', {}), /^event: operation$/m);
  });
});

describe('the change signal', () => {
  test('it never throws at its caller, whatever a listener does', () => {
    // A listener that throws must not stop the others being told, and must not surface in the route
    // that performed the operation — the operation already happened.
    assert.doesNotThrow(() => infraChanged());
  });
});
