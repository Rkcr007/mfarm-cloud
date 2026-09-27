/**
 * WHAT AN AI CALL COSTS THE CUSTOMER — THE ONE DEFINITION (ADR-0043 C4, repriced by ADR-0046 §6).
 *
 * MFARM pays the model provider and bills the customer (owner decision, 2026-09-24). Until 2026-09-27
 * every model call was a flat ₹4 (Flash) or ₹9 (Pro), derived from `claude-opus-5` list prices and
 * never recalibrated — on a farm whose model cost a fraction of that. The owner then chose "pay for AI
 * only when AI works" (ADR-0046 §6): **a call is billed from the tokens it actually used**, at its
 * model's list price, times `AI_MARGIN`, rounded up to the paisa. A step the loop takes by rule, and
 * every action after the first in one call, is not a call and costs nothing.
 *
 * The console reads the ESTIMATES below through `GET /v1/ai/pricing` and never restates them. What is
 * billed is always the measured price in `ai_steps.price_inr`, written when the step ran, so a later
 * change here never re-prices history.
 */

export type AiProfile = 'flash' | 'pro';

export interface ProfileSpec {
  /** A run stops, inconclusive, before making more model calls than this. */
  stepCap: number;
  /** `output_config.effort` — how hard the model thinks per call. */
  effort: 'low' | 'medium' | 'high';
}

export const AI_PROFILES: Readonly<Record<AiProfile, ProfileSpec>> = Object.freeze({
  flash: Object.freeze({ stepCap: 40, effort: 'low' }),
  pro: Object.freeze({ stepCap: 80, effort: 'high' }),
});

/** What a new org may spend on AI in a calendar month before runs are refused. */
export const DEFAULT_AI_MONTHLY_BUDGET_INR = 2000;

export const AI_CURRENCY = '₹';

/** The rate a dollar price is converted at. */
export const INR_PER_USD = 85;

/** What MFARM charges over what the provider charges it (ADR-0046 §6). */
export const AI_MARGIN = 3;

/** A model's list price, in US dollars per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const claude = (input: number, output: number, cacheRead = input / 10): ModelPrice =>
  ({ input, output, cacheRead, cacheWrite: input * 1.25 });

/**
 * LIST PRICES, by model id (checked 2026-09-27: Anthropic's model table; Groq's model docs). A model
 * is looked up by the longest id it STARTS with, because a provider may answer with a dated name
 * (`claude-opus-5-20260401`). A provider that does not discount cached input is priced as if it did
 * not: `cacheRead` equals `input`.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  'claude-haiku-4-5': claude(1, 5),
  'claude-sonnet-5': claude(2, 10),
  'claude-opus-5': claude(5, 25),
  'claude-opus-5-5': claude(4, 20, 0.2),
  'qwen/qwen3.8-27b': { input: 0.8, output: 4, cacheRead: 0.8, cacheWrite: 0 },
});

/**
 * A model the table does not know is priced as this one, and said to be (`known: false`) — never as
 * free. An operator running a model this file has never heard of names its price in
 * `MFARM_AI_PRICES`: `model=input/output[/cacheRead]` in dollars per million tokens, comma-separated.
 */
export const UNKNOWN_MODEL_PRICE: ModelPrice = MODEL_PRICES['claude-sonnet-5']!;

type Env = Record<string, string | undefined>;

function configuredPrices(env: Env): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {};
  for (const entry of (env.MFARM_AI_PRICES ?? '').split(',')) {
    const m = /^\s*([^=\s]+)\s*=\s*([\d.]+)\s*\/\s*([\d.]+)(?:\s*\/\s*([\d.]+))?\s*$/.exec(entry);
    if (!m) continue;
    const [input, output] = [Number(m[2]), Number(m[3])];
    if (!(input >= 0 && output >= 0)) continue;
    const cacheRead = m[4] !== undefined ? Number(m[4]) : input;
    out[m[1]!] = { input, output, cacheRead, cacheWrite: 0 };
  }
  return out;
}

export function modelPrice(model: string, env: Env = process.env): { price: ModelPrice; known: boolean } {
  const table = { ...MODEL_PRICES, ...configuredPrices(env) };
  const id = model.trim();
  const match = Object.keys(table).filter((k) => id === k || id.startsWith(`${k}-`) || id.startsWith(`${k}@`))
    .sort((a, b) => b.length - a.length)[0];
  return match ? { price: table[match]!, known: true } : { price: UNKNOWN_MODEL_PRICE, known: false };
}

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }

/** Rupees for one model call, from what it used — list price × `AI_MARGIN`, rounded UP to the paisa. */
export function callPriceInr(model: string, usage: Usage, env: Env = process.env): number {
  const p = modelPrice(model, env).price;
  const usd = (usage.input * p.input + usage.output * p.output
    + usage.cacheRead * p.cacheRead + usage.cacheWrite * p.cacheWrite) / 1e6;
  // To the micro-rupee first: an exact ₹2.15 that floating point makes 215.00000000000003 paisa
  // must bill ₹2.15, not ₹2.16.
  return Math.ceil(Math.round(usd * INR_PER_USD * AI_MARGIN * 1e6) / 1e4) / 100;
}

/**
 * WHAT A CALL TYPICALLY USES, for the quote a person sees and for the budget checks that run BEFORE a
 * call (a call cannot be priced until it has answered). From the farm (2026-09-26, `ai_steps`):
 * ~2.4–3.4k input tokens a step with a full screenshot and 60–236 output tokens; phase 1b sends the
 * image less often, so these are deliberately on the high side.
 */
const TYPICAL: Readonly<Record<AiProfile | 'diagnose', Usage>> = Object.freeze({
  flash: { input: 3_000, output: 300, cacheRead: 0, cacheWrite: 0 },
  pro: { input: 4_000, output: 1_200, cacheRead: 0, cacheWrite: 0 },
  diagnose: { input: 10_000, output: 1_500, cacheRead: 0, cacheWrite: 0 },
});

/** About what one call of this kind costs on this model. Never zero: a budget check must mean something. */
export function estimateInr(kind: AiProfile | 'diagnose', model: string, env: Env = process.env): number {
  return Math.max(0.01, callPriceInr(model, TYPICAL[kind], env));
}

export function isAiProfile(v: unknown): v is AiProfile {
  return v === 'flash' || v === 'pro';
}
