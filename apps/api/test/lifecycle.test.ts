/**
 * Process lifecycle: the probes, and what shutting down actually does.
 *
 * This is the part that only exists in production, which is why it had no coverage until it had a
 * `main`. The two failure modes worth a test are a readiness check that lies (an instance kept in
 * the load balancer with no database behind it) and a shutdown that leaves the reaper ticking
 * against pools that are being torn down.
 *
 * The service binds a real port and closes real pools, so it runs LAST in this file — `closePools()`
 * is process-wide and nothing can query afterwards through db.ts.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { appPool, assertAppRoleIsRlsBound, systemPool, withSystem } from '../src/db.ts';
import { start } from '../src/main.ts';
import { ConfigError, DEV_SYSTEM_URL, parseConfig } from '../src/config.ts';

let app: FastifyInstance;
let orgId: string;
const REGION = 'lifecycle-test';

/**
 * Options every server in this file shares.
 *
 * `rateLimitMax` is passed as an argument rather than through `process.env.RATE_LIMIT_MAX`. The
 * environment assignment that used to sit at the top of this file ran AFTER the hoisted ESM imports
 * and worked only because `buildServer` happened to read the variable at call time — a fact no test
 * asserted and any refactor could quietly break. It also masked the probe exemptions: with a limit
 * of 10000 nothing in the suite could ever be throttled, so deleting the per-route rate-limit config
 * from `/health` and `/ready` changed no result. The exemptions now have their own tests below,
 * which set a limit low enough to actually catch that.
 *
 * `readyCacheMs: 0` because the readiness tests below toggle pool health and read the answer
 * immediately; the cache itself is tested separately, with a real TTL.
 */
const SHARED = { logger: false as const, rateLimitMax: 10_000, readyCacheMs: 0 };

/** Independent of db.ts on purpose: the shutdown test ends those pools and still has to look at the
 *  database afterwards to prove the reaper stopped. */
const verifier = new Pool({ connectionString: process.env.DATABASE_URL ?? DEV_SYSTEM_URL, max: 2 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type QueryFn = (...args: unknown[]) => unknown;

/** Makes a pool fail the way a pool fails: the object stays, the query does not work. Returns the
 *  undo, because the next test needs a working database. */
function breakPool(pool: Pool, message: string): () => void {
  const original = pool.query;
  (pool as unknown as { query: QueryFn }).query = () => Promise.reject(new Error(message));
  return () => {
    (pool as unknown as { query: unknown }).query = original;
  };
}

/** Counts queries so "does not touch the database" can be asserted rather than assumed. */
function countQueries(pool: Pool): { calls: () => number; restore: () => void } {
  const original = pool.query as QueryFn;
  let n = 0;
  (pool as unknown as { query: QueryFn }).query = (...args: unknown[]) => {
    n += 1;
    return original.apply(pool, args);
  };
  return {
    calls: () => n,
    restore: () => {
      (pool as unknown as { query: unknown }).query = original;
    },
  };
}

async function insertExpiredSession(): Promise<string> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO sessions (org_id, state, region, expires_at)
       VALUES ($1, 'ACTIVE', $2, now() - interval '1 minute') RETURNING id`,
      [orgId, REGION],
    );
    return rows[0].id as string;
  });
}

/** Reads through the independent pool, so it works either side of closePools(). */
async function sessionState(id: string): Promise<string> {
  const { rows } = await verifier.query('SELECT state FROM sessions WHERE id = $1', [id]);
  return rows[0].state as string;
}

async function waitUntil(cond: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(25);
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

before(async () => {
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Lifecycle Test')
                   ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgId = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent)
                            VALUES ('lifecycle','Lifecycle',50) RETURNING id`)).rows[0].id;
  });
  app = await buildServer(SHARED);
});

after(async () => {
  await app.close();
  await verifier.query('DELETE FROM sessions WHERE org_id = $1', [orgId]);
  await verifier.query('DELETE FROM orgs WHERE id = $1', [orgId]);
  await verifier.query('DELETE FROM regions WHERE code = $1', [REGION]);
  await verifier.end();
});

describe('liveness', () => {
  test('/health issues no queries at all', async () => {
    // The reason liveness and readiness are separate endpoints. If this ever starts touching the
    // database, a brief blip becomes a restart of every replica at once — and the restart is what
    // turns a blip into an outage.
    const appQ = countQueries(appPool);
    const sysQ = countQueries(systemPool);
    try {
      const r = await app.inject({ method: 'GET', url: '/health' });
      assert.equal(r.statusCode, 200);
      assert.deepEqual(r.json(), { status: 'ok' });
      assert.equal(appQ.calls(), 0);
      assert.equal(sysQ.calls(), 0);
    } finally {
      appQ.restore();
      sysQ.restore();
    }
  });

  test('/health stays 200 while the database is unreachable', async () => {
    const undoApp = breakPool(appPool, 'connection refused');
    const undoSystem = breakPool(systemPool, 'connection refused');
    try {
      const r = await app.inject({ method: 'GET', url: '/health' });
      assert.equal(r.statusCode, 200, 'liveness must not depend on a dependency it cannot fix');
    } finally {
      undoApp();
      undoSystem();
    }
  });
});

describe('readiness', () => {
  test('needs no credentials and is 200 when both pools answer', async () => {
    const r = await app.inject({ method: 'GET', url: '/ready' });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { status: 'ready' });
  });

  test('503 when the app pool is broken', async () => {
    // The pool that matters: every request handler goes through it, and it has its own role, its
    // own password and its own limit, so it can be down while the owner connection is fine.
    const undo = breakPool(appPool, 'password authentication failed for user "mfarm_app"');
    try {
      const r = await app.inject({ method: 'GET', url: '/ready' });
      assert.equal(r.statusCode, 503);
      const body = r.json();
      assert.equal(body.error.code, 'not_ready');
      assert.deepEqual(body.error.pools, { app: 'down', system: 'up' });
    } finally {
      undo();
    }
  });

  test('503 when the owner pool is broken', async () => {
    const undo = breakPool(systemPool, 'the database system is starting up');
    try {
      const r = await app.inject({ method: 'GET', url: '/ready' });
      assert.equal(r.statusCode, 503);
      assert.deepEqual(r.json().error.pools, { app: 'up', system: 'down' });
    } finally {
      undo();
    }
  });

  test('the response body carries exactly four fields and none of them is the reason', async () => {
    // /ready is unauthenticated. A pg error carries the host, port, database and role it could not
    // reach, which is a free map of the deployment for anyone who curls it during an incident.
    //
    // Asserting the absence of two specific strings was not enough: a handler that leaked the role
    // name, the database name, or `err.code` would have passed. Pin the exact key set instead, so
    // ANY new field has to be added here deliberately.
    const undo = breakPool(appPool, 'connect ECONNREFUSED 10.4.2.7:5432 as mfarm_app');
    try {
      const r = await app.inject({ method: 'GET', url: '/ready' });
      assert.equal(r.statusCode, 503);
      const body = r.json();
      assert.deepEqual(Object.keys(body), ['error']);
      assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'pools', 'requestId']);
      assert.deepEqual(Object.keys(body.error.pools).sort(), ['app', 'system']);
      assert.equal(body.error.code, 'not_ready');
      assert.equal(
        body.error.message,
        'Database is not reachable. This instance should not receive traffic.',
      );
      assert.deepEqual(body.error.pools, { app: 'down', system: 'up' });
      assert.match(body.error.requestId, /^[0-9a-f-]{36}$/);
    } finally {
      undo();
    }
  });

  test('recovers on its own once the database comes back', async () => {
    // The property that makes readiness the right place for I/O: no process died, so nothing has to
    // be restarted for the instance to return to service.
    const undo = breakPool(appPool, 'down');
    try {
      assert.equal((await app.inject({ method: 'GET', url: '/ready' })).statusCode, 503);
    } finally {
      undo();
    }
    assert.equal((await app.inject({ method: 'GET', url: '/ready' })).statusCode, 200);
  });

  test('a probe storm costs one query pair, not one per request', async () => {
    // /ready is public, exempt from nothing a caller has to pay, and it does I/O on BOTH pools.
    // Without the cache, a few hundred concurrent unauthenticated GETs exhaust appPool (20) and
    // systemPool (5) and every tenant request queues behind them — no credential, no cost to the
    // attacker. The cache is what makes the endpoint's cost independent of the request rate.
    const cached = await buildServer({ ...SHARED, readyCacheMs: 1_000 });
    const appQ = countQueries(appPool);
    const sysQ = countQueries(systemPool);
    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, () => cached.inject({ method: 'GET', url: '/ready' })),
      );
      for (const r of results) assert.equal(r.statusCode, 200, r.body);
      assert.equal(appQ.calls(), 1, '50 probes must not be 50 queries on the app pool');
      assert.equal(sysQ.calls(), 1, '50 probes must not be 50 queries on the owner pool');
    } finally {
      appQ.restore();
      sysQ.restore();
      await cached.close();
    }
  });

  test('the cache expires, so a real outage is still reported within a probe interval', async () => {
    // The other half: a cache that never expires is a readiness endpoint that lies.
    const cached = await buildServer({ ...SHARED, readyCacheMs: 100 });
    try {
      assert.equal((await cached.inject({ method: 'GET', url: '/ready' })).statusCode, 200);
      const undo = breakPool(appPool, 'down');
      try {
        await waitUntil(
          async () => (await cached.inject({ method: 'GET', url: '/ready' })).statusCode === 503,
          2_000,
          'the readiness cache to expire',
        );
      } finally {
        undo();
      }
    } finally {
      await cached.close();
    }
  });

  test('one IP cannot use /ready as an unmetered handle on the pools', async () => {
    // The cache alone is not enough: it bounds the database cost, not the request cost. HOST
    // defaults to 0.0.0.0 and the WebDriver hub has to share the listener, so this endpoint is
    // reachable from the internet. ADR-0001 exempted the probes on /health's behalf — "a 429 is
    // indistinguishable from a dead pod" — and that argument does not transfer to an endpoint that
    // does I/O.
    const limited = await buildServer({ ...SHARED, readyRateLimitMax: 3 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        codes.push((await limited.inject({ method: 'GET', url: '/ready' })).statusCode);
      }
      assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('probes and the rate limiter', () => {
  // These are the tests that were missing. With RATE_LIMIT_MAX pinned at 10000 for the whole file,
  // deleting `{ config: { rateLimit: ... } }` from both probe routes changed no assertion anywhere
  // in the suite — the exemptions were load-bearing and completely uncovered.

  test('/health is exempt from the global limiter even at a limit of 1', async () => {
    const strict = await buildServer({ ...SHARED, rateLimitMax: 1 });
    try {
      // The control: an ordinary route on the same limiter is throttled at the same limit, which
      // proves the limiter is switched on and that this test is capable of failing. Unauthenticated
      // requests are counted before they are rejected, so a 401 still costs a token.
      assert.equal((await strict.inject({ method: 'GET', url: '/v1/devices' })).statusCode, 401);
      assert.equal((await strict.inject({ method: 'GET', url: '/v1/devices' })).statusCode, 429);

      // Liveness must never be throttled: a kubelet cannot tell a 429 from a dead pod, so one noisy
      // IP sharing the ingress would restart the fleet.
      for (let i = 0; i < 10; i++) {
        assert.equal((await strict.inject({ method: 'GET', url: '/health' })).statusCode, 200, `probe ${i}`);
      }
    } finally {
      await strict.close();
    }
  });

  test('/ready has its own budget and does not spend the global one', async () => {
    // Limited, but on a separate per-IP counter: a customer's traffic must not be able to starve
    // the load balancer's probe, and the probe must not be able to starve the customer.
    const strict = await buildServer({ ...SHARED, rateLimitMax: 1, readyRateLimitMax: 20 });
    try {
      assert.equal((await strict.inject({ method: 'GET', url: '/v1/devices' })).statusCode, 401);
      assert.equal((await strict.inject({ method: 'GET', url: '/v1/devices' })).statusCode, 429);
      for (let i = 0; i < 10; i++) {
        assert.equal((await strict.inject({ method: 'GET', url: '/ready' })).statusCode, 200, `probe ${i}`);
      }
    } finally {
      await strict.close();
    }
  });
});

describe('the reaper', () => {
  test('runs on the configured interval and stops when the server closes', async () => {
    // Both halves are asserted while the pools are still OPEN, deliberately. Checking this through
    // the full shutdown instead would prove nothing: the reaper would also stop firing usefully
    // because closePools() ended the pools underneath it, so the test would pass whether or not
    // anyone had cleared the interval.
    const reaping = await buildServer({ ...SHARED, reaperIntervalMs: 100 });
    const before = await insertExpiredSession();
    await waitUntil(async () => (await sessionState(before)) === 'ENDED', 4000, 'the reaper to run');

    await reaping.close();

    const after = await insertExpiredSession();
    await sleep(600); // six intervals
    assert.equal(await sessionState(after), 'ACTIVE', 'the onClose hook did not clear the interval');
  });
});

describe('the RLS boundary, checked against the live server', () => {
  /**
   * config.ts can only compare two strings it was handed. It cannot see that `db.internal` and
   * `db-primary.internal` are the same host, that a pgbouncer address fronts the primary, or that
   * someone rotated APP_DATABASE_URL's credentials onto the owner role. Every one of those produces
   * request handling that runs as the owner — RLS enforcing nothing while every policy reads as
   * enabled. `ci.yml` makes this exact check, but only in CI, where the URLs are hardcoded and
   * correct: precisely where it cannot fail.
   */

  /** A pool that answers the boundary query with whatever the scenario needs. */
  function fakePool(row: Record<string, unknown>): Pool {
    return { query: async () => ({ rows: [row] }) } as unknown as Pool;
  }

  const sound = { role: 'mfarm_app', is_superuser: false, bypasses_rls: false, owns_tenant_tables: false };

  test('the real app pool passes', async () => {
    await assertAppRoleIsRlsBound(appPool);
  });

  test('the real owner pool is refused', async () => {
    // The check has to fail on the connection it is meant to catch, or it proves nothing above.
    await assert.rejects(() => assertAppRoleIsRlsBound(systemPool), (err: Error) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /SUPERUSER/);
      return true;
    });
  });

  for (const [what, row, needle] of [
    ['a superuser', { ...sound, role: 'mfarm', is_superuser: true }, /SUPERUSER/],
    ['a role with BYPASSRLS', { ...sound, role: 'reporting', bypasses_rls: true }, /BYPASSRLS/],
    ['the table owner', { ...sound, role: 'mfarm_owner', owns_tenant_tables: true }, /OWNS the tenant tables/],
  ] as const) {
    test(`refuses ${what}`, async () => {
      await assert.rejects(() => assertAppRoleIsRlsBound(fakePool(row)), (err: Error) => {
        assert.ok(err instanceof ConfigError, `expected a ConfigError, got ${err.name}`);
        assert.match(err.message, needle);
        assert.ok(err.message.includes(row.role), 'the message must name the role actually connected');
        return true;
      });
    });
  }

  test('a sound app role is accepted', async () => {
    await assertAppRoleIsRlsBound(fakePool(sound));
  });

  test('start() refuses to bind a port when the boundary is broken', async () => {
    // The point of doing this in start() rather than only in a test: it must happen BEFORE the
    // listener, so an instance that cannot enforce tenant isolation never receives a request. It
    // exits 78 like every other configuration refusal, because a restart will not fix it either.
    const original = appPool.query;
    (appPool as unknown as { query: QueryFn }).query = async () => ({
      rows: [{ ...sound, role: 'mfarm', is_superuser: true }],
    });
    try {
      await assert.rejects(
        () => start(parseConfig({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent' })),
        (err: Error) => err instanceof ConfigError && /SUPERUSER/.test(err.message),
      );
    } finally {
      (appPool as unknown as { query: unknown }).query = original;
    }
    // Nothing was bound and nothing was closed, so the suite below still has its pools.
    assert.equal(appPool.ended, false);
  });
});

describe('service lifecycle', () => {
  // Runs last: this closes the shared pools.
  test('binds, reaps while up, and closes cleanly', async () => {
    const stale = await insertExpiredSession();

    const svc = await start(parseConfig({
      PORT: '0',
      // AND THE METRICS PORT, which `PORT: '0'` does not cover. `start()` binds two listeners and
      // only one of them was asked for an ephemeral port, so METRICS_PORT took its 9464 default and
      // this test could not run on a machine where the API was already running — `EADDRINUSE
      // 127.0.0.1:9464`, reported as a lifecycle failure with nothing to do with lifecycle. Worse,
      // the run then HUNG instead of finishing, so the summary that names the port never printed.
      METRICS_PORT: '0',
      HOST: '127.0.0.1',
      REAPER_INTERVAL_MS: '100',
      RATE_LIMIT_MAX: '10000',
      SHUTDOWN_GRACE_MS: '5000',
      LOG_LEVEL: 'silent',
    }));
    assert.match(svc.address, /^http:\/\/127\.0\.0\.1:\d+$/);

    // The deliverable, stated as a test: a deployed process expires sessions without anybody
    // calling anything.
    await waitUntil(async () => (await sessionState(stale)) === 'ENDED', 4000, 'the reaper to expire a session');

    const afterShutdown = await insertExpiredSession();
    const clean = await svc.close('test');
    assert.equal(clean, true, 'the drain should finish well inside the grace period');

    // Both pools closed, in the same call, after the drain.
    assert.equal(appPool.ended, true);
    assert.equal(systemPool.ended, true);

    // Idempotent. Fastify throws on a second close() and pg throws on a second end(), so without
    // the memoised promise a SIGTERM followed by a SIGINT turns a clean shutdown into a crash.
    assert.equal(await svc.close('again'), true);

    // Nothing carries on after the pools are gone. Weaker than the reaper test above — an ended
    // pool would stop it either way — but it does catch a shutdown that leaves work running long
    // enough to log a stream of failures during every deploy.
    await sleep(600);
    assert.equal(await sessionState(afterShutdown), 'ACTIVE');
  });
});
