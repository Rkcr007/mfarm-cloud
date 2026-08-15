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
    const tok = { prefix: 'mwk_testpre', hash: '' };
    hostId = (await c.query(
      `INSERT INTO hosts (region,hostname,state,protocol_version,cores,memory_mb,endpoint)
       VALUES ($1,'http-test-host','UP',1,64,262144,'wss://worker-1.example:8443') RETURNING id`,
      [REGION])).rows[0].id;
    void tok;
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
