import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { TOKEN_ALG, type SessionClaims } from '@mfarm/protocol';
import { AutomationGateway, type GrantAuthority } from '../src/gateway.ts';

/**
 * The automation gateway — ADR-0004, worker half.
 *
 * This is the one internet-facing listener on the worker whose correctness is a security boundary,
 * so the tests here are mostly about what it REFUSES. A gateway that proxies correctly but accepts
 * one grant it should not is an open Appium on the internet, and every failure mode is silent.
 *
 * Minting is done locally rather than imported. `packages/protocol` deliberately exports
 * verification only — a worker that could mint could forge access to its own devices and, with the
 * audience check, to nothing else, but the point of the split is that the code does not exist on
 * this side of the fleet boundary at all. The test plays the control plane's role explicitly.
 */

const kp = generateKeyPairSync('ed25519');
const PRIVATE_PEM = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_PEM = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** A second, unrelated keypair — the "signed by someone else entirely" case. */
const other = generateKeyPairSync('ed25519');
const OTHER_PRIVATE_PEM = other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_1 = '22222222-2222-4222-8222-222222222222';
const DEVICE_2 = '33333333-3333-4333-8333-333333333333';

function mint(
  claims: Partial<SessionClaims> = {},
  privateKeyPem = PRIVATE_PEM,
  ttlSeconds = 120,
): string {
  const now = Math.floor(Date.now() / 1000);
  const full: SessionClaims = {
    sid: 'session-1', did: DEVICE_1, org: 'org-1', fence: 1, aud: HOST_ID,
    iat: now, exp: now + ttlSeconds,
    ...claims,
  };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  const payload = `${TOKEN_ALG}.${body}`;
  const sig = sign(null, Buffer.from(payload), createPrivateKey(privateKeyPem));
  return `${payload}.${sig.toString('base64url')}`;
}

/** What the fake Appium recorded about the last request it received. */
interface Seen {
  method: string;
  url: string;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
}

describe('automation gateway', () => {
  let upstream: Server;
  let upstreamPort: number;
  let seen: Seen | undefined;
  /** Set to make the fake Appium answer something specific. */
  let reply: { status: number; body: string } = { status: 200, body: '{"value":{"ok":true}}' };

  let gateway: AutomationGateway;
  let port: number;

  /** Mutable so individual tests can knock out registration or reject a fence. */
  let authority: GrantAuthority;
  let fenceAnswer = true;
  let highWater = 0;

  before(async () => {
    upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        };
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body);
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upstreamPort = (upstream.address() as { port: number }).port;

    authority = {
      get hostId() { return HOST_ID; },
      get sessionPublicKey() { return PUBLIC_PEM; },
      deviceIdFor: (localId) => (localId === 'cf-1' ? DEVICE_1 : localId === 'cf-2' ? DEVICE_2 : undefined),
      acceptFence: (_did, fence) => {
        if (!fenceAnswer) return false;
        if (fence < highWater) return false;
        highWater = fence;
        return true;
      },
    };

    gateway = new AutomationGateway({
      agent: { // delegates so a test can swap the backing object mid-run
        get hostId() { return authority.hostId; },
        get sessionPublicKey() { return authority.sessionPublicKey; },
        deviceIdFor: (id) => authority.deviceIdFor(id),
        acceptFence: (d, f) => authority.acceptFence(d, f),
      },
      // Only cf-1 and cf-2 are served. cf-3 exists to the authority but has no Appium.
      targets: new Map([['cf-1', upstreamPort], ['cf-2', upstreamPort]]),
      upstreamHost: '127.0.0.1',
      maxBodyBytes: 1024,
    });
    port = await gateway.listen(0);
  });

  after(async () => {
    await gateway.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  beforeEach(() => {
    seen = undefined;
    reply = { status: 200, body: '{"value":{"ok":true}}' };
    fenceAnswer = true;
    highWater = 0;
  });

  const call = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, init);

  const withGrant = (token: string, init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
  });

  // ------------------------------------------------------------------ refusals

  test('a request with no grant is refused', async () => {
    const res = await call('/automation/cf-1/session');
    assert.equal(res.status, 401);
    assert.equal(seen, undefined, 'nothing reached Appium');
  });

  test('a grant signed by another key is refused', async () => {
    const res = await call('/automation/cf-1/session', withGrant(mint({}, OTHER_PRIVATE_PEM)));
    assert.equal(res.status, 403);
    assert.equal(seen, undefined);
  });

  test('an expired grant is refused', async () => {
    const res = await call('/automation/cf-1/session', withGrant(mint({}, PRIVATE_PEM, -10)));
    assert.equal(res.status, 401);
    assert.equal(seen, undefined);
  });

  test('a grant minted for another host is refused', async () => {
    // The check that stops a compromised worker replaying its neighbours' grants.
    const res = await call('/automation/cf-1/session', withGrant(mint({ aud: 'some-other-host' })));
    assert.equal(res.status, 403);
    assert.equal(seen, undefined);
  });

  test('a VALID grant for a different device on this host is refused', async () => {
    // Nothing is wrong with the signature; the authorization is wrong. This is the check no network
    // transport could make, and the reason a VPN was rejected in ADR-0004.
    const res = await call('/automation/cf-2/session', withGrant(mint({ did: DEVICE_1 })));
    assert.equal(res.status, 403);
    assert.equal(seen, undefined, 'a grant for cf-1 must not drive cf-2');
  });

  test('a stale fence is refused', async () => {
    fenceAnswer = false;
    const res = await call('/automation/cf-1/session', withGrant(mint({ fence: 1 })));
    assert.equal(res.status, 409);
    assert.equal(seen, undefined);
  });

  test('a fence below the high-water mark is refused after a higher one is seen', async () => {
    const ok = await call('/automation/cf-1/session', withGrant(mint({ fence: 7 })));
    assert.equal(ok.status, 200);
    const stale = await call('/automation/cf-1/session', withGrant(mint({ fence: 6 })));
    assert.equal(stale.status, 409, 'a partitioned hub replaying an old command');
  });

  test('an unknown device and an unknown path are indistinguishable', async () => {
    // Distinguishing them lets an unauthenticated caller enumerate the host's devices.
    const unknownDevice = await call('/automation/cf-9/session');
    const notAutomation = await call('/wd/hub/session');
    assert.equal(unknownDevice.status, 404);
    assert.equal(notAutomation.status, 404);
    assert.deepEqual(await unknownDevice.json(), await notAutomation.json());
  });

  test('a device the agent knows but has no Appium for is refused before any auth decision leaks', async () => {
    // cf-3 resolves to no uuid AND has no target. It must not 200, and must not say which.
    const res = await call('/automation/cf-3/session', withGrant(mint({})));
    assert.equal(res.status, 404);
  });

  test('an unregistered host refuses everything, temporarily', async () => {
    const saved = authority;
    authority = { ...saved, get hostId() { return undefined; }, get sessionPublicKey() { return undefined; } };
    try {
      const res = await call('/automation/cf-1/session', withGrant(mint({})));
      assert.equal(res.status, 503, 'our fault, not the callers — and never a fallback to proxying');
      assert.equal(seen, undefined);
    } finally {
      authority = saved;
    }
  });

  // ------------------------------------------------------------------ proxying

  test('a valid grant proxies path-transparently, with method, query and body', async () => {
    const res = await call(
      '/automation/cf-1/session/abc/element?using=id&value=hello',
      withGrant(mint({}), { method: 'POST', body: '{"using":"id"}', headers: { 'content-type': 'application/json' } }),
    );
    assert.equal(res.status, 200);
    assert.equal(seen?.method, 'POST');
    assert.equal(seen?.url, '/session/abc/element?using=id&value=hello',
      'the device segment is stripped and everything after it is verbatim');
    assert.equal(seen?.body, '{"using":"id"}');
  });

  test('the hub\'s base + "/session" concatenation still works unchanged', async () => {
    // ADR-0004 point 3: this is a change of what the url POINTS AT, not of how the hub uses it.
    const res = await call('/automation/cf-1/session', withGrant(mint({}), { method: 'POST', body: '{}' }));
    assert.equal(res.status, 200);
    assert.equal(seen?.url, '/session');
  });

  test('a request to the bare device base becomes "/" upstream', async () => {
    const res = await call('/automation/cf-1', withGrant(mint({})));
    assert.equal(res.status, 200);
    assert.equal(seen?.url, '/');
  });

  test('the grant is NOT forwarded to Appium', async () => {
    // Appium would not check it, and forwarding a bearer token to a process that logs its requests
    // is how credentials end up in a log file.
    await call('/automation/cf-1/session', withGrant(mint({})));
    assert.equal(seen?.headers.authorization, undefined);
  });

  test('upstream status and body are returned verbatim', async () => {
    reply = { status: 404, body: '{"value":{"error":"no such element"}}' };
    const res = await call('/automation/cf-1/session/abc/element', withGrant(mint({})));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { value: { error: 'no such element' } });
  });

  test('a body over the limit is refused and does not reach Appium', async () => {
    const res = await call(
      '/automation/cf-1/session',
      withGrant(mint({}), { method: 'POST', body: 'x'.repeat(4096) }),
    );
    assert.equal(res.status, 413);
    assert.equal(seen, undefined);
  });

  test('an unreachable Appium is a 502, not a hang', async () => {
    const dead = new AutomationGateway({
      agent: authority,
      targets: new Map([['cf-1', 1]]), // port 1: nothing listens
      upstreamHost: '127.0.0.1',
    });
    const p = await dead.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${p}/automation/cf-1/session`, withGrant(mint({})));
      assert.equal(res.status, 502);
    } finally {
      await dead.close();
    }
  });
});
