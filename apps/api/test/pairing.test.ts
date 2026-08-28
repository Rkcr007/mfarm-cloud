/**
 * Pairing a machine by reading a code off its screen — ADR-0014, control-plane half.
 *
 * This flow exists to delete the worst step in the product: an org admin logging in by curl with a
 * cookie jar and a CSRF header to mint a token somebody then pastes into an environment variable.
 * What replaces it has two unauthenticated endpoints on a control plane that had none, so most of
 * what is checked here is what those two endpoints REFUSE, and what they hand out to somebody who
 * has not been approved by a human — which is nothing.
 *
 * The single most important test in the file is `an unapproved poll never returns a token`. Every
 * other guarantee is downstream of it: if a pairing could produce a credential without a signed-in
 * admin having said yes, the flow would be a way to enroll a machine into somebody else's org by
 * asking politely.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { upsertUser, cookieValue } from '../src/users.ts';
import { listEnrollments } from '../src/enrollment.ts';
import { formatUserCode, normalizeUserCode } from '../src/pairing.ts';

let app: FastifyInstance;
let orgId: string, otherOrgId: string;
let admin: { cookie: string; csrf: string };
let member: { cookie: string; csrf: string };
let otherAdmin: { cookie: string; csrf: string };

const ADMIN = `pair-admin-${randomUUID()}@example.test`;
const MEMBER = `pair-member-${randomUUID()}@example.test`;
const OTHER = `pair-other-${randomUUID()}@example.test`;
const PASSWORD = 'correct horse battery staple';

async function signIn(email: string) {
  const res = await app.inject({
    method: 'POST', url: '/v1/auth/login', payload: { email, password: PASSWORD },
  });
  assert.equal(res.statusCode, 200, `sign-in for ${email}`);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  return {
    cookie: `mfarm_session=${cookieValue(raw, 'mfarm_session')}`,
    csrf: res.json().csrfToken as string,
  };
}

/** What an agent does first: ask for a code. No credential of any kind. */
const start = (body: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/v1/pair', payload: body });

const poll = (deviceCode: string) =>
  app.inject({ method: 'POST', url: '/v1/pair/poll', payload: { deviceCode } });

const asUser = (who: { cookie: string; csrf: string }, url: string, userCode: string) =>
  app.inject({
    method: 'POST', url,
    headers: { cookie: who.cookie, 'x-mfarm-csrf': who.csrf },
    payload: { userCode },
  });

const inspect = (who: { cookie: string; csrf: string }, code: string) =>
  asUser(who, '/v1/pair/inspect', code);
const approve = (who: { cookie: string; csrf: string }, code: string) =>
  asUser(who, '/v1/pair/approve', code);

before(async () => {
  app = await buildServer({
    logger: false,
    loginRateLimitMax: 10_000,
    // The approval budget is per USER and this file approves far more often in a few seconds than a
    // person would. Its own server below, where the limit is the subject.
    pairing: { pairStartRateLimitMax: 10_000, pairPollRateLimitMax: 10_000, pairApproveRateLimitMax: 10_000 },
  });
  await withSystem(async (c) => {
    orgId = (await c.query(
      `INSERT INTO orgs (slug,name) VALUES ($1,'Pair Test') RETURNING id`,
      [`pair-${randomUUID()}`])).rows[0].id;
    otherOrgId = (await c.query(
      `INSERT INTO orgs (slug,name) VALUES ($1,'Other Org') RETURNING id`,
      [`pair-other-${randomUUID()}`])).rows[0].id;
  });
  await upsertUser(ADMIN, PASSWORD, orgId, 'admin');
  await upsertUser(MEMBER, PASSWORD, orgId, 'member');
  await upsertUser(OTHER, PASSWORD, otherOrgId, 'owner');
  admin = await signIn(ADMIN);
  member = await signIn(MEMBER);
  otherAdmin = await signIn(OTHER);
});

after(async () => {
  await app.close();
  await closePools();
});

// ------------------------------------------------------------------------------- the happy path

describe('pairing, end to end', () => {
  test('an agent shows a code, an admin approves it, and the poll returns a token', async () => {
    const started = await start({ hostname: 'ravi-macbook', platform: 'darwin-arm64', agentVersion: '0.1.0' });
    assert.equal(started.statusCode, 201);
    const { deviceCode, userCode, expiresAt, intervalSeconds } = started.json();

    // The code is what a person will read off a screen and type into another window.
    assert.match(userCode, /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
    assert.ok(deviceCode.length >= 32, 'the device code is a real secret, not a handle');
    assert.ok(new Date(expiresAt).getTime() > Date.now());
    assert.equal(intervalSeconds, 5);

    // Before anybody approves it, polling says so and hands over nothing.
    const pending = await poll(deviceCode);
    assert.equal(pending.statusCode, 200);
    assert.deepEqual(pending.json(), { status: 'pending', intervalSeconds: 5 });

    // The approver sees WHICH MACHINE before saying yes — ADR-0014 §2's phishing mitigation.
    const seen = await inspect(admin, userCode);
    assert.equal(seen.statusCode, 200);
    assert.deepEqual(seen.json().pairing.hostname, 'ravi-macbook');
    assert.equal(seen.json().pairing.platform, 'darwin-arm64');
    assert.equal(seen.json().pairing.approved, false);

    // Inspecting changed nothing.
    assert.equal((await poll(deviceCode)).json().status, 'pending');

    const approved = await approve(admin, userCode);
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().pairing.approved, true);

    const collected = await poll(deviceCode);
    assert.equal(collected.statusCode, 200);
    const body = collected.json();
    assert.equal(body.status, 'approved');
    assert.equal(body.orgId, orgId, 'the org comes from the approver, never from the agent');
    assert.match(body.token, /^mae_/, 'the same credential the curl path mints');

    // And it is a real enrollment in the org's own list, labelled so it is not a mystery row.
    const listed = await listEnrollments(orgId);
    const mine = listed.find((e) => body.token.startsWith(e.prefix));
    assert.ok(mine, 'the minted token is an ordinary agent_enrollments row');
    assert.equal(mine.label, 'paired from the agent window');
  });

  test('the token is delivered exactly once', async () => {
    const { deviceCode, userCode } = (await start()).json();
    await approve(admin, userCode);
    assert.equal((await poll(deviceCode)).json().status, 'approved');

    // A replay must not mint a second enrollment. `collected_at` is in the UPDATE's WHERE clause,
    // so two polls racing serialise and exactly one of them mints anything.
    const again = await poll(deviceCode);
    assert.equal(again.statusCode, 410);
    assert.equal(again.json().error.code, 'pairing_gone');
  });

  test('a code survives being typed the way it was displayed', async () => {
    const { userCode } = (await start()).json();
    // Displayed with a dash; a person may type it with, without, in lower case, or with a space.
    const typed = userCode.replace('-', ' ').toLowerCase();
    assert.equal((await inspect(admin, typed)).statusCode, 200);
    assert.equal((await approve(admin, userCode.replace('-', ''))).statusCode, 200);
  });
});

// ------------------------------------------------------------------ what an unapproved code gets

describe('a pairing nobody approved', () => {
  test('an unapproved poll never returns a token, however many times it asks', async () => {
    // THE TEST THIS FILE EXISTS FOR. Everything else is downstream: if a pairing could produce a
    // credential without a signed-in admin saying yes, this flow would be a way to enroll a machine
    // into somebody else's org by asking politely.
    const { deviceCode } = (await start()).json();
    for (let i = 0; i < 5; i += 1) {
      const res = await poll(deviceCode);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { status: 'pending', intervalSeconds: 5 });
      assert.ok(!('token' in res.json()));
    }
  });

  test('an unknown device code is refused, and says nothing about which exist', async () => {
    const res = await poll('a'.repeat(43));
    assert.equal(res.statusCode, 410);
    assert.equal(res.json().error.code, 'pairing_gone');
  });

  test('a device code too short to be one is refused without a query', async () => {
    const res = await poll('short');
    assert.equal(res.statusCode, 400, 'the schema catches it before anything looks it up');
  });

  test('the user code cannot be used to poll', async () => {
    // The two secrets do different jobs and must not be interchangeable — the short one is meant to
    // be read aloud, and it authenticates nothing.
    const { userCode } = (await start()).json();
    const res = await poll(normalizeUserCode(userCode).padEnd(32, 'X'));
    assert.equal(res.statusCode, 410);
  });
});

// --------------------------------------------------------------------------- who may approve

describe('who may approve a pairing', () => {
  test('an anonymous caller cannot inspect or approve', async () => {
    const { userCode } = (await start()).json();
    for (const url of ['/v1/pair/inspect', '/v1/pair/approve']) {
      const res = await app.inject({ method: 'POST', url, payload: { userCode } });
      assert.equal(res.statusCode, 401, url);
    }
  });

  test('a member cannot approve — this mints the same credential as the admin-only curl path', async () => {
    const { userCode, deviceCode } = (await start()).json();
    const res = await approve(member, userCode);
    assert.equal(res.statusCode, 403);
    assert.equal((await poll(deviceCode)).json().status, 'pending');
  });

  test('a session cookie without the CSRF header is refused', async () => {
    const { userCode } = (await start()).json();
    const res = await app.inject({
      method: 'POST', url: '/v1/pair/approve',
      headers: { cookie: admin.cookie },
      payload: { userCode },
    });
    assert.ok(res.statusCode === 403 || res.statusCode === 401, `got ${res.statusCode}`);
  });

  test('an api key is not a person, and this endpoint needs a person', async () => {
    const { userCode } = (await start()).json();
    const res = await app.inject({
      method: 'POST', url: '/v1/pair/approve',
      headers: { authorization: 'Bearer mfk_not-a-user-session' },
      payload: { userCode },
    });
    assert.ok(res.statusCode === 401 || res.statusCode === 403);
  });

  test('the org comes from the approver, so a different admin pairs it into a different org', async () => {
    const { deviceCode, userCode } = (await start()).json();
    assert.equal((await approve(otherAdmin, userCode)).statusCode, 200);
    const body = (await poll(deviceCode)).json();
    assert.equal(body.orgId, otherOrgId);
    assert.notEqual(body.orgId, orgId);
  });

  test('two admins racing on one code produce one approval', async () => {
    const { userCode } = (await start()).json();
    const [a, b] = await Promise.all([approve(admin, userCode), approve(otherAdmin, userCode)]);
    const codes = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(codes, [200, 409], 'exactly one wins; the loser is told it is already approved');
  });
});

// ------------------------------------------------------------------------------ bad codes

describe('codes that are not valid', () => {
  test('every failure looks the same to the caller', async () => {
    // Unknown, mistyped and wrong-length must be indistinguishable, or the endpoint becomes a way
    // to learn which codes exist.
    const bodies = new Set<string>();
    for (const code of ['ABCD-EFGH', 'ZZZZ-ZZZZ', '2345-6789']) {
      const res = await inspect(admin, code);
      assert.equal(res.statusCode, 404, code);
      bodies.add(JSON.stringify(res.json()));
    }
    assert.equal(bodies.size, 1, 'one message for every reason');
  });

  test('a code containing an excluded character is refused, not silently repaired', async () => {
    // `O`, `0`, `1`, `I` and `L` are not in the alphabet. Stripping them would turn a misread code
    // into a valid DIFFERENT one — pairing a machine the user never looked at.
    const { userCode } = (await start()).json();
    const withO = normalizeUserCode(userCode).slice(0, 4) + 'O' + normalizeUserCode(userCode).slice(4);
    const res = await inspect(admin, withO);
    assert.equal(res.statusCode, 404);
  });

  test('an approved code cannot be approved again', async () => {
    const { userCode } = (await start()).json();
    assert.equal((await approve(admin, userCode)).statusCode, 200);
    const second = await approve(admin, userCode);
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error.code, 'already_approved');
  });

  test('a collected code is gone for everyone', async () => {
    const { deviceCode, userCode } = (await start()).json();
    await approve(admin, userCode);
    await poll(deviceCode);
    assert.equal((await inspect(admin, userCode)).statusCode, 404);
    assert.equal((await approve(admin, userCode)).statusCode, 404);
  });
});

// ---------------------------------------------------------------------------------- expiry

describe('expiry', () => {
  /** Age a pairing by moving its expiry into the past — faster and more exact than waiting. */
  const expire = (deviceCodeHashSql: string) => withSystem(async (c) => {
    await c.query(`UPDATE agent_pairings SET expires_at = now() - interval '1 minute'
                    WHERE id = (SELECT id FROM agent_pairings ORDER BY created_at DESC LIMIT 1)`);
    return deviceCodeHashSql;
  });

  test('an expired pairing nobody approved is gone', async () => {
    const { deviceCode, userCode } = (await start()).json();
    await expire('');
    assert.equal((await poll(deviceCode)).statusCode, 410);
    assert.equal((await inspect(admin, userCode)).statusCode, 404);
  });

  test('an APPROVED pairing still collects after its TTL passes', async () => {
    /**
     * The TTL bounds how long an UNCLAIMED code is guessable. Once a human has approved it that
     * window is closed, so expiring it here would mean an admin approving at 9:59 and an agent
     * polling at 10:01 fails with nothing to show for it — a race nobody could diagnose.
     */
    const { deviceCode, userCode } = (await start()).json();
    assert.equal((await approve(admin, userCode)).statusCode, 200);
    await expire('');
    const res = await poll(deviceCode);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'approved');
    assert.match(res.json().token, /^mae_/);
  });

  test('starting a pairing sweeps expired ones', async () => {
    await start();
    await expire('');
    const before = await withSystem(async (c) =>
      Number((await c.query('SELECT count(*) c FROM agent_pairings WHERE expires_at < now() AND collected_at IS NULL')).rows[0].c));
    assert.ok(before > 0, 'there is something to sweep');
    await start();
    const after = await withSystem(async (c) =>
      Number((await c.query('SELECT count(*) c FROM agent_pairings WHERE expires_at < now() AND collected_at IS NULL')).rows[0].c));
    assert.equal(after, 0, 'the table is cleaned by the thing that grows it');
  });
});

// -------------------------------------------------------------------------------- storage

describe('what is actually stored', () => {
  test('neither secret is in the table in a usable form', async () => {
    const { deviceCode, userCode } = (await start()).json();
    const row = await withSystem(async (c) =>
      (await c.query('SELECT * FROM agent_pairings ORDER BY created_at DESC LIMIT 1')).rows[0]);
    const dumped = JSON.stringify(row);
    assert.ok(!dumped.includes(deviceCode), 'the device code is stored hashed');
    assert.ok(!dumped.includes(normalizeUserCode(userCode)), 'so is the user code');
  });

  test('no enrollment token exists until the agent collects one', async () => {
    // Minting at approval would leave a usable mae_ plaintext resting somewhere until the agent
    // came for it, and there is no good place to put that.
    const beforeCount = (await listEnrollments(orgId)).length;
    const { deviceCode, userCode } = (await start()).json();
    await approve(admin, userCode);
    assert.equal((await listEnrollments(orgId)).length, beforeCount,
      'approval alone mints nothing');
    await poll(deviceCode);
    assert.equal((await listEnrollments(orgId)).length, beforeCount + 1);
  });

  test('the machine description is bounded, because an unauthenticated caller supplies it', async () => {
    const started = await start({ hostname: 'x'.repeat(500) });
    // The schema refuses it outright rather than storing a truncated version of somebody's payload.
    assert.equal(started.statusCode, 400);
  });

  test('a pairing with no description is fine', async () => {
    const started = await start();
    assert.equal(started.statusCode, 201);
    const seen = await inspect(admin, started.json().userCode);
    assert.equal(seen.json().pairing.hostname, null);
  });
});

// ------------------------------------------------------------------------------ rate limiting

describe('rate limiting', () => {
  test('code attempts are capped per user, not per address', async () => {
    /**
     * Approval is where a guessed code would be cashed in, and it is the one budget that is a
     * security control rather than a cap on table growth. Per user, so an attacker with an account
     * cannot get a fresh allowance by changing address — and a legitimate admin cannot lose theirs
     * because a colleague on the same NAT was mistyping.
     */
    const own = await buildServer({
      logger: false, loginRateLimitMax: 10_000,
      pairing: { pairApproveRateLimitMax: 3, pairStartRateLimitMax: 10_000, pairPollRateLimitMax: 10_000 },
    });
    try {
      const res = await own.inject({
        method: 'POST', url: '/v1/auth/login', payload: { email: ADMIN, password: PASSWORD },
      });
      const raw = String(res.headers['set-cookie']);
      const who = {
        cookie: `mfarm_session=${cookieValue(raw, 'mfarm_session')}`,
        csrf: res.json().csrfToken as string,
      };
      const attempt = () => own.inject({
        method: 'POST', url: '/v1/pair/approve',
        headers: { cookie: who.cookie, 'x-mfarm-csrf': who.csrf },
        payload: { userCode: 'ZZZZ-ZZZZ' },
      });
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1) codes.push((await attempt()).statusCode);
      assert.ok(codes.includes(429), `expected a 429 among ${codes.join(',')}`);
      // And it is a proper error, not the 500 a plain object would produce from this plugin.
      const last = await attempt();
      assert.equal(last.statusCode, 429);
      assert.equal(last.json().error.code, 'rate_limited');
    } finally {
      await own.close();
    }
  });
});

describe('the code itself', () => {
  test('formats and normalizes as a round trip', () => {
    assert.equal(formatUserCode('ABCD2345'), 'ABCD-2345');
    assert.equal(normalizeUserCode('abcd-2345'), 'ABCD2345');
    assert.equal(normalizeUserCode('  abcd 2345 '), 'ABCD2345');
  });
});
