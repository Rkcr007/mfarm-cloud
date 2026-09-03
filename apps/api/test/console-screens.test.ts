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
import { installDom, countElements, classesOf, textOf } from './dom-shim.ts';

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
   * `console.js` imports `/live.js` and `/profiles.js` — ABSOLUTE URL paths, which are correct in a
   * browser (the origin resolves them) and unresolvable in Node, where `/live.js` means the
   * filesystem root.
   *
   * Rewritten to file URLs in a copy rather than changed at source: the absolute specifier is what
   * makes the console work with no bundler and no import map, and bending the shipped file to suit
   * a test would be the tail wagging the dog.
   *
   * Rewritten by PATTERN rather than one call per file, because the previous form silently did
   * nothing for a specifier it did not name — the next browser module added to the console would
   * have failed every screen test with a module-not-found that points at a temp directory.
   */
  const src = (await readFile(join(PUBLIC, 'console.js'), 'utf8'))
    .replace(/from '\/([\w.-]+\.js)'/g, (_m, file) => `from ${JSON.stringify(pathToFileURL(join(PUBLIC, file)).href)}`);
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
    assert.doesNotMatch(real, /cf_x86_64/, 'a virtual device must not survive the real filter');

    mod.state.deviceKind = 'virtual';
    const virtual = textOf(mod.SCREENS.devices());
    assert.match(virtual, /cf_x86_64/);
    assert.doesNotMatch(virtual, /Pixel 9/);

    mod.state.deviceKind = 'all';
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

  test('the stage draws a body and a punch-hole for a profiled device', () => {
    withProfiled();
    mod.state.route = { name: 'cockpit', id: 'sess-1' };
    // `state.detail`, which is the key the cockpit actually reads. It was `state.sessionDetail`
    // here — a name that appears nowhere in console.js — so this test spread `undefined` and then
    // rendered the UNPROFILED `dev-1` while asserting things about an X1 Pro. Every assertion still
    // passed, because the two it made are true of every device.
    mod.state.detail = { ...mod.state.detail, deviceId: 'dev-3' };
    mod.state.stage = null;
    const classes = classesOf(mod.SCREENS.cockpit());
    assert.ok(classes.includes('dev-body'), 'the phone body');
    assert.ok(classes.includes('dev-cutout'), 'the camera, which sits IN the display on this body');
    /**
     * The SIDE BUTTONS, and this is the assertion that carries the test.
     *
     * `dev-body` and `dev-cutout` are built once with the panel and exist for EVERY device, profiled
     * or not — so asserting them proves the panel was built and nothing more. This one is different:
     * a button only exists when `chromeFor` matched a real profile, so it is the only line here that
     * fails if the device never resolves and the chrome silently falls back to plain.
     *
     * It is also the line that would have caught the crash. Buttons are the one piece of chrome
     * written through `h()`, and `h()` writes styles as `Object.assign(node.style, value)` — a
     * string there spreads across the indices `0`, `1`, `2`… A real `CSSStyleDeclaration` throws on
     * that; the shim used to accept it. Both halves are fixed, and this reaches the code.
     */
    assert.ok(classes.includes('dev-btn-right'), 'the volume and power keys down the right edge');
  });

  test('an unprofiled device still renders — the plain bezel is the ordinary case', () => {
    // Two of this farm's four devices are deliberately unprofiled, every physical handset is, and an
    // N-1 worker profiles nothing. This path is the common one and must never look like an error.
    seed({ name: 'cockpit', id: 'sess-1' });
    mod.state.stage = null;
    const tree = mod.SCREENS.cockpit();
    assert.ok(countElements(tree) > 0);
    assert.ok(classesOf(tree).includes('dev-frame'), 'the screen is still drawn');
  });

  test('an unknown profile falls back instead of blanking the panel', () => {
    // A worker can be a version ahead of the console it is registering with. A profile added after
    // this file was written must render as a plain phone, not take out the whole live view.
    seed({ name: 'cockpit', id: 'sess-1' });
    mod.state.devices[0].profile = 'mfarm-x9-from-the-future';
    mod.state.stage = null;
    assert.ok(classesOf(mod.SCREENS.cockpit()).includes('dev-frame'));
  });
});
