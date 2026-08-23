/**
 * Agent enrollment, org-pinning, and the two quarantine rules registration used to break.
 *
 * The subject here is a host nobody in this project administers — a teammate's laptop with a phone
 * on it. Three things change at that point and each has a way of failing silently: the bootstrap
 * credential stops being a fleet-wide secret, the devices must never reach the shared pool, and
 * re-registration stops being the rare event it was for a Cuttlefish host.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, withTenant, closePools } from '../src/db.ts';
import { createApiKey } from '../src/auth.ts';
import { createEnrollment, listEnrollments, revokeEnrollment } from '../src/enrollment.ts';

let app: FastifyInstance;
let orgA: string, orgB: string, keyA: string, keyB: string;
const REGION = 'enroll-test';

const auth = (k: string) => ({ authorization: `Bearer ${k}` });

/** A registration payload for a laptop with one phone on it. */
const laptop = (hostname: string, localId: string, capabilities = ALL_CAPS) => ({
  protocolVersion: 2, hostname, region: REGION,
  endpoint: 'wss://laptop.example:8443', cores: 8, memoryMb: 16384,
  capabilities: ALL_CAPS,
  devices: [{
    localId, platform: 'android' as const, tier: 'physical' as const,
    model: 'Pixel 9', osVersion: '16', capabilities, adbSerial: `SER${localId}`,
  }],
});

const ALL_CAPS = ['screen-stream', 'input-datachannel', 'snapshot-reset'];

const register = (token: string, payload: unknown) => app.inject({
  method: 'POST', url: '/v1/workers/register',
  headers: { 'x-worker-registration-token': token },
  payload: payload as Record<string, unknown>,
});

const hostRow = (hostname: string) => withSystem(async (c) =>
  (await c.query('SELECT id, org_id, state, quarantine_source FROM hosts WHERE hostname = $1',
    [hostname])).rows[0]);

const deviceRow = (localId: string) => withSystem(async (c) =>
  (await c.query('SELECT id, org_id, state, quarantined_from FROM devices WHERE local_id = $1',
    [localId])).rows[0]);

before(async () => {
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Enroll Test')
                   ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgA = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent)
                           VALUES ($1,'A',50) RETURNING id`, [`enroll-a-${randomUUID()}`])).rows[0].id;
    orgB = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent)
                           VALUES ($1,'B',50) RETURNING id`, [`enroll-b-${randomUUID()}`])).rows[0].id;
  });
  keyA = (await createApiKey(orgA)).plaintext;
  keyB = (await createApiKey(orgB)).plaintext;
  app = await buildServer({ logger: false });
});

after(async () => {
  await app.close();
  await withSystem(async (c) => {
    await c.query('DELETE FROM sessions WHERE region = $1', [REGION]);
    await c.query('DELETE FROM devices WHERE region = $1', [REGION]);
    await c.query('DELETE FROM agent_enrollments WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM hosts WHERE region = $1', [REGION]);
    await c.query('DELETE FROM api_keys WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM orgs WHERE id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await closePools();
});

describe('enrolling an agent', () => {
  test('an enrollment token registers a host and stamps the org on it and its devices', async () => {
    const { plaintext } = await createEnrollment(orgA, null, "Rakesh's laptop", 24);
    const hostname = `laptop-${randomUUID()}`;
    const localId = `phone-${randomUUID()}`;

    const r = await register(plaintext, laptop(hostname, localId));
    assert.equal(r.statusCode, 201);

    const host = await hostRow(hostname);
    assert.equal(host.org_id, orgA, 'the host belongs to the org that enrolled it');

    const device = await deviceRow(localId);
    assert.equal(device.org_id, orgA,
      'a device that cannot be powerwashed must never carry org_id NULL — that IS the shared pool');
    assert.equal(device.state, 'READY');
  });

  test('the token is single use', async () => {
    const { plaintext } = await createEnrollment(orgA, null, null, 24);
    const first = await register(plaintext, laptop(`l-${randomUUID()}`, `p-${randomUUID()}`));
    assert.equal(first.statusCode, 201);

    const second = await register(plaintext, laptop(`l-${randomUUID()}`, `p-${randomUUID()}`));
    assert.equal(second.statusCode, 401, 'a spent bootstrap credential is not a standing one');
  });

  test('an expired token is refused', async () => {
    const { plaintext } = await createEnrollment(orgA, null, null, -1);
    const r = await register(plaintext, laptop(`l-${randomUUID()}`, `p-${randomUUID()}`));
    assert.equal(r.statusCode, 401);
  });

  test('a revoked token is refused', async () => {
    const { plaintext, prefix } = await createEnrollment(orgA, null, null, 24);
    assert.equal(await revokeEnrollment(orgA, prefix), true);
    const r = await register(plaintext, laptop(`l-${randomUUID()}`, `p-${randomUUID()}`));
    assert.equal(r.statusCode, 401);
  });

  test('a wrong secret on a real prefix does not burn the enrollment', async () => {
    // The reason redemption is a SELECT ... FOR UPDATE and then a compare, rather than one
    // conditional UPDATE: an UPDATE matching on the hash would have to consume the row to discover
    // the token was wrong, so anyone who learned a prefix could destroy a colleague's enrollment
    // by guessing at it.
    const { plaintext, prefix } = await createEnrollment(orgA, null, null, 24);
    const forged = `${prefix}${'x'.repeat(30)}`;
    assert.notEqual(forged, plaintext);

    const bad = await register(forged, laptop(`l-${randomUUID()}`, `p-${randomUUID()}`));
    assert.equal(bad.statusCode, 401);

    const good = await register(plaintext, laptop(`l-${randomUUID()}`, `p-${randomUUID()}`));
    assert.equal(good.statusCode, 201, 'the real token must still work after a failed guess');
  });

  test('an unknown token says exactly what a wrong one says', async () => {
    const r = await register(`mae_${'z'.repeat(43)}`, laptop(`l-${randomUUID()}`, `p-${randomUUID()}`));
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error.message, 'Invalid or missing X-Worker-Registration-Token.',
      'the refusal must not reveal whether the prefix exists');
  });
});

describe('org-pinned devices', () => {
  test("another org can neither see nor be allocated an enrolled host's device", async () => {
    const { plaintext } = await createEnrollment(orgA, null, null, 24);
    const localId = `pinned-${randomUUID()}`;
    await register(plaintext, laptop(`l-${randomUUID()}`, localId));

    const mine = await app.inject({ method: 'GET', url: '/v1/devices', headers: auth(keyA) });
    assert.ok(mine.json().devices.some((d: { id: string }) => d.id),
      'the owning org sees its own device');

    const theirs = await app.inject({ method: 'GET', url: '/v1/devices', headers: auth(keyB) });
    const dev = await deviceRow(localId);
    assert.ok(!theirs.json().devices.some((d: { id: string }) => d.id === dev.id),
      'devices_visible scopes on org_id; a pinned device is not another org\'s to see');

    // And the allocator agrees, which is the half that actually matters — visibility is a UI
    // concern, allocation is a tenant leak. `allocate_device` filters on
    // (d.org_id IS NULL OR d.org_id = p_org) and needed no change for this.
    const s = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: { ...auth(keyB), 'idempotency-key': randomUUID() },
      payload: { region: REGION, platform: 'android', tier: 'physical' },
    });
    assert.equal(s.json().session.state, 'QUEUED',
      'orgB must queue forever rather than be handed orgA\'s phone');
  });
});

describe('re-registration', () => {
  test("a host's own worker token re-registers it and keeps its org", async () => {
    // An agent re-registers whenever its capability fingerprint changes, and an enrollment token is
    // spent by then. Without this path a laptop could never plug in a second phone.
    const { plaintext } = await createEnrollment(orgA, null, null, 24);
    const hostname = `l-${randomUUID()}`;
    const first = await register(plaintext, laptop(hostname, `p-${randomUUID()}`));
    const workerToken = first.json().workerToken;

    const second = await register(workerToken, laptop(hostname, `p2-${randomUUID()}`));
    assert.equal(second.statusCode, 201);
    assert.equal((await hostRow(hostname)).org_id, orgA, 'the org survives re-registration');
  });

  test('a worker token cannot register under another hostname', async () => {
    const { plaintext } = await createEnrollment(orgA, null, null, 24);
    const mine = `l-${randomUUID()}`;
    const workerToken = (await register(plaintext, laptop(mine, `p-${randomUUID()}`))).json().workerToken;

    const r = await register(workerToken, laptop(`someone-else-${randomUUID()}`, `p-${randomUUID()}`));
    assert.equal(r.statusCode, 401,
      'otherwise a compromised agent rewrites another host\'s endpoint and takes its sessions');
  });

  test('the fleet secret still registers an operator host, org-less and shared', async () => {
    const hostname = `cf-${randomUUID()}`;
    const localId = `cf-dev-${randomUUID()}`;
    const r = await register('test-registration-secret', {
      ...laptop(hostname, localId), devices: [{
        localId, platform: 'android', tier: 'cuttlefish', model: 'cf_x86_64', osVersion: '17',
        capabilities: ALL_CAPS,
      }],
    });
    assert.equal(r.statusCode, 201);
    assert.equal((await hostRow(hostname)).org_id, null);
    assert.equal((await deviceRow(localId)).org_id, null, 'NULL org_id is the shared pool, unchanged');
  });
});

describe('registration and quarantine', () => {
  test('re-registering does not lift an operator quarantine', async () => {
    // Migration 016 split the two kinds precisely because a packet from a host cannot answer an
    // operator's judgement about it. The heartbeat respected that; registration cleared every
    // quarantine unconditionally, which was harmless only while a healthy agent never re-registered.
    const { plaintext } = await createEnrollment(orgA, null, null, 24);
    const hostname = `q-${randomUUID()}`;
    const localId = `qd-${randomUUID()}`;
    const workerToken = (await register(plaintext, laptop(hostname, localId))).json().workerToken;
    const { id: hostId } = await hostRow(hostname);

    await withSystem((c) => c.query("SELECT quarantine_host($1, 'taken out of service', 'operator')", [hostId]));

    const again = await register(workerToken, laptop(hostname, localId));
    assert.equal(again.statusCode, 201, 'it may still register — it just does not get to argue');

    const host = await hostRow(hostname);
    assert.equal(host.state, 'QUARANTINED');
    assert.equal(host.quarantine_source, 'operator');
    assert.equal((await deviceRow(localId)).state, 'QUARANTINED',
      'and its devices stay out of the pool');
  });

  test('re-registering DOES lift a silence quarantine, and restores what each device was doing', async () => {
    const { plaintext } = await createEnrollment(orgA, null, null, 24);
    const hostname = `q2-${randomUUID()}`;
    const localId = `qd2-${randomUUID()}`;
    const workerToken = (await register(plaintext, laptop(hostname, localId))).json().workerToken;
    const { id: hostId } = await hostRow(hostname);

    // CLEANING is the state that matters: a session ended and no worker has confirmed the reset.
    await withSystem((c) => c.query("UPDATE devices SET state = 'CLEANING' WHERE local_id = $1", [localId]));
    await withSystem((c) => c.query("SELECT quarantine_host($1, 'no heartbeat for 90s', 'reaper')", [hostId]));
    assert.equal((await deviceRow(localId)).quarantined_from, 'CLEANING');

    const again = await register(workerToken, laptop(hostname, localId));
    assert.equal(again.statusCode, 201);

    assert.equal((await hostRow(hostname)).state, 'UP');
    const dev = await deviceRow(localId);
    assert.equal(dev.state, 'CLEANING',
      'promoting it to READY would hand the next tenant the last one\'s data — the leak CLEANING exists to prevent');
    assert.equal(dev.quarantined_from, null);
  });
});

describe('the enrollment list', () => {
  test('is scoped to the org, and never returns the secret', async () => {
    const { prefix, plaintext } = await createEnrollment(orgA, null, 'listed', 24);
    const mine = await listEnrollments(orgA);
    const row = mine.find((e) => e.prefix === prefix);
    assert.ok(row, 'the owning org sees it');
    assert.equal(row.label, 'listed');
    // The prefix is meant to be here — it is what a person matches against the token they pasted
    // into a laptop, and it is safe to log. The SECRET is what must be unrecoverable.
    assert.equal(row.prefix, prefix);
    assert.ok(!JSON.stringify(row).includes(plaintext.slice(12)),
      'only a sha256 is stored; the plaintext is returned exactly once, at creation');

    const theirs = await listEnrollments(orgB);
    assert.ok(!theirs.some((e) => e.prefix === prefix));
  });

  test('the tenant pool cannot write the table', async () => {
    // 001's ALTER DEFAULT PRIVILEGES attaches the full grant to every table the owner creates, so
    // this arrived writable until 023 revoked it. Same trap migration 014 hit.
    await assert.rejects(
      withTenant(orgA, (c) => c.query(
        `INSERT INTO agent_enrollments (org_id, prefix, token_hash, expires_at)
         VALUES ($1,$2,$3, now() + interval '1 day')`,
        [orgA, `mae_forged${randomUUID()}`.slice(0, 12), 'x'],
      )),
      /permission denied/i,
    );
  });
});
