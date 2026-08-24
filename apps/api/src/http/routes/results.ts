import type { FastifyInstance } from 'fastify';
import { ALL_FAILURE_REASONS, classifyReason } from '@mfarm/protocol';
import { withTenant } from '../../db.ts';
import { requireTenant } from '../server.ts';
import { badRequest, notFound } from '../errors.ts';

/**
 * What the SUITE says happened — the only source of pass and fail there is.
 *
 * WebDriver has no concept of an assertion. The hub watches a session open, drive a device and
 * close, and those look identical whether every test passed or every one failed. So this endpoint is
 * not a convenience over something the farm could work out for itself; it is the entire mechanism,
 * and a session that never calls it has an UNKNOWN outcome rather than a passing one.
 *
 * The shape is chosen to survive contact with a real `afterEach`, which is where it has to live:
 * one test per call, no batching, no session bookkeeping, nothing to clean up if the suite dies.
 * A batching endpoint would be cheaper per test and would lose every result of a crashed run,
 * which is the run whose results matter most.
 */

/** Long enough for a real stack, short enough that one test cannot post a novel. */
const MAX_FAILURE_CHARS = 10_000;

/**
 * Truncate rather than reject.
 *
 * A stack over the limit is the caller's most valuable payload arriving slightly too big; refusing
 * it would cost them the result entirely, and the result is the thing this endpoint exists for. The
 * cut is MARKED, because a stack that silently stops is one somebody will debug as if it were
 * complete.
 */
function boundFailure(failure: string | undefined): string | null {
  if (failure === undefined) return null;
  const text = failure.trim();
  if (text === '') return null;
  if (text.length <= MAX_FAILURE_CHARS) return text;
  const kept = text.slice(0, MAX_FAILURE_CHARS);
  return `${kept}\n… truncated by mfarm at ${MAX_FAILURE_CHARS} characters (${text.length} sent).`;
}

interface ResultBody {
  status: 'passed' | 'failed' | 'skipped';
  name: string;
  failure?: string;
  durationMs?: number;
  /**
   * WHY the test failed, in the taxonomy of spec §18 — `assertion-failure`, `application-crash`,
   * and the infrastructure and device-health reasons a sufficiently aware suite can recognise.
   *
   * OPTIONAL, and its absence means UNCLASSIFIED rather than "the product's fault". Defaulting it
   * would manufacture on the caller's behalf exactly the claim this taxonomy exists to stop being
   * manufactured — and would make every suite written before §18 retroactively assert something it
   * never said.
   *
   * The CLASS is not accepted. It is derived from the reason, because the two must agree and only
   * one of them can be wrong.
   */
  failureReason?: string;
}

interface ResultRow {
  id: string;
  session_id: string;
  name: string;
  status: string;
  failure: string | null;
  failure_class: string | null;
  failure_reason: string | null;
  duration_ms: number | null;
  reported_at: Date;
}

const resultJson = (r: ResultRow) => ({
  id: r.id,
  sessionId: r.session_id,
  name: r.name,
  status: r.status,
  failure: r.failure,
  failureClass: r.failure_class,
  failureReason: r.failure_reason,
  durationMs: r.duration_ms,
  reportedAt: r.reported_at,
});

export async function resultRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/sessions/:id/result — one test's outcome.
   *
   * ACCEPTED FOR A SESSION IN ANY STATE, including one that has already ended, and that is a
   * deliberate loosening rather than an oversight. An `afterEach` normally runs while the session is
   * live, but a suite that reports in an `after` hook, or a CI job that posts its results after
   * quitting, is doing something reasonable — and the case where the session ended UNEXPECTEDLY is
   * exactly the case whose result is most worth having. Refusing it would drop data precisely when
   * a test crashed, which is the opposite of what this table is for.
   *
   * What is NOT loosened is whose session it is: RLS scopes the lookup, so another org's session is
   * indistinguishable from one that never existed, and `org_id` is taken from the session row
   * rather than from the caller (architecture rule 4).
   */
  app.post<{ Params: { id: string }; Body: ResultBody }>(
    '/sessions/:id/result',
    {
      schema: {
        body: {
          type: 'object',
          required: ['status', 'name'],
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
            name: { type: 'string', minLength: 1, maxLength: 500 },
            // Not length-capped here on purpose — the handler truncates instead, so an oversized
            // stack costs the caller nothing. A `maxLength` would turn it into a 400 and lose the
            // result. See `boundFailure`.
            failure: { type: 'string' },
            durationMs: { type: 'integer', minimum: 0 },
            // Enumerated in the schema so an unknown reason is a 400 naming the valid set, rather
            // than a CHECK violation surfacing as a 500. The list lives in `packages/protocol` so
            // the constraint, this schema and the console cannot drift apart.
            failureReason: { type: 'string', enum: [...ALL_FAILURE_REASONS] },
          },
        },
      },
    },
    async (req, reply) => {
      const { orgId } = requireTenant(req);
      const sessionId = req.params.id;
      const { status, name, failureReason } = req.body;

      /**
       * Only a failed test has a failure to classify.
       *
       * Refused rather than ignored. A suite sending `status: 'passed'` with a reason attached has a
       * bug in its reporting hook, and silently dropping half of a contradictory pair would let that
       * bug live forever while quietly skewing every count built on the column. The database has the
       * same constraint; this is the version that says so in words the caller can act on.
       */
      if (failureReason !== undefined && status !== 'failed') {
        throw badRequest(
          `failureReason is only meaningful on a failed test; this one is "${status}".`,
        );
      }
      // Derived, never accepted — see ResultBody. `classifyReason` is total over the schema's enum,
      // so this cannot be undefined here, but the fallback keeps that from being a silent assumption.
      const failureClass = failureReason === undefined ? null : classifyReason(failureReason) ?? null;

      const row = await withTenant(orgId, async (c) => {
        // The org comes from the SESSION, and the INSERT ... SELECT is what ties them together in
        // one statement: there is no window in which a caller could name a session it does not own
        // and have the row written under an org it does.
        const { rows } = await c.query<ResultRow>(
          `INSERT INTO test_results
             (org_id, session_id, name, status, failure, duration_ms, failure_class, failure_reason)
           SELECT s.org_id, s.id, $2, $3, $4, $5, $6, $7 FROM sessions s WHERE s.id = $1
           RETURNING *`,
          [sessionId, name.trim(), status, boundFailure(req.body.failure), req.body.durationMs ?? null,
           failureClass, failureReason ?? null],
        );
        return rows[0] ?? null;
      });

      if (!row) throw notFound('Session');
      return reply.code(201).send({ result: resultJson(row) });
    },
  );

  /** GET /v1/sessions/:id/results — everything this session reported, in the order it reported it. */
  app.get<{ Params: { id: string } }>('/sessions/:id/results', async (req) => {
    const { orgId } = requireTenant(req);
    const rows = await withTenant(orgId, async (c) => {
      const r = await c.query<ResultRow>(
        'SELECT * FROM test_results WHERE session_id = $1 ORDER BY reported_at, id',
        [req.params.id],
      );
      return r.rows;
    });
    return { results: rows.map(resultJson) };
  });
}
