/**
 * App install, worker half — end to end against the REAL control plane.
 *
 * The point of running this against the real API rather than a stub is that the install path is a
 * conversation between three components that each believe something about the other two: the
 * control plane decides which host may see a job, the worker decides whether to trust the bytes it
 * downloads, and the device does the only irreversible part. A stub would test this file's idea of
 * that protocol.
 *
 * What is faked here is exactly one thing — the device — because `adb install` needs an Android on
 * the other end. Everything between the tenant's request and `installApp(path)` is real, including
 * the HTTP download and the digest check.
 */
process.env.WORKER_REGISTRATION_TOKEN = 'install-test-registration-secret';
process.env.RATE_LIMIT_MAX = '10000';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const storeDir = join(tmpdir(), `mfarm-install-store-${randomUUID()}`);
process.env.APP_STORE_DIR = storeDir;

import type { FastifyInstance } from 'fastify';
import { buildServer } from '@mfarm/api/server';
import { withSystem, closePools } from '@mfarm/api/db';
import { createApiKey } from '@mfarm/api/auth';
import { Agent } from '../src/agent.ts';
import type { DeviceBackend, DeviceControl, DeviceHealth, DeviceInfo } from '../src/device.ts';
// The APK generator lives with the parser it was written against. Imported by path rather than
// duplicated: a second encoder would drift, and then two suites would agree with each other and
// with no real build.
import { buildApk } from '../../../apps/api/test/fixtures/apk.ts';

const REGION = 'install-test';

let app: FastifyInstance;
let baseUrl: string;
let orgId: string;
let tenantKey: string;
let workDir: string;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A device tier that cannot sideload — an iOS simulator, a locked-down handset.
 *
 * It does not define `installApp` AT ALL, rather than defining one that throws, because that is the
 * distinction the whole optional-method design rests on: the agent decides what this host can do by
 * asking whether the method exists. Subclassing to add the method (rather than inheriting it and
 * deleting it) is the only way to express that in a class — `delete this.installApp` is a no-op
 * against a prototype method, which is a mistake this test made once and would have hidden the very
 * thing it checks.
 */
class NoInstallDevice implements DeviceControl {
  readonly info: DeviceInfo;

  constructor(localId: string) {
    this.info = {
      localId, platform: 'android', tier: 'cuttlefish', model: 'fake', osVersion: '17',
      capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset'],
      screen: { width: 720, height: 1280, density: 320 },
      adbSerial: `0.0.0.0:adb-${localId}`,
    };
  }
  async start() {}
  async stop() {}
  async resetToSnapshot() {}
  async tap() {}
  async swipe() {}
  async key() {}
  async text() {}
  async health(): Promise<DeviceHealth> { return { status: 'healthy', inputLatencyMs: 1 }; }
}

/** A device that records what it was asked to install, and can be told to fail. */
class FakeDevice extends NoInstallDevice {
  readonly installed: Array<{ path: string; bytes: Buffer }> = [];
  readonly launched: string[] = [];
  readonly uninstalled: string[] = [];
  failNextInstall?: string;
  failNextLaunch?: string;

  constructor(localId: string) {
    super(localId);
    this.info.capabilities = ['screen-stream', 'input-datachannel', 'snapshot-reset', 'app-install', 'screenshot'];
  }

  /** A real PNG header, so the control plane's content sniffing sees what it expects. */
  async screenshot() {
    return { bytes: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), contentType: 'image/png' };
  }

  async installApp(apkPath: string) {
    if (this.failNextInstall) {
      const reason = this.failNextInstall;
      this.failNextInstall = undefined;
      throw new Error(reason);
    }
    // Reads the file, so a test can assert the worker handed over the bytes the tenant uploaded and
    // not merely a path that exists.
    this.installed.push({ path: apkPath, bytes: await readFile(apkPath) });
  }

  async launchApp(packageName: string) {
    if (this.failNextLaunch) {
      const reason = this.failNextLaunch;
      this.failNextLaunch = undefined;
      throw new Error(reason);
    }
    this.launched.push(packageName);
  }

  async uninstallApp(packageName: string) {
    this.uninstalled.push(packageName);
  }
}

function backendFor(control: DeviceControl): DeviceBackend {
  return { control, media: { async endpoint() { return null; } } };
}

function makeAgent(backends: DeviceBackend[], hostname: string) {
  return new Agent({
    controlPlaneUrl: baseUrl,
    registrationToken: 'install-test-registration-secret',
    hostname, region: REGION,
    endpoint: 'wss://install-test.example:8080',
    devices: backends,
    statePath: join(workDir, `${hostname}.json`),
    appCacheDir: join(workDir, `${hostname}-apps`),
    cores: 8, memoryMb: 16384,
  });
}

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${tenantKey}`, ...(init.headers ?? {}) },
  });

/**
 * Read a response once.
 *
 * `assert.equal(res.status, 200, await res.text())` reads the body to build a message it usually
 * does not need, and every later `res.json()` then throws "Body is unusable" — an assertion helper
 * that breaks the thing it is checking.
 */
async function json<T>(res: Response, expect: number): Promise<T> {
  const text = await res.text();
  assert.equal(res.status, expect, text);
  return JSON.parse(text) as T;
}

async function uploadApk(apk: Buffer): Promise<string> {
  const res = await api('/v1/apps?filename=test.apk', {
    method: 'POST',
    headers: { 'content-type': 'application/vnd.android.package-archive' },
    body: apk,
  });
  return (await json<{ app: { id: string } }>(res, 201)).app.id;
}

/** Allocate the one READY device in this region and return the session. */
async function allocate(): Promise<string> {
  const res = await api('/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ region: REGION, platform: 'android' }),
  });
  return (await json<{ session: { id: string } }>(res, 201)).session.id;
}

async function requestAction(sessionId: string, appId: string, kind = 'install'): Promise<string> {
  const res = await api(`/v1/sessions/${sessionId}/app-actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId, kind }),
  });
  return (await json<{ action: { id: string } }>(res, 202)).action.id;
}

/**
 * Poll until the install leaves PENDING.
 *
 * The agent deliberately does NOT await `runRequestedInstalls` inside the heartbeat — an install is
 * a download plus a dexopt pass, and a beat that waited for it would look like a dead host — so the
 * only honest way to observe the outcome is the same way a user does.
 */
async function settled(actionId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api(`/v1/app-actions/${actionId}`);
    const { action } = await json<{ action: { state: string; error: string | null } }>(res, 200);
    if (action.state !== 'PENDING') return action;
    if (Date.now() > deadline) return action;
    await sleep(50);
  }
}

/** One device only, so allocation is deterministic. */
const clearFleet = () => withSystem(async (c) => {
  await c.query('DELETE FROM app_actions');
  await c.query('DELETE FROM metering_events WHERE org_id = $1', [orgId]);
  await c.query('DELETE FROM sessions WHERE org_id = $1', [orgId]);
  await c.query('DELETE FROM devices WHERE region = $1', [REGION]);
});

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mfarm-install-'));
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Install Test') ON CONFLICT DO NOTHING`, [REGION]);
    orgId = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent)
                            VALUES ('install-org','Install',50) RETURNING id`)).rows[0].id;
  });
  tenantKey = (await createApiKey(orgId)).plaintext;
  app = await buildServer({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  await app.close();
  await withSystem(async (c) => {
    await c.query('DELETE FROM app_actions');
    await c.query('DELETE FROM app_builds WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM metering_events WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM sessions WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM devices WHERE region = $1', [REGION]);
    await c.query('DELETE FROM api_keys WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM hosts WHERE region = $1', [REGION]);
    await c.query('DELETE FROM orgs WHERE id = $1', [orgId]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await closePools();
  await rm(workDir, { recursive: true, force: true });
  await rm(storeDir, { recursive: true, force: true });
});

describe('install over the heartbeat', () => {
  test('a queued install reaches the device with the exact bytes that were uploaded', async () => {
    await clearFleet();
    const device = new FakeDevice(`cf-${randomUUID().slice(0, 8)}`);
    const agent = makeAgent([backendFor(device)], `install-${randomUUID().slice(0, 8)}`);
    await agent.start();

    const apk = buildApk({ packageName: 'dev.mfarm.e2e', versionCode: 3 });
    const appId = await uploadApk(apk);
    const actionId = await requestAction(await allocate(), appId);

    // One beat is the whole delivery mechanism.
    await agent.heartbeat();
    const action = await settled(actionId);

    assert.equal(action.state, 'DONE', action.error ?? '');
    assert.equal(device.installed.length, 1);
    // The digest, not the length: a truncated download of the right size is the failure this check
    // exists for, and comparing bytes proves the whole path end to end.
    assert.equal(sha(device.installed[0]!.bytes), sha(apk));
    await agent.shutdown();
  });

  test('a device that cannot install is refused at request time, never queued', async () => {
    await clearFleet();
    // Declares no `app-install`, so the control plane refuses at request time — the install never
    // becomes a job. That refusal is the feature: a queued job nobody can run is a poll that never
    // ends, and the person waiting has nothing to read.
    const device = new NoInstallDevice(`no-${randomUUID().slice(0, 8)}`);
    const agent = makeAgent([backendFor(device)], `noinstall-${randomUUID().slice(0, 8)}`);
    await agent.start();

    const appId = await uploadApk(buildApk({ packageName: 'dev.mfarm.nope' }));
    const sessionId = await allocate();
    const res = await api(`/v1/sessions/${sessionId}/app-actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId }),
    });
    const body = await json<{ error: { message: string } }>(res, 409);
    assert.match(body.error.message, /app-install/);
    await agent.shutdown();
  });

  test('a device failure is reported verbatim, not swallowed', async () => {
    await clearFleet();
    const device = new FakeDevice(`fail-${randomUUID().slice(0, 8)}`);
    device.failNextInstall = 'adb install failed: Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]';
    const agent = makeAgent([backendFor(device)], `fail-${randomUUID().slice(0, 8)}`);
    await agent.start();

    const appId = await uploadApk(buildApk({ packageName: 'dev.mfarm.full' }));
    const actionId = await requestAction(await allocate(), appId);
    await agent.heartbeat();
    const action = await settled(actionId);

    assert.equal(action.state, 'FAILED');
    // adb's own words survive to the tenant. A category ("install failed") would send whoever reads
    // it to us rather than to the reason.
    assert.match(action.error ?? '', /INSUFFICIENT_STORAGE/);
    await agent.shutdown();
  });

  test('a finished install is not performed twice when the beat re-offers it', async () => {
    await clearFleet();
    const device = new FakeDevice(`once-${randomUUID().slice(0, 8)}`);
    const agent = makeAgent([backendFor(device)], `once-${randomUUID().slice(0, 8)}`);
    await agent.start();

    const appId = await uploadApk(buildApk({ packageName: 'dev.mfarm.once' }));
    const actionId = await requestAction(await allocate(), appId);
    await agent.heartbeat();
    assert.equal((await settled(actionId)).state, 'DONE');

    // The control plane stops offering it once it is INSTALLED; the in-flight guard covers the
    // window before that. Together they are what make re-offering on every beat safe.
    await agent.heartbeat();
    await agent.heartbeat();
    await sleep(200);
    assert.equal(device.installed.length, 1);
    await agent.shutdown();
  });

  test('the same build is downloaded once and reused from the cache', async () => {
    await clearFleet();
    const device = new FakeDevice(`cache-${randomUUID().slice(0, 8)}`);
    const hostname = `cache-${randomUUID().slice(0, 8)}`;
    const agent = makeAgent([backendFor(device)], hostname);
    await agent.start();

    const apk = buildApk({ packageName: 'dev.mfarm.cache' });
    const appId = await uploadApk(apk);

    const first = await requestAction(await allocate(), appId);
    await agent.heartbeat();
    assert.equal((await settled(first)).state, 'DONE');

    // Same build, second session on the same host. On a two-device farm this is the common case —
    // install the build, run, reset, install it again — and re-downloading it every time is the
    // difference between an install that starts instantly and one that waits on a transfer.
    await withSystem((c) => c.query('DELETE FROM sessions WHERE org_id = $1', [orgId]));
    await withSystem((c) => c.query(`UPDATE devices SET state = 'READY' WHERE region = $1`, [REGION]));
    const second = await requestAction(await allocate(), appId);
    await agent.heartbeat();
    assert.equal((await settled(second)).state, 'DONE');

    const cached = await readdir(join(workDir, `${hostname}-apps`));
    assert.deepEqual(cached, [`${sha(apk)}.apk`], 'one file, named for its digest, and no leftover .part');
    assert.equal(device.installed.length, 2);
    await agent.shutdown();
  });

  test('a cached file whose digest no longer matches is re-fetched, not installed', async () => {
    await clearFleet();
    const device = new FakeDevice(`tamper-${randomUUID().slice(0, 8)}`);
    const hostname = `tamper-${randomUUID().slice(0, 8)}`;
    const cacheDir = join(workDir, `${hostname}-apps`);
    const agent = makeAgent([backendFor(device)], hostname);
    await agent.start();

    const apk = buildApk({ packageName: 'dev.mfarm.tamper' });
    const appId = await uploadApk(apk);

    // Whatever wrote this — a killed process mid-write, anything else on the host with access to
    // the cache directory — the agent must not hand it to adb because the name looks right.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, `${sha(apk)}.apk`), Buffer.from('not the app you asked for'));

    const actionId = await requestAction(await allocate(), appId);
    await agent.heartbeat();
    assert.equal((await settled(actionId)).state, 'DONE');
    assert.equal(sha(device.installed[0]!.bytes), sha(apk), 'the tampered cache entry must not be installed');
    await agent.shutdown();
  });

  test('launch and uninstall ride the same pipeline, carrying only the package name', async () => {
    await clearFleet();
    const device = new FakeDevice(`verbs-${randomUUID().slice(0, 8)}`);
    const agent = makeAgent([backendFor(device)], `verbs-${randomUUID().slice(0, 8)}`);
    await agent.start();

    const appId = await uploadApk(buildApk({ packageName: 'dev.mfarm.verbs' }));
    const sessionId = await allocate();

    const launch = await requestAction(sessionId, appId, 'launch');
    await agent.heartbeat();
    assert.equal((await settled(launch)).state, 'DONE');
    assert.deepEqual(device.launched, ['dev.mfarm.verbs']);
    // No bytes moved: a launch that downloaded the build would be doing minutes of work to send an
    // intent, and would need an authorisation it should not have.
    assert.equal(device.installed.length, 0);

    const uninstall = await requestAction(sessionId, appId, 'uninstall');
    await agent.heartbeat();
    assert.equal((await settled(uninstall)).state, 'DONE');
    assert.deepEqual(device.uninstalled, ['dev.mfarm.verbs']);
    await agent.shutdown();
  });

  test('a pending launch is not a licence to download the build', async () => {
    await clearFleet();
    const device = new FakeDevice(`blob-${randomUUID().slice(0, 8)}`);
    const hostname = `blob-${randomUUID().slice(0, 8)}`;
    const agent = makeAgent([backendFor(device)], hostname);
    const state = await agent.start();

    const appId = await uploadApk(buildApk({ packageName: 'dev.mfarm.noblob' }));
    const actionId = await requestAction(await allocate(), appId, 'launch');

    // The worker's own credential, against its own pending action — and still refused, because the
    // blob route requires kind = 'install'. Without that clause a launch would widen a package-name
    // job into read access to the build's contents.
    const res = await fetch(`${baseUrl}/v1/apps/${appId}/blob?actionId=${actionId}`, {
      headers: { authorization: `Bearer ${state.workerToken}` },
    });
    assert.equal(res.status, 404);
    await res.text();
    await agent.shutdown();
  });

  test('a launch failure carries the reason a missing launcher activity gives', async () => {
    await clearFleet();
    const device = new FakeDevice(`nolaunch-${randomUUID().slice(0, 8)}`);
    device.failNextLaunch = 'could not launch: ** No activities found to run, monkey aborted.';
    const agent = makeAgent([backendFor(device)], `nolaunch-${randomUUID().slice(0, 8)}`);
    await agent.start();

    const appId = await uploadApk(buildApk({ packageName: 'dev.mfarm.service' }));
    const actionId = await requestAction(await allocate(), appId, 'launch');
    await agent.heartbeat();
    const action = await settled(actionId);

    assert.equal(action.state, 'FAILED');
    // The case a farm hits constantly: a service-only or test APK has no launcher activity, and
    // monkey reports it on stdout with a ZERO exit code.
    assert.match(action.error ?? '', /No activities found/);
    await agent.shutdown();
  });

  test('a screenshot is captured on demand and filed against the session', async () => {
    // THE POINT. The release-time screenshot is taken after Appium force-stops the app, so it shows
    // the launcher rather than the failure. This one is taken while the suite still holds the
    // device — and it is the first verb in this pipeline that names no app, so it exercises the
    // path that the heartbeat's old INNER JOIN on app_builds silently swallowed.
    await clearFleet();
    const device = new FakeDevice(`shot-${randomUUID().slice(0, 8)}`);
    const agent = makeAgent([backendFor(device)], `shot-${randomUUID().slice(0, 8)}`);
    await agent.start();

    const sessionId = await allocate();

    // No appId, which is the whole difference: the first verb in this pipeline that names no app.
    const queued = await api(`/v1/sessions/${sessionId}/app-actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'screenshot' }),
    });
    const actionId = (await json<{ action: { id: string } }>(queued, 202)).action.id;

    await agent.heartbeat();
    const action = await settled(actionId);
    assert.equal(action.state, 'DONE', action.error ?? '');

    // The artifact is what makes the verb worth having, and it must be filed against the SESSION —
    // the control plane derives the owning org from it, so a worker cannot misfile one.
    const arts = await api(`/v1/sessions/${sessionId}/artifacts`);
    const { artifacts } = await json<{ artifacts: Array<{ kind: string }> }>(arts, 200);
    assert.equal(artifacts.filter((a) => a.kind === 'screenshot').length, 1,
      'the capture must reach the artifact store, not just report DONE');

    await agent.shutdown();
  });

  test('a verb this worker does not know fails rather than looping forever', async () => {
    await clearFleet();
    const device = new FakeDevice(`unknown-${randomUUID().slice(0, 8)}`);
    const agent = makeAgent([backendFor(device)], `unknown-${randomUUID().slice(0, 8)}`);
    await agent.start();

    // Simulates a newer control plane offering a verb this build has never heard of. Ignoring it
    // would leave the row PENDING and re-offered on every beat for the life of the farm.
    const reqs = [{
      actionId: randomUUID(), kind: 'teleport', deviceId: 'nope', appId: randomUUID(),
      packageName: 'dev.mfarm.x', fence: 1,
    }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (agent as any).runRequestedActions(reqs);
    await agent.shutdown();
  });

  test('work offered on the FIRST heartbeat of a restart is acted on, not dropped', async () => {
    // The bug this exists for: `start()` used to heartbeat and only then assign `this.state`, so
    // the device-id map was empty while the response was being handled — and every reset or action
    // that beat carried was discarded with "unknown device" for a device sitting right there. It
    // self-healed on the next beat, which is precisely why nobody noticed. Found by running the
    // fake farm against a real control plane, not by review.
    await clearFleet();
    const hostname = `restart-${randomUUID().slice(0, 8)}`;
    const statePath = join(workDir, `${hostname}.json`);
    const cacheDir = join(workDir, `${hostname}-apps`);
    // The SAME local id across the restart, which is what a restarted worker really has. A
    // different one changes the capability fingerprint, so `start()` would re-register instead of
    // taking the heartbeat path — and this test would silently stop testing the heartbeat path.
    const localId = `restart-dev-${randomUUID().slice(0, 8)}`;

    const first = new Agent({
      controlPlaneUrl: baseUrl, registrationToken: 'install-test-registration-secret',
      hostname, region: REGION, endpoint: 'wss://install-test.example:8080',
      devices: [backendFor(new FakeDevice(localId))],
      statePath, appCacheDir: cacheDir, cores: 8, memoryMb: 16384,
    });
    await first.start();

    const appId = await uploadApk(buildApk({ packageName: 'dev.mfarm.restart' }));
    const actionId = await requestAction(await allocate(), appId, 'install');
    await first.shutdown();

    // A NEW agent over the same state file: it has a valid credential, so `start()` takes the
    // heartbeat path rather than re-registering — and that beat is the one carrying the install.
    const device = new FakeDevice(localId);
    const second = new Agent({
      controlPlaneUrl: baseUrl, registrationToken: 'install-test-registration-secret',
      hostname, region: REGION, endpoint: 'wss://install-test.example:8080',
      devices: [backendFor(device)],
      statePath, appCacheDir: cacheDir, cores: 8, memoryMb: 16384,
    });
    await second.start();

    // No extra heartbeat: `start()` is the only beat that has happened.
    assert.equal((await settled(actionId)).state, 'DONE');
    await second.shutdown();
  });

  test('the host advertises app-install only when a device implements it', async () => {
    await clearFleet();
    const able = makeAgent([backendFor(new FakeDevice(`able-${randomUUID().slice(0, 8)}`))], `able-${randomUUID().slice(0, 8)}`);
    const unable = makeAgent([backendFor(new NoInstallDevice(`unable-${randomUUID().slice(0, 8)}`))], `unable-${randomUUID().slice(0, 8)}`);
    const a = await able.start();
    const u = await unable.start();

    const caps = async (hostId: string) => withSystem(async (c) =>
      (await c.query('SELECT capabilities FROM hosts WHERE id = $1', [hostId])).rows[0].capabilities as string[]);

    // A host that claimed the capability with nothing behind it would collect install jobs and then
    // fail them one at a time, which is worse than never being offered them.
    assert.ok((await caps(a.hostId)).includes('app-install'));
    assert.ok(!(await caps(u.hostId)).includes('app-install'));
    await able.shutdown();
    await unable.shutdown();
  });
});
