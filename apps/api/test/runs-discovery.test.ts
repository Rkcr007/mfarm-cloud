/**
 * Finding a run once there are more than a screenful.
 *
 * `GET /v1/runs` took only `limit` until 2026-09-11 — correct for a lab with nineteen runs, useless
 * the first week somebody runs CI daily. These are the cases that decide whether the list is usable
 * at volume, and two of them are about being WRONG rather than being missing:
 *
 *   - a keyset page must not repeat or skip a row when a run is created mid-pagination, which is
 *     exactly what an OFFSET does and exactly when CI is busiest;
 *   - `status=` must select the same rows the badge labels, or the list disagrees with itself —
 *     the D35 family, where four surfaces answered one question from different tables.
 */
process.env.RATE_LIMIT_MAX = '10000';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { createApiKey } from '../src/auth.ts';

let app: FastifyInstance;
let orgId: string, key: string;

const auth = () => ({ authorization: `Bearer ${key}` });
const list = (qs = '') => app.inject({ method: 'GET', url: `/v1/runs${qs}`, headers: auth() });
const ids = (res: { json(): { runs: { runId: string }[] } }) => res.json().runs.map((r) => r.runId);

/**
 * A run with a chosen creation time, so ordering is a fact rather than a race.
 *
 * Sessions and results are inserted directly because the SUBJECT here is the list query, not the
 * allocator — and driving a real device to produce a failed test would make this suite need a farm.
 */
async function seedRun(opts: {
  externalId: string; name?: string | null; createdAt: string;
  results?: ('passed' | 'failed' | 'skipped')[]; live?: boolean;
}) {
  return withSystem(async (c) => {
    const run = await c.query(
      `INSERT INTO runs (org_id, external_id, name, created_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      [orgId, opts.externalId, opts.name ?? null, opts.createdAt]);
    const runId = run.rows[0].id;

    if (opts.results?.length || opts.live) {
      const sess = await c.query(
        `INSERT INTO sessions (org_id, run_id, state, region, created_at)
         VALUES ($1,$2,$3,'lab',$4) RETURNING id`,
        [orgId, runId, opts.live ? 'ACTIVE' : 'ENDED', opts.createdAt]);
      for (const status of opts.results ?? []) {
        await c.query(
          `INSERT INTO test_results (org_id, session_id, name, status) VALUES ($1,$2,$3,$4)`,
          [orgId, sess.rows[0].id, `a ${status} test`, status]);
      }
    }
    return runId;
  });
}

const AT = (n: number) => new Date(Date.UTC(2026, 0, n, 12, 0, 0)).toISOString();

before(async () => {
  app = await buildServer({ logger: false });
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ('lab','Lab') ON CONFLICT (code) DO NOTHING`);
    const r = await c.query(
      `INSERT INTO orgs (slug, name, max_concurrent) VALUES ($1,'Runs Discovery',50) RETURNING id`,
      [`runsq-${randomUUID()}`]);
    orgId = r.rows[0].id;
  });
  key = (await createApiKey(orgId, 'runs discovery fixture', { scope: 'full' })).plaintext;

  await seedRun({ externalId: 'nightly-1', name: 'Android_UAE_Expenses_01', createdAt: AT(1), results: ['passed', 'passed'] });
  await seedRun({ externalId: 'nightly-2', name: 'Android_UAE_Expenses_02', createdAt: AT(2), results: ['passed', 'failed'] });
  await seedRun({ externalId: 'nightly-3', name: 'Android_UAE_Smoke_03', createdAt: AT(3) });
  await seedRun({ externalId: 'pr-4471', name: null, createdAt: AT(4), results: ['passed'] });
  await seedRun({ externalId: 'pr-4472', name: null, createdAt: AT(5), live: true });
});

after(async () => { await app?.close(); await closePools(); });

describe('search', () => {
  test('matches the run id, which is what CI knows', async () => {
    assert.deepEqual(ids(await list('?q=pr-447')).sort(), ['pr-4471', 'pr-4472']);
  });

  test('matches the name, which is what a person remembers', async () => {
    assert.deepEqual(ids(await list('?q=Expenses')).sort(), ['nightly-1', 'nightly-2']);
  });

  test('is case-insensitive — nobody types a run name in the right case', async () => {
    assert.deepEqual(ids(await list('?q=eXpEnSeS')).sort(), ['nightly-1', 'nightly-2']);
  });

  test('a run with a null name is still findable by id', async () => {
    assert.deepEqual(ids(await list('?q=4471')), ['pr-4471']);
  });

  test('no match is an empty list, not an error', async () => {
    const res = await list('?q=nothing-is-called-this');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().runs, []);
  });

  test('A WILDCARD IN THE QUERY IS A LITERAL, not a pattern', async () => {
    // `%` unescaped matches everything, so a person searching for a name containing one would get
    // the whole org back and read it as "everything matches". No run here has a literal `%`.
    assert.deepEqual(ids(await list('?q=%')), []);

    /**
     * `_` is the subtler half and the reason this assertion is written by DIFFERENCE rather than
     * against an empty list. Unescaped it means "any single character", which matches every run;
     * escaped it matches only the three whose names genuinely contain one. The first version of
     * this test expected `[]` and failed — correctly — because `Android_UAE_Expenses_01` really
     * does contain an underscore.
     */
    const underscore = ids(await list('?q=_')).sort();
    assert.deepEqual(underscore, ['nightly-1', 'nightly-2', 'nightly-3']);
    assert.ok(!underscore.includes('pr-4471'), '`_` must not behave as "any character"');
  });
});

describe('status, which must agree with the badge', () => {
  test('failed selects the run with a failure', async () => {
    assert.deepEqual(ids(await list('?status=failed')), ['nightly-2']);
  });

  test('passed excludes the unreported run — not measured is not green', async () => {
    const got = ids(await list('?status=passed')).sort();
    assert.deepEqual(got, ['nightly-1', 'pr-4471']);
    assert.ok(!got.includes('nightly-3'), 'a run nobody reported has not passed');
  });

  test('not-reported finds exactly the run nothing spoke for', async () => {
    assert.deepEqual(ids(await list('?status=not-reported')).sort(), ['nightly-3', 'pr-4472']);
  });

  test('live finds the run still going', async () => {
    assert.deepEqual(ids(await list('?status=live')), ['pr-4472']);
  });

  test('EVERY ROW CARRIES THE OUTCOME THE FILTER SELECTED IT FOR', async () => {
    // The actual anti-D35 assertion: the filter and the field are one derivation, so a row can
    // never come back under a status its own badge would contradict.
    for (const status of ['passed', 'failed', 'not-reported']) {
      const runs = (await list(`?status=${status}`)).json().runs;
      assert.ok(runs.length, `${status} should match something in this fixture`);
      for (const r of runs) assert.equal(r.outcome, status, `${r.runId} came back under ${status}`);
    }
  });

  test('an unknown status is refused rather than ignored', async () => {
    const res = await list('?status=green');
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /passed|failed/);
  });
});

describe('date window', () => {
  test('from and to bound it inclusively', async () => {
    assert.deepEqual(ids(await list(`?from=${AT(2)}&to=${AT(4)}`)).sort(),
      ['nightly-2', 'nightly-3', 'pr-4471']);
  });

  test('a garbage date is refused, not silently dropped', async () => {
    const res = await list('?from=last%20tuesday');
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /ISO 8601/);
  });
});

describe('pagination', () => {
  test('a short page reports no cursor, so a client knows to stop', async () => {
    assert.equal((await list('?limit=200')).json().nextCursor, null);
  });

  test('pages walk the whole list without repeating a row', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const res: Awaited<ReturnType<typeof list>> = await list(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const body = res.json();
      seen.push(...body.runs.map((r: { runId: string }) => r.runId));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    assert.equal(new Set(seen).size, seen.length, `a row was repeated: ${seen.join(',')}`);
    assert.deepEqual(seen, ['pr-4472', 'pr-4471', 'nightly-3', 'nightly-2', 'nightly-1']);
  });

  test('A RUN CREATED MID-PAGINATION DOES NOT SHIFT THE PAGES — the reason this is keyset', async () => {
    const first = (await list('?limit=2')).json();
    assert.deepEqual(first.runs.map((r: { runId: string }) => r.runId), ['pr-4472', 'pr-4471']);

    // The event an OFFSET cannot survive: a write lands at the HEAD between page one and page two.
    await seedRun({ externalId: 'arrived-midway', createdAt: AT(6) });

    const second = (await list(`?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    const got = second.runs.map((r: { runId: string }) => r.runId);
    // With OFFSET 2 this would have returned pr-4471 again — the new row having pushed everything
    // down one. Anchored to the last row of page one instead, it simply continues.
    assert.deepEqual(got, ['nightly-3', 'nightly-2']);
    assert.ok(!got.includes('arrived-midway'), 'a row created after page one must not appear inside it');
  });

  test('filters survive pagination', async () => {
    const res = (await list('?q=nightly&limit=1')).json();
    assert.equal(res.runs.length, 1);
    const next = (await list(`?q=nightly&limit=1&cursor=${encodeURIComponent(res.nextCursor)}`)).json();
    assert.ok(next.runs[0].runId.startsWith('nightly'), 'the second page must still be filtered');
  });

  test('a cursor this API did not issue is refused', async () => {
    for (const bad of ['not-base64', Buffer.from('{"t":"nope","i":"x"}').toString('base64url')]) {
      const res = await list(`?cursor=${encodeURIComponent(bad)}`);
      assert.equal(res.statusCode, 400, `${bad} should be refused`);
    }
  });
});

describe('tenancy', () => {
  test('search cannot reach another org’s runs', async () => {
    const otherOrg = await withSystem(async (c) => (await c.query(
      `INSERT INTO orgs (slug, name, max_concurrent) VALUES ($1,'Other',50) RETURNING id`,
      [`runsq-other-${randomUUID()}`])).rows[0].id);
    await withSystem((c) => c.query(
      `INSERT INTO runs (org_id, external_id, name) VALUES ($1,'nightly-secret','Expenses')`, [otherOrg]));

    // The same query that finds this org's expenses runs must not find theirs -- RLS, not a WHERE
    // clause in the handler, is what enforces it.
    assert.deepEqual(ids(await list('?q=nightly-secret')), []);
    assert.deepEqual(ids(await list('?q=Expenses')).sort(), ['nightly-1', 'nightly-2']);
  });
});
