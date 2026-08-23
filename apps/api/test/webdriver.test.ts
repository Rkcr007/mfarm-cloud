/**
 * The W3C WebDriver hub.
 *
 * What is actually at stake here is the migration promise: an existing Appium suite points at a new
 * URL and keeps working. So these tests are written from the client's side of the wire — the shapes
 * a WebDriver client parses, the errors it can act on, and the two ways a device gets leaked
 * (Appium refuses the session, or the client quits) that would quietly eat the fleet.
 *
 * The upstream automation server is a real HTTP server on a real port, not a mock. The proxy's whole
 * job is path rewriting and passthrough, and a mock would be asserting on the thing under test.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';
// `mfarm:appId` blocks the session on an install the worker performs over the heartbeat. In
// production the budget is minutes; here the "worker" is a loop in this file, so a short deadline
// keeps the timeout case from being the slowest test in the suite.
process.env.MFARM_WD_APP_INSTALL_TIMEOUT_MS = '3000';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { createApiKey, generateWorkerToken } from '../src/auth.ts';
import { parseCapabilities } from '../src/http/webdriver/capabilities.ts';
import { verifySessionToken } from '../src/tokens.ts';

let app: FastifyInstance;
let orgA: string, orgB: string, hostId: string;
let keyA: string, keyB: string;
/** The host's own credential, so a test can play the worker that performs an install. */
let workerToken: string;
const REGION = 'wd-test';

const auth = (k: string) => ({ authorization: `Bearer ${k}` });
const androidCaps = (extra: Record<string, unknown> = {}) => ({
  capabilities: {
    alwaysMatch: { platformName: 'android', 'mfarm:region': REGION, ...extra },
    firstMatch: [{}],
  },
});

// ---------------------------------------------------------------- stub automation server

interface Recorded { method: string; url: string; body: unknown; auth?: string }

let upstream: Server;
let upstreamUrl: string;
let recorded: Recorded[] = [];
/** Flipped by the tests that need the automation server to misbehave. */
let upstreamMode: 'ok' | 'reject' = 'ok';

function startUpstream(): Promise<string> {
  upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      recorded.push({
        method: req.method!, url: req.url!,
        body: raw ? JSON.parse(raw) : undefined,
        // ADR-0004: the automation hop carries a signed grant. A real Appium ignores it; the
        // worker-side gateway that will terminate this hop does not.
        auth: req.headers.authorization,
      });
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
      };

      if (req.method === 'POST' && req.url === '/session') {
        if (upstreamMode === 'reject') {
          return json(500, {
            value: { error: 'session not created', message: 'no devices matched the given udid', stacktrace: '' },
          });
        }
        return json(200, {
          value: {
            sessionId: 'upstream-session-1',
            capabilities: { platformName: 'android', 'appium:automationName': 'UiAutomator2' },
          },
        });
      }
      if (req.url?.startsWith('/session/upstream-session-1')) {
        if (req.method === 'DELETE') return json(200, { value: null });
        if (req.url.endsWith('/screenshot')) return json(200, { value: 'iVBORw0KGgo=' });
        if (req.url.endsWith('/element')) {
          return json(200, { value: { 'element-6066-11e4-a52e-4f735466cecf': 'element-42' } });
        }
      }
      return json(404, { value: { error: 'unknown command', message: req.url, stacktrace: '' } });
    });
  });
  return new Promise((resolve) => {
    upstream.listen(0, '127.0.0.1', () => {
      const addr = upstream.address();
      resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`);
    });
  });
}

// ---------------------------------------------------------------- fixtures

/** `webdriver: false` seeds a device that is otherwise perfect but has no automation server. */
async function seedDevices(
  n: number,
  opts: { webdriver?: boolean; platform?: string; appInstall?: boolean } = {},
) {
  const caps = ['screen-stream', 'input-datachannel', 'snapshot-reset'];
  if (opts.webdriver !== false) caps.push('webdriver');
  // Off by default: `mfarm:appId` is the only thing here that needs it, and a fixture that quietly
  // declares every capability would hide the allocator refusing a device that cannot install.
  if (opts.appInstall) caps.push('app-install');
  return withSystem(async (c) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const { rows } = await c.query(
        // adb_serial, system_port and mjpeg_server_port are part of the fixture because they are
        // part of a real device (migration 011). Without a serial the hub refuses the session
        // outright rather than sending a udid no driver can match — see `no_device_identity`.
        `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, capabilities,
                              local_id, adb_serial, system_port, mjpeg_server_port)
         VALUES ($1,$2,$3,'cuttlefish','cf_x86_64','15','READY',$4::jsonb,$5,$6,$7,$8)
         RETURNING id`,
        [hostId, REGION, opts.platform ?? 'android', JSON.stringify(caps), `wd-${randomUUID()}`,
         `0.0.0.0:${6520 + i}`, 8200 + i, 7810 + i],
      );
      ids.push(rows[0].id);
    }
    return ids;
  });
}

const clearFleet = () => withSystem(async (c) => {
  await c.query('DELETE FROM app_actions WHERE org_id = ANY($1)', [[orgA, orgB]]);
  await c.query('DELETE FROM webdriver_sessions WHERE org_id = ANY($1)', [[orgA, orgB]]);
  await c.query('DELETE FROM metering_events WHERE org_id = ANY($1)', [[orgA, orgB]]);
  await c.query('DELETE FROM sessions WHERE org_id = ANY($1)', [[orgA, orgB]]);
  await c.query('DELETE FROM devices WHERE host_id = $1', [hostId]);
  recorded = [];
  upstreamMode = 'ok';
});

const deviceState = (id: string) => withSystem(async (c) =>
  (await c.query('SELECT state FROM devices WHERE id = $1', [id])).rows[0]?.state);
const sessionState = (id: string) => withSystem(async (c) =>
  (await c.query('SELECT state FROM sessions WHERE id = $1', [id])).rows[0]?.state);

before(async () => {
  upstreamUrl = await startUpstream();
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'WebDriver Test')
                   ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgA = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent)
                           VALUES ('wd-a','A',50) RETURNING id`)).rows[0].id;
    orgB = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent)
                           VALUES ('wd-b','B',50) RETURNING id`)).rows[0].id;
    const wt = generateWorkerToken();
    workerToken = wt.plaintext;
    hostId = (await c.query(
      `INSERT INTO hosts (region,hostname,state,protocol_version,cores,memory_mb,endpoint,automation_endpoint,
                          token_prefix,token_hash,last_heartbeat_at)
       VALUES ($1,'wd-test-host','UP',1,64,262144,'wss://wd-worker.example:8443',$2,$3,$4, now()) RETURNING id`,
      [REGION, upstreamUrl, wt.prefix, wt.hash])).rows[0].id;
  });
  keyA = (await createApiKey(orgA)).plaintext;
  keyB = (await createApiKey(orgB)).plaintext;
  app = await buildServer({ logger: false });
});

after(async () => {
  await app.close();
  await withSystem(async (c) => {
    await c.query('DELETE FROM app_actions WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM webdriver_sessions WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM metering_events WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM sessions WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM app_builds WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM devices WHERE host_id = $1', [hostId]);
    await c.query('DELETE FROM api_keys WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM hosts WHERE id = $1', [hostId]);
    await c.query('DELETE FROM orgs WHERE id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await new Promise<void>((r) => upstream.close(() => r()));
  await closePools();
});

// ---------------------------------------------------------------- capabilities

describe('capability negotiation', () => {
  const opts = { defaultRegion: undefined };

  test('alwaysMatch and firstMatch are merged', () => {
    const p = parseCapabilities({
      capabilities: {
        alwaysMatch: { platformName: 'Android' },
        firstMatch: [{ 'mfarm:region': 'eu-1', 'appium:automationName': 'UiAutomator2' }],
      },
    }, opts);
    assert.equal(p.platform, 'android', 'platformName is case-insensitive in practice');
    assert.equal(p.region, 'eu-1');
    assert.equal(p.upstream['appium:automationName'], 'UiAutomator2');
  });

  test('a key in both alwaysMatch and firstMatch is rejected, not silently resolved', () => {
    assert.throws(() => parseCapabilities({
      capabilities: {
        alwaysMatch: { platformName: 'android', 'mfarm:region': 'eu-1' },
        firstMatch: [{ platformName: 'ios' }],
      },
    }, opts), /both alwaysMatch and firstMatch/);
  });

  test('firstMatch falls through to an entry that can be satisfied', () => {
    const p = parseCapabilities({
      capabilities: {
        alwaysMatch: { 'mfarm:region': 'eu-1' },
        firstMatch: [{ platformName: 'windows-phone' }, { platformName: 'android' }],
      },
    }, opts);
    assert.equal(p.platform, 'android');
  });

  test('an unprefixed non-standard capability names itself in the error', () => {
    assert.throws(
      () => parseCapabilities({ capabilities: { alwaysMatch: { platformName: 'android', deviceName: 'Pixel' } } }, opts),
      /`deviceName`.*appium:deviceName/s,
      'the message has to say what to change — this is the first error a migrating team hits',
    );
  });

  test('legacy desiredCapabilities are accepted and prefixed for the upstream', () => {
    const p = parseCapabilities({
      desiredCapabilities: { platformName: 'android', 'mfarm:region': 'eu-1', deviceName: 'Pixel', app: 'https://x/a.apk' },
    }, opts);
    assert.equal(p.protocol, 'jsonwp', 'the response dialect has to match what was asked');
    assert.equal(p.upstream['appium:deviceName'], 'Pixel');
    assert.equal(p.upstream['appium:app'], 'https://x/a.apk');
  });

  test('mfarm: capabilities never reach the automation server', () => {
    const p = parseCapabilities({
      capabilities: { alwaysMatch: { platformName: 'android', 'mfarm:region': 'eu-1', 'mfarm:ttlMinutes': 15 } },
    }, opts);
    assert.equal(p.ttlMinutes, 15);
    assert.ok(!Object.keys(p.upstream).some((k) => k.startsWith('mfarm:')));
  });

  test('a missing region is a usable error rather than a default region', () => {
    assert.throws(() => parseCapabilities({ capabilities: { alwaysMatch: { platformName: 'android' } } }, opts),
      /mfarm:region/);
  });

  // ---------------------------------------------------------------- mfarm:appId

  const withAppId = (id: unknown, extra: Record<string, unknown> = {}) => parseCapabilities({
    capabilities: {
      alwaysMatch: { platformName: 'android', 'mfarm:region': 'eu-1', 'mfarm:appId': id, ...extra },
      firstMatch: [{}],
    },
  }, opts);

  test('mfarm:appId accepts an id, a package, a pinned version and @latest', () => {
    assert.deepEqual(withAppId('3f2504e0-4f89-11d3-9a0c-0305e82c3301').appRef,
      { kind: 'id', id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' });
    assert.deepEqual(withAppId('com.acme.app').appRef,
      { kind: 'package', packageName: 'com.acme.app', versionName: null },
      'a bare package name means the newest build, the way it does in every package manager');
    assert.deepEqual(withAppId('com.acme.app@1.4.2').appRef,
      { kind: 'package', packageName: 'com.acme.app', versionName: '1.4.2' });
    assert.deepEqual(withAppId('com.acme.app@latest').appRef,
      { kind: 'package', packageName: 'com.acme.app', versionName: null });
    // Uppercase is what a client library will hand back from its own uuid formatting.
    assert.deepEqual(withAppId('3F2504E0-4F89-11D3-9A0C-0305E82C3301').appRef,
      { kind: 'id', id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' });
  });

  test('a bare @latest is refused by naming the package it is missing', () => {
    assert.throws(() => withAppId('@latest'), /does not name a package/);
    assert.throws(() => withAppId('com.acme.app@'), /bare "@"/);
    assert.throws(() => withAppId('not a package'), /is not an app reference/);
    assert.throws(() => withAppId('acme'), /is not an app reference/,
      'one segment is not a package name, and is much more likely to be a truncated id');
    assert.throws(() => withAppId(''), /must be a non-empty string/);
  });

  test('mfarm:appId and appium:app both name the app, so together they are an error', () => {
    assert.throws(
      () => withAppId('com.acme.app', { 'appium:app': '/home/ci/apks/acme.apk' }),
      /both name the app to install/,
    );
  });

  test('an unknown mfarm: capability is refused, in both dialects', () => {
    // The typo this exists for. Ignoring it would start a session on a device with no app on it and
    // report whatever the launcher happened to show.
    assert.throws(() => parseCapabilities({
      capabilities: {
        alwaysMatch: { platformName: 'android', 'mfarm:region': 'eu-1', 'mfarm:appid': 'com.acme.app' },
        firstMatch: [{}],
      },
    }, opts), /`mfarm:appid` is not a capability this hub understands/);

    assert.throws(() => parseCapabilities({
      desiredCapabilities: { platformName: 'android', 'mfarm:region': 'eu-1', 'mfarm:vidoe': true },
    }, opts), /not a capability this hub understands/);

    // A vendor prefix that is not ours is somebody else's business and stays untouched.
    const p = parseCapabilities({
      capabilities: {
        alwaysMatch: { platformName: 'android', 'mfarm:region': 'eu-1', 'goog:chromeOptions': {} },
        firstMatch: [{}],
      },
    }, opts);
    assert.ok('goog:chromeOptions' in p.upstream);
  });
});

// ---------------------------------------------------------------- hub

describe('hub status', () => {
  test('status needs no credentials, at both mount points', async () => {
    for (const url of ['/wd/hub/status', '/status']) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 200, url);
      assert.equal(r.json().value.ready, true);
    }
  });
});

describe('new session', () => {
  test('allocates a device and returns the W3C session shape', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: androidCaps({ 'appium:app': 'https://example.test/app.apk' }),
    });

    assert.equal(r.statusCode, 200);
    const value = r.json().value;
    assert.match(value.sessionId, /^[0-9a-f-]{36}$/, 'the WebDriver session id IS the mfarm session id');
    assert.equal(value.capabilities['appium:automationName'], 'UiAutomator2', 'granted caps come from upstream');

    assert.equal(await sessionState(value.sessionId), 'ACTIVE');
    assert.equal(await deviceState(dev), 'SESSION_ACTIVE');

    const created = recorded.find((x) => x.url === '/session')!;
    const sent = (created.body as { capabilities: { alwaysMatch: Record<string, unknown> } }).capabilities.alwaysMatch;
    assert.equal(sent['appium:app'], 'https://example.test/app.apk', 'client caps are forwarded');
    assert.ok(!('mfarm:region' in sent), 'our vendor caps are stripped');
  });

  test('the udid is chosen by the allocator, never by the client, and it is the ADB SERIAL', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    const row = await withSystem(async (c) =>
      (await c.query('SELECT local_id, adb_serial, system_port, mjpeg_server_port FROM devices WHERE id = $1', [dev])).rows[0]);

    await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      // A client asking for someone else's device by udid must not get it.
      payload: androidCaps({ 'appium:udid': 'emulator-9999' }),
    });

    const sent = (recorded.find((x) => x.url === '/session')!.body as
      { capabilities: { alwaysMatch: Record<string, unknown> } }).capabilities.alwaysMatch;
    assert.equal(sent['appium:udid'], row.adb_serial, 'the hub overrides the requested udid');
    // B3: this used to be `local_id`. UiAutomator2 matches `udid` against the adb serial and has
    // never heard of `cf-1`, so every session the hub created would have targeted nothing.
    assert.notEqual(sent['appium:udid'], row.local_id, 'the local id is our name, not the driver\'s');
  });

  test('per-device driver ports are injected so two concurrent sessions do not collide', async () => {
    // UiAutomator2 defaults systemPort to 8200 and its MJPEG server to 7810 for every session, so a
    // second concurrent session on one host fails to start. Only reachable since migration 010 let
    // one host serve WebDriver on more than one device.
    await clearFleet();
    const [dev] = await seedDevices(1);
    const row = await withSystem(async (c) =>
      (await c.query('SELECT system_port, mjpeg_server_port FROM devices WHERE id = $1', [dev])).rows[0]);

    await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: androidCaps({ 'appium:systemPort': 9999 }),
    });

    const sent = (recorded.find((x) => x.url === '/session')!.body as
      { capabilities: { alwaysMatch: Record<string, unknown> } }).capabilities.alwaysMatch;
    assert.equal(sent['appium:systemPort'], row.system_port, 'the client does not get to pick a host port');
    assert.equal(sent['appium:mjpegServerPort'], row.mjpeg_server_port);
  });

  test('a device with no adb serial is refused rather than mis-targeted', async () => {
    // The two alternatives are both worse: `local_id` is a udid no driver matches (B3), and omitting
    // `appium:udid` lets the driver pick any attached device — possibly another tenant's.
    await clearFleet();
    const [dev] = await seedDevices(1);
    await withSystem((c) => c.query('UPDATE devices SET adb_serial = NULL WHERE id = $1', [dev]));

    const res = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    assert.equal(res.statusCode, 500);
    const body = res.json() as { value: { message: string } };
    assert.match(body.value.message, /adb serial/i);
    assert.equal(recorded.find((x) => x.url === '/session'), undefined, 'nothing reached the driver');
  });

  test('a rejected upstream session gives the device back', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    upstreamMode = 'reject';

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });

    assert.equal(r.statusCode, 500);
    assert.equal(r.json().value.error, 'session not created');
    assert.match(r.json().value.message, /no devices matched/, 'the upstream reason has to survive');
    // The failure that would silently eat the fleet: a device stuck RESERVED against a session that
    // never existed.
    assert.equal(await deviceState(dev), 'CLEANING', 'released, not left reserved');
  });

  test('an unreachable automation server gives the device back', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    await withSystem((c) => c.query(
      `UPDATE hosts SET automation_endpoint = 'http://127.0.0.1:1' WHERE id = $1`, [hostId]));

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });

    await withSystem((c) => c.query('UPDATE hosts SET automation_endpoint = $2 WHERE id = $1', [hostId, upstreamUrl]));

    assert.equal(r.json().value.error, 'session not created');
    assert.equal(r.json().value['mfarm:code'], 'automation_unreachable');
    assert.equal(await deviceState(dev), 'CLEANING');
  });

  test('a device with no automation server is not allocated for WebDriver', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1, { webdriver: false });

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });

    assert.equal(r.json().value['mfarm:code'], 'no_capacity');
    assert.equal(await deviceState(dev), 'READY', 'it was never touched, so it stays allocatable');
  });

  test('no capacity is an error a test author can act on', async () => {
    await clearFleet();
    await seedDevices(1);
    await app.inject({ method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps() });

    const second = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyB), payload: androidCaps(),
    });
    assert.equal(second.statusCode, 500);
    assert.equal(second.json().value.error, 'session not created');
    assert.match(second.json().value.message, /queueTimeoutSeconds/, 'tell them how to wait instead');
  });

  test('a legacy JSONWP client gets a JSONWP response', async () => {
    await clearFleet();
    await seedDevices(1);
    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: { desiredCapabilities: { platformName: 'android', 'mfarm:region': REGION, deviceName: 'Pixel' } },
    });
    assert.equal(r.statusCode, 200);
    assert.match(r.json().sessionId, /^[0-9a-f-]{36}$/, 'JSONWP reads the id from the top level');
    assert.equal(r.json().status, 0);
  });

  test('Appium 2 clients reach the same hub at the root path', async () => {
    await clearFleet();
    await seedDevices(1);
    const r = await app.inject({
      method: 'POST', url: '/session', headers: auth(keyA), payload: androidCaps(),
    });
    assert.equal(r.statusCode, 200);

    // The proxy reconstructs the upstream path by stripping its own mount prefix, so the root mount
    // is the case where an off-by-one leading slash would send every command to the wrong URL.
    const sid = r.json().value.sessionId;
    const cmd = await app.inject({
      method: 'POST', url: `/session/${sid}/element`, headers: auth(keyA),
      payload: { using: 'id', value: 'login' },
    });
    assert.equal(cmd.statusCode, 200);
    assert.equal(recorded.at(-1)!.url, '/session/upstream-session-1/element');
  });
});

describe('command proxy', () => {
  async function open(key = keyA): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(key), payload: androidCaps(),
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().value.sessionId;
  }

  test('commands are rewritten onto the upstream session id and passed through verbatim', async () => {
    await clearFleet();
    await seedDevices(1);
    const sid = await open();

    const r = await app.inject({
      method: 'POST', url: `/wd/hub/session/${sid}/element`, headers: auth(keyA),
      payload: { using: 'id', value: 'login' },
    });

    assert.equal(r.statusCode, 200);
    assert.equal(r.json().value['element-6066-11e4-a52e-4f735466cecf'], 'element-42');

    const seen = recorded.at(-1)!;
    assert.equal(seen.url, '/session/upstream-session-1/element');
    assert.deepEqual(seen.body, { using: 'id', value: 'login' });
  });

  test('GET commands proxy without a body', async () => {
    await clearFleet();
    await seedDevices(1);
    const sid = await open();
    const r = await app.inject({ method: 'GET', url: `/wd/hub/session/${sid}/screenshot`, headers: auth(keyA) });
    assert.equal(r.json().value, 'iVBORw0KGgo=');
    assert.equal(recorded.at(-1)!.body, undefined);
  });

  test('an upstream error status is not rewritten into a success', async () => {
    await clearFleet();
    await seedDevices(1);
    const sid = await open();
    const r = await app.inject({ method: 'GET', url: `/wd/hub/session/${sid}/nonsense`, headers: auth(keyA) });
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().value.error, 'unknown command');
  });

  test("another org's session id is 'invalid session id', not a 403", async () => {
    await clearFleet();
    await seedDevices(1);
    const sid = await open(keyA);

    const r = await app.inject({
      method: 'POST', url: `/wd/hub/session/${sid}/element`, headers: auth(keyB),
      payload: { using: 'id', value: 'login' },
    });
    // A 403 would confirm the id exists, and the id is the only thing an attacker needs to guess.
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().value.error, 'invalid session id');
    assert.equal(recorded.filter((x) => x.url.includes('/element')).length, 0, 'nothing reached the device');
  });

  test('a malformed session id is a client error, not a 500', async () => {
    // The second one is 36 characters of uuid-legal punctuation: a length-and-charset check passes
    // it through to Postgres, which raises on the cast and turns a client typo into a 500.
    for (const id of ['not-a-uuid', '-'.repeat(36)]) {
      const r = await app.inject({ method: 'GET', url: `/wd/hub/session/${id}/screenshot`, headers: auth(keyA) });
      assert.equal(r.statusCode, 404, id);
      assert.equal(r.json().value.error, 'invalid session id', id);
    }
  });
});

describe('quit', () => {
  test('quitting tells the upstream, ends the session and releases the device', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    const created = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    const sid = created.json().value.sessionId;

    const r = await app.inject({ method: 'DELETE', url: `/wd/hub/session/${sid}`, headers: auth(keyA) });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().value, null);

    assert.ok(recorded.some((x) => x.method === 'DELETE' && x.url === '/session/upstream-session-1'));
    assert.equal(await sessionState(sid), 'ENDED');
    // CLEANING, never READY: the next tenant must not get the previous one's accounts and caches.
    assert.equal(await deviceState(dev), 'CLEANING');
  });

  test('commands after quit are rejected', async () => {
    await clearFleet();
    await seedDevices(1);
    const created = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    const sid = created.json().value.sessionId;
    await app.inject({ method: 'DELETE', url: `/wd/hub/session/${sid}`, headers: auth(keyA) });

    const r = await app.inject({ method: 'GET', url: `/wd/hub/session/${sid}/screenshot`, headers: auth(keyA) });
    assert.equal(r.json().value.error, 'invalid session id');
  });

  test('an unreachable upstream still releases the device', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    const created = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    const sid = created.json().value.sessionId;

    await withSystem((c) => c.query(
      `UPDATE hosts SET automation_endpoint = 'http://127.0.0.1:1' WHERE id = $1`, [hostId]));
    const r = await app.inject({ method: 'DELETE', url: `/wd/hub/session/${sid}`, headers: auth(keyA) });
    await withSystem((c) => c.query('UPDATE hosts SET automation_endpoint = $2 WHERE id = $1', [hostId, upstreamUrl]));

    assert.equal(r.statusCode, 200, 'quit must not fail because the host is gone');
    assert.equal(await deviceState(dev), 'CLEANING', 'giving the device back is the part that matters');
  });

  test('the session list shows live sessions and drops ended ones', async () => {
    await clearFleet();
    await seedDevices(1);
    const created = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    const sid = created.json().value.sessionId;

    const listed = await app.inject({ method: 'GET', url: '/wd/hub/sessions', headers: auth(keyA) });
    assert.deepEqual(listed.json().value.map((s: { id: string }) => s.id), [sid]);

    const otherOrg = await app.inject({ method: 'GET', url: '/wd/hub/sessions', headers: auth(keyB) });
    assert.deepEqual(otherOrg.json().value, [], 'RLS, not a WHERE clause someone can forget');

    await app.inject({ method: 'DELETE', url: `/wd/hub/session/${sid}`, headers: auth(keyA) });
    const after = await app.inject({ method: 'GET', url: '/wd/hub/sessions', headers: auth(keyA) });
    assert.deepEqual(after.json().value, []);
  });
});

describe('credentials', () => {
  test('a missing credential comes back in the W3C envelope, not the REST one', async () => {
    const r = await app.inject({ method: 'POST', url: '/wd/hub/session', payload: androidCaps() });
    assert.equal(r.statusCode, 401);
    const body = r.json();
    // Not `{error:{...}}`: a WebDriver client cannot read that, and the user sees "unknown
    // server-side error" instead of "your key is wrong".
    assert.equal(body.error, undefined);
    assert.equal(body.value['mfarm:code'], 'unauthorized');
    assert.match(body.value.message, /Bearer/);
  });

  test('the key can travel in the URL as Basic credentials', async () => {
    await clearFleet();
    await seedDevices(1);
    // https://<key>@hub.mfarm.dev/wd/hub — this is what makes the migration one URL rather than one
    // URL plus a client-library change to inject a header.
    const basic = Buffer.from(`${keyA}:`).toString('base64');
    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session',
      headers: { authorization: `Basic ${basic}` }, payload: androidCaps(),
    });
    assert.equal(r.statusCode, 200, r.body);
  });

  test('the key is also accepted as the Basic password', async () => {
    await clearFleet();
    await seedDevices(1);
    const basic = Buffer.from(`ignored-username:${keyA}`).toString('base64');
    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session',
      headers: { authorization: `Basic ${basic}` }, payload: androidCaps(),
    });
    assert.equal(r.statusCode, 200, r.body);
  });

  test('a bad capability body is a 400 the client can read', async () => {
    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: { capabilities: { alwaysMatch: { platformName: 'android', 'mfarm:region': REGION, browser: 'x' } } },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().value.error, 'invalid argument');
  });
});

describe('waiting for capacity', () => {
  test('a queued session is promoted onto a freed device while the client waits', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    // The wait depends on something running promote_queued. In production that is the reaper; here
    // it is the same reaper, on a short interval.
    const reaping = await buildServer({ logger: false, reaperIntervalMs: 200 });

    const first = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    const firstId = first.json().value.sessionId;

    const waiting = reaping.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyB),
      payload: androidCaps({ 'mfarm:queueTimeoutSeconds': 20 }),
    });

    // Free the device the way the fleet really does: release, then a worker confirms the restore.
    await new Promise((r) => setTimeout(r, 600));
    await app.inject({ method: 'DELETE', url: `/wd/hub/session/${firstId}`, headers: auth(keyA) });
    await withSystem((c) => c.query(
      `SELECT device_reset_complete((SELECT host_id FROM devices WHERE id = $1),
                                    $1, (SELECT fence FROM devices WHERE id = $1))`, [dev]));

    const r = await waiting;
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(await sessionState(r.json().value.sessionId), 'ACTIVE');
    await reaping.close();
  });

  test('promotion honours the capabilities the session was queued with', async () => {
    await clearFleet();
    // One device that cannot serve WebDriver, so the queued session must stay queued no matter how
    // many times promotion runs. Before constraints were recorded, promote_queued matched on region
    // alone and would have handed this over.
    const [plain] = await seedDevices(1, { webdriver: false });
    const queued = await withSystem(async (c) => {
      const { rows } = await c.query(
        `SELECT o_session_id AS id FROM allocate_device($1,NULL,$2,'android',NULL,'30 minutes','{}'::jsonb,'["webdriver"]'::jsonb)`,
        [orgA, REGION]);
      return rows[0].id;
    });
    assert.equal(await sessionState(queued), 'QUEUED');

    const promoted = await withSystem(async (c) =>
      (await c.query('SELECT promote_queued(20) AS n')).rows[0].n);
    assert.equal(Number(promoted), 0);
    assert.equal(await sessionState(queued), 'QUEUED');
    assert.equal(await deviceState(plain), 'READY');
  });
});

// ---------------------------------------------------------------- binding (ADR-0002 D1)

/**
 * The double-billing defect, and the fix.
 *
 * `mfarm run` allocates a session and hands the child a hub URL. Before binding existed the hub had
 * no way to be told about that session, so it allocated a second device from the client's
 * capabilities: the suite held two devices, paid for two, and never touched the CLI's. Nothing
 * failed — it overcharged, which is the kind of bug a customer finds on an invoice.
 *
 * These tests are written around the property that matters, which is a COUNT: one `mfarm run`, one
 * session, one device, however many times the suite calls `driver.quit()`.
 */
describe('binding to a session the caller already owns', () => {
  /** How `mfarm run` presents itself: the key as the Basic username, the session as the password. */
  const hubUrlAuth = (key: string, sessionId?: string) => ({
    authorization: `Basic ${Buffer.from(`${key}:${sessionId ?? ''}`).toString('base64')}`,
  });

  const liveSessions = (orgId: string) => withSystem(async (c) =>
    Number((await c.query(
      `SELECT count(*)::int AS n FROM sessions
        WHERE org_id = $1 AND state IN ('QUEUED','ALLOCATING','ACTIVE')`, [orgId])).rows[0].n));

  /** Allocate the way the CLI does, through the REST API. */
  async function cliAllocate(key: string) {
    const r = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(key),
      payload: { region: REGION, platform: 'android', requireCapabilities: ['webdriver'] },
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().session as { id: string; deviceId: string };
  }

  test('a suite under `mfarm run` holds one device, not two', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    const cli = await cliAllocate(keyA);

    // The suite is unchanged: no mfarm capabilities at all, not even a region. All it got was a URL.
    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id),
      payload: { capabilities: { alwaysMatch: { platformName: 'android' }, firstMatch: [{}] } },
    });

    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().value.sessionId, cli.id, 'the hub drives the session the CLI allocated');
    assert.equal(await liveSessions(orgA), 1, 'ONE session — this count is the whole defect');
    assert.equal(await deviceState(dev), 'SESSION_ACTIVE');
    assert.equal(await sessionState(cli.id), 'ACTIVE');
  });

  test('without a binding the hub still allocates its own session', async () => {
    // The unbound path is unchanged, and this test exists to keep the contrast visible: the same
    // request without the session id in the URL is what used to happen under `mfarm run`.
    await clearFleet();
    await seedDevices(2);
    const cli = await cliAllocate(keyA);

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.notEqual(r.json().value.sessionId, cli.id);
    assert.equal(await liveSessions(orgA), 2, 'two sessions, two devices, two bills');
  });

  test('the `mfarm:sessionId` capability binds the same way the URL does', async () => {
    await clearFleet();
    await seedDevices(1);
    const cli = await cliAllocate(keyA);

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: androidCaps({ 'mfarm:sessionId': cli.id }),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().value.sessionId, cli.id);
    assert.equal(await liveSessions(orgA), 1);
  });

  test('the binding never reaches the automation server', async () => {
    await clearFleet();
    await seedDevices(1);
    const cli = await cliAllocate(keyA);
    await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: androidCaps({ 'mfarm:sessionId': cli.id }),
    });
    const sent = recorded.find((r) => r.url === '/session')!.body as
      { capabilities: { alwaysMatch: Record<string, unknown> } };
    assert.equal(sent.capabilities.alwaysMatch['mfarm:sessionId'], undefined);
  });

  test('quit ends the WebDriver session but not the run', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    const cli = await cliAllocate(keyA);
    await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id), payload: androidCaps(),
    });

    const q = await app.inject({
      method: 'DELETE', url: `/wd/hub/session/${cli.id}`, headers: hubUrlAuth(keyA, cli.id),
    });
    assert.equal(q.statusCode, 200);

    // The device is still ours. `mfarm run` releases it when the child exits, and only then.
    assert.equal(await sessionState(cli.id), 'ACTIVE', 'quit must not end a session it does not own');
    assert.equal(await deviceState(dev), 'SESSION_ACTIVE');

    // And a suite that quits between tests re-binds instead of buying another device.
    const second = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id), payload: androidCaps(),
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().value.sessionId, cli.id);
    assert.equal(await liveSessions(orgA), 1, 'N tests, one device');
  });

  test('quit still releases a session the hub allocated itself', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    const created = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    const id = created.json().value.sessionId;
    await app.inject({ method: 'DELETE', url: `/wd/hub/session/${id}`, headers: auth(keyA) });
    assert.equal(await sessionState(id), 'ENDED');
    assert.equal(await deviceState(dev), 'CLEANING');
  });

  test('a failed upstream leaves a bound session for its owner to release', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    const cli = await cliAllocate(keyA);
    upstreamMode = 'reject';

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id), payload: androidCaps(),
    });
    assert.equal(r.statusCode, 500);
    // The unbound path gives the device back here. The bound path must not: `mfarm run` is still
    // running, still believes it holds this device, and will release it on its own way out.
    assert.notEqual(await sessionState(cli.id), 'ENDED');
    assert.notEqual(await deviceState(dev), 'CLEANING');
  });

  test("another org's session id is not bindable", async () => {
    await clearFleet();
    await seedDevices(2);
    const mine = await cliAllocate(keyB);

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, mine.id), payload: androidCaps(),
    });
    assert.equal(r.statusCode, 500);
    assert.match(r.json().value.message, /No session .* in this organisation/);
    assert.equal(await sessionState(mine.id), 'ALLOCATING', "orgB's session is untouched");
  });

  test('a session already driving a WebDriver session cannot be bound twice', async () => {
    await clearFleet();
    await seedDevices(1);
    const cli = await cliAllocate(keyA);
    await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id), payload: androidCaps(),
    });

    const again = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id), payload: androidCaps(),
    });
    assert.equal(again.statusCode, 500);
    assert.match(again.json().value.message, /already has a WebDriver session/);
    assert.equal(await liveSessions(orgA), 1);
  });

  test('binding to a device that cannot run Appium fails before the proxy hop', async () => {
    await clearFleet();
    await seedDevices(1, { webdriver: false });
    // Allocated without demanding `webdriver`, the way `mfarm run` does for a non-WebDriver suite.
    const s = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(keyA),
      payload: { region: REGION, platform: 'android' },
    });
    const id = s.json().session.id;

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, id), payload: androidCaps(),
    });
    assert.equal(r.statusCode, 500);
    assert.match(r.json().value.message, /no automation server/);
  });

  test('a queued session says so rather than looking like a fleet failure', async () => {
    await clearFleet();
    const queued = await withSystem(async (c) =>
      (await c.query(
        `SELECT o_session_id AS id FROM allocate_device($1,NULL,$2,'android',NULL,'30 minutes','{}'::jsonb,'[]'::jsonb)`,
        [orgA, REGION])).rows[0].id);
    assert.equal(await sessionState(queued), 'QUEUED');

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, queued), payload: androidCaps(),
    });
    assert.match(r.json().value.message, /still queued/);
  });

  test('a URL binding and a capability that disagree are refused, not resolved', async () => {
    await clearFleet();
    await seedDevices(1);
    const cli = await cliAllocate(keyA);

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id),
      payload: androidCaps({ 'mfarm:sessionId': randomUUID() }),
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().value.message, /does not match the session in the hub URL/);
  });

  test('allocation capabilities cannot be combined with a binding', async () => {
    await clearFleet();
    await seedDevices(1);
    const cli = await cliAllocate(keyA);

    for (const extra of [{ 'mfarm:tier': 'cuttlefish' }, { 'mfarm:ttlMinutes': 60 },
                         { 'mfarm:queueTimeoutSeconds': 30 }]) {
      const r = await app.inject({
        method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id),
        payload: androidCaps(extra),
      });
      assert.equal(r.statusCode, 400, JSON.stringify(extra));
      assert.match(r.json().value.message, /cannot be combined with `mfarm:sessionId`/);
    }
  });

  test('a region that disagrees with the session is refused', async () => {
    await clearFleet();
    await seedDevices(1);
    const cli = await cliAllocate(keyA);
    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id),
      payload: {
        capabilities: {
          alwaysMatch: { platformName: 'android', 'mfarm:region': 'somewhere-else' },
          firstMatch: [{}],
        },
      },
    });
    assert.equal(r.statusCode, 500);
    assert.match(r.json().value.message, /is in wd-test/);
  });

  test('a platformName that disagrees with the session is refused', async () => {
    await clearFleet();
    await seedDevices(1);           // android
    const cli = await cliAllocate(keyA);
    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id),
      payload: { capabilities: { alwaysMatch: { platformName: 'iOS' }, firstMatch: [{}] } },
    });
    assert.equal(r.statusCode, 500);
    assert.match(r.json().value.message, /holds a android device/);
  });

  test('a non-uuid in the password half is ignored, not an error', async () => {
    // Plenty of clients put a placeholder there. Failing their first request over it would be a
    // poor welcome, and the key alone is still a complete credential.
    await clearFleet();
    await seedDevices(1);
    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, 'x'), payload: androidCaps(),
    });
    assert.equal(r.statusCode, 200, r.body);
  });
});

// ---------------------------------------------------------------- automation transport (ADR-0004)

/**
 * Appium binds loopback, so the hop from the hub to it has to terminate on the worker — and the
 * thing that terminates it has to be able to tell an authorised request from a stranger's, because
 * on the other side of it is unauthenticated device control.
 *
 * The answer is the token the system already has: an Ed25519 grant the worker verifies offline with
 * the public key it was handed at registration. These tests assert the control-plane half. The
 * gateway that consumes it does not exist yet (ADR-0004, "what is not implemented"), which is
 * exactly why the wire format is pinned down here rather than discovered later on a bare-metal box.
 */
describe('the automation grant', () => {
  const grantOn = (r: Recorded): string => {
    const header = r.auth ?? '';
    assert.ok(header.startsWith('Bearer '), `no grant on ${r.method} ${r.url}`);
    return header.slice(7);
  };

  test('every upstream request carries a grant the worker can verify', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    const created = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    const id = created.json().value.sessionId;
    await app.inject({ method: 'GET', url: `/wd/hub/session/${id}/screenshot`, headers: auth(keyA) });
    await app.inject({ method: 'DELETE', url: `/wd/hub/session/${id}`, headers: auth(keyA) });

    assert.ok(recorded.length >= 3, 'new session, one command, and the quit');
    for (const r of recorded) {
      const v = verifySessionToken(grantOn(r), app.signingKey.publicKeyPem, hostId);
      assert.equal(v.ok, true, `grant on ${r.method} ${r.url} did not verify`);
      assert.equal(v.ok && v.claims.sid, id, 'names the session it is for');
      assert.equal(v.ok && v.claims.did, dev, 'and the device — a leaked grant drives nothing else');
      assert.equal(v.ok && v.claims.org, orgA);
    }
  });

  test('a grant is useless at another host', async () => {
    await clearFleet();
    await seedDevices(1);
    await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    const v = verifySessionToken(
      grantOn(recorded[0]), app.signingKey.publicKeyPem, randomUUID(),
    );
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, 'wrong_audience');
  });

  test('the grant carries the fence, so a replayed command is refusable', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    const fence = await withSystem(async (c) =>
      Number((await c.query('SELECT fence FROM devices WHERE id = $1', [dev])).rows[0].fence));
    const v = verifySessionToken(grantOn(recorded[0]), app.signingKey.publicKeyPem, hostId);
    assert.equal(v.ok && v.claims.fence, fence,
                 'a partitioned hub replaying an old command presents an old fence');
  });

  test('a bound session grants against the device its owner allocated', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    const s = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(keyA),
      payload: { region: REGION, platform: 'android', requireCapabilities: ['webdriver'] },
    });
    const cli = s.json().session;

    await app.inject({
      method: 'POST', url: '/wd/hub/session',
      headers: { authorization: `Basic ${Buffer.from(`${keyA}:${cli.id}`).toString('base64')}` },
      payload: androidCaps(),
    });

    const v = verifySessionToken(grantOn(recorded[0]), app.signingKey.publicKeyPem, hostId);
    assert.equal(v.ok && v.claims.sid, cli.id);
    assert.equal(v.ok && v.claims.did, dev);
  });
});

// ---------------------------------------------------------------- mfarm:appId

/**
 * `mfarm:appId` — the app under test comes from the library, not from a path on the device host.
 *
 * The interesting thing about this capability is that it makes session creation depend on a WORKER,
 * asynchronously, in the middle of a request: the hub queues an install, the heartbeat carries it
 * down, and nothing proceeds until the outcome comes back up. So these tests play the worker for
 * real — `POST /v1/workers/heartbeat` to collect the job and `POST /v1/workers/events` to report it
 * — rather than writing DONE into the table. What is under test is the whole loop, and the loop is
 * where the failures are: a device left holding a lease after a bad APK, an install offered to the
 * wrong host, a session that opens before the app is on the device.
 */
describe('mfarm:appId', () => {
  /** A build in the library. The hub never reads the bytes — only a worker does — so there are none. */
  async function seedBuild(orgId: string, opts: {
    packageName: string; versionName?: string | null; versionCode?: number;
    platform?: string; secondsAgo?: number;
  }): Promise<string> {
    return withSystem(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO app_builds (org_id, platform, package_name, version_name, version_code,
                                 sha256, size_bytes, filename, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() - ($9 || ' seconds')::interval) RETURNING id`,
        [orgId, opts.platform ?? 'android', opts.packageName, opts.versionName ?? null,
         opts.versionCode ?? 1, randomBytes(32).toString('hex'), 4096,
         `${opts.packageName}.apk`, String(opts.secondsAgo ?? 0)],
      );
      return rows[0].id;
    });
  }

  /** One heartbeat, and a report for everything it was offered. Returns what it was asked to do. */
  async function workerBeat(outcome: { ok: boolean; error?: string }) {
    const beat = await app.inject({
      method: 'POST', url: '/v1/workers/heartbeat', headers: auth(workerToken),
    });
    const offered = beat.json().actions as Array<{ actionId: string; kind: string; appId: string }>;
    if (offered.length > 0) {
      await app.inject({
        method: 'POST', url: '/v1/workers/events', headers: auth(workerToken),
        payload: { actions: offered.map((a) => ({ actionId: a.actionId, ...outcome })) },
      });
    }
    return offered;
  }

  /**
   * Create a session while a worker is running beside it.
   *
   * The request cannot be awaited first — it blocks ON the worker — so it is started, serviced, and
   * only then awaited. The iteration cap is what turns "the hub is waiting for something that will
   * never happen" into a failed assertion rather than a test run that hangs.
   */
  async function createSession(
    caps: Record<string, unknown>,
    opts: { outcome?: { ok: boolean; error?: string }; work?: boolean; key?: string } = {},
    /** For the bound path, where the credential carries the session id in its password half. */
    headers?: Record<string, string>,
  ) {
    const offered: Array<{ actionId: string; kind: string; appId: string }> = [];
    const pending = app.inject({
      method: 'POST', url: '/wd/hub/session',
      headers: headers ?? auth(opts.key ?? keyA), payload: caps,
    });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });

    for (let i = 0; i < 400 && !settled; i++) {
      if (opts.work !== false) offered.push(...await workerBeat(opts.outcome ?? { ok: true }));
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(settled, 'the hub never answered — it is still waiting on something');
    return { reply: await pending, offered };
  }

  test('resolves a build id, installs it, and only then opens the session', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1, { appInstall: true });
    const appId = await seedBuild(orgA, { packageName: 'com.acme.shop', versionName: '1.4.2' });

    const { reply, offered } = await createSession(androidCaps({ 'mfarm:appId': appId }));

    assert.equal(reply.statusCode, 200, reply.body);
    const value = reply.json().value;
    assert.equal(await sessionState(value.sessionId), 'ACTIVE');
    assert.equal(await deviceState(dev), 'SESSION_ACTIVE');

    // The worker was asked to install exactly this build, once.
    assert.equal(offered.length, 1);
    assert.equal(offered[0].kind, 'install');
    assert.equal(offered[0].appId, appId);

    // Appium is told which app to bring up, and is NOT handed a path — that coupling is the whole
    // thing this capability removes.
    const created = recorded.find((r) => r.method === 'POST' && r.url === '/session')!;
    const sent = (created.body as { capabilities: { alwaysMatch: Record<string, unknown> } })
      .capabilities.alwaysMatch;
    assert.equal(sent['appium:appPackage'], 'com.acme.shop');
    assert.ok(!('appium:app' in sent), 'no host path reaches the automation server');
    assert.ok(!('appium:appActivity' in sent), 'the launchable activity is the driver\'s to resolve');
    assert.ok(!('mfarm:appId' in sent), 'our vendor caps are stripped upstream as always');

    // The build that actually ran is reported back, and recorded on the session.
    assert.equal(value.capabilities['mfarm:appId'], appId);
    const stored = await withSystem(async (c) => (await c.query(
      'SELECT capabilities FROM webdriver_sessions WHERE session_id = $1', [value.sessionId],
    )).rows[0].capabilities);
    assert.equal(stored['mfarm:appId'], appId);
  });

  test('the install happens before the automation session is created, not after', async () => {
    await clearFleet();
    await seedDevices(1, { appInstall: true });
    const appId = await seedBuild(orgA, { packageName: 'com.acme.order' });

    // One beat, deliberately withheld until after a moment of nothing: if the hub created the
    // Appium session first, the upstream would already have been called by now.
    const pending = app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: androidCaps({ 'mfarm:appId': appId }),
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(recorded.filter((r) => r.url === '/session').length, 0,
      'the session must not open against a device that has no app on it yet');

    for (let i = 0; i < 100; i++) {
      if ((await workerBeat({ ok: true })).length > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const reply = await pending;
    assert.equal(reply.statusCode, 200, reply.body);
    assert.equal(recorded.filter((r) => r.url === '/session').length, 1);
  });

  test('@latest takes the newest upload, and a pinned version takes that one', async () => {
    await clearFleet();
    await seedDevices(2, { appInstall: true });
    const old = await seedBuild(orgA, { packageName: 'com.acme.nightly', versionName: '1.0.0', secondsAgo: 600 });
    const fresh = await seedBuild(orgA, { packageName: 'com.acme.nightly', versionName: '1.1.0', secondsAgo: 1 });

    const latest = await createSession(androidCaps({ 'mfarm:appId': 'com.acme.nightly@latest' }));
    assert.equal(latest.reply.statusCode, 200, latest.reply.body);
    assert.equal(latest.reply.json().value.capabilities['mfarm:appId'], fresh);
    assert.equal(latest.offered[0].appId, fresh);

    const pinned = await createSession(androidCaps({ 'mfarm:appId': 'com.acme.nightly@1.0.0' }));
    assert.equal(pinned.reply.statusCode, 200, pinned.reply.body);
    assert.equal(pinned.reply.json().value.capabilities['mfarm:appId'], old,
      'a pinned version is how a run is made reproducible, so it must not drift to the newest');
  });

  test('a bare package name means the newest build of it', async () => {
    await clearFleet();
    await seedDevices(1, { appInstall: true });
    await seedBuild(orgA, { packageName: 'com.acme.bare', versionName: '0.9', secondsAgo: 600 });
    const fresh = await seedBuild(orgA, { packageName: 'com.acme.bare', versionName: '1.0' });

    const { reply } = await createSession(androidCaps({ 'mfarm:appId': 'com.acme.bare' }));
    assert.equal(reply.json().value.capabilities['mfarm:appId'], fresh);
  });

  test('a build that is not in the library costs no device at all', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1, { appInstall: true });

    for (const ref of [randomUUID(), 'com.acme.never@latest', 'com.acme.shop@9.9.9']) {
      const r = await app.inject({
        method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
        payload: androidCaps({ 'mfarm:appId': ref }),
      });
      assert.equal(r.json().value.error, 'session not created', ref);
      assert.equal(r.json().value['mfarm:code'], 'no_such_app', ref);
      // Resolution happens before allocation on purpose: a typo must not spend a lease, and on a
      // busy farm must not spend a queue wait either.
      assert.equal(await deviceState(dev), 'READY', ref);
    }
  });

  test("another org's build is not nameable, even by its exact id", async () => {
    await clearFleet();
    await seedDevices(1, { appInstall: true });
    const theirs = await seedBuild(orgB, { packageName: 'com.rival.app', versionName: '2.0' });

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: androidCaps({ 'mfarm:appId': theirs }),
    });
    // Indistinguishable from a build that never existed — RLS scopes the lookup, so there is no
    // answer here that confirms the id to a stranger.
    assert.equal(r.json().value['mfarm:code'], 'no_such_app');
  });

  test('a failed install fails the session with adb\'s own words, and gives the device back', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1, { appInstall: true });
    const appId = await seedBuild(orgA, { packageName: 'com.acme.broken' });

    const { reply } = await createSession(
      androidCaps({ 'mfarm:appId': appId }),
      { outcome: { ok: false, error: 'INSTALL_FAILED_NO_MATCHING_ABIS' } },
    );

    assert.equal(reply.statusCode, 500);
    assert.equal(reply.json().value['mfarm:code'], 'app_install_failed');
    assert.match(reply.json().value.message, /INSTALL_FAILED_NO_MATCHING_ABIS/,
      'the reason names the caller\'s APK, because that is what is actually wrong');
    // No automation session was ever started, so there is nothing upstream to clean up — but the
    // device is ours to give back, and leaving it reserved would eat the fleet one bad build at a time.
    assert.equal(recorded.filter((r) => r.url === '/session').length, 0);
    assert.equal(await deviceState(dev), 'CLEANING', 'released, not left reserved');
  });

  test('an install that never finishes times out instead of holding the request open', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1, { appInstall: true });
    const appId = await seedBuild(orgA, { packageName: 'com.acme.slow' });

    // A worker that beats but never reports — a host that took the job and died mid-install.
    const { reply } = await createSession(androidCaps({ 'mfarm:appId': appId }), { work: false });

    assert.equal(reply.json().value['mfarm:code'], 'app_install_timeout');
    assert.equal(await deviceState(dev), 'CLEANING');
  });

  test('a device that cannot install apps is not allocated for a session that needs one', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);  // webdriver, but no app-install
    const appId = await seedBuild(orgA, { packageName: 'com.acme.shop' });

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: androidCaps({ 'mfarm:appId': appId }),
    });

    assert.equal(r.json().value['mfarm:code'], 'no_capacity');
    assert.match(r.json().value.message, /can install apps/,
      'the message has to say which requirement went unmet, or the farm just looks full');
    assert.equal(await deviceState(dev), 'READY', 'never touched, so still allocatable');
  });

  test('an android reference does not resolve an ios build', async () => {
    await clearFleet();
    await seedDevices(1, { appInstall: true });
    await seedBuild(orgA, { packageName: 'com.acme.ios', versionName: '1.0', platform: 'ios' });

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: androidCaps({ 'mfarm:appId': 'com.acme.ios@latest' }),
    });
    assert.equal(r.json().value['mfarm:code'], 'no_such_app');
  });

  test('a bound session installs too, and its device is checked here, not by the allocator', async () => {
    const hubAuth = (key: string, sessionId: string) => ({
      authorization: `Basic ${Buffer.from(`${key}:${sessionId}`).toString('base64')}`,
    });
    const bindable = (appId: string) => ({
      capabilities: { alwaysMatch: { platformName: 'android', 'mfarm:appId': appId }, firstMatch: [{}] },
    });
    const allocate = async (requireCapabilities: string[]) => {
      const r = await app.inject({
        method: 'POST', url: '/v1/sessions', headers: auth(keyA),
        payload: { region: REGION, platform: 'android', requireCapabilities },
      });
      assert.equal(r.statusCode, 201, r.body);
      return r.json().session.id as string;
    };

    await clearFleet();
    await seedDevices(1);
    let appId = await seedBuild(orgA, { packageName: 'com.acme.bound' });

    // `mfarm run` allocated this one and asked for nothing but WebDriver, so the device it holds may
    // well be unable to install — the allocator was never told an install was coming. That is why
    // the capability is checked again on the device actually in hand.
    const plain = await allocate(['webdriver']);
    const refused = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubAuth(keyA, plain), payload: bindable(appId),
    });
    assert.equal(refused.json().value['mfarm:code'], 'no_app_install');
    // Left for its owner. `mfarm run` releases this session, and ending it here would stop a run
    // that is still going, from under a process that believes it holds the device.
    assert.equal(await sessionState(plain), 'ALLOCATING');

    await clearFleet();
    await seedDevices(1, { appInstall: true });
    appId = await seedBuild(orgA, { packageName: 'com.acme.bound' });
    const capable = await allocate(['webdriver', 'app-install']);
    const { reply, offered } = await createSession(bindable(appId), {}, hubAuth(keyA, capable));

    assert.equal(reply.statusCode, 200, reply.body);
    assert.equal(reply.json().value.sessionId, capable, 'it drives the session its owner allocated');
    assert.equal(reply.json().value.capabilities['mfarm:appId'], appId);
    assert.equal(offered.length, 1, 'the install is queued against the borrowed session');
  });

  test('an explicit appium:appPackage wins — preloading a build is not the same as launching it', async () => {
    await clearFleet();
    await seedDevices(1, { appInstall: true });
    const appId = await seedBuild(orgA, { packageName: 'com.acme.helper' });

    const { reply } = await createSession(androidCaps({
      'mfarm:appId': appId,
      'appium:appPackage': 'com.acme.hostapp',
      'appium:appActivity': '.MainActivity',
    }));

    assert.equal(reply.statusCode, 200, reply.body);
    const sent = (recorded.find((r) => r.url === '/session')!
      .body as { capabilities: { alwaysMatch: Record<string, unknown> } }).capabilities.alwaysMatch;
    assert.equal(sent['appium:appPackage'], 'com.acme.hostapp');
    assert.equal(sent['appium:appActivity'], '.MainActivity');
  });
});
