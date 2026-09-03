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
 * How long a reset may stay outstanding before it counts as a failed attempt.
 *
 * NOT a heartbeat interval, and the difference is the design. Counting an attempt per offer would
 * make the budget a function of how often the host beats — six beats a minute burns a three-attempt
 * budget in thirty seconds, and a slow-but-succeeding reset would escalate while it was still
 * working. A powerwash measured 40–80s on real hardware, so the default leaves generous room above
 * the slowest observed success before calling one attempt lost.
 */
function resetTimeoutMs(): number {
  return Number(process.env.RESET_ATTEMPT_TIMEOUT_MS ?? 180_000);
}

/**
 * How many counted attempts a device gets before recovery stops and a human is needed.
 *
 * The point of a small number is that the alternative is not "more retries", it is "retries
 * forever": before migration 032 a device that could never reset was re-offered every ten seconds
 * for the life of the process, silently out of the pool.
 */
function maxResetAttempts(): number {
  return Number(process.env.MAX_RESET_ATTEMPTS ?? 3);
}

/**
 * How long an authorised recovery may run before the farm gives up on it (migration 035).
 *
 * NOT the reset budget above, and the difference is what it is measuring. That one bounds a device
 * the farm is trying to fix on its own, attempt by attempt. This one bounds ONE attempt with a
 * person behind it: an operator released the quarantine, the heartbeat re-offers the reset every
 * beat inside this window, and when it closes the honest report is "nobody confirmed this".
 *
 * Ten minutes clears the slowest observed preparation with room to spare — a powerwash is 40-80s on
 * real hardware, a cold boot 35s, and an Appium that has to come back after it adds tens of seconds
 * more — while still being short enough that an operator who released a device and walked away
 * finds a decided answer rather than a spinner.
 */
function recoveryTimeoutMs(): number {
  return Number(process.env.RECOVERY_TIMEOUT_MS ?? 600_000);
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
  hostsQuarantined: number; artifactsExpired: number; blobsDeleted: number; resetsEscalated: number;
  attemptsClosed: number; recoveriesExpired: number;
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
    /**
     * Resets that are not going to finish (migration 032).
     *
     * The heartbeat re-offers every CLEANING device on every beat, which is what makes a missed
     * reset self-healing — and was also an unbounded retry loop, because a reset that always throws
     * is offered again ten seconds later forever and the device is silently out of the pool. This
     * counts an attempt only when one has been OUTSTANDING TOO LONG, on the reaper's clock rather
     * than the host's beat, and stops offering once the budget is spent.
     *
     * Logged per transition rather than per tick: an escalation is news exactly once, and a running
     * total printed six times a minute is the shape that hid the lab box's quarantine in its own
     * log for an hour.
     */
    const esc = await c.query<{ n: number }>(
      'SELECT count_stalled_resets(make_interval(secs => $1), $2) AS n',
      [resetTimeoutMs() / 1000, maxResetAttempts()],
    );
    if (Number(esc.rows[0].n) > 0) {
      console.warn(`[reaper] ${esc.rows[0].n} device(s) escalated: no reset after `
        + `${maxResetAttempts()} attempts. They stay unallocatable until cleared.`);
    }

    /**
     * Recoveries nobody finished (migration 035).
     *
     * A device released from quarantine sits in PREPARING while its host resets it and reports a
     * health result. A host that is asked and then goes silent — powered off, unplugged,
     * partitioned — would leave that device in PREPARING for the life of the database, which is
     * exactly the "state a device could never leave" ADR-0019 refused to build. This is the
     * terminal state §11 asks for, reached without anybody reporting anything.
     *
     * Per tick rather than on the host sweep's slower clock: the window is minutes, the check is
     * one indexed read against a partial index, and a recovery that has expired should not wait on
     * a sweep that exists to bound a FLEET-WIDE write.
     */
    const rec = await c.query<{ n: number }>(
      'SELECT expire_stalled_recoveries(make_interval(secs => $1)) AS n',
      [recoveryTimeoutMs() / 1000],
    );
    if (Number(rec.rows[0].n) > 0) {
      console.warn(`[reaper] ${rec.rows[0].n} recovery attempt(s) expired after `
        + `${Math.round(recoveryTimeoutMs() / 1000)}s with no host confirmation — back to quarantine.`);
    }

    /**
     * Attempts whose session has ended (migration 033).
     *
     * A SWEEP, not a call on each end path, and the difference is maintenance rather than taste. A
     * session ends in at least four places — the tenant's DELETE, the TTL, the idle-WebDriver
     * reclaim from 029, and a host quarantine taking the device back — and a close bolted onto each
     * is four things to keep in step plus the fifth somebody adds later without one. The symptom
     * would be an attempt that stays open forever, which reads as "the farm is still trying" when
     * it stopped hours ago.
     *
     * Not logged per tick. This is the ordinary end of ordinary sessions, and a line every ten
     * seconds saying so is the shape that hid a real quarantine in its own log for an hour.
     */
    const ca = await c.query<{ n: number }>('SELECT close_ended_session_attempts() AS n');

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
      resetsEscalated: Number(esc.rows[0].n),
      attemptsClosed: Number(ca.rows[0].n),
      recoveriesExpired: Number(rec.rows[0].n),
    };
  });
}

/**
 * The deliberate act that ends an escalation (migration 032).
 *
 * A FLEET operation, so it runs on the system pool: `clear_reset_escalation` is definer-owned and
 * revoked from `mfarm_app`, exactly like `device_reset_complete` above.
 *
 * NOT CALLABLE BY THE WORKER, and that is the point rather than an oversight. The heartbeat is what
 * exhausted the budget; letting the same path clear it would rebuild the unbounded loop 032 exists
 * to end, one indirection further away where nobody would find it. The caller is a human, through
 * the route in `routes/devices.ts`.
 *
 * `false` means there was nothing to clear — an operator who clicks twice is told, rather than
 * reassured that something happened.
 */
export async function clearResetEscalation(deviceId: string): Promise<boolean> {
  return withSystem(async (c) => {
    const { rows } = await c.query('SELECT clear_reset_escalation($1) AS ok', [deviceId]);
    return rows[0].ok === true;
  });
}

export interface ResetAttempt {
  attempt: number;
  outcome: 'timed-out' | 'succeeded' | 'escalated';
  detail: string | null;
  fence: number | null;
  occurredAt: Date;
}

/**
 * What this device's recovery actually did, most recent first.
 *
 * On the system pool because `device_reset_attempts` carries no `org_id` and no RLS policy — it is
 * about HARDWARE, and a shared-pool device belongs to no tenant (migration 032's table comment).
 * The route above it is what decides who may look.
 */
export async function resetAttempts(deviceId: string, limit = 50): Promise<ResetAttempt[]> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `SELECT attempt, outcome, detail, fence, occurred_at
         FROM device_reset_attempts
        WHERE device_id = $1
        ORDER BY occurred_at DESC, attempt DESC
        LIMIT $2`,
      [deviceId, limit],
    );
    return rows.map((r) => ({
      attempt: Number(r.attempt),
      outcome: r.outcome as ResetAttempt['outcome'],
      detail: r.detail as string | null,
      // bigint arrives as a string, like every other fence in this file.
      fence: r.fence === null ? null : Number(r.fence),
      occurredAt: r.occurred_at as Date,
    }));
  });
}

/* ------------------------------------------------------------------ quarantine, and the way back */

/**
 * Take one device out of service (migration 035).
 *
 * A FLEET operation on the system pool, like everything else in this section: `quarantine_device` is
 * definer-owned and revoked from `mfarm_app`.
 *
 * `false` means nothing moved — the device is already quarantined, or it has been evicted. Said
 * plainly rather than folded into a throw, because both are ordinary answers to a second click.
 */
export async function quarantineDevice(
  deviceId: string,
  reason: string,
  source: 'host' | 'operator' | 'health' = 'operator',
  actorId: string | null = null,
  detail: Record<string, unknown> | null = null,
): Promise<boolean> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      'SELECT quarantine_device($1, $2, $3, $4, $5) AS ok',
      [deviceId, reason, source, actorId, detail ? JSON.stringify(detail) : null],
    );
    return rows[0].ok === true;
  });
}

/**
 * Authorise a quarantined device to ATTEMPT recovery (migration 035, ADR-0024).
 *
 * This does not make a device available and it must never be described as if it does. It moves the
 * device to `PREPARING`, where the heartbeat starts offering it a reset again; only a completed
 * reset plus a passing health check, reported by the host that owns it, reaches `READY`.
 *
 * NOT CALLABLE BY THE WORKER, for `clearResetEscalation`'s reason and one more: the whole value of
 * the gate is that a person looked. A worker that could release its own devices would turn the
 * quarantine into a pause.
 */
export async function releaseDeviceQuarantine(
  deviceId: string, actorId: string | null,
): Promise<boolean> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      'SELECT release_device_quarantine($1, $2) AS ok', [deviceId, actorId],
    );
    return rows[0].ok === true;
  });
}

/**
 * The outcome of a recovery, as reported by the host that was asked to perform it.
 *
 * Host-scoped and fenced inside the function (migration 008's rule), so a worker naming another
 * host's device changes nothing. Returns the state the device ended in, or `null` when nothing
 * matched — a stale fence, another host's device, or a device that is no longer recovering.
 *
 * `ok` IS THE HEALTH RESULT, not "the reset returned". A restore that completes on a handset whose
 * USB has gone is a successful reset of a device nobody can drive.
 */
export async function finishRecovery(
  hostId: string, deviceId: string, fence: number, ok: boolean,
  reason: string | null = null, detail: Record<string, unknown> | null = null,
): Promise<'READY' | 'QUARANTINED' | null> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      'SELECT finish_device_recovery($1, $2, $3, $4, $5, $6) AS state',
      [hostId, deviceId, fence, ok, reason, detail ? JSON.stringify(detail) : null],
    );
    return (rows[0].state ?? null) as 'READY' | 'QUARANTINED' | null;
  });
}

export interface QuarantineEvent {
  event: 'quarantined' | 'released' | 'recovered' | 'recovery-failed';
  source: string | null;
  reason: string | null;
  actorId: string | null;
  actorEmail: string | null;
  fromReason: string | null;
  detail: Record<string, unknown> | null;
  fence: number | null;
  occurredAt: Date;
}

/**
 * Every quarantine, release and recovery outcome for this device, most recent first.
 *
 * On the system pool because `device_quarantine_log` carries no `org_id` and no RLS policy — it is
 * about HARDWARE (migration 035's table comment, and 032's before it). The route above it is what
 * decides who may look, by reading the device through `withTenant` first.
 */
export async function quarantineLog(deviceId: string, limit = 50): Promise<QuarantineEvent[]> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `SELECT event, source, reason, actor_id, actor_email, from_reason, detail, fence, occurred_at
         FROM device_quarantine_log
        WHERE device_id = $1
        -- By append order, not by timestamp: rows written in one transaction share occurred_at
        -- to the microsecond, and a uuid tiebreaker would render the timeline differently on
        -- different reads (migration 035).
        ORDER BY seq DESC
        LIMIT $2`,
      [deviceId, limit],
    );
    return rows.map((r) => ({
      event: r.event as QuarantineEvent['event'],
      source: r.source as string | null,
      reason: r.reason as string | null,
      actorId: r.actor_id as string | null,
      actorEmail: r.actor_email as string | null,
      fromReason: r.from_reason as string | null,
      detail: r.detail as Record<string, unknown> | null,
      // bigint arrives as a string, like every other fence in this file.
      fence: r.fence === null ? null : Number(r.fence),
      occurredAt: r.occurred_at as Date,
    }));
  });
}
