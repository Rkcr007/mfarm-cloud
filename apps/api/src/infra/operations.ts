import type { FastifyRequest } from 'fastify';
import { withSystem } from '../db.ts';
import { notFound, forbidden } from '../http/errors.ts';
import { audited, type StepResult } from './audit.ts';
import { infraChanged } from './stream.ts';
import {
  CloudError, awaitState, instanceFor, instanceStatus, powerAction, thisInstanceName,
  type PowerState,
} from './cloud.ts';

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
 * Restarting a service on a host. That needs the agent to learn a new job kind, so it arrives in
 * its own stage; until then `capabilities.services` is false and the console draws no button.
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
  result: StepResult;
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
  result: StepResult;
  /** The line that lands in `infra_operations.detail`. Terse; for reading a table. */
  detail?: string;
  value: {
    /** What the console shows. `accepted` renders as "in progress", never as a success. */
    result: StepResult;
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

/* ------------------------------------------------------------------ power */

/**
 * How long to watch a machine after asking it to move, before answering the operator.
 *
 * A GCE stop settles in well under this; a start does NOT — the instance reaches RUNNING in tens of
 * seconds and the devices cold boot for minutes afterwards. So this is not "wait until it is
 * finished", it is "wait long enough that the usual case answers with the truth", and everything
 * slower comes back as `accepted` with the state it had reached. The console keeps showing it move,
 * because the page is a live view of the provider's own status.
 *
 * Overridable, and read inside the function rather than at module scope, for the reason every route
 * file here documents: `import` is hoisted, so an env var read during module evaluation cannot be
 * set by a test. A test asserting "a machine still booting stays `accepted`" otherwise has to wait
 * out the real twenty-five seconds to find out.
 */
function settleMs(): number {
  return Number(process.env.INFRA_POWER_SETTLE_MS ?? 25_000);
}

/** Resolve a host to the machine it is allowed to power, refusing everything not on the list. */
async function powerTarget(host: Host) {
  const target = instanceFor(host.hostname);
  if (!target) {
    throw forbidden(
      `${host.hostname} is not on this control plane's power allow-list, so it cannot be started or `
      + 'stopped from here. That list is configuration on the control plane (MFARM_POWER_INSTANCES) '
      + 'and deliberately not derived from the host name a worker registers with.');
  }
  /**
   * THE SECOND LOCK. The allow-list already makes this impossible, and it costs one cached metadata
   * read to make it impossible twice. A console that can switch off the machine serving it is a
   * console with one working button, and the failure would be unrecoverable from the console.
   */
  const self = await thisInstanceName();
  if (self && self === target.instance) {
    throw forbidden(
      'That is the machine this control plane is running on. Stopping it from here would end the '
      + 'session making the request, and nothing would be left to start it again.');
  }
  return target;
}

/** The five words the console and the log use for a machine's power. */
const POWER_WORD: Record<PowerState, string> = {
  running: 'running', stopped: 'stopped', starting: 'starting',
  stopping: 'stopping', error: 'in an error state', unknown: 'in a state the provider did not name',
};

type PowerVerb = 'start' | 'stop' | 'restart';

const ACTION_NAME: Record<PowerVerb, string> = {
  start: 'start-host', stop: 'stop-host', restart: 'restart-host',
};

/**
 * Start, stop or restart a machine.
 *
 * ---------------------------------------------------------------- the three answers §9 asks for
 *
 *   ALREADY RUNNING + start  -> `noop`, "Already running." Not an error: see the header.
 *   ALREADY STOPPED + stop   -> `noop`, "Already stopped."
 *   WE NEVER FOUND OUT       -> `unknown`, and the message says the operation may have happened.
 *
 * The third is the one that takes discipline. A timeout, a provider that stops answering, a network
 * fault between here and Google — none of them mean the instance did not stop, and every one of
 * them would be reported as a failure by a naive `catch`. `CloudError.answered` carries the
 * distinction from the fetch itself: the provider REFUSED (a real failure, with a reason) or the
 * provider NEVER SPOKE (unknown).
 *
 * A MACHINE ALREADY IN MOTION IS NOT ASKED AGAIN. Pressing Stop on an instance that is STOPPING is
 * `noop`, not a second stop — the second call is harmless at the provider and the honest answer to
 * "did anything change" is no.
 */
async function powerOperation(
  req: FastifyRequest, hostId: string, verb: PowerVerb, reasonRaw: unknown,
): Promise<OperationOutcome> {
  const host = await loadHost(hostId);
  const target = await powerTarget(host);
  const reason = cleanReason(reasonRaw, `${verb} requested by an operator from the console`);

  return audited(req, {
    action: ACTION_NAME[verb],
    targetKind: 'host',
    targetId: host.id,
    targetLabel: host.hostname,
    // The instance and zone, so the log says WHICH machine in WHICH project was acted on — a
    // hostname alone is ambiguous the moment a farm has a staging project.
    params: { reason, instance: target.instance, zone: target.zone },
  }, async (): Promise<Step> => {
    let before;
    try {
      before = await instanceStatus(target);
    } catch (e) {
      const err = e as CloudError;
      return {
        result: err.answered ? 'failed' : 'unknown',
        detail: err.message,
        value: {
          result: err.answered ? 'failed' : 'unknown',
          message: err.answered
            ? `${host.hostname}: ${err.message}`
            : `Could not reach the cloud provider to find out what ${host.hostname} is doing, so `
              + 'nothing was attempted. Its state is unchanged.',
        },
      };
    }

    /* ---------------------------------------------- already there, or already on the way */

    const settled = (message: string): Step => ({
      result: 'noop', detail: message,
      value: { result: 'noop', message },
    });
    if (verb === 'start' && before.state === 'running') {
      return settled(`${host.hostname} is already running. Nothing changed.`);
    }
    if (verb === 'stop' && before.state === 'stopped') {
      return settled(`${host.hostname} is already stopped. Nothing changed.`);
    }
    if ((verb === 'start' && before.state === 'starting')
        || (verb === 'stop' && before.state === 'stopping')) {
      return settled(`${host.hostname} is already ${POWER_WORD[before.state]}. Nothing changed.`);
    }
    /**
     * RESTARTING A STOPPED MACHINE IS A START, and saying so is better than either alternative.
     * `reset` on a TERMINATED instance is refused by the provider with a message about instance
     * state that means nothing to the person who pressed it, and silently starting it instead would
     * be the console doing something other than what the button said.
     */
    if (verb === 'restart' && before.state === 'stopped') {
      return {
        result: 'failed', detail: 'Refused: the machine is stopped, so there is nothing to restart.',
        value: {
          result: 'failed',
          message: `${host.hostname} is stopped, so there is nothing to restart. Start it instead.`,
        },
      };
    }

    /* ---------------------------------------------- do it */

    const providerVerb = verb === 'restart' ? 'reset' : verb;
    try {
      await powerAction(target, providerVerb);
    } catch (e) {
      const err = e as CloudError;
      return {
        result: err.answered ? 'failed' : 'unknown',
        detail: err.message,
        value: {
          result: err.answered ? 'failed' : 'unknown',
          message: err.answered
            ? `${host.hostname}: ${err.message}`
            : `The request to ${verb} ${host.hostname} was sent and never acknowledged, so it may `
              + 'have been carried out. Watch its state on this page rather than pressing again.',
        },
      };
    }
    infraChanged();

    /* ---------------------------------------------- watch it move */

    const want: PowerState[] = verb === 'stop' ? ['stopped'] : ['running'];
    let after;
    try {
      after = await awaitState(target, want, settleMs());
    } catch {
      after = { state: 'unknown' as PowerState, raw: '' };
    }
    infraChanged();

    if (want.includes(after.state)) {
      /**
       * A CONFIRMED STOP IS THE ONE MOMENT THE CONTROL PLANE KNOWS A MACHINE IS OFF, and until this
       * line it threw that away.
       *
       * Nothing else writes `hosts.state = 'DOWN'`. The reaper writes QUARANTINED for silence, which
       * is right for a host that went quiet on its own — we cannot tell an unplugged machine from a
       * partitioned one. But we JUST STOPPED THIS ONE and watched the provider agree, so `unknown`
       * would be a worse answer than the one we have.
       *
       * IT COSTS A ROUND TRIP AND BUYS TWO THINGS. The card reads `stopped` instead of `unknown`,
       * which is what makes a Start button appear rather than a disabled one — found by stopping the
       * real lab from the console and then being unable to start it again. And it closes the power
       * ledger through 054's trigger, at `last_heartbeat_at` rather than at the reaper's sweep up to
       * ninety seconds later.
       *
       * ONLY ON A CONFIRMED STOP. An `accepted` stop is still moving and the reaper's inference is
       * the honest fallback for it.
       */
      if (verb === 'stop') {
        await withSystem((c) =>
          c.query(`UPDATE hosts SET state = 'DOWN' WHERE id = $1 AND state <> 'DOWN'`, [host.id]))
          .catch((e: Error) => {
            // The machine IS stopped; failing the operation over bookkeeping would send somebody to
            // press Stop again on a machine that is already off.
            console.warn(`[infra] stopped ${host.hostname} but could not mark it DOWN: ${e.message}`);
          });
        infraChanged();
      }
      return {
        result: 'succeeded',
        detail: `${host.hostname} is ${after.state}.`,
        value: {
          result: 'succeeded',
          message: verb === 'stop'
            ? `${host.hostname} is stopped. It costs nothing until it is started again.`
            : `${host.hostname} is running. Its devices cold boot from here, which takes a few minutes.`,
          changed: { state: after.state },
        },
      };
    }

    /**
     * IT WAS ACCEPTED AND IT IS STILL MOVING. That is `accepted`, not `unknown` and certainly not
     * `failed`: the provider took the request, we watched it for twenty-five seconds, and a GCE
     * start legitimately takes longer. The row stays open so that the log says what it is — a thing
     * in flight — rather than claiming an outcome nobody has.
     */
    return {
      result: 'accepted',
      detail: `Accepted; last seen ${after.raw || 'unknown'} after ${Math.round(settleMs() / 1000)}s.`,
      value: {
        result: 'accepted',
        message: `${host.hostname} accepted the request and is ${POWER_WORD[after.state]}. `
          + 'This page follows it from here.',
        changed: { state: after.state },
      },
    };
  });
}

export const startHost = (req: FastifyRequest, id: string, reason?: unknown) =>
  powerOperation(req, id, 'start', reason);
export const stopHost = (req: FastifyRequest, id: string, reason?: unknown) =>
  powerOperation(req, id, 'stop', reason);
export const restartHost = (req: FastifyRequest, id: string, reason?: unknown) =>
  powerOperation(req, id, 'restart', reason);
