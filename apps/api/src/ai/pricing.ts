/**
 * What an AI step costs the customer — THE ONE DEFINITION (ADR-0043, capability C4).
 *
 * MFARM pays the model provider and bills per step (owner decision, 2026-09-24). The console reads
 * these through `GET /v1/ai/pricing` and never restates them, so the price a customer is quoted and
 * the price they are metered cannot drift apart. `ai-runs.test.ts` pins that.
 *
 * FIRST CUT, DERIVED — NOT MEASURED. At `claude-opus-5` list prices ($5 in / $25 out per MTok, ₹85
 * to the dollar):
 *
 *   Flash, effort low:  ~4k fresh input (screenshot ~1.5k, element list ~1.5k, history ~1k) + ~300
 *                       output  ≈ $0.028 ≈ ₹2.4 a step           → ₹4
 *   Pro, effort high:   ~5k input + ~1.5k output (thinking)     ≈ $0.063 ≈ ₹5.3 a step → ₹9
 *   Diagnosis:          ~10k input + ~1.5k output               ≈ $0.088 ≈ ₹7.5        → ₹12
 *
 * Every step stores its real token counts (`ai_steps.input_tokens` …), so the first twenty real runs
 * on the farm replace these guesses with a number. Recalibrate HERE and nowhere else.
 */

export type AiProfile = 'flash' | 'pro';

export interface ProfileSpec {
  /** Rupees billed per model call in a run on this profile. */
  priceInr: number;
  /** A run stops, inconclusive, before taking more steps than this. */
  stepCap: number;
  /** `output_config.effort` — how hard the model thinks per step. */
  effort: 'low' | 'medium' | 'high';
}

export const AI_PROFILES: Readonly<Record<AiProfile, ProfileSpec>> = Object.freeze({
  flash: Object.freeze({ priceInr: 4, stepCap: 40, effort: 'low' }),
  pro: Object.freeze({ priceInr: 9, stepCap: 80, effort: 'high' }),
});

/** One diagnosis of a failed run (C8) is one larger model call. */
export const AI_DIAGNOSE_PRICE_INR = 12;

/** What a new org may spend on AI steps in a calendar month before runs are refused. */
export const DEFAULT_AI_MONTHLY_BUDGET_INR = 2000;

export const AI_CURRENCY = '₹';

export function isAiProfile(v: unknown): v is AiProfile {
  return v === 'flash' || v === 'pro';
}
