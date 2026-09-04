import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../config.ts';

/**
 * Serve the web console.
 *
 * An ALLOWLIST rather than a static-file plugin, and that is the whole security design: the only
 * paths that resolve are the literals below, so there is no path to traverse, no dotfile to leak,
 * and no need to reason about what `..%2f` decodes to in this particular framework. It also avoids a
 * dependency for what is genuinely a `readFile` and a content type.
 *
 * These routes are PUBLIC, deliberately. They are the login page and the shell that renders it; the
 * data behind them is not. Every byte served here is the same for an anonymous visitor as for the
 * owner of the fleet, and the console does not receive so much as a device count until it presents a
 * session cookie to `/v1/*`.
 */
/**
 * The one origin `connect-src` may name beyond `'self'`: the data plane the viewer connects to.
 *
 * WHEN THIS IS EMPTY — the recommended deployment — the console's own TLS ingress proxies
 * `/dp/<hostId>` to the worker, so the socket is same-origin and `'self'` already covers it. That is
 * ADR-0007's shape and it needs no widening at all.
 *
 * WHEN IT IS NOT — a worker reached directly on its own host and port, which is what a developer
 * running the API and a fake farm on one laptop has — the browser must be allowed to open a socket
 * to exactly that origin and nothing else. ADR-0005 said this concession would be to "exact
 * origins, never to `*`", and this is it: scheme, host and port from the configured url, with the
 * path and everything after it discarded.
 *
 * Silently failing is what makes this worth the code. A blocked WebSocket surfaces in the browser as
 * a bare `error` event with no reason on it, so the console can only report "the connection closed"
 * for what is actually a header on this response.
 */
function dataPlaneOrigin(): string | null {
  const base = loadConfig().dataPlanePublicBase;
  if (!base) return null;
  try {
    const u = new URL(base);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null; // parseConfig already refused to boot on an unparseable value
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', '..', '..', 'public');

const FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  /**
   * THE DESIGN TOKENS, and they are a separate file on purpose.
   *
   * Colour, type, space, shape, elevation and motion for BOTH consoles: this one links it from
   * `index.html`, and the React console at `/app` is meant to import it rather than maintain a
   * second vocabulary for the same product. A token defined inside a component stylesheet is a
   * token only that component can have, which is how two consoles end up with two palettes that
   * drift by a hex at a time.
   */
  '/design-tokens.css': { file: 'design-tokens.css', type: 'text/css; charset=utf-8' },
  '/console.css': { file: 'console.css', type: 'text/css; charset=utf-8' },
  '/console.js': { file: 'console.js', type: 'text/javascript; charset=utf-8' },
  // Imported as a module by console.js. Separate because it is the one part of the console that is
  // not a render function — it holds a socket and a peer connection open (ADR-0007) — and because
  // a page that never opens a cockpit never parses it.
  '/live.js': { file: 'live.js', type: 'text/javascript; charset=utf-8' },
  /**
   * The icon set, imported as a module by console.js.
   *
   * GENERATED AND COMMITTED — `scripts/build-icon-sprite.mjs` extracts the geometry from
   * `lucide-static` and `icons.test.ts` fails when the two drift. It has to be a checked-in file
   * for the same reason the fonts do: this table names literal paths, so a file that only exists
   * after a build step could not be served from a fresh checkout.
   */
  '/icons.js': { file: 'icons.js', type: 'text/javascript; charset=utf-8' },
  // Device chrome (ADR-0016), also imported as a module by console.js.
  //
  // ITS ABSENCE HERE TOOK THE WHOLE CONSOLE DOWN IN PRODUCTION. This table is an allowlist, and a
  // path missing from it falls through to the authenticated API routes and answers 401 — so the
  // browser could not resolve the import, the module graph failed, and console.js never executed.
  // Not a degraded console: a blank page. Caught by curl against the deployed host, and by nothing
  // else, which is why `ui.test.ts` now derives this list from console.js's own imports.
  '/profiles.js': { file: 'profiles.js', type: 'text/javascript; charset=utf-8' },

  /**
   * THE NEW CONSOLE, served at `/app` beside the old one at `/`.
   *
   * Both ship in the same image on purpose. The new console is not at parity yet, so the old one
   * stays the front door; a cutover is repointing `/` at `app/index.html`, and a rollback is
   * pointing it back. Nobody has to choose a release to find out.
   *
   * THE FILENAMES ARE FIXED, NOT HASHED, and that is what makes this table possible — see the note
   * in `apps/console/vite.config.ts`. A content hash changes every build, so an allowlist could
   * never name it, and the alternative is a static-file plugin that would undo the security
   * decision this table exists to make. It costs nothing: every response here is `no-store`, so a
   * cache-busting name has no cache to bust.
   */
  '/app': { file: 'app/index.html', type: 'text/html; charset=utf-8' },
  '/app/': { file: 'app/index.html', type: 'text/html; charset=utf-8' },
  '/app/app.js': { file: 'app/app.js', type: 'text/javascript; charset=utf-8' },
  '/app/app.css': { file: 'app/app.css', type: 'text/css; charset=utf-8' },

  /**
   * Three faces, latin only, and ONE COPY SERVED TO BOTH CONSOLES.
   *
   * They used to live under `/app/fonts/` because vite bundled them out of `node_modules` for the
   * React console alone, which meant the old console at `/` had no webfonts at all and the image
   * would have carried a second identical 112 KB of typeface the moment it got them. These are
   * checked in under `public/fonts` instead and referenced by absolute path from
   * `design-tokens.css`, so there is one set of bytes, one allowlist block, and no way for the two
   * consoles to end up on different cuts of the same face.
   *
   * The console declares them by hand rather than importing a package entry point precisely so this
   * list stays three lines instead of eleven. Adding a subset means adding it here too, and
   * `ui.test.ts` derives that requirement from the stylesheets themselves, so a font added without
   * an allowlist entry fails the suite rather than 404ing in production.
   */
  '/fonts/instrument-sans-latin-wght-normal.woff2':
    { file: 'fonts/instrument-sans-latin-wght-normal.woff2', type: 'font/woff2' },
  '/fonts/bricolage-grotesque-latin-wght-normal.woff2':
    { file: 'fonts/bricolage-grotesque-latin-wght-normal.woff2', type: 'font/woff2' },
  '/fonts/jetbrains-mono-latin-wght-normal.woff2':
    { file: 'fonts/jetbrains-mono-latin-wght-normal.woff2', type: 'font/woff2' },
};

/** Exported so a test can assert this table covers every module `console.js` actually imports. */
export const SERVED_PATHS = Object.keys(FILES);

export async function uiRoutes(app: FastifyInstance): Promise<void> {
  const dp = dataPlaneOrigin();
  for (const [route, { file, type }] of Object.entries(FILES)) {
    /**
     * FONTS ARE BINARY AND ARE NOT CREDENTIALED, and both halves of that change how they are served.
     *
     * Read as a Buffer, never as utf8 — decoding a woff2 as text and re-encoding it produces a file
     * the browser silently refuses, and the only symptom is the fallback face. And cached rather
     * than `no-store`: `no-store` is here because the console renders somebody's fleet, which is
     * true of the markup and false of a typeface. Sending 110 KB of identical font on every page
     * load to protect a secret it does not contain is a cost with nothing on the other side.
     */
    const isFont = type.startsWith('font/');

    app.get(route, async (_req, reply) => {
      const body = isFont
        ? await readFile(join(PUBLIC_DIR, file))
        : await readFile(join(PUBLIC_DIR, file), 'utf8');
      return reply
        .header('content-type', type)
        // The console is a credentialed surface; a shared cache holding it is a shared cache
        // holding somebody's fleet page. A font is not — see above.
        .header('cache-control', isFont ? 'public, max-age=604800, immutable' : 'no-store')
        // Defence in depth for a page that renders device names and app package ids from the API.
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'same-origin')
        .header(
          'content-security-policy',
          // No inline script and no external origin: the console loads exactly its own two assets
          // and talks to its own origin. If a device name ever contains markup, this is what stops
          // it becoming script.
          //
          // `connect-src` stays `'self'` ALONE in the recommended deployment. ADR-0005 assumed this
          // line would have to name an external worker origin; ADR-0007 routes the data-plane
          // WebSocket through the console's own ingress instead, so `wss://<this host>/dp/...` is
          // same-origin. Where that proxy does not exist — a worker reached directly — exactly one
          // extra origin is named, computed from configuration rather than from a request. See
          // `dataPlaneOrigin`.
          //
          // `webrtc 'allow'` states what is already true rather than granting anything: CSP3's
          // webrtc directive is opt-in, so peer connections are permitted by default and
          // `default-src 'none'` never governed them. Saying it out loud means the next person to
          // read this line does not have to work that out, and a future `webrtc 'block'` becomes a
          // one-word change rather than an archaeology exercise.
          // `font-src 'self'` is the ONE directive the new console adds, and it names no external
          // origin. The faces are self-hosted and served from this same allowlist; a self-hosted
          // product that phones a font CDN on every page load is not self-hosted, and it would put
          // a third party in the load path of a page somebody's fleet depends on.
          "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; " +
          "img-src 'self' data: blob:; " +
          `connect-src 'self'${dp ? ` ${dp}` : ''}; media-src 'self' blob:; webrtc 'allow'; ` +
          "form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
        )
        .send(body);
    });
  }
}

/** The console's paths, so the server can exempt them from the authenticate-by-default rule. */
export const UI_PATHS = Object.keys(FILES);
