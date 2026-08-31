import type { PoolClient } from 'pg';
import { withTenant, withSystem } from './db.ts';
import { appStore } from './appstore.ts';
import { loadConfig } from './config.ts';

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

/**
 * A data-plane client attached to a session — reported by the WORKER, host-scoped (migration 017).
 *
 * Distinct from `activate` above, which is the tenant-scoped form the WebDriver hub calls with an
 * org it already proved it owns. Here the caller is a worker, so the scope is its host and the org
 * is derived from the session inside the function rather than accepted from the request — the rule
 * migration 008 had to retrofit onto every other worker-facing mutation.
 *
 * `false` is the ordinary answer on a reconnect (the session is already ACTIVE), not an error.
 */
export async function sessionAttach(hostId: string, sessionId: string, fence: number): Promise<boolean> {
  return withSystem(async (c) => {
    const { rows } = await c.query('SELECT session_attach($1, $2, $3) AS ok', [hostId, sessionId, fence]);
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
/**
 * How long a host may go silent before its devices leave the pool.
 *
 * Nine missed beats at the default 10s interval. Generous on purpose: quarantining costs the farm
 * capacity and un-quarantining needs the worker to come back and re-register, so a flap should not
 * trigger it — but a worker that has said nothing for a minute and a half is not one whose devices
 * should still be handed to a tenant.
 */
function hostSilenceMs(): number {
  return Number(process.env.HOST_SILENCE_TIMEOUT_MS ?? 90_000);
}

/**
 * How often the host sweep actually runs, regardless of how often the reaper ticks.
 *
 * The reaper's other three jobs are per-tick by nature — a session expires the moment its clock
 * runs out. "Has a host been quiet for 90 seconds" cannot change meaningfully between two ticks a
 * few seconds apart, and it is the only FLEET-WIDE WRITE in the sweep, so running it on every tick
 * spends a query and a possible mass state change to answer a question whose answer is still being
 * computed. `REAPER_INTERVAL_MS` is deployment-chosen and may be small; this is not.
 */
function hostSweepMinIntervalMs(): number {
  return Number(process.env.HOST_SWEEP_MIN_INTERVAL_MS ?? 15_000);
}

/**
 * How long a WebDriver session may go without a command before the farm takes the device back.
 *
 * Must exceed the longest plausible SINGLE command, not the gap between them: `last_command_at`
 * marks when the last proxied command STARTED, so a slow install or a long `waitUntil` leaves it
 * stale while the session is perfectly alive. It should also sit above the client's own idle timer,
 * which is the layer meant to fire first — `examples/medishop-suite` sets
 * `appium:newCommandTimeout: 300`. Ten minutes clears both and is still a third of the lease TTL,
 * so this does the reclaiming in the ordinary case and the TTL goes back to being a backstop rather
 * than the only mechanism. See migration 029.
 */
function webdriverIdleMs(): number {
  return Number(process.env.WEBDRIVER_IDLE_TIMEOUT_MS ?? 600_000);
}

/**
 * Module-level: one reaper per process, and it is the only caller.
 *
 * Both knobs above are read INSIDE the sweep rather than at module scope, and that is not style.
 * ES imports are hoisted, so a test that sets `process.env.X` in its first statement has already
 * missed a module-scope read — which is exactly how the first version of this shipped green and
 * then failed the moment a suite tried to configure it.
 */
let lastHostSweepAt = 0;

export async function reap(): Promise<{
  expired: number; idleEnded: number; promoted: number; keysPurged: number; installsOrphaned: number;
  hostsQuarantined: number; artifactsExpired: number; blobsDeleted: number;
}> {
  return withSystem(async (c: PoolClient) => {
    const e = await c.query('SELECT expire_sessions() AS n');
    /**
     * Clients that stopped driving without releasing (migration 029).
     *
     * BEFORE `promote_queued`, deliberately. These devices go to CLEANING rather than READY, so
     * they are not allocatable this tick either way — but ending the sessions first is what lets
     * the org's concurrency cap fall, and the cap is the thing that gates promotion. A suite whose
     * runner was killed while holding the org at its limit would otherwise keep the queue blocked
     * for an extra tick for no reason.
     */
    const w = await c.query('SELECT expire_idle_webdriver_sessions(make_interval(secs => $1)) AS n',
      [webdriverIdleMs() / 1000]);
    if (Number(w.rows[0].n) > 0) {
      console.warn(`[reaper] ended ${w.rows[0].n} idle WebDriver session(s) — no command for over `
        + `${Math.round(webdriverIdleMs() / 1000)}s`);
    }
    const p = await c.query('SELECT promote_queued($1) AS n', [20]);
    // Nothing else ever deletes an idempotency key. Left alone the table grows by one row per
    // session created, forever, and it is on the hot path of every session creation.
    const g = await c.query(
      'DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => $1)',
      [IDEMPOTENCY_RETENTION_HOURS],
    );
    /**
     * App actions whose session ended before a worker ever collected them.
     *
     * Without this they sit PENDING forever: the heartbeat query will not offer an action for a
     * dead session, so nothing finishes it and nothing sweeps it, and a caller polling the action
     * waits on a job no worker will ever be told about. Ordered AFTER `expire_sessions()` on
     * purpose — that call is what turns an abandoned session into a finished one, so running the
     * sweep first would leave every install it just orphaned for the next tick.
     *
     * FAILED rather than a state of its own, because that is what happened from the caller's side:
     * the app was not installed, and the reason says why in words they can act on.
     */
    const i = await c.query(
      `UPDATE app_actions ai
          SET state = 'FAILED',
              error = 'The session ended before this action reached the device.',
              finished_at = now()
         FROM sessions s
        WHERE s.id = ai.session_id
          AND ai.state = 'PENDING'
          AND s.state NOT IN ('QUEUED','ALLOCATING','ACTIVE')`,
    );
    /**
     * Hosts that have gone silent, and the devices they were holding open.
     *
     * `quarantine_host` has existed since migration 003 and NOTHING HAS EVER CALLED IT. The effect
     * on a two-device farm is not subtle: kill a worker and its devices stay READY forever, so the
     * allocator keeps handing them out and every session on them fails at connect time — the farm
     * reports full capacity while serving none of it. Found by killing the fake worker and watching
     * the allocator pick one of its devices a minute later.
     *
     * Quarantining is the honest state: the device is not gone (the host may come back), it is not
     * schedulable, and it is visible as a problem rather than as capacity.
     *
     * Recovery used to be registration alone — a returning worker re-asserts its devices, which is
     * why `workers.ts` had to learn to promote a device OUT of QUARANTINED as well as into it. That
     * was not enough, and a host reboot proved it: a healthy agent whose capabilities have not
     * changed never re-registers, so it beat at a control plane that had written it off for an hour
     * with `available: 0`. Since migration 016 this quarantine is stamped `reaper`, and the next
     * heartbeat clears it — the beat is the disproof of the only thing this quarantine ever
     * asserted. An operator quarantine is stamped differently and stays.
     */
    const dueForSweep = Date.now() - lastHostSweepAt >= hostSweepMinIntervalMs();
    if (dueForSweep) lastHostSweepAt = Date.now();
    const q = dueForSweep
      ? await c.query<{ id: string; hostname: string }>(
          `SELECT id, hostname FROM hosts
            WHERE state = 'UP'
              AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - make_interval(secs => $1))`,
          [hostSilenceMs() / 1000],
        )
      : { rows: [] as Array<{ id: string; hostname: string }> };
    for (const host of q.rows) {
      await c.query('SELECT quarantine_host($1, $2, $3)', [
        host.id, `no heartbeat for ${Math.round(hostSilenceMs() / 1000)}s`, 'reaper',
      ]);
      console.warn(`[reaper] quarantined host ${host.hostname}: silent for over ${Math.round(hostSilenceMs() / 1000)}s`);
    }

    /**
     * Artifacts past their retention window.
     *
     * TWO STEPS, AND THE ORDER IS THE WHOLE POINT. `expire_artifacts` deletes the rows and returns
     * only the digests that no surviving row references — content addressing means two sessions can
     * share one file, and deleting the bytes because one of them expired would break the other's
     * download. The blobs are on the API's disk, which SQL cannot reach, so the unlink happens here.
     *
     * Rows first, files second, deliberately. Crash between them and the store holds a file nothing
     * references, which costs disk and breaks nothing; the other order leaves a row pointing at
     * bytes that are gone, which a person discovers as a 404 while chasing a failure.
     */
    const a = await c.query<{ sha256: string; blob_orphaned: boolean }>(
      'SELECT sha256, blob_orphaned FROM expire_artifacts($1)', [500],
    );
    let blobsDeleted = 0;
    const orphans = a.rows.filter((r) => r.blob_orphaned);
    if (orphans.length) {
      const store = appStore(loadConfig().artifactDir);
      // Deduped: a digest can be flagged by more than one deleted row in the same batch, and
      // unlinking the same path twice is a wasted syscall rather than an error.
      for (const sha of new Set(orphans.map((r) => r.sha256))) {
        await store.remove(sha);
        blobsDeleted++;
      }
    }

    return {
      expired: Number(e.rows[0].n),
      idleEnded: Number(w.rows[0].n),
      promoted: Number(p.rows[0].n),
      keysPurged: g.rowCount ?? 0,
      installsOrphaned: i.rowCount ?? 0,
      hostsQuarantined: q.rows.length,
      artifactsExpired: a.rows.length,
      blobsDeleted,
    };
  });
}
