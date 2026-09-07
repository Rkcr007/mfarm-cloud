/**
 * What the HOST MACHINE reports about itself — S7.4, migration 044.
 *
 * ---------------------------------------------------------------- the gap this closes
 *
 * Every other gauge in `metrics.ts` is sampled from Postgres and describes the FLEET: devices by
 * state, sessions by state, queue depth, queue age, host heartbeat age. Every one of them is green
 * on a device host whose disk is 98% full — which is the state in which snapshot restores start
 * failing and the farm degrades in a way that reads as a device fault, for as long as it takes
 * somebody to ssh in and run `df`. That is D18's shape: a fact nobody measured, found by hand.
 *
 * `EXECUTION_ROADMAP.md` S7 previously claimed queue depth and capacity were the unobservable
 * things. They are not, and have not been for weeks; `metrics.test.ts` has a case named for them.
 * This is the gap that was actually there.
 *
 * ---------------------------------------------------------------- what is tested, and why here
 *
 * THE WHOLE PATH, THROUGH THE REAL ROUTE. `apps/api/test/metrics.test.ts` can seed a `hosts` row
 * and assert the gauges come out, and that would test the COLLECTOR while proving nothing about the
 * beat that has to fill those columns — a test that seeds state tests the renderer, never the
 * loader (`docs/DEFECTS.md`, D26). So this file registers a worker for real, posts a real
 * heartbeat, and reads the numbers back out of the exposition body.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { collectFleet, registry } from '../src/metrics.ts';

const REGION = `host-stats-${randomUUID().slice(0, 8)}`;
const HOSTNAME = `host-stats-${randomUUID().slice(0, 8)}`;

let app: FastifyInstance;
let hostId: string;
let workerToken: string;

/** One sample out of the exposition body, matching a subset of the labels. */
function sample(body: string, name: string, labels: string): number | undefined {
  for (const line of body.split('\n')) {
    if (line.startsWith('#')) continue;
    const m = /^([^\s{]+)(\{[^}]*\})?\s+(.+)$/.exec(line);
    if (!m || m[1] !== name) continue;
    if (!(m[2] ?? '').includes(labels)) continue;
    return Number(m[3]);
  }
  return undefined;
}

const at = `hostname="${HOSTNAME}"`;
const gauges = async () => { await collectFleet(); return registry.render(); };

const beat = (stats: unknown) => app.inject({
  method: 'POST', url: '/v1/workers/heartbeat',
  headers: { authorization: `Bearer ${workerToken}` },
  payload: stats === undefined ? {} : { stats },
});

const stored = () => withSystem(async (c) => (await c.query(
  `SELECT disk_free_bytes, disk_total_bytes, load1, cores, mem_available_mb, mem_total_mb,
          stats_at, last_heartbeat_at
     FROM hosts WHERE id = $1`, [hostId])).rows[0]);

before(async () => {
  app = await buildServer({ logger: false, rateLimitMax: 10_000 });
  await withSystem((c) => c.query(
    `INSERT INTO regions (code, name) VALUES ($1, 'Host Stats') ON CONFLICT (code) DO NOTHING`, [REGION]));

  const r = await app.inject({
    method: 'POST', url: '/v1/workers/register',
    headers: { 'x-worker-registration-token': 'test-registration-secret' },
    payload: {
      protocolVersion: 2, hostname: HOSTNAME, region: REGION,
      endpoint: 'wss://host-stats.example:8443', cores: 8, memoryMb: 16384,
      capabilities: ['screen-stream', 'snapshot-reset'], devices: [],
    },
  });
  assert.equal(r.statusCode, 201, r.body);
  hostId = r.json().hostId;
  workerToken = r.json().workerToken;
});

after(async () => {
  await withSystem(async (c) => {
    await c.query('DELETE FROM devices WHERE host_id = $1', [hostId]);
    await c.query('DELETE FROM hosts WHERE id = $1', [hostId]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await app?.close();
  await closePools();
});

describe('a host that has never reported', () => {
  /**
   * THE MOST IMPORTANT ASSERTION IN THIS FILE, and the one that inverts a rule the rest of
   * `metrics.ts` follows.
   *
   * Everywhere else, a missing series is the enemy: `DEVICE_STATES` is enumerated precisely so that
   * `mfarm_devices{state="READY"} == 0` keeps firing when the fleet empties, because an alert on a
   * series that disappears is silent exactly when it matters.
   *
   * Here the opposite is true. A zero disk gauge does not read as "unmeasured" — it reads as A FULL
   * DISK. Zero-filling these would manufacture a critical incident on every host running an agent
   * too old to answer, on the very first scrape after this migration. So NULL emits nothing, and
   * staleness is carried by `mfarm_host_stats_age_seconds` instead.
   */
  test('emits no machine gauges at all, rather than zeros that read as a full disk', async () => {
    const body = await gauges();
    for (const m of ['mfarm_host_disk_free_bytes', 'mfarm_host_disk_total_bytes',
                     'mfarm_host_load1', 'mfarm_host_mem_available_mb',
                     'mfarm_host_mem_total_mb', 'mfarm_host_stats_age_seconds']) {
      assert.equal(sample(body, m, at), undefined,
        `${m} was emitted for a host that has never reported — a zero here reads as an incident`);
    }
  });

  test('but is still a live host by every gauge that does not depend on stats', async () => {
    const body = await gauges();
    assert.equal(typeof sample(body, 'mfarm_host_last_heartbeat_timestamp_seconds', at), 'number');
  });
});

describe('a heartbeat carrying machine stats', () => {
  const STATS = {
    diskFreeBytes: 12_884_901_888, diskTotalBytes: 107_374_182_400,
    load1: 3.5, cores: 8, memAvailableMb: 4096, memTotalMb: 16384,
  };

  test('is stored, and comes back out as gauges', async () => {
    assert.equal((await beat(STATS)).statusCode, 200);
    const body = await gauges();
    assert.equal(sample(body, 'mfarm_host_disk_free_bytes', at), STATS.diskFreeBytes);
    assert.equal(sample(body, 'mfarm_host_disk_total_bytes', at), STATS.diskTotalBytes);
    assert.equal(sample(body, 'mfarm_host_load1', at), STATS.load1);
    assert.equal(sample(body, 'mfarm_host_mem_available_mb', at), STATS.memAvailableMb);
    assert.equal(sample(body, 'mfarm_host_mem_total_mb', at), STATS.memTotalMb);
    const age = sample(body, 'mfarm_host_stats_age_seconds', at);
    assert.ok(age !== undefined && age >= 0 && age < 60, `stats age was ${age}`);
  });

  /**
   * `stats_at` IS NOT `last_heartbeat_at`, and this is what makes the age gauge worth having.
   *
   * An agent too old to send stats beats perfectly happily. Reading freshness from the heartbeat
   * column would report a week-old disk reading as current — a stale number wearing a fresh
   * timestamp, which is worse than no number.
   */
  test('a later beat with no stats leaves the numbers alone and does NOT refresh their age', async () => {
    assert.equal((await beat(STATS)).statusCode, 200);
    const first = await stored();

    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await beat(undefined)).statusCode, 200);
    const second = await stored();

    assert.equal(Number(second.disk_free_bytes), STATS.diskFreeBytes, 'a statless beat wiped the disk reading');
    assert.equal(second.stats_at.getTime(), first.stats_at.getTime(), 'stats_at moved on a beat that carried none');
    assert.ok(second.last_heartbeat_at.getTime() > first.last_heartbeat_at.getTime(),
      'the beat itself must still count as liveness');
  });

  /**
   * A worker is AUTHENTICATED BUT NOT TRUSTED TO BE CORRECT. A string, a NaN or an Infinity here
   * would either throw inside the beat — quarantining a live host over a metric, because migration
   * 038 reaps a host that stops beating — or store a value that makes the gauge lie.
   */
  test('rubbish in the stats is dropped, and never fails the beat', async () => {
    assert.equal((await beat(STATS)).statusCode, 200);
    const r = await beat({
      diskFreeBytes: 'lots', diskTotalBytes: null, load1: Number.NaN,
      memAvailableMb: Number.POSITIVE_INFINITY, memTotalMb: { nested: 1 }, cores: [],
    });
    assert.equal(r.statusCode, 200, 'a malformed stats block must not fail the heartbeat');
    const row = await stored();
    for (const k of ['disk_free_bytes', 'disk_total_bytes', 'load1', 'mem_available_mb', 'mem_total_mb'] as const) {
      assert.equal(row[k], null, `${k} kept a value it could not have measured`);
    }
    // `cores` is COALESCEd, so registration's 8 survives a beat that could not read it. That is the
    // one field with a second, authoritative writer.
    assert.equal(Number(row.cores), 8, 'a beat with no core count nulled what registration knew');
  });

  test('a stats block that is not an object is ignored rather than throwing', async () => {
    for (const junk of ['nope', 42, [], null]) {
      assert.equal((await beat(junk)).statusCode, 200, `stats: ${JSON.stringify(junk)} failed the beat`);
    }
  });

  /**
   * A DELETED HOST MUST STOP REPORTING A DISK. Without the reset in `collectFleet`, its last
   * reading would sit on the dashboard forever — indistinguishable from a machine that is still
   * there and still nearly full, which is an alert nobody can ever clear.
   */
  test('a host that is deleted stops reporting a disk', async () => {
    assert.equal((await beat(STATS)).statusCode, 200);
    assert.equal(typeof sample(await gauges(), 'mfarm_host_disk_free_bytes', at), 'number');

    const spare = await withSystem(async (c) => (await c.query(
      `INSERT INTO hosts (region, hostname, state, protocol_version, endpoint)
       VALUES ($1, $2, 'UP', 2, 'wss://gone.example:8443') RETURNING id`,
      [REGION, `${HOSTNAME}-gone`])).rows[0].id);
    await withSystem((c) => c.query(
      `UPDATE hosts SET disk_free_bytes = 1, stats_at = now() WHERE id = $1`, [spare]));
    assert.equal(sample(await gauges(), 'mfarm_host_disk_free_bytes', `hostname="${HOSTNAME}-gone"`), 1);

    await withSystem((c) => c.query('DELETE FROM hosts WHERE id = $1', [spare]));
    assert.equal(sample(await gauges(), 'mfarm_host_disk_free_bytes', `hostname="${HOSTNAME}-gone"`), undefined,
      'a deleted host is still reporting a disk');
  });
});
