/**
 * The app library: parsing an APK, storing it once, and getting it onto a device.
 *
 * Two halves, and they fail in different ways. The parser half is pure and exact — it either reads
 * the bytes Android writes or it does not — so it is tested against a generated APK that varies the
 * things real builds vary (pool encoding, compression, resource-id-only attributes).
 *
 * The install half is a THREE-PARTY protocol — tenant, control plane, worker — and every
 * interesting failure in it is an authorization one that returns a perfectly ordinary-looking
 * success to the wrong party. So those tests are mostly about who is refused: a worker reading a
 * build it holds no install for, a worker finishing another host's install, a tenant installing
 * onto a device it does not hold, and a tenant editing the outcome of its own install.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'apps-test-registration-secret';
// The host sweep is throttled in production so a fleet-wide write does not ride every reaper tick.
// This suite calls `reap()` directly and asserts on the sweep, so it opts out of the throttle
// rather than sleeping fifteen seconds to observe it.
process.env.HOST_SWEEP_MIN_INTERVAL_MS = '0';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set before the server — and therefore `loadConfig()` — is imported, because configuration is
// parsed once per process and cached.
const storeDir = join(tmpdir(), `mfarm-apps-test-${randomUUID()}`);
process.env.APP_STORE_DIR = storeDir;

import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, withTenant, closePools } from '../src/db.ts';
import { createApiKey, generateWorkerToken } from '../src/auth.ts';
import { reap } from '../src/allocator.ts';
import { ApkParseError, parseManifest, readApkMetadata } from '../src/apk.ts';
import { AppStore } from '../src/appstore.ts';
import { buildApk, buildManifest, buildNonApkZip, buildZip } from './fixtures/apk.ts';

const REGION = 'apps-test';
const APK_TYPE = 'application/vnd.android.package-archive';

let app: FastifyInstance;
let orgA: string, orgB: string;
let keyA: string, keyB: string;
let hostA: string, hostB: string;
let workerA: string, workerB: string;
let deviceA: string, deviceB: string;
let tmpFiles: string;

const auth = (k: string) => ({ authorization: `Bearer ${k}` });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A device that can take a session AND declares it can install apps. */
async function seedDevice(hostId: string, caps: string[]): Promise<string> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, capabilities, local_id)
       VALUES ($1,$2,'android','cuttlefish','cf_x86_64','17','READY',$3::jsonb,$4)
       RETURNING id`,
      [hostId, REGION, JSON.stringify(caps), `apps-${randomUUID()}`],
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
       VALUES ($1,$2,'UP',2,16,65536,'wss://apps-test.example:8443',$3,$4, now()) RETURNING id`,
      [REGION, hostname, token.prefix, token.hash],
    );
    return rows[0].id;
  });
  return { hostId, token: token.plaintext };
}

/** Allocate a live session on a specific device by taking every other device out of the pool. */
async function liveSession(key: string, deviceId: string): Promise<{ sessionId: string }> {
  await withSystem((c) =>
    c.query(`UPDATE devices SET state = 'OFFLINE' WHERE region = $1 AND id <> $2 AND state = 'READY'`,
      [REGION, deviceId]));
  const res = await app.inject({
    method: 'POST', url: '/v1/sessions', headers: auth(key),
    payload: { region: REGION, platform: 'android' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const sessionId = res.json().session.id as string;
  assert.equal(res.json().session.deviceId, deviceId);
  return { sessionId };
}

async function uploadApk(key: string, apk: Buffer, filename = 'app.apk') {
  return app.inject({
    method: 'POST', url: `/v1/apps?filename=${encodeURIComponent(filename)}`,
    headers: { ...auth(key), 'content-type': APK_TYPE },
    payload: apk,
  });
}

const clearFleet = () => withSystem(async (c) => {
  await c.query('DELETE FROM app_actions');
  await c.query('DELETE FROM idempotency_keys');
  await c.query('DELETE FROM metering_events');
  await c.query('DELETE FROM sessions');
  await c.query(`UPDATE devices SET state = 'READY' WHERE region = $1`, [REGION]);
});

before(async () => {
  tmpFiles = await mkdtemp(join(tmpdir(), 'mfarm-apk-'));
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Apps Test') ON CONFLICT DO NOTHING`, [REGION]);
    orgA = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent) VALUES ('apps-a','A',50) RETURNING id`)).rows[0].id;
    orgB = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent) VALUES ('apps-b','B',50) RETURNING id`)).rows[0].id;
  });
  keyA = (await createApiKey(orgA)).plaintext;
  keyB = (await createApiKey(orgB)).plaintext;
  ({ hostId: hostA, token: workerA } = await seedHost('apps-test-host-a'));
  ({ hostId: hostB, token: workerB } = await seedHost('apps-test-host-b'));
  deviceA = await seedDevice(hostA, ['screen-stream', 'input-datachannel', 'snapshot-reset', 'app-install']);
  deviceB = await seedDevice(hostB, ['screen-stream', 'input-datachannel', 'snapshot-reset', 'app-install']);
  app = await buildServer({ logger: false });
});

after(async () => {
  await app.close();
  await withSystem(async (c) => {
    await c.query('DELETE FROM app_actions');
    await c.query('DELETE FROM app_builds WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM metering_events');
    await c.query('DELETE FROM sessions');
    await c.query('DELETE FROM devices WHERE region = $1', [REGION]);
    await c.query('DELETE FROM api_keys WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM hosts WHERE region = $1', [REGION]);
    await c.query('DELETE FROM orgs WHERE id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await closePools();
  await rm(tmpFiles, { recursive: true, force: true });
  await rm(storeDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the parser

describe('APK metadata', () => {
  const write = async (apk: Buffer): Promise<string> => {
    const path = join(tmpFiles, `${randomUUID()}.apk`);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, apk);
    return path;
  };

  test('reads package, version and label from a deflated UTF-16 manifest', async () => {
    const meta = await readApkMetadata(await write(buildApk({
      packageName: 'dev.mfarm.sample', versionCode: 71, versionName: '2.0.1', minSdk: 29, label: 'Sample',
    })));
    assert.deepEqual(meta, {
      packageName: 'dev.mfarm.sample', versionCode: 71, versionName: '2.0.1', minSdk: 29, label: 'Sample',
    });
  });

  test('reads a UTF-8 string pool', async () => {
    // aapt2 emits either encoding depending on version and content, and the two length prefixes are
    // completely different shapes — a parser that handles one silently mangles the other.
    const meta = await readApkMetadata(await write(buildApk({ utf8: true, packageName: 'dev.mfarm.utf8' })));
    assert.equal(meta.packageName, 'dev.mfarm.utf8');
    assert.equal(meta.versionName, '1.4.2');
  });

  test('reads a STORED (uncompressed) manifest', async () => {
    const meta = await readApkMetadata(await write(buildApk({ stored: true, packageName: 'dev.mfarm.stored' })));
    assert.equal(meta.packageName, 'dev.mfarm.stored');
  });

  test('falls back to resource ids when attribute names are absent', async () => {
    // The case a name-only parser fails on: an obfuscated manifest identifies android:versionCode
    // by 0x0101021b and leaves the name string empty.
    const meta = await readApkMetadata(await write(buildApk({
      anonymousAttributes: true, versionCode: 900, minSdk: 31, label: 'Anon',
    })));
    assert.equal(meta.versionCode, 900);
    assert.equal(meta.minSdk, 31);
    assert.equal(meta.label, 'Anon');
  });

  test('a versionName that is a resource reference is null, not a hex id', async () => {
    // `@string/version` cannot be resolved without resources.arsc. Reporting `@0x7f0e0042` would put
    // a number nobody can use into the library and into the database column.
    const meta = await readApkMetadata(await write(buildApk({ versionNameAsReference: true })));
    assert.equal(meta.versionName, null);
    assert.equal(meta.versionCode, 42);
  });

  test('the local header extra field is used, not the central one', async () => {
    // Every zipaligned APK pads the LOCAL extra field and leaves the central one at zero. A reader
    // that computes the data offset from the central value lands three bytes into the deflate
    // stream — which is why the fixture pads by default and this test names it explicitly.
    const apk = buildZip([
      { name: 'AndroidManifest.xml', content: buildManifest({ packageName: 'dev.mfarm.aligned' }), localExtra: 7 },
    ]);
    assert.equal((await readApkMetadata(await write(apk))).packageName, 'dev.mfarm.aligned');
  });

  test('a zip with no manifest is refused as not an APK', async () => {
    await assert.rejects(readApkMetadata(await write(buildNonApkZip())), ApkParseError);
  });

  test('random bytes are refused', async () => {
    await assert.rejects(readApkMetadata(await write(Buffer.alloc(4096, 0x41))), ApkParseError);
  });

  test('a plain-text manifest is refused with a message that says why', () => {
    assert.throws(
      () => parseManifest(Buffer.from('<manifest package="com.example"/>')),
      (e: Error) => e instanceof ApkParseError && /binary XML/.test(e.message),
    );
  });
});

// ---------------------------------------------------------------- the store

describe('blob store', () => {
  test('the same bytes are stored once and reported as not created the second time', async () => {
    const store = new AppStore(join(tmpFiles, 'store'));
    const bytes = buildApk({ packageName: 'dev.mfarm.dedupe' });
    const { Readable } = await import('node:stream');

    const first = await store.put(Readable.from(bytes), 10_000_000);
    const second = await store.put(Readable.from(bytes), 10_000_000);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.sha256, sha(bytes));
    assert.equal(second.path, first.path);
  });

  test('an oversized stream is refused without writing it out', async () => {
    const store = new AppStore(join(tmpFiles, 'store-limit'));
    const { Readable } = await import('node:stream');
    await assert.rejects(
      store.put(Readable.from(Buffer.alloc(5_000)), 1_000),
      /exceeds the 1000 byte limit/,
    );
    // The temp file is cleaned up rather than left behind: this path is reachable by anyone with a
    // key, so a leak here is a disk-fill primitive.
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(join(tmpFiles, 'store-limit', 'tmp')), []);
  });
});

// ---------------------------------------------------------------- upload

describe('upload', () => {
  test('an upload returns parsed metadata and is deduplicated on the second try', async () => {
    const apk = buildApk({ packageName: 'dev.mfarm.upload', versionCode: 5, versionName: '0.5.0' });

    const first = await uploadApk(keyA, apk, 'release-v5.apk');
    assert.equal(first.statusCode, 201, first.body);
    const created = first.json().app;
    assert.equal(created.packageName, 'dev.mfarm.upload');
    assert.equal(created.versionCode, 5);
    assert.equal(created.sha256, sha(apk));
    assert.equal(created.sizeBytes, apk.length);
    assert.equal(created.filename, 'release-v5.apk');

    // 200, not 201, and the SAME id: a CI job that uploads on every run must not fill the library
    // with copies, and must not have to check first.
    const again = await uploadApk(keyA, apk, 'release-v5.apk');
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().deduplicated, true);
    assert.equal(again.json().app.id, created.id);
  });

  test('different bytes are a different build', async () => {
    const a = await uploadApk(keyA, buildApk({ packageName: 'dev.mfarm.two', padBytes: 32 }));
    const b = await uploadApk(keyA, buildApk({ packageName: 'dev.mfarm.two', padBytes: 64 }));
    assert.notEqual(a.json().app.id, b.json().app.id);
    assert.notEqual(a.json().app.sha256, b.json().app.sha256);
  });

  test('two orgs uploading identical bytes get their own rows', async () => {
    // One blob on disk, two rows. Deleting one org's build must never remove the other's, which is
    // why the uniqueness is (org_id, sha256) rather than sha256 alone.
    const apk = buildApk({ packageName: 'dev.mfarm.shared' });
    const a = await uploadApk(keyA, apk);
    const b = await uploadApk(keyB, apk);
    assert.equal(a.statusCode, 201);
    assert.equal(b.statusCode, 201);
    assert.notEqual(a.json().app.id, b.json().app.id);
    assert.equal(a.json().app.sha256, b.json().app.sha256);
  });

  test('a JSON body is refused with the content-type it should have used', async () => {
    // The mistake every first attempt makes. Failing inside the stream pipeline would answer 500,
    // which tells the caller to report a bug rather than to change one header.
    const res = await app.inject({
      method: 'POST', url: '/v1/apps',
      headers: { ...auth(keyA), 'content-type': 'application/json' },
      payload: { packageName: 'dev.mfarm.wrong' },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /vnd\.android\.package-archive/);
  });

  test('a non-APK upload is a 400 that says what was wrong', async () => {
    const res = await uploadApk(keyA, buildNonApkZip());
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /AndroidManifest/);
  });

  test('an org cannot see another org\'s builds', async () => {
    const mine = (await uploadApk(keyA, buildApk({ packageName: 'dev.mfarm.private' }))).json().app;

    const list = await app.inject({ method: 'GET', url: '/v1/apps', headers: auth(keyB) });
    assert.equal(list.statusCode, 200);
    assert.ok(!list.json().apps.some((a: { id: string }) => a.id === mine.id));

    // 404 rather than 403: confirming the id exists is itself a disclosure.
    const direct = await app.inject({ method: 'GET', url: `/v1/apps/${mine.id}`, headers: auth(keyB) });
    assert.equal(direct.statusCode, 404);
  });

  test('a worker token cannot upload or list', async () => {
    const upload = await uploadApk(workerA, buildApk());
    assert.equal(upload.statusCode, 403);
    const list = await app.inject({ method: 'GET', url: '/v1/apps', headers: auth(workerA) });
    assert.equal(list.statusCode, 403);
  });
});

// ---------------------------------------------------------------- install

describe('install', () => {
  let appId: string;
  let apk: Buffer;

  before(async () => {
    apk = buildApk({ packageName: 'dev.mfarm.installable', versionCode: 9 });
    appId = (await uploadApk(keyA, apk)).json().app.id;
  });

  test('a request against a live session queues a job and reaches only that host', async () => {
    await clearFleet();
    const { sessionId } = await liveSession(keyA, deviceA);

    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/app-actions`,
      headers: auth(keyA), payload: { appId },
    });
    // 202, not 201: nothing has touched the device yet, and saying "created" would imply it had.
    assert.equal(res.statusCode, 202, res.body);
    const action = res.json().action;
    assert.equal(action.state, 'PENDING');
    assert.equal(action.kind, 'install');
    assert.equal(action.deviceId, deviceA);

    const beatA = await app.inject({ method: 'POST', url: '/v1/workers/heartbeat', headers: auth(workerA) });
    const offered = beatA.json().actions;
    assert.equal(offered.length, 1);
    assert.equal(offered[0].actionId, action.id);
    assert.equal(offered[0].kind, 'install');
    assert.equal(offered[0].sha256, sha(apk));
    assert.equal(offered[0].packageName, 'dev.mfarm.installable');

    // The other host is told nothing at all. A worker must never learn about, let alone act on,
    // another host's devices.
    const beatB = await app.inject({ method: 'POST', url: '/v1/workers/heartbeat', headers: auth(workerB) });
    assert.deepEqual(beatB.json().actions, []);
  });

  test('a worker downloads the blob only for an install it holds', async () => {
    await clearFleet();
    const { sessionId } = await liveSession(keyA, deviceA);
    const actionId = (await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/app-actions`, headers: auth(keyA), payload: { appId },
    })).json().action.id;

    const ok = await app.inject({
      method: 'GET', url: `/v1/apps/${appId}/blob?actionId=${actionId}`, headers: auth(workerA),
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['content-type'], APK_TYPE);
    assert.equal(sha(ok.rawPayload), sha(apk));

    // No install id: the id IS the authorization, so without it the only question left would be
    // "is this a valid worker", which any host in the fleet can answer.
    const bare = await app.inject({ method: 'GET', url: `/v1/apps/${appId}/blob`, headers: auth(workerA) });
    assert.equal(bare.statusCode, 400);

    // A different host holding a valid worker token: the install is not for its hardware.
    const wrongHost = await app.inject({
      method: 'GET', url: `/v1/apps/${appId}/blob?actionId=${actionId}`, headers: auth(workerB),
    });
    assert.equal(wrongHost.statusCode, 404);

    // And a tenant key, which is the credential most likely to be tried here by mistake.
    const tenant = await app.inject({
      method: 'GET', url: `/v1/apps/${appId}/blob?actionId=${actionId}`, headers: auth(keyA),
    });
    assert.equal(tenant.statusCode, 403);
  });

  test('the worker reports the outcome, and only the owning host can', async () => {
    await clearFleet();
    const { sessionId } = await liveSession(keyA, deviceA);
    const actionId = (await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/app-actions`, headers: auth(keyA), payload: { appId },
    })).json().action.id;

    // Another host claiming this install is refused, and told nothing about why.
    const impostor = await app.inject({
      method: 'POST', url: '/v1/workers/events', headers: auth(workerB),
      payload: { actions: [{ actionId, ok: true }] },
    });
    assert.deepEqual(impostor.json().actions, [{ actionId, accepted: false }]);
    const stillPending = await app.inject({ method: 'GET', url: `/v1/app-actions/${actionId}`, headers: auth(keyA) });
    assert.equal(stillPending.json().action.state, 'PENDING');

    const real = await app.inject({
      method: 'POST', url: '/v1/workers/events', headers: auth(workerA),
      payload: { actions: [{ actionId, ok: true }] },
    });
    assert.deepEqual(real.json().actions, [{ actionId, accepted: true }]);
    const done = await app.inject({ method: 'GET', url: `/v1/app-actions/${actionId}`, headers: auth(keyA) });
    assert.equal(done.json().action.state, 'DONE');
    assert.equal(done.json().action.error, null);

    // A re-sent confirmation — the shape a worker produces when its flush response was lost — is
    // absorbed rather than applied twice.
    const replay = await app.inject({
      method: 'POST', url: '/v1/workers/events', headers: auth(workerA),
      payload: { actions: [{ actionId, ok: false, error: 'nonsense' }] },
    });
    assert.deepEqual(replay.json().actions, [{ actionId, accepted: false }]);
    const unchanged = await app.inject({ method: 'GET', url: `/v1/app-actions/${actionId}`, headers: auth(keyA) });
    assert.equal(unchanged.json().action.state, 'DONE');

    // Finished, so the blob is no longer readable by the host that just installed it.
    const after = await app.inject({
      method: 'GET', url: `/v1/apps/${appId}/blob?actionId=${actionId}`, headers: auth(workerA),
    });
    assert.equal(after.statusCode, 404);
  });

  test('a failure is recorded with the reason the tenant needs to read', async () => {
    await clearFleet();
    const { sessionId } = await liveSession(keyA, deviceA);
    const actionId = (await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/app-actions`, headers: auth(keyA), payload: { appId },
    })).json().action.id;

    await app.inject({
      method: 'POST', url: '/v1/workers/events', headers: auth(workerA),
      payload: { actions: [{ actionId, ok: false, error: 'adb: Failure [INSTALL_FAILED_NO_MATCHING_ABIS]' }] },
    });
    const res = await app.inject({ method: 'GET', url: `/v1/app-actions/${actionId}`, headers: auth(keyA) });
    assert.equal(res.json().action.state, 'FAILED');
    assert.match(res.json().action.error, /INSTALL_FAILED_NO_MATCHING_ABIS/);
  });

  test('installing another org\'s build is a 404', async () => {
    await clearFleet();
    const { sessionId } = await liveSession(keyA, deviceA);
    const theirs = (await uploadApk(keyB, buildApk({ packageName: 'dev.mfarm.theirs' }))).json().app.id;
    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/app-actions`, headers: auth(keyA), payload: { appId: theirs },
    });
    assert.equal(res.statusCode, 404);
  });

  test('installing onto another org\'s session is a 404', async () => {
    await clearFleet();
    const { sessionId } = await liveSession(keyA, deviceA);
    // orgB holds no session at all; RLS makes orgA's look like it does not exist.
    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/app-actions`, headers: auth(keyB), payload: { appId },
    });
    assert.equal(res.statusCode, 404);
  });

  test('a session that holds no device is refused, not queued', async () => {
    await clearFleet();
    const { sessionId } = await liveSession(keyA, deviceA);
    await app.inject({ method: 'DELETE', url: `/v1/sessions/${sessionId}`, headers: auth(keyA) });

    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/app-actions`, headers: auth(keyA), payload: { appId },
    });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error.message, /holds no device/);
  });

  test('a device that does not declare app-install is refused', async () => {
    await clearFleet();
    // Same required capabilities, minus the one this feature needs. Queueing a job for it would
    // leave a PENDING install no worker can ever complete.
    const dumb = await seedDevice(hostA, ['screen-stream', 'input-datachannel', 'snapshot-reset']);
    try {
      const { sessionId } = await liveSession(keyA, dumb);
      const res = await app.inject({
        method: 'POST', url: `/v1/sessions/${sessionId}/app-actions`, headers: auth(keyA), payload: { appId },
      });
      assert.equal(res.statusCode, 409);
      assert.match(res.json().error.message, /app-install/);
    } finally {
      await withSystem((c) => c.query('DELETE FROM sessions WHERE device_id = $1', [dumb]));
      await withSystem((c) => c.query('DELETE FROM devices WHERE id = $1', [dumb]));
    }
  });

  test('an install for a reallocated device is never offered', async () => {
    await clearFleet();
    const { sessionId } = await liveSession(keyA, deviceA);
    const actionId = (await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/app-actions`, headers: auth(keyA), payload: { appId },
    })).json().action.id;

    // The fence moves when the device is handed to someone else. The session row may still read
    // ACTIVE for as long as it takes the reaper to notice, so the fence is the check that holds.
    await withSystem((c) => c.query('UPDATE devices SET fence = fence + 1 WHERE id = $1', [deviceA]));

    const beat = await app.inject({ method: 'POST', url: '/v1/workers/heartbeat', headers: auth(workerA) });
    assert.deepEqual(beat.json().actions.map((i: { actionId: string }) => i.actionId).filter((i: string) => i === actionId), []);
  });

  test('the reaper fails installs the session left behind', async () => {
    await clearFleet();
    const { sessionId } = await liveSession(keyA, deviceA);
    const actionId = (await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/app-actions`, headers: auth(keyA), payload: { appId },
    })).json().action.id;
    await app.inject({ method: 'DELETE', url: `/v1/sessions/${sessionId}`, headers: auth(keyA) });

    // Without this sweep the row sits PENDING forever: the heartbeat will not offer an install for
    // a dead session, so nothing finishes it and a caller polling it waits on a job no worker will
    // ever hear about.
    const { installsOrphaned } = await reap();
    assert.ok(installsOrphaned >= 1);
    const res = await app.inject({ method: 'GET', url: `/v1/app-actions/${actionId}`, headers: auth(keyA) });
    assert.equal(res.json().action.state, 'FAILED');
    assert.match(res.json().action.error, /session ended/i);
  });

  test('a silent host is quarantined, and re-registering brings its devices back', async () => {
    await clearFleet();
    // The failure this closes: `quarantine_host` has existed since migration 003 with no caller, so
    // a worker that died left its devices READY and the allocator kept handing them out. On a farm
    // of two that is half the capacity turned into a trap.
    await withSystem((c) =>
      c.query(`UPDATE hosts SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [hostA]));

    const { hostsQuarantined } = await reap();
    assert.ok(hostsQuarantined >= 1);

    const after = await withSystem(async (c) => (await c.query(
      `SELECT h.state AS host, d.state AS device, h.quarantine_source AS source
         FROM hosts h JOIN devices d ON d.host_id = h.id WHERE h.id = $1`,
      [hostA],
    )).rows[0]);
    assert.equal(after.host, 'QUARANTINED');
    assert.equal(after.device, 'QUARANTINED');
    assert.equal(after.source, 'reaper', 'stamped so the host can beat its way back (migration 016)');

    // And the recovery, which is the half that makes the sweep safe rather than a one-way door: the
    // worker comes back and re-registers, and its devices must be schedulable again.
    const reg = await app.inject({
      method: 'POST', url: '/v1/workers/register',
      headers: { 'x-worker-registration-token': 'apps-test-registration-secret' },
      payload: {
        protocolVersion: 2, hostname: 'apps-test-host-a', region: REGION,
        endpoint: 'wss://apps-test.example:8443', cores: 16, memoryMb: 65536,
        capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset', 'app-install'],
        devices: [{
          localId: (await withSystem(async (c) => (await c.query(
            'SELECT local_id FROM devices WHERE host_id = $1 LIMIT 1', [hostA])).rows[0].local_id)),
          platform: 'android', tier: 'cuttlefish', model: 'cf_x86_64', osVersion: '17',
          capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset', 'app-install'],
          adbSerial: '0.0.0.0:6520',
        }],
      },
    });
    assert.equal(reg.statusCode, 201, reg.body);
    const recovered = await withSystem(async (c) => (await c.query(
      'SELECT state FROM devices WHERE host_id = $1 LIMIT 1', [hostA])).rows[0].state);
    assert.equal(recovered, 'READY');

    // Registration ISSUES A NEW CREDENTIAL, so the fixture's token is now stale. Adopted here
    // rather than left for a later test to fail on with a puzzling 401.
    workerA = reg.json().workerToken;
    await withSystem((c) => c.query(
      `UPDATE hosts SET last_heartbeat_at = now() WHERE region = $1`, [REGION]));
  });

  test('a host that goes silent and comes back recovers on its own heartbeat', async () => {
    await clearFleet();
    // The whole path, through the real reaper rather than a hand-written quarantine: this is the
    // sequence a host reboot produces, and before migration 016 it ended with a farm reporting
    // `available: 0` until a human deleted the agent's state file. The worker never re-registers
    // here, deliberately — that is exactly what a healthy agent does not do.
    await withSystem((c) =>
      c.query(`UPDATE hosts SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [hostA]));
    const { hostsQuarantined } = await reap();
    assert.ok(hostsQuarantined >= 1);

    const beat = await app.inject({
      method: 'POST', url: '/v1/workers/heartbeat', headers: auth(workerA),
    });
    assert.equal(beat.statusCode, 200, beat.body);
    assert.equal(beat.json().hostState, 'UP');

    const back = await withSystem(async (c) => (await c.query(
      `SELECT h.state AS host, h.quarantine_source AS source, d.state AS device
         FROM hosts h JOIN devices d ON d.host_id = h.id WHERE h.id = $1`,
      [hostA],
    )).rows[0]);
    assert.equal(back.host, 'UP');
    assert.equal(back.source, null);
    assert.equal(back.device, 'READY', 'and the farm has its capacity back without anyone logging in');
  });

  test('a tenant cannot mark its own action DONE', async () => {
    await clearFleet();
    const { sessionId } = await liveSession(keyA, deviceA);
    const actionId = (await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/app-actions`, headers: auth(keyA), payload: { appId },
    })).json().action.id;

    // There is no route that does this, so the test goes at the grant directly. 001 grants
    // UPDATE on every future table by default, which would have made "the install succeeded" a
    // thing any API key could assert about its own device.
    await assert.rejects(
      withTenant(orgA, (c) => c.query(`UPDATE app_actions SET state = 'DONE' WHERE id = $1`, [actionId])),
      /permission denied/i,
    );
  });
});
