import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type Anthropic from '@anthropic-ai/sdk';
import {
  classifyModelFailure, COOL_DOWN_MS, modelHalfOpen, modelUsable, providerHealth, recordModelFailure,
  recordModelOk, resetProviderHealth,
} from '../src/ai/health.ts';
import { ModelError, ModelUnavailableError } from '../src/ai/model-error.ts';
import {
  buildModel, ensureModelReady, NO_RETRY, PROBE_EVERY_MS, resetProbes, resilientModel, type ModelSlot,
} from '../src/ai/provider.ts';
import { modelCheck } from '../src/ai/readiness.ts';
import type { Model } from '../src/ai/agent.ts';

/**
 * ADR-0044 without a database or a provider: how a failure is read, who serves while the primary
 * cannot, and when a provider that failed is let back in.
 */

beforeEach(() => { resetProviderHealth(); resetProbes(); });

const NOW = 1_800_000_000_000;
const e = (status: number | null, extra: Partial<{ retryAfterMs: number; body: string }> = {}) =>
  new ModelError(`${status} from api.test`, { status, ...extra });

test('a failure is read by its status and the provider\'s hint — never by guessing from prose', () => {
  const daily = classifyModelFailure(e(429, { retryAfterMs: 361_000, body: 'Limit 200000 on tokens per day (TPD)' }), NOW)!;
  assert.equal(daily.state, 'limited');
  assert.match(daily.reason!, /daily allowance/);
  assert.equal(daily.retryAt, NOW + 361_000, 'the wait the provider asked for');

  const perMinute = classifyModelFailure(e(429), NOW)!;
  assert.match(perMinute.reason!, /rate-limiting/);
  assert.equal(perMinute.retryAt, NOW + COOL_DOWN_MS.limited, 'no hint: the per-minute default');

  assert.match(classifyModelFailure(e(402), NOW)!.reason!, /no credit left/);
  assert.equal(classifyModelFailure(e(402), NOW)!.retryAt, NOW + COOL_DOWN_MS.account, 'a key problem needs a person first');
  assert.match(classifyModelFailure(e(401), NOW)!.reason!, /rejected/);
  assert.match(classifyModelFailure(e(404), NOW)!.reason!, /not available to this farm/);
  assert.match(classifyModelFailure(e(503), NOW)!.reason!, /failing \(HTTP 503\)/);
  assert.match(classifyModelFailure(e(null), NOW)!.reason!, /did not answer/);

  // The request's own fault says nothing about the provider, and must not stop every other run.
  assert.equal(classifyModelFailure(e(400), NOW), null);
  assert.equal(classifyModelFailure(e(413), NOW), null);
  assert.equal(classifyModelFailure(new Error('a bug of ours'), NOW), null);
});

test('a failed provider is left alone until its wait is over, then let back in half-open', () => {
  assert.equal(modelUsable('primary', NOW), true, 'never tried: usable');
  recordModelFailure('primary', e(429, { retryAfterMs: 60_000 }), NOW);
  assert.equal(modelUsable('primary', NOW + 59_000), false);
  assert.equal(modelUsable('primary', NOW + 60_000), true);
  assert.equal(modelHalfOpen('primary', NOW + 60_000), true, 'let in by the clock, not yet by a success');
  recordModelOk('primary', NOW + 61_000);
  assert.equal(modelHalfOpen('primary', NOW + 61_000), false);
  assert.equal(providerHealth('primary').state, 'ok');
});

// -------------------------------------------------------------------------- who serves

function answer(model: string): Anthropic.Beta.BetaMessage {
  return {
    id: 'm', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok', citations: null }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

function slot(name: 'primary' | 'fallback', behaviour: { fail?: ModelError | Error; calls: string[] }): ModelSlot {
  const call: Model = async (params) => {
    behaviour.calls.push(params.model);
    if (behaviour.fail) throw behaviour.fail;
    return answer(params.model);
  };
  return { slot: name, model: `${name}-model`, label: name, call, probe: call };
}

const ask = { model: 'what-the-agent-asked-for', max_tokens: 10, messages: [{ role: 'user' as const, content: 'hi' }] };

test('the primary serves while it can; when it is limited the fallback serves, asked for ITS OWN model', async () => {
  const p: { calls: string[]; fail?: ModelError } = { calls: [] };
  const f: { calls: string[]; fail?: ModelError } = { calls: [] };
  const model = resilientModel([slot('primary', p), slot('fallback', f)]);

  assert.equal((await model(ask)).model, 'primary-model');
  assert.equal(providerHealth('primary').state, 'ok');

  p.fail = e(429, { retryAfterMs: 3_600_000, body: 'tokens per day' });
  assert.equal((await model(ask)).model, 'fallback-model', 'the same call, served by the fallback');
  assert.deepEqual(f.calls, ['fallback-model']);

  // The primary is now known to be limited: the next call does not even try it.
  const before = p.calls.length;
  await model(ask);
  assert.equal(p.calls.length, before, 'a provider known to be down is skipped without being contacted');
});

test('when nothing can serve, it says why and until when — at once, without calling anyone', async () => {
  const p = { calls: [] as string[], fail: e(429, { retryAfterMs: 600_000, body: 'tokens per day (TPD)' }) as ModelError | undefined };
  const f = { calls: [] as string[], fail: e(402) as ModelError | undefined };
  const model = resilientModel([slot('primary', p), slot('fallback', f)]);
  await assert.rejects(model(ask), (err: ModelUnavailableError) => {
    assert.ok(err instanceof ModelUnavailableError);
    assert.match(err.message, /daily allowance/);
    assert.match(err.message, /The fallback is unavailable too: .*no credit left/);
    assert.match(err.message, /It can be tried again at \d{4}-\d\d-\d\dT/);
    return true;
  });
  const calls = p.calls.length + f.calls.length;
  await assert.rejects(model(ask), ModelUnavailableError);
  assert.equal(p.calls.length + f.calls.length, calls, 'the second refusal contacted nobody');
});

test('a request the provider refuses as malformed is not an outage: rethrown, not recorded, not re-sent elsewhere', async () => {
  const p = { calls: [] as string[], fail: e(400, { body: 'bad schema' }) as ModelError | undefined };
  const f = { calls: [] as string[] };
  const model = resilientModel([slot('primary', p), slot('fallback', f)]);
  await assert.rejects(model(ask), /400/);
  assert.equal(providerHealth('primary').state, 'unknown');
  assert.equal(f.calls.length, 0);
});

test('go / no-go before a device is taken: a half-open provider gets ONE tiny probe, at most every 30s', async () => {
  const p = { calls: [] as string[], fail: e(503) as ModelError | undefined };
  const s = slot('primary', p);
  assert.equal(await ensureModelReady([s], NOW), true, 'never failed: go, and no probe spent');
  assert.equal(p.calls.length, 0);

  recordModelFailure('primary', e(503), NOW);
  assert.equal(await ensureModelReady([s], NOW + 1_000), false, 'inside its wait: no-go, nothing sent');
  assert.equal(p.calls.length, 0);

  const open = NOW + COOL_DOWN_MS.down;
  assert.equal(await ensureModelReady([s], open), false, 'half-open, probed, still down');
  assert.equal(p.calls.length, 1);
  assert.equal(providerHealth('primary').retryAt, open + COOL_DOWN_MS.down, 'the failed probe moved the wait on');

  // Let back in again, but inside the probe interval: no second request.
  recordModelFailure('primary', e(503), open - COOL_DOWN_MS.down);
  assert.equal(await ensureModelReady([s], open + PROBE_EVERY_MS - 1), false);
  assert.equal(p.calls.length, 1, 'one probe per interval, however many ticks ask');

  p.fail = undefined;
  assert.equal(await ensureModelReady([s], open + PROBE_EVERY_MS), true, 'it answered: go');
  assert.equal(providerHealth('primary').state, 'ok');
});

test('readiness reads the same memory: go, served by the fallback, or no with the time it lifts', () => {
  const p = slot('primary', { calls: [] });
  const f = slot('fallback', { calls: [] });
  assert.equal(modelCheck({ slots: [p, f] }, NOW).ok, true);

  recordModelFailure('primary', e(429, { retryAfterMs: 600_000, body: 'per day' }), NOW);
  const onFallback = modelCheck({ slots: [p, f] }, NOW + 1);
  assert.equal(onFallback.ok, true);
  assert.match(onFallback.message, /fallback model \(fallback-model\)/);

  recordModelFailure('fallback', e(401), NOW);
  const none = modelCheck({ slots: [p, f] }, NOW + 1);
  assert.equal(none.ok, false);
  assert.match(none.message, /daily allowance.*The fallback is unavailable too/);
  assert.equal(none.retryAt, new Date(NOW + 600_000).toISOString(), 'the earliest of the two waits');

  assert.equal(modelCheck({ slots: [] }).ok, false, 'no key at all is a no');
  assert.equal(modelCheck({ slots: [], injected: true }).ok, true);
});

// -------------------------------------------------------------------------- the adapters' errors

async function serve(handler: (url: string) => [number, Record<string, string>, string]) {
  let hits = 0;
  const srv = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits++;
      const [status, headers, body] = handler(String(req.url));
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, hits: () => hits, close: () => srv.close() };
}

test('a probe with no hint to wait sends ONE request — a zero-wait policy used to loop for ever', async () => {
  const s = await serve(() => [429, {}, '{"error":"slow down"}']);
  try {
    const probe = buildModel({ provider: 'openai', apiKey: 'k', baseUrl: `${s.url}/v1` }, NO_RETRY);
    await assert.rejects(probe(ask), (err: ModelError) => err instanceof ModelError && err.status === 429);
    assert.equal(s.hits(), 1);
  } finally { s.close(); }
});

test('an unreachable provider is a ModelError with no status — "did not answer", not fetch\'s "fetch failed"', async () => {
  const s = await serve(() => [200, {}, '{}']);
  const url = `${s.url}/v1`;
  s.close();
  await new Promise((r) => setTimeout(r, 50));
  const model = buildModel({ provider: 'openai', apiKey: 'k', baseUrl: url }, NO_RETRY);
  await assert.rejects(model(ask), (err: ModelError) => {
    assert.ok(err instanceof ModelError);
    assert.equal(err.status, null);
    assert.match(err.message, /did not answer/);
    return true;
  });
  assert.equal(classifyModelFailure(await model(ask).catch((x) => x), NOW)!.state, 'down');
});

test('the Anthropic SDK\'s failures are read the same way: its status, and the provider\'s Retry-After', async () => {
  const s = await serve(() => [429, { 'retry-after': '30' }, '{"type":"error","error":{"type":"rate_limit_error","message":"slow"}}']);
  try {
    const model = buildModel({ provider: 'anthropic', apiKey: 'k', baseUrl: s.url }, NO_RETRY);
    await assert.rejects(model(ask), (err: ModelError) => {
      assert.ok(err instanceof ModelError, `got ${(err as Error).constructor.name}`);
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterMs, 30_000);
      return true;
    });
    assert.equal(s.hits(), 1, 'the SDK\'s own retries are off for a probe');
  } finally { s.close(); }
});
