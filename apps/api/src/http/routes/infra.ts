import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireOperator } from '../server.ts';
import { badRequest } from '../errors.ts';
import {
  costSnapshot, fleetSnapshot, healthComponents, hostSnapshots, overallHealth, probeDatabase,
} from '../../infra/snapshot.ts';
import { recentEvents } from '../../infra/events.ts';
import { history, historyFacets, type TargetKind } from '../../infra/audit.ts';
import { drainHost, resumeHost } from '../../infra/operations.ts';
import { waitForChange, sseFrame, SSE_KEEPALIVE, streamListeners } from '../../infra/stream.ts';
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

/**
 * How often the stream recomputes when nothing has signalled.
 *
 * TWO SECONDS, which is slower than a heartbeat and faster than the poll it accelerates. Anything
 * shorter would spend the payload's cost — a probe, five grouped queries and a fortnight of
 * interval arithmetic — on redrawing numbers that move at ten-second resolution.
 *
 * OVERRIDABLE, and the reason is a test rather than a deployment. `infraChanged()` is supposed to
 * make an operation arrive faster than the tick; with a two-second tick, a test asserting that
 * cannot tell a working push from a tick that happened to land — it would pass with the signal
 * removed, which is a test that agrees with a broken feature. Winding the tick out to half a minute
 * makes the push the only way a frame can arrive in time.
 *
 * Read inside the handler, not at module scope: `import` is hoisted, so an env var read during
 * module evaluation cannot be set by a test — the trap every route file in here documents.
 */
function tickMs(): number {
  return Number(process.env.INFRA_STREAM_TICK_MS ?? 2_000);
}

/**
 * How often a quiet stream says something, INDEPENDENTLY of how often it recomputes.
 *
 * These were the same timer and that was a bug waiting for a slower tick. A proxy closes an idle
 * connection — a minute is a common default — and a stream that is healthy but has nothing to
 * report is indistinguishable from a dead one until bytes arrive. Tying the keepalive to the
 * recompute meant that raising the tick past the proxy's patience would silently start dropping
 * connections, and the symptom would be a page that stops updating for reasons nobody could see.
 *
 * Fifteen seconds, well under any idle timeout worth worrying about, and overridable for the same
 * reason as the tick: a test asserting "a quiet farm sends keepalives, not redraws" needs both
 * halves observable inside a few seconds.
 */
function keepaliveMs(): number {
  return Number(process.env.INFRA_STREAM_KEEPALIVE_MS ?? 15_000);
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
  /**
   * The whole payload, built once and shared by the request route and the stream.
   *
   * ONE BUILDER, because the two must never drift: a console that gets a different shape depending
   * on whether its stream is connected is a console with two rendering paths and one of them
   * untested. The stream diffs what comes out of here; the route sends it.
   */
  async function overviewPayload() {
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
        /**
         * TRUE ONLY WHERE THE ROUTE BEHIND IT EXISTS. "The mechanism exists" is not the same claim
         * as "the console can invoke it": `quarantine_host` has been in the database since 016 and
         * declaring this true on the strength of the SQL would have put a button on the page that
         * posts to a 404 — the same defect in a new costume.
         */
        drain: true,
        /** Needs a cloud credential this VM does not hold. See `capabilities` in the console. */
        power: false,
        /** Needs the agent to learn a job kind. Its own stage. */
        services: false,
      },
    };
  }

  app.get('/infra/overview', async (req) => {
    requireOperator(req);
    return overviewPayload();
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

  /* ------------------------------------------------------------------ operations */

  /**
   * POST /v1/infra/hosts/:id/drain — take a host out of service without evicting anybody.
   *
   * THE ONLY INPUT IS A REASON, and it is stored and never executed. There is no host name here,
   * no command, no path: the id is a uuid the database resolves or 404s on. That is what makes an
   * infrastructure control safe to put behind a browser at all.
   *
   * CSRF IS ALREADY HANDLED, centrally, for every unsafe request — see `server.ts`. It is not
   * re-checked here, because a second check in one route is a check the other routes do not have.
   *
   * RATE LIMITING IS ALREADY HANDLED, centrally, by `@fastify/rate-limit`. Worth stating because
   * the brief asks for it specifically and the honest answer is that the mechanism exists and is
   * global, not that a special one was added for this.
   */
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/infra/hosts/:id/drain',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          // Nothing else is accepted. A body with an extra field is a caller expecting behaviour
          // this route does not have, and a silent ignore is how that becomes a support thread.
          additionalProperties: false,
          properties: { reason: { type: 'string', maxLength: 200 } },
        },
      },
    },
    async (req) => {
      requireOperator(req);
      return drainHost(req, req.params.id, req.body?.reason);
    },
  );

  /** POST /v1/infra/hosts/:id/resume — put a drained host back into service. */
  app.post<{ Params: { id: string } }>(
    '/infra/hosts/:id/resume',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      },
    },
    async (req) => {
      requireOperator(req);
      return resumeHost(req, req.params.id);
    },
  );

  /* ------------------------------------------------------------------ the live stream */

  /**
   * GET /v1/infra/stream — the overview, pushed.
   *
   * WHY A STREAM WHEN THE CONSOLE ALREADY POLLS. An operation has a moment: somebody presses Drain
   * and watches, and five seconds of nothing is long enough to press it again. The push closes that
   * window to a round trip. See `infra/stream.ts` for why this is SSE and not a socket, and for the
   * in-process limit of the change signal.
   *
   * THE POLL IS NOT REMOVED. A browser that cannot hold this open sees the page it would have seen
   * anyway, five seconds later — which is what makes this an accelerator rather than a dependency.
   */
  app.get('/infra/stream', async (req, reply) => {
    requireOperator(req);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx and friends buffer a response body by default, which turns an event stream into a
      // single delivery at the end of time. This is the header that turns it off, and it is inert
      // everywhere else.
      'x-accel-buffering': 'no',
    });

    /**
     * ABORTED WHEN THE CLIENT GOES, and that is the whole lifecycle. A stream that keeps computing
     * an expensive payload for a closed tab is a leak that only shows up on a busy day.
     */
    const gone = new AbortController();
    req.raw.on('close', () => gone.abort());

    /**
     * The keepalive, on its OWN timer — see `keepaliveMs`. `unref` so a stream never holds the
     * process open, and cleared in the `finally` below so a closed client leaves no timer behind.
     */
    const keepalive = setInterval(() => {
      try { reply.raw.write(SSE_KEEPALIVE); } catch { gone.abort(); }
    }, keepaliveMs());
    keepalive.unref?.();

    let lastSignature = '';
    try {
      while (!gone.signal.aborted) {
        const payload = await overviewPayload();
        /**
         * SENT ONLY WHEN SOMETHING THE PAGE DRAWS HAS CHANGED, at the resolution it draws it.
         *
         * Not `generatedAt`, which differs on every tick — sending that would make the console
         * rebuild the screen twice a second under somebody's cursor, which is exactly what
         * `pollSignature` exists to prevent on the polling path. The signature below is the same
         * idea on the pushing one.
         */
        const signature = JSON.stringify([
          payload.health.overall,
          payload.hosts.map((h) => [h.id, h.power, h.reachability, h.machine.status,
            h.maintenance.drained, h.devices, h.sessions.active,
            h.alerts.map((a) => a.code)]),
          payload.fleet,
          payload.capabilities,
        ]);
        if (signature !== lastSignature) {
          lastSignature = signature;
          reply.raw.write(sseFrame('infra', payload));
        }
        await waitForChange(tickMs(), gone.signal);
      }
    } catch {
      /* A write to a socket the client already closed. Nothing to do but stop. */
    } finally {
      clearInterval(keepalive);
      gone.abort();
      reply.raw.end();
    }
    // Fastify must not also try to send a body.
    return reply;
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
