/**
 * ONE EXTERNAL ORIGIN: the console, the API and the live view all reachable on the same name.
 *
 * ---------------------------------------------------------------- the bug this file pins
 *
 * `browserEndpoint()` used to return null unless `DATA_PLANE_PUBLIC_BASE` named an absolute
 * `wss://` origin. Two deployment scripts disagreed with that:
 *
 *   * `deploy/setup-ingress.sh` proxies `/dp/*` on the console's own TLS name and has since
 *     ADR-0007 — over the agent's tunnel since ADR-0011;
 *   * `deploy/docker-compose.prod.yml` passes `DATA_PLANE_PUBLIC_BASE` through with an empty
 *     default, so the deployed farm never set it.
 *
 * So the ingress was routing the live view while the API told the browser no route existed — and on
 * a TUNNELLED host it went further and refused the session outright, releasing the device. The
 * configuration the deploy scripts actually produce was the one that could not allocate.
 *
 * ---------------------------------------------------------------- why NOT a second port
 *
 * The tempting fix is to publish the worker's data plane on its own public port and name it here.
 * That is the shape ADR-0005 already rejected and ADR-0011 removed: it needs a second listener
 * firewalled, a second certificate, a widened `connect-src`, and it cannot work at all for a host
 * behind NAT. A same-origin path needs none of those, so the assertions below are as much about
 * what stays ABSENT as about what works.
 *
 * `DATA_PLANE_PUBLIC_BASE` IS DELIBERATELY NOT SET IN THIS FILE. `ui.test.ts` sets it and tests the
 * other branch; each test file is its own process, so the two coexist. Do not add it here — it
 * would silently convert every assertion below into a test of the configured path.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { createApiKey } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { DATA_PLANE_TUNNEL_ENDPOINT } from '@mfarm/protocol';

const REGION = `one-origin-${randomUUID().slice(0, 8)}`;

let app: FastifyInstance;
let orgId: string;
let apiKey: string;
let tunnelHost: string;
let directHost: string;

const auth = () => ({ authorization: `Bearer ${apiKey}` });

async function seedHost(endpoint: string): Promise<string> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO hosts (region, hostname, state, protocol_version, cores, memory_mb,
                          endpoint, last_heartbeat_at)
       VALUES ($1, $2, 'UP', 1, 64, 262144, $3, now()) RETURNING id`,
      [REGION, `one-origin-${randomUUID().slice(0, 8)}`, endpoint],
    );
    return rows[0].id as string;
  });
}

async function seedDevice(hostId: string): Promise<string> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO devices (host_id, org_id, region, platform, tier, model, os_version, state, capabilities)
       VALUES ($1, NULL, $2, 'android', 'cuttlefish', 'cf_x86_64', '15', 'READY',
               '["screen-stream","input-datachannel","snapshot-reset"]'::jsonb)
       RETURNING id`,
      [hostId, REGION],
    );
    return rows[0].id as string;
  });
}

/** Remove every device in this region, so a test can decide which host must serve the next session. */
async function onlyHost(hostId: string): Promise<string> {
  await withSystem((c) => c.query(
    'DELETE FROM devices WHERE host_id = ANY($1)', [[tunnelHost, directHost]],
  ));
  return seedDevice(hostId);
}

before(async () => {
  app = await buildServer({ logger: false, rateLimitMax: 10_000 });
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code, name) VALUES ($1, 'One Origin')
                   ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgId = (await c.query(
      `INSERT INTO orgs (slug, name, max_concurrent) VALUES ($1, 'One Origin', 50) RETURNING id`,
      [`one-origin-${randomUUID().slice(0, 8)}`],
    )).rows[0].id;
  });
  apiKey = (await createApiKey(orgId)).plaintext;
  tunnelHost = await seedHost(DATA_PLANE_TUNNEL_ENDPOINT);
  directHost = await seedHost('wss://worker-direct.example:8443');
});

after(async () => {
  await app.close();
  await withSystem(async (c) => {
    await c.query('DELETE FROM sessions WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM devices WHERE host_id = ANY($1)', [[tunnelHost, directHost]]);
    await c.query('DELETE FROM api_keys WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM hosts WHERE region = $1', [REGION]);
    await c.query('DELETE FROM orgs WHERE id = $1', [orgId]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await closePools();
});

describe('the configuration these tests run under', () => {
  test('no external data-plane origin is configured — the case the deploy scripts produce', () => {
    // A guard on the file itself. If this ever becomes non-null, every assertion below is testing
    // the configured branch while claiming to test the default one.
    assert.equal(loadConfig().dataPlanePublicBase, null);
  });
});

describe('the console loads on the existing port', () => {
  test('the console and its assets are served by the same server as the API', async () => {
    for (const path of ['/', '/index.html', '/console.css', '/signin.css', '/console.js', '/live.js']) {
      const res = await app.inject({ method: 'GET', url: path });
      assert.equal(res.statusCode, 200, `${path} must be served on the console origin`);
      assert.ok(res.body.length > 0, `${path} must not be empty`);
    }
  });

  /**
   * `/app` USED TO BE IN THE LIST ABOVE, expecting a 200.
   *
   * The React console that lived there is retired: it was two screens against this console's ten,
   * and while both were served the sign-in screen landed on the preview instead of on the product.
   * It redirects here now — which still satisfies what this file is about, since a redirect to `/`
   * is the same origin. Asserting the redirect rather than deleting the path is what keeps this
   * covered: a 401 here is the failure mode that actually happened, when the retired paths were
   * dropped from `UI_PATHS` and the authenticate-by-default rule answered before the handler.
   */
  test('the retired /app paths redirect to the console rather than 401ing', async () => {
    for (const path of ['/app', '/app/', '/app/signin', '/app/devices']) {
      const res = await app.inject({ method: 'GET', url: path });
      assert.equal(res.statusCode, 308, `${path} should redirect, not ${res.statusCode}`);
      assert.equal(res.headers.location, '/', `${path} should point at the console`);
    }
  });

  test('the console CSP names no origin but its own — there is nothing to widen it for', async () => {
    const csp = String((await app.inject({ method: 'GET', url: '/' })).headers['content-security-policy']);
    const connect = /connect-src ([^;]+);/.exec(csp)?.[1].trim();
    assert.equal(connect, "'self'",
      'a same-origin live view is exactly the thing that keeps this directive to one word');
    assert.ok(!/wss?:\/\//.test(csp), 'no ws origin should appear anywhere in the policy');
  });
});

describe('the existing API still answers on that origin', () => {
  test('device and session routes work unchanged', async () => {
    await onlyHost(directHost);

    const list = await app.inject({ method: 'GET', url: `/v1/devices?region=${REGION}`, headers: auth() });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().devices.length, 1);

    const id = list.json().devices[0].id;
    const one = await app.inject({ method: 'GET', url: `/v1/devices/${id}`, headers: auth() });
    assert.equal(one.statusCode, 200);
    assert.equal(one.json().device.id, id);
  });

  test('a device is still allocated and released — lifecycle is untouched by the routing change', async () => {
    const deviceId = await onlyHost(directHost);

    const created = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(),
      payload: { region: REGION, platform: 'android' },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().session.deviceId, deviceId);

    const sessionId = created.json().session.id;
    const ended = await app.inject({
      method: 'DELETE', url: `/v1/sessions/${sessionId}`, headers: auth(),
    });
    assert.ok(ended.statusCode < 300, `release failed: ${ended.body}`);

    const after = await withSystem(async (c) =>
      (await c.query('SELECT state::text AS state FROM devices WHERE id = $1', [deviceId])).rows[0].state);
    assert.equal(after, 'CLEANING', 'a released device still goes to CLEANING');
  });
});

describe('the live view rides the console origin', () => {
  test('a session on a TUNNELLED host is allocated, and handed a same-origin path', async () => {
    // THE REGRESSION. This exact case used to release the device and answer 400.
    await onlyHost(tunnelHost);

    const res = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(),
      payload: { region: REGION, platform: 'android' },
    });
    assert.equal(res.statusCode, 201, `a tunnelled host must be able to take a session: ${res.body}`);

    const browser = res.json().dataPlane.browserEndpoint as string;
    assert.equal(browser, `/dp/${tunnelHost}`,
      'the browser is given a path on this console, not an address of its own');

    // Independent of the equality above: assert the SHAPE, so a future absolute url that happened
    // to contain the right path could not satisfy this.
    assert.ok(browser.startsWith('/'), 'a same-origin path, so the browser resolves it itself');
    assert.ok(!/:\/\//.test(browser), 'no scheme and no host — that is what "no second origin" means');
    assert.ok(!/:\d+/.test(browser), 'and no port');

    await app.inject({ method: 'DELETE', url: `/v1/sessions/${res.json().session.id}`, headers: auth() });
  });

  test('a session on a DIRECT host gets the same treatment when nothing else is configured', async () => {
    await onlyHost(directHost);
    const res = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(),
      payload: { region: REGION, platform: 'android' },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().dataPlane.browserEndpoint, `/dp/${directHost}`);

    // The worker's own endpoint is still reported, unchanged, for a program on the farm's network.
    // Two different answers to two different questions; conflating them is the original bug.
    assert.equal(res.json().dataPlane.endpoint, 'wss://worker-direct.example:8443');
    await app.inject({ method: 'DELETE', url: `/v1/sessions/${res.json().session.id}`, headers: auth() });
  });

  test('GET /sessions/:id agrees with the allocation', async () => {
    await onlyHost(tunnelHost);
    const created = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(),
      payload: { region: REGION, platform: 'android' },
    });
    const sessionId = created.json().session.id;

    const fetched = await app.inject({ method: 'GET', url: `/v1/sessions/${sessionId}`, headers: auth() });
    assert.equal(fetched.statusCode, 200);
    assert.equal(
      fetched.json().dataPlane.browserEndpoint,
      created.json().dataPlane.browserEndpoint,
      'a reconnecting console must be sent to the same place as the first response did',
    );
    await app.inject({ method: 'DELETE', url: `/v1/sessions/${sessionId}`, headers: auth() });
  });
});

describe('that path is served by this same process', () => {
  test('/dp/* answers 426 rather than 404 — the route exists on the console origin', async () => {
    // Not decoration: `deploy/verify-live.sh` probes `/dp/probe` and REQUIRES 426. A 404 here means
    // the browser path this file just asserted resolves to nothing.
    const res = await app.inject({ method: 'GET', url: '/dp/probe' });
    assert.equal(res.statusCode, 426);
  });

  test('and it takes no credential, so the tunnel relay is unchanged', async () => {
    // `/dp/*` is public by design (ADR-0005): the credential is the Ed25519 grant sent inside the
    // socket, which the AGENT verifies offline. If this ever answers 401 the live view is dead and
    // the failure is invisible in a browser.
    const res = await app.inject({ method: 'GET', url: `/dp/${tunnelHost}` });
    assert.notEqual(res.statusCode, 401, '/dp/* must not be behind the authenticate-by-default rule');
    assert.notEqual(res.statusCode, 404, '/dp/* must be routed');
  });

  test('no second listener is involved — one server answered console, API and /dp alike', async () => {
    // All three on the SAME injected instance. A design that needed another port could not make
    // this pass without one of them 404ing.
    const console_ = await app.inject({ method: 'GET', url: '/' });
    const api = await app.inject({ method: 'GET', url: '/v1/devices', headers: auth() });
    const dp = await app.inject({ method: 'GET', url: '/dp/probe' });
    assert.equal(console_.statusCode, 200);
    assert.equal(api.statusCode, 200);
    assert.equal(dp.statusCode, 426);
  });
});
