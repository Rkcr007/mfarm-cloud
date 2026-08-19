/**
 * The console's own routes — the allowlist, and the Content-Security-Policy.
 *
 * The CSP is here for one reason: **a CSP mistake is invisible from the outside.** A blocked
 * WebSocket surfaces in the browser as a bare `error` event with no reason on it, so a console whose
 * live view will never connect looks exactly like a worker that is down. That was not hypothetical —
 * it is how the data-plane origin came to be named here at all (ADR-0007).
 *
 * The environment is set BEFORE the server is imported, because `loadConfig` caches on first call
 * and Node's test runner gives each file its own process.
 */
process.env.DATA_PLANE_PUBLIC_BASE = 'wss://console.example/dp';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { closePools } from '../src/db.ts';

let app: FastifyInstance;

before(async () => { app = await buildServer({ logger: false }); });
after(async () => { await app.close(); await closePools(); });

const get = (url: string) => app.inject({ method: 'GET', url });

describe('the console is served from an allowlist', () => {
  test('every asset the console needs resolves', async () => {
    for (const path of ['/', '/index.html', '/console.css', '/console.js', '/live.js']) {
      const res = await get(path);
      assert.equal(res.statusCode, 200, `${path} must be served`);
      assert.ok(res.body.length > 0, `${path} must not be empty`);
    }
  });

  test('the module graph is complete — console.js imports live.js, and live.js is served', async () => {
    // The console is loaded as an ES module with no bundler, so a file it imports that is not on the
    // allowlist is a 404 at parse time and a blank page. Nothing else would catch that.
    const console_js = (await get('/console.js')).body;
    assert.match(console_js, /from '\/live\.js'/, 'console.js imports live.js by absolute path');
  });

  test('nothing outside the allowlist resolves, however it is spelled', async () => {
    for (const path of ['/../src/config.ts', '/console.js/../../package.json', '/.env', '/turn.ts']) {
      const res = await get(path);
      assert.notEqual(res.statusCode, 200, `${path} must not be served`);
    }
  });
});

describe('content security policy', () => {
  const csp = async () => String((await get('/')).headers['content-security-policy']);

  test('scripts and styles come from this origin only', async () => {
    const p = await csp();
    assert.match(p, /default-src 'none'/);
    assert.match(p, /script-src 'self'/);
    assert.doesNotMatch(p, /unsafe-inline|unsafe-eval/, 'the console has no inline script and must not permit one');
  });

  test('connect-src names the data-plane origin, and only its origin', async () => {
    const p = await csp();
    const directive = p.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src'));
    assert.equal(
      directive,
      "connect-src 'self' wss://console.example",
      'the path is dropped — CSP source expressions match on origin, and leaving "/dp" on makes the ' +
      'whole directive fail to match the socket the console actually opens',
    );
  });

  test('the live view is not permitted to become a hole', async () => {
    const p = await csp();
    // The two ways a live view "just works" if someone reaches for them, and both are refusals here.
    assert.doesNotMatch(p, /connect-src[^;]*\*/, 'a wildcard connect-src would permit exfiltration to anywhere');
    assert.match(p, /frame-ancestors 'none'/, 'the cockpit drives a real device; it must not be framed');
    assert.match(p, /form-action 'none'/);
  });

  test('the console is never cached by a shared cache', async () => {
    // It renders one org's fleet. A proxy holding it is a proxy holding somebody's devices.
    const res = await get('/');
    assert.match(String(res.headers['cache-control']), /no-store/);
  });
});
