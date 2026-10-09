/**
 * A machine an org enrolled itself is not the farm's infrastructure — D73, ADR-0050.
 *
 * WHAT THIS FILE REPRODUCES. On 2026-10-09 the live farm had two hosts: the device host, switched
 * off, and a MacBook that had enrolled an agent to share two phones. The product had one model of a
 * host — a cloud VM rented by the hour whose silence is an incident — and applied it to both:
 *
 *   the laptop's 34.4 powered hours were priced at the device host's ₹65 an hour;
 *   the overview read DOWN whether the laptop was awake (no usable device) or asleep (a host not
 *     answering), in a farm that was simply put away;
 *   every nap wrote a "stopped responding" warning and two device-quarantine rows into the feed.
 *
 * THE FIXTURE IS THAT FARM: one fleet host that is stopped, one enrolled host that is awake with
 * its phones unplugged, and one that is asleep. Every assertion below failed against it before.
 *
 * THE DATABASE IS SHARED WITH EVERY OTHER TEST FILE, so nothing here asserts a fleet-wide total.
 * Where a figure is global — the device counts, the month's spend — the test measures it, changes
 * one thing, and measures it again.
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
import { upsertUser, cookieValue } from '../src/users.ts';
import { parseConfig } from '../src/config.ts';
import {
  costSnapshot, fleetSnapshot, healthComponents, hostSnapshots, type FleetSnapshot,
} from '../src/infra/snapshot.ts';
import { recentEvents } from '../src/infra/events.ts';
import { hostHourlyRate, hostKind } from '../src/infra/rates.ts';

let app: FastifyInstance;
let orgId: string;
let operatorCookie: string;
let lab: string, awake: string, asleep: string;
let labDevice: string, asleepDevice: string;

const REGION = `enrolled-${randomUUID().slice(0, 8)}`;
const OPERATOR = `op-${randomUUID()}@example.test`;
const PASSWORD = 'correct horse battery staple';
const ORG_NAME = 'Acme Phones';

const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  withSystem(async (c) => (await c.query(sql, params)).rows as T[]);

async function signIn(email: string) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PASSWORD } });
  assert.equal(res.statusCode, 200, `sign-in failed: ${res.body}`);
  const raw = String(res.headers['set-cookie']);
  return `mfarm_session=${cookieValue(raw.replace(/; /g, '; '), 'mfarm_session')}`;
}

const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: operatorCookie } });

/** A host, fleet or enrolled, with a chosen state and a chosen silence. */
async function seedHost(hostname: string, opts: {
  enrolled: boolean; state: string; beatSecondsAgo: number; source?: string;
}): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO hosts (region, hostname, state, protocol_version, org_id, last_heartbeat_at,
                        quarantine_source, quarantined_at, cores, memory_mb)
     VALUES ($1,$2,$3,2,$4, now() - make_interval(secs => $5), $6,
             CASE WHEN $6::text IS NULL THEN NULL ELSE now() END, 8, 16384) RETURNING id`,
    [REGION, hostname, opts.state, opts.enrolled ? orgId : null, opts.beatSecondsAgo, opts.source ?? null]);
  return row.id;
}

const seedDevice = async (host: string, state: string, enrolled: boolean): Promise<string> => (await q<{ id: string }>(
  `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, capabilities, local_id, org_id)
   VALUES ($1,$2,'android','physical','Phone Test','14',$3,'[]'::jsonb,$4,$5) RETURNING id`,
  [host, REGION, state, `d-${randomUUID().slice(0, 6)}`, enrolled ? orgId : null]))[0].id;

/** A closed stretch of powered time, ending `endedMinutesAgo` ago. */
const seedInterval = (host: string, minutes: number, endedMinutesAgo: number, endedBy: string) => q(
  `INSERT INTO host_power_intervals (host_id, started_at, ended_at, ended_by)
   VALUES ($1, now() - make_interval(mins => $2), now() - make_interval(mins => $3), $4)`,
  [host, minutes + endedMinutesAgo, endedMinutesAgo, endedBy]);

/** Only this file's hosts, out of everything the shared database holds. */
async function mine() {
  const all = await hostSnapshots(() => false);
  return all.filter((h) => [lab, awake, asleep].includes(h.id));
}

before(async () => {
  app = await buildServer({ logger: false, loginRateLimitMax: 10_000 });
  await q(`INSERT INTO regions (code,name) VALUES ($1,'Enrolled Test') ON CONFLICT (code) DO NOTHING`, [REGION]);
  orgId = (await q<{ id: string }>(
    `INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,$2,50) RETURNING id`,
    [`enrolled-${randomUUID()}`, ORG_NAME]))[0].id;
  await upsertUser(OPERATOR, PASSWORD, orgId, 'admin');
  await q('UPDATE users SET operator = true WHERE lower(email) = lower($1)', [OPERATOR]);
  operatorCookie = await signIn(OPERATOR);

  // The farm, put away: its one host switched off from the console, its devices withdrawn.
  lab = await seedHost(`lab-${REGION}`, { enrolled: false, state: 'DOWN', beatSecondsAgo: 6 * 3600 });
  labDevice = await seedDevice(lab, 'QUARANTINED', false);
  await seedDevice(lab, 'QUARANTINED', false);

  // A laptop that is open, with its phones unplugged.
  awake = await seedHost(`awake-${REGION}`, { enrolled: true, state: 'UP', beatSecondsAgo: 3 });
  await seedDevice(awake, 'OFFLINE', true);
  await seedDevice(awake, 'OFFLINE', true);

  // A laptop that is closed. The reaper has done what it does to any silent host.
  asleep = await seedHost(`asleep-${REGION}`,
    { enrolled: true, state: 'QUARANTINED', beatSecondsAgo: 3 * 3600, source: 'reaper' });
  asleepDevice = await seedDevice(asleep, 'QUARANTINED', true);
});

after(async () => {
  // Devices, the power ledger and the quarantine log all cascade from `hosts`.
  await q('DELETE FROM hosts WHERE region = $1', [REGION]);
  await q('DELETE FROM user_sessions WHERE org_id = $1', [orgId]);
  await q('DELETE FROM memberships WHERE org_id = $1', [orgId]);
  await q('DELETE FROM orgs WHERE id = $1', [orgId]);
  await q('DELETE FROM regions WHERE code = $1', [REGION]);
  await app.close();
  await closePools();
});

describe('the overview keeps the farm and the enrolled apart', () => {
  test('an enrolled host is listed under `enrolled`, never under `hosts`', async () => {
    const body = (await get('/v1/infra/overview')).json();
    const ids = (list: Array<{ id: string }>) => list.map((h) => h.id);

    assert.ok(ids(body.hosts).includes(lab), 'the fleet host is missing from `hosts`');
    for (const id of [awake, asleep]) {
      assert.ok(!ids(body.hosts).includes(id),
        'an enrolled laptop is in `hosts`, which is everything the page counts, costs and alerts on');
      assert.ok(ids(body.enrolled).includes(id), 'an enrolled host is in neither list');
    }
    assert.ok(!ids(body.enrolled).includes(lab));
  });

  test('it says whose it is, and is never offered a power control', async () => {
    const body = (await get('/v1/infra/overview')).json();
    const host = body.enrolled.find((h: { id: string }) => h.id === awake);
    assert.equal(host.kind, 'enrolled');
    assert.deepEqual(host.owner, { orgId, name: ORG_NAME });
    assert.equal(host.powerable, false, 'Start and Stop are drawn from this, on a customer\'s laptop');

    const fleet = body.hosts.find((h: { id: string }) => h.id === lab);
    assert.equal(fleet.kind, 'fleet');
    assert.equal(fleet.owner, null);
  });

  test('connected or away — a closed laptop is not `unknown`, and raises no alarm', async () => {
    const [labHost, awakeHost, asleepHost] = await mine().then((hs) =>
      [lab, awake, asleep].map((id) => hs.find((h) => h.id === id)!));

    assert.equal(awakeHost.power, 'running');
    assert.equal(asleepHost.power, 'away');
    assert.equal(asleepHost.reachability, 'unavailable', 'the fixture is not actually silent');
    assert.deepEqual(asleepHost.alerts, [],
      `a closed laptop raised ${JSON.stringify(asleepHost.alerts.map((a) => a.code))}`);
    // Its own disk and load are its owner's business: it has never reported stats here, which on a
    // fleet host is a warning.
    assert.deepEqual(awakeHost.alerts.map((a) => a.code).filter((c) => c !== 'tunnel-down'), []);

    // The control: the same silence on the farm's own host is still an alarm when it is not off.
    assert.equal(labHost.power, 'stopped');
  });

  test('an enrolled host has no rate and has cost the farm nothing', async () => {
    await seedInterval(awake, 600, 5, 'silence');
    const host = (await mine()).find((h) => h.id === awake)!;
    assert.deepEqual(host.cost, { perHour: null, sinceUp: null, today: null, monthToDate: null },
      'ten hours of somebody\'s laptop were priced');
    assert.equal(host.utilisationPct, null, 'an idle laptop was scored as wasted capacity');

    const fleet = (await mine()).find((h) => h.id === lab)!;
    assert.equal(fleet.cost.perHour, 65);
  });
});

describe('the health of the farm is about the farm', () => {
  /** The fleet as it would be if this file's rows were the whole database. */
  const fleetOf = (devices: Partial<FleetSnapshot['devices']>): FleetSnapshot => ({
    devices: { total: 0, ready: 0, allocated: 0, quarantined: 0, offline: 0, preparing: 0, cleaning: 0, ...devices },
    enrolledDevices: { total: 3, ready: 0, allocated: 0 },
    sessions: { active: 0, queued: 0, oldestQueuedSeconds: null },
    loadPct: null,
  });

  test('a farm that is switched off reads OFF with a laptop awake beside it, and with one asleep', async () => {
    const components = await healthComponents(await mine(), fleetOf({ total: 2, quarantined: 2 }), 5);
    const status = (id: string) => components.find((c) => c.id === id)!.status;

    // Before: the awake laptop made the farm "1 of 3 powered on" and its unplugged phones made
    // "Device farm" DOWN; the sleeping one was a host not answering.
    assert.equal(status('hosts'), 'off', components.find((c) => c.id === 'hosts')!.detail);
    assert.equal(status('devices'), 'off', components.find((c) => c.id === 'devices')!.detail);
    assert.equal(status('agents'), 'off');
    assert.equal(status('network'), 'off');
    // Only the lights that are ABOUT hosts. `storage` and `database` measure the machine running
    // this test, and a developer's nearly-full disk is not this file's business.
    const aboutHosts = components.filter((c) => ['hosts', 'agents', 'devices', 'network'].includes(c.id));
    assert.ok(!aboutHosts.some((c) => c.status === 'down' || c.status === 'degraded'),
      `a put-away farm read as broken: ${JSON.stringify(aboutHosts)}`);
    assert.match(components.find((c) => c.id === 'hosts')!.detail, /^0 of 1 powered on/,
      'the laptops are still being counted as hosts of this farm');
  });

  test('the device counts are the farm\'s own, and a retired host\'s devices are gone from them', async () => {
    const beforeAny = await fleetSnapshot();

    // Two more phones on an enrolled laptop...
    await seedDevice(awake, 'OFFLINE', true);
    await seedDevice(awake, 'READY', true);
    // ...and a fleet host somebody retired, whose device `retireHost` leaves quarantined for the record.
    const gone = await seedHost(`gone-${REGION}`, { enrolled: false, state: 'QUARANTINED', beatSecondsAgo: 86_400, source: 'operator' });
    await q('UPDATE hosts SET retired_at = now() WHERE id = $1', [gone]);
    await seedDevice(gone, 'QUARANTINED', false);

    const afterAll = await fleetSnapshot();
    assert.deepEqual(afterAll.devices, beforeAny.devices,
      'devices that are not the farm\'s current capacity moved its counts');
    assert.equal(afterAll.enrolledDevices.total, beforeAny.enrolledDevices.total + 2);
    assert.equal(afterAll.enrolledDevices.ready, beforeAny.enrolledDevices.ready + 1);

    // The control: a device on a current fleet host does count.
    await seedDevice(lab, 'QUARANTINED', false);
    assert.equal((await fleetSnapshot()).devices.quarantined, beforeAny.devices.quarantined + 1);
  });
});

describe('what the farm is spending', () => {
  test('a laptop that is awake is not money burning', async () => {
    const cost = await costSnapshot(await mine());
    assert.equal(cost.runningPerHour, 0, 'the only thing "running" here is somebody\'s laptop');
    assert.match(cost.estimatedMonth.basis, /Nothing is powered on/);
    assert.deepEqual(cost.idle, [], 'an idle laptop is not a host left on');
  });

  test('an enrolled host\'s hours add nothing to the bill; a fleet host\'s do', async () => {
    const spent = async () => (await costSnapshot([])).monthToDate!;
    const start = await spent();

    await seedInterval(asleep, 300, 1, 'silence');
    assert.equal(await spent(), start, 'five hours of a customer\'s laptop were added to the month');

    // Thirty minutes, ended a minute ago. Compared loosely: the first half hour of a month clips it.
    await seedInterval(lab, 30, 1, 'stopped');
    assert.ok(await spent() > start, 'the farm\'s own host costs nothing either — the filter is too wide');
  });

  test('a fleet host is priced at its own instance\'s rate, and at the default without one', () => {
    const cfg = parseConfig({
      ...process.env,
      HOST_HOURLY_COST: '65',
      GCP_PROJECT: 'a-project',
      MFARM_POWER_INSTANCES: 'big.internal=big:zone-a,plain.internal=plain:zone-a',
      CLOUD_INSTANCE_RATES: 'big=140',
    });
    assert.equal(hostHourlyRate({ hostname: 'big.internal', orgId: null }, cfg), 140);
    assert.equal(hostHourlyRate({ hostname: 'plain.internal', orgId: null }, cfg), 65, 'on the allow-list, no rate named');
    assert.equal(hostHourlyRate({ hostname: 'elsewhere', orgId: null }, cfg), 65, 'not on the allow-list');
    // Ownership wins over any rate somebody configured by the same name.
    assert.equal(hostHourlyRate({ hostname: 'big.internal', orgId: 'an-org' }, cfg), null);
    assert.equal(hostKind('an-org'), 'enrolled');
    assert.equal(hostKind(null), 'fleet');
  });
});

describe('the feed is not a record of somebody\'s laptop sleeping', () => {
  test('an enrolled host\'s comings and goings are not events; the farm\'s are', async () => {
    await seedInterval(asleep, 4, 2, 'silence');
    await seedInterval(lab, 4, 2, 'silence');
    const titles = (await recentEvents({ limit: 200, sinceHours: 1 })).map((e) => e.title);

    assert.ok(!titles.some((t) => t.startsWith(`asleep-${REGION}`)),
      `the laptop is in the feed: ${titles.filter((t) => t.includes(REGION)).join(' | ')}`);
    assert.ok(titles.includes(`lab-${REGION} stopped responding`), 'the fleet host\'s silence was dropped too');
    assert.ok(titles.includes(`lab-${REGION} powered on`));
  });

  test('its devices leaving the pool with it are not events; anything else that happens to them is', async () => {
    await q(`INSERT INTO device_quarantine_log (device_id, event, source, reason)
             VALUES ($1,'quarantined','host','its host went quiet'),
                    ($1,'quarantined','operator','screen cracked'),
                    ($2,'quarantined','host','its host was stopped from the console')`,
      [asleepDevice, labDevice]);
    const events = (await recentEvents({ limit: 200, sinceHours: 1 }))
      .filter((e) => e.source === 'device' && e.target?.label.endsWith(REGION));
    const seen = events.map((e) => `${e.target!.label}: ${e.detail}`);

    assert.ok(!seen.includes(`asleep-${REGION}: its host went quiet`), 'the nap is in the feed');
    assert.ok(seen.includes(`asleep-${REGION}: screen cracked`), 'a person\'s action on an enrolled device was dropped');
    assert.ok(seen.includes(`lab-${REGION}: its host was stopped from the console`), 'the farm\'s own device event was dropped');
  });
});

describe('what the org that enrolled it is shown', () => {
  test('its own machine has no rate and no cost on /v1/hosts', async () => {
    await q(`INSERT INTO host_power_intervals (host_id, started_at) VALUES ($1, now() - interval '2 hours')
             ON CONFLICT DO NOTHING`, [awake]);
    const body = (await get('/v1/hosts')).json();
    const own = body.hosts.find((h: { id: string }) => h.id === awake);
    assert.equal(own.kind, 'enrolled');
    assert.equal(own.ratePerHour, null);
    assert.ok(own.uptimeSeconds > 0, 'the fixture has no open interval, so the next line proves nothing');
    assert.equal(own.costSinceUp, null, 'two hours of their own laptop, billed to them at the device host\'s rate');

    const shared = body.hosts.find((h: { id: string }) => h.id === lab);
    assert.equal(shared.kind, 'fleet');
    assert.equal(shared.ratePerHour, 65);
  });
});
