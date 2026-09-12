/**
 * Everything the app has in the cloud — and the three costs nobody was being shown.
 *
 * WHAT THIS FILE IS REALLY ASSERTING. The Infrastructure page knew about `hosts`: machines running
 * an agent, one VM on this farm. Three things it could not see, each of which bills whether or not
 * anything is running:
 *
 *   the CONTROL PLANE, which serves the page and had never appeared anywhere in the product;
 *   180 GB of persistent disk;
 *   reserved addresses, which GCE charges for whenever they are NOT on a running instance — so
 *     stopping a VM starts a charge on its address rather than ending one.
 *
 * "The farm costs nothing while it is off" was never true, and the FLOOR is the number that makes
 * that checkable. Every test below is about one of those.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.GCP_PROJECT = 'mfarm-test';
process.env.MFARM_POWER_INSTANCES = 'lab-a:asia-south1-c';
process.env.HOST_HOURLY_COST = '65';
process.env.COST_CURRENCY = '₹';
/** Rates chosen so every arithmetic assertion below is checkable by hand. */
process.env.CLOUD_DISK_RATE = '10';
process.env.CLOUD_SNAPSHOT_RATE = '2';
process.env.CLOUD_ADDRESS_RATE = '1';
process.env.CLOUD_INSTANCE_RATES = 'cp-a=5';

import { test, before, after, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { upsertUser, cookieValue } from '../src/users.ts';
import { resetCloudCache } from '../src/infra/cloud.ts';
import { resetInventoryCache } from '../src/infra/inventory.ts';

let app: FastifyInstance;
let cookie = '';

const REGION = `inv-${randomUUID().slice(0, 8)}`;
const OPERATOR = `op-${randomUUID()}@example.test`;
const PASSWORD = 'correct horse battery staple';
const realFetch = globalThis.fetch;

/**
 * A fake project. `labRunning` is what makes the address assertions interesting: the same address,
 * on the same instance, is free or billed depending only on whether that instance is running.
 */
function fakeProject(opts: { labRunning?: boolean } = {}) {
  const labStatus = opts.labRunning === false ? 'TERMINATED' : 'RUNNING';
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    if (url.includes('/service-accounts/default/token')) {
      return json({ access_token: 'fake', expires_in: 3600 });
    }
    if (url.includes('/instance/name')) return new Response('cp-a', { status: 200 });

    if (url.endsWith('/aggregated/instances')) {
      return json({ items: {
        'zones/asia-south1-c': { instances: [
          { name: 'lab-a', zone: '.../zones/asia-south1-c', status: labStatus,
            machineType: '.../machineTypes/n2-standard-16',
            disks: [{ source: '.../disks/lab-a' }] },
          { name: 'cp-a', zone: '.../zones/asia-south1-c', status: 'RUNNING',
            machineType: '.../machineTypes/e2-medium',
            disks: [{ source: '.../disks/cp-a' }] },
        ] },
        'zones/empty': { warning: { code: 'NO_RESULTS_ON_PAGE' } },
      } });
    }
    if (url.endsWith('/aggregated/disks')) {
      return json({ items: { 'zones/asia-south1-c': { disks: [
        { name: 'lab-a', zone: '.../zones/asia-south1-c', sizeGb: '150',
          type: '.../diskTypes/pd-balanced', users: ['.../instances/lab-a'] },
        { name: 'cp-a', zone: '.../zones/asia-south1-c', sizeGb: '30',
          type: '.../diskTypes/pd-balanced', users: ['.../instances/cp-a'] },
        // The one nobody remembers: attached to nothing and billed in full.
        { name: 'orphan', zone: '.../zones/asia-south1-c', sizeGb: '20',
          type: '.../diskTypes/pd-ssd' },
      ] } } });
    }
    if (url.endsWith('/aggregated/addresses')) {
      return json({ items: { 'regions/asia-south1': { addresses: [
        { name: 'lab-ip', address: '34.1.1.1', status: 'IN_USE',
          region: '.../regions/asia-south1', users: ['.../instances/lab-a'] },
        { name: 'cp-ip', address: '34.1.1.2', status: 'IN_USE',
          region: '.../regions/asia-south1', users: ['.../instances/cp-a'] },
      ] } } });
    }
    if (url.includes('/global/snapshots')) {
      return json({ items: [
        { name: 'cf-ready', diskSizeGb: '150', storageBytes: String(10 * 1024 ** 3),
          sourceDisk: '.../disks/lab-a', creationTimestamp: '2026-08-01T00:00:00Z' },
      ] });
    }
    throw new Error(`unexpected call: ${url}`);
  }) as typeof fetch;
}

const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });

before(async () => {
  app = await buildServer({ logger: false, loginRateLimitMax: 10_000 });
  let orgId = '';
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Inventory Test') ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgId = (await c.query(
      `INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,'Inv',50) RETURNING id`,
      [`inv-${randomUUID()}`])).rows[0].id;
  });
  await upsertUser(OPERATOR, PASSWORD, orgId, 'admin');
  await withSystem((c) =>
    c.query('UPDATE users SET operator = true WHERE lower(email) = lower($1)', [OPERATOR]));
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login',
    payload: { email: OPERATOR, password: PASSWORD } });
  cookie = `mfarm_session=${cookieValue(String(res.headers['set-cookie']).replace(/; /g, '; '), 'mfarm_session')}`;
});

beforeEach(() => { resetCloudCache(); resetInventoryCache(); });
afterEach(() => { globalThis.fetch = realFetch; });

after(async () => {
  globalThis.fetch = realFetch;
  await withSystem(async (c) => {
    await c.query('DELETE FROM hosts WHERE region = $1', [REGION]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await app.close();
  await closePools();
});

describe('what the project actually contains', () => {
  test('THE CONTROL PLANE IS LISTED — it had never appeared anywhere in the product', async () => {
    fakeProject();
    const body = (await get('/v1/infra/cloud')).json();
    const names = body.instances.map((i: { name: string }) => i.name);
    assert.deepEqual(names.sort(), ['cp-a', 'lab-a']);

    const cp = body.instances.find((i: { name: string }) => i.name === 'cp-a');
    assert.equal(cp.isFleetHost, false, 'the control plane runs no agent and must not claim to');
    // And it is priced separately: one rate for a control plane and a 16-core device host is how
    // the control plane's share stayed invisible.
    assert.equal(cp.rateHourly, 5);
    const lab = body.instances.find((i: { name: string }) => i.name === 'lab-a');
    assert.equal(lab.rateHourly, 65, 'an unnamed instance falls back to HOST_HOURLY_COST');
  });

  test('an empty zone in an aggregated list is skipped, not crashed on', async () => {
    fakeProject();
    const res = await get('/v1/infra/cloud');
    assert.equal(res.statusCode, 200, res.body);
  });

  test('AN UNATTACHED DISK IS BILLED FOR NOTHING, and is named', async () => {
    fakeProject();
    const body = (await get('/v1/infra/cloud')).json();
    const orphan = body.disks.find((d: { name: string }) => d.name === 'orphan');
    assert.ok(orphan);
    assert.equal(orphan.attachedTo, null);
    assert.equal(orphan.costPerMonth, 200, '20 GB at 10 a GB-month');
  });

  test('a snapshot is priced on BYTES STORED, not on the disk it came from', async () => {
    fakeProject();
    const body = (await get('/v1/infra/cloud')).json();
    const snap = body.snapshots[0];
    assert.equal(snap.diskSizeGb, 150, 'it restores a 150 GB disk');
    // ...and costs for the 10 GB it actually occupies. Pricing on 150 would overstate it fifteenfold
    // and make keeping a snapshot look like a decision worth agonising over.
    assert.equal(snap.costPerMonth, 20, '10 GB stored at 2 a GB-month');
  });
});

describe('the address charge nobody expects', () => {
  /**
   * GCE bills a reserved address whenever it is NOT attached to a RUNNING instance. So **stopping a
   * VM starts a charge on its address rather than ending one**, and nothing in a status of `IN_USE`
   * says so. This is the single most surprising line on the page.
   */
  test('an address on a RUNNING instance is free', async () => {
    fakeProject({ labRunning: true });
    const body = (await get('/v1/infra/cloud')).json();
    const labIp = body.addresses.find((a: { name: string }) => a.name === 'lab-ip');
    assert.equal(labIp.billed, false);
    assert.equal(labIp.costPerMonth, null, 'a free address must not be given a price');
  });

  test('THE SAME ADDRESS ON A STOPPED INSTANCE IS BILLED', async () => {
    fakeProject({ labRunning: false });
    const body = (await get('/v1/infra/cloud')).json();
    const labIp = body.addresses.find((a: { name: string }) => a.name === 'lab-ip');
    assert.equal(labIp.billed, true,
      'stopping a VM starts a charge on its address, and the page said nothing');
    assert.equal(labIp.costPerMonth, 730, '1 an hour for a month');
    // The status the provider reports is unchanged — which is exactly why `billed` is derived here
    // rather than read off it.
    assert.equal(labIp.status, 'IN_USE');
  });
});

describe('the floor', () => {
  /**
   * THE NUMBER THIS MODULE EXISTS FOR: what the estate costs with every machine switched off. Disks
   * and snapshots do not care whether anything is running, and every reserved address is billed once
   * nothing is. `docs/STATUS.md` says the device host is ~95% of the bill and is stopped between
   * sessions — right about the variable cost, and silent about this.
   */
  test('it counts disks, snapshots and EVERY address, whatever is running now', async () => {
    fakeProject({ labRunning: true });
    const body = (await get('/v1/infra/cloud')).json();

    // disks 150+30+20 = 200 GB at 10 = 2000; snapshot 10 GB at 2 = 20; two addresses at 1/h = 1460.
    assert.equal(body.cost.floorPerMonth, 2000 + 20 + 1460);
    assert.equal(body.cost.byKind.disks, 2000);
    assert.equal(body.cost.byKind.snapshots, 20);
  });

  test('the floor does not move when a machine stops — that is the point of it', async () => {
    fakeProject({ labRunning: true });
    const running = (await get('/v1/infra/cloud')).json().cost.floorPerMonth;
    resetInventoryCache();
    fakeProject({ labRunning: false });
    const stopped = (await get('/v1/infra/cloud')).json().cost.floorPerMonth;
    assert.equal(stopped, running,
      'the floor is what you pay regardless; if it moves with the machines it is not a floor');
  });

  test('the RUNNING cost does move, and counts the control plane', async () => {
    fakeProject({ labRunning: true });
    assert.equal((await get('/v1/infra/cloud')).json().cost.runningPerHour, 70, '65 + 5');
    resetInventoryCache();
    fakeProject({ labRunning: false });
    assert.equal((await get('/v1/infra/cloud')).json().cost.runningPerHour, 5,
      'the control plane keeps running and keeps costing');
  });
});

/**
 * The CONFIGURATION shapes — an unpriced estate, and a control plane with no credential — are
 * asserted in `config.test.ts` instead. `loadConfig()` memoises on purpose, so a test that deletes
 * an environment variable at runtime is testing the memo rather than the product; `parseConfig`
 * takes its environment as an argument, which is the seam that file already uses.
 */
describe('when the cloud cannot be read', () => {
  test('a provider that refuses is reported, and the section is not blanked', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/service-accounts/default/token')) {
        return new Response(JSON.stringify({ access_token: 'x', expires_in: 3600 }), {
          status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('nope', { status: 403 });
    }) as typeof fetch;

    const body = (await get('/v1/infra/cloud')).json();
    assert.equal(body.configured, true);
    assert.match(body.error, /scopes cap IAM|refused/);
  });
});

describe('who may read it', () => {
  test('an operator may; a plain admin may not', async () => {
    fakeProject();
    assert.equal((await get('/v1/infra/cloud')).statusCode, 200);

    const other = `plain-${randomUUID()}@example.test`;
    const orgId = (await withSystem(async (c) => (await c.query<{ org_id: string }>(
      'SELECT org_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE lower(u.email) = lower($1)',
      [OPERATOR])).rows))[0].org_id;
    await upsertUser(other, PASSWORD, orgId, 'admin');
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login',
      payload: { email: other, password: PASSWORD } });
    const theirs = `mfarm_session=${cookieValue(String(login.headers['set-cookie']).replace(/; /g, '; '), 'mfarm_session')}`;
    const res = await app.inject({ method: 'GET', url: '/v1/infra/cloud', headers: { cookie: theirs } });
    assert.equal(res.statusCode, 403, res.body);
  });
});
