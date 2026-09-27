import { withTenant } from '../db.ts';
import { badRequest } from '../http/errors.ts';
import { secretNamesIn, unseal, vaultKey, type RunSecrets } from './vault.ts';

/**
 * THE ORG'S SECRETS, AS THE DOORS AND THE RUNNER NEED THEM (ADR-0045). Always through `withTenant`:
 * the table is under row-level security like every tenant table, and the runner is no exception.
 */

/**
 * REFUSED AT THE DOOR: a task that names a secret the org does not have. Typed later, `{{PIN}}` would
 * go into the app as braces — the agent reporting the app broken for a secret nobody saved.
 */
export async function refuseUnknownSecrets(orgId: string, prompt: string): Promise<void> {
  const named = secretNamesIn(prompt);
  if (!named.length) return;
  const saved = await withTenant(orgId, async (c) => new Set((await c.query<{ name: string }>(
    'SELECT name FROM ai_secrets WHERE org_id = $1 AND name = ANY($2)', [orgId, named])).rows.map((r) => r.name)));
  const missing = named.filter((n) => !saved.has(n));
  if (missing.length) {
    const list = missing.map((n) => `{{${n}}}`).join(', ');
    throw badRequest(`The task names ${list}, which ${missing.length === 1 ? 'is not a saved secret' : 'are not saved secrets'} `
      + 'of this organisation. Save it in AI testing › Secrets, or write the task without it.');
  }
}

/** The values a run's task names — opened here, for this run only, and never logged. */
export async function loadRunSecrets(orgId: string, prompt: string, signingKeyPem: string): Promise<RunSecrets> {
  const named = secretNamesIn(prompt);
  if (!named.length) return { values: {}, unreadable: [] };
  const rows = await withTenant(orgId, async (c) => (await c.query<{ name: string; sealed: Buffer }>(
    'SELECT name, sealed FROM ai_secrets WHERE org_id = $1 AND name = ANY($2)', [orgId, named])).rows);
  const key = vaultKey(signingKeyPem);
  const values: Record<string, string> = {};
  const unreadable: string[] = [];
  for (const r of rows) {
    const v = unseal(key, orgId, r.name, r.sealed);
    if (v === null) unreadable.push(r.name);
    else values[r.name] = v;
  }
  return { values, unreadable };
}
