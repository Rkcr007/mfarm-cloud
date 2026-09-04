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
import { readFile, readdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { installDom, countElements, classesOf, textOf, findByClass } from './dom-shim.ts';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * The rewritten copy goes to a TEMP DIRECTORY, never into `public/`.
 *
 * Everything in `public/` is served to the internet by design. A copy of the console left there by
 * a crashed test run would be served alongside the real one — and it is possible to leave one,
 * because cleanup runs in `after()` and `after()` does not run if the process dies. Outside the
 * served tree that cannot happen at all.
 *
 * It costs nothing: `console.js` imports only browser-absolute specifiers, and every one of them is
 * rewritten to an absolute file URL below, so the copy has no paths left to resolve.
 */
let SHIMMED = '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any;

before(async () => {
  /**
   * The console's modules import each other by ABSOLUTE URL PATH — `/live.js`, `/profiles.js`,
   * `/icons.js`, `/frame.js` — which is correct in a browser, where the origin resolves them, and
   * unresolvable in Node, where `/live.js` means the filesystem root.
   *
   * Rewritten to file URLs in a COPY rather than changed at source: the absolute specifier is what
   * makes the console work with no bundler and no import map, and bending the shipped file to suit
   * a test would be the tail wagging the dog. The copy goes to a temp directory and never into
   * `public/`, which is served to the internet — see the note on `SHIMMED`.
   *
   * THE WHOLE GRAPH, NOT JUST THE ENTRY POINT. This used to rewrite `console.js` alone, which
   * worked only while every browser module was a leaf. The first module to import another —
   * `frame.js` importing `/profiles.js` — failed every screen test at once with a
   * module-not-found pointing at the filesystem root, because the rewrite never reached it. Copying
   * every module and rewriting each one costs a few milliseconds and cannot go stale: a file added
   * to `public/` is picked up by being there.
   *
   * Subdirectories are skipped deliberately. `public/app/` is the React console's BUILD OUTPUT —
   * a bundle, not a browser module this console imports, and not something to rewrite.
   */
  const dir = await mkdtemp(join(tmpdir(), 'mfarm-console-'));
  const modules = (await readdir(PUBLIC, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => e.name);

  const rewrite = (src: string) => src.replace(
    /from '\/([\w.-]+\.js)'/g,
    (whole, file: string) => (modules.includes(file)
      ? `from ${JSON.stringify(pathToFileURL(join(dir, file)).href)}`
      : whole),
  );

  for (const name of modules) {
    await writeFile(join(dir, name), rewrite(await readFile(join(PUBLIC, name), 'utf8')));
  }
  SHIMMED = join(dir, 'console.js');

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
    tests: { total: 8, passed: 6, failed: 1, skipped: 1, sessionsReporting: 3 },
  };
  Object.assign(mod.state, {
    me: { user: { id: 'u1', email: 'someone@mfarm.local' }, org: { id: 'o1', name: 'Farm', slug: 'farm', maxConcurrent: 5 }, role: 'admin' },
    devices: [device],
    available: 1,
    sessions: [session],
    apps: [{ id: 'app-1', packageName: 'com.acme.app', versionName: '1.0', sizeBytes: 1024, createdAt: new Date().toISOString(), label: 'Acme' }],
    // `DONE`, not `SUCCEEDED`. The latter is a state this system has never emitted — migration 015
    // renamed `INSTALLED` to `DONE` and the enum is PENDING/DONE/FAILED. The fixture carried a
    // fictional value, so `installedOn()` found nothing in every test that used this seed, and any
    // assertion about an installed build was passing against an empty answer.
    actions: [{ id: 'a1', kind: 'install', state: 'DONE', appId: 'app-1', deviceId: 'dev-1', sessionId: 'sess-1', requestedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }],
    detail: { ...session, dataPlane: null, ice: null, fetchedAt: Date.now() },
    runs: [run],
    runDetail: {
      id: route.id ?? 'run-1', run, loaded: true,
      sessions: [{ ...session, build: run.build, tests: { total: 8, passed: 6, failed: 1, skipped: 1 } }],
      failures: [{
        id: 'tr-1', sessionId: 'sess-1', name: 'checkout applies a promo',
        failure: 'AssertionError: expected 8 got 10', durationMs: 1200,
        reportedAt: new Date().toISOString(),
      }],
    },
    held: null,
    // ADR-0014. `loaded: true` so the screen renders itself rather than the loading skeleton — the
    // gate fires a fetch that has no server behind it here, and a skeleton would make every
    // assertion below pass against an empty page.
    pair: {
      code: '', machine: null, busy: false, error: null, loaded: true,
      enrollments: [{
        prefix: 'mae_abcdefgh', label: 'paired from the agent window',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        revokedAt: null, usedAt: new Date().toISOString(), hostId: 'host-1',
      }],
    },
    route: { name: route.name, id: route.id ?? null },
    // Explicitly cleared, not left over. Both are fetched on navigation rather than by the poll, so
    // a test that does not set them would otherwise inherit whichever device the PREVIOUS test
    // opened — and the device screen merges the detail read over the poll row, which is exactly the
    // place a stale fixture would look like a passing assertion.
    deviceDetail: null,
    quarantineLog: null,
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
    { name: 'agents' },
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
  for (const name of ['launch', 'devices', 'apps', 'sessions', 'runs', 'queue', 'health', 'agents', 'team', 'settings']) {
    test(`${name} renders with nothing in it`, () => {
      seed({ name });
      Object.assign(mod.state, { devices: [], available: 0, sessions: [], apps: [], actions: [], runs: [], runDetail: null, detail: null, held: null });
      assert.ok(countElements(mod.SCREENS[name]()) > 0, `${name} produced no elements when empty`);
    });
  }
});

/**
 * The pairing screen — ADR-0014's console half.
 *
 * The two things worth protecting here are both about what a person is shown BEFORE they admit a
 * machine to their org: that the confirmation step exists at all, and that it names the machine.
 * Losing either turns a deliberate stop into a single click on a code somebody was sent.
 */
describe('pairing a machine', () => {
  test('asks for a code, and does not offer to approve anything yet', () => {
    seed({ name: 'agents' });
    const text = textOf(mod.SCREENS.agents());
    assert.match(text, /Pair a machine/);
    assert.match(text, /Find machine/);
    assert.ok(!/Yes, pair this machine/.test(text),
      'nothing may be approvable before a machine has been looked up');
  });

  test('names the machine before offering to pair it', () => {
    seed({ name: 'agents' });
    mod.state.pair.code = 'ABCD-2345';
    mod.state.pair.machine = {
      hostname: 'ravi-macbook', platform: 'darwin-arm64', agentVersion: '0.1.0',
      requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
      approved: false,
    };
    const text = textOf(mod.SCREENS.agents());
    assert.match(text, /ravi-macbook/);
    assert.match(text, /darwin-arm64/);
    assert.match(text, /Yes, pair this machine/);
    // The warning is the mitigation, so it is asserted rather than assumed to have survived edits.
    assert.match(text, /do not recognise it, do not approve/);
  });

  test('a member is told they cannot pair, rather than given a button that fails', () => {
    seed({ name: 'agents' });
    mod.state.me.role = 'member';
    assert.match(textOf(mod.SCREENS.agents()), /Only an owner or admin can pair/);
  });

  test('lists machines that have already paired', () => {
    seed({ name: 'agents' });
    assert.match(textOf(mod.SCREENS.agents()), /paired from the agent window/);
  });
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

describe('outcome reporting in the console', () => {
  test('a run nobody reported reads as unmeasured, never as passing', () => {
    // The distinction the whole of §4.3 exists to preserve. "0 failed" on a run that was never
    // instrumented is a green number on an unchecked result, and green numbers stop people looking.
    seed({ name: 'runs' });
    mod.state.runs = [{
      ...mod.state.runs[0],
      tests: { total: 0, passed: 0, failed: 0, skipped: 0, sessionsReporting: 0 },
    }];
    const text = textOf(mod.SCREENS.runs());
    assert.match(text, /Not reported/);
    assert.ok(!/all passed|0 failed/.test(text),
      'an unreported run must not render as a pass');
  });

  test('a run whose suite reported shows the counts it reported', () => {
    seed({ name: 'runs' });
    assert.match(textOf(mod.SCREENS.runs()), /1 failed/);
  });

  test('the run detail shows the failure and a way to its evidence', () => {
    seed({ name: 'run', id: '4471' });
    const text = textOf(mod.SCREENS.run());
    assert.match(text, /checkout applies a promo/);
    assert.match(text, /expected 8 got 10/);
    assert.match(text, /Open the session/, 'the failure has to link to its logcat and screenshot');
  });

  test('a partially reported run says so rather than implying the counts cover it', () => {
    seed({ name: 'run', id: '4471' });
    mod.state.runDetail.run = {
      ...mod.state.runDetail.run,
      sessions: { total: 5, live: 0, ended: 5 },
      tests: { total: 8, passed: 8, failed: 0, skipped: 0, sessionsReporting: 2 },
    };
    assert.match(textOf(mod.SCREENS.run()), /Only 2 of 5 sessions reported/);
  });
});

/**
 * Real devices in the fleet screen (ADR-0008, spec §25).
 *
 * The thing worth testing is not that a badge exists — it is that the two kinds are DISTINGUISHED.
 * A physical handset and a Cuttlefish differ in what a result from them means, and a console that
 * renders them identically quietly invites someone to trust an emulator run as if it were a phone.
 */
describe('real and virtual devices are told apart', () => {
  /** A handset as the agent registers one: physical tier, session-reset, and no stream. */
  function withPhone() {
    seed({ name: 'devices' });
    mod.state.devices = [
      ...mod.state.devices,
      {
        id: 'dev-2', region: 'lab', platform: 'android', tier: 'physical',
        model: 'Pixel 9', osVersion: '16', state: 'READY', dedicated: true,
        // `install-reset`, which is what a handset declares since ADR-0012 — a release undoes what
        // the session installed rather than sweeping the owner's apps.
        capabilities: ['input-datachannel', 'install-reset', 'app-install', 'logcat',
          'screenshot', 'ui-hierarchy', 'webdriver'],
        screen: { width: 1080, height: 2400, density: 420 },
      },
    ];
    mod.state.available = 2;
  }

  test('a handset is labelled REAL and a cuttlefish VIRTUAL', () => {
    withPhone();
    const text = textOf(mod.SCREENS.devices());
    assert.match(text, /REAL DEVICE/);
    assert.match(text, /VIRTUAL DEVICE/);
    assert.match(text, /Pixel 9/);
  });

  test('the kind filter narrows to one kind', () => {
    withPhone();
    mod.state.deviceKind = 'real';
    const real = textOf(mod.SCREENS.devices());
    assert.match(real, /Pixel 9/);
    assert.doesNotMatch(real, /Unprofiled device/, 'a virtual device must not survive the real filter');

    mod.state.deviceKind = 'virtual';
    const virtual = textOf(mod.SCREENS.devices());
    // `dev-1` is an unprofiled Cuttlefish device, and "Unprofiled device" is what it is CALLED —
    // see `deviceName`. It used to render as its raw model string, `cf_x86_64`, which names an
    // implementation the reader did not choose and cannot act on.
    assert.match(virtual, /Unprofiled device/);
    assert.doesNotMatch(virtual, /Pixel 9/);

    mod.state.deviceKind = 'all';
  });

  /**
   * THE RAW STACK VOCABULARY NEVER APPEARS IN A NAME.
   *
   * A device is addressed by what it IS. `cf_x86_64` and `cuttlefish` are still shown — in the
   * details table, as machine text, where the mono register itself tells the reader this came from
   * the machine rather than from us. What they may never be is the device's name.
   *
   * The physical handset is the exception and is checked here too: `Pixel 9` is its OWN model
   * number, and naming it accurately is the opposite of the counterfeiting ADR-0017 forbids.
   */
  test('a device is named by what it is, not by the stack it runs on', () => {
    withPhone();
    mod.state.deviceKind = 'all';
    const text = textOf(mod.SCREENS.devices());

    assert.doesNotMatch(text, /cf_x86_64/, 'the raw model is not a name');
    assert.match(text, /Unprofiled device/, 'it is called what it is');
    assert.match(text, /Pixel 9/, 'a real handset keeps its own model number');
    // Still present, and still available to copy — placed, not banned.
    assert.match(text, /cuttlefish/, 'the tier stays in the details table');
  });

  /**
   * A filter that can only produce an empty screen is a control that should not be there. This is
   * the state every existing Cuttlefish-only farm is in, and offering "Real (0)" on it would be an
   * invitation to click into a blank page and wonder what broke.
   */
  test('the filter is not offered on a fleet of one kind', () => {
    seed({ name: 'devices' });
    assert.doesNotMatch(textOf(mod.SCREENS.devices()), /Virtual|Real/,
      'one kind in the fleet means nothing to choose between');
  });

  test('filtering to a kind the farm does not have explains itself', () => {
    seed({ name: 'devices' });
    mod.state.deviceKind = 'real';
    const text = textOf(mod.SCREENS.devices());
    // Never the "no devices are registered" copy — there ARE devices, just not of this kind.
    assert.doesNotMatch(text, /No devices are registered/);
    assert.match(text, /Clear the filter/);
    mod.state.deviceKind = 'all';
  });

  test('the device detail names the reset it has rather than showing it as missing', () => {
    withPhone();
    mod.state.route = { name: 'device', id: 'dev-2' };
    // KNOWN_CAPS drives the chip row; a capability absent from it renders as an unknown extra and
    // a phone's only reset would read as "this device cannot reset at all".
    assert.match(textOf(mod.SCREENS.device()), /install-reset/);
  });
});

/**
 * ADR-0024 on the screen an operator actually acts from.
 *
 * The claim this change exists to make is a SENTENCE — "releasing does not make this device
 * available" — and a sentence is exactly the kind of thing that survives a refactor in the code and
 * quietly disappears from the page. These render the device detail in each of the three states and
 * assert on what a person reads.
 */
describe('the device detail carries the quarantine gate', () => {
  const withDevice = (extra: Record<string, unknown>) => {
    seed({ name: 'device', id: 'dev-1' });
    Object.assign(mod.state.devices[0], extra);
    mod.state.quarantineLog = { id: 'dev-1', loaded: true, events: [] };
    return textOf(mod.SCREENS.device());
  };

  test('a quarantined device says WHY, not what the state generally means', () => {
    const t = withDevice({
      state: 'QUARANTINED',
      quarantine: { at: new Date().toISOString(), reason: 'adb keeps dropping mid-session', source: 'health' },
    });
    assert.match(t, /adb keeps dropping mid-session/);
    assert.match(t, /failed a health check/i, 'the source is what says where to look');
    // The button names the AUTHORISATION, not an outcome the operator cannot produce. "Release
    // quarantine" promised a state change that releasing does not make — only a passing health
    // check returns the device to the pool.
    assert.match(t, /Authorise one recovery attempt/);
  });

  test('and the screen refuses to imply that releasing makes it available', () => {
    const t = withDevice({
      state: 'QUARANTINED',
      quarantine: { at: new Date().toISOString(), reason: 'frozen', source: 'operator' },
    });
    /**
     * The one CLAIM this whole change is about. If it ever disappears from the page, the button
     * reads exactly like the `UPDATE devices SET state = 'READY'` that ADR-0024 refused to build.
     *
     * The WORDING moved with document 05 §03: the page used to carry it as a single line of prose,
     * "Releasing a quarantine does not mark this device available", and it is now the second entry
     * in the consequence list, where it sits beside the two other things a release does not do. The
     * assertion follows the claim rather than the sentence — but it is deliberately still two
     * halves, because "it does not return the device" without "only a passing check does" is a
     * refusal with no path forward, and somebody would eventually soften it back.
     */
    assert.match(t, /does\s+not\s+return the device to the pool/i);
    assert.match(t, /only a passing health check does that/i);
  });

  test('a device already recovering offers no second release, and says what it is waiting on', () => {
    const t = withDevice({
      state: 'PREPARING',
      recovery: { startedAt: new Date().toISOString(), fromReason: 'usb dropped' },
    });
    assert.match(t, /usb dropped/, 'what it is recovering FROM is the context for the wait');
    assert.match(t, /health check/i);
    assert.doesNotMatch(t, /Authorise one recovery attempt/,
      'there is nothing left to release — a second click must not be offered');
  });

  test('a healthy device offers the way IN, since §30 needs one', () => {
    const t = withDevice({ state: 'READY' });
    assert.match(t, /Quarantine device/);
    assert.doesNotMatch(t, /Authorise one recovery attempt/);
  });
});

/**
 * §18 in the console: a farm fault must be visibly NOT a test failure.
 *
 * The taxonomy is worth nothing if the screen renders both identically — the whole point is that a
 * person reading a red run can tell "your app is broken" from "our cable fell out".
 */
describe('failure classification on the run detail', () => {
  function withIncidents() {
    seed({ name: 'run', id: '4471' });
    mod.state.runDetail.failures = [
      {
        id: 'tr-1', sessionId: 'sess-1', name: 'checkout applies a promo',
        failure: 'AssertionError: expected 8 got 10', durationMs: 1200,
        failureClass: 'test', failureReason: 'assertion-failure',
        reportedAt: new Date().toISOString(),
      },
      {
        id: 'tr-2', sessionId: 'sess-1', name: 'cart survives a reload',
        failure: 'no such session', durationMs: 900,
        failureClass: null, failureReason: null,
        reportedAt: new Date().toISOString(),
      },
    ];
    mod.state.runDetail.incidents = [{
      id: 'si-1', sessionId: 'sess-1', class: 'infrastructure',
      reason: 'device-disconnected', detail: 'adb: device offline',
      device: 'phone-ABC123', occurredAt: new Date().toISOString(),
    }];
  }

  test('what the farm saw is its own card, not mixed into the failures', () => {
    withIncidents();
    const text = textOf(mod.SCREENS.run());
    assert.match(text, /What the farm saw/);
    assert.match(text, /adb: device offline/);
    assert.match(text, /phone-ABC123/);
    // The failures card still reports only what the SUITE said.
    assert.match(text, /Failures \(2\)/);
  });

  test('an infrastructure incident is labelled as such, never as a test failure', () => {
    withIncidents();
    const text = textOf(mod.SCREENS.run());
    assert.match(text, /Infrastructure/);
  });

  test('a classified test failure carries its class', () => {
    withIncidents();
    assert.match(textOf(mod.SCREENS.run()), /Test/);
  });

  /** The run still renders when the farm saw nothing — the common, healthy case. */
  test('no incidents means no card, not an empty one', () => {
    seed({ name: 'run', id: '4471' });
    mod.state.runDetail.incidents = [];
    assert.doesNotMatch(textOf(mod.SCREENS.run()), /What the farm saw/);
  });

  /**
   * The state this card exists for: nothing failed, but the farm had a problem. A run like this
   * looks perfectly green and should not be trusted without a second look.
   */
  test('incidents show even when every test passed', () => {
    seed({ name: 'run', id: '4471' });
    mod.state.runDetail.failures = [];
    mod.state.runDetail.incidents = [{
      id: 'si-1', sessionId: 'sess-1', class: 'device-health',
      reason: 'low-battery', detail: 'battery at 9%',
      device: 'phone-ABC123', occurredAt: new Date().toISOString(),
    }];
    const text = textOf(mod.SCREENS.run());
    assert.match(text, /What the farm saw/);
    assert.match(text, /Device health/);
  });
});

/**
 * Device profiles in the console — ADR-0016.
 *
 * The panel is drawn from two independent sources and the split is the thing worth protecting:
 * GEOMETRY comes from the device's own reported screen, CHROME comes from its profile. A test that
 * only checked "the X1 Pro looks like an X1 Pro" would pass just as happily if the console had
 * started drawing the panel from the chrome table — which would show a shape the device is not.
 */
/**
 * NO SCREEN RENDERS THE WORD "null".
 *
 * `add()` skips null; the DOM does not. `replaceChildren(x ? node : null)` and `append(null)` are
 * native methods that convert their arguments with `String()`, so a conditional child that
 * evaluates to null becomes the literal text "null" on the page.
 *
 * That shipped: the device toolbar's chrome toggle is `… : null` on an unprofiled device, so every
 * session on `cf-1`, `cf-2` or a physical handset drew `null` under the toolbar. Found by looking
 * at a real session on 2026-08-31, not by a test — the shim was skipping the null a browser would
 * have rendered, which is the same "kinder than the platform" blind spot as the style-string crash.
 *
 * Asserted across EVERY screen rather than on the toolbar, because the next one will be somewhere
 * else. A screen legitimately displaying the word "null" would need this test taught about it,
 * which is a conversation worth having at that point.
 */
describe('no screen leaks a stringified nullish', () => {
  for (const name of Object.keys(mod?.SCREENS ?? {})) {
    void name;
  }

  test('every screen is free of "null" and "undefined" text', () => {
    const leaks: string[] = [];
    for (const [name, screen] of Object.entries(mod.SCREENS as Record<string, () => unknown>)) {
      seed({ name, id: 'sess-1' });
      mod.state.stage = null;
      let text = '';
      try {
        text = textOf(screen());
      } catch {
        continue; // a screen that cannot render at all is the other tests' business, not this one
      }
      if (/\b(null|undefined)\b/.test(text)) leaks.push(`${name}: ${text.match(/.{0,40}\b(null|undefined)\b.{0,20}/)?.[0]}`);
    }
    assert.deepEqual(leaks, [], `a conditional child reached the DOM as text:\n${leaks.join('\n')}`);
  });
});

/**
 * A DEVICE THAT IS NEVER COMING BACK MUST NOT READ AS "BUSY".
 *
 * The Launch screen counted `READY` as free and lumped EVERYTHING ELSE under `N busy`. So a
 * quarantined handset — one that failed health checks and will never be scheduled — invited a
 * tester to wait for it. The Health screen, reading the same API, correctly said `Quarantined`;
 * two screens disagreed about the same device.
 *
 * Found by exploratory testing on 2026-08-31, and worth a test because the failure is a WORD rather
 * than an error: everything renders, nothing throws, and the screen is confidently wrong.
 */
/**
 * LOGCAT IS NOT DUMPED RAW — §17 of the product direction, and a measured problem.
 *
 * On a real session 37% of the lines were one system service retrying a connection it never got.
 * A tester looking for their own app's behaviour was reading somebody else's retry loop.
 *
 * These test `visibleLog` through the screen, because the interesting failures are about WHICH
 * lines survive, and a filter that quietly hides an error would be worse than no filter at all.
 */
describe('the log pane scopes to the app under test', () => {
  const LINES = [
    { time: '00:01', level: 'D', tag: 'AiSealSystemService', message: 'not yet available; trying again', raw: 'D AiSealSystemService not yet available; trying again' },
    { time: '00:02', level: 'I', tag: 'ActivityManager', message: 'Displayed com.acme.app/.Main', raw: 'I ActivityManager Displayed com.acme.app/.Main' },
    { time: '00:03', level: 'D', tag: 'OkHttp', message: '<-- 200 https://api.acme.io', raw: 'D OkHttp <-- 200 https://api.acme.io' },
    { time: '00:04', level: 'E', tag: 'SomeSystemThing', message: 'a crash nobody should hide', raw: 'E SomeSystemThing a crash nobody should hide' },
  ];

  /**
   * Drives `visibleLog` rather than the screen tree, because the log pane paints itself into a node
   * instead of going through `render()` — a screen-level assertion sees an empty div no matter what
   * the filter did.
   */
  const shown = (scope: string) => {
    seed({ name: 'cockpit', id: 'sess-1' });
    mod.state.log = { lines: [...LINES], filter: '', level: 'ALL', follow: true, dropped: 0, scope };
    // The seeded action is a confirmed install of app-1 (com.acme.app) on sess-1.
    return mod.visibleLog().map((l: { raw: string }) => l.raw).join('\n');
  };

  test('the app scope drops system chatter that never mentions the app', () => {
    assert.doesNotMatch(shown('app'), /trying again/, 'the noisiest system line is not what a tester came for');
  });

  test('the app scope keeps lines that name the package', () => {
    assert.match(shown('app'), /Displayed com\.acme\.app/);
  });

  test('AN ERROR IS NEVER HIDDEN, whoever wrote it', () => {
    // A crash in a system service is very often the reason the app under test is misbehaving. A
    // filter that buries it makes the control worse than no control.
    assert.match(shown('app'), /a crash nobody should hide/);
  });

  test('the everything scope really does show everything', () => {
    const t = shown('all');
    assert.match(t, /trying again/);
    assert.match(t, /OkHttp/);
    assert.match(t, /a crash nobody should hide/);
  });

  test('the scope is inert when nothing is installed — no build, no filtering', () => {
    // Otherwise a session with no app would hide every line and look like a dead device.
    seed({ name: 'cockpit', id: 'sess-1' });
    mod.state.actions = [];
    mod.state.log = { lines: [...LINES], filter: '', level: 'ALL', follow: true, dropped: 0, scope: 'app' };
    assert.equal(mod.visibleLog().length, LINES.length);
  });

  test('a level chip still narrows within the scope', () => {
    seed({ name: 'cockpit', id: 'sess-1' });
    mod.state.log = { lines: [...LINES], filter: '', level: 'E', follow: true, dropped: 0, scope: 'all' };
    const out = mod.visibleLog();
    assert.equal(out.length, 1);
    assert.match(out[0].raw, /a crash nobody should hide/);
  });
});

describe('the launch picker distinguishes busy from unavailable', () => {
  const withState = (state: string) => {
    seed({ name: 'launch' });
    mod.state.devices = [{
      id: 'dev-q', region: 'lab', platform: 'android', tier: 'physical',
      model: 'SM-TEST', osVersion: '16', state, dedicated: false,
      capabilities: ['app-install', 'input-datachannel'],
    }];
    return textOf(mod.SCREENS.launch());
  };

  test('a quarantined device is unavailable, not busy', () => {
    const t = withState('QUARANTINED');
    assert.match(t, /unavailable/i, 'a device that failed health checks is not going to free up');
    assert.doesNotMatch(t, /\bbusy\b/i);
  });

  test('an offline device is unavailable, not busy', () => {
    const t = withState('OFFLINE');
    assert.match(t, /unavailable/i);
    assert.doesNotMatch(t, /\bbusy\b/i);
  });

  test('a device someone else is using IS busy — it comes back on its own', () => {
    const t = withState('SESSION_ACTIVE');
    assert.match(t, /\bbusy\b/i);
    assert.doesNotMatch(t, /unavailable/i);
  });

  test('a device restoring its snapshot is busy — that finishes by itself too', () => {
    assert.match(withState('CLEANING'), /\bbusy\b/i);
  });

  /**
   * PREPARING resolves without anybody doing anything — to READY if the health check passes, back
   * to QUARANTINED if it does not, and the reaper ends it either way inside RECOVERY_TIMEOUT_MS. So
   * it belongs with the states "busy" honestly describes, and NOT with the ones that need somebody
   * to act. Calling it unavailable would tell a tester to give up on a device that is minutes from
   * being free; the failure this whole set of tests exists for is the opposite mistake.
   */
  test('a device recovering from quarantine is busy — an operator already acted on it', () => {
    const t = withState('PREPARING');
    assert.match(t, /\bbusy\b/i);
    assert.doesNotMatch(t, /unavailable/i);
  });

  test('a ready device is free, and says so', () => {
    const t = withState('READY');
    assert.match(t, /\bfree\b/i);
    assert.doesNotMatch(t, /unavailable/i);
  });
});

describe('device profiles', () => {
  /** cf-3 as the agent registers it: profiled, MFARM-named, and still a virtual device. */
  function withProfiled() {
    seed({ name: 'devices' });
    mod.state.devices = [
      ...mod.state.devices,
      {
        id: 'dev-3', region: 'lab', platform: 'android', tier: 'cuttlefish',
        model: 'MFARM X1 Pro', osVersion: '17', state: 'READY', dedicated: false,
        profile: 'mfarm-x1-pro',
        screen: { width: 1080, height: 2340, density: 450 },
        abis: ['x86_64', 'x86'],
        capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset', 'app-install',
          'logcat', 'screenshot', 'ui-hierarchy'],
      },
    ];
    mod.state.available = 2;
  }

  test('a profiled device is named as the handset AND still tagged VIRTUAL', () => {
    // Both halves, in one assertion, on purpose. The name is only defensible while the tag is
    // beside it — if the tag is ever dropped, this is the test that should fail.
    withProfiled();
    const text = textOf(mod.SCREENS.devices());
    assert.match(text, /MFARM X1 Pro/);
    assert.match(text, /VIRTUAL DEVICE/);
  });

  test('the card shows the panel it actually boots with', () => {
    withProfiled();
    assert.match(textOf(mod.SCREENS.devices()), /1080 × 2340 · 450dpi/);
  });

  test('a device that reported no screen shows no geometry row rather than an empty one', () => {
    seed({ name: 'devices' });
    mod.state.devices = [{
      id: 'dev-4', region: 'lab', platform: 'android', tier: 'cuttlefish',
      model: 'cuttlefish', osVersion: '17', state: 'READY', dedicated: false,
      capabilities: ['app-install'],
    }];
    const text = textOf(mod.SCREENS.devices());
    assert.doesNotMatch(text, /Screen/, 'an N-1 worker sends no screen; a "— × —" row is worse than none');
  });

  test('the stage draws a chassis and a punch-hole for a profiled device', () => {
    withProfiled();
    mod.state.route = { name: 'cockpit', id: 'sess-1' };
    // `state.detail`, which is the key the cockpit actually reads. It was `state.sessionDetail`
    // here — a name that appears nowhere in console.js — so this test spread `undefined` and then
    // rendered the UNPROFILED `dev-1` while asserting things about an X1 Pro. Every assertion still
    // passed, because the two it made are true of every device.
    mod.state.detail = { ...mod.state.detail, deviceId: 'dev-3' };
    mod.state.stage = null;
    const tree = mod.SCREENS.cockpit();
    const classes = classesOf(tree);
    assert.ok(classes.includes('mf-chassis'), 'the phone body');
    assert.ok(classes.includes('mf-glass'), 'the screen box, which carries the panel radius');

    /**
     * THE RAILS ARE THE ASSERTION THAT CARRIES THIS TEST.
     *
     * `mf-chassis`, `mf-glass` and `mf-cutout` are built once with the panel and exist for EVERY
     * device, profiled or not — the cutout is merely `hidden` when there is none — so asserting
     * them proves the frame was built and nothing more. A rail is different: `frameFor` returns an
     * EMPTY rail list for the neutral chassis, so a rail element exists only when the resolver
     * matched a real profile. It is the one line here that fails if the device never resolves and
     * the frame silently falls back to unprofiled.
     *
     * It is also the line that would have caught the old crash. Rails are the one piece of chrome
     * built element-by-element, and `h()` writes styles as `Object.assign(node.style, value)` — a
     * string there spreads across the indices `0`, `1`, `2`… A real `CSSStyleDeclaration` throws on
     * that; the shim used to accept it. Both halves are fixed, and this reaches the code.
     */
    assert.ok(classes.includes('mf-rail'), 'the volume and power keys down the right edge');

    // And the punch-hole is actually SHOWN, not merely present. `hidden` is how a frame with no
    // cutout is drawn, so "the element exists" and "this device has a camera" are separate facts.
    const cutout = findByClass(tree, 'mf-cutout');
    assert.ok(cutout, 'the cutout element');
    assert.equal(cutout.hidden, false, 'an X1 Pro has a punch-hole and it is drawn');
  });

  test('an unprofiled device still renders — the neutral chassis is the ordinary case', () => {
    // Two of this farm's four devices are deliberately unprofiled, every physical handset is, and an
    // N-1 worker profiles nothing. This path is the common one and must never look like an error.
    seed({ name: 'cockpit', id: 'sess-1' });
    mod.state.stage = null;
    const tree = mod.SCREENS.cockpit();
    assert.ok(countElements(tree) > 0);
    assert.ok(classesOf(tree).includes('mf-glass'), 'the screen is still drawn');

    /**
     * AND IT HAS NO CUTOUT, which is the honest half rather than an omission.
     *
     * We do not know where this device's camera is, so drawing one would be inventing data — and
     * the whole point of the neutral chassis is that it is honest about what the farm knows:
     * geometry, and nothing more.
     */
    assert.equal(findByClass(tree, 'mf-cutout')?.hidden, true, 'no camera is invented');
    assert.ok(!classesOf(tree).includes('mf-rail'), 'no side keys are invented either');
  });

  test('an unknown profile falls back instead of blanking the panel', () => {
    // A worker can be a version ahead of the console it is registering with. A profile added after
    // this file was written must render as a plain phone, not take out the whole live view.
    seed({ name: 'cockpit', id: 'sess-1' });
    mod.state.devices[0].profile = 'mfarm-x9-from-the-future';
    mod.state.stage = null;
    assert.ok(classesOf(mod.SCREENS.cockpit()).includes('mf-glass'));
  });

  /**
   * The frame's SHAPE comes from the device's own pixels, never from the profile table.
   *
   * A 720×1280 device is visibly stubbier than a 1080×2340 one and it must be — screen shape is the
   * reason somebody chose a device, so the frame is where that difference becomes visible before
   * they start testing. This is the assertion that fails if the aspect is ever taken from the table
   * instead, which would draw a shape the device is not.
   */
  test('the panel aspect is the device\'s reported geometry', () => {
    withProfiled();
    mod.state.route = { name: 'cockpit', id: 'sess-1' };
    mod.state.detail = { ...mod.state.detail, deviceId: 'dev-3' };
    mod.state.stage = null;
    mod.SCREENS.cockpit();

    const frame = mod.state.stage.dom.root;
    assert.equal(frame.style['--f-aspect'], String(1080 / 2340));
  });
});

/**
 * THE COPY RULES, asserted rather than reviewed.
 *
 * Copy is the part of a design that decays fastest, because every one of these sentences is one
 * edit away from being replaced by something shorter that means something slightly different — and
 * nothing in a code review reliably catches "this button now promises an outcome it cannot
 * produce". These tests are the rules from the copy deck, in the places they apply.
 */
describe('the copy rules hold', () => {
  /**
   * THE ONE RULE UNDER ALL OF IT: a device is addressed by what it IS.
   *
   * Internal vocabulary — tier, cuttlefish, fence, host id, region code — belongs in a details
   * panel or a copyable field, never in a button or a heading. It is not banned, it is PLACED: the
   * mono register tells the reader a string came from the machine rather than from us, which is
   * exactly why it can stay where it is genuinely useful.
   */
  test('no button or heading names the stack', () => {
    seed({ name: 'devices' });
    // Nobody is holding it, so the card offers the primary action rather than "View session".
    mod.state.sessions = [];
    mod.state.held = null;
    const text = textOf(mod.SCREENS.devices());
    assert.doesNotMatch(text, /on tier /i, 'a tier is not something a person chose');
    assert.doesNotMatch(text, /Start a session on/i);
    assert.match(text, /Start Unprofiled device/, 'the primary action names the device');
  });

  /**
   * A CAPACITY LINE IS A FRACTION.
   *
   * "3 free" answers "can I get one" and stops. "3 of 4" also answers "is this farm nearly full",
   * which is the question behind it and the one that decides whether somebody starts now or waits.
   */
  test('capacity is stated as a fraction, never a bare count', () => {
    seed({ name: 'launch' });
    const text = textOf(mod.SCREENS.launch());
    assert.match(text, /\d+ of \d+ (free|busy)/, 'the denominator is not decoration');
  });

  /**
   * NO LIVE VIEW IS A PROPERTY OF THE DEVICE, NOT A FAULT.
   *
   * This panel is otherwise identical to the ones reporting a real failure, so the words are the
   * only thing separating "this cannot happen here" from "this went wrong" — and naming what still
   * works is what stops somebody abandoning a device that would have served them fine.
   */
  test('a device with no screen-stream is not described as broken', () => {
    seed({ name: 'cockpit', id: 'sess-1' });
    mod.state.devices[0].capabilities = ['app-install', 'webdriver', 'logcat'];
    mod.state.stage = null;
    const text = textOf(mod.SCREENS.cockpit());
    assert.match(text, /property of the device, not a fault/);
    /**
     * The list GREW with stage 5, and the growth is the point. It used to name four capabilities
     * and omit keyboard and launch, so somebody deciding whether this device was worth keeping read
     * a shorter list than the device actually has. Document 04 S2 heads it "Everything else works":
     * only the three that need pixels do not.
     */
    assert.match(text, /Input, keyboard, install, launch, logcat and WebDriver are all live/);
    assert.doesNotMatch(text, /failed|error/i, 'nothing here went wrong');
  });

  /**
   * BEING QUEUED SAYS THAT THE PAGE MOVES ON BY ITSELF.
   *
   * A rank alone — "Queue 4", "Position 4 of 6" — leaves the reader to work out whether they have
   * to keep watching. And there is deliberately NO ETA: producing one needs every current holder's
   * lease time, which the sessions list does not return, so a number here would be invented.
   */
  test('the queued state promises the handover and estimates nothing', () => {
    seed({ name: 'launching', id: 'sess-q' });
    mod.state.sessions = [{
      id: 'sess-q', state: 'QUEUED', deviceId: null, region: 'lab',
      createdAt: new Date().toISOString(), startedAt: null, expiresAt: null,
      endedAt: null, endReason: null,
    }];
    mod.state.bringup = { sessionId: 'sess-q', appId: null, launchAfter: false, install: null, launch: null, error: null };
    // `screenLaunching` reads `state.detail`, not the list — the list is what `queueNote` ranks
    // against, so both are needed and they are two different reads.
    mod.state.detail = { ...mod.state.sessions[0], fetchedAt: Date.now() };
    const text = textOf(mod.SCREENS.launching('sess-q'));
    assert.match(text, /moves on by itself/);
    assert.doesNotMatch(text, /about \d+ minutes|estimated|ETA/i,
      'the API does not report other tenants\' lease times, so any estimate here is invented');
  });

  /**
   * A DESTRUCTIVE-ADJACENT BUTTON NAMES THE AUTHORISATION, NOT AN OUTCOME.
   *
   * Releasing a quarantine does not return the device to the pool; it permits one restart and one
   * health check, and only a passing check puts it back. The green safety line has to survive too,
   * because it is the last thing read before the click.
   */
  test('the quarantine gate promises only what it can deliver', () => {
    seed({ name: 'device', id: 'dev-1' });
    mod.state.devices[0].state = 'QUARANTINED';
    mod.state.devices[0].quarantine = { at: new Date().toISOString(), reason: 'frozen', source: 'health' };
    const text = textOf(mod.SCREENS.device('dev-1'));
    assert.match(text, /Authorise one recovery attempt/);
    assert.match(text, /only a passing (health )?check/i, 'the safety property, immediately above the button');
  });

  /**
   * IDLE IS NOT PROGRESS.
   *
   * `ensureLive` returns without starting anything when a session carries no browser route to the
   * data plane, leaving `liveState` at its initial `idle`. The overlay's `default:` arm used to
   * catch that alongside the three real negotiation states, so the panel drew a ring at 80% and
   * "Negotiating the media connection" for a connection nobody had attempted — a bar filling for
   * something that is not happening, which is the exact motion this console refuses to ship. It
   * also contradicted the panel beside it, which was already saying there were no data-plane
   * coordinates.
   *
   * Found by opening the page and reading it, not by a test — 80 of these were green while it was
   * on screen. That is the argument for looking at the thing.
   */
  test('a session with no data-plane route does not pretend to be connecting', () => {
    seed({ name: 'cockpit', id: 'sess-1' });
    mod.state.liveState = 'idle';
    mod.state.stage = null;
    const text = textOf(mod.SCREENS.cockpit());
    assert.doesNotMatch(text, /Negotiating the media connection/,
      'nothing is being negotiated — there is no route to negotiate over');
    assert.doesNotMatch(text, /\d+\s*%/, 'a percentage nobody reported is an invented number');
    assert.match(text, /no route to the data plane/i);
    assert.match(text, /WebDriver still works/, 'what does work is the half that keeps somebody moving');
  });

  /**
   * DEPTH IS A STATE VARIABLE, and the frame has to be told which one.
   *
   * `stageState` first tested for the LiveSession OBJECT, which exists from the moment a socket
   * opens and says nothing about whether anything is on screen — so a cockpit mid-negotiation
   * reported `off`, the shadow never landed, and the whole mechanic silently did nothing while
   * looking implemented. It reads the state machine now, which is what the overlay beside it reads.
   */
  test('the frame reports the panel state the live view is actually in', () => {
    seed({ name: 'cockpit', id: 'sess-1' });

    for (const [liveState, expected] of [
      ['idle', 'off'],
      ['connecting', 'waking'],
      ['negotiating', 'waking'],
      ['streaming', 'live'],
      ['nostream', 'nosignal'],
      ['failed', 'off'],
    ] as const) {
      mod.state.liveState = liveState;
      mod.state.stage = null;
      const tree = mod.SCREENS.cockpit();
      const frame = findByClass(tree, 'mf-device');
      assert.equal(frame?.dataset.state, expected, `liveState "${liveState}" should draw "${expected}"`);
    }
  });

  /**
   * A SESSION THAT ENDED SAYS WHO ENDED IT AND WHEN.
   *
   * "Session ended" is the state, and the state is the least useful thing to tell somebody looking
   * at a screen that visibly stopped. The reasons are keyed on the literals the control plane
   * actually writes — a merely plausible key falls through to the generic word while looking as
   * though it explained something.
   */
  test('an ended session explains itself from real end reasons', () => {
    seed({ name: 'cockpit', id: 'sess-1' });
    mod.state.sessions = [{
      ...mod.state.sessions[0],
      state: 'ENDED', endReason: 'client_request',
      endedAt: new Date().toISOString(),
      startedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
    }];
    mod.state.detail = { ...mod.state.sessions[0] };
    mod.state.stage = null;
    const text = textOf(mod.SCREENS.cockpit());
    assert.match(text, /Released by you/);
    assert.match(text, /back in the pool/);
  });
});


/**
 * THE FLEET SURFACE — direction B, one route with four lenses.
 *
 * Devices, Sessions and Queue answered one question between them: can I get a device right now, and
 * if not, why not. They are lenses now. The tests that matter most here are not the ones that check
 * the table renders — they are the ones that check the OLD ROUTES STILL LAND, because that promise
 * is what makes the merge safe to ship to people with bookmarks and muscle memory.
 */
describe('the fleet', () => {
  test('every lens builds a tree', () => {
    for (const lens of ['capacity', 'catalogue', 'live', 'waiting']) {
      seed({ name: 'fleet' });
      mod.state.lens = lens;
      const tree = mod.SCREENS.fleet();
      assert.ok(countElements(tree) > 0, `the ${lens} lens rendered nothing`);
    }
  });

  /**
   * `#/devices`, `#/sessions` and `#/queue` each land on the lens that used to be that page. A
   * bookmark, a link in a runbook and a `G` shortcut all go through here, so this is the test that
   * fails if somebody later "tidies up" the redirect table.
   */
  test('the three merged routes still resolve, onto the right lens', () => {
    for (const [hash, lens] of [
      ['#/devices', 'capacity'],
      ['#/sessions', 'live'],
      ['#/queue', 'waiting'],
      ['#/fleet', 'capacity'],
      ['#/fleet/catalogue', 'catalogue'],
    ] as const) {
      const route = mod.parseHash(hash);
      assert.equal(route.name, 'fleet', `${hash} should reach the fleet`);
      assert.equal(route.lens, lens, `${hash} should open the ${lens} lens`);
    }
  });

  /**
   * AND THE DETAIL ROUTES ARE UNTOUCHED. `#/devices/<id>` is the operator's page and was never one
   * of the three; `#/sessions/<id>` is the cockpit. Collapsing their parents must not swallow them.
   */
  test('the detail routes are not swallowed by the merge', () => {
    assert.deepEqual(
      { name: mod.parseHash('#/devices/abc').name, id: mod.parseHash('#/devices/abc').id },
      { name: 'device', id: 'abc' },
    );
    assert.equal(mod.parseHash('#/sessions/xyz').name, 'cockpit');
  });

  /**
   * An unknown hash lands on the fleet rather than on a blank page — it is the console's front door
   * now, the way Devices was.
   */
  test('an unknown route falls back to the fleet', () => {
    assert.equal(mod.parseHash('#/nonsense').name, 'fleet');
  });

  /**
   * THE CATALOGUE PROMISES ONLY WHAT EVERY DEVICE IN THE CLASS CAN DO.
   *
   * A class is what the allocator hands over (ADR-0025), so advertising a capability that two of
   * three devices declare is advertising a coin toss. The intersection is the only honest set.
   */
  test('a class advertises the intersection of its devices capabilities', () => {
    seed({ name: 'fleet' });
    mod.state.lens = 'catalogue';
    mod.state.devices = [
      { ...mod.state.devices[0], id: 'a', profile: 'mfarm-x1-pro', capabilities: ['app-install', 'logcat', 'screenshot'] },
      { ...mod.state.devices[0], id: 'b', profile: 'mfarm-x1-pro', capabilities: ['app-install', 'logcat'] },
    ];
    const text = textOf(mod.SCREENS.fleet());
    assert.match(text, /app-install/);
    assert.match(text, /logcat/);
    assert.doesNotMatch(text, /screenshot/,
      'only one of the two devices declares screenshot; the class cannot promise it');
  });

  /**
   * A class with nothing free still offers the queue, and says so. ADR-0025 made the allocator
   * queue rather than substitute, so this button is the whole point of that decision being visible.
   */
  test('a fully booked class offers the queue rather than nothing', () => {
    seed({ name: 'fleet' });
    mod.state.lens = 'catalogue';
    mod.state.devices = [{ ...mod.state.devices[0], profile: 'mfarm-x1-pro', state: 'SESSION_ACTIVE' }];
    const text = textOf(mod.SCREENS.fleet());
    assert.match(text, /0 of 1 free/);
    assert.match(text, /Join the queue/);
  });

  /**
   * AND A CLASS NOTHING WILL COME BACK FROM MUST NOT OFFER ONE.
   *
   * The allocator only ever promotes a queued session onto a READY device, so a queue behind a
   * quarantined class is one that is never served — the button buys a session that waits forever
   * and looks completely reasonable while doing it.
   *
   * The first draft offered it, because it only asked whether anything was FREE. The launch picker
   * has made this exact busy-versus-unavailable distinction for months; the catalogue missed it one
   * screen over, which is what a new surface built from the same data does when the reasoning is
   * not carried across with it.
   */
  test('a class that is out of the pool does not offer a queue nobody would serve', () => {
    seed({ name: 'fleet' });
    mod.state.lens = 'catalogue';
    mod.state.devices = [{
      ...mod.state.devices[0], profile: 'mfarm-x1-pro', state: 'QUARANTINED',
      quarantine: { at: new Date().toISOString(), reason: 'adb keeps dropping', source: 'health' },
    }];
    const text = textOf(mod.SCREENS.fleet());
    assert.doesNotMatch(text, /Join the queue/,
      'the allocator only promotes onto READY — this queue would never be served');
    assert.match(text, /never be served/, 'and it has to say why the button is absent');
  });

  /**
   * The flagship leads. Sorting alphabetically put "MFARM X1" above "MFARM X1 Pro", so the cheaper
   * sibling led the one page that is also a sales surface.
   */
  test('the flagship comes before the standard class', () => {
    seed({ name: 'fleet' });
    mod.state.lens = 'catalogue';
    const base = mod.state.devices[0];
    mod.state.devices = [
      { ...base, id: 'x1', profile: 'mfarm-x1', state: 'READY' },
      { ...base, id: 'pro', profile: 'mfarm-x1-pro', state: 'READY' },
    ];
    const text = textOf(mod.SCREENS.fleet());
    assert.ok(
      text.indexOf('FLAGSHIP') < text.indexOf('STANDARD'),
      'the flagship should lead the catalogue',
    );
  });
});


/**
 * THE COCKPIT RAIL — a control the device cannot honour is VISIBLE and inert, never removed.
 *
 * Document 04 S2 and `RailControl` in 07 both require it, and the console removed two of them:
 * `caps.includes('screenshot') ? toolBtn(…) : null`. A person on a device without `screenshot` got
 * a rail with a gap in it and no way to learn why — the same lie by omission as filtering an
 * undeclared capability out of the chip list, which this console has always been careful not to do.
 *
 * These tests are written against the RENDERED RAIL rather than against `toolBtn`, because the bug
 * was at the call site: the component was innocent and the ternary in front of it was not.
 */
describe('the cockpit rail explains what it cannot do', () => {
  function railFor(caps: string[]) {
    seed({ name: 'cockpit', id: 'sess-1' });
    mod.state.devices[0].capabilities = caps;
    mod.state.liveState = 'streaming';
    mod.state.stage = null;
    const tree = mod.SCREENS.cockpit();
    return { tree, bar: findByClass(tree, 'devbar') };
  }

  /** A control per rail entry, whether or not the device can honour it. */
  const buttons = (bar: { children: unknown[] }) =>
    (bar?.children ?? []).filter((n: any) => typeof n?.className === 'string' && n.className.includes('devbtn'));

  /**
   * `title` is an ATTRIBUTE, not a property.
   *
   * `h()` routes everything it does not special-case through `setAttribute`, and the shim keeps
   * those in `attrs` — so `b.title` is `undefined` and an assertion against it passes or fails for
   * the wrong reason. Read it the way it is actually stored.
   */
  const titleOf = (b: any): string => b.getAttribute?.('title') ?? '';

  test('the rail is the same length with and without the optional capabilities', () => {
    const rich = buttons(railFor([
      'screen-stream', 'input-datachannel', 'screenshot', 'ui-hierarchy', 'logcat',
    ]).bar as never);
    const poor = buttons(railFor(['screen-stream', 'input-datachannel']).bar as never);

    assert.ok(rich.length > 0, 'the rail rendered no controls at all');
    assert.equal(
      poor.length, rich.length,
      'controls vanished when the capability did — the reader cannot see what is missing',
    );
  });

  /**
   * AND THE ONES IT CANNOT HONOUR SAY SO. The class is what draws the dash and the strike; the
   * tooltip is what names the capability. Both matter: the first is seen, the second is read.
   */
  test('an undeclared control is marked, disabled, and names the capability', () => {
    const { bar } = railFor(['screen-stream', 'input-datachannel']);
    const undeclared = buttons(bar as never).filter((b: any) => b.className.includes('undeclared'));

    assert.ok(undeclared.length >= 2, 'screenshot and the inspector should both be marked');
    for (const b of undeclared as any[]) {
      assert.equal(b.disabled, true, 'a control the device cannot honour must be inert');
      assert.match(titleOf(b), /does not declare/, `no reason given: ${titleOf(b)}`);
      assert.match(titleOf(b), /screenshot|ui-hierarchy/, `the tooltip must name the capability: ${titleOf(b)}`);
    }
  });

  /**
   * A DEVICE THAT DECLARES NO STREAM CAN NEVER ZOOM, and the rail has to say so.
   *
   * 04 S2 names zoom and fullscreen alongside screenshot: they need the stream. Gating them on the
   * transport alone tells a person with a no-video device "not available until the live view is
   * connected" — a live view that is never coming. This farm's physical handset is exactly that
   * device, which is how the gap was found: I claimed it would demonstrate the undeclared rail and
   * then read its capabilities, and it declares screenshot and ui-hierarchy but NOT screen-stream.
   */
  test('zoom and fit are struck on a device that declares no stream', () => {
    const { bar } = railFor(['input-datachannel', 'screenshot', 'ui-hierarchy', 'logcat']);
    const marked = buttons(bar as never).filter((b: any) => b.className.includes('undeclared'));
    const reasons = marked.map((b: any) => titleOf(b));

    assert.ok(
      reasons.some((t: string) => /Zoom in .*does not declare screen-stream/.test(t)),
      `zoom should be struck on a no-stream device, got: ${JSON.stringify(reasons)}`,
    );
    assert.ok(
      reasons.some((t: string) => /Fit to panel .*does not declare screen-stream/.test(t)),
      'fit should be struck too',
    );
    // And the ones it CAN honour are not struck — the whole point is telling them apart.
    assert.ok(
      !reasons.some((t: string) => /Screenshot/.test(t)),
      'this device declares screenshot; it must not be marked undeclared',
    );
  });

  /**
   * NOT YET IS NOT NOT EVER, and this is the assertion that stops the two collapsing back into one
   * appearance. A control waiting on the stream comes good on its own; one the device cannot honour
   * never will. Stage 2 gave both the dashed border, which said "not ever" to both.
   */
  test('a control waiting for the stream is not marked as undeclared', () => {
    seed({ name: 'cockpit', id: 'sess-1' });
    mod.state.devices[0].capabilities = ['screen-stream', 'input-datachannel', 'screenshot', 'ui-hierarchy'];
    // Attached, but no video yet — zoom and the inspector are waiting, not impossible.
    mod.state.liveState = 'negotiating';
    mod.state.stage = null;
    const bar = findByClass(mod.SCREENS.cockpit(), 'devbar');

    const marked = buttons(bar as never).filter((b: any) => b.className.includes('undeclared'));
    assert.deepEqual(marked, [], 'the device declares these — they are merely not ready yet');

    const waiting = buttons(bar as never).filter((b: any) => b.disabled);
    assert.ok(waiting.length > 0, 'something should be waiting on the stream in this state');
    for (const b of waiting as any[]) {
      assert.doesNotMatch(titleOf(b), /does not declare/,
        'a control waiting for the stream must not claim the device lacks the capability');
    }
  });
});

/* ==================================================================== device detail (05 §03) ===
 *
 * The operator's page. Every assertion below is about a SENTENCE rather than about a layout,
 * because the failure mode this screen has is not a broken render — it is a sentence that was true
 * when it was written and describes something the console no longer does.
 */
describe('device detail', () => {
  /** A device out of the pool, with an audit log that knows who took it out. */
  function quarantined(opts: { actor?: string | null; reason?: string | null } = {}) {
    const { device } = seed({ name: 'device', id: 'dev-1' });
    device.state = 'QUARANTINED';
    (device as any).quarantine = {
      at: new Date(Date.now() - 86_400_000).toISOString(),
      reason: opts.reason === undefined ? 'adb keeps dropping mid-session' : opts.reason,
      source: 'operator',
    };
    mod.state.quarantineLog = {
      id: 'dev-1',
      loaded: true,
      events: opts.actor === null ? [] : [{
        event: 'quarantined',
        actor: opts.actor ?? 'admin@mfarm.local',
        reason: opts.reason === undefined ? 'adb keeps dropping mid-session' : opts.reason,
        occurredAt: new Date(Date.now() - 86_400_000).toISOString(),
      }],
    };
    return device;
  }

  test('it names the class, the short id, the tier and the region', () => {
    seed({ name: 'device', id: 'dev-1' });
    const text = textOf(mod.SCREENS.device());
    assert.match(text, /Unprofiled device/, 'the title is what the device IS');
    assert.match(text, /dev-1 · cuttlefish · lab/,
      'the identity line is how you name this device in a log line or a support message');
    assert.match(text, /Virtual device/, 'and what kind of thing it is');
  });

  test('a real device is badged as one', () => {
    const { device } = seed({ name: 'device', id: 'dev-1' });
    device.tier = 'physical';
    device.model = 'SM-S918B';
    assert.match(textOf(mod.SCREENS.device()), /Real device/);
  });

  /**
   * THE LIST DOES NOT CARRY `lastResetAt`, AND THIS SCREEN USED TO READ THE LIST.
   *
   * So "Last reset" said "not reported" for every device in the fleet, forever — a field that
   * looked like a farm which had never reset anything. The merge is what fixes it, and the merge is
   * what this asserts: a field present ONLY in the detail read has to reach the page.
   */
  test('a field only the detail read carries reaches the page', () => {
    seed({ name: 'device', id: 'dev-1' });
    // Deliberately not on `state.devices[0]` — the poll row has never had these.
    mod.state.deviceDetail = {
      id: 'dev-1',
      loaded: true,
      device: {
        ...mod.state.devices[0],
        lastResetAt: new Date(Date.now() - 7_200_000).toISOString(),
        hostLastSeenAt: new Date(Date.now() - 172_800_000).toISOString(),
      },
    };
    const text = textOf(mod.SCREENS.device());
    assert.doesNotMatch(text, /Last reset\s+not reported/,
      'the detail read carries a reset time; showing "not reported" means the poll row won the merge');
    assert.match(text, /Host last seen/);
    assert.match(text, /2d ago/);
  });

  /**
   * "Host last seen", not "Last seen". A device can be unplugged from a host that is beating
   * perfectly, and a row labelled for the device would then be reassuring about the wrong machine.
   */
  test('the heartbeat row says whose heartbeat it is', () => {
    seed({ name: 'device', id: 'dev-1' });
    const text = textOf(mod.SCREENS.device());
    assert.match(text, /Host last seen/);
  });

  test('the reset story names which of the three resets this device has', () => {
    const { device } = seed({ name: 'device', id: 'dev-1' });
    assert.match(textOf(mod.SCREENS.device()), /Reset story\s+snapshot-reset/);

    device.capabilities = device.capabilities.filter((c: string) => c !== 'snapshot-reset');
    assert.match(textOf(mod.SCREENS.device()), /none declared/,
      'a device with no reset is never handed out; this row is where an operator learns why');
  });

  describe('the quarantine gate', () => {
    /**
     * THE CONTRACT, ON THE PAGE. It used to live only behind the confirm dialog — read by somebody
     * who has already decided. Each of these three is a thing a person reasonably expects a
     * "release" button to do, and none of them is true (ADR-0024).
     */
    test('it states what authorising recovery will and will not do', () => {
      quarantined();
      const text = textOf(mod.SCREENS.device());
      assert.match(text, /Authorising recovery does one thing/);
      assert.match(text, /Permits\s+one\s+recovery attempt/);
      assert.match(text, /not\s+return the device to the pool/);
      assert.match(text, /not\s+clear the quarantine note/);
      assert.match(text, /the device stays out and the failure is recorded/);
      assert.match(text, /No session can be started on this device until a check passes/);
    });

    /**
     * The mark is not the message. Somebody who cannot tell the arrow from the cross by colour
     * still has to read three sentences that say "does not".
     */
    test('every consequence reads correctly without its arrow or cross', () => {
      quarantined();
      const marks = classesOf(mod.SCREENS.device()).filter((c) => c === 'csq-mark');
      assert.equal(marks.length, 4, 'one mark per consequence');
      const text = textOf(mod.SCREENS.device()).replace(/[→×]/g, '');
      assert.match(text, /It does\s+not\s+return the device to the pool/);
    });

    test('it names who took the device out, from the audit log', () => {
      quarantined({ actor: 'admin@mfarm.local' });
      const text = textOf(mod.SCREENS.device());
      assert.match(text, /Taken out by/);
      assert.match(text, /admin@mfarm\.local/);
      assert.match(text, /adb keeps dropping mid-session/);
      assert.match(text, /will not hand this device to anybody while it is quarantined/);
    });

    /**
     * A HEALTH CHECK HAS NO ACTOR, and a quarantine older than the audit log has neither actor nor
     * note. Building the sentence as a template with holes produces "Taken out by  with the note"
     * on exactly the oldest, most confusing rows in the fleet.
     */
    test('with no actor and no note it is still a sentence', () => {
      quarantined({ actor: null, reason: null });
      const text = textOf(mod.SCREENS.device());
      assert.doesNotMatch(text, /Taken out by\s+with/);
      assert.doesNotMatch(text, /the note\s*\./);
      assert.doesNotMatch(text, /undefined|null/);
      assert.match(text, /An operator took it out of service/,
        'the source is what is known, so the source is what it says');
    });

    /**
     * Not softened by a quiet variant — see the note under document 05 §03. A destructive action
     * drawn as a secondary button reads as reversible, and this one authorises a device restart.
     */
    test('the destructive button keeps the solid variant', () => {
      quarantined();
      assert.ok(findByClass(mod.SCREENS.device(), 'danger-solid'),
        'quarantine and release exist to be used correctly, not gently');
    });

    test('a member sees no button and is told what release would have done', () => {
      quarantined();
      mod.state.me.role = 'member';
      const text = textOf(mod.SCREENS.device());
      assert.doesNotMatch(text, /Authorise one recovery attempt/);
      assert.match(text, /Only an owner or an admin/);
      assert.match(text, /only a passing check returns the device to the pool/i,
        'a member who cannot press it still needs to know the button does not make it available');
    });

    /**
     * A HOST QUARANTINE IS A DIFFERENT STORY, and the page used to tell the wrong one.
     *
     * Found on the deployed farm. The page printed "It comes back on its own when the host beats
     * again" and then offered "Authorise one recovery attempt" above a list explaining that only a
     * health check can return it — two true sentences that contradict each other, one of them
     * attached to a red button. Pressing it asks the host that is not answering, times out, and
     * quarantines the device again with a new reason.
     */
    describe('a host quarantine', () => {
      function hostQuarantined() {
        const { device } = seed({ name: 'device', id: 'dev-1' });
        device.state = 'QUARANTINED';
        (device as any).quarantine = {
          at: new Date(Date.now() - 25_200_000).toISOString(),
          reason: 'its host was quarantined: no heartbeat for 90s',
          source: 'host',
        };
        mod.state.deviceDetail = {
          id: 'dev-1',
          loaded: true,
          device: { ...device, hostLastSeenAt: new Date(Date.now() - 25_200_000).toISOString() },
        };
        mod.state.quarantineLog = { id: 'dev-1', loaded: true, events: [] };
        return device;
      }

      test('it says the device returns on its own, and does not claim a check is the only way', () => {
        hostQuarantined();
        const text = textOf(mod.SCREENS.device());
        assert.match(text, /comes back on its own/);
        assert.match(text, /returns to the pool\s+automatically/);
        assert.doesNotMatch(text, /Authorising recovery does one thing/,
          'that list is about a device-level quarantine and contradicts the sentence above it here');
      });

      test('it names what pressing the button would actually cost', () => {
        hostQuarantined();
        const text = textOf(mod.SCREENS.device());
        assert.match(text, /this host is not answering/);
        assert.match(text, /times out and quarantines the device again/);
        assert.match(text, /last heard from that host 7h ago/,
          'the deciding fact belongs beside the decision');
      });

      /**
       * The action stays — an admin may know the host is coming back — but out of the solid
       * variant, which is reserved for the action that is the right one to take.
       */
      test('the action is offered, demoted, and renamed', () => {
        hostQuarantined();
        const tree = mod.SCREENS.device();
        assert.match(textOf(tree), /Ask for a recovery attempt anyway/);
        assert.equal(findByClass(tree, 'danger-solid'), null,
          'the solid variant would say this is the right thing to do, and it is not');
        assert.ok(findByClass(tree, 'danger'), 'but it must still be reachable');
      });

      /**
       * `quarantine_host` writes the reason and the source from the same fact, so printing both
       * read: "Its host was quarantined. It comes back on its own when the host beats again. The
       * note reads 'its host was quarantined: no heartbeat for 90s'."
       */
      test('the machine-written note is not printed back beside the sentence it came from', () => {
        hostQuarantined();
        const text = textOf(mod.SCREENS.device());
        assert.doesNotMatch(text, /The note reads/);
        assert.match(text, /Its host was quarantined/,
          'the source sentence is the one that carries the fact');
      });

      /**
       * The rule is about WHO WROTE THE NOTE, not about matching strings. A health check has no
       * actor either, and its detail is an independent fact worth every character.
       */
      test("a health check's detail is still shown, though it also has no actor", () => {
        const { device } = seed({ name: 'device', id: 'dev-1' });
        device.state = 'QUARANTINED';
        (device as any).quarantine = {
          at: new Date().toISOString(),
          reason: 'device did not answer adb within 30s',
          source: 'health',
        };
        mod.state.quarantineLog = { id: 'dev-1', loaded: true, events: [] };
        const text = textOf(mod.SCREENS.device());
        assert.match(text, /device did not answer adb within 30s/);
        assert.match(text, /Authorising recovery does one thing/,
          'a health-check quarantine IS the operator\'s to act on');
      });
    });

    test('a healthy device offers the quarantine action instead', () => {
      seed({ name: 'device', id: 'dev-1' });
      const text = textOf(mod.SCREENS.device());
      assert.match(text, /Take out of service/);
      assert.doesNotMatch(text, /Authorising recovery does one thing/);
    });
  });

  /**
   * THE CAPTION THAT WENT STALE. It used to end "it is why a control that needs it is missing",
   * which described the rail BEFORE stage 5 — and stage 5 made those controls visible and struck
   * through instead of removing them. A caption about another screen is a claim about another
   * screen, and it rots silently when that screen changes.
   */
  test('the capability caption describes the rail as it is now', () => {
    seed({ name: 'device', id: 'dev-1' });
    const text = textOf(mod.SCREENS.device());
    assert.match(text, /visible and disabled/);
    assert.match(text, /never removed/);
    assert.doesNotMatch(text, /is why a control that needs it is missing/,
      'stage 5 stopped removing them; this sentence has to move with it');
  });

  /**
   * The WebDriver endpoint is the FARM's, so it stays correct on a device that is out of the pool —
   * it just has nothing to hand out. The page most likely to be read about a quarantined device
   * used to offer it with no note at all.
   */
  test('the WebDriver card says what happens when the device is not allocatable', () => {
    quarantined();
    const text = textOf(mod.SCREENS.device());
    assert.match(text, /WebDriver endpoint/);
    assert.match(text, /will queue rather than start/);

    seed({ name: 'device', id: 'dev-1' });
    assert.doesNotMatch(textOf(mod.SCREENS.device()), /will queue rather than start/,
      'an available device has nothing to warn about');
  });

  /**
   * "That device is not in this fleet" is a much stronger claim than a console that has not
   * finished loading can make — and it is the sentence a person screenshots and sends to support.
   */
  test('an unknown id waits for the detail read before calling it missing', () => {
    seed({ name: 'device', id: 'nope' });
    mod.state.deviceDetail = { id: 'nope', device: null, loaded: false };
    assert.match(textOf(mod.SCREENS.device()), /Loading/);
    assert.doesNotMatch(textOf(mod.SCREENS.device()), /not in this fleet/);

    mod.state.deviceDetail = { id: 'nope', device: null, loaded: true };
    assert.match(textOf(mod.SCREENS.device()), /not in this fleet/);
  });

  /**
   * A FAILED DETAIL READ MUST NOT BLANK THE PAGE. It costs the four fields only that endpoint
   * carries; the name, the state and the quarantine reason are all in the poll row already, and
   * those are what somebody opened this screen for.
   */
  test('a failed detail read still draws everything the poll knows', () => {
    quarantined();
    mod.state.deviceDetail = { id: 'dev-1', device: null, loaded: true };
    const text = textOf(mod.SCREENS.device());
    assert.match(text, /Out of the pool/);
    assert.match(text, /adb keeps dropping mid-session/);
    assert.doesNotMatch(text, /not in this fleet/);
  });

  test('it goes back to the Fleet, which is where devices now live', () => {
    seed({ name: 'device', id: 'dev-1' });
    assert.match(textOf(mod.SCREENS.device()), /Fleet/);
  });
});

/* =============================================================== what a route fetches for itself
 *
 * THE DEFECT NO RENDERED-SCREEN ASSERTION CAN SEE.
 *
 * Every other test in this file seeds `state` and renders. That is the right shape for "does this
 * screen say the correct thing", and it is structurally blind to "does anything ever put data in
 * that state" — the test performs, by hand, precisely the work it should be checking happened.
 *
 * `device` was in the `hashchange` listener and missing from `boot()`. `hashchange` does not fire
 * on load, so the device screen's quarantine history read "Loading…" forever for anybody who opened
 * a device link, refreshed the page, or returned to a bookmark. It worked only if you clicked
 * through from the Fleet, which is the one path a developer always takes.
 */
describe('a route fetches what its screen needs', () => {
  /** Record every url `api()` reaches for, and answer each one with an empty, valid body. */
  function recording() {
    const urls: string[] = [];
    (globalThis as any).fetch = async (url: string) => {
      urls.push(String(url));
      return { ok: true, status: 200, text: async () => '{}' };
    };
    return urls;
  }

  const realFetch = (globalThis as any).fetch;
  after(() => { (globalThis as any).fetch = realFetch; });

  test('the device screen asks for the device AND its audit log', async () => {
    seed({ name: 'device', id: 'dev-1' });
    const urls = recording();
    await mod.loadForRoute();
    assert.ok(urls.some((u) => u === '/v1/devices/dev-1'),
      'the detail read carries lastResetAt and hostLastSeenAt, which the fleet poll does not');
    assert.ok(urls.some((u) => u.includes('/quarantine-log')),
      'without this the history card says "Loading…" for as long as the page is open');
  });

  test('the cockpit and the run screen still ask for theirs', async () => {
    seed({ name: 'cockpit', id: 'sess-1' });
    let urls = recording();
    await mod.loadForRoute();
    assert.ok(urls.some((u) => u.includes('/v1/sessions/sess-1')));

    seed({ name: 'run', id: 'run-1' });
    urls = recording();
    await mod.loadForRoute();
    assert.ok(urls.some((u) => u.includes('/v1/runs/run-1')));
  });

  /**
   * A screen with nothing of its own to fetch must not fetch, and must not throw. `boot()` awaits
   * this before the first paint, so a rejection here is a console that never renders at all.
   */
  test('a screen the poll already feeds asks for nothing, quietly', async () => {
    seed({ name: 'fleet' });
    const urls = recording();
    await mod.loadForRoute();
    assert.deepEqual(urls, [], 'the fleet is the 5s poll; a second read on navigation is waste');
  });
});

/* ============================================ the cockpit's four states (document 04, stage 5) ==
 *
 * Every assertion here is about what the panel CLAIMS, because the cockpit's failure mode is not a
 * broken render — it is a control or an indicator that depicts something the control plane never
 * reported.
 */
describe('the cockpit', () => {
  test('the device is the title, and the uuid moves to the identity line', () => {
    seed({ name: 'cockpit', id: 'sess-1' });
    const text = textOf(mod.SCREENS.cockpit());
    assert.match(text, /Unprofiled device/, 'the person is holding a device, not a uuid');
    assert.match(text, /sess-1 · android 17 · 720 × 1280/,
      'the id, the OS and the geometry the DEVICE reported — never the profile table (ADR-0016)');
    assert.match(text, /Fleet/, 'devices live under the Fleet now');
  });

  describe('an action in flight (S3)', () => {
    /**
     * THE BAR THAT CONTRADICTED THE SENTENCE ABOVE IT.
     *
     * This panel drew `.bar.indet` — a 32% sliver sweeping left to right — two lines underneath its
     * own caption promising "You will see the outcome, not a progress bar". The control plane
     * cannot dial a worker, so an app verb has exactly two reportable states: queued, and finished.
     * Document 04: "A filling bar here would be the one lie that discredits the other five."
     */
    test('a queued action shows no bar', () => {
      seed({ name: 'cockpit', id: 'sess-1' });
      mod.state.action = {
        id: 'a9', kind: 'install', state: 'PENDING', appId: 'app-1',
        app: { packageName: 'com.acme.app', label: 'Acme' },
        requestedAt: new Date().toISOString(), finishedAt: null,
      };
      /**
       * Scoped to the action strip, not to the page. `.bar.lease` is elsewhere in the cockpit and
       * is entirely legitimate — it measures elapsed lease time against a real expiry. The rule is
       * not "no bars", it is "no bar without a number behind it".
       */
      const strip = findByClass(mod.SCREENS.cockpit(), 'actionstrip');
      assert.ok(strip, 'the queued action should have a panel at all');
      assert.equal(findByClass(strip, 'indet'), null,
        'nothing has reported progress, so nothing may depict it');
      assert.equal(findByClass(strip, 'bar'), null, 'not a smaller bar either');
      assert.ok(findByClass(strip, 'breathe'), 'a pulse has no extent and cannot read as 40% done');
      assert.match(textOf(strip), /Queued for the worker's next heartbeat/);
    });

    /**
     * NOT "no bars" — "no bar without a number behind it". The moment a worker reports bytes, a
     * bar is measuring something and is legitimate.
     */
    test('a real byte count brings the bar back', () => {
      seed({ name: 'cockpit', id: 'sess-1' });
      mod.state.action = {
        id: 'a9', kind: 'install', state: 'PENDING', appId: 'app-1',
        app: { packageName: 'com.acme.app' },
        requestedAt: new Date().toISOString(),
        bytesDone: 18_400_000, bytesTotal: 42_100_000,
      };
      const strip = findByClass(mod.SCREENS.cockpit(), 'actionstrip');
      assert.ok(findByClass(strip, 'bar'), 'a percentage is legitimate the moment it is real');
      assert.match(textOf(strip), /44%/);
    });

    /** The gap between asking and hearing back is the heartbeat interval, made concrete. */
    test('an outcome says when, and how long after queueing', () => {
      seed({ name: 'cockpit', id: 'sess-1' });
      const t0 = Date.now() - 30_000;
      mod.state.action = {
        id: 'a9', kind: 'install', state: 'DONE', appId: 'app-1',
        app: { packageName: 'com.acme.app' },
        requestedAt: new Date(t0).toISOString(),
        finishedAt: new Date(t0 + 8200).toISOString(),
      };
      const text = textOf(mod.SCREENS.cockpit());
      assert.match(text, /Confirmed by the worker/);
      assert.match(text, /8\.2s after queueing/);
    });

    /** A row from before the column existed has no duration, and one must not be invented. */
    test('an outcome with no requestedAt invents no duration', () => {
      seed({ name: 'cockpit', id: 'sess-1' });
      mod.state.action = {
        id: 'a9', kind: 'install', state: 'DONE', appId: 'app-1',
        app: { packageName: 'com.acme.app' },
        requestedAt: null, finishedAt: new Date().toISOString(),
      };
      assert.doesNotMatch(textOf(mod.SCREENS.cockpit()), /after queueing/);
    });
  });

  describe('after it ended (S4)', () => {
    function ended() {
      const { session, device } = seed({ name: 'cockpit', id: 'sess-1' });
      // A new object rather than mutating the seed's: the fixture's fields are inferred as their
      // literal types, so assigning a string to `endedAt: null` is a type error rather than a test.
      const done = { ...session, state: 'ENDED', endedAt: new Date().toISOString(), endReason: 'client_request' };
      mod.state.sessions = [done];
      mod.state.detail = { ...done, dataPlane: null, ice: null, fetchedAt: Date.now() };
      return { session: done, device };
    }

    test('it accounts for what the session used and produced', () => {
      ended();
      const text = textOf(mod.SCREENS.cockpit());
      assert.match(text, /held for/);
      assert.match(text, /action/);
      assert.match(text, /artifact/);
    });

    /**
     * ADR-0012: the three resets are not interchangeable, and a device may declare none. Writing
     * "reset from snapshot" under a session on an install-reset handset would name a mechanism
     * that did not run.
     */
    test('it names the reset the device actually declares', () => {
      const { device } = ended();
      assert.match(textOf(mod.SCREENS.cockpit()), /snapshot/);

      device.capabilities = device.capabilities.filter((c: string) => c !== 'snapshot-reset');
      const text = textOf(mod.SCREENS.cockpit());
      assert.match(text, /no reset declared/);
      assert.doesNotMatch(text, /reset from snapshot/);
    });

    /**
     * The offer names the CLASS, because that is the only thing ADR-0025 lets the allocator
     * promise — and it is withheld when the class has nothing free, which is entry 51's
     * "Join the queue" mistake in a different place.
     */
    test('it offers another of the same class, and only when one is free', () => {
      const { device } = ended();
      assert.match(textOf(mod.SCREENS.cockpit()), /Start another Unprofiled device/);

      device.state = 'QUARANTINED';
      const text = textOf(mod.SCREENS.cockpit());
      assert.doesNotMatch(text, /Start another/);
      assert.match(text, /will queue you/, 'said, rather than a button that quietly queues them');
    });
  });

  /**
   * WAITING IS NOT ENDING. `live` is false for a QUEUED session because it has no device, so the
   * stage overlay told somebody whose session had not started that it had ended.
   */
  test('a queued session is not described as an ended one', () => {
    const { session } = seed({ name: 'cockpit', id: 'sess-1' });
    const queued = { ...session, state: 'QUEUED', deviceId: null, startedAt: null };
    mod.state.sessions = [queued];
    mod.state.detail = { ...queued, dataPlane: null, ice: null, fetchedAt: Date.now() };
    const text = textOf(mod.SCREENS.cockpit());
    assert.doesNotMatch(text, /Session ended/);
    assert.doesNotMatch(text, /This session has ended/,
      'the Tools rail used `!live` to mean "ended" too');
    assert.match(text, /in line/, 'a queue position is a real fact and this one has it');
    assert.doesNotMatch(text, /held for/, 'nothing was held, so there is nothing to account for');
    assert.match(text, /moves on by itself/,
      'the one thing a waiting person needs to know is that they need not watch');
    assert.doesNotMatch(text, /minutes|ETA|estimate is/,
      'the soonest lease is only an upper bound — no number may be invented here');
  });

  /**
   * The half-list was doing the opposite of its job: it left out keyboard and launch, so somebody
   * deciding whether to keep this device read a shorter capability list than the device has.
   */
  test('a device with no stream names everything that still works', () => {
    const { device } = seed({ name: 'cockpit', id: 'sess-1' });
    device.capabilities = device.capabilities.filter((c: string) => c !== 'screen-stream');
    const text = textOf(mod.SCREENS.cockpit());
    assert.match(text, /Everything else works/);
    assert.match(text, /Input, keyboard, install, launch, logcat and WebDriver/);
    assert.match(text, /property of the device, not a fault/);
  });

  /**
   * The reason changed, so the sentence had to. `GET /v1/sessions` returns `expiresAt` now, so
   * "the API does not report other sessions' lease times" became false — while the answer stayed
   * the same, for a different and still-true reason.
   */
  test('the queue explains its missing estimate with a reason that is still true', () => {
    seed({ name: 'fleet' });
    const text = textOf(mod.SCREENS.fleet());
    assert.doesNotMatch(text, /API does not report other sessions/,
      'expiresAt exists now; that explanation is a leftover');
  });
});
