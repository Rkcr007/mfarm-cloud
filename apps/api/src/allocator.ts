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
  /** Capabilities the device must declare. The WebDriver hub uses this to demand `webdriver`. */
  requireCapabilities?: string[];
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
         FROM allocate_device($1, $2, $3, $4, $5, make_interval(mins => $6), $7, $8)`,
      [
        req.orgId,
        req.userId,
        req.region,
        req.platform,
        req.tier ?? null,
        req.ttlMinutes ?? 30,
        JSON.stringify(req.requested ?? {}),
        JSON.stringify(req.requireCapabilities ?? []),
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

/**
 * Worker reports snapshot restore finished.
 *
 * A fleet operation, so there is no tenant scope — but there IS a host scope, and it is the caller's
 * authenticated host id, never a value from the request body. Without it any worker could mark any
 * other host's device READY mid-restore (migration 008).
 */
export async function resetComplete(hostId: string, deviceId: string, fence: number): Promise<boolean> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      'SELECT device_reset_complete($1, $2, $3) AS ok',
      [hostId, deviceId, fence],
    );
    return rows[0].ok === true;
  });
}

/**
 * How long a stored idempotent response stays replayable. Well past any client's retry window, and
 * short enough that the table does not grow for the lifetime of the deployment.
 */
const IDEMPOTENCY_RETENTION_HOURS = 24;

/** Run on a schedule. Implements "never leave a device permanently locked" as a mechanism. */
export async function reap(): Promise<{
  expired: number; promoted: number; keysPurged: number; installsOrphaned: number;
}> {
  return withSystem(async (c: PoolClient) => {
    const e = await c.query('SELECT expire_sessions() AS n');
    const p = await c.query('SELECT promote_queued($1) AS n', [20]);
    // Nothing else ever deletes an idempotency key. Left alone the table grows by one row per
    // session created, forever, and it is on the hot path of every session creation.
    const g = await c.query(
      'DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => $1)',
      [IDEMPOTENCY_RETENTION_HOURS],
    );
    /**
     * Installs whose session ended before a worker ever collected them.
     *
     * Without this they sit PENDING forever: the heartbeat query will not offer an install for a
     * dead session, so nothing finishes it and nothing sweeps it, and a caller polling the install
     * waits on a job no worker will ever be told about. Ordered AFTER `expire_sessions()` on
     * purpose — that call is what turns an abandoned session into a finished one, so running the
     * sweep first would leave every install it just orphaned for the next tick.
     *
     * FAILED rather than a state of its own, because that is what happened from the caller's side:
     * the app was not installed, and the reason says why in words they can act on.
     */
    const i = await c.query(
      `UPDATE app_installs ai
          SET state = 'FAILED',
              error = 'The session ended before this install reached the device.',
              finished_at = now()
         FROM sessions s
        WHERE s.id = ai.session_id
          AND ai.state = 'PENDING'
          AND s.state NOT IN ('QUEUED','ALLOCATING','ACTIVE')`,
    );
    return {
      expired: Number(e.rows[0].n),
      promoted: Number(p.rows[0].n),
      keysPurged: g.rowCount ?? 0,
      installsOrphaned: i.rowCount ?? 0,
    };
  });
}
