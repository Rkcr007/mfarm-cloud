/**
 * The AI testing screens' LOADERS, not their renderers.
 *
 * WHY THIS FILE EXISTS. Every AI test in `console-screens.test.ts` seeds `state.ai` and renders it,
 * which cannot see the bug found on the farm on 2026-09-26: "Recent AI runs" said "Loading…" for
 * good, so a person who started a run could not find it again. The three loaders run together on
 * arrival, and `loadAiPricing` wrote back a copy of `state.ai` it had taken BEFORE its request —
 * so when the prices answered after the run list, the list was erased and `loading: true` restored,
 * and `loadAiRuns` never runs while that flag is set. Only responses that resolve out of order can
 * produce that, which is why this needed a `fetch` whose answers the test hands out one at a time —
 * the shape `console-runs-loader.test.ts` uses for the same family of defect.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { installDom, textOf } from './dom-shim.ts';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any;
let dir = '';

/** Every request the console has made and nobody has answered yet. */
interface Pending { url: string; answer(body: unknown): void }
let pending: Pending[] = [];

function stubFetch() {
  pending = [];
  (globalThis as unknown as { fetch: unknown }).fetch = (url: string) => new Promise((res) => {
    pending.push({
      url: String(url),
      answer: (body) => res({ ok: true, status: 200, text: async () => JSON.stringify(body) }),
    });
  });
}

/** The request for exactly this URL, taken off the queue so the test decides when it answers. */
function take(url: string): Pending {
  const i = pending.findIndex((p) => p.url === url);
  assert.ok(i >= 0, `nothing asked for ${url}; waiting: ${pending.map((p) => p.url).join(', ') || 'nothing'}`);
  return pending.splice(i, 1)[0]!;
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

const RUN = {
  id: 'air-5', prompt: 'Open Settings and check Display', profile: 'flash', platform: 'android',
  region: 'lab', appRef: null, stepCap: 40, status: 'passed', stopReason: null, summary: 'Display opened',
  evidence: 'Display', model: 'm', sessionId: 'sess-5', runId: 'run-5', steps: 2, costInr: 8,
  createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
  cancelRequested: false, createdBy: 'someone@mfarm.local', trigger: 'manual', test: null,
};
const PRICING = {
  configured: true, currency: '₹', diagnosePriceInr: 12,
  profiles: { flash: { priceInr: 4, stepCap: 40 }, pro: { priceInr: 9, stepCap: 80 } },
  budget: { spentInr: 8, budgetInr: 2000 },
};

/** Arrive as a person does: nothing loaded, nothing in flight. */
function fresh(route: { name: string; id?: string }) {
  mod.state.route = { name: route.name, id: route.id ?? null };
  mod.state.ai = {
    ...mod.state.ai,
    runs: [], loaded: false, loading: false, pricing: null, pricingLoading: false,
    detail: null, detailLoading: false, tests: [], testsLoaded: false, testsLoading: false,
  };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mfarm-console-ai-loader-'));
  const modules = (await readdir(PUBLIC)).filter((f) => f.endsWith('.js'));
  const rewrite = (src: string) => src.replace(
    /from '\/([\w.-]+\.js)'/g, (_m, f) => `from '${pathToFileURL(join(dir, f)).href}'`);
  for (const name of modules) {
    await writeFile(join(dir, name), rewrite(await readFile(join(PUBLIC, name), 'utf8')));
  }

  installDom();
  stubFetch();
  mod = await import(pathToFileURL(join(dir, 'console.js')).href);
  clearInterval(mod.state.poll);
  clearInterval(mod.state.tick);
  await settle();
});

after(async () => {
  clearInterval(mod?.state?.poll);
  clearInterval(mod?.state?.tick);
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('the AI testing loaders', () => {
  test('the run list survives the prices answering after it — it said "Loading…" for good', async () => {
    stubFetch();
    fresh({ name: 'ai' });
    mod.SCREENS.ai(); // arrival: the screen asks for everything it has not got, all at once
    // The most recent 100: the list's search and filters work over those, in the browser (2026-09-27).
    const runs = take('/v1/ai/runs?limit=100');
    const pricing = take('/v1/ai/pricing');

    runs.answer({ aiRuns: [RUN] });
    await settle();
    pricing.answer(PRICING); // AFTER the list — the order the farm produced
    await settle();

    assert.equal(mod.state.ai.runs.length, 1, 'the list that landed first is still there');
    assert.equal(mod.state.ai.loaded, true);
    assert.equal(mod.state.ai.loading, false, '"loading" left set means the list is never asked for again');
    assert.ok(mod.state.ai.pricing?.configured, 'and the prices landed too');
    const text = textOf(mod.SCREENS.ai());
    assert.match(text, /Open Settings and check Display/);
    assert.doesNotMatch(text, /Loading…/);
  });

  test('an open run survives the prices answering after it — the same write could erase it', async () => {
    stubFetch();
    fresh({ name: 'airun', id: 'air-5' });
    mod.SCREENS.airun();
    const run = take('/v1/ai/runs/air-5');
    const pricing = take('/v1/ai/pricing');

    run.answer({ aiRun: RUN, steps: [] });
    await settle();
    pricing.answer(PRICING);
    await settle();

    assert.equal(mod.state.ai.detail?.aiRun?.id, 'air-5', 'the run is still the one on screen');
    assert.equal(mod.state.ai.detailLoading, false);
    assert.match(textOf(mod.SCREENS.airun()), /Open Settings and check Display/);
  });
});
