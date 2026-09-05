import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, badRequest } from '../errors.ts';
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
/**
 * Login attempts per minute from one address.
 *
 * Much tighter than the general limit, because this is the one endpoint where the credential is
 * short enough to guess and the general limit is sized for machines. Ten a minute is far more than a
 * person mistyping a password and far less than useful for a guessing run.
 *
 * Per IP rather than per account on purpose. Keying on the submitted email would let anyone lock a
 * named colleague out of their own account by spending the budget for them, which turns a defence
 * into a denial of service against the one user it is supposed to protect.
 *
 * This depends on `TRUST_PROXY` being right. With a proxy in front and that flag off, `req.ip` is the
 * proxy for every caller, this budget becomes one global budget, and the lockout it causes is the
 * one the paragraph above is trying to avoid — for everybody at once.
 */
export const DEFAULT_LOGIN_RATE_LIMIT_MAX = 10;

export interface AuthRoutesOptions {
  /**
   * Overrides the default above. Exists for tests, which sign in far more often in a few seconds
   * than a person ever would and would otherwise spend the budget on themselves — the same reason
   * `readyRateLimitMax` exists. A deployment should leave it alone.
   */
  loginRateLimitMax?: number;
}

export async function authRoutes(
  app: FastifyInstance,
  routeOptions: AuthRoutesOptions = {},
): Promise<void> {
  const loginOpts = {
    config: {
      rateLimit: {
        max: routeOptions.loginRateLimitMax ?? DEFAULT_LOGIN_RATE_LIMIT_MAX,
        timeWindow: '1 minute',
        // Distinct prefix so the budget is this route's alone: sharing a key with the global bucket
        // would let ordinary console traffic spend the login allowance and vice versa.
        keyGenerator: (req: FastifyRequest) => `login:${req.ip}`,
        // Must be an Error. The plugin `throw`s this, so a plain object reaches the error handler as
        // an unrecognised throwable and comes back 500 — on the path that exists to return 429.
        errorResponseBuilder: (_req: FastifyRequest, ctx: { ttl: number; statusCode: number }) =>
          new ApiError(
            ctx.statusCode,
            'rate_limited',
            `Too many sign-in attempts. Retry after ${Math.ceil(ctx.ttl / 1000)}s.`,
          ),
      },
    },
  };

  /**
   * POST /v1/auth/login
   *
   * One failure message for every reason, and the same status. Unknown email, wrong password, no
   * password set, removed from the org: distinguishing them tells an attacker which half of the
   * guess was right. `login()` also spends the same scrypt cost on an unknown account so the timing
   * does not answer the question the message refuses to.
   */
  app.post('/auth/login', loginOpts, async (req, reply) => {
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

    /**
     * EVERY ORG THIS PERSON BELONGS TO, so the console can say which one they are in.
     *
     * A user with two memberships gets whichever one `login` ordered first, and until now nothing
     * told them: the org name lived in the avatar's `title` attribute and nowhere else. Their
     * sessions, keys and builds silently belong to a tenant they did not choose, and the symptom is
     * that their work "disappears". It cost an hour of exploring the wrong tenant during the
     * exploratory pass on 2026-09-05, and a real user would not have known to check.
     *
     * Sent always, not only when there are several. A caller that has to ask "is this list longer
     * than one" is a caller that will forget to.
     */
    const orgs = await withSystem((c) =>
      c.query<{ id: string; name: string; slug: string; role: string }>(
        `SELECT o.id, o.name, o.slug, m.role
           FROM memberships m JOIN orgs o ON o.id = m.org_id
          WHERE m.user_id = $1
          ORDER BY o.name`,
        [userId],
      ).then((r) => r.rows),
    );

    return {
      user: { id: userId, email: row.email },
      org: { id: orgId, name: row.org_name, slug: row.org_slug, maxConcurrent: row.max_concurrent },
      orgs,
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
