import type { FastifyInstance, FastifyRequest } from 'fastify';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { requireUser } from '../server.ts';
import { withSystem, withTenant } from '../../db.ts';
import { createApiKey, revokeApiKey } from '../../auth.ts';
import { hashPassword } from '../../users.ts';

/**
 * The ORGANISATION surface: who is on this farm, and what credentials they hold.
 *
 * `index.html` carried a comment where this nav group belongs — Team and Settings were in the
 * design with no endpoint behind them, and the file says plainly that a nav item opening an invented
 * page is the same lie as a button for a capability the device lacks. This is that backend.
 *
 * WHY IT IS THE BLOCKER IT IS. `createApiKey` and `revokeApiKey` have existed in `auth.ts` since the
 * beginning with no route and no caller, so the only way to get a CI credential was for someone to
 * SSH to the box and run a script. That makes "a teammate uses this farm" impossible in the literal
 * sense, whatever else works.
 *
 * ---
 *
 * TWO RULES GOVERN EVERY QUERY BELOW, and both are architecture rules this repo learned the hard way:
 *
 *   Reads go through `withTenant`, so RLS is the thing enforcing the org boundary rather than a
 *   WHERE clause someone might forget. Migration 018 exists so that `users` is safe to read this
 *   way at all.
 *
 *   Writes go through `withSystem` — the tenant pool has no write policy on `users` on purpose, so
 *   that a bug cannot rewrite a colleague's password hash — and therefore every mutation names its
 *   org explicitly. `withSystem` bypasses RLS entirely; the scope in the SQL IS the authorization.
 */

/**
 * Only an owner or an admin may change who has access.
 *
 * THE FIRST ROLE CHECK IN THIS CODEBASE. `memberships.role` has existed since 001 with a CHECK
 * constraint and has never been read for an authorization decision anywhere — every tenant-facing
 * endpoint treats any member of an org as equivalent, which is right for allocating a device and
 * wrong for handing out credentials. Reads below stay open to any member: seeing who your
 * colleagues are is not a privilege, and hiding it would only push people back to SSH.
 */
function requireOrgAdmin(req: FastifyRequest): { userId: string; orgId: string } {
  const { userId, orgId, role } = requireUser(req);
  if (role !== 'owner' && role !== 'admin') {
    throw forbidden('Only an owner or admin can change team members or API keys.');
  }
  return { userId, orgId };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Long enough that the scrypt cost is not the only thing standing between an address and an account.
 * Not a complexity rule: those produce `Passw0rd!` and a sticky note.
 */
const MIN_PASSWORD_LENGTH = 12;

interface MemberRow {
  user_id: string;
  email: string;
  role: string;
  created_at: Date;
}

interface KeyRow {
  prefix: string;
  created_at: Date;
  revoked_at: Date | null;
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------ team

  /** GET /v1/account/members — who is in this org. Any member may look. */
  app.get('/account/members', async (req) => {
    const { orgId } = requireUser(req);

    // The roster comes through the tenant pool, so RLS is what confines it to this org rather than
    // the WHERE clause below. Migration 018 is what makes reading `users` this way safe at all.
    const rows = await withTenant(orgId, async (c) => {
      const r = await c.query<MemberRow>(
        `SELECT u.id AS user_id, u.email, m.role, u.created_at
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.org_id = $1
          ORDER BY (m.role = 'owner') DESC, u.email`,
        [orgId],
      );
      return r.rows;
    });

    /**
     * Last sign-in, fetched SEPARATELY and on the system pool.
     *
     * `user_sessions` is deny-all to the tenant pool by design (018): it holds the CSRF value in
     * clear beside a session hash, and a policy wide enough to answer "when did they last sign in"
     * is also wide enough to hand a tenant query the rest of the row.
     *
     * The first version of this route asked for it as a subquery inside the tenant read above, and
     * RLS answered it with NULL rather than an error — so the Team screen told a signed-in owner
     * they had "never signed in". That is the failure mode 018's own comment warns about: the
     * denial is silent, and a silent denial renders as a confident falsehood.
     *
     * Scoped to the ids the tenant read already returned, so this cannot widen what the caller sees.
     */
    const ids = rows.map((m) => m.user_id);
    const lastSeen = new Map<string, Date>();
    if (ids.length) {
      await withSystem(async (c) => {
        const r = await c.query<{ user_id: string; seen: Date }>(
          `SELECT user_id, max(created_at) AS seen FROM user_sessions
            WHERE org_id = $1 AND user_id = ANY($2::uuid[]) GROUP BY user_id`,
          [orgId, ids],
        );
        for (const row of r.rows) lastSeen.set(row.user_id, row.seen);
      });
    }

    return {
      members: rows.map((m) => ({
        userId: m.user_id,
        email: m.email,
        role: m.role,
        createdAt: m.created_at.toISOString(),
        lastSeenAt: lastSeen.get(m.user_id)?.toISOString() ?? null,
      })),
    };
  });

  /**
   * POST /v1/account/members — add a person, or reset one's password.
   *
   * NOT an invite: there is no mail transport on this farm and inventing one to send a link would be
   * a second system to keep alive for a two-device box. The password is generated or supplied here
   * and shown to the admin ONCE, which is the same shape `farm-up.sh` already uses for the seeded
   * console account. Say so in the UI rather than implying an email is on its way.
   */
  app.post('/account/members', async (req, reply) => {
    const { orgId } = requireOrgAdmin(req);
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown; role?: unknown };

    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) throw badRequest('A valid email address is required.');

    const role = typeof body.role === 'string' ? body.role : 'member';
    if (role !== 'owner' && role !== 'admin' && role !== 'member') {
      throw badRequest("role must be one of 'owner', 'admin' or 'member'.");
    }

    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw badRequest(`password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    const digest = await hashPassword(password);

    // `withSystem`, so the org scope below is the whole of the authorization — see the file header.
    const result = await withSystem(async (c) => {
      // Bump `credential_epoch` on a password change so every browser session minted under the old
      // one stops authenticating at its next request. This is the same trick `upsertUser` uses, and
      // it is what makes "reset a password" a real revocation rather than a cosmetic one.
      const u = await c.query<{ id: string; created: boolean }>(
        `INSERT INTO users (email, password_hash)
         VALUES (lower($1), $2)
         ON CONFLICT (lower(email)) DO UPDATE
           SET password_hash = EXCLUDED.password_hash,
               credential_epoch = users.credential_epoch + 1
         RETURNING id, (xmax = 0) AS created`,
        [email, digest],
      );
      const userId = u.rows[0].id;
      const m = await c.query<{ role: string }>(
        `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role
         RETURNING role`,
        [orgId, userId, role],
      );
      return { userId, created: u.rows[0].created, role: m.rows[0].role };
    });

    return reply.code(result.created ? 201 : 200).send({
      member: { userId: result.userId, email, role: result.role },
      created: result.created,
    });
  });

  /**
   * DELETE /v1/account/members/:userId — revoke someone's access to THIS org.
   *
   * Removes the membership; it does not delete the person, because a user can belong to more than
   * one org and deleting the row would take their access to all of them. The epoch bump is what
   * makes the removal immediate — without it their existing browser session keeps working until it
   * expires, which for a seven-day cookie is not a revocation anyone should rely on.
   */
  app.delete<{ Params: { userId: string } }>('/account/members/:userId', async (req) => {
    const { userId: actorId, orgId } = requireOrgAdmin(req);
    const target = req.params.userId;

    // Refusing self-removal is not paternalism: an admin who removes their own last admin
    // membership locks the org out of its own team screen, and the only cure is SSH to the box —
    // which is the thing this endpoint exists to stop being necessary.
    if (target === actorId) {
      throw badRequest('You cannot remove your own access. Ask another owner or admin to do it.');
    }

    return withSystem(async (c) => {
      const existing = await c.query<{ role: string }>(
        'SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, target],
      );
      if (existing.rows.length === 0) throw notFound('Member');

      // An org with no owner cannot promote anyone, so this is a one-way door worth refusing at.
      if (existing.rows[0].role === 'owner') {
        const owners = await c.query<{ n: string }>(
          "SELECT count(*) AS n FROM memberships WHERE org_id = $1 AND role = 'owner'", [orgId],
        );
        if (Number(owners.rows[0].n) <= 1) {
          throw conflict('last_owner', 'This is the only owner. Promote someone else first.');
        }
      }

      await c.query('DELETE FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, target]);
      // Every session this person holds anywhere stops working. Broader than this org, and that is
      // the safe direction to be wrong in for a revocation.
      await c.query(
        'UPDATE users SET credential_epoch = credential_epoch + 1 WHERE id = $1', [target],
      );
      await c.query('DELETE FROM user_sessions WHERE user_id = $1 AND org_id = $2', [target, orgId]);
      return { removed: true };
    });
  });

  // -------------------------------------------------------------- api keys

  /**
   * GET /v1/account/api-keys — prefixes only.
   *
   * The secret is unrecoverable by construction: `api_keys` stores a sha256 and the plaintext is
   * returned exactly once, at creation. The prefix is what a person matches against the key in
   * their CI settings, and it is safe to log, which is why the column comment says so.
   */
  app.get('/account/api-keys', async (req) => {
    const { orgId } = requireUser(req);
    const rows = await withTenant(orgId, async (c) => {
      const r = await c.query<KeyRow>(
        `SELECT prefix, created_at, revoked_at FROM api_keys
          WHERE org_id = $1 ORDER BY revoked_at IS NOT NULL, created_at DESC`,
        [orgId],
      );
      return r.rows;
    });
    return {
      keys: rows.map((k) => ({
        prefix: k.prefix,
        createdAt: k.created_at.toISOString(),
        revokedAt: k.revoked_at ? k.revoked_at.toISOString() : null,
      })),
    };
  });

  /** POST /v1/account/api-keys — mint one. The plaintext in this response is the only copy. */
  app.post('/account/api-keys', async (req, reply) => {
    const { orgId } = requireOrgAdmin(req);
    const { plaintext, prefix } = await createApiKey(orgId);
    return reply.code(201).send({
      key: {
        prefix,
        // Named so a client cannot mistake it for something retrievable later.
        plaintextShownOnce: plaintext,
      },
    });
  });

  /** DELETE /v1/account/api-keys/:prefix — revoke. Idempotent from the caller's side. */
  app.delete<{ Params: { prefix: string } }>('/account/api-keys/:prefix', async (req) => {
    const { orgId } = requireOrgAdmin(req);
    const ok = await revokeApiKey(orgId, req.params.prefix);
    if (!ok) throw notFound('API key');
    return { revoked: true };
  });
}
