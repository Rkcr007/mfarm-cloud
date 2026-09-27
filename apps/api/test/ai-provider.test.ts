import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AGENT_TOOLS } from '../src/ai/agent.ts';
import {
  aiParallelTools, resetLearnedToolLimits,
  aiApiKey, aiFallbackConfig, aiProviderConfig, buildModel, DEFAULT_RETRY, fromOpenAiResponse, NO_RETRY, outputCapFor,
  retryAfterMs, toOpenAiRequest, tooLargeOf,
} from '../src/ai/provider.ts';
import { ModelError, modelFailureWords } from '../src/ai/model-error.ts';

test('the generic key wins; the vendor names are fallbacks for their own protocol only', () => {
  assert.equal(aiApiKey({ MFARM_AI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }), 'g');
  assert.equal(aiApiKey({ ANTHROPIC_API_KEY: 'a' }), 'a');
  assert.equal(aiApiKey({ MFARM_AI_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'a' }), '');
  assert.equal(aiApiKey({ MFARM_AI_PROVIDER: 'openai', OPENAI_API_KEY: 'o' }), 'o');
  assert.equal(aiProviderConfig({ MFARM_AI_PROVIDER: 'gemini', MFARM_AI_API_KEY: 'k' }), null);
  assert.deepEqual(aiProviderConfig({ MFARM_AI_PROVIDER: 'OpenAI', MFARM_AI_API_KEY: 'k', MFARM_AI_BASE_URL: 'http://x/v1' }),
    { provider: 'openai', apiKey: 'k', baseUrl: 'http://x/v1' });
});

test('a Messages request becomes Chat Completions: system, images, strict tools, one call per turn', () => {
  const body = toOpenAiRequest({
    model: 'm', max_tokens: 100,
    system: [{ type: 'text', text: 'be a tester', cache_control: { type: 'ephemeral' } }],
    tools: AGENT_TOOLS, tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'TASK' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ] }],
  }) as { messages: unknown[]; tools: Array<{ function: { name: string; strict?: boolean } }>; parallel_tool_calls: boolean; thinking?: unknown };
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'be a tester' },
    { role: 'user', content: [{ type: 'text', text: 'TASK' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
  ]);
  assert.equal(body.tools.length, AGENT_TOOLS.length);
  assert.equal(body.tools[0]!.function.name, 'tap_element');
  assert.equal(body.tools[0]!.function.strict, true);
  assert.equal(body.parallel_tool_calls, false);
  // The agent lets one call name several actions (ADR-0046); the flag carries across as it was set.
  const batched = toOpenAiRequest({
    model: 'm', max_tokens: 100, tools: AGENT_TOOLS, tool_choice: { type: 'auto', disable_parallel_tool_use: false },
    messages: [{ role: 'user', content: 'TASK' }],
  }) as { parallel_tool_calls: boolean };
  assert.equal(batched.parallel_tool_calls, true);
  assert.equal(body.thinking, undefined);
});

test('a Chat Completions answer reads back as a tool_use turn, with cached tokens counted apart', () => {
  const m = fromOpenAiResponse({
    choices: [{ finish_reason: 'tool_calls', message: { content: 'tapping login', tool_calls: [
      { id: 'c1', function: { name: 'tap_element', arguments: '{"index":3,"why":"login"}' } },
    ] } }],
    usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 400 } },
  }, 'm');
  assert.equal(m.stop_reason, 'tool_use');
  assert.deepEqual(m.content.map((b) => b.type), ['text', 'tool_use']);
  assert.deepEqual((m.content[1] as { input: unknown }).input, { index: 3, why: 'login' });
  assert.deepEqual(
    [m.usage.input_tokens, m.usage.output_tokens, m.usage.cache_read_input_tokens],
    [600, 50, 400],
  );
  assert.equal(fromOpenAiResponse({ choices: [{ message: { refusal: 'no' } }] }, 'm').stop_reason, 'refusal');
});

test('the openai provider really posts to <base>/chat/completions with the key as a bearer token', async () => {
  let seen: { url?: string; auth?: string; body?: { model: string } } = {};
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"verdict":"unknown"}' } }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { port } = srv.address() as AddressInfo;
    const model = buildModel({ provider: 'openai', apiKey: 'sk-test', baseUrl: `http://127.0.0.1:${port}/v1/` });
    const m = await model({ model: 'gemini-x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(seen.url, '/v1/chat/completions');
    assert.equal(seen.auth, 'Bearer sk-test');
    assert.equal(seen.body?.model, 'gemini-x');
    assert.equal(m.stop_reason, 'end_turn');
    assert.deepEqual(m.content.map((b) => b.type), ['text']);
  } finally {
    srv.close();
  }
});

/** A chat-completions server that answers from a script: one [status, headers, body] per request. */
async function scripted(replies: Array<[number, Record<string, string>, string]>) {
  let hits = 0;
  const srv = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const [status, headers, body] = replies[Math.min(hits, replies.length - 1)];
      hits++;
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, hits: () => hits, close: () => srv.close() };
}

const OK: [number, Record<string, string>, string] =
  [200, {}, JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] })];
const FAST = { baseMs: 5, maxSingleWaitMs: 200, maxTotalWaitMs: 400 };
const ask = { model: 'm', max_tokens: 10, messages: [{ role: 'user' as const, content: 'hi' }] };

test('a 429 is waited out, not reported as a broken model — Retry-After first, then backoff', async () => {
  const s = await scripted([[429, { 'retry-after': '0' }, '{}'], [429, {}, '{}'], [503, {}, '{}'], OK]);
  try {
    const model = buildModel({ provider: 'openai', apiKey: 'k', baseUrl: s.baseUrl }, FAST);
    const m = await model(ask);
    assert.equal(m.stop_reason, 'end_turn');
    assert.equal(s.hits(), 4);
  } finally { s.close(); }
});

test('a daily cap ("come back in an hour") fails at once instead of holding the device', async () => {
  const s = await scripted([[429, { 'retry-after': '3600' }, '{"error":"daily limit"}'], OK]);
  try {
    const model = buildModel({ provider: 'openai', apiKey: 'k', baseUrl: s.baseUrl }, FAST);
    await assert.rejects(model(ask), /429 .*daily limit.*asked to wait 3600s/);
    assert.equal(s.hits(), 1);
  } finally { s.close(); }
});

test('a provider that keeps refusing is given up on inside the total budget', async () => {
  const s = await scripted([[503, {}, 'busy']]);
  try {
    const model = buildModel({ provider: 'openai', apiKey: 'k', baseUrl: s.baseUrl }, FAST);
    const t0 = Date.now();
    await assert.rejects(model(ask), /503 .*busy.*still refused after \d+ attempts/);
    assert.ok(Date.now() - t0 < 2_000);
    assert.ok(s.hits() > 1);
  } finally { s.close(); }
});

test('a client error is not retried — a bad request stays bad', async () => {
  const s = await scripted([[400, {}, '{"error":"bad schema"}'], OK]);
  try {
    const model = buildModel({ provider: 'openai', apiKey: 'k', baseUrl: s.baseUrl }, FAST);
    await assert.rejects(model(ask), /400 .*bad schema/);
    assert.equal(s.hits(), 1);
  } finally { s.close(); }
});

test('a structured answer the server failed to validate is asked for once more — and only once', async () => {
  const invalid: [number, Record<string, string>, string] =
    [400, {}, '{"error":{"message":"Failed to generate JSON.","code":"json_validate_failed"}}'];
  const schema = { output_config: { format: { type: 'json_schema' as const, schema: { type: 'object' } } } };
  const s = await scripted([invalid, OK]);
  try {
    const model = buildModel({ provider: 'openai', apiKey: 'k', baseUrl: s.baseUrl }, FAST);
    assert.equal((await model({ ...ask, ...schema } as never)).stop_reason, 'end_turn');
    assert.equal(s.hits(), 2);
  } finally { s.close(); }

  const twice = await scripted([invalid, invalid, OK]);
  try {
    const model = buildModel({ provider: 'openai', apiKey: 'k', baseUrl: twice.baseUrl }, FAST);
    await assert.rejects(model({ ...ask, ...schema } as never), /400 .*json_validate_failed/);
    assert.equal(twice.hits(), 2, 'a second identical refusal is the answer');
  } finally { twice.close(); }

  const plain = await scripted([invalid, OK]);
  try {
    const model = buildModel({ provider: 'openai', apiKey: 'k', baseUrl: plain.baseUrl }, FAST);
    await assert.rejects(model(ask), /400/, 'without a schema it is an ordinary bad request');
    assert.equal(plain.hits(), 1);
  } finally { plain.close(); }
});

test('retry hints are read from a seconds header, a date header, and Gemini\'s RetryInfo body', () => {
  const hdr = (v: string | null) => ({ headers: { get: () => v } });
  assert.equal(retryAfterMs(hdr('7'), ''), 7_000);
  assert.equal(retryAfterMs(hdr(new Date(1_000_000 + 30_000).toUTCString()), '', 1_000_000), 30_000);
  assert.equal(retryAfterMs(hdr(null), '{"details":[{"retryDelay": "37s"}]}'), 37_000);
  assert.equal(retryAfterMs(hdr(null), '{}'), null);
});

test('the default retry budget stays under the runner\'s appium:newCommandTimeout of 300s', () => {
  // A model call that outwaits the session loses the phone it was about to drive (runner.ts).
  assert.ok(DEFAULT_RETRY.maxTotalWaitMs + DEFAULT_RETRY.maxSingleWaitMs < 300_000);
});

// ---------------------------------------------------------------- D54: refused for its size

/** Groq's words on 2026-09-27, for a request that sent no cap on its answer. */
const OTPM = (requested: number) => JSON.stringify({ error: {
  message: `Request too large for model \`qwen/qwen3.8-27b\` in organization \`org_test\` service tier \`on_demand\` on output tokens per minute (OTPM): Limit 1000, Requested ${requested}. The request's expected output tokens exceed the enforced limit; reduce max_tokens (or the request's expected output) and try again.`,
  type: 'tokens', code: 'rate_limit_exceeded' } });

/** A server with Groq's rule: an answer allowed more than 1,000 tokens is refused, not queued. */
async function groqLike() {
  const bodies: Array<{ max_completion_tokens?: number }> = [];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw) as { max_completion_tokens?: number };
      bodies.push(body);
      const cap = body.max_completion_tokens;
      res.writeHead(cap === undefined || cap > 1000 ? 429 : 200, { 'content-type': 'application/json' });
      res.end(cap === undefined || cap > 1000 ? OTPM(cap ?? 1748) : OK[2]);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, bodies, close: () => srv.close() };
}

test('an answer refused for its size is asked for again at once, capped at half the tier\'s limit — and stays capped', async () => {
  const s = await groqLike();
  try {
    // NO_RETRY: one attempt, no waiting. A smaller request is a new request, so even a probe learns it.
    const model = buildModel({ provider: 'openai', apiKey: 'k', baseUrl: s.baseUrl }, NO_RETRY);
    const big = { ...ask, max_tokens: 16000 };
    const t0 = Date.now();
    assert.equal((await model(big)).stop_reason, 'end_turn');
    assert.ok(Date.now() - t0 < 1_000, 'nothing was waited on');
    assert.deepEqual(s.bodies.map((b) => b.max_completion_tokens), [undefined, 500]);

    assert.equal((await model(big)).stop_reason, 'end_turn');
    assert.deepEqual(s.bodies.slice(2).map((b) => b.max_completion_tokens), [500], 'the next call starts capped: one request');

    await model({ ...ask, max_tokens: 8 });
    assert.equal(s.bodies.at(-1)!.max_completion_tokens, 8, 'a smaller ask than the cap is sent as asked — the probe');
  } finally { s.close(); }
});

test('the cap is learned per endpoint and model, never guessed for another', async () => {
  const a = await groqLike();
  const b = await groqLike();
  try {
    await buildModel({ provider: 'openai', apiKey: 'k', baseUrl: a.baseUrl }, NO_RETRY)({ ...ask, model: 'qwen' });
    await buildModel({ provider: 'openai', apiKey: 'k', baseUrl: b.baseUrl }, NO_RETRY)({ ...ask, model: 'qwen' });
    assert.equal(b.bodies[0]!.max_completion_tokens, undefined, 'another server was not told a limit it never set');
    await buildModel({ provider: 'openai', apiKey: 'k', baseUrl: a.baseUrl }, NO_RETRY)({ ...ask, model: 'other' });
    assert.equal(a.bodies.at(-2)!.max_completion_tokens, undefined, 'nor another model on the same server');
  } finally { a.close(); b.close(); }
});

test('MFARM_AI_MAX_OUTPUT_TOKENS caps the first request; nonsense is ignored', async () => {
  assert.equal(aiProviderConfig({ MFARM_AI_API_KEY: 'k', MFARM_AI_MAX_OUTPUT_TOKENS: '800' })!.maxOutputTokens, 800);
  for (const v of ['', 'abc', '0', '-5', '12.5']) {
    assert.equal(aiProviderConfig({ MFARM_AI_API_KEY: 'k', MFARM_AI_MAX_OUTPUT_TOKENS: v })!.maxOutputTokens, undefined, v);
  }
  assert.equal(aiFallbackConfig({ MFARM_AI_FALLBACK_API_KEY: 'k', MFARM_AI_FALLBACK_MAX_OUTPUT_TOKENS: '300' })!.maxOutputTokens, 300);
  const s = await groqLike();
  try {
    await buildModel({ provider: 'openai', apiKey: 'k', baseUrl: s.baseUrl, maxOutputTokens: 800 }, NO_RETRY)({ ...ask, max_tokens: 16000 });
    assert.deepEqual(s.bodies.map((b) => b.max_completion_tokens), [800]);
  } finally { s.close(); }
  assert.equal((toOpenAiRequest({ ...ask, max_tokens: 16000 }, 700) as { max_completion_tokens: number }).max_completion_tokens, 700);
  assert.equal((toOpenAiRequest({ ...ask, max_tokens: 16000 }) as { max_completion_tokens?: number }).max_completion_tokens, undefined,
    'no cap known: none sent — servers disagree on its name');
});

test('a request too large for its INPUT fails at once — no waiting, no re-send — and says so', async () => {
  const tpm = JSON.stringify({ error: { message: 'Request too large for model `m` on tokens per minute (TPM): Limit 7000, Requested 17500, please reduce your message size and try again.', code: 'rate_limit_exceeded' } });
  const s = await scripted([[429, {}, tpm], OK]);
  try {
    // FAST retries every 429; this one it must not.
    const model = buildModel({ provider: 'openai', apiKey: 'k', baseUrl: s.baseUrl }, FAST);
    const err = await model(ask).then(() => null, (e: unknown) => e as ModelError);
    assert.ok(err instanceof ModelError);
    assert.deepEqual(err.tooLarge, { limit: 7000, requested: 17500, output: false });
    assert.match(err.message, /no wait changes that/);
    assert.equal(s.hits(), 1);
    assert.match(modelFailureWords(err), /^The model provider refused the request as larger than this farm's key allows/);
    assert.match(modelFailureWords(new ModelError('503 from x', { status: 503 })), /^The model could not be reached/);
  } finally { s.close(); }
});

test('a size refusal is read from the provider\'s words once, and an ordinary 429 is not one', () => {
  assert.deepEqual(tooLargeOf(429, OTPM(1748)), { limit: 1000, requested: 1748, output: true });
  assert.equal(tooLargeOf(429, '{"error":{"message":"Rate limit reached for model on tokens per minute (TPM): Limit 7000, Used 6500, Requested 900. Please try again in 3.4s."}}'), null,
    'slow down, not too large');
  assert.equal(tooLargeOf(400, OTPM(1748)), null);
  assert.deepEqual(tooLargeOf(413, 'Request too large'), { limit: null, requested: null, output: false });
  assert.equal(outputCapFor(1000), 500);
  assert.equal(outputCapFor(60), 64, 'never a cap too small to hold a tool call');
});

// ---------------------------------------------------------------- D56: a tool call the server could not read


test('several actions an answer: on for anthropic, off for openai-compatible servers, unless set', () => {
  assert.equal(aiParallelTools({}), true);
  assert.equal(aiParallelTools({ MFARM_AI_PROVIDER: 'openai' }), false);
  assert.equal(aiParallelTools({ MFARM_AI_PROVIDER: 'openai', MFARM_AI_PARALLEL_TOOLS: 'true' }), true);
  assert.equal(aiParallelTools({ MFARM_AI_PARALLEL_TOOLS: 'false' }), false);
});

/** A server that answers from a list and keeps each request's body. */
async function recording(replies: Array<[number, string]>) {
  const bodies: Array<Record<string, unknown>> = [];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      const [status, body] = replies[Math.min(bodies.length - 1, replies.length - 1)]!;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, bodies, close: () => srv.close() };
}

// What Groq answered on the farm, 2026-09-27 — the tool call qwen wrote, and could not be read.
const TOOL_USE_FAILED: [number, string] = [400, JSON.stringify({ error: {
  message: "Failed to call a function. Please adjust your prompt. See 'failed_generation' for more details.",
  type: 'invalid_request_error', code: 'tool_use_failed',
  failed_generation: '<tool_call>\n<function=tap_element>\n<parameter=index>\n7\n</parameter',
} })];
const withTools = {
  ...ask, model: 'qwen/qwen3.8-27b',
  tools: [{ name: 'tap_element', description: 'tap', input_schema: { type: 'object', properties: {}, required: [] } }],
  tool_choice: { type: 'auto', disable_parallel_tool_use: false },
};

test('a tool call the server could not read is asked for again, with one tool an answer — and that is remembered', async () => {
  resetLearnedToolLimits();
  const s = await recording([TOOL_USE_FAILED, [200, OK[2]]]);
  try {
    const model = buildModel({ provider: 'openai', apiKey: 'k', baseUrl: s.baseUrl }, FAST);
    assert.equal((await model(withTools as never)).stop_reason, 'end_turn');
    assert.deepEqual(s.bodies.map((b) => b.parallel_tool_calls), [true, false]);
    // The next call to this model does not have to fail first to find out.
    await model(withTools as never);
    assert.equal(s.bodies[2]!.parallel_tool_calls, false);
  } finally { s.close(); }
});

test('a model that keeps writing unreadable tool calls fails after two more tries, not forever', async () => {
  resetLearnedToolLimits();
  const s = await recording([TOOL_USE_FAILED]);
  try {
    const model = buildModel({ provider: 'openai', apiKey: 'k', baseUrl: s.baseUrl }, FAST);
    await assert.rejects(model(withTools as never), /400 .*tool_use_failed/);
    assert.equal(s.bodies.length, 3);
  } finally { s.close(); }
});
