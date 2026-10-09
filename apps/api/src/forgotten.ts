import { withSystem } from './db.ts';

/**
 * Forgetting a device that is gone — migration 069.
 *
 * ---------------------------------------------------------------- the one rule
 *
 * `inFleet` below is the predicate every read of "what devices does the fleet have" uses. It is
 * deliberately NOT `retired_at IS NULL`: a device is hidden only while it is ALSO in a state the
 * allocator never hands out. Anything that ever made a forgotten device allocatable would, by the
 * same change, make it visible. See the migration for why that matters more than tidiness.
 */

/** States a device may be forgotten in, and the only ones it stays hidden in. */
const HIDDEN_STATES = "('OFFLINE', 'QUARANTINED')";

/**
 * SQL, true for a device that is part of the fleet. `alias` is the `devices` table's alias in the
 * query it is spliced into — a constant in the source, never anything a caller sent.
 */
export const inFleet = (alias: string): string =>
  `(${alias}.retired_at IS NULL OR ${alias}.state NOT IN ${HIDDEN_STATES})`;

/** The opposite: a device somebody forgot, that is still gone. */
export const forgotten = (alias: string): string =>
  `(${alias}.retired_at IS NOT NULL AND ${alias}.state IN ${HIDDEN_STATES})`;

export type ForgetOutcome =
  | { forgotten: true }
  | { forgotten: false; why: 'already' | 'present' | 'in-use' | 'host-held' | 'busy' | 'missing' };

/**
 * Forget one device.
 *
 * ONLY A DEVICE THAT IS NOT THERE. `OFFLINE` is the control plane's word for a device its agent
 * cannot drive, and a quarantine a person or a health check applied is a device already withdrawn.
 * Everything else is refused, and each refusal has its own reason because each has a different
 * next step:
 *
 *   present   -- READY: its agent can see it. The next beat would only give it back; unplug it, or
 *                stop sharing it, first.
 *   in-use    -- somebody holds it. Forgetting is not a way to take a device from under them.
 *   host-held -- quarantined because its HOST is away. It returns when the host does, so "gone" is
 *                not yet known; retire the host if the machine is not coming back.
 *   busy      -- cleaning, booting or recovering: the farm is in the middle of something with it.
 *
 * One conditional UPDATE, so a heartbeat that gives the device back in the same instant either
 * lands first (and this refuses) or second (and un-forgets it). There is no window in between.
 */
export async function forgetDevice(
  deviceId: string, actorId: string | null, reason: string | null,
): Promise<ForgetOutcome> {
  return withSystem(async (c) => {
    const done = await c.query(
      `UPDATE devices
          SET retired_at = now(), retired_by = $2, retired_reason = $3, updated_at = now()
        WHERE id = $1 AND retired_at IS NULL
          AND (state = 'OFFLINE'
               OR (state = 'QUARANTINED' AND quarantine_source IN ('operator', 'health')))
      RETURNING id`,
      [deviceId, actorId, reason]);
    if ((done.rowCount ?? 0) > 0) return { forgotten: true };

    const { rows } = await c.query<{ state: string; retired: boolean }>(
      'SELECT state::text AS state, retired_at IS NOT NULL AS retired FROM devices WHERE id = $1',
      [deviceId]);
    const row = rows[0];
    if (!row) return { forgotten: false, why: 'missing' };
    if (row.retired) return { forgotten: false, why: 'already' };
    if (row.state === 'READY') return { forgotten: false, why: 'present' };
    if (row.state === 'RESERVED' || row.state === 'SESSION_ACTIVE') return { forgotten: false, why: 'in-use' };
    if (row.state === 'QUARANTINED') return { forgotten: false, why: 'host-held' };
    return { forgotten: false, why: 'busy' };
  });
}

/** Put a forgotten device back on the list. False when it was not forgotten. */
export async function restoreDevice(deviceId: string): Promise<boolean> {
  return withSystem(async (c) => {
    const { rowCount } = await c.query(
      `UPDATE devices
          SET retired_at = NULL, retired_by = NULL, retired_reason = NULL, updated_at = now()
        WHERE id = $1 AND retired_at IS NOT NULL`,
      [deviceId]);
    return (rowCount ?? 0) > 0;
  });
}
