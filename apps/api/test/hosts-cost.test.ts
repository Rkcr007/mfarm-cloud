/**
 * What a machine costs to leave on, and what a tenant actually used.
 *
 * THE CASE THIS WHOLE FEATURE EXISTS FOR IS "UP AND IDLE". On 2026-09-11 the device host ran for
 * twenty hours after a check that needed two minutes; `metering_events` recorded a few minutes of
 * device time, correctly, because the devices were idle. A usage view built on the meter alone would
 * have shown almost nothing and prevented nothing. So the first test below asserts the two numbers
 * DISAGREE — a host billing twenty hours while the meter reports two minutes is the farm telling
 * the truth, not a bug.
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
let orgId: string, otherOrgId: string, key: string;
let adminCookie: string, memberCookie: string;
let sharedHost: string, ownHost: string, otherHost: string, downHost: string;

const REGION = `cost-${randomUUID().slice(0, 8)}`;
const ADMIN = `admin-${randomUUID()}@example.test`;
const MEMBER = `member-${randomUUID()}@example.test`;
const PASSWORD = 'correct horse battery staple';

async function signIn(email: string) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PASSWORD } });
  assert.equal(res.statusCode, 200, `sign-in failed: ${res.body}`);
  const raw = String(res.headers['set-cookie']);
  return `mfarm_session=${cookieValue(raw.replace(/; /g, '; '), 'mfarm_session')}`;
}

const hosts = (cookie = adminCookie) =>
  app.inject({ method: 'GET', url: '/v1/hosts', headers: { cookie } });

const findHost = async (hostname: string) =>
  (await hosts()).json().hosts.find((h: { hostname: string }) => h.hostname === hostname);

/** A host in a chosen state, up for a chosen length of time. */
async function seedHost(hostname: string, opts: {
  org?: string | null; state?: string; upHoursAgo?: number | null;
}) {
  return withSystem(async (c) => {
    const r = await c.query(
      `INSERT INTO hosts (region, hostname, state, protocol_version, org_id, up_since, last_heartbeat_at)
       VALUES ($1,$2,$3,2,$4,$5, now()) RETURNING id`,
      [REGION, hostname, opts.state ?? 'UP', opts.org ?? null,
       opts.upHoursAgo == null ? null : new Date(Date.now() - opts.upHoursAgo * 3600_000)]);
    return r.rows[0].id as string;
  });
}

before(async () => {
  app = await buildServer({ logger: false, loginRateLimitMax: 10_000 });
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Cost Test') ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgId = (await c.query(
      `INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,'Cost',50) RETURNING id`,
      [`cost-${randomUUID()}`])).rows[0].id;
    otherOrgId = (await c.query(
      `INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,'Other',50) RETURNING id`,
      [`cost-other-${randomUUID()}`])).rows[0].id;
  });
  await upsertUser(ADMIN, PASSWORD, orgId, 'admin');
  await upsertUser(MEMBER, PASSWORD, orgId, 'member');
  adminCookie = await signIn(ADMIN);
  memberCookie = await signIn(MEMBER);
  key = (await createApiKey(orgId, 'cost test fixture', { scope: 'full' })).plaintext;

  sharedHost = await seedHost(`shared-${REGION}`, { org: null, upHoursAgo: 20.8 });
  ownHost = await seedHost(`own-${REGION}`, { org: orgId, upHoursAgo: 2 });
  otherHost = await seedHost(`other-${REGION}`, { org: otherOrgId, upHoursAgo: 5 });
  downHost = await seedHost(`down-${REGION}`, { org: null, state: 'DOWN', upHoursAgo: 96 });
});

after(async () => { await app?.close(); await closePools(); });

describe('what a machine costs to leave on', () => {
  test('AN IDLE HOST STILL BILLS — the case the meter cannot see', async () => {
    // 20.8h at ₹65/h. The meter would report nearly nothing for this window, and both are right.
    const h = await findHost(`shared-${REGION}`);
    assert.ok(h, 'the shared host should be visible');
    assert.ok(Math.abs(h.uptimeSeconds - 20.8 * 3600) < 120, `uptime was ${h.uptimeSeconds}`);
    assert.ok(Math.abs(h.costSinceUp - 20.8 * 65) < 5, `cost was ${h.costSinceUp}`);

    const used = (await app.inject({
      method: 'GET', url: '/v1/account/usage', headers: { authorization: `Bearer ${key}` },
    })).json();
    // Nothing metered at all, while the host has been billing for the best part of a day. The two
    // numbers disagreeing IS the finding, and the reason this endpoint exists next to the meter.
    assert.ok(!used.usage.device_seconds, 'this fixture meters nothing, which is the point');
  });

  test('the rate is echoed, so a page showing money can say where it came from', async () => {
    const body = (await hosts()).json();
    assert.deepEqual(body.rate, { hourly: 65, currency: '₹' });
  });

  test('A STOPPED HOST REPORTS NO UPTIME, rather than counting since it was last on', async () => {
    // `up_since` on a DOWN host is the last time it came up. Subtracting it from now would report a
    // VM switched off on Tuesday as having run for four days — the opposite of the fact this
    // endpoint exists to report.
    const h = await findHost(`down-${REGION}`);
    assert.equal(h.state, 'DOWN');
    assert.equal(h.uptimeSeconds, null);
    assert.equal(h.costSinceUp, null);
    assert.ok(h.upSince, 'the timestamp is still reported — it just is not an uptime');
  });

  test('a host that has never said reports null, not zero', async () => {
    const name = `silent-${REGION}`;
    await seedHost(name, { org: null, upHoursAgo: null });
    const h = await findHost(name);
    assert.equal(h.upSince, null);
    assert.equal(h.uptimeSeconds, null);
    // Zero is a measurement. "We were not recording" is not one.
    assert.equal(h.costSinceUp, null);
  });

  test('a quarantined host is still burning money and still says so', async () => {
    const name = `quarantined-${REGION}`;
    await seedHost(name, { org: null, state: 'QUARANTINED', upHoursAgo: 3 });
    const h = await findHost(name);
    assert.ok(h.uptimeSeconds > 0, 'a quarantined machine is powered on');
    assert.ok(h.costSinceUp > 0, 'and is therefore still costing its hourly rate');
  });
});

describe('who may see it', () => {
  test('a shared host and this org’s own host are visible', async () => {
    const names = (await hosts()).json().hosts.map((h: { hostname: string }) => h.hostname);
    assert.ok(names.includes(`shared-${REGION}`));
    assert.ok(names.includes(`own-${REGION}`));
  });

  test('ANOTHER ORG’S DEDICATED HOST IS NOT', async () => {
    const names = (await hosts()).json().hosts.map((h: { hostname: string }) => h.hostname);
    assert.ok(!names.includes(`other-${REGION}`),
      'this runs on the system pool, so the WHERE clause is the whole authorization');
  });

  test('a member cannot see the machines at all', async () => {
    assert.equal((await hosts(memberCookie)).statusCode, 403);
  });

  test('an API key cannot either — this needs a person', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/hosts', headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(res.statusCode, 403);
  });
});

describe('the machine numbers migration 044 collected and nothing could read', () => {
  test('disk, load and memory come back WITH the time they were taken', async () => {
    await withSystem((c) => c.query(
      `UPDATE hosts SET disk_free_bytes = 5000000000, disk_total_bytes = 160000000000,
              load1 = 3.5, mem_available_mb = 2048, mem_total_mb = 65536, stats_at = now()
        WHERE id = $1`, [ownHost]));

    const h = await findHost(`own-${REGION}`);
    assert.equal(h.machine.diskFreeBytes, 5_000_000_000);
    assert.equal(h.machine.diskTotalBytes, 160_000_000_000);
    assert.equal(h.machine.load1, 3.5);
    // The timestamp is the load-bearing half: every gauge reads green on a host that stopped
    // reporting an hour before its disk filled.
    assert.ok(h.machine.at, 'a reading with no age is indistinguishable from a current one');
  });

  test('a host that has reported no stats says so rather than showing zeroes', async () => {
    const h = await findHost(`shared-${REGION}`);
    assert.equal(h.machine, null);
  });

  test('device counts come from the devices, not from the host', async () => {
    await withSystem((c) => c.query(
      `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, capabilities)
       VALUES ($1,$2,'android','cuttlefish','MFARM X1','17','READY','[]'::jsonb),
              ($1,$2,'android','cuttlefish','MFARM X1','17','OFFLINE','[]'::jsonb)`,
      [ownHost, REGION]));
    const h = await findHost(`own-${REGION}`);
    assert.equal(h.devices.total, 2);
    assert.equal(h.devices.ready, 1);
  });
});

describe('usage by day', () => {
  test('a sum is split into days, and days with nothing are absent rather than zero', async () => {
    const sessionId = await withSystem(async (c) => {
      const s = await c.query(
        `INSERT INTO sessions (org_id, state, region) VALUES ($1,'ENDED',$2) RETURNING id`,
        [orgId, REGION]);
      const id = s.rows[0].id;
      // Two days apart, with an empty day between them.
      for (const [ago, qty] of [[1, 600], [3, 1800]] as const) {
        await c.query(
          `INSERT INTO metering_events (event_id, org_id, session_id, kind, quantity, occurred_at)
           VALUES ($1,$2,$3,'device_seconds',$4, now() - ($5 || ' days')::interval)`,
          [randomUUID(), orgId, id, qty, ago]);
      }
      return id;
    });
    assert.ok(sessionId);

    const body = (await app.inject({
      method: 'GET', url: '/v1/account/usage', headers: { authorization: `Bearer ${key}` },
    })).json();

    const days = body.byDay.filter((d: { deviceSeconds: number }) => d.deviceSeconds > 0);
    assert.equal(days.length, 2, `expected two days with usage, got ${JSON.stringify(body.byDay)}`);
    assert.deepEqual(days.map((d: { deviceSeconds: number }) => d.deviceSeconds).sort((a: number, b: number) => a - b),
      [600, 1800]);
    // Each bucket is a UTC date string, not a timestamp — see `usageByDay`.
    for (const d of days) assert.match(d.day, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('the daily series adds up to the total the same window reports', async () => {
    const body = (await app.inject({
      method: 'GET', url: '/v1/account/usage', headers: { authorization: `Bearer ${key}` },
    })).json();
    const summed = body.byDay.reduce((n: number, d: { deviceSeconds: number }) => n + d.deviceSeconds, 0);
    // Two derivations of one number, which is the thing that has gone wrong repeatedly here.
    assert.equal(summed, body.usage.device_seconds ?? 0);
  });
});
