/**
 * Taking and deleting snapshots from the console — ADR-0053, migration 070.
 *
 * WHAT THIS FILE IS TRYING HARD TO CATCH, worst first:
 *
 *   A DELETE THE CONSOLE SHOULD NOT BE ABLE TO MAKE. The name of the snapshot to delete arrives
 *   from a browser. Three things must stop it: the snapshot was not taken from an allow-listed disk
 *   (decided by what the PROVIDER says its source is, not by its name); it is the newest restore
 *   point of its disk; or the caller is not a fleet operator. Each asserts that NO delete reached
 *   the provider, not only that the answer was a refusal.
 *
 *   AN OUTCOME THAT WAS GUESSED. A provider that refused is `failed`; one that never answered is
 *   `unknown`; a snapshot still being written is `accepted`, and is finished by the reconciler.
 *
 * The provider is a fake `fetch` holding snapshots in memory. Every request it receives is recorded,
 * so a test can say what was asked of the cloud and what was not.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.GCP_PROJECT = 'mfarm-test';
process.env.MFARM_SNAPSHOT_DISKS = 'cp-disk:zone-a,lab-disk:zone-a';
process.env.INFRA_SNAPSHOT_SETTLE_MS = '400';
process.env.CLOUD_SNAPSHOT_RATE = '2';

import { test, before, after, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { upsertUser, cookieValue } from '../src/users.ts';
import { resetCloudCache } from '../src/infra/cloud.ts';
import { resetInventoryCache } from '../src/infra/inventory.ts';
import { reconcileSnapshots, snapshotName } from '../src/infra/snapshots.ts';

let app: FastifyInstance;
let orgId: string;
const who: Record<string, { cookie: string; csrf: string }> = {};

const OPERATOR = `op-${randomUUID()}@example.test`;
const ADMIN = `admin-${randomUUID()}@example.test`;
const PASSWORD = 'correct horse battery staple';
const realFetch = globalThis.fetch;

interface Snap { status: string; disk: string; at: string }
let snaps: Map<string, Snap>;
let calls: Array<{ method: string; url: string; body: Record<string, unknown> | null }>;

/**
 * The project, as the provider would answer for it.
 *
 * `createLands` is the state a new snapshot is in when the create returns — CREATING models a busy
 * disk. `deleteLands` is what a delete leaves behind: `gone`, or DELETING for one that is slow.
 * `refuse` answers every compute call with that status; `vanish` drops the named verb on the floor.
 */
function fakeCloud(opts: {
  createLands?: string; deleteLands?: 'gone' | 'DELETING'; refuse?: number; vanish?: 'POST' | 'DELETE';
} = {}) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    });
    if (url.includes('/service-accounts/default/token')) return json({ access_token: 'fake', expires_in: 3600 });
    if (url.includes('/instance/name')) return new Response('cp-a', { status: 200 });

    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (opts.vanish === method) throw new Error('network gone');
    if (opts.refuse) return new Response('refused', { status: opts.refuse });

    const one = (name: string, s: Snap) => ({
      name, status: s.status, creationTimestamp: s.at, diskSizeGb: '30', storageBytes: '1073741824',
      sourceDisk: `https://compute/projects/mfarm-test/zones/zone-a/disks/${s.disk}`,
    });
    const single = /\/global\/snapshots\/([^/?]+)$/.exec(url);
    if (single) {
      const s = snaps.get(single[1]);
      if (method === 'DELETE') {
        if (!s) return json({ error: 'not found' }, 404);
        if (opts.deleteLands === 'DELETING') s.status = 'DELETING'; else snaps.delete(single[1]);
        return json({});
      }
      return s ? json(one(single[1], s)) : json({ error: 'not found' }, 404);
    }
    if (url.endsWith('/global/snapshots')) return json({ items: [...snaps].map(([n, s]) => one(n, s)) });
    const create = /\/disks\/([^/]+)\/createSnapshot$/.exec(url);
    if (create && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { name: string };
      snaps.set(body.name, { status: opts.createLands ?? 'READY', disk: create[1], at: new Date().toISOString() });
      return json({});
    }
    if (url.includes('/aggregated/disks')) {
      return json({ items: { 'zones/zone-a': { disks: [
        { name: 'cp-disk', sizeGb: '30', type: 'x/pd-balanced', zone: 'x/zone-a', users: ['x/cp-a'] },
        { name: 'other-disk', sizeGb: '10', type: 'x/pd-balanced', zone: 'x/zone-a', users: [] },
      ] } } });
    }
    if (url.includes('/aggregated/')) return json({ items: {} });
    return json({ error: `unexpected ${method} ${url}` }, 500);
  }) as typeof fetch;
}

const post = (as: string, url: string, payload: Record<string, unknown> = {}) => app.inject({
  method: 'POST', url, payload, headers: { cookie: who[as].cookie, 'x-mfarm-csrf': who[as].csrf },
});
const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: who.operator.cookie } });

const q = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  withSystem(async (c) => (await c.query<T>(sql, params)).rows);
const opsFor = (target: string) => q<{ action: string; result: string; target_kind: string; params: Record<string, string> }>(
  `SELECT action, result, target_kind, params FROM infra_operations WHERE target_id = $1 ORDER BY requested_at`, [target]);
const asked = (method: string) => calls.filter((c) => c.method === method);

/** A snapshot `daysAgo` old, of `disk`. */
const have = (name: string, disk: string, daysAgo: number, status = 'READY') =>
  snaps.set(name, { status, disk, at: new Date(Date.now() - daysAgo * 86_400_000).toISOString() });

async function signIn(email: string) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PASSWORD } });
  assert.equal(res.statusCode, 200, res.body);
  return {
    cookie: `mfarm_session=${cookieValue(String(res.headers['set-cookie']), 'mfarm_session')}`,
    csrf: res.json().csrfToken as string,
  };
}

before(async () => {
  app = await buildServer({ logger: false, loginRateLimitMax: 10_000 });
  orgId = (await q<{ id: string }>(
    `INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,'Snapshots',50) RETURNING id`,
    [`snap-${randomUUID()}`]))[0].id;
  await upsertUser(OPERATOR, PASSWORD, orgId, 'admin');
  await upsertUser(ADMIN, PASSWORD, orgId, 'admin');
  await q('UPDATE users SET operator = true WHERE lower(email) = lower($1)', [OPERATOR]);
  who.operator = await signIn(OPERATOR);
  who.admin = await signIn(ADMIN);
});

after(async () => {
  globalThis.fetch = realFetch;
  await withSystem(async (c) => {
    await c.query('ALTER TABLE infra_operations DISABLE TRIGGER infra_operations_append_only');
    await c.query('DELETE FROM infra_operations WHERE actor_org_id = $1', [orgId]);
    await c.query('ALTER TABLE infra_operations ENABLE TRIGGER infra_operations_append_only');
    await c.query('DELETE FROM user_sessions WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM memberships WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM orgs WHERE id = $1', [orgId]);
  });
  await app.close();
  await closePools();
});

beforeEach(() => {
  snaps = new Map();
  calls = [];
  resetCloudCache();
  resetInventoryCache();
  fakeCloud();
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('taking a snapshot', () => {
  test('of a disk on the list: the provider is asked once, and the name is the server\'s', async () => {
    const res = await post('operator', '/v1/infra/cloud/disks/cp-disk/snapshot', { reason: 'before the upgrade' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().result, 'succeeded');

    const made = asked('POST');
    assert.equal(made.length, 1);
    assert.match(made[0].url, /\/projects\/mfarm-test\/zones\/zone-a\/disks\/cp-disk\/createSnapshot$/);
    assert.match(String(made[0].body!.name), /^cp-disk-\d{8}-\d{4}$/, 'the snapshot name is not one the server chose');
    assert.equal(made[0].body!.description, 'before the upgrade');
    assert.deepEqual(made[0].body!.labels, { 'created-by': 'mfarm-console' });

    const [op] = await opsFor('cp-disk');
    assert.deepEqual([op.action, op.result, op.target_kind], ['snapshot-disk', 'succeeded', 'cloud']);
    assert.equal(op.params.snapshot, made[0].body!.name);
  });

  test('of a disk NOT on the list: refused, and the provider is never asked', async () => {
    const res = await post('operator', '/v1/infra/cloud/disks/other-disk/snapshot');
    assert.equal(res.statusCode, 403, res.body);
    assert.match(res.json().error.message, /MFARM_SNAPSHOT_DISKS/);
    assert.equal(calls.length, 0, `the cloud was asked: ${JSON.stringify(calls)}`);
  });

  test('a second press in the same minute makes no second copy', async () => {
    await post('operator', '/v1/infra/cloud/disks/lab-disk/snapshot');
    const again = await post('operator', '/v1/infra/cloud/disks/lab-disk/snapshot');
    assert.equal(again.json().result, 'noop', again.body);
    assert.match(again.json().message, /already exists/);
    assert.equal(asked('POST').length, 1, 'two snapshots were requested');
  });

  test('a busy disk answers "in progress", and the reconciler finishes the row', async () => {
    fakeCloud({ createLands: 'CREATING' });
    const res = await post('operator', '/v1/infra/cloud/disks/cp-disk/snapshot');
    assert.equal(res.json().result, 'accepted', res.body);
    const name = res.json().changed.snapshot as string;
    assert.equal((await opsFor('cp-disk')).at(-1)!.result, 'accepted', 'a snapshot still being written was called done');

    // Still being written: nothing to settle yet.
    assert.equal((await reconcileSnapshots()).settled, 0);
    snaps.get(name)!.status = 'READY';
    assert.equal((await reconcileSnapshots()).settled, 1);
    assert.equal((await opsFor('cp-disk')).at(-1)!.result, 'succeeded');
  });

  test('a provider that refuses is a failure that says which permission; one that vanishes is unknown', async () => {
    fakeCloud({ refuse: 403 });
    const refused = await post('operator', '/v1/infra/cloud/disks/cp-disk/snapshot');
    assert.equal(refused.json().result, 'failed', refused.body);
    assert.match(refused.json().message, /compute\.disks\.createSnapshot/);

    fakeCloud({ vanish: 'POST' });
    const lost = await post('operator', '/v1/infra/cloud/disks/lab-disk/snapshot');
    assert.equal(lost.json().result, 'unknown', lost.body);
    assert.match(lost.json().message, /may have\s+been taken/);
  });

  test('the name is to the minute, in UTC, and never longer than the provider allows', () => {
    assert.equal(snapshotName('cp-disk', new Date('2026-10-09T07:05:59Z')), 'cp-disk-20261009-0705');
    const long = snapshotName(`${'a'.repeat(60)}`, new Date('2026-10-09T07:05:00Z'));
    assert.ok(long.length <= 63, `${long.length} characters`);
    assert.match(long, /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/);
  });
});

describe('deleting a snapshot', () => {
  test('an old restore point of a listed disk is deleted, and the answer says what is left', async () => {
    have('lab-old', 'lab-disk', 40);
    have('lab-new', 'lab-disk', 2);
    const res = await post('operator', '/v1/infra/cloud/snapshots/lab-old/delete', { reason: 'superseded' });
    assert.equal(res.json().result, 'succeeded', res.body);
    assert.match(res.json().message, /still has a newer restore point/);
    assert.equal(asked('DELETE').length, 1);
    assert.ok(!snaps.has('lab-old'));
    assert.ok(snaps.has('lab-new'));
    const [op] = await opsFor('lab-old');
    assert.deepEqual([op.action, op.result, op.target_kind], ['delete-snapshot', 'succeeded', 'cloud']);
  });

  test('THE NEWEST restore point of a disk is refused, and no delete reaches the provider', async () => {
    have('lab-old', 'lab-disk', 40);
    have('lab-new', 'lab-disk', 2);
    // A newer one that is still being written does not count as a restore point yet.
    have('lab-writing', 'lab-disk', 0, 'CREATING');
    const res = await post('operator', '/v1/infra/cloud/snapshots/lab-new/delete');
    assert.equal(res.json().result, 'failed', res.body);
    assert.match(res.json().message, /newest restore point for lab-disk/);
    assert.equal(asked('DELETE').length, 0, 'the last way back was deleted');

    // The only snapshot of a disk is its newest.
    have('cp-only', 'cp-disk', 5);
    assert.equal((await post('operator', '/v1/infra/cloud/snapshots/cp-only/delete')).json().result, 'failed');
    assert.equal(asked('DELETE').length, 0);
  });

  test('a snapshot of a disk that is NOT on the list is refused whatever it is called', async () => {
    // Named exactly like a snapshot this console would make of an allow-listed disk.
    have('cp-disk-20260101-0000', 'other-disk', 90);
    have('other-new', 'other-disk', 1);
    const res = await post('operator', '/v1/infra/cloud/snapshots/cp-disk-20260101-0000/delete');
    assert.equal(res.json().result, 'failed', res.body);
    assert.match(res.json().message, /it is a snapshot of other-disk/);
    assert.equal(asked('DELETE').length, 0, 'a snapshot was deleted because of its NAME');
  });

  test('one that is already gone changes nothing, and one already going is not asked twice', async () => {
    const gone = await post('operator', '/v1/infra/cloud/snapshots/never-existed/delete');
    assert.equal(gone.json().result, 'noop', gone.body);

    have('lab-going', 'lab-disk', 40, 'DELETING');
    have('lab-new', 'lab-disk', 2);
    const going = await post('operator', '/v1/infra/cloud/snapshots/lab-going/delete');
    assert.equal(going.json().result, 'noop', going.body);
    assert.equal(asked('DELETE').length, 0);
  });

  test('a slow delete answers "in progress", and the reconciler finishes it once it is gone', async () => {
    fakeCloud({ deleteLands: 'DELETING' });
    have('lab-old', 'lab-disk', 40);
    have('lab-new', 'lab-disk', 2);
    const res = await post('operator', '/v1/infra/cloud/snapshots/lab-old/delete');
    assert.equal(res.json().result, 'accepted', res.body);

    assert.equal((await reconcileSnapshots()).settled, 0);
    snaps.delete('lab-old');
    assert.equal((await reconcileSnapshots()).settled, 1);
    assert.equal((await opsFor('lab-old')).at(-1)!.result, 'succeeded');
  });

  test('a delete the provider never acknowledged is unknown, not failed', async () => {
    have('lab-old', 'lab-disk', 40);
    have('lab-new', 'lab-disk', 2);
    fakeCloud({ vanish: 'DELETE' });
    const res = await post('operator', '/v1/infra/cloud/snapshots/lab-old/delete');
    assert.equal(res.json().result, 'unknown', res.body);
    assert.match(res.json().message, /may have been\s+carried out/);
  });
});

describe('who may, and what may be named', () => {
  test('an org admin who is not a fleet operator can do neither', async () => {
    have('lab-old', 'lab-disk', 40);
    have('lab-new', 'lab-disk', 2);
    assert.equal((await post('admin', '/v1/infra/cloud/disks/cp-disk/snapshot')).statusCode, 403);
    assert.equal((await post('admin', '/v1/infra/cloud/snapshots/lab-old/delete')).statusCode, 403);
    assert.equal(calls.length, 0, 'a 403 that reached the cloud anyway');
  });

  test('a name that is not a resource name never reaches a URL', async () => {
    for (const bad of ['UPPER', 'has..dots', 'a'.repeat(64), '-leading']) {
      const res = await post('operator', `/v1/infra/cloud/snapshots/${encodeURIComponent(bad)}/delete`);
      assert.equal(res.statusCode, 400, `${bad}: ${res.body}`);
    }
    assert.equal(calls.length, 0);
  });
});

describe('what the page is told it may do', () => {
  test('the overview says snapshots are available, and the log can be filtered to them', async () => {
    assert.equal((await get('/v1/infra/overview')).json().capabilities.snapshots, true);
    await post('operator', '/v1/infra/cloud/disks/cp-disk/snapshot');
    const res = await get('/v1/infra/operations?targetKind=cloud&limit=5');
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.json().operations.some((o: { action: string }) => o.action === 'snapshot-disk'));
  });

  test('each disk says whether it may be snapshotted; each snapshot whether it may be deleted, and why not', async () => {
    have('cp-old', 'cp-disk', 40);
    have('cp-new', 'cp-disk', 2);
    have('theirs', 'other-disk', 9);
    const body = (await get('/v1/infra/cloud?refresh=1')).json();

    const disk = (n: string) => body.disks.find((d: { name: string }) => d.name === n);
    assert.equal(disk('cp-disk').snapshottable, true);
    assert.equal(disk('other-disk').snapshottable, false);

    const snap = (n: string) => body.snapshots.find((s: { name: string }) => s.name === n);
    assert.deepEqual([snap('cp-old').deletable, snap('cp-old').keptBecause], [true, null]);
    assert.equal(snap('cp-new').deletable, false);
    assert.match(snap('cp-new').keptBecause, /newest restore point for cp-disk/);
    assert.equal(snap('theirs').deletable, false);
    assert.match(snap('theirs').keptBecause, /not a snapshot of a disk this console may snapshot/);
  });
});
