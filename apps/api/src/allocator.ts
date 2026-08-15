import type { PoolClient } from 'pg';
import { withTenant, withSystem } from './db.ts';

export interface AllocationRequest {
  orgId: string;
  userId: string | null;
  region: string;
  platform: 'android' | 'ios';
  tier?: string | null;
  ttlMinutes?: number;
  requested?: Record<string, unknown>;
}

export interface Allocation {
  sessionId: string;
  deviceId: string | null;
  fence: number | null;
  state: 'QUEUED' | 'ALLOCATING' | 'ACTIVE' | 'ENDING' | 'ENDED' | 'FAILED';
}

/**
 * Allocate a device, or queue if none is available / the org is at its concurrency cap.
 *
 * All the interesting logic lives in the SQL function rather than here, on purpose: allocation must
 * be atomic with session creation, and the only place that atomicity is cheap and guaranteed is
 * inside one database transaction.
 */
export async function allocate(req: AllocationRequest): Promise<Allocation> {
  return withTenant(req.orgId, async (c) => {
    const { rows } = await c.query(
      `SELECT o_session_id AS session_id, o_device_id AS device_id,
              o_fence AS fence, o_state AS state
         FROM allocate_device($1, $2, $3, $4, $5, make_interval(mins => $6), $7)`,
      [
        req.orgId,
        req.userId,
        req.region,
        req.platform,
        req.tier ?? null,
        req.ttlMinutes ?? 30,
        JSON.stringify(req.requested ?? {}),
      ],
    );
    const r = rows[0];
    return {
      sessionId: r.session_id,
      deviceId: r.device_id,
      // pg returns bigint as string to avoid precision loss; fences stay well inside Number range
      fence: r.fence === null ? null : Number(r.fence),
      state: r.state,
    };
  });
}

export async function activate(orgId: string, sessionId: string, fence: number): Promise<boolean> {
  return withTenant(orgId, async (c) => {
    const { rows } = await c.query('SELECT session_activate($1, $2, $3) AS ok', [orgId, sessionId, fence]);
    return rows[0].ok === true;
  });
}

export async function release(orgId: string, sessionId: string, reason = 'client_disconnect'): Promise<boolean> {
  return withTenant(orgId, async (c) => {
    const { rows } = await c.query('SELECT release_device($1, $2, $3) AS ok', [orgId, sessionId, reason]);
    return rows[0].ok === true;
  });
}

/** Worker reports snapshot restore finished. Fleet operation — no tenant scope. */
export async function resetComplete(deviceId: string, fence: number): Promise<boolean> {
  return withSystem(async (c) => {
    const { rows } = await c.query('SELECT device_reset_complete($1, $2) AS ok', [deviceId, fence]);
    return rows[0].ok === true;
  });
}

/** Run on a schedule. Implements "never leave a device permanently locked" as a mechanism. */
export async function reap(): Promise<{ expired: number; promoted: number }> {
  return withSystem(async (c: PoolClient) => {
    const e = await c.query('SELECT expire_sessions() AS n');
    const p = await c.query('SELECT promote_queued($1) AS n', [20]);
    return { expired: Number(e.rows[0].n), promoted: Number(p.rows[0].n) };
  });
}
