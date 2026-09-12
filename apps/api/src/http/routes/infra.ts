import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireOperator } from '../server.ts';
import { badRequest } from '../errors.ts';
import {
  costSnapshot, fleetSnapshot, healthComponents, hostSnapshots, overallHealth, probeDatabase,
} from '../../infra/snapshot.ts';
import { recentEvents } from '../../infra/events.ts';
import { history, historyFacets, type TargetKind } from '../../infra/audit.ts';
import { GIT_SHA, BUILT_AT, shortSha } from '../../version.ts';

/**
 * The Infrastructure Operations Center's read side.
 *
 * ---------------------------------------------------------------- what this is NOT
 *
 * It is not the top bar moved to a new URL. The header segment this work removes said "4 of 5
 * ready" and, since ADR-0035, "host up 20h · ~₹410" — two facts about a farm, on a bar that follows
 * you around every screen in the product. Everything else an operator needs to run this thing lived
 * in Prometheus behind a token, in `journalctl` on a box, or in a shell script on somebody's laptop.
 *
 * This is the other side of that: one surface that can answer what exists, whether it is healthy,
 * what is running, what it is costing, and what happened — and, from the operations routes that
 * follow this file, act on the answer without an SSH session.
 *
 * ---------------------------------------------------------------- the boundary
 *
 * **THE BROWSER NEVER TALKS TO A MACHINE.** Every route here runs on the control plane, reads from
 * Postgres and from the agent tunnel registry, and returns JSON. There is no credential in any
 * payload below, no address of anything private, and — deliberately — no generic escape hatch: no
 * command field, no path parameter that reaches a shell, nothing that takes a string from a client
 * and gives it to a machine. The operations that exist are named, fixed and enumerated in code.
 *
 * `requireOperator` is the only gate, and it is a FLEET capability rather than an org role — see
 * migration 053 for why the two are not the same question, and `server.ts` for the check itself.
 */

/** A bounded integer from a query string, or the default. Never throws on garbage; clamps. */
function intParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A uuid from a query string, validated HERE rather than by the database.
 *
 * `$3::uuid` on a string that is not one raises `invalid input syntax for type uuid`, which Fastify
 * turns into a 500 — so a typo in a filter would look like the control plane falling over. Checked
 * in the one place that can say which parameter was wrong.
 */
function uuidParam(raw: string | undefined, name: string): string | null {
  if (raw === undefined || raw === '') return null;
  if (!UUID.test(raw)) throw badRequest(`\`${name}\` must be a uuid.`);
  return raw;
}

function dateParam(raw: string | undefined, name: string): Date | null {
  if (raw === undefined || raw === '') return null;
  const d = new Date(raw);
  // Refused rather than defaulted, the same choice `/account/usage` makes: a caller who asked for a
  // window and silently got a different one would read the answer as being about the window they
  // named.
  if (Number.isNaN(d.getTime())) {
    throw badRequest(`"${raw}" is not a date this API understands (${name}). Use ISO 8601.`);
  }
  return d;
}

export async function infraRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Whether a host's agent tunnel is open right now.
   *
   * THE ONE REAL-TIME FACT ON THIS PAGE. Everything else is a row that was written at some point in
   * the past; this is a socket that either is or is not connected as the request is served. It is
   * what separates `live` from `stale`, and until now nothing in the product read it — the registry
   * itself carried a comment saying so, and this is the caller it was waiting for.
   */
  const reachable = (hostId: string): boolean => app.tunnels.has(hostId);

  /**
   * GET /v1/infra/overview — the whole dashboard, in one request.
   *
   * ONE REQUEST RATHER THAN SIX, and that is a correctness decision rather than a performance one.
   * The health rollup is computed FROM the host and fleet snapshots; if the console fetched them
   * separately it would eventually render a green "Healthy" beside a host card that says
   * unreachable, because the two came from different moments. `generatedAt` stamps the whole
   * payload so the page can say how old everything on it is, together.
   */
  app.get('/infra/overview', async (req) => {
    requireOperator(req);

    // Sequential on purpose: `probeDatabase` is a latency measurement, and running it beside four
    // other queries on the same pool would measure the contention this page creates rather than the
    // database's own health.
    const dbLatencyMs = await probeDatabase();
    const [hosts, fleet] = await Promise.all([hostSnapshots(reachable), fleetSnapshot()]);
    const [cost, components, events] = await Promise.all([
      costSnapshot(hosts),
      healthComponents(hosts, fleet, dbLatencyMs),
      recentEvents({ limit: 20 }),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      /** The control plane describing itself, because it is infrastructure too. */
      controlPlane: {
        // The same identity the header badge carries, on the page that asks "what is running".
        // `shortSha` renders `dev` for a working tree rather than inventing a release identity.
        sha: GIT_SHA,
        shortSha: shortSha(),
        builtAt: BUILT_AT,
        uptimeSeconds: Math.round(process.uptime()),
        dbLatencyMs,
      },
      health: { overall: overallHealth(components), components },
      fleet,
      hosts,
      cost,
      events,
      /**
       * WHAT THIS DEPLOYMENT CAN ACTUALLY DO, sent to the browser rather than assumed by it.
       *
       * The console must not draw a Stop button that returns 501, and it must not hide one that
       * would have worked. Both mistakes are the same mistake — a control offered on a premise the
       * server has not confirmed — and this repo has shipped that shape seven times. So the server
       * says, per capability, and the page renders from the answer.
       */
      capabilities: {
        drain: true,
        power: false,
        services: false,
      },
    };
  });

  /**
   * GET /v1/infra/events — the feed on its own, for the Events tab.
   *
   * Separate from the overview's `events` because they answer different questions with the same
   * rows: twenty lines beside the health panel is context, and this is the whole week with a window
   * somebody chose.
   */
  app.get<{ Querystring: { limit?: string; hours?: string } }>('/infra/events', async (req) => {
    requireOperator(req);
    return {
      events: await recentEvents({
        limit: intParam(req.query.limit, 100, 1, 200),
        sinceHours: intParam(req.query.hours, 168, 1, 24 * 90),
      }),
    };
  });

  /**
   * GET /v1/infra/operations — who did what to this farm, filtered.
   *
   * Every filter the brief asks for is a column and an index (053): date, user, host, action, and
   * success/failure. None of them is computed in application code, because a filter that pages the
   * whole table into the process and then discards most of it stops working exactly when the log is
   * long enough to need filtering.
   */
  app.get<{
    Querystring: {
      from?: string; to?: string; actor?: string; targetKind?: string; target?: string;
      action?: string; outcome?: string; limit?: string;
    };
  }>('/infra/operations', async (req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>) => {
    requireOperator(req);
    const q = req.query;

    const outcome = q.outcome === 'ok' || q.outcome === 'bad' ? q.outcome : null;
    if (q.outcome && !outcome) {
      throw badRequest('`outcome` must be `ok` (succeeded or already in that state) or `bad` (failed or unknown).');
    }
    const targetKind = q.targetKind as TargetKind | undefined;
    if (targetKind && !['host', 'service', 'fleet'].includes(targetKind)) {
      throw badRequest('`targetKind` must be host, service or fleet.');
    }

    return {
      operations: await history({
        from: dateParam(q.from, 'from'),
        to: dateParam(q.to, 'to'),
        actorUserId: uuidParam(q.actor, 'actor'),
        targetKind: targetKind ?? null,
        targetId: q.target ?? null,
        action: q.action ?? null,
        outcome,
        limit: intParam(q.limit, 100, 1, 500),
      }),
    };
  });

  /**
   * GET /v1/infra/operations/facets — the values the filters above should offer.
   *
   * Built from what is IN the log rather than from the API's allow-list, so the filter never offers
   * an action nothing on this farm has ever performed.
   */
  app.get('/infra/operations/facets', async (req) => {
    requireOperator(req);
    return historyFacets();
  });
}
