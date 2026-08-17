/**
 * Metrics: the exposition format, the fleet collectors, and the listener that serves them.
 *
 * Three things are worth testing here and they fail in three different ways.
 *
 *   1. The TEXT FORMAT. A malformed histogram or an unescaped label makes Prometheus drop the whole
 *      scrape, and the symptom is a dashboard of "no data" that looks identical to a healthy idle
 *      farm.
 *   2. The ZERO-FILL. A gauge that vanishes when its count reaches zero cannot be alerted on with
 *      `== 0`, so the alert for "no device is allocatable" would be silent at precisely the moment
 *      it matters. That is the reason DEVICE_STATES is enumerated rather than derived, and this
 *      suite reads the enum back out of Postgres to prove the two lists have not drifted.
 *   3. The LISTENER's access rules. Every gauge here is fleet-wide and collected on the owner pool
 *      because RLS would otherwise hide it — so this endpoint crosses every tenant boundary the
 *      rest of the codebase defends.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  Counter,
  DEVICE_STATES,
  Gauge,
  HOST_STATES,
  Histogram,
  Registry,
  SESSION_STATES,
  collectFleet,
  collectRuntime,
  registry,
  scrape,
} from '../src/metrics.ts';
import { startMetricsServer } from '../src/http/metrics-server.ts';
import { withSystem, closePools } from '../src/db.ts';

// ---------------------------------------------------------------- helpers

/** One sample out of an exposition body. Labels are matched as a substring of the `{...}` block, so
 *  a caller can name a subset — enough for assertions, deliberately not a parser. */
function sample(body: string, name: string, labels?: string): number | undefined {
  for (const line of body.split('\n')) {
    if (line.startsWith('#')) continue;
    const m = /^([^\s{]+)(\{[^}]*\})?\s+(.+)$/.exec(line);
    if (!m || m[1] !== name) continue;
    if (labels && !(m[2] ?? '').includes(labels)) continue;
    return Number(m[3]);
  }
  return undefined;
}

const lines = (body: string, name: string) =>
  body.split('\n').filter((l) => !l.startsWith('#') && l.startsWith(name));

// ---------------------------------------------------------------- format

describe('exposition format', () => {
  test('a counter renders HELP, TYPE and one line per series', () => {
    const r = new Registry();
    const c = r.register(new Counter('t_requests_total', 'Requests.', ['route']));
    c.inc({ route: '/a' });
    c.inc({ route: '/a' }, 2);
    c.inc({ route: '/b' });
    const out = r.render();
    assert.match(out, /# HELP t_requests_total Requests\./);
    assert.match(out, /# TYPE t_requests_total counter/);
    assert.equal(sample(out, 't_requests_total', 'route="/a"'), 3);
    assert.equal(sample(out, 't_requests_total', 'route="/b"'), 1);
    assert.ok(out.endsWith('\n'), 'the format requires a trailing newline');
  });

  test('label values are escaped, and the quote escape is not double-escaped', () => {
    const r = new Registry();
    const c = r.register(new Counter('t_escaped_total', 'x', ['v']));
    c.inc({ v: 'a\\b"c\nd' });
    const out = r.render();
    // Backslash doubled, quote as \", newline as \n — and NOT \\" for the quote, which is what
    // escaping the quote before the backslash produces.
    assert.ok(out.includes('v="a\\\\b\\"c\\nd"'), out);
  });

  test('help text cannot break out of its line', () => {
    const r = new Registry();
    r.register(new Gauge('t_help', 'first\nsecond', []));
    const out = r.render();
    assert.ok(out.includes('# HELP t_help first second'));
    assert.equal(out.split('\n').filter((l) => l.startsWith('# HELP')).length, 1);
  });

  test('a histogram emits cumulative buckets, +Inf equal to _count, and a _sum', () => {
    const r = new Registry();
    const h = r.register(new Histogram('t_seconds', 'x', [], [0.1, 1]));
    h.observe({}, 0.05);
    h.observe({}, 0.5);
    h.observe({}, 10);
    const out = r.render();
    assert.equal(sample(out, 't_seconds_bucket', 'le="0.1"'), 1);
    assert.equal(sample(out, 't_seconds_bucket', 'le="1"'), 2);
    assert.equal(sample(out, 't_seconds_bucket', 'le="+Inf"'), 3);
    assert.equal(sample(out, 't_seconds_count'), 3);
    assert.equal(sample(out, 't_seconds_sum'), 10.55);
  });

  test('an untouched unlabelled counter still publishes its zero', () => {
    // An absent series is not a zero: `increase(x[5m]) > 0` cannot fire on one, `absent()` reads it
    // as a dead target, and a panel says "No data" for a healthy farm. Failure counters spend most
    // of their life at zero, which is exactly when they have to be visible.
    const r = new Registry();
    r.register(new Counter('t_failures_total', 'x'));
    r.register(new Histogram('t_untouched_seconds', 'x', [], [0.1]));
    const out = r.render();
    assert.equal(sample(out, 't_failures_total'), 0);
    assert.equal(sample(out, 't_untouched_seconds_count'), 0);
    assert.equal(sample(out, 't_untouched_seconds_bucket', 'le="+Inf"'), 0);
  });

  test('a gauge reset drops series rather than freezing them at their last value', () => {
    const r = new Registry();
    const gg = r.register(new Gauge('t_devices', 'x', ['state']));
    gg.set({ state: 'READY' }, 2);
    assert.equal(sample(r.render(), 't_devices', 'state="READY"'), 2);
    gg.reset();
    assert.equal(sample(r.render(), 't_devices', 'state="READY"'), undefined);
  });

  test('an invalid metric or label name is refused at construction', () => {
    assert.throws(() => new Counter('9lives', 'x'), /valid Prometheus metric name/);
    assert.throws(() => new Counter('ok_total', 'x', ['not-a-label']), /valid Prometheus label name/);
    // `le` is the bucket boundary; a histogram that also carried it as a user label would emit two
    // `le` keys in one label set and the scrape would be rejected outright.
    assert.throws(() => new Histogram('t_h', 'x', ['le']), /cannot take a label called "le"/);
  });

  test('registering the same name twice is refused', () => {
    const r = new Registry();
    r.register(new Counter('t_dup_total', 'x'));
    assert.throws(() => r.register(new Counter('t_dup_total', 'x')), /already registered/);
  });

  test('unbounded labels are capped and counted rather than growing forever', () => {
    const r = new Registry();
    const c = r.register(new Counter('t_unbounded_total', 'x', ['id']));
    for (let i = 0; i < 2_100; i++) c.inc({ id: `id-${i}` });
    assert.equal(r.totalDroppedSeries(), 100);
    assert.equal(lines(r.render(), 't_unbounded_total').length, 2_000);
  });

  test('a missing label is an empty value, not a throw', () => {
    const r = new Registry();
    const c = r.register(new Counter('t_partial_total', 'x', ['a', 'b']));
    // Instrumentation must never be able to fail the request it is measuring.
    assert.doesNotThrow(() => c.inc({ a: 'x' }));
    assert.equal(sample(r.render(), 't_partial_total', 'b=""'), 1);
  });
});

// ---------------------------------------------------------------- collectors

const REGION = 'metrics-test';
let hostId: string;
let orgId: string;

before(async () => {
  await withSystem(async (c) => {
    await c.query(
      `INSERT INTO regions (code,name) VALUES ($1,'Metrics Test') ON CONFLICT (code) DO NOTHING`,
      [REGION],
    );
    orgId = (await c.query(
      `INSERT INTO orgs (slug,name,max_concurrent) VALUES ('metrics-org','Metrics',50) RETURNING id`,
    )).rows[0].id;
    hostId = (await c.query(
      `INSERT INTO hosts (region,hostname,state,protocol_version,cores,memory_mb,endpoint,last_heartbeat_at)
       VALUES ($1,'metrics-test-host','UP',2,16,32768,'wss://metrics.example:8443', now()) RETURNING id`,
      [REGION],
    )).rows[0].id;
  });
});

after(async () => {
  await withSystem(async (c) => {
    await c.query('DELETE FROM sessions WHERE region = $1', [REGION]);
    await c.query('DELETE FROM devices WHERE region = $1', [REGION]);
    await c.query('DELETE FROM hosts WHERE region = $1', [REGION]);
    await c.query('DELETE FROM orgs WHERE id = $1', [orgId]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await closePools();
});

/** `age` is how long the device has been in `state` — `updated_at` is what the CLEANING gauge
 *  measures from, because that is the column every transition into CLEANING sets. */
const seedDevice = (state: string, age = '0 seconds') =>
  withSystem(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, local_id, updated_at)
       VALUES ($1,$2,'android','cuttlefish','cf_x86_64','17',$3,$4, now() - $5::interval)
       RETURNING id`,
      [hostId, REGION, state, `metrics-${randomUUID()}`, age],
    );
    return rows[0].id as string;
  });

describe('fleet collectors', () => {
  test('the enum lists in metrics.ts still match the ones in the database', async () => {
    const read = (name: string) =>
      withSystem(async (c) => {
        const { rows } = await c.query<{ v: string }>(
          `SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = $1 ORDER BY e.enumsortorder`,
          [name],
        );
        return rows.map((r) => r.v);
      });
    // If a migration adds a state and this list is not updated, the new state is still REPORTED —
    // it just never gets a zero-filled series, so an alert on it is silent until the first row
    // exists. That is the failure this catches.
    assert.deepEqual(await read('device_state'), [...DEVICE_STATES]);
    assert.deepEqual(await read('session_state'), [...SESSION_STATES]);
    assert.deepEqual(await read('host_state'), [...HOST_STATES]);
  });

  test('every device state gets a series even at zero', async () => {
    await seedDevice('READY');
    await collectFleet();
    const out = registry.render();
    for (const state of DEVICE_STATES) {
      assert.equal(
        typeof sample(out, 'mfarm_devices', `state="${state}",region="${REGION}"`),
        'number',
        `mfarm_devices{state="${state}"} is missing — an alert on it would never fire`,
      );
    }
    assert.equal(sample(out, 'mfarm_devices', `state="READY",region="${REGION}"`), 1);
    assert.equal(sample(out, 'mfarm_devices', `state="CLEANING",region="${REGION}"`), 0);
  });

  test('a device stuck in CLEANING shows up as reset-restore age', async () => {
    await seedDevice('CLEANING', '10 minutes');
    await collectFleet();
    const out = registry.render();
    assert.equal(sample(out, 'mfarm_devices', `state="CLEANING",region="${REGION}"`), 1);
    // The reset-failure signal: a restore that never completed leaves the device here by design,
    // because a device must never return to READY without a worker confirming it.
    assert.ok((sample(out, 'mfarm_device_cleaning_age_seconds_max') ?? 0) >= 600);
  });

  test('queue depth and queue age are reported', async () => {
    await withSystem((c) =>
      c.query(
        `INSERT INTO sessions (org_id, region, state, created_at)
         VALUES ($1,$2,'QUEUED', now() - interval '5 minutes')`,
        [orgId, REGION],
      ),
    );
    await collectFleet();
    const out = registry.render();
    assert.ok((sample(out, 'mfarm_sessions', 'state="QUEUED"') ?? 0) >= 1);
    assert.ok((sample(out, 'mfarm_session_queue_oldest_seconds') ?? 0) >= 300);
    for (const state of SESSION_STATES) {
      assert.equal(typeof sample(out, 'mfarm_sessions', `state="${state}"`), 'number');
    }
  });

  test('a host reports the TIMESTAMP of its last heartbeat, not an age', async () => {
    await collectFleet();
    const out = registry.render();
    const beat = sample(out, 'mfarm_host_last_heartbeat_timestamp_seconds', 'hostname="metrics-test-host"');
    assert.ok(beat && beat > 1_600_000_000, `expected a unix timestamp, got ${beat}`);
    // A timestamp is what makes "registered and never heartbeated" expressible as 0, which an age
    // gauge has to invent a number for.
    assert.ok((sample(out, 'mfarm_hosts', 'state="UP"') ?? 0) >= 1);
    for (const state of HOST_STATES) {
      assert.equal(typeof sample(out, 'mfarm_hosts', `state="${state}"`), 'number');
    }
  });

  test('runtime metrics need no database', () => {
    collectRuntime();
    const out = registry.render();
    assert.equal(sample(out, 'mfarm_build_info'), 1);
    assert.ok((sample(out, 'mfarm_process_resident_memory_bytes') ?? 0) > 0);
    assert.equal(typeof sample(out, 'mfarm_pg_pool_connections', 'pool="app",state="waiting"'), 'number');
  });

  test('a healthy scrape reports no scrape error and still carries the fleet gauges', async () => {
    const before = sample(await scrape(), 'mfarm_scrape_errors_total') ?? 0;
    const body = await scrape();
    // Nothing is broken here, so the counter must NOT have moved — the point of the assertion is
    // that a healthy scrape does not report an error, since the error path is what keeps a database
    // outage from turning into "target down" and hiding every other signal with it.
    assert.equal(sample(body, 'mfarm_scrape_errors_total'), before);
    assert.ok((sample(body, 'mfarm_scrape_total') ?? 0) >= 2);
    assert.match(body, /# TYPE mfarm_devices gauge/);
  });
});

// ---------------------------------------------------------------- the listener

describe('metrics listener', () => {
  test('serves /metrics on its own port and refuses everything else', async () => {
    const s = await startMetricsServer({ host: '127.0.0.1', port: 0 });
    try {
      const base = `http://127.0.0.1:${s.port}`;
      const ok = await fetch(`${base}/metrics`);
      assert.equal(ok.status, 200);
      assert.match(ok.headers.get('content-type') ?? '', /^text\/plain; version=0\.0\.4/);
      assert.match(await ok.text(), /# TYPE mfarm_devices gauge/);

      // No API routes are reachable here. That is the entire reason it is a separate server:
      // a hook or a PUBLIC_PATHS entry on the main listener cannot expose this data by mistake.
      assert.equal((await fetch(`${base}/v1/devices`)).status, 404);
      assert.equal((await fetch(`${base}/metrics`, { method: 'POST' })).status, 405);
      assert.equal((await fetch(`${base}/health`)).status, 200);
    } finally {
      await s.close();
    }
  });

  test('a token, when set, is required — and a wrong one gets no hint', async () => {
    const s = await startMetricsServer({ host: '127.0.0.1', port: 0, token: 'scrape-secret' });
    try {
      const base = `http://127.0.0.1:${s.port}`;
      const anon = await fetch(`${base}/metrics`);
      assert.equal(anon.status, 401);
      assert.equal(anon.headers.get('www-authenticate'), null, 'a challenge invites guessing');

      assert.equal((await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
      assert.equal((await fetch(`${base}/metrics`, { headers: { authorization: 'scrape-secret' } })).status, 401);
      assert.equal(
        (await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer scrape-secret' } })).status,
        200,
      );
      // Liveness stays open: a probe on this port must not need the scrape credential.
      assert.equal((await fetch(`${base}/health`)).status, 200);
    } finally {
      await s.close();
    }
  });

  test('close() releases the port', async () => {
    const s = await startMetricsServer({ host: '127.0.0.1', port: 0 });
    const port = s.port;
    await s.close();
    const again = await startMetricsServer({ host: '127.0.0.1', port });
    assert.equal(again.port, port);
    await again.close();
  });
});
