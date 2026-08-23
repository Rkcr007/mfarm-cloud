/**
 * The ORGANISATION surface: team members and API keys.
 *
 * Two things are under test here and only one of them is the feature. The other is migration 018 —
 * `users` had no RLS at all while `mfarm_app` held SELECT on every table, so the tenant pool could
 * read every account in the database. Nothing exploited it because every caller happened to use
 * `withSystem`; this file is where that stops being luck.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, withTenant, closePools } from '../src/db.ts';
import { upsertUser, cookieValue, CSRF_HEADER } from '../src/users.ts';

let app: FastifyInstance;
let orgId: string, otherOrgId: string;

const ADMIN = `admin-${randomUUID()}@example.test`;
const MEMBER = `member-${randomUUID()}@example.test`;
const OWNER = `owner-${randomUUID()}@example.test`;
const OUTSIDER = `outsider-${randomUUID()}@example.test`;
const PASSWORD = 'correct horse battery staple';

interface Session { cookie: string; csrf: string }

async function signIn(email: string, password = PASSWORD): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
  assert.equal(res.statusCode, 200, `sign-in for ${email} failed: ${res.body}`);
  const raw = Array.isArray(res.headers['set-cookie'])
    ? res.headers['set-cookie'][0] : String(res.headers['set-cookie']);
  return {
    cookie: `mfarm_session=${cookieValue(raw.replace(/; /g, '; '), 'mfarm_session')}`,
    csrf: res.json().csrfToken as string,
  };
}

/**
 * A browser request: cookie plus the double-submit header every unsafe route requires.
 *
 * The return type is annotated rather than inferred. `inject()` is heavily overloaded, and spreading
 * an optional payload into its argument makes TypeScript pick the callback-style overload — which
 * types the result as `void & Promise<Response> & Chain` and loses `.statusCode` entirely.
 */
function as(
  s: Session, method: string, url: string, payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: method as 'GET',
    url,
    headers: { cookie: s.cookie, [CSRF_HEADER]: s.csrf },
    ...(payload === undefined ? {} : { payload }),
  });
}

before(async () => {
  app = await buildServer({ logger: false, loginRateLimitMax: 10_000 });
  await withSystem(async (c) => {
    const a = await c.query(
      `INSERT INTO orgs (slug, name) VALUES ($1,'Account Test') RETURNING id`, [`acct-${randomUUID()}`]);
    orgId = a.rows[0].id;
    const b = await c.query(
      `INSERT INTO orgs (slug, name) VALUES ($1,'Other Org') RETURNING id`, [`acct-other-${randomUUID()}`]);
    otherOrgId = b.rows[0].id;
  });
  await upsertUser(OWNER, PASSWORD, orgId, 'owner');
  await upsertUser(ADMIN, PASSWORD, orgId, 'admin');
  await upsertUser(MEMBER, PASSWORD, orgId, 'member');
  await upsertUser(OUTSIDER, PASSWORD, otherOrgId, 'owner');
});

after(async () => {
  await app.close();
  await closePools();
});

// ------------------------------------------------------------------ RLS (migration 018)

describe('users are not readable across orgs', () => {
  test('the tenant pool sees only its own org members', async () => {
    // THE REGRESSION THIS GUARDS. Before 018 this query returned every user in the database — the
    // outsider included — because RLS was never enabled on `users`. A single missing join predicate
    // in any future query would have been a cross-tenant disclosure of addresses and password
    // hashes, with nothing underneath to catch it.
    const emails = await withTenant(orgId, async (c) => {
      const r = await c.query<{ email: string }>('SELECT email FROM users');
      return r.rows.map((x) => x.email);
    });
    assert.ok(emails.includes(ADMIN), 'own org member must be visible');
    assert.ok(!emails.includes(OUTSIDER), `another org's user leaked: ${emails.join(', ')}`);
  });

  test('the tenant pool cannot write a user row, and fails silently doing it', async () => {
    // SELECT-only policy on purpose: a write policy would let one request rewrite a colleague's
    // password_hash, which is an account takeover rather than a data leak.
    //
    // AND THE DENIAL IS SILENT, which is the part worth pinning down. With no UPDATE policy,
    // Postgres makes no row visible to the statement, so the UPDATE reports success having changed
    // nothing — it does NOT raise. Any future code that writes users through `withTenant` will
    // therefore appear to work and quietly do nothing, so the assertion is on the row, not on a
    // thrown error.
    const before = await withSystem(async (c) => {
      const r = await c.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE email = $1', [ADMIN]);
      return r.rows[0].password_hash;
    });

    const changed = await withTenant(orgId, async (c) => {
      const r = await c.query('UPDATE users SET password_hash = $1 WHERE email = $2', ['x', ADMIN]);
      return r.rowCount ?? 0;
    });
    assert.equal(changed, 0, 'the tenant pool must not be able to update a user row');

    const after = await withSystem(async (c) => {
      const r = await c.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE email = $1', [ADMIN]);
      return r.rows[0].password_hash;
    });
    assert.equal(after, before, 'the password hash must be untouched');
  });

  test('browser session rows are invisible to the tenant pool', async () => {
    const rows = await withTenant(orgId, async (c) => {
      const r = await c.query('SELECT id FROM user_sessions');
      return r.rowCount ?? 0;
    });
    assert.equal(rows, 0, 'user_sessions must deny-all under RLS with no policy');
  });
});

// ------------------------------------------------------------------ team

describe('team', () => {
  test('any member can list the team, and sees only their org', async () => {
    const s = await signIn(MEMBER);
    const res = await as(s, 'GET', '/v1/account/members');
    assert.equal(res.statusCode, 200);
    const emails = res.json().members.map((m: { email: string }) => m.email);
    assert.ok(emails.includes(OWNER) && emails.includes(ADMIN) && emails.includes(MEMBER));
    assert.ok(!emails.includes(OUTSIDER));
  });

  test('last sign-in is reported, not silently nulled by RLS', async () => {
    // THE REGRESSION THIS GUARDS. `last_seen_at` began life as a subquery over `user_sessions`
    // inside the tenant-pool read. 018 makes that table deny-all to the tenant pool, and RLS
    // answers with NULL rather than an error — so the Team screen told a signed-in owner they had
    // "never signed in". A silent denial renders as a confident falsehood, which is worse than a
    // missing column.
    await signIn(OWNER);
    const s = await signIn(ADMIN);
    const members = (await as(s, 'GET', '/v1/account/members')).json().members;
    const owner = members.find((m: { email: string }) => m.email === OWNER);
    assert.ok(owner.lastSeenAt, 'a user who just signed in must not read as never having done so');
    assert.ok(Date.now() - new Date(owner.lastSeenAt).getTime() < 60_000);
  });

  test('a plain member cannot add anyone', async () => {
    // The first role check in this codebase; without it any member could mint themselves an admin.
    const s = await signIn(MEMBER);
    const res = await as(s, 'POST', '/v1/account/members',
      { email: `x-${randomUUID()}@example.test`, password: 'a'.repeat(14) });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'forbidden');
  });

  test('an admin can add a member', async () => {
    const s = await signIn(ADMIN);
    const email = `new-${randomUUID()}@example.test`;
    const res = await as(s, 'POST', '/v1/account/members', { email, password: 'a'.repeat(14) });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().member.email, email);
    assert.equal(res.json().created, true);
    // and the new person can actually sign in, which is the whole point of the endpoint
    await signIn(email, 'a'.repeat(14));
  });

  test('a short password is refused', async () => {
    const s = await signIn(ADMIN);
    const res = await as(s, 'POST', '/v1/account/members',
      { email: `short-${randomUUID()}@example.test`, password: 'short' });
    assert.equal(res.statusCode, 400);
  });

  test('a malformed address is refused', async () => {
    const s = await signIn(ADMIN);
    const res = await as(s, 'POST', '/v1/account/members',
      { email: 'not-an-address', password: 'a'.repeat(14) });
    assert.equal(res.statusCode, 400);
  });

  test('re-adding an existing address resets the password and kills their sessions', async () => {
    const email = `reset-${randomUUID()}@example.test`;
    const admin = await signIn(ADMIN);
    await as(admin, 'POST', '/v1/account/members', { email, password: 'a'.repeat(14) });

    const theirs = await signIn(email, 'a'.repeat(14));
    assert.equal((await as(theirs, 'GET', '/v1/account/members')).statusCode, 200);

    const again = await as(admin, 'POST', '/v1/account/members', { email, password: 'b'.repeat(14) });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().created, false);

    // The epoch bump is what makes a password reset a real revocation rather than a cosmetic one.
    assert.equal((await as(theirs, 'GET', '/v1/account/members')).statusCode, 401,
      'the old session must stop working the moment the password changes');
    await signIn(email, 'b'.repeat(14));
  });

  test('an admin cannot remove themselves', async () => {
    // Removing your own last admin membership locks the org out of this screen entirely, and the
    // only cure is SSH to the box — the thing this endpoint exists to stop being necessary.
    const s = await signIn(ADMIN);
    const me = (await as(s, 'GET', '/v1/account/members')).json().members
      .find((m: { email: string }) => m.email === ADMIN);
    const res = await as(s, 'DELETE', `/v1/account/members/${me.userId}`);
    assert.equal(res.statusCode, 400);
  });

  test('the only owner cannot be removed', async () => {
    const s = await signIn(ADMIN);
    const owner = (await as(s, 'GET', '/v1/account/members')).json().members
      .find((m: { email: string }) => m.email === OWNER);
    const res = await as(s, 'DELETE', `/v1/account/members/${owner.userId}`);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'last_owner');
  });

  test('removing a member revokes their access immediately', async () => {
    const email = `gone-${randomUUID()}@example.test`;
    const admin = await signIn(ADMIN);
    const made = await as(admin, 'POST', '/v1/account/members', { email, password: 'a'.repeat(14) });
    const userId = made.json().member.userId;

    const theirs = await signIn(email, 'a'.repeat(14));
    assert.equal((await as(theirs, 'GET', '/v1/account/members')).statusCode, 200);

    assert.equal((await as(admin, 'DELETE', `/v1/account/members/${userId}`)).statusCode, 200);
    assert.equal((await as(theirs, 'GET', '/v1/account/members')).statusCode, 401,
      'a removed member must not keep working until their cookie expires');
  });

  test("an admin cannot remove another org's member", async () => {
    const admin = await signIn(ADMIN);
    const outsiderId = await withSystem(async (c) => {
      const r = await c.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [OUTSIDER]);
      return r.rows[0].id;
    });
    const res = await as(admin, 'DELETE', `/v1/account/members/${outsiderId}`);
    assert.equal(res.statusCode, 404, 'must not reach across the org boundary');
    // and the outsider is untouched
    await signIn(OUTSIDER);
  });
});

// ------------------------------------------------------------------ api keys

describe('api keys', () => {
  test('an admin can mint a key, and the plaintext works', async () => {
    // This is the endpoint that makes the farm usable by anyone who does not have SSH to the box.
    const s = await signIn(ADMIN);
    const res = await as(s, 'POST', '/v1/account/api-keys');
    assert.equal(res.statusCode, 201);
    const { prefix, plaintextShownOnce } = res.json().key;
    assert.ok(plaintextShownOnce.length > 20);

    const used = await app.inject({
      method: 'GET', url: '/v1/devices',
      headers: { authorization: `Bearer ${plaintextShownOnce}` },
    });
    assert.equal(used.statusCode, 200, 'a freshly minted key must authenticate');
    assert.ok(prefix.length > 0);
  });

  test('listing never returns the secret', async () => {
    const s = await signIn(ADMIN);
    const created = await as(s, 'POST', '/v1/account/api-keys');
    const secret = created.json().key.plaintextShownOnce;

    const list = await as(s, 'GET', '/v1/account/api-keys');
    assert.equal(list.statusCode, 200);
    assert.ok(!list.body.includes(secret), 'the plaintext must be unrecoverable after creation');
    assert.ok(list.json().keys.some((k: { prefix: string }) => k.prefix === created.json().key.prefix));
  });

  test('a plain member cannot mint or revoke', async () => {
    const s = await signIn(MEMBER);
    assert.equal((await as(s, 'POST', '/v1/account/api-keys')).statusCode, 403);
    assert.equal((await as(s, 'DELETE', '/v1/account/api-keys/whatever')).statusCode, 403);
  });

  test('a member can still see which keys exist', async () => {
    const s = await signIn(MEMBER);
    assert.equal((await as(s, 'GET', '/v1/account/api-keys')).statusCode, 200);
  });

  test('revoking a key stops it authenticating', async () => {
    const s = await signIn(ADMIN);
    const created = await as(s, 'POST', '/v1/account/api-keys');
    const { prefix, plaintextShownOnce } = created.json().key;

    assert.equal((await as(s, 'DELETE', `/v1/account/api-keys/${prefix}`)).statusCode, 200);

    const used = await app.inject({
      method: 'GET', url: '/v1/devices',
      headers: { authorization: `Bearer ${plaintextShownOnce}` },
    });
    assert.equal(used.statusCode, 401, 'a revoked key must stop working at once');
  });

  test('revoking an unknown prefix is a 404, not a silent success', async () => {
    const s = await signIn(ADMIN);
    assert.equal((await as(s, 'DELETE', '/v1/account/api-keys/mfk_nope')).statusCode, 404);
  });

  test("one org cannot revoke another org's key", async () => {
    const outsider = await signIn(OUTSIDER);
    const theirKey = (await as(outsider, 'POST', '/v1/account/api-keys')).json().key;

    const admin = await signIn(ADMIN);
    const res = await as(admin, 'DELETE', `/v1/account/api-keys/${theirKey.prefix}`);
    assert.equal(res.statusCode, 404, 'revocation must be scoped to the calling org');

    const stillWorks = await app.inject({
      method: 'GET', url: '/v1/devices',
      headers: { authorization: `Bearer ${theirKey.plaintextShownOnce}` },
    });
    assert.equal(stillWorks.statusCode, 200);
  });
});
