import { withTenant } from '../db.ts';
import { conflict } from '../http/errors.ts';
import { AI_CURRENCY, AI_PROFILES, isAiProfile, type AiProfile } from './pricing.ts';

/**
 * PUTTING AN AI RUN IN THE QUEUE — the one writer, whoever asks (ADR-0043).
 *
 * Three doors lead here: a person pressing Run (`POST /v1/ai/runs`), a saved test's Run (C6), and a
 * build upload a saved test is listening for (C7). They must refuse the same way and write the same
 * row, so the budget check lives here and nowhere else — a door that skipped it would be a way to
 * queue runs the org cannot pay for.
 */

export interface QueueInput {
  prompt: string;
  profile?: string;
  platform?: 'android' | 'ios';
  region?: string | null;
  appRef?: string | null;
  stepCap?: number;
  createdBy?: string | null;
  aiTestId?: string | null;
  trigger?: 'manual' | 'test' | 'upload';
}

export async function spendThisMonth(orgId: string): Promise<{ spentInr: number; budgetInr: number }> {
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

/** Queue one run. Throws `ai_budget_exhausted` (409) when the budget cannot pay for a single step. */
export async function queueAiRun(orgId: string, input: QueueInput): Promise<string> {
  const profile: AiProfile = isAiProfile(input.profile) ? input.profile : 'flash';
  const spec = AI_PROFILES[profile];
  const stepCap = Math.min(input.stepCap ?? spec.stepCap, spec.stepCap);

  // Refused up front when the budget cannot pay for even one step. A run that would run out
  // part-way is allowed to start and stops cleanly at the step that would overspend.
  const { spentInr, budgetInr } = await spendThisMonth(orgId);
  if (spentInr + spec.priceInr > budgetInr) {
    throw conflict('ai_budget_exhausted',
      `This organisation has spent ${AI_CURRENCY}${spentInr} of its ${AI_CURRENCY}${budgetInr} monthly AI budget. `
      + 'Raise the budget or wait for next month.');
  }

  return withTenant(orgId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO ai_runs (org_id, created_by, prompt, profile, platform, region, app_ref, step_cap,
                            ai_test_id, trigger)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [orgId, input.createdBy ?? null, input.prompt.trim(), profile, input.platform ?? 'android',
       input.region ?? null, input.appRef ?? null, stepCap, input.aiTestId ?? null, input.trigger ?? 'manual'],
    );
    return rows[0]!.id;
  });
}

/**
 * C7 — a new build was uploaded; queue every saved test that listens for its package.
 *
 * BEST EFFORT BY DESIGN. The upload has already succeeded and is the customer's to keep; an AI
 * budget that ran out, or a farm with AI switched off, must never turn a good upload into an error.
 * What did and did not start is returned, so the upload's answer can say so.
 */
export async function queueUploadRuns(
  orgId: string,
  build: { id: string; packageName: string },
): Promise<{ queued: { aiRunId: string; testId: string; testName: string }[]; skipped: string | null }> {
  const tests = await withTenant(orgId, async (c) => (await c.query<{
    id: string; name: string; prompt: string; profile: string; platform: 'android' | 'ios'; region: string | null;
  }>(
    `SELECT id, name, prompt, profile, platform, region FROM ai_tests
      WHERE org_id = $1 AND run_on_upload AND archived_at IS NULL AND app_package = $2
      ORDER BY created_at`,
    [orgId, build.packageName],
  )).rows);

  const queued: { aiRunId: string; testId: string; testName: string }[] = [];
  for (const t of tests) {
    try {
      const aiRunId = await queueAiRun(orgId, {
        prompt: t.prompt, profile: t.profile, platform: t.platform, region: t.region,
        // The build that was just uploaded, by id — not `@latest`, which a second upload a moment
        // later would silently retarget.
        appRef: build.id, aiTestId: t.id, trigger: 'upload',
      });
      queued.push({ aiRunId, testId: t.id, testName: t.name });
    } catch (err) {
      const code = (err as { code?: string }).code;
      return { queued, skipped: code === 'ai_budget_exhausted' ? 'budget' : 'error' };
    }
  }
  return { queued, skipped: null };
}
