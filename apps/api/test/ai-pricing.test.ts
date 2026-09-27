import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { callPriceInr, estimateInr, modelPrice, UNKNOWN_MODEL_PRICE } from '../src/ai/pricing.ts';
import { forModel, resilientModel, type ModelSlot } from '../src/ai/provider.ts';
import { resetProviderHealth } from '../src/ai/health.ts';

/**
 * WHAT AN AI CALL IS BILLED (ADR-0046 §6): its measured tokens × its model's list price × 3, up to the
 * paisa — and which model a call goes to. Every figure below is worked by hand, not asked of the code.
 */

const usage = (input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

test('a call is billed from what it used, at its model\'s list price, times three, up to the paisa', () => {
  // 3,000 in + 300 out on Haiku 4.5 ($1/$5): $0.0045 × 85 × 3 = ₹1.1475 → ₹1.15.
  assert.equal(callPriceInr('claude-haiku-4-5', usage(3000, 300), {}), 1.15);
  // The same call on Opus 5 ($5/$25): $0.0225 × 255 = ₹5.7375 → ₹5.74.
  assert.equal(callPriceInr('claude-opus-5', usage(3000, 300), {}), 5.74);
  // The farm's Groq model ($0.80/$4): 2,800 in + 120 out = $0.00272 × 255 = ₹0.6936 → ₹0.70.
  assert.equal(callPriceInr('qwen/qwen3.8-27b', usage(2800, 120), {}), 0.7);
  // Cached input is a tenth of the price on Claude.
  assert.equal(callPriceInr('claude-sonnet-5', usage(0, 0, 10_000), {}), 0.51, '10k cached × $0.20 = $0.002 × 255');
});

test('an exact amount is billed exactly — floating point does not add a paisa', () => {
  // 58,000 in on Haiku = $0.058 × 255 = ₹14.79 exactly — which floating point computes as
  // 14.790000000000003, and a plain ceil would bill ₹14.80.
  assert.equal(callPriceInr('claude-haiku-4-5', usage(58_000), {}), 14.79);
  assert.equal(callPriceInr('claude-haiku-4-5', usage(10_000), {}), 2.55);
});

test('a model is found by the longest id it starts with — a dated name, and Opus 5.5 is not Opus 5', () => {
  assert.equal(modelPrice('claude-opus-5-20260401', {}).price.input, 5);
  assert.equal(modelPrice('claude-opus-5-5', {}).price.input, 4, 'claude-opus-5-5 starts with claude-opus-5 too');
  assert.equal(modelPrice('claude-opus-50', {}).known, false, 'a prefix match needs a separator');
});

test('a model the table does not know is billed as a known one and said to be — never free', () => {
  const p = modelPrice('mistral-large-9', {});
  assert.equal(p.known, false);
  assert.deepEqual(p.price, UNKNOWN_MODEL_PRICE);
  assert.ok(callPriceInr('mistral-large-9', usage(3000, 300), {}) > 0);
});

test('MFARM_AI_PRICES names a model\'s price; malformed entries are ignored', () => {
  const env = { MFARM_AI_PRICES: 'mistral-large-9=2/6, junk, qwen/qwen3.8-27b=0.5/1/0.1' };
  assert.deepEqual(modelPrice('mistral-large-9', env), { price: { input: 2, output: 6, cacheRead: 2, cacheWrite: 0 }, known: true });
  assert.equal(modelPrice('qwen/qwen3.8-27b', env).price.cacheRead, 0.1, 'it overrides the table');
});

test('an estimate is never zero — a budget check against ₹0 would let anything through', () => {
  assert.equal(estimateInr('flash', 'free-model', { MFARM_AI_PRICES: 'free-model=0/0' }), 0.01);
  assert.equal(estimateInr('flash', 'claude-opus-5', {}), 5.74);
});

test('Haiku is not sent what it refuses: effort and adaptive thinking go, a JSON format stays', () => {
  const params = {
    model: 'claude-haiku-4-5', max_tokens: 400, messages: [{ role: 'user' as const, content: 'hi' }],
    thinking: { type: 'adaptive' as const },
    output_config: { effort: 'low' as const, format: { type: 'json_schema' as const, schema: { type: 'object' } } },
  } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming;
  const fitted = forModel(params) as unknown as Record<string, unknown>;
  assert.equal(fitted.thinking, undefined);
  assert.deepEqual(fitted.output_config, { format: { type: 'json_schema', schema: { type: 'object' } } });
  const opus = { ...params, model: 'claude-opus-5' } as Anthropic.Beta.MessageCreateParamsNonStreaming;
  assert.equal(forModel(opus), opus, 'every other model is sent the request as it was');
});

test('a call for the strong tier goes to the slot\'s strong model, and to its usual one when it has none', async () => {
  resetProviderHealth();
  const asked: string[] = [];
  const answer = async (p: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
    asked.push(p.model);
    return { model: p.model, content: [], usage: {} } as unknown as Anthropic.Beta.BetaMessage;
  };
  const slot = (strongModel: string | null): ModelSlot =>
    ({ slot: 'primary', model: 'claude-haiku-4-5', strongModel, label: 't', call: answer, probe: answer });
  const req = { model: 'x', max_tokens: 1, messages: [] } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming;
  await resilientModel([slot('claude-sonnet-5')])(req);
  await resilientModel([slot('claude-sonnet-5')])(req, { tier: 'strong' });
  await resilientModel([slot(null)])(req, { tier: 'strong' });
  assert.deepEqual(asked, ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
});
