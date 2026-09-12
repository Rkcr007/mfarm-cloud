import type { FastifyRequest } from 'fastify';
import { withSystem } from '../db.ts';
import { notFound } from '../http/errors.ts';
import { audited, type OperationResult } from './audit.ts';
import { infraChanged } from './stream.ts';

/**
 * The things an operator can actually do to this farm, from the console.
 *
 * ---------------------------------------------------------------- the shape, and why it is this one
 *
 * **NAMED OPERATIONS, NEVER A COMMAND.** There is no field in any of these that reaches a shell, a
 * path, or a hostname the caller chose. Each function below takes a host UUID the database resolves
 * and, at most, a reason string that is stored and never executed. That is not a precaution bolted
 * on; it is the whole reason a console can be trusted with this at all, and it is why there is no
 * generic "run this on the host" route and never will be.
 *
 * **EVERY ONE IS IDEMPOTENT, AND SAYS SO.** Draining a host that is already drained is `noop`, not
 * an error. That is the brief's requirement and it is also the only behaviour that survives a real
 * operator: somebody who is not sure whether their click landed will click again, and a farm that
 * answers the second click with a red error teaches them to distrust the first.
 *
 * **AN OUTCOME IS NEVER GUESSED.** Where a result cannot be established the operation settles as
 * `unknown` — see `audit.ts` on why reporting a failure for something that may have succeeded is
 * the more dangerous mistake.
 *
 * ---------------------------------------------------------------- what is NOT here
 *
 * Powering a machine on or off, and restarting a service on it. Both are real requirements and
 * neither is a control-plane change: power needs a cloud credential this VM does not hold, and a
 * service restart needs the agent to learn a new job kind. They arrive in their own stages, and
 * until then `capabilities` reports them false so the console does not draw a button for them.
 */

/** A host, resolved and described enough to log and to answer with. */
interface Host {
  id: string;
  hostname: string;
  state: string;
  quarantineSource: string | null;
  quarantineReason: string | null;
  activeSessions: number;
  idleDevices: number;
}

async function loadHost(hostId: string): Promise<Host> {
  const rows = await withSystem(async (c) => {
    const { rows } = await c.query(
      `SELECT h.id, h.hostname, h.state::text AS state,
              h.quarantine_source, h.quarantine_reason,
              (SELECT count(*) FROM sessions s JOIN devices d ON d.id = s.device_id
                WHERE d.host_id = h.id AND s.state IN ('ACTIVE','ALLOCATING')) AS active_sessions,
              -- Exactly what "quarantine_host" withdraws, counted with the same predicate so the
              -- number reported back cannot disagree with the number acted on.
              (SELECT count(*) FROM devices d WHERE d.host_id = h.id
                AND d.state IN ('READY','OFFLINE','BOOTING','CLEANING')) AS idle_devices
         FROM hosts h WHERE h.id = $1`,
      [hostId],
    );
    return rows;
  });
  if (rows.length === 0) throw notFound('That host');
  const r = rows[0];
  return {
    id: r.id,
    hostname: r.hostname,
    state: r.state,
    quarantineSource: r.quarantine_source,
    quarantineReason: r.quarantine_reason,
    activeSessions: Number(r.active_sessions ?? 0),
    idleDevices: Number(r.idle_devices ?? 0),
  };
}

export interface OperationOutcome {
  operationId: string;
  result: OperationResult;
  /** One sentence for the operator, in the same voice as `errors.ts`: what happened, and what next. */
  message: string;
  /** What actually moved. Absent when nothing did. */
  changed?: Record<string, number | string>;
}

/**
 * What one step of an operation reports back.
 *
 * ANNOTATED RATHER THAN INFERRED, because TypeScript unifies the branches of these functions into a
 * union of literal types — `'noop' | 'failed' | 'succeeded'` in three different shapes — and then
 * refuses it against `audited`'s single parameter type. Naming it here also makes the contract
 * visible: the OUTCOME goes to the log, the `value` goes to the operator.
 */
interface Step {
  result: OperationResult;
  /** The line that lands in `infra_operations.detail`. Terse; for reading a table. */
  detail?: string;
  value: {
    result: OperationResult;
    message: string;
    changed?: Record<string, number | string>;
  };
}

/**
 * How long a reason may be. Long enough for "draining for the kernel upgrade, back by 16:00", short
 * enough that the column is not a place to paste a stack trace.
 */
const MAX_REASON = 200;

function cleanReason(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  // Newlines out, because this is rendered inline in a log table and in a device's quarantine
  // reason, and a reason with a line break in it breaks both. Not an escaping concern — nothing in
  // this codebase renders server strings as markup — a layout one.
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);
  return text.length ? text : fallback;
}

/**
 * DRAIN — take a host out of service without evicting anybody.
 *
 * `quarantine_host(..., 'operator')` has existed since migration 016 and this is its first caller
 * outside the reaper. What it does is exactly maintenance mode and is worth restating, because it
 * is what makes this safe to offer in a console:
 *
 *   READY, OFFLINE, BOOTING and CLEANING devices are withdrawn from the pool;
 *   RESERVED and SESSION_ACTIVE devices are LEFT ALONE — a tenant mid-session is never evicted, and
 *     their session ends by its own path;
 *   each device remembers the state it was in, so resuming restores it rather than guessing;
 *   and the quarantine survives contact with the host: no heartbeat can lift a human's judgement.
 *
 * The machine stays POWERED ON and keeps costing money, which the console says in the confirmation
 * and on the host card afterwards. Draining is not stopping.
 */
export async function drainHost(
  req: FastifyRequest, hostId: string, reasonRaw: unknown,
): Promise<OperationOutcome> {
  const host = await loadHost(hostId);
  const reason = cleanReason(reasonRaw, 'drained by an operator from the console');

  return audited(req, {
    action: 'drain-host',
    targetKind: 'host',
    targetId: host.id,
    targetLabel: host.hostname,
    params: { reason },
  }, async (): Promise<Step> => {
    /**
     * ALREADY DRAINED IS `noop`, not an error and not a second quarantine.
     *
     * `quarantine_host` is written to be safe when repeated — its device UPDATE skips rows already
     * QUARANTINED so `quarantined_from` cannot be overwritten with QUARANTINED — but calling it
     * again would still rewrite the reason and the timestamp, which would quietly erase why the
     * host was taken out of service and when. The honest answer is that nothing needs to happen.
     */
    if (host.state === 'QUARANTINED' && host.quarantineSource === 'operator') {
      return {
        result: 'noop' as const,
        detail: 'Already drained.',
        value: {
          result: 'noop' as const,
          message: `${host.hostname} is already drained${host.quarantineReason ? ` — ${host.quarantineReason}` : ''}. Nothing changed.`,
        },
      };
    }

    /**
     * A HOST THE REAPER PUT AWAY IS ALREADY OUT OF THE POOL, and draining it would replace a
     * quarantine that HEALS ITSELF with one only a human can lift. That is a worse state than the
     * one they started in: the host comes back on its own when it beats again, and after a drain it
     * would sit out of service until somebody remembered.
     */
    if (host.state === 'QUARANTINED' && host.quarantineSource === 'reaper') {
      return {
        result: 'failed' as const,
        detail: 'Refused: the host is already quarantined for silence.',
        value: {
          result: 'failed' as const,
          message: `${host.hostname} has stopped answering, so its devices have already left the pool. `
            + 'Draining it would replace a quarantine that lifts itself on the next heartbeat with '
            + 'one that only a person can lift. Fix the host, or stop it.',
        },
      };
    }

    const withdrawn = await withSystem(async (c) => {
      const { rows } = await c.query<{ n: number }>(
        'SELECT quarantine_host($1, $2, $3) AS n', [host.id, reason, 'operator']);
      return Number(rows[0]?.n ?? 0);
    });
    infraChanged();

    return {
      result: 'succeeded' as const,
      detail: `${withdrawn} device(s) withdrawn; ${host.activeSessions} session(s) left running.`,
      value: {
        result: 'succeeded' as const,
        message: withdrawn === 0 && host.activeSessions === 0
          ? `${host.hostname} is drained. It had no idle devices to withdraw.`
          : `${host.hostname} is drained. ${withdrawn} device${withdrawn === 1 ? '' : 's'} withdrawn`
            + (host.activeSessions
              ? `; ${host.activeSessions} session${host.activeSessions === 1 ? '' : 's'} still running and untouched.`
              : '.')
            + ' It is still powered on and still costing money.',
        changed: { devicesWithdrawn: withdrawn, sessionsLeftRunning: host.activeSessions },
      },
    };
  });
}

/**
 * RESUME — put a drained host back into service.
 *
 * `release_host_quarantine` (migration 053) is symmetrical with its counterpart in its refusal: it
 * clears ONLY an operator quarantine. A host the reaper put away is silent, and a person declaring
 * it healthy does not make packets arrive — the next heartbeat does that, through the path that
 * already exists.
 */
export async function resumeHost(req: FastifyRequest, hostId: string): Promise<OperationOutcome> {
  const host = await loadHost(hostId);

  return audited(req, {
    action: 'resume-host',
    targetKind: 'host',
    targetId: host.id,
    targetLabel: host.hostname,
  }, async (): Promise<Step> => {
    if (host.state !== 'QUARANTINED') {
      return {
        result: 'noop' as const,
        detail: 'Already in service.',
        value: {
          result: 'noop' as const,
          message: `${host.hostname} is already in service. Nothing changed.`,
        },
      };
    }
    if (host.quarantineSource === 'reaper') {
      return {
        result: 'failed' as const,
        detail: 'Refused: quarantined for silence, not by an operator.',
        value: {
          result: 'failed' as const,
          message: `${host.hostname} is out of service because it stopped answering, not because `
            + 'anybody drained it. It comes back on its own on the next heartbeat; declaring it '
            + 'healthy from here would not make one arrive.',
        },
      };
    }

    const restored = await withSystem(async (c) => {
      const { rows } = await c.query<{ n: number }>(
        'SELECT release_host_quarantine($1) AS n', [host.id]);
      return Number(rows[0]?.n ?? -1);
    });
    infraChanged();

    /**
     * `-1` AND `0` ARE DIFFERENT ANSWERS and the function returns them separately for this reason.
     * Zero devices restored is a real outcome — a host drained while every device was already in a
     * tenant's hands — and it is not the same as "there was nothing to release", which can only
     * happen if something changed underneath this request.
     */
    if (restored < 0) {
      return {
        result: 'noop' as const,
        detail: 'Nothing to release; the quarantine had already gone.',
        value: {
          result: 'noop' as const,
          message: `${host.hostname} was no longer drained by the time this ran. Nothing changed.`,
        },
      };
    }

    return {
      result: 'succeeded' as const,
      detail: `${restored} device(s) restored.`,
      value: {
        result: 'succeeded' as const,
        message: restored === 0
          ? `${host.hostname} is back in service. It had no withdrawn devices to restore — the ones `
            + 'it holds were with tenants throughout.'
          : `${host.hostname} is back in service and ${restored} device${restored === 1 ? '' : 's'} `
            + 'returned to the state it was in before the drain.',
        changed: { devicesRestored: restored },
      },
    };
  });
}
