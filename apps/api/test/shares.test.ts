/**
 * Share links — showing ONE failure to somebody with no account here (migration 051).
 *
 * THE THING UNDER TEST IS A DISCLOSURE BOUNDARY, so most of these assert a REFUSAL or an ABSENCE.
 * A share is the only route in this repo that answers an anonymous caller with tenant data, and the
 * ways it can go wrong are not "the link does not work" — they are "the link works too well":
 * carrying the logcat, carrying the other seven tests that ran on the same session, staying alive
 * after it was withdrawn, or telling the holder of a withdrawn link that it used to be real.
 *
 * Every test here was watched fail against a deliberately broken version before being kept. The two
 * that found real defects while being written are marked where they sit: the RLS policy named a
 * setting nothing sets, and the step window is the difference between a share and a leak.
 */
process.env.RATE_LIMIT_MAX = '10000';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { createApiKey } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { appStore } from '../src/appstore.ts';
import { MAX_SHARE_DAYS, DEFAULT_SHARE_DAYS } from '../src/shares.ts';

let app: FastifyInstance;
let orgA: string, orgB: string, hostId: string, deviceId: string;
let keyA: string, keyB: string;
const REGION = 'share-test';

const auth = (k: string) => ({ authorization: `Bearer ${k}` });

// ---------------------------------------------------------------- fixtures

/** A session with `n` results on it, reported in order, with commands interleaved between them.
 *  Returns the session id and the result ids in the order they were reported. */
async function seedSession(orgId: string, tests: Array<{ name: string; status: string; failure?: string }>) {
  return withSystem(async (c) => {
    const start = new Date(Date.now() - 600_000);
    const { rows: [s] } = await c.query(
      `INSERT INTO sessions (org_id, device_id, state, region, started_at, ended_at, name)
       VALUES ($1,$2,'ENDED',$3,$4,now(),$5) RETURNING id`,
      [orgId, deviceId, REGION, start, 'medishop nightly'],
    );

    const resultIds: string[] = [];
    let seq = 0;
    let at = start.getTime();
    for (const t of tests) {
      /**
       * FIVE COMMANDS PER TEST, each stamped inside that test's own stretch of wall clock, then the
       * result reported after them. That is the real shape — a suite drives, then its `afterEach`
       * posts — and it is the only arrangement in which a window can be got wrong in a way a test
       * can see. A fixture that reported every result at the same instant would pass whatever the
       * window did.
       */
      for (let i = 0; i < 5; i++) {
        at += 1000;
        await c.query(
          `INSERT INTO session_commands (org_id, session_id, seq, method, path, status, duration_ms, started_at)
           VALUES ($1,$2,$3,'POST',$4,200,40,$5)`,
          [orgId, s.id, ++seq, `/element/${t.name.replace(/\W+/g, '-')}-${i}`, new Date(at)],
        );
      }
      at += 1000;
      const { rows: [r] } = await c.query(
        `INSERT INTO test_results (org_id, session_id, name, status, failure, duration_ms, reported_at)
         VALUES ($1,$2,$3,$4,$5,5000,$6) RETURNING id`,
        [orgId, s.id, t.name, t.status, t.failure ?? null, new Date(at)],
      );
      resultIds.push(r.id);
    }
    return { sessionId: s.id as string, resultIds };
  });
}

/** A screenshot artifact bound to one result, the way migration 040 binds it: through `context`. */
async function seedScreenshot(orgId: string, sessionId: string, resultId: string): Promise<string> {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    randomBytes(64),
  ]);
  const store = appStore(loadConfig().artifactDir);
  const blob = await store.put(Readable.from([png]), 10_000_000);
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO artifacts (org_id, session_id, device_id, kind, sha256, size_bytes,
                              content_type, filename, expires_at, context)
       VALUES ($1,$2,$3,'screenshot',$4,$5,'image/png','failure.png', now() + interval '7 days', $6::jsonb)
       RETURNING id`,
      [orgId, sessionId, deviceId, blob.sha256, png.length,
       JSON.stringify({ source: 'test-failure', testResultId: resultId, test: 'x' })],
    );
    return rows[0].id as string;
  });
}

const share = (key: string, resultId: string, body: unknown = {}) => app.inject({
  method: 'POST', url: `/v1/results/${resultId}/shares`, headers: auth(key),
  payload: body as Record<string, unknown>,
});

/** The anonymous fetch — NO headers at all, which is the whole point. */
const open = (token: string) => app.inject({ method: 'GET', url: `/v1/shares/${token}` });

before(async () => {
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Share Test')
                   ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgA = (await c.query(
      `INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,'Medishop QA',50) RETURNING id`,
      [`share-a-${randomUUID().slice(0, 8)}`])).rows[0].id;
    orgB = (await c.query(
      `INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,'Another Tenant',50) RETURNING id`,
      [`share-b-${randomUUID().slice(0, 8)}`])).rows[0].id;
    hostId = (await c.query(
      `INSERT INTO hosts (region, hostname, token_prefix, token_hash, state)
       VALUES ($1,$2,$3,$4,'UP') RETURNING id`,
      [REGION, `share-host-${randomUUID().slice(0, 8)}`,
       `shr_${randomUUID().slice(0, 8)}`, randomBytes(32).toString('hex')])).rows[0].id;
    deviceId = (await c.query(
      `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, capabilities, local_id)
       VALUES ($1,$2,'android','cuttlefish','MFARM X1 Pro','17','READY','[]'::jsonb,$3) RETURNING id`,
      [hostId, REGION, `share-${randomUUID()}`])).rows[0].id;
  });
  keyA = (await createApiKey(orgA, 'share test A')).plaintext;
  keyB = (await createApiKey(orgB, 'share test B')).plaintext;
  app = await buildServer({ logger: false });
});

after(async () => {
  await app?.close();
  await closePools();
});

// ---------------------------------------------------------------------------------------------

describe('making a link', () => {
  test('a share resolves for a caller with no credential at all', async () => {
    const { resultIds } = await seedSession(orgA, [
      { name: 'Expenses: a claim over the limit is refused', status: 'failed',
        failure: 'AssertionError: expected "Approved" to equal "Refused"\n  at claim.spec.ts:42' },
    ]);

    const made = await share(keyA, resultIds[0]);
    assert.equal(made.statusCode, 201, made.body);
    const { token, url, path } = made.json();
    assert.match(token, /^mfs_/, 'the token identifies itself, like mfk_ and mwk_');
    assert.ok(path.endsWith(token), 'the path carries the whole token');
    assert.ok(url.endsWith(path), `url should end with the path: ${url}`);

    const res = await open(token);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.test.name, 'Expenses: a claim over the limit is refused');
    assert.equal(body.test.status, 'failed');
    assert.match(body.test.failure, /expected "Approved"/);
    assert.equal(body.org.name, 'Medishop QA', 'the recipient is told where it came from');
    assert.equal(body.device.model, 'MFARM X1 Pro');
  });

  /**
   * THE TEST THAT CAUGHT THE FIRST REAL DEFECT, and it caught it before a line of route code
   * existed. The migration's policy read `current_setting('mfarm.org_id', true)` and nothing in
   * this repo sets `mfarm.org_id` — `withTenant` sets `app.org_id`. Every insert was refused and
   * every select returned nothing, so the feature was dead in a way that reads like care.
   */
  test('the row is actually written under the tenant policy', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'writes', status: 'failed' }]);
    assert.equal((await share(keyA, resultIds[0])).statusCode, 201);
    const listed = await app.inject({
      method: 'GET', url: `/v1/results/${resultIds[0]}/shares`, headers: auth(keyA),
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().shares.length, 1, 'RLS must admit the read as well as the write');
  });

  test('the token is returned exactly once and never by the listing', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'once', status: 'failed' }]);
    const { token } = (await share(keyA, resultIds[0])).json();
    const listed = await app.inject({
      method: 'GET', url: `/v1/results/${resultIds[0]}/shares`, headers: auth(keyA),
    });
    const raw = listed.body;
    assert.ok(!raw.includes(token), 'the plaintext token must never appear in a listing');
    assert.ok(raw.includes(token.slice(0, 12)), 'the prefix does, so a person can tell links apart');
  });

  /**
   * NOTHING THAT LOOKS LIKE A LINK MAY COME OUT OF A LISTING. The first version of `shareJson`
   * returned `path: sharePath(prefix)` — `/s/mfs_g4M9wlev`, a URL of exactly the right shape that
   * resolves to nothing, because a prefix is twelve characters of a forty-seven character
   * credential. The console would have put a copy button beside a dead link and the sender would
   * have had no way to tell. Found by reading one real HTTP response; no test had caught it.
   */
  test('a listing offers nothing that could be mistaken for the link', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'no dead links', status: 'failed' }]);
    await share(keyA, resultIds[0]);
    const row = (await app.inject({
      method: 'GET', url: `/v1/results/${resultIds[0]}/shares`, headers: auth(keyA),
    })).json().shares[0];
    for (const field of ['path', 'url', 'token', 'link']) {
      assert.equal(row[field], undefined,
        `a listing carrying "${field}" would be a link built from a prefix, which 404s`);
    }
  });

  test('a result belonging to another org cannot be shared, and reads as absent', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'not yours', status: 'failed' }]);
    const res = await share(keyB, resultIds[0]);
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(res.json().error.code, 'not_found');
  });

  test('an expiry beyond the ceiling is refused, naming the ceiling', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'forever', status: 'failed' }]);
    const res = await share(keyA, resultIds[0], { expiresInDays: MAX_SHARE_DAYS + 1 });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.body, new RegExp(String(MAX_SHARE_DAYS)));
  });

  test('the default expiry is the documented one, not whatever the column allows', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'default', status: 'failed' }]);
    const { share: s } = (await share(keyA, resultIds[0])).json();
    const days = (Date.parse(s.expiresAt) - Date.now()) / 86_400_000;
    assert.ok(Math.abs(days - DEFAULT_SHARE_DAYS) < 0.01, `expected ~${DEFAULT_SHARE_DAYS} days, got ${days}`);
  });

  /**
   * A PASSING RESULT IS SHAREABLE. The table is named for failures and the page is laid out for
   * one, but "it passes on the farm, so it is your local setup" is the same conversation pointed
   * the other way, and refusing it would be an arbitrary wall a person hits on the day they want it.
   */
  test('a passing result can be shared too', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'a cardholder submits a claim', status: 'passed' }]);
    const made = await share(keyA, resultIds[0]);
    assert.equal(made.statusCode, 201, made.body);
    assert.equal((await open(made.json().token)).json().test.status, 'passed');
  });
});

// ---------------------------------------------------------------------------------------------

describe('what the link does NOT carry', () => {
  /**
   * THE TEST THAT CAUGHT THE SECOND DEFECT SHAPE, and the one this whole feature turns on.
   *
   * `session_commands` is the WHOLE SESSION's step trace. On the one-test-per-session shape that is
   * this test and nothing else — which is why a naive implementation passes every other test in
   * this file. A session running three scenarios would hand the link holder all three, which is
   * exactly the widening that scoping a share to one result exists to prevent.
   */
  test('a share on a multi-test session carries only ITS OWN steps', async () => {
    const { resultIds } = await seedSession(orgA, [
      { name: 'one: signs in', status: 'passed' },
      { name: 'two: opens the claim', status: 'passed' },
      { name: 'three: is refused over the limit', status: 'failed', failure: 'boom' },
    ]);

    const { token } = (await share(keyA, resultIds[2])).json();
    const body = (await open(token)).json();

    const paths = body.steps.items.map((s: { path: string }) => s.path).join(' ');
    assert.ok(paths.includes('three'), 'the failing test’s own steps must be here');
    assert.ok(!paths.includes('one:'), `steps from test one leaked: ${paths}`);
    assert.ok(!paths.includes('two:'), `steps from test two leaked: ${paths}`);
    assert.equal(body.steps.items.length, 5, 'exactly the five commands of this test');
  });

  test('the FIRST test on a session is windowed from the session start, not from nothing', async () => {
    const { resultIds } = await seedSession(orgA, [
      { name: 'first: signs in', status: 'failed', failure: 'boom' },
      { name: 'second: does more', status: 'passed' },
    ]);
    const { token } = (await share(keyA, resultIds[0])).json();
    const body = (await open(token)).json();
    const paths = body.steps.items.map((s: { path: string }) => s.path).join(' ');
    assert.equal(body.steps.items.length, 5, `expected the first test's five steps, got ${paths}`);
    assert.ok(!paths.includes('second'), 'a later test’s steps must not be in an earlier window');
  });

  test('no logcat is reachable through a share, by any field', async () => {
    const { sessionId, resultIds } = await seedSession(orgA, [{ name: 'logs', status: 'failed' }]);
    await withSystem((c) => c.query(
      `INSERT INTO artifacts (org_id, session_id, device_id, kind, sha256, size_bytes,
                              content_type, filename, expires_at, context)
       VALUES ($1,$2,$3,'logcat',$4,99,'text/plain','log.txt', now() + interval '7 days', $5::jsonb)`,
      [orgA, sessionId, deviceId, randomBytes(32).toString('hex'),
       JSON.stringify({ source: 'test-failure', testResultId: resultIds[0] })]));

    const { token } = (await share(keyA, resultIds[0])).json();
    const res = await open(token);
    assert.equal(res.statusCode, 200);
    /**
     * Asserted against the RAW BODY rather than against a field, because the failure mode is a
     * field nobody meant to add. A check for `body.logcat === undefined` passes happily while
     * `body.artifacts[1].kind` says 'logcat'.
     */
    assert.ok(!res.body.includes('logcat'), `a share must not mention the log at all: ${res.body}`);
    assert.equal(res.json().screenshot, false, 'a log is not a screenshot');
  });

  test('no session id, org id or device id is disclosed', async () => {
    const { sessionId, resultIds } = await seedSession(orgA, [{ name: 'ids', status: 'failed' }]);
    const { token } = (await share(keyA, resultIds[0])).json();
    const raw = (await open(token)).body;
    for (const [what, id] of [['session', sessionId], ['org', orgA], ['device', deviceId]] as const) {
      assert.ok(!raw.includes(id), `the ${what} id is a map of this tenant's fleet and leaked: ${raw}`);
    }
  });

  test('no recording is offered, even when the session has one', async () => {
    // The test is NOT named "video": the assertion below greps the raw body, and a fixture whose
    // own test name contained the word would fail on its own echo. That is not a hypothetical —
    // it is what the first version of this test did.
    const { sessionId, resultIds } = await seedSession(orgA, [{ name: 'a recorded run', status: 'failed' }]);
    await withSystem((c) => c.query(
      `INSERT INTO artifacts (org_id, session_id, device_id, kind, sha256, size_bytes,
                              content_type, filename, expires_at, context)
       VALUES ($1,$2,$3,'video',$4,4096,'video/webm','rec.webm', now() + interval '7 days', '{}'::jsonb)`,
      [orgA, sessionId, deviceId, randomBytes(32).toString('hex')]));
    const { token } = (await share(keyA, resultIds[0])).json();
    const raw = (await open(token)).body;
    assert.ok(!raw.includes('video'), `a recording covers every test on the session: ${raw}`);
    assert.ok(!raw.includes('webm'), raw);
  });
});

// ---------------------------------------------------------------------------------------------

describe('withdrawing it', () => {
  test('a revoked link stops working', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'revoke me', status: 'failed' }]);
    const { token } = (await share(keyA, resultIds[0])).json();
    assert.equal((await open(token)).statusCode, 200);

    const gone = await app.inject({
      method: 'DELETE', url: `/v1/shares/${token.slice(0, 12)}`, headers: auth(keyA),
    });
    assert.equal(gone.statusCode, 200, gone.body);
    assert.equal(gone.json().revoked, true);
    assert.equal((await open(token)).statusCode, 404, 'a withdrawn link must be dead');
  });

  /**
   * REVOKED AND NEVER-EXISTED MUST BE THE SAME ANSWER. A page that distinguished them would confirm
   * to somebody holding a withdrawn link that they once held a real one, which is exactly the fact
   * revocation is trying to take back.
   */
  test('a revoked link is indistinguishable from one that never existed', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'indistinguishable', status: 'failed' }]);
    const { token } = (await share(keyA, resultIds[0])).json();
    await app.inject({ method: 'DELETE', url: `/v1/shares/${token.slice(0, 12)}`, headers: auth(keyA) });

    const revoked = await open(token);
    const invented = await open(`mfs_${randomBytes(32).toString('base64url')}`);
    assert.equal(revoked.statusCode, invented.statusCode);
    /**
     * The `requestId` is per-request and is the one field that MUST differ — it is how a person
     * reporting "this link is broken" is matched to a log line. Everything else has to be identical,
     * so it is masked rather than the comparison being softened to a status code.
     */
    const mask = (b: string) => b.replace(/"requestId":"[^"]+"/, '"requestId":"<per-request>"');
    assert.equal(mask(revoked.body), mask(invented.body), 'the two must be otherwise identical');
  });

  test('another org cannot revoke this org’s link', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'not yours to revoke', status: 'failed' }]);
    const { token } = (await share(keyA, resultIds[0])).json();
    const tried = await app.inject({
      method: 'DELETE', url: `/v1/shares/${token.slice(0, 12)}`, headers: auth(keyB),
    });
    assert.equal(tried.statusCode, 200, 'the prefix reads as absent, not as forbidden');
    assert.equal(tried.json().revoked, false);
    assert.equal((await open(token)).statusCode, 200, 'and the link is untouched');
  });

  test('revoking is idempotent', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'twice', status: 'failed' }]);
    const { token } = (await share(keyA, resultIds[0])).json();
    const p = token.slice(0, 12);
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/shares/${p}`, headers: auth(keyA) })).json().revoked, true);
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/shares/${p}`, headers: auth(keyA) })).json().revoked, false);
  });

  test('an expired link stops working', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'expired', status: 'failed' }]);
    const { token } = (await share(keyA, resultIds[0])).json();
    await withSystem((c) => c.query(
      "UPDATE result_shares SET expires_at = now() - interval '1 minute' WHERE prefix = $1",
      [token.slice(0, 12)]));
    assert.equal((await open(token)).statusCode, 404);
  });

  test('a listing shows a withdrawn link as inactive rather than hiding it', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'audit', status: 'failed' }]);
    const { token } = (await share(keyA, resultIds[0])).json();
    await app.inject({ method: 'DELETE', url: `/v1/shares/${token.slice(0, 12)}`, headers: auth(keyA) });
    const shares = (await app.inject({
      method: 'GET', url: `/v1/results/${resultIds[0]}/shares`, headers: auth(keyA),
    })).json().shares;
    assert.equal(shares.length, 1, '"who did I send this to and did I withdraw it" needs the row');
    assert.equal(shares[0].active, false);
    assert.ok(shares[0].revokedAt);
  });
});

// ---------------------------------------------------------------------------------------------

describe('the credential itself', () => {
  test('a share token authenticates as nothing on the ordinary API', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'not a key', status: 'failed' }]);
    const { token } = (await share(keyA, resultIds[0])).json();
    const res = await app.inject({ method: 'GET', url: '/v1/devices', headers: auth(token) });
    assert.equal(res.statusCode, 401, 'mfs_ is not mfk_ and must open no tenant door');
  });

  test('a correct prefix with the wrong secret is refused', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'guess', status: 'failed' }]);
    const { token } = (await share(keyA, resultIds[0])).json();
    const forged = `${token.slice(0, 12)}${randomBytes(32).toString('base64url')}`;
    assert.notEqual(forged, token);
    assert.equal((await open(forged)).statusCode, 404);
  });

  test('nonsense in the token position is a 404, not a 500', async () => {
    for (const bad of ['x', 'mfs_', 'mfk_something', '../../etc/passwd', '%00']) {
      const res = await app.inject({ method: 'GET', url: `/v1/shares/${encodeURIComponent(bad)}` });
      assert.equal(res.statusCode, 404, `${bad} gave ${res.statusCode}`);
    }
  });

  test('opening a link counts a view', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'counted', status: 'failed' }]);
    const { token } = (await share(keyA, resultIds[0])).json();
    await open(token);
    const s = (await app.inject({
      method: 'GET', url: `/v1/results/${resultIds[0]}/shares`, headers: auth(keyA),
    })).json().shares[0];
    assert.equal(s.views, 1);
    assert.ok(s.lastViewedAt, '"is this link still circulating" needs both halves');
  });

  test('making a link requires a credential; opening one does not', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'doors', status: 'failed' }]);
    assert.equal((await app.inject({
      method: 'POST', url: `/v1/results/${resultIds[0]}/shares`, payload: {},
    })).statusCode, 401);
    assert.equal((await app.inject({
      method: 'DELETE', url: '/v1/shares/mfs_anything',
    })).statusCode, 401, 'the revoke route must NOT inherit the public prefix');
  });
});

// ---------------------------------------------------------------------------------------------

describe('the screenshot', () => {
  test('the screenshot captured for this result is served, and says so first', async () => {
    const { sessionId, resultIds } = await seedSession(orgA, [{ name: 'shot', status: 'failed' }]);
    await seedScreenshot(orgA, sessionId, resultIds[0]);

    const { token } = (await share(keyA, resultIds[0])).json();
    assert.equal((await open(token)).json().screenshot, true);

    const img = await app.inject({ method: 'GET', url: `/v1/shares/${token}/screenshot` });
    assert.equal(img.statusCode, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.equal(img.headers['cache-control'], 'no-store');
    assert.equal(img.rawPayload.subarray(0, 4).toString('hex'), '89504e47', 'real PNG bytes');
  });

  /**
   * A SCREENSHOT BOUND TO A DIFFERENT RESULT ON THE SAME SESSION IS NOT THIS ONE'S. Same widening
   * as the steps, in the artifact table: `context->>'testResultId'` is the whole scoping rule and a
   * query that only matched `session_id` would show the wrong test's screen under this stack.
   */
  test('a screenshot belonging to another test on the same session is not served', async () => {
    const { sessionId, resultIds } = await seedSession(orgA, [
      { name: 'first', status: 'failed' },
      { name: 'second', status: 'failed' },
    ]);
    await seedScreenshot(orgA, sessionId, resultIds[0]);

    const { token } = (await share(keyA, resultIds[1])).json();
    assert.equal((await open(token)).json().screenshot, false, 'this result captured nothing');
    assert.equal((await app.inject({
      method: 'GET', url: `/v1/shares/${token}/screenshot`,
    })).statusCode, 404);
  });

  test('a missing blob is reported as absent rather than served as a broken image', async () => {
    const { sessionId, resultIds } = await seedSession(orgA, [{ name: 'ghost', status: 'failed' }]);
    await withSystem((c) => c.query(
      `INSERT INTO artifacts (org_id, session_id, device_id, kind, sha256, size_bytes,
                              content_type, filename, expires_at, context)
       VALUES ($1,$2,$3,'screenshot',$4,10,'image/png','gone.png', now() + interval '7 days', $5::jsonb)`,
      [orgA, sessionId, deviceId, randomBytes(32).toString('hex'),
       JSON.stringify({ testResultId: resultIds[0] })]));
    const { token } = (await share(keyA, resultIds[0])).json();
    assert.equal((await open(token)).json().screenshot, false, 'the row exists; the bytes do not');
  });

  test('the screenshot route refuses a revoked token', async () => {
    const { sessionId, resultIds } = await seedSession(orgA, [{ name: 'revoked shot', status: 'failed' }]);
    await seedScreenshot(orgA, sessionId, resultIds[0]);
    const { token } = (await share(keyA, resultIds[0])).json();
    await app.inject({ method: 'DELETE', url: `/v1/shares/${token.slice(0, 12)}`, headers: auth(keyA) });
    assert.equal((await app.inject({
      method: 'GET', url: `/v1/shares/${token}/screenshot`,
    })).statusCode, 404, 'revocation must reach the bytes, not only the payload');
  });
});

// ---------------------------------------------------------------------------------------------

describe('the page and its headers', () => {
  test('the payload is not cacheable and not indexable', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'headers', status: 'failed' }]);
    const { token } = (await share(keyA, resultIds[0])).json();
    const res = await open(token);
    assert.equal(res.headers['cache-control'], 'no-store',
      'a shared cache holding this would make revocation a suggestion');
    assert.match(String(res.headers['x-robots-tag']), /noindex/);
    assert.equal(res.headers['referrer-policy'], 'no-referrer',
      'the token is in the URL and must not travel onward in a Referer');
  });

  test('/s/<token> serves the page to an anonymous browser', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'page', status: 'failed' }]);
    const { token } = (await share(keyA, resultIds[0])).json();
    const res = await app.inject({ method: 'GET', url: `/s/${token}` });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(String(res.headers['content-type']), /text\/html/);
    assert.match(res.body, /share\.js/, 'the shell must load its script');
  });

  /**
   * THE SHELL IS SERVED FOR AN INVALID TOKEN TOO, and that is deliberate rather than sloppy: the
   * page tells a person "this link has expired or been withdrawn" in prose, which is a far better
   * answer to a colleague opening a stale link than the framework's JSON 404. The PAYLOAD is what
   * refuses; the shell discloses nothing, being identical for every token.
   */
  test('the shell for an invalid token is byte-identical to the shell for a valid one', async () => {
    const { resultIds } = await seedSession(orgA, [{ name: 'shell', status: 'failed' }]);
    const { token } = (await share(keyA, resultIds[0])).json();
    const good = await app.inject({ method: 'GET', url: `/s/${token}` });
    const bad = await app.inject({ method: 'GET', url: '/s/mfs_nonsense' });
    assert.equal(bad.statusCode, 200);
    assert.equal(good.body, bad.body);
  });

  test('the page’s assets are served without a credential', async () => {
    for (const path of ['/share.css', '/share.js', '/design-tokens.css', '/profiles.js']) {
      const res = await app.inject({ method: 'GET', url: path });
      assert.equal(res.statusCode, 200, `${path} answered ${res.statusCode} — an import the browser cannot resolve is a blank page`);
    }
  });

  test('the page’s CSP names no external origin and no media', async () => {
    const res = await app.inject({ method: 'GET', url: '/s/mfs_whatever' });
    const csp = String(res.headers['content-security-policy']);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.ok(!csp.includes('media-src'), 'there is no recording on a share');
    assert.ok(!/https?:\/\//.test(csp), `no external origin belongs here: ${csp}`);
  });
});
