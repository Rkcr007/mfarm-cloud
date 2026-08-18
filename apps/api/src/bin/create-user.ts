/**
 * Create (or re-password) a console user.
 *
 *   node --experimental-strip-types src/bin/create-user.ts <email> <password> [org-slug] [role]
 *
 * A CLI rather than an endpoint, deliberately. Bootstrapping the first user over HTTP means a route
 * that creates an administrator for anyone who can reach it, and every scheme for closing that
 * afterwards — a setup token, a "first run" flag — is a second credential to protect. An operator
 * with a shell is already the trust root here; this just uses that rather than inventing a weaker one.
 *
 * Re-running it for an existing email RESETS the password, which is the recovery path. Every session
 * that user had stops authenticating on its next request, because `upsertUser` bumps the credential
 * epoch — the same mechanism that makes "change password everywhere" work.
 */
import { upsertUser } from '../users.ts';
import { withSystem, closePools } from '../db.ts';

const [, , email, password, orgSlug, roleArg] = process.argv;

if (!email || !password) {
  console.error('usage: create-user.ts <email> <password> [org-slug] [owner|admin|member]');
  process.exit(64);
}

const role = (roleArg ?? 'admin') as 'owner' | 'admin' | 'member';
if (!['owner', 'admin', 'member'].includes(role)) {
  console.error(`role must be owner, admin or member (got "${role}")`);
  process.exit(64);
}

// A password short enough to guess makes every other control here decorative, and this is the one
// place a human chooses one. Refused rather than warned about.
if (password.length < 12) {
  console.error('password must be at least 12 characters');
  process.exit(64);
}

try {
  const org = await withSystem(async (c) => {
    if (orgSlug) {
      const { rows } = await c.query('SELECT id, slug, name FROM orgs WHERE slug = $1', [orgSlug]);
      if (rows.length === 0) throw new Error(`no org with slug "${orgSlug}"`);
      return rows[0];
    }
    // No slug given: only unambiguous when there is exactly one org. Picking "the first" would
    // silently put an administrator in somebody else's tenant.
    const { rows } = await c.query('SELECT id, slug, name FROM orgs ORDER BY created_at LIMIT 2');
    if (rows.length === 0) throw new Error('no orgs exist yet — seed one first');
    if (rows.length > 1) throw new Error('more than one org exists; name one explicitly');
    return rows[0];
  });

  const { created } = await upsertUser(email, password, org.id, role);
  console.log(
    `${created ? 'Created' : 'Updated'} ${email} as ${role} of ${org.name} (${org.slug}).` +
    (created ? '' : ' Existing sessions for this user are now invalid.'),
  );
} catch (e) {
  console.error(`create-user failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePools();
}
