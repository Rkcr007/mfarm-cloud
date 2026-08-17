import { Pool, type PoolClient } from 'pg';
import { ConfigError, parseDbConfig } from './config.ts';

/**
 * Two roles, two pools. This split is load-bearing, not tidiness.
 *
 * A PostgreSQL SUPERUSER bypasses row-level security unconditionally — FORCE ROW LEVEL SECURITY
 * does not apply to them and no policy can stop them. So an app that connects with its migration
 * credentials has RLS switched off in practice while every policy still reads as enabled. That is
 * the single most common way a tenant-isolation bug ships undetected.
 *
 *   appPool     -> mfarm_app, no superuser, no BYPASSRLS. Every request handler uses this.
 *   systemPool  -> owner. Migrations and genuine fleet operations only, never a request handler.
 */

/**
 * One reader for the database environment, shared with `config.ts` (known issues 7 and 8).
 *
 * NOT `loadConfig()`, and the distinction matters. This module is imported by `main.ts` at the top
 * of the file, before `loadConfigOrExit()` runs — so parsing the *whole* configuration here would
 * move every ConfigError to module-evaluation time, where it surfaces as an ESM stack trace instead
 * of the list of sentences it was written to be. That is the exact reason `loadConfig` is a
 * function and not a module-scope const; see its comment.
 *
 * So the problems array is collected and DELIBERATELY DISCARDED here. It is not ignored in the
 * sense of unnoticed: `parseConfig` reads the same variables through the same function moments
 * later, and reports anything wrong with them through main's handler, which exits 78. What this
 * call buys is `intVar`'s fallback — the pool receives a validated integer or the default, and
 * never `NaN`. `Number('twenty')` used to reach `new Pool({ max: NaN })` and fail silently under
 * load rather than at startup.
 *
 * The connection strings themselves now have exactly one definition, in `config.ts`. They were
 * duplicated here as literals, so a change to one file left the other pointing somewhere else.
 */
const db = parseDbConfig(process.env, []);

export const appPool = new Pool({
  connectionString: db.appDatabaseUrl,
  max: db.poolMax,
  // Without this, `pool.connect()` queues forever once every connection is checked out, so anything
  // that can saturate a pool holds every later caller indefinitely instead of failing one of them.
  // Generous: a request that waits ten seconds for a connection has already missed its deadline.
  connectionTimeoutMillis: db.pgConnectTimeoutMs,
});

export const systemPool = new Pool({
  connectionString: db.databaseUrl,
  max: db.systemPoolMax,
  connectionTimeoutMillis: db.pgConnectTimeoutMs,
});

/** One row, four booleans: everything that decides whether RLS is real on this connection. */
const RLS_BOUNDARY_SQL = `
  SELECT current_user                                    AS role,
         current_setting('is_superuser') = 'on'          AS is_superuser,
         COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false)
                                                         AS bypasses_rls,
         COALESCE(pg_get_userbyid((SELECT relowner FROM pg_class
                                    WHERE oid = to_regclass('public.sessions'))) = current_user, false)
                                                         AS owns_tenant_tables`;

interface RlsBoundaryRow {
  role: string;
  is_superuser: boolean;
  bypasses_rls: boolean;
  owns_tenant_tables: boolean;
}

/**
 * Asks the server — not the environment — whether the app connection is actually bound by RLS.
 *
 * config.ts can only compare two strings it was handed. It cannot see that `db.internal` and
 * `db-primary.internal` are the same host, or that the pgbouncer address in front of the primary
 * resolves to it, or that someone rotated `APP_DATABASE_URL`'s credentials onto the owner role. Any
 * of those produces request handling that runs as the owner, which bypasses RLS (FORCE does not
 * apply to superusers, and the owner skips policies without it) — every policy reads as enabled
 * while enforcing nothing, and the first symptom is a customer seeing another customer's session.
 *
 * One query, at startup, on the pool that matters. `ci.yml` makes this same check, but only in CI,
 * where the URLs are hardcoded and correct — i.e. exactly where it cannot fail.
 */
export async function assertAppRoleIsRlsBound(pool: Pool = appPool): Promise<void> {
  const { rows } = await pool.query<RlsBoundaryRow>(RLS_BOUNDARY_SQL);
  const r = rows[0];
  if (!r) throw new ConfigError(['The RLS boundary check returned no rows; refusing to serve.']);

  const problems: string[] = [];
  if (r.is_superuser) {
    problems.push(
      `APP_DATABASE_URL connects as "${r.role}", which is a SUPERUSER. Superusers bypass row-level ` +
        'security unconditionally — FORCE does not apply to them — so every tenant policy is decorative.',
    );
  }
  if (r.bypasses_rls) {
    problems.push(`APP_DATABASE_URL connects as "${r.role}", which has BYPASSRLS. Every tenant policy is decorative.`);
  }
  if (r.owns_tenant_tables) {
    problems.push(
      `APP_DATABASE_URL connects as "${r.role}", which OWNS the tenant tables. Request handling must ` +
        'not run as the schema owner: DATABASE_URL and APP_DATABASE_URL have converged on one role, ' +
        'however differently the two connection strings are spelt.',
    );
  }
  if (problems.length > 0) throw new ConfigError(problems);
}

/**
 * Runs `fn` inside a transaction scoped to one tenant, on the RLS-bound pool.
 *
 * The tenant is set with set_config(..., is_local => true), which ties it to the transaction rather
 * than the connection. That distinction matters because connections are pooled and reused across
 * tenants: a session-scoped setting would leak org A's identity into org B's next query.
 *
 * A query issued outside this helper sees app.org_id unset, current_org() returns NULL, and every
 * policy matches zero rows. The failure mode is an obviously empty result, not a silent cross-tenant
 * read.
 */
export async function withTenant<T>(orgId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Privileged transaction with no tenant scope, on the owner pool. Fleet operations only —
 * host registration, device inventory, the reaper. Never reachable from a request handler.
 */
export async function withSystem<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await systemPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * App-role transaction with NO tenant set. Exists so tests can prove that forgetting to scope a
 * query yields nothing rather than everything.
 */
export async function withAppUnscoped<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePools(): Promise<void> {
  await Promise.all([appPool.end(), systemPool.end()]);
}
