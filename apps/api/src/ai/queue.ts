import { withTenant } from '../db.ts';
import { ApiError, conflict } from '../http/errors.ts';
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
      // Steps AND diagnoses: one budget, whichever part of the AI line spent it (C4, C8).
      `SELECT (SELECT COALESCE(sum(price_inr), 0) FROM ai_steps
                WHERE org_id = $1 AND created_at >= date_trunc('month', now()))
            + (SELECT COALESCE(sum(price_inr), 0) FROM ai_diagnoses
                WHERE org_id = $1 AND created_at >= date_trunc('month', now())) AS spent,
              (SELECT ai_monthly_budget_inr FROM orgs WHERE id = $1) AS budget`,
      [orgId],
    );
    return { spentInr: Number(rows[0]?.spent ?? 0), budgetInr: Number(rows[0]?.budget ?? 0) };
  });
}

/**
 * THE REGION A RUN THAT NAMED NONE WILL USE — found on hardware 2026-09-26.
 *
 * The hub requires a region (Model A: the customer chooses where their devices are). The AI doors
 * made it optional and passed the absence through, so a run queued without one was ACCEPTED and then
 * died at allocation with "A region is required". Worse, the console's Save sends a region only when
 * its picker is shown — which is only when the fleet has more than one — so on a one-region farm every
 * saved test, and every run-on-upload of it, could never run.
 *
 * Resolved at QUEUE time, per run, so a saved test with no region follows the fleet: the farm's
 * `MFARM_DEFAULT_REGION` (the hub's own default), else the one region this org's devices of that
 * platform are in. More than one and none chosen is the caller's decision to make, so it is refused
 * with the list rather than guessed at.
 */
export async function resolveRegion(orgId: string, platform: 'android' | 'ios', asked: string | null | undefined): Promise<string> {
  if (asked) return asked;
  const fallback = (process.env.MFARM_DEFAULT_REGION ?? '').trim() || null;
  const regions = fallback ? [] : await withTenant(orgId, async (c) => (await c.query<{ region: string }>(
    'SELECT DISTINCT region FROM devices WHERE platform = $1 ORDER BY region', [platform],
  )).rows.map((r) => r.region));
  return pickRegion(platform, asked, fallback, regions);
}

/** The decision itself, pure: what was asked, the farm's default, and the regions the org can see. */
export function pickRegion(platform: 'android' | 'ios', asked: string | null | undefined, fallback: string | null, regions: string[]): string {
  if (asked) return asked;
  if (fallback) return fallback;
  const os = platform === 'ios' ? 'iOS' : 'Android';
  if (regions.length === 1) return regions[0]!;
  if (regions.length === 0) throw new ApiError(400, 'no_region', `This farm has no ${os} devices, so there is nowhere to run this.`);
  throw new ApiError(400, 'region_required', `Choose a region: this farm has ${os} devices in ${regions.join(', ')}.`);
}

/** Queue one run. Throws `ai_budget_exhausted` (409) when the budget cannot pay for a single step. */
export async function queueAiRun(orgId: string, input: QueueInput): Promise<string> {
  const profile: AiProfile = isAiProfile(input.profile) ? input.profile : 'flash';
  const spec = AI_PROFILES[profile];
  const stepCap = Math.min(input.stepCap ?? spec.stepCap, spec.stepCap);
  const platform = input.platform ?? 'android';
  const region = await resolveRegion(orgId, platform, input.region);

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
      [orgId, input.createdBy ?? null, input.prompt.trim(), profile, platform,
       region, input.appRef ?? null, stepCap, input.aiTestId ?? null, input.trigger ?? 'manual'],
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
      return { queued, skipped: code === 'ai_budget_exhausted' ? 'budget' : code === 'region_required' || code === 'no_region' ? 'region' : 'error' };
    }
  }
  return { queued, skipped: null };
}
