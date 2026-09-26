import { withTenant } from '../db.ts';

/**
 * What an org has spent on AI this month, and what it may spend — ONE definition, read by every door
 * that queues a run, the runner before each step, the diagnosis route and the readiness check. Its
 * own module so that `readiness.ts` and `queue.ts` can both use it without importing each other.
 */
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
