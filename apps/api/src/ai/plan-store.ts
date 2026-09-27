import { createHash } from 'node:crypto';
import { withTenant } from '../db.ts';
import { compilePlan, type PlanStep, type RecordedStep, type RunPlan } from './plan.ts';

/**
 * Where saved routes are kept (migration 065) — apart from `plan.ts`, which is pure, so the agent loop
 * that replays a route never imports the database.
 */

/**
 * SQL: whether a route exists for the run or test row aliased `alias` (its `ai_test_id` or `id`,
 * `prompt` and `platform`). Tasks are stored trimmed (queue.ts, the tests route), so hashing the stored
 * text in SQL gives what `promptSha` gives in JS — one definition of "this task's route" on both sides.
 */
export function hasRouteSql(alias: string, testIdColumn = 'ai_test_id'): string {
  return `EXISTS (SELECT 1 FROM ai_test_plans p WHERE p.ai_test_id = ${alias}.${testIdColumn}
            AND p.platform = ${alias}.platform
            AND p.prompt_sha256 = encode(sha256(convert_to(${alias}.prompt, 'UTF8')), 'hex'))`;
}

/** A plan belongs to the words it was written for: an edited test's old route is not replayed. */
export function promptSha(prompt: string): string {
  return createHash('sha256').update(prompt.trim()).digest('hex');
}

/** The newest route for this test, task and platform — or null, and the model drives from step one. */
export async function latestPlan(
  orgId: string, testId: string, prompt: string, platform: 'android' | 'ios',
): Promise<RunPlan | null> {
  return withTenant(orgId, async (c) => {
    const { rows } = await c.query<{ id: string; version: number; steps: PlanStep[]; expect: string }>(
      `SELECT id, version, steps, expect FROM ai_test_plans
        WHERE org_id = $1 AND ai_test_id = $2 AND platform = $3 AND prompt_sha256 = $4
        ORDER BY version DESC LIMIT 1`,
      [orgId, testId, platform, promptSha(prompt)],
    );
    return rows[0] ?? null;
  });
}

/**
 * After a run of a saved test passes: keep its route as the next version — unless it replayed an
 * existing one without the model (nothing new was learned), or it cannot be replayed for certain.
 * Returns the version written, or null.
 */
export async function keepRoute(
  orgId: string,
  run: { id: string; ai_test_id: string; prompt: string; platform: 'android' | 'ios' },
): Promise<number | null> {
  return withTenant(orgId, async (c) => {
    const steps = (await c.query<RecordedStep>(
      'SELECT action, result, model FROM ai_steps WHERE org_id = $1 AND ai_run_id = $2 ORDER BY n',
      [orgId, run.id],
    )).rows;
    const replayedOnly = steps.length > 0 && steps.every((s) => s.model === 'replay' || s.model === 'rule');
    if (replayedOnly) return null;
    const plan = compilePlan(steps);
    if (!plan) return null;
    const { rows } = await c.query<{ version: number }>(
      `INSERT INTO ai_test_plans (org_id, ai_test_id, version, prompt_sha256, platform, source_run_id, steps, expect)
       VALUES ($1, $2, (SELECT COALESCE(max(version), 0) + 1 FROM ai_test_plans WHERE ai_test_id = $2),
               $3, $4, $5, $6, $7)
       RETURNING version`,
      [orgId, run.ai_test_id, promptSha(run.prompt), run.platform, run.id, JSON.stringify(plan.steps), plan.expect.slice(0, 500)],
    );
    return rows[0]?.version ?? null;
  });
}
