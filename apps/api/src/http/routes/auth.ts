import type { FastifyInstance } from 'fastify';
import { badRequest } from '../errors.ts';
import { requireUser } from '../server.ts';
import {
  clearedCookie, login, logout, sessionCookie, SESSION_COOKIE,
} from '../../users.ts';
import { withSystem } from '../../db.ts';

/**
 * Sign-in for people.
 *
 * Everything else in this API is a machine talking to a machine, and the difference shows up in
 * three places here: the credential is low-entropy so the failure path must not be a guessing oracle,
 * the caller is a browser so the credential comes back as a cookie rather than in a body, and the
 * response has to carry a CSRF token because the cookie alone is not sufficient authority for an
 * unsafe request.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/auth/login
   *
   * One failure message for every reason, and the same status. Unknown email, wrong password, no
   * password set, removed from the org: distinguishing them tells an attacker which half of the
   * guess was right. `login()` also spends the same scrypt cost on an unknown account so the timing
   * does not answer the question the message refuses to.
   */
  app.post('/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown; org?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const org = typeof body.org === 'string' ? body.org.trim() : undefined;
    if (!email || !password) throw badRequest('email and password are required.');

    const session = await login(email, password, org);
    if (!session) {
      return reply.code(401).send({
        error: { code: 'invalid_credentials', message: 'That email and password do not match an account.' },
      });
    }

    // `secure` follows the deployment rather than a guess about the request: behind a reverse proxy
    // the connection to this process is plain HTTP even when the browser is on TLS, so trusting
    // req.protocol here would drop the flag on exactly the deployments that need it.
    reply.header('set-cookie', sessionCookie(session.token, session.expiresAt, app.secureCookies));
    return {
      user: { id: session.userId, email },
      orgId: session.orgId,
      // Returned in the body, NOT in a cookie — the whole point of the double-submit is that this
      // value travels somewhere the browser will not attach automatically.
      csrfToken: session.csrf,
      expiresAt: session.expiresAt.toISOString(),
    };
  });

  /** Who am I, and what may I do. The UI's first call, and its check that a cookie is still good. */
  app.get('/auth/me', async (req) => {
    const { userId, orgId, role } = requireUser(req);
    // Handed back so the console can recover it after a page reload — the cookie survives, an
    // in-memory token does not. Safe to return: a cross-origin page cannot read this response.
    const csrf = req.principal?.kind === 'user' ? req.principal.csrf : undefined;
    const { rows } = await withSystem((c) =>
      c.query(
        `SELECT u.email, o.name AS org_name, o.slug AS org_slug, o.max_concurrent
           FROM users u JOIN orgs o ON o.id = $2 WHERE u.id = $1`,
        [userId, orgId],
      ),
    );
    const row = rows[0] ?? {};
    return {
      user: { id: userId, email: row.email },
      org: { id: orgId, name: row.org_name, slug: row.org_slug, maxConcurrent: row.max_concurrent },
      role,
      csrfToken: csrf,
    };
  });

  /**
   * Revoked server-side, not merely un-set in the browser. A logout that only clears a cookie
   * leaves a working credential anywhere the cookie was already copied to.
   */
  app.post('/auth/logout', async (req, reply) => {
    const { sessionId } = requireUser(req);
    await logout(sessionId);
    reply.header('set-cookie', clearedCookie(app.secureCookies));
    return { ok: true };
  });
}

export { SESSION_COOKIE };
