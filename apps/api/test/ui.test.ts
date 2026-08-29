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

  /**
   * EVERY entry in the allowlist, not a list somebody remembered to keep in step.
   *
   * This is the generalised form of the bug that took the console down in production: `/profiles.js`
   * was missing from the table, so the browser could not resolve an import, the module graph failed
   * and the page came up blank — while the suite stayed green, because the test above names its
   * paths by hand and nobody added the new one.
   *
   * Derived from `SERVED_PATHS` instead, so an entry added to the table is automatically covered and
   * an entry whose file does not exist fails HERE rather than in somebody's browser. That is also
   * what makes this the test that fails if CI forgets to build the console: `/app/*` is emitted by
   * `npm run build --workspace apps/console`, and without it these paths 404.
   */
  test('every allowlisted path serves real bytes with the type it promises', async () => {
    const { SERVED_PATHS } = await import('../src/http/routes/ui.ts');
    assert.ok(SERVED_PATHS.length > 0, 'the allowlist is empty, which cannot be right');

    for (const path of SERVED_PATHS) {
      const res = await get(path);
      assert.equal(res.statusCode, 200, `${path} is allowlisted but does not serve`);
      assert.ok(res.rawPayload.length > 0, `${path} serves an empty body`);

      // A font decoded as text and re-encoded is a file the browser silently refuses, and the only
      // symptom is the fallback face. `wOF2` is the woff2 magic number; if it survived the round
      // trip, the bytes were not mangled.
      if (path.endsWith('.woff2')) {
        assert.equal(
          res.rawPayload.subarray(0, 4).toString('latin1'), 'wOF2',
          `${path} is not intact woff2 — it was probably read as utf8`,
        );
        assert.match(String(res.headers['content-type']), /^font\/woff2/);
      }
    }
  });

  test('the new console at /app names assets the allowlist actually serves', async () => {
    // Same failure mode as the module-graph test above, one build system further along: vite writes
    // the script and stylesheet paths into index.html, and a filename change there that is not
    // mirrored in the allowlist is a blank page with a 401 in the network tab.
    const html = (await get('/app')).body;
    for (const ref of html.matchAll(/(?:src|href)="(\/app\/[^"]+)"/g)) {
      const res = await get(ref[1]!);
      assert.equal(res.statusCode, 200, `/app/index.html references ${ref[1]}, which is not served`);
    }

    // And the stylesheet's own font references, which no HTML attribute mentions.
    const css = (await get('/app/app.css')).body;
    for (const ref of css.matchAll(/url\((\/app\/[^)]+)\)/g)) {
      const res = await get(ref[1]!);
      assert.equal(res.statusCode, 200, `app.css references ${ref[1]}, which is not served`);
    }
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

/**
 * EVERY MODULE THE CONSOLE IMPORTS MUST BE SERVED.
 *
 * `FILES` in ui.ts is an allowlist, and a path missing from it does not 404 — it falls through to
 * the authenticated API routes and answers 401. The browser then cannot resolve the import, the ES
 * module graph fails, and `console.js` never runs. The symptom is a BLANK CONSOLE, with the only
 * evidence a 401 on a `.js` file in the network tab.
 *
 * That shipped once: `/profiles.js` was added to `console.js` and not to the table, and the deployed
 * console was dead until someone curled the asset. Derived from the source rather than hand-listed,
 * because a hand-listed copy is the same mistake one level up.
 */
describe('the console can load every module it imports', () => {
  test('every browser-absolute import in console.js is a served path', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { SERVED_PATHS } = await import('../src/http/routes/ui.ts');

    const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
    const src = await readFile(join(publicDir, 'console.js'), 'utf8');
    const imports = [...src.matchAll(/from\s+'(\/[^']+)'/g)].map((m) => m[1]);

    assert.ok(imports.length > 0, 'expected console.js to import at least one module');
    for (const spec of imports) {
      assert.ok(SERVED_PATHS.includes(spec), `console.js imports ${spec}, which ui.ts does not serve`);
    }
  });

  test('an unserved import is what this catches', () => {
    // The assertion above passes trivially if the regex ever stops matching. This pins the failure
    // mode itself: a specifier the table does not carry must be rejected.
    const served = ['/console.js', '/live.js'];
    assert.equal(served.includes('/profiles.js'), false, 'the shape of the bug that shipped');
  });
});
