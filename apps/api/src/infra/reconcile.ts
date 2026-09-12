import { withSystem } from '../db.ts';
import { settle } from './audit.ts';
import { instanceFor, instanceStatus, CloudError } from './cloud.ts';
import { infraChanged } from './stream.ts';

/**
 * Finish the operations that outlived their own request.
 *
 * ---------------------------------------------------------------- why there is anything to finish
 *
 * A power operation watches the machine for twenty-five seconds and then answers. On this farm a GCE
 * stop takes longer than that, so BOTH console-initiated stops on 2026-09-13 came back `accepted` —
 * "last seen STOPPING" — which is the honest answer and leaves the row open.
 *
 * Nothing closed it. The operator saw the truth on the page, because the page is a live view of the
 * provider, but the LOG kept two operations in progress forever. Over a month of that, the audit
 * trail stops answering the question it exists for: **did anything actually change?**
 *
 * ---------------------------------------------------------------- what it does NOT do
 *
 * It does not retry, and it does not act. It asks the provider what the machine is doing now and
 * writes down what it finds. An operation that has been open for an hour is not re-issued — that
 * would turn a reconciler into a second actor, and two things issuing stops is how a farm ends up
 * stopped twice and started once.
 *
 * ---------------------------------------------------------------- and it gives up honestly
 *
 * Past the horizon, an operation whose outcome still cannot be established settles as `unknown`
 * rather than staying open or being guessed into `failed`. That is the outcome `unknown` exists for,
 * and a row that reads "we asked and never found out" is worth more than one that reads "in
 * progress" a fortnight later.
 */

/** Power actions, and the state each one is trying to reach. Nothing else is reconcilable. */
const TARGET: Record<string, 'running' | 'stopped'> = {
  'start-host': 'running',
  'restart-host': 'running',
  'stop-host': 'stopped',
};

/**
 * How long an operation may stay open before `unknown` is the honest answer.
 *
 * TEN MINUTES. A GCE stop is under two; a start plus a cold boot is under six. Past this the machine
 * is not on its way anywhere the operation asked for, and continuing to call it "in progress" is the
 * log describing a thing that is not happening.
 *
 * Overridable, and read inside the function rather than at module scope, for the reason every timing
 * in this feature is: a test asserting "it eventually gives up" cannot wait ten minutes, and it
 * cannot backdate the row either — `requested_at` is immutable and migration 053's trigger refuses
 * the UPDATE, which is the trigger working.
 */
function giveUpMs(): number {
  return Number(process.env.INFRA_OPERATION_GIVE_UP_MS ?? 10 * 60_000);
}

interface OpenRow {
  id: string;
  action: string;
  target_label: string;
  requested_at: Date;
  instance: string | null;
}

export interface ReconcileResult {
  checked: number;
  settled: number;
  gaveUp: number;
}

/**
 * One pass. Safe to call on a timer and safe to call concurrently — every write is conditioned on
 * the row still being `accepted`, and migration 053's trigger refuses a second settle regardless.
 */
export async function reconcileOperations(): Promise<ReconcileResult> {
  const rows = await withSystem(async (c) => {
    const { rows } = await c.query<OpenRow>(
      `SELECT id, action, target_label, requested_at, params->>'instance' AS instance
         FROM infra_operations
        WHERE result = 'accepted'
          AND action = ANY($1::text[])
        ORDER BY requested_at
        LIMIT 20`,
      [Object.keys(TARGET)],
    );
    return rows;
  });

  const out: ReconcileResult = { checked: rows.length, settled: 0, gaveUp: 0 };
  let changed = false;

  for (const row of rows) {
    const age = Date.now() - row.requested_at.getTime();
    /**
     * THE TARGET COMES FROM THE ROW, not from the host's current name. `params.instance` was written
     * when the operation was issued; resolving the hostname again would follow an allow-list that
     * may have been edited since, and an audit row must be settled against the machine it named.
     */
    const target = row.instance ? instanceFor(row.target_label) : null;
    if (!target || target.instance !== row.instance) {
      if (age > giveUpMs()) {
        await settle(row.id, 'unknown',
          'The machine this operation named is no longer on the power allow-list, so its outcome '
          + 'could not be checked.');
        out.gaveUp++;
        changed = true;
      }
      continue;
    }

    let state;
    try {
      state = (await instanceStatus(target)).state;
    } catch (e) {
      // The provider is unreachable. Leave it open and try on the next pass — unless it has been
      // open long enough that "we never found out" is simply true.
      if (age > giveUpMs()) {
        await settle(row.id, 'unknown',
          `The outcome was never confirmed: ${(e as CloudError).message}`);
        out.gaveUp++;
        changed = true;
      }
      continue;
    }

    if (state === TARGET[row.action]) {
      await settle(row.id, 'succeeded', `${row.target_label} is ${state}.`);
      out.settled++;
      changed = true;
      continue;
    }

    if (age > giveUpMs()) {
      /**
       * IT ARRIVED SOMEWHERE ELSE. Not a failure — the provider accepted the request and something
       * happened — and not a success either. `unknown` with the state it actually reached is the
       * only reading that does not invent a story.
       */
      await settle(row.id, 'unknown',
        `Still ${state} ${Math.round(age / 60_000)} minutes after the request, which is not the `
        + `${TARGET[row.action]} it asked for.`);
      out.gaveUp++;
      changed = true;
    }
  }

  if (changed) infraChanged();
  return out;
}
