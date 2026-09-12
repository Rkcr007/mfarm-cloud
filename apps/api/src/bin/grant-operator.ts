/**
 * Grant or revoke the fleet operator capability (migration 053).
 *
 *   node --experimental-strip-types src/bin/grant-operator.ts <email> [--revoke] [--by <email>]
 *
 * A CLI AND NEVER AN ENDPOINT, for the reason `create-user.ts` gives about itself and one more
 * besides. An endpoint that can promote somebody to fleet operator is an endpoint that is one
 * authorization bug away from handing over every machine — start, stop, drain, restart — and every
 * scheme for protecting it (a setup token, an "only an existing operator may call it" rule) is
 * another credential or another check that has to be right forever. An operator with a shell on the
 * control plane is already the trust root here. This uses that rather than inventing something
 * weaker beside it.
 *
 * THE GRANT IS FELT IMMEDIATELY, in both directions: `authenticateSession` re-reads `users.operator`
 * on every request, so a revoke takes effect on the revoked person's next click rather than whenever
 * their session happens to expire. No session is invalidated, because nothing about their identity
 * changed — only what that identity may do.
 *
 * It is deliberately NOT recorded in `infra_operations`. That table is the audit of what operators
 * did THROUGH the product, written by routes that have an authenticated request behind them; a row
 * written by a shell command with no request, no IP and a `--by` the caller typed themselves would
 * be an audit entry nobody could corroborate. The provenance that IS trustworthy — when, and by
 * which user id — is stored on the user row itself, and `--by` is resolved to a real account or
 * refused.
 */
import { withSystem, closePools } from '../db.ts';

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith('--'));
const revoke = args.includes('--revoke');
const byIdx = args.indexOf('--by');
const by = byIdx === -1 ? undefined : args[byIdx + 1];

if (!email) {
  console.error('usage: grant-operator.ts <email> [--revoke] [--by <granting-operator-email>]');
  process.exit(64);
}

try {
  const result = await withSystem(async (c) => {
    const { rows: target } = await c.query<{ id: string; email: string; operator: boolean }>(
      'SELECT id, email, operator FROM users WHERE lower(email) = lower($1)', [email],
    );
    if (target.length === 0) throw new Error(`no user with email "${email}" — create-user.ts first`);

    // Resolved, never trusted as a string. A provenance field that records whatever was typed is a
    // provenance field that records whatever somebody wanted it to say.
    let grantedBy: string | null = null;
    if (by) {
      const { rows } = await c.query<{ id: string; operator: boolean }>(
        'SELECT id, operator FROM users WHERE lower(email) = lower($1)', [by],
      );
      if (rows.length === 0) throw new Error(`--by names no user ("${by}")`);
      if (!rows[0].operator) throw new Error(`--by "${by}" is not an operator, so cannot be recorded as granting it`);
      grantedBy = rows[0].id;
    }

    const already = target[0].operator === !revoke;
    await c.query(
      `UPDATE users
          SET operator = $2,
              -- Cleared on revoke rather than left behind. Stale provenance on a capability somebody
              -- no longer holds reads, a year later, as though they still hold it.
              operator_granted_at = CASE WHEN $2 THEN now() ELSE NULL END,
              operator_granted_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END
        WHERE id = $1`,
      [target[0].id, !revoke, grantedBy],
    );
    return { email: target[0].email, already };
  });

  if (result.already) {
    console.log(`${result.email} was already ${revoke ? 'not ' : ''}a fleet operator. Nothing changed.`);
  } else {
    console.log(revoke
      ? `${result.email} is no longer a fleet operator. It stops working on their next request.`
      : `${result.email} is now a fleet operator and can open Infrastructure immediately.`);
  }
} catch (e) {
  console.error(`grant-operator failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePools();
}
