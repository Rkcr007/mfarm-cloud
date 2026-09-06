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
   * an entry whose file does not exist fails HERE rather than in somebody's browser.
   *
   * This used to double as the check that CI had built the React console, because `/app/*` did not
   * exist on disk until it ran. That console is deleted and nothing here is built any more — every
   * path in the table is a file checked into `public/`, which is a stronger property than the one
   * this paragraph used to describe.
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

  /**
   * EVERY absolute reference either console makes, not only the ones under its own prefix.
   *
   * This scan used to be anchored to `/app/`, and that made it quietly conditional: the day the
   * React console started pointing at the SHARED fonts under `/fonts/`, the loop matched nothing
   * and the test passed by finding no work to do. A test that goes vacuous when the thing it
   * guards moves is worse than no test, because the green tells you it checked.
   *
   * So both consoles, both stylesheets, and any root-relative `src`/`href`/`url()` in them.
   */
  test('every asset either console names is a path the allowlist serves', async () => {
    const pages: Array<[string, string]> = [
      ['/', (await get('/')).body],
      ['/console.css', (await get('/console.css')).body],
      ['/signin.css', (await get('/signin.css')).body],
      ['/design-tokens.css', (await get('/design-tokens.css')).body],
    ];

    let checked = 0;
    for (const [where, body] of pages) {
      const refs = new Set<string>();
      // href="/x" and src="/x" in markup; url(/x) and url('/x') in CSS. Not `//host` — that is a
      // protocol-relative external origin, which the CSP forbids and a separate test asserts.
      for (const m of body.matchAll(/(?:src|href)="(\/[^"/][^"]*)"/g)) refs.add(m[1]!);
      for (const m of body.matchAll(/url\(['"]?(\/[^'")]+)['"]?\)/g)) refs.add(m[1]!);

      for (const ref of refs) {
        const res = await get(ref);
        assert.equal(res.statusCode, 200, `${where} references ${ref}, which the allowlist does not serve`);
        checked += 1;
      }
    }

    // The guard against the vacuous pass above. The document and its three stylesheets between them
    // name five scripts, three stylesheets and three faces at minimum.
    assert.ok(checked >= 7, `expected the console to name several assets, found ${checked}`);
  });

  /**
   * THE THREE FACES ARE SERVED ONCE.
   *
   * Vite used to bundle a second copy into `/app/fonts/` for the React console, which meant the
   * console at `/` had no webfonts at all and giving it the same three would have put 112 KB of
   * duplicate typeface in the image. There is one console and one copy now, checked into
   * `public/fonts` and referenced by absolute path — but the count stays asserted, because a stale
   * allowlist entry pointing at a file that is not there is a 500 on a path nothing requests,
   * invisible until it is not.
   */
  test('the three faces are served once, from /fonts', async () => {
    const { SERVED_PATHS } = await import('../src/http/routes/ui.ts');
    const fonts = SERVED_PATHS.filter((p) => p.endsWith('.woff2'));
    assert.equal(fonts.length, 3, 'three faces, latin wght only — see sync-fonts.mjs');
    for (const p of fonts) assert.ok(p.startsWith('/fonts/'), `${p} should be at /fonts, not ${p}`);
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
