import Anthropic from '@anthropic-ai/sdk';
import type { Model } from './agent.ts';
import { ModelError, ModelUnavailableError } from './model-error.ts';
import {
  modelHalfOpen, modelUsable, providerHealth, recordModelFailure, recordModelOk, type ProviderSlot,
} from './health.ts';

/**
 * WHICH MODEL SERVICE AI RUNS TALK TO — provider-agnostic by configuration (ADR-0043 addendum).
 *
 *   MFARM_AI_API_KEY   the credential. Generic: it is whatever the chosen endpoint accepts.
 *   MFARM_AI_PROVIDER  the WIRE PROTOCOL, not the vendor: `anthropic` (Messages API, the default) or
 *                      `openai` (Chat Completions — OpenAI, Gemini's compat endpoint, OpenRouter,
 *                      Mistral, Groq, Together, Ollama, vLLM, LiteLLM all speak it).
 *   MFARM_AI_BASE_URL  optional; points either protocol at a gateway or a self-hosted server.
 *   MFARM_AI_MODEL     the model id that endpoint knows.
 *
 * ANTHROPIC_API_KEY / OPENAI_API_KEY are still read as fallbacks, so a farm configured before the
 * rename keeps working. The agent loop keeps speaking the Anthropic shape internally; the `openai`
 * adapter translates at this one boundary, so agent.ts and diagnose.ts never learn which it is.
 */

export type AiProvider = 'anthropic' | 'openai';
export const AI_PROVIDERS: readonly AiProvider[] = ['anthropic', 'openai'];

export interface AiProviderConfig {
  provider: AiProvider;
  apiKey: string;
  baseUrl: string | null;
}

type Env = Record<string, string | undefined>;

export function aiProviderOf(env: Env = process.env): AiProvider | null {
  const p = (env.MFARM_AI_PROVIDER ?? '').trim().toLowerCase() || 'anthropic';
  return (AI_PROVIDERS as readonly string[]).includes(p) ? p as AiProvider : null;
}

/** The key for the configured provider, generic name first. Empty string when there is none. */
export function aiApiKey(env: Env = process.env): string {
  const generic = (env.MFARM_AI_API_KEY ?? '').trim();
  if (generic) return generic;
  const provider = aiProviderOf(env);
  if (provider === 'openai') return (env.OPENAI_API_KEY ?? '').trim();
  if (provider === 'anthropic') return (env.ANTHROPIC_API_KEY ?? '').trim();
  return '';
}

export function aiProviderConfig(env: Env = process.env): AiProviderConfig | null {
  const provider = aiProviderOf(env);
  const apiKey = aiApiKey(env);
  if (!provider || !apiKey) return null;
  return { provider, apiKey, baseUrl: (env.MFARM_AI_BASE_URL ?? '').trim() || null };
}

/** The model id the primary provider is asked for — the one name config.ts and the runner share. */
export function aiModelId(env: Env = process.env): string {
  return (env.MFARM_AI_MODEL ?? '').trim() || 'claude-opus-5';
}

export function buildModel(cfg: AiProviderConfig, retry?: RetryPolicy): Model {
  return cfg.provider === 'openai' ? openaiModel(cfg, retry) : anthropicModel(cfg, retry);
}

// ---------------------------------------------------------------- the fallback provider (ADR-0044)

/**
 * A SECOND PROVIDER, used only while the first cannot serve. Optional; the same four meanings as the
 * primary's variables, under `MFARM_AI_FALLBACK_*`:
 *
 *   MFARM_AI_FALLBACK_API_KEY   its credential. Unset: there is no fallback.
 *   MFARM_AI_FALLBACK_PROVIDER  its wire protocol, `anthropic` (default) or `openai`.
 *   MFARM_AI_FALLBACK_BASE_URL  optional gateway or self-hosted endpoint.
 *   MFARM_AI_FALLBACK_MODEL     required for `openai`; defaults to claude-opus-5 for `anthropic`.
 *
 * A different VENDOR is the useful kind: a second key on the same provider shares its outage, and on
 * a free tier usually its allowance too.
 */
export interface AiSlotConfig extends AiProviderConfig {
  model: string;
}

export function aiFallbackConfig(env: Env = process.env): AiSlotConfig | null {
  const apiKey = (env.MFARM_AI_FALLBACK_API_KEY ?? '').trim();
  if (!apiKey) return null;
  const provider = (env.MFARM_AI_FALLBACK_PROVIDER ?? '').trim().toLowerCase() || 'anthropic';
  if (!(AI_PROVIDERS as readonly string[]).includes(provider)) return null;
  const model = (env.MFARM_AI_FALLBACK_MODEL ?? '').trim() || (provider === 'anthropic' ? 'claude-opus-5' : '');
  if (!model) return null;
  return { provider: provider as AiProvider, apiKey, baseUrl: (env.MFARM_AI_FALLBACK_BASE_URL ?? '').trim() || null, model };
}

/** One provider the farm may use: its place in the order, the model it is asked for, and how to call it. */
export interface ModelSlot {
  slot: ProviderSlot;
  model: string;
  /** "openai via api.groq.com qwen/qwen3.8-27b" — what an operator configured, in one line. */
  label: string;
  call: Model;
  /** The same provider with no retries — a probe must answer "is it back?" in one request. */
  probe: Model;
}

function slotOf(slot: ProviderSlot, cfg: AiProviderConfig, model: string): ModelSlot {
  const via = cfg.baseUrl ? ` via ${new URL(cfg.baseUrl).host}` : '';
  return { slot, model, label: `${cfg.provider}${via} ${model}`, call: buildModel(cfg), probe: buildModel(cfg, NO_RETRY) };
}

/** The providers this farm is configured with, primary first. Empty when AI is off. */
export function configuredSlots(env: Env = process.env): ModelSlot[] {
  const primary = aiProviderConfig(env);
  if (!primary) return [];
  const slots = [slotOf('primary', primary, aiModelId(env))];
  const fallback = aiFallbackConfig(env);
  if (fallback) slots.push(slotOf('fallback', fallback, fallback.model));
  return slots;
}

/**
 * THE MODEL THE AGENT AND DIAGNOSIS ACTUALLY CALL: the first provider that is usable, recording what
 * each call taught about it (health.ts). A provider known to be down or limited is skipped WITHOUT
 * being contacted; when none is usable, `ModelUnavailableError` says why and until when — at once,
 * rather than after the run has taken a device.
 *
 * The agent names the model it wants; each provider is asked for ITS OWN model instead, and every
 * step records the model that answered (agent.ts), so a run half-served by the fallback says so.
 */
export function resilientModel(slots: ModelSlot[]): Model {
  return async (params) => {
    for (const s of slots) {
      if (!modelUsable(s.slot)) continue;
      try {
        const message = await s.call({ ...params, model: s.model });
        recordModelOk(s.slot);
        return message;
      } catch (err) {
        // Null: the REQUEST's own fault (a schema, a size). Another provider would refuse it too, and
        // it says nothing about this one — so it is neither recorded nor retried elsewhere.
        if (!recordModelFailure(s.slot, err)) throw err;
      }
    }
    throw modelUnavailable(slots);
  };
}

/** Why no provider can serve, from the primary's side, and the earliest time one is worth trying. */
export function modelUnavailable(slots: ModelSlot[]): ModelUnavailableError {
  const primary = providerHealth('primary');
  const retryAt = slots.map((s) => providerHealth(s.slot).retryAt)
    .filter((t): t is number => t !== null).sort((a, b) => a - b)[0] ?? null;
  const parts = [primary.reason ?? 'The AI model is unavailable.'];
  const fallback = slots.find((s) => s.slot === 'fallback');
  if (fallback) {
    const fb = providerHealth('fallback');
    if (fb.reason) parts.push(`The fallback is unavailable too: ${fb.reason}`);
  }
  // Machine-readable on purpose: the console turns it into a clock time in the reader's zone.
  if (retryAt) parts.push(`It can be tried again at ${new Date(retryAt).toISOString()}.`);
  if (primary.detail) parts.push(`(${primary.detail.slice(0, 300)})`);
  return new ModelUnavailableError(parts.join(' '), retryAt);
}

const lastProbeAt = new Map<ProviderSlot, number>();
/** A half-open provider is probed at most this often, however many callers ask. */
export const PROBE_EVERY_MS = 30_000;

/**
 * GO / NO-GO FOR SOMETHING ABOUT TO TAKE A DEVICE. True at once for a provider that last worked (or
 * was never tried); for one only let back in by the clock, one tiny request decides — so a provider
 * that is still down costs a request, never a device. False when nothing can serve.
 */
export async function ensureModelReady(slots: ModelSlot[], now = Date.now()): Promise<boolean> {
  for (const s of slots) {
    if (!modelUsable(s.slot, now)) continue;
    if (!modelHalfOpen(s.slot, now)) return true;
    if ((lastProbeAt.get(s.slot) ?? -Infinity) > now - PROBE_EVERY_MS) continue;
    lastProbeAt.set(s.slot, now);
    try {
      await s.probe({ model: s.model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with OK.' }] });
      recordModelOk(s.slot, now);
      return true;
    } catch (err) {
      // A probe the provider ANSWERED with a request error still proves it is reachable.
      if (!recordModelFailure(s.slot, err, now)) {
        recordModelOk(s.slot, now);
        return true;
      }
    }
  }
  return false;
}

/** Tests only: forget when each slot was last probed. */
export function resetProbes(): void {
  lastProbeAt.clear();
}

// ---------------------------------------------------------------- anthropic

/** An SDK failure as a `ModelError`: its status, and the provider's own retry hint. */
function fromAnthropicError(err: unknown): ModelError {
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : null;
    const headers = err.headers as { get?(n: string): string | null } | undefined;
    const hint = headers?.get ? retryAfterMs({ headers: { get: (n) => headers.get!(n) } }, '') : null;
    return new ModelError(err.message, { status, retryAfterMs: hint, body: err.message });
  }
  return new ModelError((err as Error)?.message ?? String(err), { status: null });
}

function anthropicModel(cfg: AiProviderConfig, retry?: RetryPolicy): Model {
  const client = new Anthropic({
    apiKey: cfg.apiKey,
    ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
    // The SDK retries 429 and 5xx itself; a probe must not.
    ...(retry?.maxAttempts === 1 ? { maxRetries: 0 } : {}),
  });
  // Server-side refusal fallback is Anthropic's own feature; a compatible gateway may reject the beta.
  const create: Model = cfg.baseUrl
    ? (params) => client.beta.messages.create(params)
    : (params) => client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  return async (params) => {
    try {
      return await create(params);
    } catch (err) {
      throw fromAnthropicError(err);
    }
  };
}

// ---------------------------------------------------------------- openai-compatible

type Params = Parameters<Model>[0];
type Message = Awaited<ReturnType<Model>>;

type OaPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface OaResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: Array<{ id: string; type?: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

/**
 * Translate one Messages request to Chat Completions and back. Only what agent.ts and diagnose.ts
 * send is mapped: a system prompt, ONE user turn of text and base64 images, strict tools with a
 * single tool call per turn, and an optional JSON-schema output. Anthropic-only knobs (adaptive
 * thinking, effort, cache_control) have no portable equivalent and are dropped, not guessed at.
 * No token cap is sent: `max_tokens` vs `max_completion_tokens` differs by server, and the step cap
 * is what bounds a run's cost.
 */
export function toOpenAiRequest(params: Params): Record<string, unknown> {
  const system = typeof params.system === 'string'
    ? params.system
    : (params.system ?? []).map((b) => b.text).join('\n');
  const messages: Array<Record<string, unknown>> = system ? [{ role: 'system', content: system }] : [];
  for (const m of params.messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content;
    const parts: OaPart[] = [];
    for (const b of blocks) {
      if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image' && b.source.type === 'base64') {
        parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
      } else {
        throw new Error(`the openai provider cannot send a ${b.type} block`);
      }
    }
    messages.push({ role: m.role, content: parts });
  }

  const body: Record<string, unknown> = { model: params.model, messages };
  if (params.tools?.length) {
    body.tools = params.tools.map((t) => {
      if (!('input_schema' in t)) throw new Error('the openai provider supports only custom tools');
      return {
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema, ...(t.strict ? { strict: true } : {}) },
      };
    });
    body.tool_choice = 'auto';
    body.parallel_tool_calls = false;
  }
  const format = params.output_config?.format;
  if (format?.type === 'json_schema') {
    body.response_format = { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: format.schema } };
  }
  return body;
}

export function fromOpenAiResponse(r: OaResponse, model: string): Message {
  const choice = r.choices?.[0];
  const msg = choice?.message ?? {};
  const content: Array<Record<string, unknown>> = [];
  if (msg.content) content.push({ type: 'text', text: msg.content, citations: null });
  for (const call of msg.tool_calls ?? []) {
    let input: unknown = {};
    try { input = JSON.parse(call.function.arguments || '{}'); } catch { /* the turn reads as no action */ continue; }
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
  }
  const refused = Boolean(msg.refusal) || choice?.finish_reason === 'content_filter';
  const stop = refused ? 'refusal'
    : content.some((b) => b.type === 'tool_use') ? 'tool_use'
    : choice?.finish_reason === 'length' ? 'max_tokens'
    : 'end_turn';
  // Chat Completions counts cached tokens INSIDE prompt_tokens; Messages counts them apart.
  const cached = r.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    id: r.id ?? '',
    type: 'message',
    role: 'assistant',
    model: r.model ?? model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, (r.usage?.prompt_tokens ?? 0) - cached),
      output_tokens: r.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  } as unknown as Message;
}

/**
 * A 429 IS "SLOW DOWN", NOT "BROKEN". Free and low tiers (GitHub Models, Groq, Gemini free) answer
 * 429 on a per-minute cap several times a run; without a retry the run stopped as `model_error` on
 * its first busy minute and read as a product defect. The Anthropic SDK already retries these; this
 * gives the openai adapter the same manners.
 *
 * The waiting is BOUNDED BY THE DEVICE, not by patience: the runner's session has
 * `appium:newCommandTimeout: 300`, so a model call that waits too long loses the phone it was about
 * to drive. One wait is capped at `maxSingleWaitMs` and all waits at `maxTotalWaitMs`, well under
 * 300s. A server asking for longer than one wait (a daily cap says "come back in 6 hours") fails
 * now, with its number in the message, rather than holding a device for nothing.
 */
export interface RetryPolicy {
  baseMs: number;
  maxSingleWaitMs: number;
  maxTotalWaitMs: number;
  /** A hard stop on requests. Without it a zero-wait policy would re-send forever: 0 + 0 is never > 0. */
  maxAttempts?: number;
}
export const DEFAULT_RETRY: RetryPolicy = Object.freeze({ baseMs: 1_000, maxSingleWaitMs: 60_000, maxTotalWaitMs: 120_000 });
/** One request and its answer — what a probe needs. */
export const NO_RETRY: RetryPolicy = Object.freeze({ baseMs: 0, maxSingleWaitMs: 0, maxTotalWaitMs: 0, maxAttempts: 1 });

const RETRYABLE = (status: number) => status === 429 || status >= 500;

/** How long the server asked us to wait, in ms, or null when it did not say. */
export function retryAfterMs(res: { headers: { get(name: string): string | null } }, body: string, now = Date.now()): number | null {
  const h = res.headers.get('retry-after');
  if (h) {
    const secs = Number(h);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const at = Date.parse(h);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  // Gemini says it in the body: google.rpc.RetryInfo { "retryDelay": "37s" }.
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return m ? Number(m[1]) * 1000 : null;
}

function openaiModel(cfg: AiProviderConfig, retry: RetryPolicy = DEFAULT_RETRY): Model {
  const url = `${(cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`;
  const host = new URL(url).host;
  return async (params) => {
    const request = toOpenAiRequest(params);
    const body = JSON.stringify(request);
    let waited = 0;
    let regenerated = false;
    for (let attempt = 0; ; attempt++) {
      const last = attempt + 1 >= (retry.maxAttempts ?? Infinity);
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
          body,
          signal: AbortSignal.timeout(600_000),
        });
      } catch (err) {
        // No HTTP answer at all — DNS, a refused connection, the timeout. Retried like a 5xx, and said
        // as "did not answer" rather than surfacing as fetch's bare "fetch failed".
        const failure = `${host} did not answer: ${(err as Error).message}`;
        const wait = Math.min(retry.maxSingleWaitMs, retry.baseMs * 2 ** attempt);
        if (last || waited + wait > retry.maxTotalWaitMs) {
          throw new ModelError(`${failure} (after ${attempt + 1} attempt${attempt ? 's' : ''})`, { status: null });
        }
        waited += wait;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const text = await res.text();
      if (res.ok) return fromOpenAiResponse(JSON.parse(text) as OaResponse, params.model);
      const failure = `${res.status} from ${host}: ${text.slice(0, 300)}`;
      // A structured answer the server's own validator rejected (Groq: `json_validate_failed`). It is
      // the model's sampling, not the request: the same diagnosis parsed on 2 of 2 re-sends. Once.
      if (res.status === 400 && !regenerated && !last && request.response_format && /json_validate_failed/.test(text)) {
        regenerated = true;
        continue;
      }
      const asked = retryAfterMs(res, text);
      if (!RETRYABLE(res.status)) throw new ModelError(failure, { status: res.status, retryAfterMs: asked, body: text });
      if (asked !== null && asked > retry.maxSingleWaitMs) {
        throw new ModelError(`${failure} (the provider asked to wait ${Math.ceil(asked / 1000)}s — longer than a device can be held idle)`,
          { status: res.status, retryAfterMs: asked, body: text });
      }
      const wait = asked ?? Math.min(retry.maxSingleWaitMs, retry.baseMs * 2 ** attempt);
      if (last || waited + wait > retry.maxTotalWaitMs) {
        throw new ModelError(`${failure} (still refused after ${attempt + 1} attempts and ${Math.round(waited / 1000)}s of waiting)`,
          { status: res.status, retryAfterMs: asked, body: text });
      }
      waited += wait;
      await new Promise((r) => setTimeout(r, wait));
    }
  };
}
