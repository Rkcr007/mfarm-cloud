import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withTenant } from '../../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { requireTenant } from '../server.ts';
import { SECRET_NAME, seal, unseal, vaultKey } from '../../ai/vault.ts';

/**
 * THE ORG'S AI SECRETS — names in, values in, names out (ADR-0045).
 *
 * A task says `{{PIN}}`; the value is set here and nothing ever reads it back: not this API, not the
 * console, not the org that owns it. To change one, set it again. The runner is the only reader, and
 * only for the run that types it.
 */

/** Setting or removing one changes what every test of the org types — a person or a full key. */
function requireSecretKeeper(req: FastifyRequest): { orgId: string; userId: string | null } {
  const { orgId } = requireTenant(req);
  const p = req.principal!;
  if (p.kind === 'tenant' && p.scope !== 'full') {
    throw forbidden('An `automation`-scope key cannot change the organisation\'s AI secrets. Use a `full` key, '
      + 'or set them from the console.');
  }
  return { orgId, userId: p.kind === 'user' ? p.userId : null };
}

function nameParam(raw: string): string {
  if (!SECRET_NAME.test(raw)) {
    throw badRequest('A secret\'s name is capital letters, digits and _, starting with a letter, at most 40 — '
      + 'PIN, LOGIN_EMAIL. A task writes it as {{PIN}}.');
  }
  return raw;
}

interface SecretRow { name: string; sealed: Buffer; updated_at: Date; updated_by_email: string | null }

export async function aiSecretRoutes(app: FastifyInstance): Promise<void> {
  const key = () => vaultKey(app.signingKey.privateKeyPem);

  /** Names only — and whether each still opens, so a rotated signing key is said, not discovered mid-run. */
  app.get('/ai/secrets', async (req) => {
    const { orgId } = requireTenant(req);
    const rows = await withTenant(orgId, async (c) => (await c.query<SecretRow>(
      `SELECT s.name, s.sealed, s.updated_at, u.email AS updated_by_email
         FROM ai_secrets s LEFT JOIN users u ON u.id = s.updated_by
        WHERE s.org_id = $1 ORDER BY s.name`, [orgId])).rows);
    const k = key();
    return {
      aiSecrets: rows.map((r) => ({
        name: r.name, placeholder: `{{${r.name}}}`, updatedAt: r.updated_at.toISOString(), updatedBy: r.updated_by_email,
        readable: unseal(k, orgId, r.name, r.sealed) !== null,
      })),
    };
  });

  app.put<{ Params: { name: string }; Body: { value: string } }>('/ai/secrets/:name', {
    schema: {
      body: {
        type: 'object', required: ['value'], additionalProperties: false,
        properties: { value: { type: 'string', minLength: 1, maxLength: 500 } },
      },
    },
  }, async (req) => {
    const { orgId, userId } = requireSecretKeeper(req);
    const name = nameParam(req.params.name);
    const sealed = seal(key(), orgId, name, req.body.value);
    const row = await withTenant(orgId, async (c) => (await c.query<{ updated_at: Date }>(
      `INSERT INTO ai_secrets (org_id, name, sealed, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, name) DO UPDATE SET sealed = EXCLUDED.sealed, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING updated_at`, [orgId, name, sealed, userId])).rows[0]!);
    // The value is not echoed — not even to the caller who just sent it.
    return { aiSecret: { name, placeholder: `{{${name}}}`, updatedAt: row.updated_at.toISOString(), readable: true } };
  });

  app.delete<{ Params: { name: string } }>('/ai/secrets/:name', async (req, reply) => {
    const { orgId } = requireSecretKeeper(req);
    const name = nameParam(req.params.name);
    const gone = await withTenant(orgId, async (c) => (await c.query(
      'DELETE FROM ai_secrets WHERE org_id = $1 AND name = $2', [orgId, name])).rowCount);
    if (!gone) throw notFound('AI secret');
    return reply.code(204).send();
  });
}
