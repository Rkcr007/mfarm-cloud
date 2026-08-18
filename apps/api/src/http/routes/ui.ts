import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

/**
 * Serve the web console.
 *
 * An ALLOWLIST rather than a static-file plugin, and that is the whole security design: the only
 * paths that resolve are the four literals below, so there is no path to traverse, no dotfile to
 * leak, and no need to reason about what `..%2f` decodes to in this particular framework. It also
 * avoids a dependency for what is genuinely a `readFile` and a content type.
 *
 * These routes are PUBLIC, deliberately. They are the login page and the shell that renders it; the
 * data behind them is not. Every byte served here is the same for an anonymous visitor as for the
 * owner of the fleet, and the console does not receive so much as a device count until it presents a
 * session cookie to `/v1/*`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', '..', '..', 'public');

const FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/console.css': { file: 'console.css', type: 'text/css; charset=utf-8' },
  '/console.js': { file: 'console.js', type: 'text/javascript; charset=utf-8' },
};

export async function uiRoutes(app: FastifyInstance): Promise<void> {
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
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
          "connect-src 'self'; media-src 'self' blob:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
        )
        .send(body);
    });
  }
}

/** The console's paths, so the server can exempt them from the authenticate-by-default rule. */
export const UI_PATHS = Object.keys(FILES);
