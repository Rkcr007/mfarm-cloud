import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withTenant } from '../../db.ts';
import { loadConfig } from '../../config.ts';
import { requireTenant } from '../server.ts';
import { badRequest, conflict, forbidden, notFound, unavailable } from '../errors.ts';
import { AI_CURRENCY, AI_DIAGNOSE_PRICE_INR, AI_PROFILES } from '../../ai/pricing.ts';
import { queueAiRun, spendThisMonth } from '../../ai/queue.ts';
import { aiConfigured, aiStepStore, anthropicModel } from '../../ai/runner.ts';
import { diagnoseSession, diagnosisJson, DIAGNOSIS_SELECT } from '../../ai/diagnose.ts';
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
  ai_test_id: string | null; trigger: string; test_name: string | null;
}

const RUN_COLUMNS = `r.id, r.prompt, r.profile, r.platform, r.region, r.app_ref, r.step_cap, r.status,
  r.stop_reason, r.summary, r.evidence, r.model, r.session_id, r.run_id, r.steps, r.cost_inr,
  r.created_at, r.started_at, r.ended_at, r.cancel_requested_at, u.email AS created_by_email,
  r.ai_test_id, r.trigger, (SELECT t.name FROM ai_tests t WHERE t.id = r.ai_test_id) AS test_name`;

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
    trigger: r.trigger,
    test: r.ai_test_id ? { id: r.ai_test_id, name: r.test_name } : null,
  };
}

async function readRun(orgId: string, id: string): Promise<RunRow> {
  return withTenant(orgId, async (c) => (await c.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM ai_runs r LEFT JOIN users u ON u.id = r.created_by WHERE r.org_id = $1 AND r.id = $2`,
    [orgId, id],
  )).rows[0]!);
}

export interface AiRouteOptions {
  /** Tests inject the model the runner uses, so "is AI configured" answers the same way. */
  aiModel?: Model;
  aiModelId?: string;
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
      budget: await spendThisMonth(orgId),
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
      const id = await queueAiRun(orgId, {
        prompt, profile: req.body.profile, platform: (req.body.platform as 'android' | 'ios') ?? 'android',
        region: req.body.region ?? null, appRef: req.body.appId ?? null, stepCap: req.body.stepCap,
        createdBy: userId,
      });
      const row = await readRun(orgId, id);
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
   * C8 — explain a failed session. One billed model call; kept, so asking again shows the answer
   * already paid for (`GET`) rather than buying a second one. `POST` always buys a fresh one — that is
   * what a person pressing "Explain again" after new evidence arrived is asking for.
   */
  app.post<{ Body: { sessionId: string } }>('/ai/diagnoses', {
    schema: {
      body: {
        type: 'object', required: ['sessionId'], additionalProperties: false,
        properties: { sessionId: { type: 'string', minLength: 36, maxLength: 36 } },
      },
    },
  }, async (req, reply) => {
    const { orgId, userId } = requireSpender(req);
    const sessionId = uuidParam(req.body.sessionId, 'Session');
    const model = opts.aiModel ?? (configured() ? anthropicModel() : undefined);
    const d = await diagnoseSession(orgId, sessionId, {
      model, modelId: opts.aiModelId ?? cfg.aiModel, artifactDir: cfg.artifactDir, createdBy: userId,
    });
    return reply.code(201).send({ diagnosis: d });
  });

  app.get<{ Querystring: { sessionId: string } }>('/ai/diagnoses', {
    schema: { querystring: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } } },
  }, async (req) => {
    const { orgId } = requireTenant(req);
    const sessionId = uuidParam(req.query.sessionId, 'Session');
    const rows = await withTenant(orgId, async (c) => (await c.query(
      `${DIAGNOSIS_SELECT} WHERE d.org_id = $1 AND d.session_id = $2 ORDER BY d.created_at DESC LIMIT 10`,
      [orgId, sessionId],
    )).rows);
    return { diagnoses: rows.map((r) => diagnosisJson(r as Parameters<typeof diagnosisJson>[0])) };
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

// ---------------------------------------------------------------- saved tests (C6, C7)

interface TestRow {
  id: string; name: string; prompt: string; profile: string; platform: string; region: string | null;
  app_package: string | null; run_on_upload: boolean; created_at: Date; updated_at: Date;
  created_by_email: string | null;
  recent: { id: string; status: string; at: string }[] | null;
}

function testJson(t: TestRow) {
  return {
    id: t.id, name: t.name, prompt: t.prompt, profile: t.profile, platform: t.platform,
    region: t.region, appPackage: t.app_package, runOnUpload: t.run_on_upload,
    createdAt: t.created_at.toISOString(), updatedAt: t.updated_at.toISOString(),
    createdBy: t.created_by_email,
    // Newest first — a saved test's history is the question "has this been passing?".
    recent: t.recent ?? [],
  };
}

const TEST_SELECT = `SELECT t.id, t.name, t.prompt, t.profile, t.platform, t.region, t.app_package, t.run_on_upload,
       t.created_at, t.updated_at, u.email AS created_by_email,
       (SELECT json_agg(json_build_object('id', r.id, 'status', r.status, 'at', r.created_at) ORDER BY r.created_at DESC)
          FROM (SELECT id, status, created_at FROM ai_runs WHERE ai_test_id = t.id
                 ORDER BY created_at DESC LIMIT 10) r) AS recent
  FROM ai_tests t LEFT JOIN users u ON u.id = t.created_by`;

const TEST_BODY = {
  name: { type: 'string', minLength: 1, maxLength: 120 },
  prompt: { type: 'string', minLength: 1, maxLength: 4000 },
  profile: { type: 'string', enum: ['flash', 'pro'] },
  platform: { type: 'string', enum: ['android', 'ios'] },
  region: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
  appPackage: { type: ['string', 'null'], minLength: 1, maxLength: 255 },
  runOnUpload: { type: 'boolean' },
} as const;

type TestBody = {
  name?: string; prompt?: string; profile?: string; platform?: string; region?: string | null;
  appPackage?: string | null; runOnUpload?: boolean;
};

/** Postgres' refusals, as the sentences a person can act on. */
function testWriteError(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505') throw conflict('ai_test_name_taken', 'A saved AI test already has that name.');
  if (e.constraint === 'ai_tests_upload_needs_package') {
    throw badRequest('Running on every upload needs the app package this test is about.');
  }
  throw err;
}

export async function aiTestRoutes(app: FastifyInstance, opts: AiRouteOptions): Promise<void> {
  const configured = () => aiConfigured({ model: opts.aiModel });

  app.get('/ai/tests', async (req) => {
    const { orgId } = requireTenant(req);
    const rows = await withTenant(orgId, async (c) => (await c.query<TestRow>(
      `${TEST_SELECT} WHERE t.org_id = $1 AND t.archived_at IS NULL ORDER BY lower(t.name)`, [orgId],
    )).rows);
    return { aiTests: rows.map(testJson) };
  });

  app.post<{ Body: TestBody }>('/ai/tests', {
    schema: { body: { type: 'object', required: ['name', 'prompt'], additionalProperties: false, properties: TEST_BODY } },
  }, async (req, reply) => {
    const { orgId, userId } = requireSpender(req);
    const b = req.body;
    const id = await withTenant(orgId, async (c) => (await c.query<{ id: string }>(
      `INSERT INTO ai_tests (org_id, created_by, name, prompt, profile, platform, region, app_package, run_on_upload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [orgId, userId, b.name!.trim(), b.prompt!.trim(), b.profile ?? 'flash', b.platform ?? 'android',
       b.region ?? null, b.appPackage?.trim() || null, b.runOnUpload ?? false],
    )).rows[0]!.id).catch(testWriteError);
    const row = await withTenant(orgId, async (c) =>
      (await c.query<TestRow>(`${TEST_SELECT} WHERE t.org_id = $1 AND t.id = $2`, [orgId, id])).rows[0]!);
    return reply.code(201).send({ aiTest: testJson(row) });
  });

  app.patch<{ Params: { id: string }; Body: TestBody }>('/ai/tests/:id', {
    schema: { body: { type: 'object', additionalProperties: false, properties: TEST_BODY } },
  }, async (req) => {
    const { orgId } = requireSpender(req);
    const id = uuidParam(req.params.id, 'AI test');
    const b = req.body;
    const sets: string[] = [];
    const vals: unknown[] = [orgId, id];
    const put = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.name !== undefined) put('name', b.name.trim());
    if (b.prompt !== undefined) put('prompt', b.prompt.trim());
    if (b.profile !== undefined) put('profile', b.profile);
    if (b.platform !== undefined) put('platform', b.platform);
    if (b.region !== undefined) put('region', b.region);
    if (b.appPackage !== undefined) put('app_package', b.appPackage?.trim() || null);
    if (b.runOnUpload !== undefined) put('run_on_upload', b.runOnUpload);
    if (sets.length === 0) throw badRequest('Nothing to change.');
    const row = await withTenant(orgId, async (c) => {
      const r = await c.query(
        `UPDATE ai_tests SET ${sets.join(', ')}, updated_at = now()
          WHERE org_id = $1 AND id = $2 AND archived_at IS NULL RETURNING id`, vals,
      ).catch(testWriteError);
      if (!r.rows[0]) throw notFound('AI test');
      return (await c.query<TestRow>(`${TEST_SELECT} WHERE t.org_id = $1 AND t.id = $2`, [orgId, id])).rows[0]!;
    });
    return { aiTest: testJson(row) };
  });

  /** Archive. Its runs keep pointing at it, so their history keeps its name. */
  app.post<{ Params: { id: string } }>('/ai/tests/:id/archive', async (req) => {
    const { orgId } = requireSpender(req);
    const id = uuidParam(req.params.id, 'AI test');
    const ok = await withTenant(orgId, async (c) => (await c.query(
      `UPDATE ai_tests SET archived_at = now(), run_on_upload = false, updated_at = now()
        WHERE org_id = $1 AND id = $2 AND archived_at IS NULL`, [orgId, id],
    )).rowCount);
    if (!ok) throw notFound('AI test');
    return { archived: true };
  });

  /** Run a saved test now. With no build given, the latest build of its package. */
  app.post<{ Params: { id: string }; Body: { appId?: string } | undefined }>('/ai/tests/:id/run', {
    schema: {
      body: { type: ['object', 'null'], additionalProperties: false, properties: { appId: { type: 'string', minLength: 1, maxLength: 300 } } },
    },
  }, async (req, reply) => {
    const { orgId, userId } = requireSpender(req);
    if (!configured()) throw unavailable('AI runs are not configured on this farm (no model credential). Nothing was queued.');
    const id = uuidParam(req.params.id, 'AI test');
    const t = await withTenant(orgId, async (c) => (await c.query<{
      prompt: string; profile: string; platform: 'android' | 'ios'; region: string | null; app_package: string | null;
    }>('SELECT prompt, profile, platform, region, app_package FROM ai_tests WHERE org_id = $1 AND id = $2 AND archived_at IS NULL',
      [orgId, id])).rows[0]);
    if (!t) throw notFound('AI test');
    const runId = await queueAiRun(orgId, {
      prompt: t.prompt, profile: t.profile, platform: t.platform, region: t.region,
      appRef: req.body?.appId ?? (t.app_package ? `${t.app_package}@latest` : null),
      createdBy: userId, aiTestId: id, trigger: 'test',
    });
    return reply.code(201).send({ aiRun: runJson(await readRun(orgId, runId)) });
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id is a 404 like an unknown one — never a Postgres cast error surfacing as a 500. */
function uuidParam(v: string, what = 'AI run'): string {
  if (!UUID.test(v)) throw notFound(what);
  return v;
}
