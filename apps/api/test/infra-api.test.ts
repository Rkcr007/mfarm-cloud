/**
 * The Infrastructure Operations Center's read side, and the boundary in front of it.
 *
 * TWO THINGS THIS FILE IS TRYING HARD TO CATCH, because both have shipped in this repo before:
 *
 *   A CONTROL OFFERED ON A FALSE PREMISE. Seven defects of one shape. Here that would be an org
 *   admin — who is emphatically not a fleet operator — reaching a page that can drain a host. The
 *   403 tests below are the point of the feature, not paperwork around it.
 *
 *   A GREEN LIGHT THAT MEANS "WE HAVE NOT HEARD". Migration 044 needed a paragraph explaining that
 *   all five host gauges read healthy on a machine whose disk filled an hour after it stopped
 *   reporting. So `machine.status` is asserted to age INDEPENDENTLY of the heartbeat: a host beating
 *   perfectly with a wedged stats collector must not paint its hour-old disk reading green.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.HOST_HOURLY_COST = '65';
process.env.COST_CURRENCY = '₹';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { createApiKey } from '../src/auth.ts';
import { upsertUser, cookieValue } from '../src/users.ts';

let app: FastifyInstance;
let orgId: string, key: string;
let operatorCookie: string, adminCookie: string;
let liveHost: string, staleHost: string, silentHost: string, muteHost: string;

const REGION = `infra-${randomUUID().slice(0, 8)}`;
const OPERATOR = `op-${randomUUID()}@example.test`;
const ADMIN = `admin-${randomUUID()}@example.test`;
const PASSWORD = 'correct horse battery staple';

async function signIn(email: string) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PASSWORD } });
  assert.equal(res.statusCode, 200, `sign-in failed: ${res.body}`);
  const raw = String(res.headers['set-cookie']);
  return `mfarm_session=${cookieValue(raw.replace(/; /g, '; '), 'mfarm_session')}`;
}

const overview = (cookie = operatorCookie) =>
  app.inject({ method: 'GET', url: '/v1/infra/overview', headers: { cookie } });

/** One host out of the overview payload. Loosely typed on purpose: the assertions below are about
 *  the WIRE shape, and restating it here would make this file agree with itself rather than with
 *  the server. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hostIn = (body: { hosts: Array<Record<string, any>> }, id: string) =>
  body.hosts.find((h) => h.id === id)!;

/**
 * A host with a chosen heartbeat age and a chosen stats age.
 *
 * The two are separate arguments ON PURPOSE. They age independently in production and the whole
 * point of the freshness model is that the page says so; a fixture that tied them together could
 * not express the case that matters.
 */
async function seedHost(hostname: string, opts: {
  beatSecondsAgo?: number | null;
  statsSecondsAgo?: number | null;
  upHoursAgo?: number | null;
  state?: string;
  cores?: number;
  diskUsedPct?: number;
}) {
  const beat = opts.beatSecondsAgo == null ? null : new Date(Date.now() - opts.beatSecondsAgo * 1000);
  const stats = opts.statsSecondsAgo == null ? null : new Date(Date.now() - opts.statsSecondsAgo * 1000);
  const total = 500_000_000_000;
  const free = opts.diskUsedPct === undefined ? null
    : Math.round(total * (1 - opts.diskUsedPct / 100));
  return withSystem(async (c) => {
    const r = await c.query(
      `INSERT INTO hosts (region, hostname, state, protocol_version, org_id,
                          up_since, last_heartbeat_at, cores, memory_mb,
                          stats_at, disk_free_bytes, disk_total_bytes, load1,
                          mem_available_mb, mem_total_mb)
       VALUES ($1,$2,$3,2,NULL,$4,$5,$6,32768,$7,$8,$9,1.2,20000,32768) RETURNING id`,
      [REGION, hostname, opts.state ?? 'UP',
       opts.upHoursAgo == null ? null : new Date(Date.now() - opts.upHoursAgo * 3600_000),
       beat, opts.cores ?? 8, stats, free, free === null ? null : total]);
    return r.rows[0].id as string;
  });
}

before(async () => {
  app = await buildServer({ logger: false, loginRateLimitMax: 10_000 });
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Infra Test') ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgId = (await c.query(
      `INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,'Infra',50) RETURNING id`,
      [`infra-${randomUUID()}`])).rows[0].id;
  });
  // Both are org ADMINS. The only difference between them is the fleet grant, which is exactly the
  // distinction under test — a member would pass these tests for the wrong reason.
  await upsertUser(OPERATOR, PASSWORD, orgId, 'admin');
  await upsertUser(ADMIN, PASSWORD, orgId, 'admin');
  await withSystem((c) =>
    c.query('UPDATE users SET operator = true WHERE lower(email) = lower($1)', [OPERATOR]));
  operatorCookie = await signIn(OPERATOR);
  adminCookie = await signIn(ADMIN);
  key = (await createApiKey(orgId, 'infra test fixture', { scope: 'full' })).plaintext;

  liveHost   = await seedHost(`live-${REGION}`,   { beatSecondsAgo: 4,   statsSecondsAgo: 10,  upHoursAgo: 3, diskUsedPct: 40 });
  staleHost  = await seedHost(`stale-${REGION}`,  { beatSecondsAgo: 45,  statsSecondsAgo: 45,  upHoursAgo: 9, diskUsedPct: 60 });
  silentHost = await seedHost(`silent-${REGION}`, { beatSecondsAgo: 600, statsSecondsAgo: 600, upHoursAgo: 20, diskUsedPct: 70 });
  muteHost   = await seedHost(`mute-${REGION}`,   { beatSecondsAgo: null, statsSecondsAgo: null, upHoursAgo: null });
});

after(async () => {
  // Named region, so this cannot take another test's fixtures with it. `host_power_intervals`
  // cascades from `hosts`; `infra_operations` has no host FK and is cleaned by target id.
  await withSystem(async (c) => {
    // `infra_operations` refuses DELETE — migration 053's trigger applies to the owner too — so the
    // guard is lifted explicitly, which is the only shape that works and the right amount of
    // ceremony for erasing an audit trail. This suite writes no operations today; the line is here
    // so the stage that adds write routes does not discover the refusal in CI.
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

describe('who may open Infrastructure', () => {
  test('a fleet operator may', async () => {
    const res = await overview();
    assert.equal(res.statusCode, 200, res.body);
  });

  test('an ORG ADMIN who is not a fleet operator may not — the whole point of migration 053',
    async () => {
      const res = await overview(adminCookie);
      assert.equal(res.statusCode, 403, res.body);
      // The refusal has to say where the capability comes from, or the person reading it goes to
      // the Team page and changes a role that has nothing to do with it.
      assert.match(res.json().error.message, /fleet operator/i);
      assert.match(res.json().error.message, /separate from your role/i);
    });

  test('an API KEY may not, whatever its scope', async () => {
    for (const url of ['/v1/infra/overview', '/v1/infra/events', '/v1/infra/operations']) {
      const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });
      assert.equal(res.statusCode, 403, `${url} let a key through: ${res.body}`);
    }
  });

  test('an anonymous caller may not', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/infra/overview' });
    assert.equal(res.statusCode, 401, res.body);
  });

  test('revoking the grant takes effect on the NEXT REQUEST, not at session expiry', async () => {
    await withSystem((c) =>
      c.query('UPDATE users SET operator = false WHERE lower(email) = lower($1)', [OPERATOR]));
    try {
      // Same cookie, same session, no re-login. The grant is re-read per request by design.
      assert.equal((await overview()).statusCode, 403);
    } finally {
      await withSystem((c) =>
        c.query('UPDATE users SET operator = true WHERE lower(email) = lower($1)', [OPERATOR]));
    }
    assert.equal((await overview()).statusCode, 200);
  });
});

describe('live, stale, unavailable, unknown — four answers, never two', () => {
  test('each host lands on the right one', async () => {
    const body = (await overview()).json();
    assert.equal(hostIn(body, liveHost).reachability, 'live');
    assert.equal(hostIn(body, staleHost).reachability, 'stale');
    assert.equal(hostIn(body, silentHost).reachability, 'unavailable');
    assert.equal(hostIn(body, muteHost).reachability, 'unknown');
  });

  test('a host past the silence threshold is NOT reported as running', async () => {
    const body = (await overview()).json();
    assert.equal(hostIn(body, silentHost).power, 'unknown');
    // And its uptime is withheld rather than computed from a stale `up_since` — ADR-0035's rule.
    assert.equal(hostIn(body, silentHost).uptimeSeconds, null);
    assert.equal(hostIn(body, liveHost).power, 'running');
    assert.ok(hostIn(body, liveHost).uptimeSeconds! > 3 * 3600 - 60);
  });

  test('A LONG SILENCE IS SPELLED IN DAYS, not in thousands of minutes', async () => {
    // The real farm carried a laptop that had been off for a fortnight and the alert read
    // "No heartbeat for 21310 minutes" — correct, and a puzzle rather than a duration.
    const ancient = await seedHost(`ancient-${REGION}`, {
      beatSecondsAgo: 15 * 86_400, statsSecondsAgo: 15 * 86_400, upHoursAgo: null,
    });
    const h = hostIn((await overview()).json(), ancient);
    const alert = h.alerts.find((a: { code: string }) => a.code === 'host-silent');
    assert.ok(alert, 'no host-silent alert');
    assert.match(alert.message, /No heartbeat for 15 days/);
    assert.ok(!/\d{4,} minutes/.test(alert.message));
  });

  test('a silent host carries a critical alert naming the silence', async () => {
    const body = (await overview()).json();
    const alert = hostIn(body, silentHost).alerts.find((a: { code: string }) => a.code === 'host-silent');
    assert.ok(alert, 'no host-silent alert');
    assert.equal(alert.severity, 'critical');
  });
});

describe('a reading carries its own age', () => {
  test('MACHINE STATS AGE SEPARATELY FROM THE HEARTBEAT — migration 044s trap', async () => {
    const wedged = await seedHost(`wedged-${REGION}`, {
      beatSecondsAgo: 3,        // beating perfectly
      statsSecondsAgo: 4000,    // and the collector died over an hour ago
      upHoursAgo: 5, diskUsedPct: 97,
    });
    const body = (await overview()).json();
    const h = hostIn(body, wedged);

    assert.equal(h.reachability, 'live', 'the host itself is live');
    assert.equal(h.machine.status, 'unavailable', 'but its gauges are not');
    assert.ok(h.machine.ageSeconds! > 3600);

    // The 97% disk is REPORTED — hiding a number is its own kind of lie — but it must not raise a
    // disk alert, because a reading that old may have been cleared fifty minutes ago.
    assert.equal(h.machine.diskUsedPct, 97);
    const codes = h.alerts.map((a: { code: string }) => a.code);
    assert.ok(codes.includes('machine-stats-stale'), `expected machine-stats-stale, got ${codes}`);
    assert.ok(!codes.includes('disk-full'),
      'a stale 97% disk must not raise a current-disk alert');
  });

  test('a CURRENT full disk does raise one', async () => {
    const full = await seedHost(`full-${REGION}`, {
      beatSecondsAgo: 3, statsSecondsAgo: 5, upHoursAgo: 1, diskUsedPct: 96,
    });
    const h = hostIn((await overview()).json(), full);
    assert.equal(h.machine.status, 'live');
    const alert = h.alerts.find((a: { code: string }) => a.code === 'disk-full');
    assert.ok(alert, `expected disk-full, got ${h.alerts.map((a: { code: string }) => a.code)}`);
    assert.equal(alert.severity, 'critical');
  });

  test('a host that has never reported gauges says so rather than reading zero', async () => {
    const h = hostIn((await overview()).json(), muteHost);
    assert.equal(h.machine.status, 'unknown');
    assert.equal(h.machine.diskUsedPct, null);
    assert.equal(h.machine.diskFreeBytes, null, 'null, never 0 — 0 free bytes is a full disk');
  });
});

describe('the health rollup', () => {
  test('every component explains itself, including the healthy ones', async () => {
    const { health } = (await overview()).json();
    const ids = health.components.map((c: { id: string }) => c.id);
    for (const id of ['hosts', 'agents', 'database', 'devices', 'network', 'storage']) {
      assert.ok(ids.includes(id), `missing component ${id}`);
    }
    for (const c of health.components) {
      assert.ok(c.detail && c.detail.length > 0, `${c.id} has a status with no evidence behind it`);
    }
  });

  test('the overall word is the WORST component, never an average', async () => {
    const { health } = (await overview()).json();
    const worst = health.components.some((c: { status: string }) => c.status === 'down') ? 'down'
      : health.components.some((c: { status: string }) => c.status === 'degraded') ? 'degraded'
        : null;
    if (worst) assert.equal(health.overall, worst);
    // The fixtures include a host that has not beaten in ten minutes, so this suite should never
    // see a green overall. A test that passed on "healthy" here would be asserting nothing.
    assert.notEqual(health.overall, 'healthy');
  });

  test('the database component reports its own latency', async () => {
    const { health, controlPlane } = (await overview()).json();
    const db = health.components.find((c: { id: string }) => c.id === 'database');
    assert.equal(db.status, 'healthy');
    assert.ok(typeof controlPlane.dbLatencyMs === 'number');
  });
});

describe('cost', () => {
  test('the rate is echoed so the page never has to know it', async () => {
    const { cost } = (await overview()).json();
    assert.deepEqual(cost.rate, { hourly: 65, currency: '₹' });
  });

  test('the month projection states its assumption in words', async () => {
    const { cost } = (await overview()).json();
    assert.ok(typeof cost.estimatedMonth.value === 'number');
    assert.ok(/stay on for the rest of the month|month to date/.test(cost.estimatedMonth.basis),
      `basis was: ${cost.estimatedMonth.basis}`);
  });

  test('the trend covers fourteen days with no gaps', async () => {
    const { cost } = (await overview()).json();
    assert.equal(cost.trend.length, 14);
    // A day on which nothing was powered must appear as a zero rather than vanish, or the line
    // slopes the wrong way.
    for (const d of cost.trend) {
      assert.ok(typeof d.poweredHours === 'number', `${d.date} has no poweredHours`);
    }
  });

  test('a host that was never on has no utilisation figure — null, not 0%', async () => {
    const h = hostIn((await overview()).json(), muteHost);
    assert.equal(h.utilisationPct, null,
      'a machine that was off did not underuse anything');
  });
});

describe('capabilities are declared by the server', () => {
  test('the console is told what this deployment can do', async () => {
    const { capabilities } = (await overview()).json();
    // Read rather than asserted true: the point is that the FIELD exists and the page renders from
    // it, so a deployment with no cloud driver cannot draw a Stop button that returns 501.
    assert.equal(typeof capabilities.power, 'boolean');
    assert.equal(typeof capabilities.drain, 'boolean');
    assert.equal(typeof capabilities.services, 'boolean');
  });
});

describe('the filters refuse nonsense instead of 500ing', () => {
  test('a non-uuid actor is a 400 naming the parameter', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/infra/operations?actor=bob', headers: { cookie: operatorCookie },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.json().error.message, /actor/);
  });

  test('an unparseable date is a 400, not a silently different window', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/infra/operations?from=last-tuesday', headers: { cookie: operatorCookie },
    });
    assert.equal(res.statusCode, 400, res.body);
  });

  test('an unknown outcome is refused rather than ignored', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/infra/operations?outcome=maybe', headers: { cookie: operatorCookie },
    });
    assert.equal(res.statusCode, 400, res.body);
  });

  test('a wild limit is clamped, not refused', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/infra/events?limit=99999', headers: { cookie: operatorCookie },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.json().events.length <= 200);
  });
});
