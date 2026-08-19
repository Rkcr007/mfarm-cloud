/**
 * Human sign-in: passwords, browser sessions, and the CSRF rule that makes a cookie safe to accept.
 *
 * The interesting cases here are all about a browser credential behaving differently from an API
 * key. A key is handed to a program deliberately; a cookie is attached by the browser to whatever it
 * is pointed at, and it belongs to a person whose authority can be taken away while the credential
 * is still in their hand.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { upsertUser, hashPassword, verifyPassword, cookieValue } from '../src/users.ts';

let app: FastifyInstance;
let orgId: string, otherOrgId: string;
const EMAIL = `person-${randomUUID()}@example.test`;
const PASSWORD = 'correct horse battery staple';

/** Log in and return the pieces a browser would then be holding. */
async function signIn(email = EMAIL, password = PASSWORD) {
  const res = await app.inject({
    method: 'POST', url: '/v1/auth/login', payload: { email, password },
  });
  if (res.statusCode !== 200) return { res, cookie: undefined, csrf: undefined };
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  return {
    res,
    cookie: `mfarm_session=${cookieValue(raw.replace(/; /g, '; '), 'mfarm_session')}`,
    csrf: res.json().csrfToken as string,
  };
}

before(async () => {
  // The login limiter is per-IP and `inject()` presents one address for the whole file, so the real
  // default would be spent partway through and every later case would fail as "login returned no
  // cookie" rather than as itself. The limit gets its own server below, where it is the subject.
  app = await buildServer({ logger: false, loginRateLimitMax: 10_000 });
  await withSystem(async (c) => {
    const a = await c.query(
      `INSERT INTO orgs (slug, name) VALUES ($1,'Login Test') RETURNING id`, [`login-${randomUUID()}`]);
    orgId = a.rows[0].id;
    const b = await c.query(
      `INSERT INTO orgs (slug, name) VALUES ($1,'Other Org') RETURNING id`, [`other-${randomUUID()}`]);
    otherOrgId = b.rows[0].id;
  });
  await upsertUser(EMAIL, PASSWORD, orgId, 'admin');
});

after(async () => {
  await app.close();
  await closePools();
});

describe('password hashing', () => {
  test('a digest carries its own cost, so the cost can be raised later', async () => {
    const digest = await hashPassword(PASSWORD);
    const [scheme, n, r, p] = digest.split('$');
    assert.equal(scheme, 'scrypt');
    // Encoded rather than assumed: an old digest must still verify under its own parameters.
    assert.ok(Number(n) >= 32768 && Number(r) > 0 && Number(p) > 0);
    assert.equal(await verifyPassword(PASSWORD, digest), true);
    assert.equal(await verifyPassword('wrong', digest), false);
  });

  test('the same password twice produces different digests', async () => {
    // Per-user salt. Equal digests would let one leak answer "who else uses this password".
    assert.notEqual(await hashPassword(PASSWORD), await hashPassword(PASSWORD));
  });

  test('a corrupt or absent digest never authenticates', async () => {
    for (const bad of [null, '', 'not-a-digest', 'scrypt$x$y$z$a$b', 'scrypt$1$2$3']) {
      assert.equal(await verifyPassword(PASSWORD, bad as string | null), false, `accepted: ${bad}`);
    }
  });
});

describe('signing in', () => {
  test('a correct password returns a cookie and a CSRF token', async () => {
    const { res, cookie, csrf } = await signIn();
    assert.equal(res.statusCode, 200);
    assert.ok(cookie?.includes('mfarm_session=mus_'));
    assert.ok(csrf && csrf.length > 20);

    const raw = String(res.headers['set-cookie']);
    assert.match(raw, /HttpOnly/, 'script must not be able to read it');
    assert.match(raw, /SameSite=Strict/, 'the browser must not attach it cross-site');
    // The CSRF token is deliberately NOT a cookie — that is the whole of the double-submit.
    assert.doesNotMatch(raw, /csrf/i);
  });

  test('a wrong password and an unknown account are indistinguishable', async () => {
    const wrong = await app.inject({
      method: 'POST', url: '/v1/auth/login', payload: { email: EMAIL, password: 'nope' },
    });
    const unknown = await app.inject({
      method: 'POST', url: '/v1/auth/login', payload: { email: 'nobody@example.test', password: 'nope' },
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal(unknown.statusCode, 401);
    // Same code and same message: telling them apart is an account enumeration oracle.
    assert.deepEqual(wrong.json(), unknown.json());
  });

  test('login is reachable without being logged in', async () => {
    // Stating the obvious because the server authenticates by default, and a route added without
    // an explicit exemption is unreachable anonymously — which for THIS route is a lockout.
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: {} });
    assert.equal(res.statusCode, 400, 'reached the handler rather than being rejected as anonymous');
  });
});

describe('a session cookie is authority', () => {
  test('it authenticates a GET with no Authorization header at all', async () => {
    const { cookie } = await signIn();
    const res = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: cookie! } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user.email, EMAIL.toLowerCase());
    assert.equal(res.json().role, 'admin');
  });

  test('it reaches org-scoped endpoints, because a member holds the org\'s authority', async () => {
    const { cookie } = await signIn();
    const res = await app.inject({ method: 'GET', url: '/v1/devices', headers: { cookie: cookie! } });
    assert.equal(res.statusCode, 200);
  });

  test('it still cannot act as a worker', async () => {
    // The boundary that does NOT widen: a person must never be able to register a host.
    const { cookie } = await signIn();
    const res = await app.inject({
      method: 'POST', url: '/v1/workers/heartbeat', headers: { cookie: cookie! },
    });
    assert.equal(res.statusCode, 403);
  });

  test('an Authorization header wins over the cookie', async () => {
    // Otherwise a page logged in as one org could answer for a key belonging to another.
    const { cookie } = await signIn();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: cookie!, authorization: 'Bearer mfk_not-a-real-key-at-all-padding' },
    });
    // The header was preferred, failed to authenticate, and the cookie was not used as a fallback.
    assert.equal(res.statusCode, 401);
  });
});

describe('CSRF', () => {
  test('an unsafe request with a cookie and no CSRF header is refused', async () => {
    const { cookie } = await signIn();
    const res = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: cookie! } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'forbidden');
  });

  test('a wrong CSRF token is refused', async () => {
    const { cookie } = await signIn();
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/logout',
      headers: { cookie: cookie!, 'x-mfarm-csrf': 'a-token-from-somewhere-else' },
    });
    assert.equal(res.statusCode, 403);
  });

  test('the matching CSRF token is accepted', async () => {
    const { cookie, csrf } = await signIn();
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/logout',
      headers: { cookie: cookie!, 'x-mfarm-csrf': csrf! },
    });
    assert.equal(res.statusCode, 200);
  });

  test('an API key needs no CSRF token', async () => {
    // A key is never attached automatically, so there is nothing to forge. Requiring a token here
    // would break every existing machine client for no gain.
    const { createApiKey } = await import('../src/auth.ts');
    const key = await createApiKey(orgId);
    const res = await app.inject({
      method: 'POST', url: '/v1/sessions',
      headers: { authorization: `Bearer ${key.plaintext}` },
      payload: { region: 'nowhere-at-all', platform: 'android' },
    });
    assert.notEqual(res.statusCode, 403, 'a key must not be asked for a CSRF token');
  });
});

describe('a session must not outlive the authority it was minted from', () => {
  test('logout revokes it server-side, not just in the browser', async () => {
    const { cookie, csrf } = await signIn();
    await app.inject({
      method: 'POST', url: '/v1/auth/logout',
      headers: { cookie: cookie!, 'x-mfarm-csrf': csrf! },
    });
    // The cookie value still exists; it just no longer authenticates anywhere.
    const after = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: cookie! } });
    assert.equal(after.statusCode, 401);
  });

  test('changing the password invalidates every existing session', async () => {
    const { cookie } = await signIn();
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: cookie! } })).statusCode, 200);

    await upsertUser(EMAIL, 'a completely different password', orgId, 'admin');

    const after = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: cookie! } });
    assert.equal(after.statusCode, 401, 'the credential epoch must have moved under it');
  });

  test('losing the membership kills the session', async () => {
    const email = `temp-${randomUUID()}@example.test`;
    await upsertUser(email, PASSWORD, otherOrgId, 'member');
    const { cookie } = await signIn(email, PASSWORD);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: cookie! } })).statusCode, 200);

    await withSystem((c) => c.query(
      'DELETE FROM memberships WHERE org_id = $1 AND user_id = (SELECT id FROM users WHERE lower(email) = lower($2))',
      [otherOrgId, email],
    ));

    const after = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: cookie! } });
    assert.equal(after.statusCode, 401, 'removal from the org must take effect on the next request');
  });

  test('a session names one org, and it is the org it was minted for', async () => {
    // A user in two orgs gets a session pinned to one. An ambient "current org" that a request could
    // read differently from the check that authorised it is the shape of a cross-tenant leak.
    const email = `dual-${randomUUID()}@example.test`;
    await upsertUser(email, PASSWORD, orgId, 'member');
    await upsertUser(email, PASSWORD, otherOrgId, 'member');
    const { cookie } = await signIn(email, PASSWORD);
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: cookie! } });
    assert.equal(me.statusCode, 200);
    assert.ok([orgId, otherOrgId].includes(me.json().org.id));
  });
});

/**
 * The sign-in budget, which is deliberately much tighter than the general limit.
 *
 * This matters more since the console became internet-facing: a password is short enough to guess,
 * so the endpoint that checks one is the endpoint worth rationing. Its own server, with its own
 * small budget, because the point is to spend it.
 */
describe('login is rate limited harder than everything else', () => {
  let limited: FastifyInstance;
  const MAX = 3;
  // Its own account, not the shared EMAIL: a case above rotates that password, so borrowing it
  // would make these assertions depend on the order the file happens to run in.
  const LIMITED_EMAIL = `ratelimited-${randomUUID()}@example.test`;

  before(async () => {
    limited = await buildServer({ logger: false, loginRateLimitMax: MAX });
    await upsertUser(LIMITED_EMAIL, PASSWORD, orgId, 'member');
  });

  after(async () => {
    await limited.close();
  });

  test('a guessing run is cut off, and the cutoff is a 429 rather than a 500', async () => {
    const attempt = () => limited.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: LIMITED_EMAIL, password: 'not the password' },
      // A distinct address, so this case cannot be affected by anything else that has run.
      remoteAddress: '198.51.100.7',
    });

    for (let i = 0; i < MAX; i++) {
      assert.equal((await attempt()).statusCode, 401, `attempt ${i + 1} should still be answered`);
    }

    const blocked = await attempt();
    // 429 and not 500 is the whole assertion. The limiter `throw`s whatever errorResponseBuilder
    // returns, so returning a plain object there produces "Internal error" on the one path that
    // exists to say "slow down" — which is what the general limiter did until a test asked.
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().error.code, 'rate_limited');
  });

  test('the budget belongs to the address, so a spent one also blocks the right password', async () => {
    const from = '198.51.100.8';
    for (let i = 0; i < MAX; i++) {
      await limited.inject({
        method: 'POST', url: '/v1/auth/login',
        payload: { email: LIMITED_EMAIL, password: 'wrong' }, remoteAddress: from,
      });
    }

    // Stated as a test because it is a real cost, not an oversight: whoever is behind this address
    // cannot sign in until the window rolls. That is why the key is the address and not the
    // submitted email — keyed on email, anyone could spend a named colleague's budget for them and
    // lock that person out of their own account from anywhere.
    const correct = await limited.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: LIMITED_EMAIL, password: PASSWORD }, remoteAddress: from,
    });
    assert.equal(correct.statusCode, 429);
  });

  test('a different address has its own budget', async () => {
    const res = await limited.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: LIMITED_EMAIL, password: PASSWORD }, remoteAddress: '198.51.100.9',
    });
    assert.equal(res.statusCode, 200, 'one attacker must not be able to lock out the whole farm');
  });
});
