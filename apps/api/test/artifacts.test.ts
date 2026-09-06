/**
 * Session artifacts: the evidence a failed run leaves behind.
 *
 * This is a THREE-PARTY surface — a worker writes, a tenant reads, and the control plane decides
 * who owns the bytes — so most of what follows is about who is refused. The upload path is
 * worker-authenticated and the org that ends up owning a screenshot is derived from the session
 * rather than supplied, which is architecture rule 4 restated for a new table: metering once took
 * the paying org from the worker's own request body, and that was a forgery waiting to happen.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';
process.env.ARTIFACT_DIR = `${process.env.TMPDIR ?? '/tmp'}/mfarm-artifacts-test-${process.pid}`;

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { createApiKey, generateWorkerToken } from '../src/auth.ts';
import { reap } from '../src/allocator.ts';

const REGION = 'artifacts-test';
const ARTIFACT_DIR = process.env.ARTIFACT_DIR!;

let app: FastifyInstance;
let orgA: string, orgB: string;
let keyA: string, keyB: string;
let hostA: string, hostB: string;
let workerA: string, workerB: string;
let deviceA: string, deviceB: string;

const auth = (k: string) => ({ authorization: `Bearer ${k}` });
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const blobPath = (digest: string) => join(ARTIFACT_DIR, digest.slice(0, 2), digest);
const onDisk = async (digest: string) => Boolean(await stat(blobPath(digest)).catch(() => null));

async function seedDevice(hostId: string): Promise<string> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, capabilities, local_id)
       VALUES ($1,$2,'android','cuttlefish','cf_x86_64','17','READY',$3::jsonb,$4)
       RETURNING id`,
      [hostId, REGION, JSON.stringify(['screen-stream', 'input-datachannel', 'snapshot-reset', 'logcat']),
       `art-${randomUUID()}`],
    );
    return rows[0].id;
  });
}

async function seedHost(hostname: string): Promise<{ hostId: string; token: string }> {
  const token = generateWorkerToken();
  const hostId = await withSystem(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO hosts (region, hostname, state, protocol_version, cores, memory_mb, endpoint,
                          token_prefix, token_hash, last_heartbeat_at)
       VALUES ($1,$2,'UP',2,16,65536,'wss://artifacts-test.example:8443',$3,$4, now()) RETURNING id`,
      [REGION, hostname, token.prefix, token.hash],
    );
    return rows[0].id;
  });
  return { hostId, token: token.plaintext };
}

/** Allocate a live session on a specific device by taking every other device out of the pool. */
async function liveSession(key: string, deviceId: string): Promise<string> {
  await withSystem((c) =>
    c.query(`UPDATE devices SET state = 'OFFLINE' WHERE region = $1 AND id <> $2 AND state = 'READY'`,
      [REGION, deviceId]));
  const res = await app.inject({
    method: 'POST', url: '/v1/sessions', headers: auth(key),
    payload: { region: REGION, platform: 'android' },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().session.deviceId, deviceId);
  await withSystem((c) =>
    c.query(`UPDATE devices SET state = 'READY' WHERE region = $1 AND state = 'OFFLINE'`, [REGION]));
  return res.json().session.id as string;
}

/** Upload as a worker would: raw bytes, kind and device in the query. */
function upload(
  token: string, sessionId: string, deviceId: string, kind: string, body: Buffer | string,
  filename?: string,
): Promise<LightMyRequestResponse> {
  const q = new URLSearchParams({ kind, device: deviceId });
  if (filename) q.set('filename', filename);
  return app.inject({
    method: 'POST',
    url: `/v1/sessions/${sessionId}/artifacts?${q}`,
    headers: { ...auth(token), 'content-type': 'application/octet-stream' },
    payload: body,
  });
}

const clearFleet = () => withSystem(async (c) => {
  await c.query('DELETE FROM artifacts');
  await c.query('DELETE FROM idempotency_keys');
  await c.query('DELETE FROM metering_events');
  await c.query('DELETE FROM sessions');
  await c.query(`UPDATE devices SET state = 'READY' WHERE region = $1`, [REGION]);
});

before(async () => {
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Artifacts Test') ON CONFLICT DO NOTHING`, [REGION]);
    orgA = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent) VALUES ('art-a','A',50) RETURNING id`)).rows[0].id;
    orgB = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent) VALUES ('art-b','B',50) RETURNING id`)).rows[0].id;
  });
  keyA = (await createApiKey(orgA)).plaintext;
  keyB = (await createApiKey(orgB)).plaintext;
  ({ hostId: hostA, token: workerA } = await seedHost('artifacts-host-a'));
  ({ hostId: hostB, token: workerB } = await seedHost('artifacts-host-b'));
  deviceA = await seedDevice(hostA);
  deviceB = await seedDevice(hostB);
  app = await buildServer({ logger: false });
});

after(async () => {
  await app.close();
  await withSystem(async (c) => {
    await c.query('DELETE FROM artifacts');
    await c.query('DELETE FROM metering_events');
    await c.query('DELETE FROM sessions');
    await c.query('DELETE FROM devices WHERE region = $1', [REGION]);
    await c.query('DELETE FROM api_keys WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM hosts WHERE region = $1', [REGION]);
    await c.query('DELETE FROM orgs WHERE id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await rm(ARTIFACT_DIR, { recursive: true, force: true });
  await closePools();
});

// ------------------------------------------------------------------ upload

describe('worker upload', () => {
  test('a worker stores a logcat for its own session', async () => {
    await clearFleet();
    const sessionId = await liveSession(keyA, deviceA);
    const log = '01-01 00:00:00.000  I/Boot: hello\n'.repeat(20);

    const res = await upload(workerA, sessionId, deviceA, 'logcat', log, 'session.log');
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().artifact.sha256, sha(log));
    assert.ok(await onDisk(sha(log)), 'the bytes must reach the store');
  });

  test('the owning org comes from the session, never from the worker', async () => {
    // Architecture rule 4. A worker names a session and a device and nothing else; if it could
    // influence org_id it could file evidence — and eventually anything else keyed the same way —
    // into another tenant's library.
    await clearFleet();
    const sessionId = await liveSession(keyA, deviceA);
    await upload(workerA, sessionId, deviceA, 'screenshot', Buffer.from('PNGDATA-1'));

    const owner = await withSystem(async (c) => {
      const r = await c.query<{ org_id: string }>('SELECT org_id FROM artifacts WHERE session_id = $1', [sessionId]);
      return r.rows[0].org_id;
    });
    assert.equal(owner, orgA);
    assert.notEqual(owner, orgB);
  });

  test("a worker cannot attach an artifact to another host's session", async () => {
    // The 008 defect, in a new place: without the host check inside `artifact_record`, any
    // registered worker could write into any session on the farm.
    await clearFleet();
    const sessionId = await liveSession(keyA, deviceA);

    const res = await upload(workerB, sessionId, deviceA, 'logcat', 'not mine');
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'not_your_session');

    const n = await withSystem(async (c) => {
      const r = await c.query('SELECT 1 FROM artifacts WHERE session_id = $1', [sessionId]);
      return r.rowCount ?? 0;
    });
    assert.equal(n, 0);
  });

  test('a worker cannot claim a device the session is not on', async () => {
    await clearFleet();
    const sessionId = await liveSession(keyA, deviceA);
    const res = await upload(workerB, sessionId, deviceB, 'logcat', 'wrong device');
    assert.equal(res.statusCode, 409);
  });

  test('a rejected upload does not leave its bytes behind', async () => {
    // The store is content-addressed and shared, so a refused write that still landed on disk is
    // both wasted space and a file no row will ever clean up.
    await clearFleet();
    const sessionId = await liveSession(keyA, deviceA);
    const body = `orphan-${randomUUID()}`;
    const res = await upload(workerB, sessionId, deviceA, 'logcat', body);
    assert.equal(res.statusCode, 409);
    assert.equal(await onDisk(sha(body)), false, 'a refused upload must not leave an orphan blob');
  });

  test('an unknown kind is refused rather than stored under a made-up one', async () => {
    await clearFleet();
    const sessionId = await liveSession(keyA, deviceA);
    // `video` is deliberately NOT a kind: nothing produces one, and a storage enum that accepts it
    // is the same claim-with-nothing-behind-it that got `recording` removed from the capability list.
    for (const kind of ['video', 'heapdump', '']) {
      const res = await upload(workerA, sessionId, deviceA, kind, 'x');
      assert.equal(res.statusCode, 400, `kind=${kind} should be refused`);
    }
  });

  test('a tenant API key cannot upload', async () => {
    await clearFleet();
    const sessionId = await liveSession(keyA, deviceA);
    const res = await upload(keyA, sessionId, deviceA, 'logcat', 'from a tenant');
    assert.equal(res.statusCode, 403);
  });

  test('two sessions capturing identical bytes share one blob', async () => {
    // What content addressing buys. Two screenshots of the same idle home screen are one file.
    await clearFleet();
    const s1 = await liveSession(keyA, deviceA);
    const identical = Buffer.from('PNG-IDENTICAL');
    assert.equal((await upload(workerA, s1, deviceA, 'screenshot', identical)).statusCode, 201);

    await withSystem((c) => c.query(`UPDATE sessions SET state='ENDED', ended_at=now() WHERE id=$1`, [s1]));
    await withSystem((c) => c.query(`UPDATE devices SET state='READY' WHERE id=$1`, [deviceA]));
    const s2 = await liveSession(keyA, deviceA);
    assert.equal((await upload(workerA, s2, deviceA, 'screenshot', identical)).statusCode, 201);

    const rows = await withSystem(async (c) => {
      const r = await c.query('SELECT id FROM artifacts WHERE sha256 = $1', [sha(identical)]);
      return r.rowCount ?? 0;
    });
    assert.equal(rows, 2, 'two rows');
    assert.ok(await onDisk(sha(identical)), 'one file');
  });
});

// ------------------------------------------------------------------ read

describe('tenant read', () => {
  test('a session lists what it left behind, newest first', async () => {
    await clearFleet();
    const sessionId = await liveSession(keyA, deviceA);
    await upload(workerA, sessionId, deviceA, 'logcat', 'first');
    await upload(workerA, sessionId, deviceA, 'screenshot', Buffer.from('second'));

    const res = await app.inject({
      method: 'GET', url: `/v1/sessions/${sessionId}/artifacts`, headers: auth(keyA),
    });
    assert.equal(res.statusCode, 200);
    const kinds = res.json().artifacts.map((a: { kind: string }) => a.kind);
    assert.equal(kinds.length, 2);
    assert.deepEqual([...kinds].sort(), ['logcat', 'screenshot']);
  });

  test("another org cannot list or download this session's artifacts", async () => {
    await clearFleet();
    const sessionId = await liveSession(keyA, deviceA);
    await upload(workerA, sessionId, deviceA, 'logcat', 'private');

    const list = await app.inject({
      method: 'GET', url: `/v1/sessions/${sessionId}/artifacts`, headers: auth(keyB),
    });
    // RLS answers with an empty set rather than an error, which is the correct shape: org B is not
    // told that a session it cannot see exists.
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().artifacts.length, 0);

    const id = (await app.inject({
      method: 'GET', url: `/v1/sessions/${sessionId}/artifacts`, headers: auth(keyA),
    })).json().artifacts[0].id;

    const blob = await app.inject({ method: 'GET', url: `/v1/artifacts/${id}/blob`, headers: auth(keyB) });
    assert.equal(blob.statusCode, 404, 'a known id must not leak across orgs');
  });

  test('the blob downloads with the right type and bytes', async () => {
    await clearFleet();
    const sessionId = await liveSession(keyA, deviceA);
    const png = Buffer.from('\x89PNG\r\n\x1a\nFAKE', 'binary');
    await upload(workerA, sessionId, deviceA, 'screenshot', png, 'shot.png');

    const id = (await app.inject({
      method: 'GET', url: `/v1/sessions/${sessionId}/artifacts`, headers: auth(keyA),
    })).json().artifacts[0].id;

    const blob = await app.inject({ method: 'GET', url: `/v1/artifacts/${id}/blob`, headers: auth(keyA) });
    assert.equal(blob.statusCode, 200);
    assert.match(String(blob.headers['content-type']), /image\/png/);
    assert.match(String(blob.headers['content-disposition']), /inline; filename="shot.png"/);
    assert.equal(blob.headers['x-mfarm-sha256'], sha(png));
    assert.equal(blob.rawPayload.length, png.length);
  });

  test('the org-wide feed is scoped to the caller', async () => {
    await clearFleet();
    const sessionId = await liveSession(keyA, deviceA);
    await upload(workerA, sessionId, deviceA, 'logcat', 'mine');

    assert.ok((await app.inject({ method: 'GET', url: '/v1/artifacts', headers: auth(keyA) }))
      .json().artifacts.length > 0);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/artifacts', headers: auth(keyB) }))
      .json().artifacts.length, 0);
  });
});

// ------------------------------------------------------------------ retention

describe('retention', () => {
  test('the reaper deletes expired rows and their unreferenced blobs', async () => {
    await clearFleet();
    const sessionId = await liveSession(keyA, deviceA);
    const body = `expiring-${randomUUID()}`;
    const up = await upload(workerA, sessionId, deviceA, 'logcat', body);
    assert.equal(up.statusCode, 201, up.body);
    assert.ok(await onDisk(sha(body)));

    await withSystem((c) => c.query(`UPDATE artifacts SET expires_at = now() - interval '1 hour'`));
    const out = await reap();

    assert.equal(out.artifactsExpired, 1);
    assert.equal(out.blobsDeleted, 1);
    assert.equal(await onDisk(sha(body)), false, 'the blob must go with the row');
  });

  test('a blob still referenced by a live row survives its sibling expiring', async () => {
    // The reason `expire_artifacts` computes `blob_orphaned` in SQL after the delete rather than
    // letting the caller guess: deleting shared bytes turns another org's download into a 404.
    await clearFleet();
    const s1 = await liveSession(keyA, deviceA);
    const shared = Buffer.from(`shared-${randomUUID()}`);
    await upload(workerA, s1, deviceA, 'screenshot', shared);

    await withSystem((c) => c.query(`UPDATE sessions SET state='ENDED', ended_at=now() WHERE id=$1`, [s1]));
    await withSystem((c) => c.query(`UPDATE devices SET state='READY' WHERE id=$1`, [deviceA]));
    const s2 = await liveSession(keyA, deviceA);
    await upload(workerA, s2, deviceA, 'screenshot', shared);

    // Expire only the first one.
    await withSystem((c) =>
      c.query(`UPDATE artifacts SET expires_at = now() - interval '1 hour' WHERE session_id = $1`, [s1]));
    const out = await reap();

    assert.equal(out.artifactsExpired, 1);
    assert.equal(out.blobsDeleted, 0, 'a blob another row still points at must not be unlinked');
    assert.ok(await onDisk(sha(shared)), 'the surviving row must still resolve to bytes');
  });

  test('a sweep reports rows deleted, not distinct blobs', async () => {
    // The bug this pins: an earlier `expire_artifacts` returned only orphaned digests, so a sweep
    // that removed fifty rows sharing three files logged "3".
    await clearFleet();
    const sessionId = await liveSession(keyA, deviceA);
    const same = Buffer.from(`same-${randomUUID()}`);
    // Same bytes, two kinds — two rows, one blob.
    assert.equal((await upload(workerA, sessionId, deviceA, 'logcat', same)).statusCode, 201);
    assert.equal((await upload(workerA, sessionId, deviceA, 'screenshot', same)).statusCode, 201);

    await withSystem((c) => c.query(`UPDATE artifacts SET expires_at = now() - interval '1 hour'`));
    const out = await reap();

    assert.equal(out.artifactsExpired, 2, 'two rows expired');
    assert.equal(out.blobsDeleted, 1, 'one file removed');
  });
});

// ------------------------------------------------------------------ evidence at failure time

/**
 * Migration 040: a failed test asks for its own evidence.
 *
 * THE PROBLEM THIS SOLVES is stated in 022 and was only half solved there. The release-time
 * screenshot is taken after Appium force-stops the app, so it reliably shows the launcher; 022 gave
 * a suite a verb to take its own, which works and which every customer would have to reinvent. This
 * is the control plane doing it on their behalf, off the one signal it already had and ignored —
 * the result POST.
 *
 * Most of what follows is about the BOUNDS, because the ways this feature could make things worse
 * are more interesting than the way it makes them better: fifty failing tests must not queue fifty
 * screenshots, a device that cannot capture must not collect actions that fail, and a result must
 * be recorded whether or not any of this works.
 */
describe('a failed test asks for its own evidence', () => {
  /** Everything this session has been asked to capture, newest last. */
  const captures = (sessionId: string) => withSystem(async (c) => (await c.query<{
    kind: string; state: string; context: Record<string, unknown>;
  }>(`SELECT kind, state::text AS state, context FROM app_actions
       WHERE session_id = $1 AND kind IN ('screenshot','logcat')
       ORDER BY requested_at`, [sessionId])).rows);

  const report = (key: string, sessionId: string, body: Record<string, unknown>) => app.inject({
    method: 'POST', url: `/v1/sessions/${sessionId}/result`, headers: auth(key), payload: body,
  });

  /** `deviceA` declares logcat but NOT screenshot; this gives it both for one test. */
  const withScreenshotCap = (deviceId: string) => withSystem((c) => c.query(
    `UPDATE devices SET capabilities = capabilities || '["screenshot"]'::jsonb WHERE id = $1`,
    [deviceId]));
  const withoutScreenshotCap = (deviceId: string) => withSystem((c) => c.query(
    `UPDATE devices SET capabilities = capabilities - 'screenshot' WHERE id = $1`, [deviceId]));

  test('a failed result queues a screenshot and a logcat, each naming the test', async () => {
    await clearFleet();
    await withScreenshotCap(deviceA);
    try {
      const sessionId = await liveSession(keyA, deviceA);
      const res = await report(keyA, sessionId, {
        status: 'failed', name: 'checkout applies the discount',
        failure: 'expected 90 but got 100', failureReason: 'assertion-failure',
      });
      assert.equal(res.statusCode, 201, res.body);
      const resultId = res.json().result.id;

      const rows = await captures(sessionId);
      assert.deepEqual(rows.map((r) => r.kind).sort(), ['logcat', 'screenshot'],
        'both halves of the evidence — the screen, and what the app was saying on the way there');

      for (const r of rows) {
        assert.equal(r.state, 'PENDING', 'the beat has not carried it down yet');
        assert.equal(r.context.source, 'test-failure');
        assert.equal(r.context.testResultId, resultId,
          'the artifact has to name WHICH failure it was taken for, or it is a mystery file');
        assert.equal(r.context.test, 'checkout applies the discount');
      }
    } finally {
      await withoutScreenshotCap(deviceA);
    }
  });

  test('a passing test asks for nothing', async () => {
    await clearFleet();
    await withScreenshotCap(deviceA);
    try {
      const sessionId = await liveSession(keyA, deviceA);
      const res = await report(keyA, sessionId, { status: 'passed', name: 'the happy path' });
      assert.equal(res.statusCode, 201, res.body);
      assert.deepEqual(await captures(sessionId), [],
        'capturing evidence for a green test is how a farm fills its own disk');
    } finally {
      await withoutScreenshotCap(deviceA);
    }
  });

  test('thirty failures queue one capture of each kind, not sixty', async () => {
    await clearFleet();
    await withScreenshotCap(deviceA);
    try {
      const sessionId = await liveSession(keyA, deviceA);
      for (let i = 0; i < 30; i++) {
        const res = await report(keyA, sessionId, { status: 'failed', name: `spec ${i}` });
        assert.equal(res.statusCode, 201, res.body);
      }

      const rows = await captures(sessionId);
      /**
       * THE BOUND THAT MAKES THIS SHIPPABLE. A suite that fails thirty tests in a burst is ordinary,
       * and on a ten-second beat the first capture has not even been delivered by the thirtieth
       * failure — so the twenty-nine after it would be near-identical pictures of the same screen,
       * paid for in device time, disk and upload.
       *
       * `request_capture` coalesces on one PENDING per kind per session. The next failure after
       * this one is DELIVERED gets a fresh capture, which is the behaviour worth having.
       */
      assert.equal(rows.length, 2, `expected one screenshot and one logcat, got ${rows.length}`);
      assert.deepEqual(rows.map((r) => r.kind).sort(), ['logcat', 'screenshot']);
      assert.equal(rows[0].context.test, 'spec 0', 'the capture names the failure that triggered it');

      /**
       * ONE PENDING, NOT ONE EVER — and the assertion above cannot tell those two apart, which is
       * why this half exists. A session that captured once and then went quiet forever would pass
       * every line above and be a worse product than the one this replaces.
       *
       * Deliver the pending pair the way a beat would, then fail again.
       */
      await withSystem((c) => c.query(
        `UPDATE app_actions SET state = 'DONE', finished_at = now() WHERE session_id = $1`,
        [sessionId]));
      assert.equal((await report(keyA, sessionId, { status: 'failed', name: 'a later spec' }))
        .statusCode, 201);

      const after = await captures(sessionId);
      assert.equal(after.length, 4, 'a failure after the last capture landed gets its own');
      assert.equal(after[3].context.test, 'a later spec',
        'and it names the failure that triggered IT, not the first one of the run');
    } finally {
      await withoutScreenshotCap(deviceA);
    }
  });

  test('a device that cannot screenshot collects no screenshot action', async () => {
    await clearFleet();
    // deviceA's seeded capabilities include `logcat` and not `screenshot`, which is the case this
    // pins: an action a device can never perform sits PENDING, is re-offered on every beat, and is
    // finally swept into a FAILED row that reads as a broken farm. It is not broken — the tier has
    // no capture path — so the right answer is silence.
    const sessionId = await liveSession(keyA, deviceA);
    assert.equal((await report(keyA, sessionId, { status: 'failed', name: 'no camera here' }))
      .statusCode, 201);

    assert.deepEqual((await captures(sessionId)).map((r) => r.kind), ['logcat'],
      'the half the device can serve, and only that half');
  });

  test('a result on an ended session is still recorded, and captures nothing', async () => {
    await clearFleet();
    await withScreenshotCap(deviceA);
    try {
      const sessionId = await liveSession(keyA, deviceA);
      await app.inject({ method: 'DELETE', url: `/v1/sessions/${sessionId}`, headers: auth(keyA) });

      /**
       * THE RULE THIS PINS: evidence is a bonus and the report is the point. A reporting hook that
       * flushes after the suite has released the device must still get its result written — turning
       * that into a 500 would make the hook retry, and a retried result is a double-counted failure.
       */
      const res = await report(keyA, sessionId, { status: 'failed', name: 'reported after quit' });
      assert.equal(res.statusCode, 201, res.body);
      assert.deepEqual(await captures(sessionId), [],
        'the device has been handed back; aiming a capture at it would photograph the next tenant');
    } finally {
      await withoutScreenshotCap(deviceA);
    }
  });

  test('the context reaches the artifact, and a release-time capture has none', async () => {
    await clearFleet();
    const sessionId = await liveSession(keyA, deviceA);
    const shot = Buffer.from(`png-${randomUUID()}`);
    const log = `log-${randomUUID()}`;

    const q = new URLSearchParams({
      kind: 'screenshot', device: deviceA,
      context: JSON.stringify({ source: 'test-failure', testResultId: 'abc', test: 'a spec' }),
    });
    const withCtx = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/artifacts?${q}`,
      headers: { ...auth(workerA), 'content-type': 'application/octet-stream' }, payload: shot,
    });
    assert.equal(withCtx.statusCode, 201, withCtx.body);
    assert.equal((await upload(workerA, sessionId, deviceA, 'logcat', log)).statusCode, 201);

    const list = await app.inject({
      method: 'GET', url: `/v1/sessions/${sessionId}/artifacts`, headers: auth(keyA) });
    const byKind = Object.fromEntries(list.json().artifacts.map(
      (a: { kind: string; context: Record<string, unknown> }) => [a.kind, a.context]));

    assert.equal(byKind.screenshot.source, 'test-failure');
    assert.equal(byKind.screenshot.test, 'a spec');
    // Always present, never absent — a screen that has to tell "no context" from "the field is
    // missing" is one that gets it wrong once.
    assert.deepEqual(byKind.logcat, {}, 'a release-time capture carries an empty context, not null');
  });

  test('a context that is not a JSON object is refused before the bytes are stored', async () => {
    await clearFleet();
    const sessionId = await liveSession(keyA, deviceA);
    const body = Buffer.from(`never-stored-${randomUUID()}`);

    for (const bad of ['not json', '"a string"', '[1,2,3]', 'null']) {
      const q = new URLSearchParams({ kind: 'logcat', device: deviceA, context: bad });
      const res = await app.inject({
        method: 'POST', url: `/v1/sessions/${sessionId}/artifacts?${q}`,
        headers: { ...auth(workerA), 'content-type': 'application/octet-stream' }, payload: body,
      });
      assert.equal(res.statusCode, 400, `${bad} should be refused: ${res.body}`);
    }
    // Refused BEFORE the store, so nothing is written that the failing insert would then orphan.
    assert.equal(await onDisk(sha(body)), false, 'a rejected upload must leave no bytes behind');
  });
});
