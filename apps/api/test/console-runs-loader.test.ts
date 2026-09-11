/**
 * The Runs list LOADER, not its renderer.
 *
 * WHY THIS FILE EXISTS AT ALL. Every other console test in this repo seeds `state` and calls a
 * screen, which checks that the tree builds — the failure that once shipped a blank cockpit. It
 * cannot see a bug in the code that FILLS that state, and `docs/DEFECTS.md` has a family of exactly
 * those: a screen that renders a value correctly while the thing loading the value is wrong.
 *
 * The bug this was written for was found by pressing a filter chip on the deployed farm. `refreshRuns`
 * is called both by the filter and by the 5s poll, so a poll that left BEFORE the chip was pressed
 * lands AFTER it and replaces the filtered rows with everything — leaving the chip lit above a list
 * that ignores it. Nothing in a test that awaits its own call can produce that ordering, which is
 * why it needed a `fetch` whose responses resolve out of order.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { installDom } from './dom-shim.ts';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any;
let dir = '';

/** Every pending fetch, by the URL that asked for it, so a test decides what answers when. */
interface Pending { url: string; resolve(runs: string[], nextCursor?: string | null): void }
let pending: Pending[] = [];

function stubFetch() {
  pending = [];
  (globalThis as unknown as { fetch: unknown }).fetch = (url: string) => new Promise((res) => {
    pending.push({
      url: String(url),
      resolve: (runs, nextCursor = null) => res({
        ok: true, status: 200,
        text: async () => JSON.stringify({
          runs: runs.map((runId) => ({ runId, id: runId, tests: {}, outcome: 'passed' })),
          nextCursor,
        }),
      }),
    });
  });
}

const waiting = (fragment: string) => pending.find((p) => p.url.includes(fragment));

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mfarm-console-loader-'));
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
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
});

after(async () => {
  clearInterval(mod?.state?.poll);
  clearInterval(mod?.state?.tick);
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('the runs loader', () => {
  test('sends the filter that is set, not the one that was', async () => {
    stubFetch();
    Object.assign(mod.state.runsQuery, { q: 'expenses', status: 'failed', cursor: null });
    const done = mod.refreshRuns();
    await new Promise((r) => setImmediate(r));

    const req = pending[0];
    assert.ok(req, 'no request was made');
    assert.match(req.url, /q=expenses/);
    assert.match(req.url, /status=failed/);
    req.resolve(['a']);
    await done;
  });

  test('A STALE ANSWER DOES NOT LAND ON A NEWER QUESTION', async () => {
    stubFetch();
    mod.state.runs = [];

    // The poll leaves first, unfiltered — this is the request already in flight when somebody
    // presses a chip.
    Object.assign(mod.state.runsQuery, { q: '', status: '', cursor: null });
    const poll = mod.refreshRuns();
    await new Promise((r) => setImmediate(r));

    // The chip is pressed: a second, filtered request.
    Object.assign(mod.state.runsQuery, { status: 'failed' });
    const click = mod.refreshRuns();
    await new Promise((r) => setImmediate(r));

    // The filtered answer arrives first, then the stale unfiltered one — the ordering that put an
    // unfiltered list under a lit chip on the farm.
    waiting('status=failed')!.resolve(['failed-one']);
    await click;
    assert.deepEqual(mod.state.runs.map((r: { runId: string }) => r.runId), ['failed-one']);

    pending.find((p) => !p.url.includes('status='))!.resolve(['everything', 'else', 'entirely']);
    await poll;

    assert.deepEqual(mod.state.runs.map((r: { runId: string }) => r.runId), ['failed-one'],
      'the poll’s older answer replaced the filtered list');
  });

  test('a stale answer does not move the cursor either', async () => {
    stubFetch();
    mod.state.runs = [];
    Object.assign(mod.state.runsQuery, { q: '', status: '', cursor: null, more: false });

    const poll = mod.refreshRuns();
    await new Promise((r) => setImmediate(r));
    Object.assign(mod.state.runsQuery, { status: 'passed' });
    const click = mod.refreshRuns();
    await new Promise((r) => setImmediate(r));

    waiting('status=passed')!.resolve(['p1'], null);
    await click;

    // A cursor from the discarded request would page the WRONG query on the next Load more.
    pending.find((p) => !p.url.includes('status='))!.resolve(['x'], 'cursor-from-the-stale-one');
    await poll;

    assert.equal(mod.state.runsQuery.cursor, null);
    assert.equal(mod.state.runsQuery.more, false);
  });

  test('append adds a page instead of replacing one', async () => {
    stubFetch();
    mod.state.runs = [{ runId: 'first' }];
    Object.assign(mod.state.runsQuery, { q: '', status: '', cursor: 'c1', more: true });

    const done = mod.refreshRuns({ append: true });
    await new Promise((r) => setImmediate(r));
    assert.match(pending[0].url, /cursor=c1/);
    pending[0].resolve(['second'], null);
    await done;

    assert.deepEqual(mod.state.runs.map((r: { runId: string }) => r.runId), ['first', 'second']);
    assert.equal(mod.state.runsQuery.more, false);
  });

  test('a replacing fetch asks for the rows already on screen, so a poll cannot collapse pages', async () => {
    stubFetch();
    // Somebody has loaded three pages; the poll must not drop them back to one.
    mod.state.runs = Array.from({ length: 120 }, (_, i) => ({ runId: `r${i}` }));
    Object.assign(mod.state.runsQuery, { q: '', status: '', cursor: null });

    const done = mod.refreshRuns();
    await new Promise((r) => setImmediate(r));
    assert.match(pending[0].url, /limit=150/);
    pending[0].resolve(['r0']);
    await done;
  });
});
