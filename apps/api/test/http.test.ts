/**
 * HTTP layer and auth.
 *
 * Focus is the boundary: who can call what, what leaks in an error, and whether a retry costs the
 * customer twice. Uses fastify.inject() so no port is bound.
 */
process.env.RATE_LIMIT_MAX = '10000';          // the limiter has its own test below
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { createApiKey, generateApiKey } from '../src/auth.ts';
import { verifySessionToken } from '../src/tokens.ts';

let app: FastifyInstance;
let orgA: string, orgB: string, hostId: string;
let keyA: string, keyB: string, workerToken: string;
const REGION = 'http-test';

const auth = (k: string) => ({ authorization: `Bearer ${k}` });

async function seedDevices(n: number) {
  return withSystem(async (c) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const { rows } = await c.query(
        `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, capabilities, local_id)
         VALUES ($1,$2,'android','cuttlefish','cf_x86_64','15','READY',
                 '["screen-stream","input-datachannel","snapshot-reset"]'::jsonb, $3)
         RETURNING id`,
        [hostId, REGION, `seed-${randomUUID()}`],
      );
      ids.push(rows[0].id);
    }
    return ids;
  });
}

const clearDevices = () => withSystem(async (c) => {
  await c.query('DELETE FROM idempotency_keys');
  await c.query('DELETE FROM metering_events');
  await c.query('DELETE FROM sessions');
  await c.query('DELETE FROM devices WHERE host_id = $1', [hostId]);
});

before(async () => {
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'HTTP Test')
                   ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgA = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent)
                           VALUES ('http-a','A',50) RETURNING id`)).rows[0].id;
    orgB = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent)
                           VALUES ('http-b','B',50) RETURNING id`)).rows[0].id;
    hostId = (await c.query(
      `INSERT INTO hosts (region,hostname,state,protocol_version,cores,memory_mb,endpoint,last_heartbeat_at)
       VALUES ($1,'http-test-host','UP',1,64,262144,'wss://worker-1.example:8443', now()) RETURNING id`,
      [REGION])).rows[0].id;
  });
  keyA = (await createApiKey(orgA)).plaintext;
  keyB = (await createApiKey(orgB)).plaintext;
  app = await buildServer({ logger: false });
});

after(async () => {
  await app.close();
  await withSystem(async (c) => {
    await c.query('DELETE FROM idempotency_keys');
    await c.query('DELETE FROM metering_events');
    await c.query('DELETE FROM sessions');
    await c.query('DELETE FROM devices WHERE host_id IN (SELECT id FROM hosts WHERE region = $1)', [REGION]);
    await c.query('DELETE FROM api_keys WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM hosts WHERE region = $1', [REGION]);
    await c.query('DELETE FROM orgs WHERE id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await closePools();
});

describe('auth boundary', () => {
  test('health needs no credentials', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(r.statusCode, 200);
  });

  test('a protected route without credentials is 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/devices' });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error.code, 'unauthorized');
  });

  test('a well-formed but unknown key is 401', async () => {
    const r = await app.inject({
      method: 'GET', url: '/v1/devices', headers: auth(generateApiKey().plaintext),
    });
    assert.equal(r.statusCode, 401);
  });

  test('a key that shares a prefix but not the secret is rejected', async () => {
    // Guards the lookup-by-prefix design: the prefix is an index, never the credential.
    const forged = keyA.slice(0, 12) + 'x'.repeat(keyA.length - 12);
    const r = await app.inject({ method: 'GET', url: '/v1/devices', headers: auth(forged) });
    assert.equal(r.statusCode, 401);
  });

  test('a revoked key stops working', async () => {
    const temp = await createApiKey(orgA);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/devices', headers: auth(temp.plaintext) })).statusCode, 200);
    await withSystem((c) => c.query('UPDATE api_keys SET revoked_at = now() WHERE prefix = $1', [temp.prefix]));
    assert.equal((await app.inject({ method: 'GET', url: '/v1/devices', headers: auth(temp.plaintext) })).statusCode, 401);
  });

  test('error bodies never echo the credential', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/devices', headers: auth(keyA + 'tampered') });
    assert.equal(r.statusCode, 401);
    assert.ok(!r.body.includes(keyA.slice(4)), 'response must not contain any part of the secret');
  });
});

describe('principal separation', () => {
  before(async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/workers/register',
      headers: { 'x-worker-registration-token': 'test-registration-secret' },
      payload: {
        protocolVersion: 1, hostname: 'http-test-host', region: REGION,
        endpoint: 'wss://worker-1.example:8443', cores: 64, memoryMb: 262144,
        capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset'],
        devices: [],
      },
    });
    workerToken = r.json().workerToken;
  });

  test('a worker token cannot read tenant data', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/devices', headers: auth(workerToken) });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error.code, 'forbidden');
  });

  test('a tenant key cannot post worker events', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/workers/events', headers: auth(keyA), payload: {},
    });
    assert.equal(r.statusCode, 403);
  });

  test('registration requires the bootstrap token', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/workers/register',
      headers: { 'x-worker-registration-token': 'wrong' },
      payload: { protocolVersion: 1, hostname: 'x', region: REGION, cores: 1, memoryMb: 1, capabilities: [], devices: [] },
    });
    assert.equal(r.statusCode, 401);
  });

  test('a device lacking snapshot-reset registers but is not READY', async () => {
    const localId = `nores-${randomUUID()}`;
    const reReg = await app.inject({
      method: 'POST', url: '/v1/workers/register',
      headers: { 'x-worker-registration-token': 'test-registration-secret' },
      payload: {
        protocolVersion: 1, hostname: 'http-test-host', region: REGION,
        endpoint: 'wss://worker-1.example:8443', cores: 64, memoryMb: 262144,
        capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset'],
        devices: [{ localId, platform: 'android', tier: 'cuttlefish', model: 'cf', osVersion: '15',
                    capabilities: ['screen-stream', 'input-datachannel'] }],
      },
    });
    // Registration is the credential-issuing operation, so re-registering rotates the token.
    // Track the newest one, exactly as a real worker would persist it.
    workerToken = reReg.json().workerToken;

    const state = await withSystem(async (c) =>
      (await c.query('SELECT state FROM devices WHERE local_id = $1', [localId])).rows[0].state);
    assert.equal(state, 'OFFLINE', 'must not be allocatable — it would leak the previous tenant');
    await withSystem((c) => c.query('DELETE FROM devices WHERE local_id = $1', [localId]));
  });

  test('a device that gains the missing capability is promoted out of OFFLINE', async () => {
    // Registration deliberately leaves most states alone, which used to mean OFFLINE was a trap: a
    // device that registered unschedulable stayed that way forever. Observed on the lab VM — cf-2's
    // first snapshot failed, the next run took one, and the control plane still said OFFLINE.
    const localId = `promote-${randomUUID()}`;
    const register = (capabilities: string[]) => app.inject({
      method: 'POST', url: '/v1/workers/register',
      headers: { 'x-worker-registration-token': 'test-registration-secret' },
      payload: {
        protocolVersion: 1, hostname: 'http-test-host', region: REGION,
        endpoint: 'wss://worker-1.example:8443', cores: 64, memoryMb: 262144,
        capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset'],
        devices: [{ localId, platform: 'android', tier: 'cuttlefish', model: 'cf', osVersion: '15', capabilities }],
      },
    });
    const stateOf = async () => (await withSystem(async (c) =>
      (await c.query('SELECT state FROM devices WHERE local_id = $1', [localId])).rows[0]))?.state;

    await register(['screen-stream', 'input-datachannel']);
    assert.equal(await stateOf(), 'OFFLINE');

    const promoted = await register(['screen-stream', 'input-datachannel', 'snapshot-reset']);
    workerToken = promoted.json().workerToken;
    assert.equal(await stateOf(), 'READY', 'a device that can now be reset must rejoin the pool');

    // And symmetrically: losing it takes the device back out, exactly as withdrawing an automation
    // endpoint does. A device that cannot be wiped must not keep taking tenants.
    const demoted = await register(['screen-stream', 'input-datachannel']);
    workerToken = demoted.json().workerToken;
    assert.equal(await stateOf(), 'OFFLINE');

    await withSystem((c) => c.query('DELETE FROM devices WHERE local_id = $1', [localId]));
  });

  test('registration does not disturb a device that is mid-session', async () => {
    const localId = `insession-${randomUUID()}`;
    const reg = await app.inject({
      method: 'POST', url: '/v1/workers/register',
      headers: { 'x-worker-registration-token': 'test-registration-secret' },
      payload: {
        protocolVersion: 1, hostname: 'http-test-host', region: REGION,
        endpoint: 'wss://worker-1.example:8443', cores: 64, memoryMb: 262144,
        capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset'],
        devices: [{ localId, platform: 'android', tier: 'cuttlefish', model: 'cf', osVersion: '15',
                    capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset'] }],
      },
    });
    workerToken = reg.json().workerToken;
    await withSystem((c) => c.query(`UPDATE devices SET state = 'SESSION_ACTIVE' WHERE local_id = $1`, [localId]));

    // An agent restart must not yank a device out from under a running session, nor hand back one
    // still being cleaned. Only READY <-> OFFLINE is registration's to decide.
    const again = await app.inject({
      method: 'POST', url: '/v1/workers/register',
      headers: { 'x-worker-registration-token': 'test-registration-secret' },
      payload: {
        protocolVersion: 1, hostname: 'http-test-host', region: REGION,
        endpoint: 'wss://worker-1.example:8443', cores: 64, memoryMb: 262144,
        capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset'],
        devices: [{ localId, platform: 'android', tier: 'cuttlefish', model: 'cf', osVersion: '15',
                    capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset'] }],
      },
    });
    workerToken = again.json().workerToken;
    const state = await withSystem(async (c) =>
      (await c.query('SELECT state FROM devices WHERE local_id = $1', [localId])).rows[0].state);
    assert.equal(state, 'SESSION_ACTIVE');
    await withSystem((c) => c.query('DELETE FROM devices WHERE local_id = $1', [localId]));
  });
});

describe('session creation', () => {
  test('allocates and returns a verifiable data-plane token', async () => {
    await clearDevices();
    await seedDevices(1);
    const r = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(keyA),
      payload: { region: REGION, platform: 'android' },
    });
    assert.equal(r.statusCode, 201);
    const body = r.json();
    assert.equal(body.session.state, 'ALLOCATING');
    assert.equal(body.dataPlane.endpoint, 'wss://worker-1.example:8443');

    const v = verifySessionToken(body.dataPlane.token, app.signingKey.publicKeyPem, hostId);
    assert.equal(v.ok, true, 'worker must be able to verify offline');
    assert.equal(v.ok && v.claims.sid, body.session.id);
    assert.equal(v.ok && v.claims.fence, body.session.fence);
  });

  test('a token minted for one host is rejected by another', async () => {
    await clearDevices();
    await seedDevices(1);
    const r = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(keyA),
      payload: { region: REGION, platform: 'android' },
    });
    const v = verifySessionToken(r.json().dataPlane.token, app.signingKey.publicKeyPem, randomUUID());
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, 'wrong_audience');
  });

  test('an expired token is rejected', async () => {
    await clearDevices();
    await seedDevices(1);
    const r = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(keyA),
      payload: { region: REGION, platform: 'android' },
    });
    const future = Math.floor(Date.now() / 1000) + 99999;
    const v = verifySessionToken(r.json().dataPlane.token, app.signingKey.publicKeyPem, hostId, future);
    assert.equal(v.ok === false && v.reason, 'expired');
  });

  test('no free device queues with 202 rather than failing', async () => {
    await clearDevices();
    await seedDevices(1);
    await app.inject({ method: 'POST', url: '/v1/sessions', headers: auth(keyA),
                       payload: { region: REGION, platform: 'android' } });
    const second = await app.inject({ method: 'POST', url: '/v1/sessions', headers: auth(keyB),
                                      payload: { region: REGION, platform: 'android' } });
    assert.equal(second.statusCode, 202);
    assert.equal(second.json().session.state, 'QUEUED');
  });

  test('invalid platform is a 400 with a usable message', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/sessions', headers: auth(keyA),
                                 payload: { region: REGION, platform: 'windows-phone' } });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error.code, 'bad_request');
  });

  test('unknown body fields are rejected, not silently ignored', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/sessions', headers: auth(keyA),
                                 payload: { region: REGION, platform: 'android', ttlMinutes: 5, typo: true } });
    assert.equal(r.statusCode, 400);
  });
});

describe('idempotency', () => {
  test('a retried request returns the first response and allocates once', async () => {
    await clearDevices();
    await seedDevices(2);
    const key = randomUUID();
    const payload = { region: REGION, platform: 'android' };

    const first = await app.inject({ method: 'POST', url: '/v1/sessions',
      headers: { ...auth(keyA), 'idempotency-key': key }, payload });
    const second = await app.inject({ method: 'POST', url: '/v1/sessions',
      headers: { ...auth(keyA), 'idempotency-key': key }, payload });

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.equal(second.headers['idempotent-replay'], 'true');
    assert.equal(first.json().session.id, second.json().session.id, 'same session, not a second one');

    const live = await withSystem(async (c) =>
      (await c.query(`SELECT count(*)::int AS n FROM sessions
                       WHERE org_id = $1 AND state IN ('ALLOCATING','ACTIVE')`, [orgA])).rows[0].n);
    assert.equal(live, 1, 'a retry must not consume a second device or a second bill');
  });

  test('two concurrent retries of one key do not allocate two devices', async () => {
    // The retry that matters is the one sent because the first request is taking too long, so it
    // arrives while the first is still running. "Check, then allocate, then record" misses that
    // window entirely and bills the customer twice for one session.
    await clearDevices();
    await seedDevices(2);
    const key = randomUUID();
    const payload = { region: REGION, platform: 'android' };
    const headers = { ...auth(keyA), 'idempotency-key': key };

    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/sessions', headers, payload }),
      app.inject({ method: 'POST', url: '/v1/sessions', headers, payload }),
    ]);

    const live = await withSystem(async (c) =>
      (await c.query(`SELECT count(*)::int AS n FROM sessions
                       WHERE org_id = $1 AND state IN ('ALLOCATING','ACTIVE')`, [orgA])).rows[0].n);
    assert.equal(live, 1, 'one key, one session, one bill');

    const busy = [a, b].filter((r) => r.statusCode === 409);
    const created = [a, b].filter((r) => r.statusCode === 201);
    assert.equal(busy.length + created.length, 2, `unexpected statuses: ${a.statusCode}/${b.statusCode}`);
    // Whichever loses the race is told to retry rather than being handed a second device.
    if (busy.length > 0) assert.equal(busy[0].json().error.code, 'idempotency_in_flight');
    if (created.length === 2) {
      assert.equal(created[0].json().session.id, created[1].json().session.id, 'same session replayed');
    }
  });

  test('a failed request releases its key so the retry is not locked out', async () => {
    // Claiming the key before doing the work means a transient failure could otherwise burn it: the
    // client's own retry would collide with its abandoned claim and 409 until the TTL expired.
    await clearDevices();
    const brokenHost = await withSystem(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO hosts (region,hostname,state,protocol_version,cores,memory_mb,last_heartbeat_at)
         VALUES ($1,'no-endpoint-host','UP',1,4,4096, now()) RETURNING id`, [REGION]);
      await c.query(
        `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, capabilities, local_id)
         VALUES ($1,$2,'android','cuttlefish','cf','15','READY','[]'::jsonb,$3)`,
        [rows[0].id, REGION, `broken-${randomUUID()}`]);
      return rows[0].id;
    });

    const key = randomUUID();
    const headers = { ...auth(keyA), 'idempotency-key': key };
    const payload = { region: REGION, platform: 'android' };

    const failed = await app.inject({ method: 'POST', url: '/v1/sessions', headers, payload });
    assert.equal(failed.statusCode, 400, 'a host with no data-plane endpoint cannot serve a session');

    await withSystem(async (c) => {
      await c.query('DELETE FROM sessions WHERE org_id = $1', [orgA]);
      await c.query('DELETE FROM devices WHERE host_id = $1', [brokenHost]);
      await c.query('DELETE FROM hosts WHERE id = $1', [brokenHost]);
    });
    await seedDevices(1);

    const retry = await app.inject({ method: 'POST', url: '/v1/sessions', headers, payload });
    assert.equal(retry.statusCode, 201, 'the same key must work once the cause is fixed');
  });

  test('an oversized Idempotency-Key is rejected rather than indexed', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/sessions',
      headers: { ...auth(keyA), 'idempotency-key': 'x'.repeat(300) },
      payload: { region: REGION, platform: 'android' },
    });
    assert.equal(r.statusCode, 400);
  });

  test('reusing a key with a different body is a 409', async () => {
    await clearDevices();
    await seedDevices(2);
    const key = randomUUID();
    await app.inject({ method: 'POST', url: '/v1/sessions',
      headers: { ...auth(keyA), 'idempotency-key': key }, payload: { region: REGION, platform: 'android' } });
    const r = await app.inject({ method: 'POST', url: '/v1/sessions',
      headers: { ...auth(keyA), 'idempotency-key': key },
      payload: { region: REGION, platform: 'android', ttlMinutes: 99 } });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error.code, 'idempotency_key_reuse');
  });

  test('the same key in two orgs does not collide', async () => {
    await clearDevices();
    await seedDevices(2);
    const key = 'shared-key-value';
    const a = await app.inject({ method: 'POST', url: '/v1/sessions',
      headers: { ...auth(keyA), 'idempotency-key': key }, payload: { region: REGION, platform: 'android' } });
    const b = await app.inject({ method: 'POST', url: '/v1/sessions',
      headers: { ...auth(keyB), 'idempotency-key': key }, payload: { region: REGION, platform: 'android' } });
    assert.equal(a.statusCode, 201);
    assert.equal(b.statusCode, 201);
    assert.notEqual(a.json().session.id, b.json().session.id);
  });
});

/**
 * Known issue 9. `GET /v1/sessions/:id` used to return the session and nothing else, which broke two
 * things quietly: a session created on the QUEUED path never got data-plane coordinates at all — the
 * POST that created it had no device to name — and a session token lives 120 seconds, so even the
 * immediate path went stale during any run longer than two minutes with nowhere to refresh.
 */
describe('data-plane coordinates on GET', () => {
  test('a live session carries an endpoint and a token that verifies', async () => {
    await clearDevices();
    const [deviceId] = await seedDevices(1);
    const created = await app.inject({ method: 'POST', url: '/v1/sessions', headers: auth(keyA),
                                       payload: { region: REGION, platform: 'android' } });
    assert.equal(created.statusCode, 201);
    const id = created.json().session.id;

    const got = await app.inject({ method: 'GET', url: `/v1/sessions/${id}`, headers: auth(keyA) });
    assert.equal(got.statusCode, 200);
    const dp = got.json().dataPlane;
    assert.ok(dp, 'a live session must carry coordinates');
    assert.equal(dp.endpoint, created.json().dataPlane.endpoint);

    // Verified against the host it names, not merely parsed. A token that parses and does not
    // verify is the failure that reaches the worker instead of the test.
    const v = verifySessionToken(dp.token, app.signingKey.publicKeyPem, hostId);
    assert.equal(v.ok, true, 'the worker must be able to verify this offline');
    assert.equal(v.ok && v.claims.sid, id);
    assert.equal(v.ok && v.claims.did, deviceId);
    assert.equal(v.ok && v.claims.org, orgA);
    // The fence is what makes a replayed command refusable, and it must be the session's own.
    assert.equal(v.ok && v.claims.fence, created.json().session.fence);
  });

  test('a token minted here names the same host as the one minted at creation', async () => {
    await clearDevices();
    await seedDevices(1);
    const created = await app.inject({ method: 'POST', url: '/v1/sessions', headers: auth(keyA),
                                       payload: { region: REGION, platform: 'android' } });
    const id = created.json().session.id;
    const got = await app.inject({ method: 'GET', url: `/v1/sessions/${id}`, headers: auth(keyA) });
    // `aud` is the host the worker checks the token against, and it is checked offline — a refreshed
    // token naming a different host is simply rejected, and the symptom is a session that worked
    // and then stopped mid-run. Verifying both against the same hostId is the assertion.
    for (const token of [created.json().dataPlane.token, got.json().dataPlane.token]) {
      assert.equal(verifySessionToken(token, app.signingKey.publicKeyPem, hostId).ok, true);
    }
  });

  test('a queued session gets no coordinates, because there is no device to name', async () => {
    await clearDevices();                       // no devices at all
    const created = await app.inject({ method: 'POST', url: '/v1/sessions', headers: auth(keyA),
                                       payload: { region: REGION, platform: 'android' } });
    assert.equal(created.statusCode, 202);
    const got = await app.inject({
      method: 'GET', url: `/v1/sessions/${created.json().session.id}`, headers: auth(keyA),
    });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().session.state, 'QUEUED');
    assert.equal(got.json().dataPlane, undefined);
  });

  test('an ended session gets no coordinates', async () => {
    await clearDevices();
    await seedDevices(1);
    const created = await app.inject({ method: 'POST', url: '/v1/sessions', headers: auth(keyA),
                                       payload: { region: REGION, platform: 'android' } });
    const id = created.json().session.id;
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/sessions/${id}`, headers: auth(keyA) })).statusCode, 204);

    const got = await app.inject({ method: 'GET', url: `/v1/sessions/${id}`, headers: auth(keyA) });
    assert.equal(got.statusCode, 200);
    // The device is already in CLEANING and will be handed to someone else. A token naming it would
    // be a credential for another tenant's device — the worker's fence check would reject it, but a
    // token that has to be rejected should never have been minted.
    assert.equal(got.json().dataPlane, undefined);
  });
});

describe('tenant isolation over HTTP', () => {
  test("another org's session is 404, not 403", async () => {
    await clearDevices();
    await seedDevices(1);
    const created = await app.inject({ method: 'POST', url: '/v1/sessions', headers: auth(keyA),
                                       payload: { region: REGION, platform: 'android' } });
    const id = created.json().session.id;

    const asB = await app.inject({ method: 'GET', url: `/v1/sessions/${id}`, headers: auth(keyB) });
    // 403 would confirm the id exists. 404 leaks nothing.
    assert.equal(asB.statusCode, 404);

    const asA = await app.inject({ method: 'GET', url: `/v1/sessions/${id}`, headers: auth(keyA) });
    assert.equal(asA.statusCode, 200);
  });

  test("another org cannot delete a session it does not own", async () => {
    await clearDevices();
    await seedDevices(1);
    const created = await app.inject({ method: 'POST', url: '/v1/sessions', headers: auth(keyA),
                                       payload: { region: REGION, platform: 'android' } });
    const id = created.json().session.id;
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/sessions/${id}`, headers: auth(keyB) })).statusCode, 404);
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/sessions/${id}`, headers: auth(keyA) })).statusCode, 204);
  });
});

describe('rate limiting', () => {
  /** A second server with a tiny limit, so the shared one stays usable for every other test. */
  async function strictServer(max: number) {
    const previous = process.env.RATE_LIMIT_MAX;
    process.env.RATE_LIMIT_MAX = String(max);
    const strict = await buildServer({ logger: false });
    process.env.RATE_LIMIT_MAX = previous;
    return strict;
  }

  test('an authenticated caller is limited per org, not per IP', async () => {
    const strict = await strictServer(3);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await strict.inject({ method: 'GET', url: '/v1/devices', headers: auth(keyA) })).statusCode);
    }
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);

    // A different org shares the IP (one CI fleet behind one NAT is not everyone's problem).
    const other = await strict.inject({ method: 'GET', url: '/v1/devices', headers: auth(keyB) });
    assert.equal(other.statusCode, 200, 'org B must not be throttled by org A');
    await strict.close();
  });

  test('unauthenticated attempts are limited too', async () => {
    // The gap this closes: rejecting a bad credential before the limiter's hook runs leaves key
    // guessing — and registration-token guessing — completely unlimited, at one database round trip
    // per attempt.
    const strict = await strictServer(3);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await strict.inject({
        method: 'GET', url: '/v1/devices', headers: auth(generateApiKey().plaintext),
      });
      codes.push(r.statusCode);
    }
    assert.deepEqual(codes, [401, 401, 401, 429, 429], 'guessing must hit a wall, not a database');
    await strict.close();
  });

  test('an oversized body is a 413, not a crash report', async () => {
    // Fastify throws this with a status attached rather than as our own ApiError. Rendering it as a
    // 500 tells the caller to file a bug for a mistake only they can fix, and buries real crashes
    // among false alarms in the log.
    const tooBig = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(keyA),
      payload: { region: REGION, platform: 'android', requested: { pad: 'x'.repeat(1_100_000) } },
    });
    assert.equal(tooBig.statusCode, 413);
    assert.equal(tooBig.json().error.code, 'payload_too_large');
  });

  test('a 429 stays in the error shape clients already parse', async () => {
    const strict = await strictServer(1);
    await strict.inject({ method: 'GET', url: '/v1/devices', headers: auth(keyA) });
    const limited = await strict.inject({ method: 'GET', url: '/v1/devices', headers: auth(keyA) });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'rate_limited');
    await strict.close();
  });
});

describe('worker events', () => {
  test('metering batches are idempotent across retries', async () => {
    await clearDevices();
    await seedDevices(1);
    const s = await app.inject({ method: 'POST', url: '/v1/sessions', headers: auth(keyA),
                                 payload: { region: REGION, platform: 'android' } });
    const { id: sessionId, deviceId } = s.json().session;
    const batch = {
      metering: [{
        eventId: randomUUID(), orgId: orgA, sessionId, deviceId,
        kind: 'device_seconds', quantity: 30, occurredAt: new Date().toISOString(),
      }],
    };
    const first = await app.inject({ method: 'POST', url: '/v1/workers/events', headers: auth(workerToken), payload: batch });
    const retry = await app.inject({ method: 'POST', url: '/v1/workers/events', headers: auth(workerToken), payload: batch });
    assert.equal(first.json().meteringRecorded, 1);
    assert.equal(retry.json().meteringRecorded, 0);
    assert.equal(retry.json().meteringDuplicates, 1);
    assert.equal(retry.json().meteringRejected, 0);
  });

  test('a worker cannot bill another org by naming it (migration 008)', async () => {
    await clearDevices();
    await seedDevices(1);
    const s = await app.inject({ method: 'POST', url: '/v1/sessions', headers: auth(keyA),
                                 payload: { region: REGION, platform: 'android' } });
    const { id: sessionId, deviceId } = s.json().session;

    // orgB is named in the payload; the session belongs to orgA. The claim is simply not consulted.
    const r = await app.inject({
      method: 'POST', url: '/v1/workers/events', headers: auth(workerToken),
      payload: { metering: [{
        eventId: randomUUID(), orgId: orgB, sessionId, deviceId,
        kind: 'device_seconds', quantity: 30, occurredAt: new Date().toISOString(),
      }] },
    });
    assert.equal(r.json().meteringRecorded, 1);
    assert.equal(r.json().meteringRejected, 0);

    const charged = await withSystem(async (c) =>
      (await c.query('SELECT org_id FROM metering_events WHERE session_id = $1', [sessionId])).rows[0].org_id);
    assert.equal(charged, orgA, 'the session decides who pays, not the request body');
  });

  test('a stale reset is reported, not fatal to the batch', async () => {
    await clearDevices();
    const [dev] = await seedDevices(1);
    const r = await app.inject({
      method: 'POST', url: '/v1/workers/events', headers: auth(workerToken),
      payload: { resets: [{ deviceId: dev, fence: 999 }] },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().resets[0].accepted, false);
  });

  test('heartbeat tells a quarantined host it must drain', async () => {
    await withSystem((c) => c.query(`SELECT quarantine_host($1,'test')`, [hostId]));
    const r = await app.inject({ method: 'POST', url: '/v1/workers/heartbeat', headers: auth(workerToken) });
    assert.equal(r.json().hostState, 'QUARANTINED');
    await withSystem((c) => c.query(`UPDATE hosts SET state='UP', quarantined_at=NULL WHERE id=$1`, [hostId]));
  });
});
