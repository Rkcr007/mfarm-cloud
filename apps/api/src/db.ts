import { Pool, type PoolClient } from 'pg';

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

const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://mfarm_app:mfarm_app@localhost:5433/mfarm';
const SYSTEM_URL =
  process.env.DATABASE_URL ?? 'postgres://mfarm:mfarm@localhost:5433/mfarm';

export const appPool = new Pool({
  connectionString: APP_URL,
  max: Number(process.env.PG_POOL_MAX ?? 20),
});

export const systemPool = new Pool({
  connectionString: SYSTEM_URL,
  max: Number(process.env.PG_SYSTEM_POOL_MAX ?? 5),
});

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
