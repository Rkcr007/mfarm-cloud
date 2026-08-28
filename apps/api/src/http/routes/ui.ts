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
  '/console.css': { file: 'console.css', type: 'text/css; charset=utf-8' },
  '/console.js': { file: 'console.js', type: 'text/javascript; charset=utf-8' },
  // Imported as a module by console.js. Separate because it is the one part of the console that is
  // not a render function — it holds a socket and a peer connection open (ADR-0007) — and because
  // a page that never opens a cockpit never parses it.
  '/live.js': { file: 'live.js', type: 'text/javascript; charset=utf-8' },
  // Device chrome (ADR-0016), also imported as a module by console.js.
  //
  // ITS ABSENCE HERE TOOK THE WHOLE CONSOLE DOWN IN PRODUCTION. This table is an allowlist, and a
  // path missing from it falls through to the authenticated API routes and answers 401 — so the
  // browser could not resolve the import, the module graph failed, and console.js never executed.
  // Not a degraded console: a blank page. Caught by curl against the deployed host, and by nothing
  // else, which is why `ui.test.ts` now derives this list from console.js's own imports.
  '/profiles.js': { file: 'profiles.js', type: 'text/javascript; charset=utf-8' },
};

/** Exported so a test can assert this table covers every module `console.js` actually imports. */
export const SERVED_PATHS = Object.keys(FILES);

export async function uiRoutes(app: FastifyInstance): Promise<void> {
  const dp = dataPlaneOrigin();
  for (const [route, { file, type }] of Object.entries(FILES)) {
    app.get(route, async (_req, reply) => {
      const body = await readFile(join(PUBLIC_DIR, file), 'utf8');
      return reply
        .header('content-type', type)
        // The console is a credentialed surface; a shared cache holding it is a shared cache
        // holding somebody's fleet page.
        .header('cache-control', 'no-store')
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
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
          `connect-src 'self'${dp ? ` ${dp}` : ''}; media-src 'self' blob:; webrtc 'allow'; ` +
          "form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
        )
        .send(body);
    });
  }
}

/** The console's paths, so the server can exempt them from the authenticate-by-default rule. */
export const UI_PATHS = Object.keys(FILES);
