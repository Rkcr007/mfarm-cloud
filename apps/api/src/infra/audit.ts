import type { FastifyRequest } from 'fastify';
import { withSystem } from '../db.ts';

/**
 * Every infrastructure operation, written down before it happens.
 *
 * ---------------------------------------------------------------- the rule this module lives by
 *
 * **THE ROW IS WRITTEN BEFORE THE OPERATION IS DISPATCHED, AND A FAILURE TO WRITE IT CANCELS THE
 * OPERATION.** That is the opposite of `commandLog.ts`, whose header says at length that a command
 * must never be slower or less reliable because it was recorded — and the difference is the point.
 * A WebDriver step that goes unlogged costs somebody a nicer debugging screen. An infrastructure
 * operation that goes unlogged is a production VM that stopped and nothing in the system knows who
 * did it. So this one is synchronous, on the request path, and its errors propagate.
 *
 * There is no buffer, no batch and no timer here for the same reason. Those exist in the command log
 * because it writes hundreds of rows a minute; this writes one row per human button press.
 *
 * ---------------------------------------------------------------- the outcome, and `unknown`
 *
 * A row starts as `accepted` and settles exactly once. The settle path is deliberately unable to
 * write `accepted` back, and the database enforces that rather than trusting this file — see
 * migration 053's trigger.
 *
 * The value that matters most is `unknown`. When we asked a provider to stop a VM and never found
 * out what happened, the truthful answer is not "failed": reporting a failure for an operation that
 * may well have succeeded is how somebody presses Start on a machine that is already starting. Every
 * call site that can time out must reach for `unknown`, and `settle()` will not let a timeout be
 * recorded as anything else by accident — it takes the result as an argument with no default.
 */

/** How an operation ended. See migration 053 for what each one commits the product to saying. */
export type OperationResult = 'succeeded' | 'failed' | 'noop' | 'unknown';

/**
 * What a step may report — the four settled outcomes, plus `accepted` meaning "still in flight".
 *
 * `accepted` IS NOT AN OUTCOME AND MUST NOT BE WRITTEN AS ONE. It is the state every row starts in,
 * and a step returning it is saying that the operation was dispatched and has not finished — a GCE
 * start that is still booting, most often. `audited` leaves such a row OPEN rather than settling it,
 * so the log reads "in progress" instead of claiming a result nobody has. The database refuses the
 * write independently (migration 053's trigger), which is what makes this a contract rather than a
 * convention.
 */
export type StepResult = OperationResult | 'accepted';

export type TargetKind = 'host' | 'service' | 'fleet';

export interface OperationRequest {
  action: string;
  targetKind: TargetKind;
  /** A host uuid, a service name, or the literal `fleet`. Never a free-form string from a client. */
  targetId: string;
  /** What the operator SAW — the hostname or service label as the console displayed it. */
  targetLabel: string;
  /** Validated arguments. Never a credential; nothing that reaches here has one. */
  params?: Record<string, unknown>;
}

export interface OperationRow {
  id: string;
  requestedAt: string;
  finishedAt: string | null;
  actor: { userId: string | null; email: string; orgId: string | null };
  action: string;
  target: { kind: string; id: string; label: string };
  params: Record<string, unknown>;
  result: string;
  detail: string | null;
  requestId: string | null;
}

/**
 * The actor, resolved from the request rather than passed in by the caller.
 *
 * The EMAIL is read from the database and denormalised onto the row, and that read is not a
 * convenience: `user_sessions` carries a user id and nothing legible, so a route that logged only
 * the id would produce an audit trail that becomes unreadable the moment the account is deleted —
 * which is precisely when somebody wants to read it.
 */
async function actorOf(req: FastifyRequest): Promise<{ userId: string; email: string; orgId: string }> {
  if (req.principal?.kind !== 'user') {
    // Unreachable through the routes, which all call `requireOperator` first. Thrown rather than
    // defaulted so that a future caller that forgets cannot write an anonymous row.
    throw new Error('infra audit: only a signed-in operator can be the actor of an operation');
  }
  const { userId, orgId } = req.principal;
  const email = await withSystem(async (c) => {
    const { rows } = await c.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
    return rows[0]?.email ?? userId;
  });
  return { userId, email, orgId };
}

/**
 * The client address, honouring the same proxy setting as the rate limiter.
 *
 * `req.ip` is already correct — Fastify derives it from `trustProxy`, which `config.ts` sets — so
 * this exists only to reject something that will not cast to `inet` and lose the column rather than
 * the row. An audit entry with no IP is worth far more than no audit entry.
 */
function clientIp(req: FastifyRequest): string | null {
  const ip = req.ip;
  if (typeof ip !== 'string' || ip.length === 0 || ip.length > 45) return null;
  // Fastify hands back an IPv4-mapped IPv6 address on a dual-stack listener; `inet` accepts it, but
  // `::ffff:10.0.0.4` in an audit trail is a small puzzle for whoever reads it at 2am.
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * Record that an operation was authorized and is about to be attempted. Returns its id.
 *
 * CALL THIS BEFORE DOING ANYTHING. An operation logged after the fact is not logged at all for the
 * case that matters — the one where the process dies halfway through.
 */
export async function begin(req: FastifyRequest, op: OperationRequest): Promise<string> {
  const actor = await actorOf(req);
  return withSystem(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO infra_operations
         (actor_user_id, actor_email, actor_org_id, action,
          target_kind, target_id, target_label, params, request_id, client_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       RETURNING id`,
      [
        actor.userId, actor.email, actor.orgId, op.action,
        op.targetKind, op.targetId, op.targetLabel,
        JSON.stringify(op.params ?? {}), req.id ?? null, clientIp(req),
      ],
    );
    return rows[0].id;
  });
}

/**
 * Write the outcome onto a row `begin()` opened.
 *
 * NEVER THROWS. By the time this is called the operation has already happened, and an exception
 * here would turn "the VM stopped and we failed to record it" into "the VM stopped and the operator
 * was told the whole thing errored" — which would send them to press the button again. The failure
 * is logged loudly instead, and the row stays `accepted`, which reads as "dispatched, outcome not
 * recorded" and is exactly what happened.
 */
export async function settle(
  id: string,
  result: OperationResult,
  detail?: string | null,
): Promise<void> {
  try {
    await withSystem((c) =>
      c.query(
        `UPDATE infra_operations
            SET result = $2, detail = $3, finished_at = now()
          WHERE id = $1 AND result = 'accepted'`,
        [id, result, detail ?? null],
      ));
  } catch (e) {
    console.error(`[infra-audit] could not record the outcome of operation ${id} `
      + `(${result}): ${(e as Error).message}`);
  }
}

/**
 * Record what an in-flight operation was last seen doing, WITHOUT settling it.
 *
 * The only update the append-only trigger permits on an unsettled row is one that settles it, so
 * this writes the detail through a path the trigger allows: `result` is unchanged, which makes the
 * statement a no-op as far as the immutability check is concerned. Never throws — the operation
 * already happened, and a logging failure must not be reported to the operator as one.
 */
async function noteProgress(id: string, detail: string | null): Promise<void> {
  try {
    await withSystem((c) =>
      c.query(
        `UPDATE infra_operations SET detail = $2 WHERE id = $1 AND result = 'accepted'`,
        [id, detail],
      ));
  } catch (e) {
    console.error(`[infra-audit] could not record progress on operation ${id}: ${(e as Error).message}`);
  }
}

/**
 * Run an operation with its audit row around it.
 *
 * Every route uses this rather than calling `begin`/`settle` by hand, because the hand-written
 * version has one failure mode that matters: an early `return` on a validation branch leaves a row
 * stuck at `accepted` forever, and a log full of operations that never finished is a log people stop
 * trusting. The `finally` here cannot be forgotten.
 *
 * The body returns its own result and detail, so "already running" comes back as `noop` from the
 * one place that can tell — the code that just looked.
 */
export async function audited<T>(
  req: FastifyRequest,
  op: OperationRequest,
  body: (opId: string) => Promise<{ result: StepResult; detail?: string; value: T }>,
): Promise<T & { operationId: string }> {
  const opId = await begin(req, op);
  let settled = false;
  try {
    const out = await body(opId);
    /**
     * `accepted` LEAVES THE ROW OPEN, deliberately and not as an oversight. See `StepResult`: the
     * operation is genuinely still happening, and the alternative — settling it as `succeeded`
     * because the provider took the request — would put a result in the log that nobody verified.
     * The detail is still written, so the row says what was last seen.
     */
    if (out.result === 'accepted') {
      await noteProgress(opId, out.detail ?? null);
    } else {
      await settle(opId, out.result, out.detail ?? null);
    }
    settled = true;
    return { ...(out.value as T), operationId: opId };
  } catch (e) {
    if (!settled) {
      // An exception escaping the body is a failure of the operation, with one exception the call
      // sites handle themselves: a timeout, which must settle as `unknown` INSIDE the body before
      // rethrowing. Anything that reaches here genuinely did not happen.
      await settle(opId, 'failed', (e as Error).message);
    }
    throw e;
  }
}

export interface HistoryFilter {
  from?: Date | null;
  to?: Date | null;
  actorUserId?: string | null;
  targetKind?: TargetKind | null;
  targetId?: string | null;
  action?: string | null;
  /** `ok` collapses succeeded and noop; `bad` collapses failed and unknown. */
  outcome?: 'ok' | 'bad' | null;
  limit?: number;
}

/**
 * The operations history, filtered.
 *
 * `outcome` is coarse on purpose. The history screen offers "success / failure" because that is the
 * question somebody scanning it has, and the four-value `result` is shown per row — a filter with
 * four checkboxes would make the reader decide whether `noop` counts as success before they can
 * search, which is work the filter is supposed to do for them.
 */
export async function history(f: HistoryFilter = {}): Promise<OperationRow[]> {
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const rows = await withSystem(async (c) => {
    const { rows } = await c.query(
      `SELECT id, requested_at, finished_at, actor_user_id, actor_email, actor_org_id,
              action, target_kind, target_id, target_label, params, result, detail, request_id
         FROM infra_operations
        WHERE ($1::timestamptz IS NULL OR requested_at >= $1)
          AND ($2::timestamptz IS NULL OR requested_at <  $2)
          AND ($3::uuid        IS NULL OR actor_user_id = $3)
          AND ($4::text        IS NULL OR target_kind   = $4)
          AND ($5::text        IS NULL OR target_id     = $5)
          AND ($6::text        IS NULL OR action        = $6)
          AND ($7::text        IS NULL
               OR ($7 = 'ok'  AND result IN ('succeeded', 'noop'))
               OR ($7 = 'bad' AND result IN ('failed', 'unknown')))
        ORDER BY requested_at DESC
        LIMIT $8`,
      [
        f.from ?? null, f.to ?? null, f.actorUserId ?? null,
        f.targetKind ?? null, f.targetId ?? null, f.action ?? null,
        f.outcome ?? null, limit,
      ],
    );
    return rows;
  });

  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    requestedAt: (r.requested_at as Date).toISOString(),
    finishedAt: r.finished_at ? (r.finished_at as Date).toISOString() : null,
    actor: {
      userId: (r.actor_user_id as string | null) ?? null,
      email: r.actor_email as string,
      orgId: (r.actor_org_id as string | null) ?? null,
    },
    action: r.action as string,
    target: {
      kind: r.target_kind as string,
      id: r.target_id as string,
      label: r.target_label as string,
    },
    params: (r.params as Record<string, unknown>) ?? {},
    result: r.result as string,
    detail: (r.detail as string | null) ?? null,
    requestId: (r.request_id as string | null) ?? null,
  }));
}

/**
 * The distinct actors and actions present in the log, for populating the history filters.
 *
 * READ FROM THE LOG rather than from the API's own allow-list, deliberately. A filter offering every
 * action the code can perform would list options that match nothing on this farm; a filter built
 * from what actually happened lists exactly the things somebody might be looking for.
 */
export async function historyFacets(): Promise<{
  actors: Array<{ userId: string | null; email: string }>;
  actions: string[];
  targets: Array<{ kind: string; id: string; label: string }>;
}> {
  return withSystem(async (c) => {
    const actors = await c.query(
      `SELECT DISTINCT ON (actor_email) actor_user_id, actor_email
         FROM infra_operations ORDER BY actor_email`);
    const actions = await c.query('SELECT DISTINCT action FROM infra_operations ORDER BY action');
    const targets = await c.query(
      `SELECT DISTINCT ON (target_kind, target_id) target_kind, target_id, target_label
         FROM infra_operations ORDER BY target_kind, target_id, requested_at DESC`);
    return {
      actors: actors.rows.map((r: { actor_user_id: string | null; actor_email: string }) =>
        ({ userId: r.actor_user_id, email: r.actor_email })),
      actions: actions.rows.map((r: { action: string }) => r.action),
      targets: targets.rows.map((r: { target_kind: string; target_id: string; target_label: string }) =>
        ({ kind: r.target_kind, id: r.target_id, label: r.target_label })),
    };
  });
}
