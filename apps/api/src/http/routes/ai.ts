import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withTenant } from '../../db.ts';
import { loadConfig } from '../../config.ts';
import { requireTenant } from '../server.ts';
import { badRequest, conflict, forbidden, notFound, unavailable } from '../errors.ts';
import {
  AI_CURRENCY, AI_DIAGNOSE_PRICE_INR, AI_PROFILES, isAiProfile, type AiProfile,
} from '../../ai/pricing.ts';
import { aiConfigured, aiStepStore } from '../../ai/runner.ts';
import type { Model } from '../../ai/agent.ts';

/**
 * `/v1/ai` — AI runs: describe a test in English, a real device does it (ADR-0043, C2–C5).
 *
 * The console's "AI testing" section is built entirely on these, and so is anything a customer
 * scripts. A run is CREATED here and DRIVEN by the runner (`src/ai/runner.ts`); nothing here waits
 * on a device.
 */

/**
 * STARTING A RUN SPENDS THE ORG'S MONEY, so it takes a person or a `full` key.
 *
 * An `automation` key is refused for two reasons that are each sufficient. It is what sits in a CI
 * runner, and ADR-0034 made it the narrow credential. And it is what an AI run itself drives the hub
 * with (ADR-0043 §5), so accepting it here would let a run start runs.
 */
function requireSpender(req: FastifyRequest): { orgId: string; userId: string | null } {
  const { orgId } = requireTenant(req);
  const p = req.principal!;
  if (p.kind === 'tenant' && p.scope !== 'full') {
    throw forbidden('Starting an AI run spends from the monthly AI budget, which an `automation`-scope key '
      + 'cannot do. Use a `full` key, or start it from the console.');
  }
  return { orgId, userId: p.kind === 'user' ? p.userId : null };
}

interface RunRow {
  id: string; prompt: string; profile: string; platform: string; region: string | null;
  app_ref: string | null; step_cap: number; status: string; stop_reason: string | null;
  summary: string | null; evidence: string | null; model: string | null; session_id: string | null;
  run_id: string | null; steps: number; cost_inr: string; created_at: Date; started_at: Date | null;
  ended_at: Date | null; cancel_requested_at: Date | null; created_by_email: string | null;
}

const RUN_COLUMNS = `r.id, r.prompt, r.profile, r.platform, r.region, r.app_ref, r.step_cap, r.status,
  r.stop_reason, r.summary, r.evidence, r.model, r.session_id, r.run_id, r.steps, r.cost_inr,
  r.created_at, r.started_at, r.ended_at, r.cancel_requested_at, u.email AS created_by_email`;

function runJson(r: RunRow) {
  return {
    id: r.id,
    prompt: r.prompt,
    profile: r.profile,
    platform: r.platform,
    region: r.region,
    appRef: r.app_ref,
    stepCap: r.step_cap,
    status: r.status,
    stopReason: r.stop_reason,
    summary: r.summary,
    evidence: r.evidence,
    model: r.model,
    sessionId: r.session_id,
    runId: r.run_id,
    steps: r.steps,
    costInr: Number(r.cost_inr),
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    endedAt: r.ended_at?.toISOString() ?? null,
    cancelRequested: r.cancel_requested_at !== null,
    createdBy: r.created_by_email,
  };
}

async function spend(orgId: string): Promise<{ spentInr: number; budgetInr: number }> {
  return withTenant(orgId, async (c) => {
    const { rows } = await c.query<{ spent: string; budget: string }>(
      `SELECT (SELECT COALESCE(sum(price_inr), 0) FROM ai_steps
                WHERE org_id = $1 AND created_at >= date_trunc('month', now())) AS spent,
              (SELECT ai_monthly_budget_inr FROM orgs WHERE id = $1) AS budget`,
      [orgId],
    );
    return { spentInr: Number(rows[0]?.spent ?? 0), budgetInr: Number(rows[0]?.budget ?? 0) };
  });
}

export interface AiRouteOptions {
  /** Tests inject the model the runner uses, so "is AI configured" answers the same way. */
  aiModel?: Model;
}

export async function aiRoutes(app: FastifyInstance, opts: AiRouteOptions): Promise<void> {
  const cfg = loadConfig();
  const store = aiStepStore(cfg.artifactDir);
  const configured = () => aiConfigured({ model: opts.aiModel });

  /**
   * THE PRICE LIST, as the server bills it. The console renders this and never a literal, so the
   * quote and the meter are one number (`AI_PROFILES` in `ai/pricing.ts`).
   */
  app.get('/ai/pricing', async (req) => {
    const { orgId } = requireTenant(req);
    return {
      configured: configured(),
      currency: AI_CURRENCY,
      profiles: Object.fromEntries(Object.entries(AI_PROFILES).map(([k, v]) =>
        [k, { priceInr: v.priceInr, stepCap: v.stepCap }])),
      diagnosePriceInr: AI_DIAGNOSE_PRICE_INR,
      budget: await spend(orgId),
    };
  });

  app.post<{ Body: { prompt: string; profile?: string; platform?: string; region?: string; appId?: string; stepCap?: number } }>(
    '/ai/runs',
    {
      schema: {
        body: {
          type: 'object',
          required: ['prompt'],
          additionalProperties: false,
          properties: {
            prompt: { type: 'string', minLength: 1, maxLength: 4000 },
            profile: { type: 'string', enum: ['flash', 'pro'] },
            platform: { type: 'string', enum: ['android', 'ios'] },
            region: { type: 'string', minLength: 1, maxLength: 64 },
            appId: { type: 'string', minLength: 1, maxLength: 300 },
            stepCap: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      const { orgId, userId } = requireSpender(req);
      if (!configured()) {
        throw unavailable('AI runs are not configured on this farm (no model credential). Nothing was queued.');
      }
      const prompt = req.body.prompt.trim();
      if (!prompt) throw badRequest('The prompt is empty.');
      const profile: AiProfile = isAiProfile(req.body.profile) ? req.body.profile : 'flash';
      const spec = AI_PROFILES[profile];
      const stepCap = Math.min(req.body.stepCap ?? spec.stepCap, spec.stepCap);

      // Refused up front when the budget cannot pay for even one step. A run that would run out
      // part-way is allowed to start and stops cleanly at the step that would overspend.
      const { spentInr, budgetInr } = await spend(orgId);
      if (spentInr + spec.priceInr > budgetInr) {
        throw conflict('ai_budget_exhausted',
          `This organisation has spent ${AI_CURRENCY}${spentInr} of its ${AI_CURRENCY}${budgetInr} monthly AI budget. `
          + 'Raise the budget or wait for next month.');
      }

      const row = await withTenant(orgId, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO ai_runs (org_id, created_by, prompt, profile, platform, region, app_ref, step_cap)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [orgId, userId, prompt, profile, req.body.platform ?? 'android', req.body.region ?? null,
           req.body.appId ?? null, stepCap],
        );
        const r = await c.query<RunRow>(
          `SELECT ${RUN_COLUMNS} FROM ai_runs r LEFT JOIN users u ON u.id = r.created_by WHERE r.id = $1`,
          [rows[0]!.id],
        );
        return r.rows[0]!;
      });
      return reply.code(201).send({ aiRun: runJson(row) });
    },
  );

  app.get<{ Querystring: { limit?: number } }>(
    '/ai/runs',
    { schema: { querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } } } } },
    async (req) => {
      const { orgId } = requireTenant(req);
      const rows = await withTenant(orgId, async (c) => (await c.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM ai_runs r LEFT JOIN users u ON u.id = r.created_by
          WHERE r.org_id = $1 ORDER BY r.created_at DESC LIMIT $2`,
        [orgId, req.query.limit ?? 50],
      )).rows);
      return { aiRuns: rows.map(runJson) };
    },
  );

  app.get<{ Params: { id: string } }>('/ai/runs/:id', async (req) => {
    const { orgId } = requireTenant(req);
    const id = uuidParam(req.params.id);
    return withTenant(orgId, async (c) => {
      const run = (await c.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM ai_runs r LEFT JOIN users u ON u.id = r.created_by
          WHERE r.org_id = $1 AND r.id = $2`, [orgId, id],
      )).rows[0];
      if (!run) throw notFound('AI run');
      const steps = (await c.query<{
        n: number; phase: string; thought: string | null; action: unknown; result: string | null;
        screenshot_sha256: string | null; element_count: number | null; price_inr: string;
        input_tokens: number; output_tokens: number; started_at: Date; duration_ms: number;
      }>(
        `SELECT n, phase, thought, action, result, screenshot_sha256, element_count, price_inr,
                input_tokens, output_tokens, started_at, duration_ms
           FROM ai_steps WHERE org_id = $1 AND ai_run_id = $2 ORDER BY n`, [orgId, id],
      )).rows;
      return {
        aiRun: runJson(run),
        steps: steps.map((s) => ({
          n: s.n,
          phase: s.phase,
          thought: s.thought,
          action: s.action,
          result: s.result,
          screenshotUrl: s.screenshot_sha256 ? `/v1/ai/runs/${id}/steps/${s.n}/screenshot` : null,
          elementCount: s.element_count,
          priceInr: Number(s.price_inr),
          tokens: { input: s.input_tokens, output: s.output_tokens },
          startedAt: s.started_at.toISOString(),
          durationMs: s.duration_ms,
        })),
      };
    });
  });

  app.get<{ Params: { id: string; n: string } }>('/ai/runs/:id/steps/:n/screenshot', async (req, reply) => {
    const { orgId } = requireTenant(req);
    const id = uuidParam(req.params.id);
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1) throw notFound('Step');
    const sha = await withTenant(orgId, async (c) => (await c.query<{ screenshot_sha256: string | null }>(
      'SELECT screenshot_sha256 FROM ai_steps WHERE org_id = $1 AND ai_run_id = $2 AND n = $3', [orgId, id, n],
    )).rows[0]?.screenshot_sha256);
    if (!sha) throw notFound('Screenshot');
    const path = store.pathFor(sha);
    const st = await stat(path).catch(() => null);
    if (!st) throw notFound('Screenshot');
    return reply
      .type('image/png')
      .header('content-length', st.size)
      // Content-addressed and tenant-checked above: the bytes never change, the permission might.
      .header('cache-control', 'private, max-age=86400, immutable')
      .send(createReadStream(path));
  });

  /**
   * Cancel. A queued run ends now; a running one stops before its next step — the step in flight
   * finishes and is billed, because the model call has already been paid for.
   */
  app.post<{ Params: { id: string } }>('/ai/runs/:id/cancel', async (req) => {
    const { orgId } = requireTenant(req);
    const id = uuidParam(req.params.id);
    const row = await withTenant(orgId, async (c) => {
      const { rows } = await c.query<{ status: string }>(
        `UPDATE ai_runs SET
            status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
            ended_at = CASE WHEN status = 'queued' THEN now() ELSE ended_at END,
            stop_reason = CASE WHEN status = 'queued' THEN 'cancelled' ELSE stop_reason END,
            cancel_requested_at = COALESCE(cancel_requested_at, now())
          WHERE org_id = $1 AND id = $2 AND status IN ('queued', 'running')
          RETURNING status`, [orgId, id],
      );
      if (rows[0]) return rows[0];
      const exists = await c.query('SELECT status FROM ai_runs WHERE org_id = $1 AND id = $2', [orgId, id]);
      if (!exists.rows[0]) throw notFound('AI run');
      return exists.rows[0] as { status: string };
    });
    return { status: row.status };
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id is a 404 like an unknown one — never a Postgres cast error surfacing as a 500. */
function uuidParam(v: string): string {
  if (!UUID.test(v)) throw notFound('AI run');
  return v;
}
