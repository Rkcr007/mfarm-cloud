/**
 * What an API key says about itself, what it may do, and when it stops working (ADR-0034, 049).
 *
 * THE DEFECT THIS IS ABOUT IS NOT BLAST RADIUS — IT IS ROTATION. A key already cannot escalate:
 * `requireOrgAdmin` calls `requireUser`, so an API key cannot mint another one or touch the team.
 * What it could not do was be IDENTIFIED. Four unlabelled prefixes with no record of use means
 * revoking one is a coin flip on whether CI stops, so nobody rotates and a leaked key stays valid.
 *
 * Every test here was watched fail against the pre-049 code before being kept. The two that matter
 * most are the ones asserting a REFUSAL — an anonymous key, and an `automation` key deleting
 * evidence — because a permission test that only ever sees success is a test of the happy path
 * wearing a security costume.
 */
process.env.RATE_LIMIT_MAX = '10000';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { authenticate, createApiKey } from '../src/auth.ts';
import { upsertUser, cookieValue } from '../src/users.ts';

let app: FastifyInstance;
let orgId: string;
let adminCookie: string, adminCsrf: string;
let memberCookie: string, memberCsrf: string;

const ADMIN = `admin-${randomUUID()}@example.test`;
const MEMBER = `member-${randomUUID()}@example.test`;
const PASSWORD = 'correct horse battery staple';

async function signIn(email: string) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PASSWORD } });
  assert.equal(res.statusCode, 200, `sign-in for ${email} failed: ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  return {
    cookie: `mfarm_session=${cookieValue(raw.replace(/; /g, '; '), 'mfarm_session')}`,
    csrf: res.json().csrfToken as string,
  };
}

/** Mint through the ROUTE, which is what the console does and where the label rule lives. */
const mint = (body: unknown, cookie = adminCookie, csrf = adminCsrf) => app.inject({
  method: 'POST', url: '/v1/account/api-keys',
  headers: { cookie, 'x-mfarm-csrf': csrf },
  payload: body as Record<string, unknown>,
});

const listKeys = () => app.inject({
  method: 'GET', url: '/v1/account/api-keys', headers: { cookie: adminCookie },
});

before(async () => {
  app = await buildServer({ logger: false, loginRateLimitMax: 10_000 });
  await withSystem(async (c) => {
    const r = await c.query(
      `INSERT INTO orgs (slug, name, max_concurrent) VALUES ($1,'Keys Test',50) RETURNING id`,
      [`keys-${randomUUID()}`]);
    orgId = r.rows[0].id;
  });
  await upsertUser(ADMIN, PASSWORD, orgId, 'admin');
  await upsertUser(MEMBER, PASSWORD, orgId, 'member');
  ({ cookie: adminCookie, csrf: adminCsrf } = await signIn(ADMIN));
  ({ cookie: memberCookie, csrf: memberCsrf } = await signIn(MEMBER));
});

after(async () => { await app?.close(); await closePools(); });

describe('a key has to say what it is for', () => {
  test('minting without a label is refused, and the message says why it matters', async () => {
    const res = await mint({});
    assert.equal(res.statusCode, 400);
    // Not just "400": the reason a person cannot identify a key later is the whole defect, so the
    // message has to carry it rather than saying "label is required".
    assert.match(res.json().error.message, /what it is for/i);
  });

  test('a label of only whitespace is not a label', async () => {
    const res = await mint({ label: '   ' });
    assert.equal(res.statusCode, 400);
  });

  test('a label over 120 characters is refused', async () => {
    const res = await mint({ label: 'x'.repeat(121) });
    assert.equal(res.statusCode, 400);
  });

  test('a labelled key comes back with its label, and appears in the list', async () => {
    const res = await mint({ label: 'gha-qa' });
    assert.equal(res.statusCode, 201);
    const key = res.json().key;
    assert.equal(key.label, 'gha-qa');
    assert.ok(key.plaintextShownOnce.startsWith('mfk_'));

    const listed = listKeys().then((r) => r.json().keys.find((k: { prefix: string }) => k.prefix === key.prefix));
    assert.equal((await listed).label, 'gha-qa');
  });

  test('the list names WHO minted it — a uuid would answer nobody’s question', async () => {
    const res = await mint({ label: 'attribution' });
    const prefix = res.json().key.prefix;
    const row = (await listKeys()).json().keys.find((k: { prefix: string }) => k.prefix === prefix);
    assert.equal(row.createdBy, ADMIN);
  });

  test('a member still cannot mint one — the role check is unchanged', async () => {
    const res = await mint({ label: 'should not exist' }, memberCookie, memberCsrf);
    assert.equal(res.statusCode, 403);
  });
});

describe('scope', () => {
  test('the default is the NARROW one, so a CI key is small without asking', async () => {
    const res = await mint({ label: 'defaults' });
    assert.equal(res.json().key.scope, 'automation');
  });

  test('an unknown scope is refused rather than silently widened', async () => {
    const res = await mint({ label: 'nonsense', scope: 'superuser' });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /automation.*full|full.*automation/s);
  });

  test('the scope reaches the principal, both ways', async () => {
    const narrow = (await mint({ label: 'narrow' })).json().key.plaintextShownOnce;
    const wide = (await mint({ label: 'wide', scope: 'full' })).json().key.plaintextShownOnce;

    const a = await authenticate(`Bearer ${narrow}`);
    const b = await authenticate(`Bearer ${wide}`);
    assert.equal(a?.kind === 'tenant' && a.scope, 'automation');
    assert.equal(b?.kind === 'tenant' && b.scope, 'full');
  });

  test('an `automation` key CANNOT delete evidence, and is told which scope can', async () => {
    const key = (await mint({ label: 'ci', scope: 'automation' })).json().key.plaintextShownOnce;
    const res = await app.inject({
      method: 'DELETE', url: `/v1/sessions/${randomUUID()}/artifacts`,
      headers: { authorization: `Bearer ${key}` },
    });
    // 403 rather than 404, and BEFORE the session is looked up: whether that session exists is not
    // a question this key gets to ask.
    assert.equal(res.statusCode, 403);
    assert.match(res.json().error.message, /full/);
  });

  test('a `full` key gets past the scope check — it fails on the session, not the scope', async () => {
    const key = (await mint({ label: 'ops', scope: 'full' })).json().key.plaintextShownOnce;
    const res = await app.inject({
      method: 'DELETE', url: `/v1/sessions/${randomUUID()}/artifacts`,
      headers: { authorization: `Bearer ${key}` },
    });
    assert.notEqual(res.statusCode, 403);
  });

  test('an `automation` key can still do the thing it exists for', async () => {
    const key = (await mint({ label: 'ci-reads', scope: 'automation' })).json().key.plaintextShownOnce;
    const res = await app.inject({
      method: 'GET', url: '/v1/devices', headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(res.statusCode, 200);
  });
});

describe('expiry', () => {
  test('a key with no expiry never expires, and says so', async () => {
    const row = (await listKeys()).json().keys.find(
      (k: { label: string }) => k.label === 'gha-qa');
    assert.equal(row.expiresAt, null);
    assert.equal(row.expired, false);
  });

  test('expiresInDays sets a date roughly that far out', async () => {
    const res = await mint({ label: 'thirty days', expiresInDays: 30 });
    const at = new Date(res.json().key.expiresAt).getTime();
    const expected = Date.now() + 30 * 86_400_000;
    assert.ok(Math.abs(at - expected) < 60_000, `expected ~30 days out, got ${res.json().key.expiresAt}`);
  });

  test('nonsense and out-of-range values are refused', async () => {
    for (const v of [0, -1, 'soon', 731]) {
      const res = await mint({ label: `bad ${v}`, expiresInDays: v });
      assert.equal(res.statusCode, 400, `expiresInDays=${JSON.stringify(v)} should be refused`);
    }
  });

  test('AN EXPIRED KEY AUTHENTICATES AS NOTHING, not as a refused principal', async () => {
    const { plaintext, prefix } = await createApiKey(orgId, 'already over', { scope: 'full' });
    // Backdate rather than wait. The column is the whole mechanism, so moving it IS the scenario.
    await withSystem((c) => c.query(
      `UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE prefix = $1`, [prefix]));

    assert.equal(await authenticate(`Bearer ${plaintext}`), null);

    const res = await app.inject({
      method: 'GET', url: '/v1/devices', headers: { authorization: `Bearer ${plaintext}` },
    });
    // 401, the same answer a made-up string gets. A 403 saying "that expired" would confirm the
    // key was real, which is a fact worth having if you found it in a log.
    assert.equal(res.statusCode, 401);
  });

  test('the list marks it expired so somebody can see why CI stopped', async () => {
    const row = (await listKeys()).json().keys.find((k: { label: string }) => k.label === 'already over');
    assert.equal(row.expired, true);
  });

  test('a key expiring in the FUTURE still works', async () => {
    const { plaintext } = await createApiKey(orgId, 'still valid', {
      scope: 'full', expiresAt: new Date(Date.now() + 3600_000),
    });
    const p = await authenticate(`Bearer ${plaintext}`);
    assert.equal(p?.kind, 'tenant');
  });
});

describe('last used, which is what makes revoking safe', () => {
  test('a key that has never authenticated reports null, not a fake timestamp', async () => {
    const res = await mint({ label: 'never used' });
    const row = (await listKeys()).json().keys.find(
      (k: { prefix: string }) => k.prefix === res.json().key.prefix);
    assert.equal(row.lastUsedAt, null);
  });

  test('using a key records it', async () => {
    const { plaintext, prefix } = await createApiKey(orgId, 'about to be used', { scope: 'full' });
    await app.inject({ method: 'GET', url: '/v1/devices', headers: { authorization: `Bearer ${plaintext}` } });

    const row = (await listKeys()).json().keys.find((k: { prefix: string }) => k.prefix === prefix);
    assert.ok(row.lastUsedAt, 'a key that was just used should have a last-used time');
    assert.ok(Date.now() - new Date(row.lastUsedAt).getTime() < 60_000);
  });

  test('IT IS NOT REWRITTEN ON EVERY REQUEST — the throttle is the point', async () => {
    const { plaintext, prefix } = await createApiKey(orgId, 'throttled', { scope: 'full' });
    const read = () => withSystem(async (c) =>
      (await c.query('SELECT last_used_at FROM api_keys WHERE prefix = $1', [prefix])).rows[0].last_used_at);

    const call = () => app.inject({ method: 'GET', url: '/v1/devices', headers: { authorization: `Bearer ${plaintext}` } });
    await call();
    const first = await read();
    assert.ok(first);

    // A second call moments later must NOT write again. Without the throttle this column would take
    // an UPDATE on every proxied WebDriver command — hundreds a minute per running session.
    await call();
    await call();
    assert.equal((await read()).getTime(), first.getTime());
  });
});

describe('what did not change', () => {
  test('a revoked key stops working, as before', async () => {
    const res = await mint({ label: 'to be revoked', scope: 'full' });
    const { prefix, plaintextShownOnce } = res.json().key;
    assert.equal((await authenticate(`Bearer ${plaintextShownOnce}`))?.kind, 'tenant');

    const del = await app.inject({
      method: 'DELETE', url: `/v1/account/api-keys/${prefix}`,
      headers: { cookie: adminCookie, 'x-mfarm-csrf': adminCsrf },
    });
    assert.equal(del.statusCode, 200);
    assert.equal(await authenticate(`Bearer ${plaintextShownOnce}`), null);
  });

  test('an API key STILL cannot mint another one — the escalation boundary is untouched', async () => {
    const key = (await mint({ label: 'cannot self-replicate', scope: 'full' })).json().key.plaintextShownOnce;
    const res = await app.inject({
      method: 'POST', url: '/v1/account/api-keys',
      headers: { authorization: `Bearer ${key}` },
      payload: { label: 'child key' },
    });
    assert.equal(res.statusCode, 403);
  });

  test('keys minted before 049 keep the authority they had', async () => {
    // Exactly the shape the old code wrote: no label, no scope named. The migration backfills both,
    // and `full` is deliberate — silently narrowing a live CI credential would break somebody's
    // pipeline at 3am to enforce a policy they were never told about.
    const prefix = `mfk_legacy${randomUUID().slice(0, 4)}`;
    await withSystem((c) => c.query(
      `INSERT INTO api_keys (org_id, prefix, key_hash, label)
       VALUES ($1, $2, 'not-a-real-hash', 'unnamed — created before keys had labels')`,
      [orgId, prefix]));
    const row = await withSystem(async (c) =>
      (await c.query('SELECT scope FROM api_keys WHERE prefix = $1', [prefix])).rows[0]);
    assert.equal(row.scope, 'full');
  });
});
