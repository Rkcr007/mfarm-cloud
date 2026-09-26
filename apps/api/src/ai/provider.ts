import Anthropic from '@anthropic-ai/sdk';
import type { Model } from './agent.ts';

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

export function buildModel(cfg: AiProviderConfig, retry?: RetryPolicy): Model {
  return cfg.provider === 'openai' ? openaiModel(cfg, retry) : anthropicModel(cfg);
}

// ---------------------------------------------------------------- anthropic

function anthropicModel(cfg: AiProviderConfig): Model {
  const client = new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
  // Server-side refusal fallback is Anthropic's own feature; a compatible gateway may reject the beta.
  if (cfg.baseUrl) return (params) => client.beta.messages.create(params);
  return (params) => client.beta.messages.create({
    ...params,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
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
}
export const DEFAULT_RETRY: RetryPolicy = Object.freeze({ baseMs: 1_000, maxSingleWaitMs: 60_000, maxTotalWaitMs: 120_000 });

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
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body,
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      if (res.ok) return fromOpenAiResponse(JSON.parse(text) as OaResponse, params.model);
      const failure = `${res.status} from ${host}: ${text.slice(0, 300)}`;
      // A structured answer the server's own validator rejected (Groq: `json_validate_failed`). It is
      // the model's sampling, not the request: the same diagnosis parsed on 2 of 2 re-sends. Once.
      if (res.status === 400 && !regenerated && request.response_format && /json_validate_failed/.test(text)) {
        regenerated = true;
        continue;
      }
      if (!RETRYABLE(res.status)) throw new Error(failure);
      const asked = retryAfterMs(res, text);
      if (asked !== null && asked > retry.maxSingleWaitMs) {
        throw new Error(`${failure} (the provider asked to wait ${Math.ceil(asked / 1000)}s — longer than a device can be held idle)`);
      }
      const wait = asked ?? Math.min(retry.maxSingleWaitMs, retry.baseMs * 2 ** attempt);
      if (waited + wait > retry.maxTotalWaitMs) {
        throw new Error(`${failure} (still refused after ${attempt + 1} attempts and ${Math.round(waited / 1000)}s of waiting)`);
      }
      waited += wait;
      await new Promise((r) => setTimeout(r, wait));
    }
  };
}
