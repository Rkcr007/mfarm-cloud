import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AGENT_TOOLS } from '../src/ai/agent.ts';
import { aiApiKey, aiProviderConfig, buildModel, fromOpenAiResponse, toOpenAiRequest } from '../src/ai/provider.ts';

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
