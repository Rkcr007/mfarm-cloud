/**
 * Every console screen builds a tree, for real, in Node.
 *
 * WHY THIS EXISTS, precisely. On 2026-08-23 the cockpit shipped rendering completely blank: the
 * element inspector was added to the rail as `inspectorCard(caps)`, and `caps` is a local of a
 * different function. A ReferenceError threw partway through building the tree, `render()` produced
 * nothing, and the page came up black with the device still streaming behind it.
 *
 * Nothing caught it. `node --check` passes — it is valid syntax. `tsc` never sees `console.js`,
 * because the console is plain JavaScript served with no build step and that is deliberate. And no
 * test had ever rendered a screen. A name that does not exist was caught by exactly nothing until
 * somebody opened the page.
 *
 * So: call every screen, and assert it returns something. That is a low bar on purpose. It is not
 * checking layout or copy — it is checking that the function runs to the end, which is the failure
 * that actually shipped and the one no other tool here can see.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { installDom, countElements, textOf } from './dom-shim.ts';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * The rewritten copy goes to a TEMP DIRECTORY, never into `public/`.
 *
 * Everything in `public/` is served to the internet by design. A copy of the console left there by
 * a crashed test run would be served alongside the real one — and it is possible to leave one,
 * because cleanup runs in `after()` and `after()` does not run if the process dies. Outside the
 * served tree that cannot happen at all.
 *
 * It costs nothing: the only import `console.js` has is `/live.js`, and that is rewritten to an
 * absolute file URL below, so the copy has no relative paths left to resolve.
 */
let SHIMMED = '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any;

before(async () => {
  /**
   * `console.js` imports `/live.js` — an ABSOLUTE URL path, which is correct in a browser (the
   * origin resolves it) and unresolvable in Node, where `/live.js` means the filesystem root.
   *
   * Rewritten to a file URL in a copy rather than changed at source: the absolute specifier is what
   * makes the console work with no bundler and no import map, and bending the shipped file to suit
   * a test would be the tail wagging the dog.
   */
  const src = (await readFile(join(PUBLIC, 'console.js'), 'utf8'))
    .replace("from '/live.js'", `from ${JSON.stringify(pathToFileURL(join(PUBLIC, 'live.js')).href)}`);
  SHIMMED = join(await mkdtemp(join(tmpdir(), 'mfarm-console-')), 'console.undertest.mjs');
  await writeFile(SHIMMED, src);

  installDom();
  mod = await import(pathToFileURL(SHIMMED).href);

  // The module boots on import and its `fetch` rejects, so it lands on the signed-out path and
  // starts no timers. Cleared anyway: an interval left running keeps the test process alive.
  clearInterval(mod.state.poll);
  clearInterval(mod.state.tick);

  // Let boot() and checkReach() finish rejecting BEFORE any test runs. Both are fired at import
  // and neither is awaited by anything, so without this their tails land after the suite has
  // finished — where node reports them as "asynchronous activity after the test ended" and fails
  // the whole file rather than the line responsible.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
});

after(async () => {
  clearInterval(mod?.state?.poll);
  clearInterval(mod?.state?.tick);
  if (SHIMMED) await rm(dirname(SHIMMED), { recursive: true, force: true });
});

/** Enough state for a screen to have something to draw. */
function seed(route: { name: string; id?: string | null }) {
  const device = {
    id: 'dev-1', region: 'lab', platform: 'android', tier: 'cuttlefish',
    model: 'cf_x86_64', osVersion: '17', state: 'READY', dedicated: false,
    capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset', 'app-install',
      'logcat', 'screenshot', 'ui-hierarchy', 'webdriver'],
    screen: { width: 720, height: 1280, density: 320 },
  };
  const session = {
    id: 'sess-1', state: 'ACTIVE', deviceId: 'dev-1', device: 'cf-1', region: 'lab',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    startedAt: new Date(Date.now() - 55_000).toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    endedAt: null, endReason: null,
    run: { id: 'run-1', runId: '4471' },
  };
  const run = {
    id: 'run-1', runId: '4471',
    createdAt: new Date(Date.now() - 90_000).toISOString(),
    sessions: { total: 3, live: 1, ended: 2 },
    firstSessionAt: new Date(Date.now() - 90_000).toISOString(),
    lastActivityAt: new Date(Date.now() - 5_000).toISOString(),
    build: { id: 'app-1', packageName: 'com.acme.app', versionName: '1.0' },
    buildCount: 1,
  };
  Object.assign(mod.state, {
    me: { user: { id: 'u1', email: 'someone@mfarm.local' }, org: { id: 'o1', name: 'Farm', slug: 'farm', maxConcurrent: 5 }, role: 'admin' },
    devices: [device],
    available: 1,
    sessions: [session],
    apps: [{ id: 'app-1', packageName: 'com.acme.app', versionName: '1.0', sizeBytes: 1024, createdAt: new Date().toISOString(), label: 'Acme' }],
    actions: [{ id: 'a1', kind: 'install', state: 'SUCCEEDED', appId: 'app-1', deviceId: 'dev-1', sessionId: 'sess-1', requestedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }],
    detail: { ...session, dataPlane: null, ice: null, fetchedAt: Date.now() },
    runs: [run],
    runDetail: { id: route.id ?? 'run-1', run, sessions: [{ ...session, build: run.build }], loaded: true },
    held: null,
    route: { name: route.name, id: route.id ?? null },
    error: null,
  });
  return { device, session };
}

describe('every screen renders', () => {
  // The full nav, plus the two routes reached with an id. `launching` is deliberately included:
  // it is the bring-up screen, the one nobody opens by hand, and therefore the one most likely to
  // rot unnoticed.
  const ROUTES: Array<{ name: string; id?: string }> = [
    { name: 'launch' },
    { name: 'devices' },
    { name: 'device', id: 'dev-1' },
    { name: 'apps' },
    { name: 'sessions' },
    { name: 'runs' },
    { name: 'run', id: '4471' },
    { name: 'cockpit', id: 'sess-1' },
    { name: 'queue' },
    { name: 'health' },
    { name: 'team' },
    { name: 'settings' },
    { name: 'launching', id: 'sess-1' },
  ];

  for (const route of ROUTES) {
    test(`${route.name} builds a tree`, () => {
      seed(route);
      const build = mod.SCREENS[route.name];
      assert.ok(build, `no screen registered for route "${route.name}"`);

      // The assertion the blank cockpit would have failed: this threw, so nothing came back.
      const tree = build();
      const n = countElements(tree);
      assert.ok(n > 0, `${route.name} produced no elements`);
    });
  }

  test('the route table and the nav agree', async () => {
    // A nav item pointing at a route with no screen renders the devices list instead and looks like
    // a dead click — which is what `#/sessions/<id>` was before it was pointed at the cockpit.
    const html = await readFile(join(PUBLIC, 'index.html'), 'utf8');
    for (const m of html.matchAll(/data-route="([a-z]+)"/g)) {
      assert.ok(mod.SCREENS[m[1]], `nav offers "${m[1]}" and SCREENS has no such screen`);
    }
  });
});

describe('screens survive an empty farm', () => {
  // The state a new install is in, and the one every "no devices yet" message exists for. A screen
  // that only works once data has arrived fails on the first morning somebody tries this.
  for (const name of ['launch', 'devices', 'apps', 'sessions', 'runs', 'queue', 'health', 'team', 'settings']) {
    test(`${name} renders with nothing in it`, () => {
      seed({ name });
      Object.assign(mod.state, { devices: [], available: 0, sessions: [], apps: [], actions: [], runs: [], runDetail: null, detail: null, held: null });
      assert.ok(countElements(mod.SCREENS[name]()) > 0, `${name} produced no elements when empty`);
    });
  }
});

describe('the cockpit', () => {
  test('offers the inspector when the device declares ui-hierarchy', () => {
    // The regression that started this file. `inspectorCard` reads the device's capabilities, and
    // the variable holding them has to exist in the scope it is called from.
    seed({ name: 'cockpit', id: 'sess-1' });
    mod.state.inspect = { on: true, nodes: [], picked: null, at: null, loading: false, error: null };
    assert.match(textOf(mod.SCREENS.cockpit()), /Inspector/);
  });

  test('offers no inspector when the device does not declare it', () => {
    const { device } = seed({ name: 'cockpit', id: 'sess-1' });
    device.capabilities = device.capabilities.filter((c) => c !== 'ui-hierarchy');
    mod.state.inspect = { on: true, nodes: [], picked: null, at: null, loading: false, error: null };
    assert.ok(!/Inspector/.test(textOf(mod.SCREENS.cockpit())),
      'a device without the capability must not be offered an inspector that can never fill');
  });

  test('a session that is not visible renders an explanation, not a blank page', () => {
    seed({ name: 'cockpit', id: 'nope' });
    assert.match(textOf(mod.SCREENS.cockpit()), /not visible to this org/);
  });
});

describe('the runs screens', () => {
  test('a run whose sessions disagreed on the build names none of them', () => {
    // The rule the schema and the API both hold, restated where a person actually reads it: a run
    // that touched two builds must not show one of them as THE build. `buildCount` is what carries
    // the difference, because `build: null` alone reads identically to "installed nothing".
    seed({ name: 'runs' });
    mod.state.runs = [{ ...mod.state.runs[0], build: null, buildCount: 2 }];
    assert.match(textOf(mod.SCREENS.runs()), /2 builds/);
  });

  test('a run id that resolves to nothing says so, rather than loading forever', () => {
    seed({ name: 'run', id: 'never-ran' });
    mod.state.runDetail = { id: 'never-ran', run: null, sessions: [], loaded: true };
    assert.match(textOf(mod.SCREENS.run()), /No run by that name/);
  });

  test('a detail fetch still in flight reads as loading, not as a missing run', () => {
    seed({ name: 'run', id: '4471' });
    mod.state.runDetail = { id: '4471', run: null, sessions: [], loaded: false };
    const text = textOf(mod.SCREENS.run());
    assert.match(text, /Loading/);
    assert.ok(!/No run by that name/.test(text),
      'telling somebody their run does not exist while it is still arriving is the worse error');
  });
});
