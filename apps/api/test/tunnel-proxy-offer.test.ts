/**
 * WHICH DEVICES MAY REACH A PRIVATE NETWORK, asked one beat before a device asks — ADR-0037.
 *
 * WHY THIS FILE EXISTS. ADR-0037 shipped the whole path from a device's HTTP client to a host on
 * the customer's network, tested end to end over real sockets, and shipped it unreachable: nothing
 * ever told a guest to use a proxy, so `DeviceProxy` had no caller outside its own test and the
 * feature could not work on a farm. `proxies` on the heartbeat is the missing offer, and these
 * tests are about it being made to exactly the right devices and to nobody else.
 *
 * ---------------------------------------------------------------- what these tests are careful about
 *
 * **The refusals matter more than the offer.** A wrongly-offered device is a live route from
 * somebody's test phone into somebody's private network, so most of what follows asserts absence:
 * no session, no tunnel, another host's device, a session that has ended.
 *
 * **It must agree with `routeFor`, which is the other half.** This decides which guest is POINTED
 * at a proxy; `proxy-router.ts` decides whether a request that arrives is routed. A device allocated
 * on one reading and refused on the other installs, runs for four minutes and reaches nothing — so
 * both bags (`requested` and `constraints`) and both spellings are exercised here for the same
 * reason `pickTunnel` reads both.
 *
 * **The tunnel's NAME is asserted absent.** Architecture rule 4: a worker names only its own
 * devices. A worker that learned the name would be a worker that could ask for a different one.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { allocate, release } from '../src/allocator.ts';
import { TUNNEL_CAPABILITY } from '@mfarm/protocol';

const REGION = `tun-offer-${randomUUID().slice(0, 8)}`;

let app: FastifyInstance;
let orgId: string;
let hostId: string;
let workerToken: string;
let otherHostId: string;
let otherWorkerToken: string;

interface Offer { deviceId: string; localId: string }

/** What this host's beat says about proxies right now. */
async function beat(token = workerToken): Promise<Offer[]> {
  const res = await app.inject({
    method: 'POST', url: '/v1/workers/heartbeat',
    headers: { authorization: `Bearer ${token}` },
    payload: { protocolVersion: 2, capabilities: [], devices: {} },
  });
  assert.equal(res.statusCode, 200, `heartbeat failed: ${res.body}`);
  return (res.json().proxies ?? []) as Offer[];
}

/** A READY device on `host`, with the local id the whole proxy path names it by. */
async function seedDevice(host: string, localId: string): Promise<string> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO devices (host_id, org_id, region, platform, tier, model, os_version, state,
                            local_id, capabilities)
       VALUES ($1, NULL, $2, 'android', 'cuttlefish', 'cf_x86_64', '17', 'READY', $3,
               '["screen-stream","input-datachannel","snapshot-reset","network-proxy"]'::jsonb)
       RETURNING id`,
      [host, REGION, localId],
    );
    return rows[0].id as string;
  });
}

async function registerHost(name: string): Promise<{ hostId: string; token: string }> {
  const r = await app.inject({
    method: 'POST', url: '/v1/workers/register',
    headers: { 'x-worker-registration-token': 'test-registration-secret' },
    payload: {
      protocolVersion: 2, hostname: `${name}-${randomUUID().slice(0, 8)}`, region: REGION,
      endpoint: 'wss://worker-tun.example:8443', cores: 16, memoryMb: 65536,
      capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset', 'network-proxy'],
      devices: [],
    },
  });
  assert.equal(r.statusCode, 201, `worker registration failed: ${r.body}`);
  return { hostId: r.json().hostId, token: r.json().workerToken };
}

/** Remove every device and session this file made, so one test cannot decide the next one. */
async function wipe(): Promise<void> {
  await withSystem(async (c) => {
    await c.query('DELETE FROM sessions WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM devices WHERE host_id = ANY($1::uuid[])', [[hostId, otherHostId]]);
  });
}

before(async () => {
  app = await buildServer({ logger: false, rateLimitMax: 10_000, loginRateLimitMax: 10_000 });
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code, name) VALUES ($1, 'Tunnel Proxy Offer')
                   ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgId = (await c.query(
      `INSERT INTO orgs (slug, name, max_concurrent) VALUES ($1, 'Tunnel Proxy Offer', 50) RETURNING id`,
      [`tun-offer-${randomUUID().slice(0, 8)}`],
    )).rows[0].id;
  });
  ({ hostId, token: workerToken } = await registerHost('tun-offer-host'));
  ({ hostId: otherHostId, token: otherWorkerToken } = await registerHost('tun-offer-other'));
});

after(async () => {
  await app.close();
  await withSystem(async (c) => {
    await c.query('DELETE FROM sessions WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM devices WHERE host_id = ANY($1::uuid[])', [[hostId, otherHostId]]);
    await c.query('DELETE FROM hosts WHERE region = $1', [REGION]);
    await c.query('DELETE FROM orgs WHERE id = $1', [orgId]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await closePools();
});

describe('which devices the beat offers a proxy for', () => {
  test('a device whose live session named a tunnel is offered, by local id', async () => {
    await wipe();
    const deviceId = await seedDevice(hostId, 'cf-1');
    const a = await allocate({
      orgId, userId: null, region: REGION, platform: 'android',
      requested: { [TUNNEL_CAPABILITY]: 'staging' },
    });
    assert.equal(a.deviceId, deviceId, 'the fixture device should have been allocated');

    const offers = await beat();

    assert.deepEqual(offers, [{ deviceId, localId: 'cf-1' }]);
  });

  test('the offer carries the device and NOT the tunnel name', async () => {
    await wipe();
    await seedDevice(hostId, 'cf-1');
    await allocate({
      orgId, userId: null, region: REGION, platform: 'android',
      requested: { [TUNNEL_CAPABILITY]: 'payroll-db' },
    });

    const offers = await beat();

    assert.equal(offers.length, 1);
    // Read as text rather than by key, so a name smuggled in under any field name fails this.
    assert.ok(!JSON.stringify(offers).includes('payroll-db'),
      'a worker that learned the tunnel name could ask for a different one');
    assert.deepEqual(Object.keys(offers[0]).sort(), ['deviceId', 'localId']);
  });

  test('a live session that named no tunnel is not offered', async () => {
    await wipe();
    await seedDevice(hostId, 'cf-1');
    await allocate({ orgId, userId: null, region: REGION, platform: 'android' });

    assert.deepEqual(await beat(), [], 'an ordinary session must not have its traffic diverted');
  });

  test('a device with no session at all is not offered', async () => {
    await wipe();
    await seedDevice(hostId, 'cf-1');

    // The security property `routeFor` states: a device between tenants is freshly reset or waiting
    // in the pool, and whatever the last tenant left on it must not reach the NEXT tenant's network.
    assert.deepEqual(await beat(), []);
  });

  test('a released device stops being offered — that is the whole teardown', async () => {
    await wipe();
    await seedDevice(hostId, 'cf-1');
    const a = await allocate({
      orgId, userId: null, region: REGION, platform: 'android',
      requested: { [TUNNEL_CAPABILITY]: 'staging' },
    });
    assert.equal((await beat()).length, 1, 'precondition: it was offered while the session was live');

    await release(orgId, a.sessionId, 'test');

    // There is no "proxy off" message to be lost, which is the point of re-sending the desired set:
    // the worker turns the proxy off because the device stopped appearing.
    assert.deepEqual(await beat(), []);
  });

  test('another host is never told about this ones tunnelled device', async () => {
    await wipe();
    await seedDevice(hostId, 'cf-1');
    await allocate({
      orgId, userId: null, region: REGION, platform: 'android',
      requested: { [TUNNEL_CAPABILITY]: 'staging' },
    });

    assert.equal((await beat(workerToken)).length, 1, 'precondition: the owning host is told');
    assert.deepEqual(await beat(otherWorkerToken), [],
      'host scoping is migration 008s rule, and on this path it decides whose network opens');
  });

  test('the tunnel is found in constraints as well as in requested', async () => {
    await wipe();
    const deviceId = await seedDevice(hostId, 'cf-1');
    const a = await allocate({ orgId, userId: null, region: REGION, platform: 'android' });
    assert.equal(a.deviceId, deviceId);
    // The allocator stores derived constraints and the hub stores requested capabilities, and which
    // one carries this key has moved once already. `routeFor` reads both; so must this.
    await withSystem((c) => c.query(
      `UPDATE sessions SET constraints = $2::jsonb WHERE id = $1`,
      [a.sessionId, JSON.stringify({ [TUNNEL_CAPABILITY]: 'staging' })],
    ));

    assert.deepEqual(await beat(), [{ deviceId, localId: 'cf-1' }]);
  });

  test('an empty tunnel name is not a tunnel', async () => {
    await wipe();
    await seedDevice(hostId, 'cf-1');
    const a = await allocate({ orgId, userId: null, region: REGION, platform: 'android' });
    await withSystem((c) => c.query(
      `UPDATE sessions SET requested = $2::jsonb WHERE id = $1`,
      [a.sessionId, JSON.stringify({ [TUNNEL_CAPABILITY]: '' })],
    ));

    // `pickTunnel` refuses an empty string, and a device offered here but refused there would be a
    // guest pointed at a proxy that answers every request 503.
    assert.deepEqual(await beat(), []);
  });

  test('two tunnelled devices on one host are both offered', async () => {
    await wipe();
    const one = await seedDevice(hostId, 'cf-1');
    const two = await seedDevice(hostId, 'cf-2');
    for (const _ of [0, 1]) {
      await allocate({
        orgId, userId: null, region: REGION, platform: 'android',
        requested: { [TUNNEL_CAPABILITY]: 'staging' },
      });
    }

    const byId = Object.fromEntries((await beat()).map((o) => [o.deviceId, o.localId]));
    assert.deepEqual(byId, { [one]: 'cf-1', [two]: 'cf-2' });
  });
});
