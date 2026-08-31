import type { FastifyInstance } from 'fastify';
import { withTenant } from '../../db.ts';
import { requireTenant } from '../server.ts';
import { notFound } from '../errors.ts';
import { timeline } from '../../executionEvents.ts';

/**
 * Runs — the screen that makes a hundred executions legible (docs/EXECUTION_MODEL.md §4.2).
 *
 * Everything here is DERIVED from the run's sessions. `runs` itself holds four columns and no
 * status, no end time and no build, because none of those three is knowable today and inventing
 * them would be worse than omitting them:
 *
 *   * a run has no end signal — a sequential suite ends every session before starting the next, so
 *     "the last session ended" would mark a twenty-test run finished nineteen times before it was;
 *   * WebDriver has no concept of an assertion, so a pass/fail count would be inference presented
 *     as fact (§4.3 is what makes it real);
 *   * a run's sessions may legitimately name different builds, so one denormalised `app_build_id`
 *     would silently pick a winner.
 *
 * What IS reported: how many sessions, how many are still live, the window they span, and the build
 * — named only when every session that installed one installed the same one, counted otherwise.
 *
 * Since migration 021 it also reports OUTCOMES, and those come from one place only: what the suite
 * said. A run whose sessions reported nothing has `tests.total === 0`, which the console renders as
 * "not reported" rather than as zero failures — the difference between "nothing broke" and "nobody
 * told us" is the whole reason §4.3 exists, and collapsing it would put a green number on a run that
 * was never checked.
 */

/** Sessions that have not finished. The only honest "is this run still going" signal available. */
const LIVE_STATES = ['QUEUED', 'ALLOCATING', 'ACTIVE'];

interface RunRow {
  id: string;
  external_id: string;
  created_at: Date;
  session_count: string;
  live_count: string;
  ended_count: string;
  first_session_at: Date | null;
  last_activity_at: Date | null;
  build_count: string;
  build_id: string | null;
  package_name: string | null;
  version_name: string | null;
  tests_total: string;
  tests_passed: string;
  tests_failed: string;
  tests_skipped: string;
  sessions_reporting: string;
}

/**
 * The rollup, in one statement per page rather than one per run.
 *
 * The aggregate is a LATERAL rather than a GROUP BY over a three-way join, because the join form
 * multiplies rows before it counts them: a run whose sessions each hold several artifacts would
 * report its session count times its artifact count. That is the classic shape of a number that is
 * wrong by a factor nobody notices until it is quoted in an invoice.
 *
 * `build_count` uses COUNT(DISTINCT), and `one_build` is a MAX over the same column — which is the
 * single value exactly when the count is 1, and is joined only under that condition. Reporting a
 * build for a run that touched three of them would be the same lie the schema refuses to store.
 */
const LIST_SQL = `
  SELECT r.id, r.external_id, r.created_at,
         agg.session_count, agg.live_count, agg.ended_count,
         agg.first_session_at, agg.last_activity_at, agg.build_count,
         b.id AS build_id, b.package_name, b.version_name,
         t.tests_total, t.tests_passed, t.tests_failed, t.tests_skipped, t.sessions_reporting
    FROM runs r
    LEFT JOIN LATERAL (
      SELECT count(*)                                                   AS session_count,
             count(*) FILTER (WHERE s.state = ANY($2::session_state[]))  AS live_count,
             count(*) FILTER (WHERE s.ended_at IS NOT NULL)              AS ended_count,
             min(s.created_at)                                           AS first_session_at,
             -- COALESCE down the lifecycle: a session that is still running has no ended_at, and a
             -- queued one has no started_at either. Without the fallback a run of nothing but
             -- queued sessions would report no activity at all, which is when somebody is most
             -- likely to be looking at it.
             max(COALESCE(s.ended_at, s.started_at, s.created_at))       AS last_activity_at,
             count(DISTINCT w.app_build_id)                              AS build_count,
             max(w.app_build_id::text)                                   AS one_build
        FROM sessions s
        LEFT JOIN webdriver_sessions w ON w.session_id = s.id
       WHERE s.run_id = r.id
    ) agg ON true
    LEFT JOIN app_builds b ON agg.build_count = 1 AND b.id = agg.one_build::uuid
    -- A SECOND lateral rather than more aggregates in the first one. Sessions and results are
    -- independent one-to-many branches off a run, so counting both in one join multiplies them:
    -- a run of 3 sessions with 8 results each would report 24 sessions and 24 of every result. The
    -- same row-multiplication trap the first lateral exists to avoid, one level down.
    LEFT JOIN LATERAL (
      SELECT count(*)                                           AS tests_total,
             count(*) FILTER (WHERE tr.status = 'passed')       AS tests_passed,
             count(*) FILTER (WHERE tr.status = 'failed')       AS tests_failed,
             count(*) FILTER (WHERE tr.status = 'skipped')      AS tests_skipped,
             -- How many of the run's sessions reported anything at all. This is what separates a
             -- run that passed from a run nobody instrumented, and without it the two are both
             -- "0 failures".
             count(DISTINCT tr.session_id)                      AS sessions_reporting
        FROM test_results tr
        JOIN sessions s2 ON s2.id = tr.session_id
       WHERE s2.run_id = r.id
    ) t ON true
`;

function runJson(r: RunRow) {
  const buildCount = Number(r.build_count);
  return {
    id: r.id,
    /** What the caller wrote in `mfarm:runId`. Their id, and the one they will search for. */
    runId: r.external_id,
    createdAt: r.created_at,
    sessions: {
      total: Number(r.session_count),
      live: Number(r.live_count),
      ended: Number(r.ended_count),
    },
    firstSessionAt: r.first_session_at,
    lastActivityAt: r.last_activity_at,
    /** Null when the run's sessions installed nothing, or installed more than one build. */
    build: buildCount === 1 && r.build_id
      ? { id: r.build_id, packageName: r.package_name, versionName: r.version_name }
      : null,
    /** 0, 1, or more. Distinguishes "no build named" from "several", which `build: null` cannot. */
    buildCount,
    /**
     * What the SUITE reported. The farm cannot observe any of this.
     *
     * `sessionsReporting` is load-bearing: a run with zero failures and zero reporting sessions has
     * not passed, it has not been measured, and every consumer of this object has to be able to
     * tell those apart. A retried test appears twice — once failed, once passed — because the farm
     * cannot distinguish a retry from a distinct test of the same name, and guessing which attempt
     * counted would be the same class of invention as inferring pass/fail in the first place.
     */
    tests: {
      total: Number(r.tests_total ?? 0),
      passed: Number(r.tests_passed ?? 0),
      failed: Number(r.tests_failed ?? 0),
      skipped: Number(r.tests_skipped ?? 0),
      sessionsReporting: Number(r.sessions_reporting ?? 0),
    },
  };
}

/** Exactly what Postgres will accept for a uuid, so a run named "nightly" is a lookup, not a 500. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runRoutes(app: FastifyInstance): Promise<void> {
  /** GET /v1/runs — the whole org's, newest first. The Runs screen's only query. */
  app.get<{ Querystring: { limit?: string } }>('/runs', async (req) => {
    const { orgId } = requireTenant(req);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const rows = await withTenant(orgId, async (c) => {
      const r = await c.query<RunRow>(
        `${LIST_SQL} ORDER BY r.created_at DESC LIMIT $1`,
        [limit, LIVE_STATES],
      );
      return r.rows;
    });
    return { runs: rows.map(runJson) };
  });

  /**
   * GET /v1/runs/:id — one run and every session in it.
   *
   * `:id` takes EITHER the uuid or the name the caller gave it, because the name is the one they
   * have: a CI job that knows it is build 4471 should be able to ask for `/v1/runs/4471` without
   * first searching for a uuid it never saw. The uuid is tried first and only when the parameter
   * looks like one, so a run legitimately named with a uuid still resolves — by id if that is what
   * it is, by name otherwise.
   */
  app.get<{ Params: { id: string } }>('/runs/:id', async (req) => {
    const { orgId } = requireTenant(req);
    const key = req.params.id;

    const run = await withTenant(orgId, async (c) => {
      if (UUID.test(key)) {
        const byId = await c.query<RunRow>(
          `${LIST_SQL} WHERE r.id = $1::uuid`, [key, LIVE_STATES],
        );
        if (byId.rows[0]) return byId.rows[0];
      }
      const byName = await c.query<RunRow>(
        `${LIST_SQL} WHERE r.external_id = $1`, [key, LIVE_STATES],
      );
      return byName.rows[0] ?? null;
    });
    // RLS makes another org's run indistinguishable from one that does not exist, which is the
    // same disclosure boundary as everywhere else — and it matters more here than usual, since run
    // names are guessable by construction: every CI system numbers builds from 1.
    if (!run) throw notFound('Run');

    const sessions = await withTenant(orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT s.id, s.state, s.region, s.created_at, s.started_at, s.ended_at, s.end_reason,
                d.local_id AS device_local_id, d.model AS device_model,
                w.app_build_id, b.package_name, b.version_name,
                t.total, t.passed, t.failed, t.skipped
           FROM sessions s
           LEFT JOIN devices d            ON d.id = s.device_id
           LEFT JOIN webdriver_sessions w ON w.session_id = s.id
           LEFT JOIN app_builds b         ON b.id = w.app_build_id
           -- Lateral again, for the reason the list query documents: joining results directly would
           -- multiply the session row by its result count.
           LEFT JOIN LATERAL (
             SELECT count(*)                                      AS total,
                    count(*) FILTER (WHERE tr.status = 'passed')  AS passed,
                    count(*) FILTER (WHERE tr.status = 'failed')  AS failed,
                    count(*) FILTER (WHERE tr.status = 'skipped') AS skipped
               FROM test_results tr WHERE tr.session_id = s.id
           ) t ON true
          WHERE s.run_id = $1
          ORDER BY s.created_at`,
        [run.id],
      );
      return rows;
    });

    /**
     * Every failure in the run, with the session that produced it.
     *
     * The session id is the point rather than a detail: it is what links a failed assertion to the
     * logcat and screenshot captured when that device was released. "What failed on build 4471, and
     * what did the screen look like" is one query and one click from here, which is the whole thing
     * §4.2 and §4.3 were building towards.
     *
     * Capped, because a suite that fails 4,000 tests should produce a usable page rather than a
     * 40 MB one. The count above is not capped, so the total stays honest when the list is cut.
     */
    const failures = await withTenant(orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT tr.id, tr.session_id, tr.name, tr.failure, tr.duration_ms, tr.reported_at,
                tr.failure_class, tr.failure_reason
           FROM test_results tr
           JOIN sessions s ON s.id = tr.session_id
          WHERE s.run_id = $1 AND tr.status = 'failed'
          ORDER BY tr.reported_at, tr.id
          LIMIT 200`,
        [run.id],
      );
      return rows;
    });

    /**
     * What the FARM saw during this run, alongside what the suite reported (spec §18).
     *
     * A SEPARATE LIST, not merged into `failures`, and that is the decision worth defending. The
     * merged version would attach an incident to whichever test was running when it happened and
     * call that test infrastructure — which is inference, and wrong often enough to matter: a test
     * can genuinely fail its assertion during a session that also had a cable glitch. Presented
     * side by side, a person can see "eleven tests failed and the phone dropped off USB twice" and
     * draw the conclusion themselves, which is a claim they can weigh rather than one made for them.
     */
    const incidents = await withTenant(orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT si.id, si.session_id, si.class, si.reason, si.detail, si.occurred_at,
                d.local_id AS device_local_id, d.model AS device_model
           FROM session_incidents si
           JOIN sessions s ON s.id = si.session_id
           LEFT JOIN devices d ON d.id = si.device_id
          WHERE s.run_id = $1
          ORDER BY si.occurred_at, si.id
          LIMIT 200`,
        [run.id],
      );
      return rows;
    });

    return {
      run: runJson(run),
      sessions: sessions.map((r: Record<string, unknown>) => ({
        id: r.id,
        state: r.state,
        region: r.region,
        device: r.device_local_id ?? r.device_model ?? null,
        createdAt: r.created_at,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        endReason: r.end_reason,
        build: r.app_build_id
          ? { id: r.app_build_id, packageName: r.package_name, versionName: r.version_name }
          : null,
        tests: {
          total: Number(r.total ?? 0),
          passed: Number(r.passed ?? 0),
          failed: Number(r.failed ?? 0),
          skipped: Number(r.skipped ?? 0),
        },
      })),
      failures: failures.map((f: Record<string, unknown>) => ({
        id: f.id,
        sessionId: f.session_id,
        name: f.name,
        failure: f.failure,
        // null means the suite did not classify, which is different from "the product's fault".
        failureClass: f.failure_class ?? null,
        failureReason: f.failure_reason ?? null,
        durationMs: f.duration_ms,
        reportedAt: f.reported_at,
      })),
      incidents: incidents.map((i: Record<string, unknown>) => ({
        id: i.id,
        sessionId: i.session_id,
        class: i.class,
        reason: i.reason,
        detail: i.detail,
        device: i.device_local_id ?? i.device_model ?? null,
        occurredAt: i.occurred_at,
      })),
    };
  });

  /**
   * The execution timeline — what the FARM did during this run (migration 030).
   *
   * Separate from `GET /runs/:id` rather than folded into it, because the two answer different
   * questions and have very different sizes. The detail view is a summary somebody opens for every
   * run; the timeline can be hundreds of rows and is opened for the one run that went wrong.
   * Returning it inline would make every run page pay for the rare case.
   *
   * Resolves by uuid OR by the name the suite chose, exactly as `GET /runs/:id` does — a CI job
   * that passed `mfarm:runId: '4471'` never saw a uuid, and asking it to find one to read its own
   * timeline would defeat the point of client-chosen names.
   */
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/runs/:id/timeline', async (req) => {
    const { orgId } = requireTenant(req);
    const key = req.params.id;

    const runId = await withTenant(orgId, async (c) => {
      if (UUID.test(key)) {
        const byId = await c.query<{ id: string }>('SELECT id FROM runs WHERE id = $1::uuid', [key]);
        if (byId.rows[0]) return byId.rows[0].id;
      }
      const byName = await c.query<{ id: string }>('SELECT id FROM runs WHERE external_id = $1', [key]);
      return byName.rows[0]?.id ?? null;
    });
    // RLS makes another org's run indistinguishable from one that never existed — which matters
    // more here than usual, because run names are guessable by construction.
    if (!runId) throw notFound('Run');

    // Bounded, and the cap is REPORTED rather than silently applied. A timeline that stops without
    // saying so reads as "nothing else happened", which is the one conclusion it must not invite
    // from a run somebody is debugging.
    const cap = Math.min(Math.max(Number(req.query.limit ?? 1000) || 1000, 1), 5000);
    const events = await timeline(orgId, runId, cap + 1);
    const truncated = events.length > cap;

    return {
      runId,
      truncated,
      events: events.slice(0, cap).map((e) => ({
        kind: e.kind,
        detail: e.detail,
        sessionId: e.sessionId,
        deviceId: e.deviceId,
        occurredAt: e.occurredAt,
      })),
    };
  });
}
