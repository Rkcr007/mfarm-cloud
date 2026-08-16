/**
 * Appium supervisor tests.
 *
 * DELIBERATELY DATABASE-FREE, unlike agent.test.ts next to it. Nothing here touches the control
 * plane, so `node --test --experimental-strip-types test/appium.test.ts` runs on its own with no
 * Postgres and no Docker.
 *
 * The server under supervision is a fake: a few lines of node:http spawned as a real child process,
 * so the process semantics being tested are real ones — a real SIGTERM, a real exit code, a real
 * refused connection on an interface nothing is bound to. It can be told to bind late, to crash on
 * a timer, to never bind at all, or to swallow SIGTERM. What it cannot do is behave like a real
 * Appium; see the header of src/appium.ts for what stays unverified until there is hardware.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, Server, Socket } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { AppiumSupervisor, childEnv, derivePort, type AppiumOptions } from '../src/appium.ts';

/**
 * Stands in for `appium`. Reads the same --address/--port the supervisor hands a real server, so
 * "is it bound to loopback" and "does each device get its own port" are answered by a real listener
 * rather than by inspecting an argv array.
 *
 *   FAKE_READY_AFTER_MS  answer /status with 503 until this long after start
 *   FAKE_CRASH_AFTER_MS  exit(9) this long after start
 *   FAKE_MODE=exit       exit(7) immediately, never binding
 *   FAKE_MODE=no-listen  stay alive forever without binding
 *   FAKE_IGNORE_SIGTERM  trap SIGTERM and keep running
 *   FAKE_ENV_DUMP        write this process's env var NAMES to that path, for the allowlist test
 */
const FAKE_APPIUM = `
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

if (process.env.FAKE_ENV_DUMP) {
  writeFileSync(process.env.FAKE_ENV_DUMP, JSON.stringify(Object.keys(process.env)));
}

const argv = process.argv.slice(2);
const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const mode = process.env.FAKE_MODE ?? 'ok';
const readyAfter = Number(process.env.FAKE_READY_AFTER_MS ?? 0);
const crashAfter = Number(process.env.FAKE_CRASH_AFTER_MS ?? 0);
const t0 = Date.now();

if (process.env.FAKE_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {});
if (crashAfter > 0) setTimeout(() => process.exit(9), crashAfter);

if (mode === 'exit') {
  process.exit(7);
} else if (mode === 'no-listen') {
  setInterval(() => {}, 60_000);
} else {
  createServer((_req, res) => {
    const ready = Date.now() - t0 >= readyAfter;
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ value: { ready, message: 'fake appium', build: { version: 'fake' } } }));
  }).listen(Number(flag('--port')), flag('--address'));
}
`;

let dir: string;
let fakePath: string;
/** Every supervisor a test made, so a failing assertion cannot leak a child process. */
const live: AppiumSupervisor[] = [];
/** Processes a test spawned OUTSIDE a supervisor — deliberate orphans, innocent bystanders. */
const strays: ChildProcess[] = [];
/** Plain listeners a test bound to squat on a port. */
const squatters: Server[] = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mfarm-appium-'));
  fakePath = join(dir, 'fake-appium.mjs');
  await writeFile(fakePath, FAKE_APPIUM);
});

after(async () => {
  for (const s of live) await s.stop().catch(() => {});
  for (const c of strays) { try { if (c.pid) process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const s of squatters) await new Promise<void>((r) => s.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

/** A port the OS says is free right now, so the suite never fights a real Appium on 4723. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/** Test-scaled timings: the logic is the same, the constants are milliseconds instead of minutes. */
async function supervisor(
  opts: Partial<AppiumOptions> & { fakeEnv?: NodeJS.ProcessEnv } = {},
): Promise<AppiumSupervisor> {
  const { fakeEnv, ...rest } = opts;
  const s = new AppiumSupervisor({
    localId: 'test-1',
    command: process.execPath,
    commandArgs: [fakePath],
    port: await freePort(),
    readyTimeoutMs: 3_000,
    pollIntervalMs: 25,
    baseBackoffMs: 40,
    maxBackoffMs: 10_000,
    maxRestarts: 5,
    stableAfterMs: 60_000,
    stopGraceMs: 200,
    env: fakeEnv,
    ...rest,
  });
  live.push(s);
  return s;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(pred: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

function connect(host: string, port: number, timeoutMs = 1_500): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = new Socket();
    c.setTimeout(timeoutMs);
    c.once('connect', () => { c.destroy(); resolve(); });
    c.once('timeout', () => { c.destroy(); reject(new Error('ETIMEDOUT')); });
    c.once('error', (e: Error) => { c.destroy(); reject(e); });
    c.connect(port, host);
  });
}

// ---------------------------------------------------------------- port derivation

describe('derivePort', () => {
  test('gives every device on a host its own port', () => {
    const ports = ['cf-1', 'cf-2', 'cf-3', 'cf-4'].map((id) => derivePort(id));
    assert.deepEqual(ports, [4723, 4724, 4725, 4726]);
    assert.equal(new Set(ports).size, ports.length);
  });

  test('is stable across calls, because the control plane persists the endpoint', () => {
    assert.equal(derivePort('avd-1'), derivePort('avd-1'));
    assert.equal(derivePort('pixel-tablet'), derivePort('pixel-tablet'));
  });

  test('honours a base port, so 4723 is never the only option', () => {
    assert.equal(derivePort('cf-1', 9000), 9000);
    assert.equal(derivePort('cf-2', 9000), 9001);
  });

  test('hashes ids with no trailing number, and stays inside the span', () => {
    const a = derivePort('pixel-tablet');
    const b = derivePort('galaxy-fold');
    assert.notEqual(a, b);
    for (const p of [a, b]) assert.ok(p >= 4723 && p < 4823, `${p} outside the reserved span`);
  });

  test('an id numbered from zero stays inside the span', () => {
    // `(0 - 1) % 100` is -1 in JavaScript, not 99, so `cf-0` used to derive basePort - 1 = 4722:
    // outside the reserved span and possibly owned by something else entirely. Only an operator who
    // numbers devices from zero ever hit it, which is exactly why it would have survived review.
    for (const id of ['cf-0', 'avd-0', 'x-0']) {
      const p = derivePort(id);
      assert.ok(p >= 4723 && p < 4823, `derivePort(${id}) = ${p}, outside the reserved span`);
    }
    assert.equal(derivePort('cf-0', 9000), 9099);
    // ...and still distinct from every device numbered normally.
    assert.notEqual(derivePort('cf-0'), derivePort('cf-1'));
  });

  test('a supervisor binds the port derived from its own device id', async () => {
    const one = new AppiumSupervisor({ localId: 'cf-1' });
    const two = new AppiumSupervisor({ localId: 'cf-2' });
    assert.notEqual(one.port, two.port);
    assert.equal(one.baseUrl, `http://127.0.0.1:${one.port}`);
    assert.equal(two.baseUrl, `http://127.0.0.1:${two.port}`);
  });
});

// ---------------------------------------------------------------- readiness

describe('readiness', () => {
  test('is not reported until /status actually answers', async () => {
    const s = await supervisor({ fakeEnv: { FAKE_READY_AFTER_MS: '600' } });
    const started = s.start();

    // The process is up, but the fake is still answering 503. A supervisor that reported ready on
    // spawn alone would have handed the hub an endpoint that fails the very first session.
    assert.equal(s.startAttempts, 1);
    await sleep(200);
    assert.equal(s.state, 'starting');
    assert.equal(s.healthy(), false);
    assert.equal(s.endpoint, undefined, 'nothing may be advertised before /status answers');

    assert.equal(await started, true);
    assert.equal(s.state, 'ready');
    assert.equal(s.healthy(), true);
    assert.equal(s.endpoint, `http://127.0.0.1:${s.port}`);
    await s.stop();
  });

  test('binds loopback only — a routable Appium port is unauthenticated device control', async () => {
    const s = await supervisor();
    assert.equal(await s.start(), true);

    assert.equal(s.spawnArgs[s.spawnArgs.indexOf('--address') + 1], '127.0.0.1');
    // The hub builds `${base}/session`, so the server has to be at the root.
    assert.equal(s.spawnArgs[s.spawnArgs.indexOf('--base-path') + 1], '/');

    await connect('127.0.0.1', s.port);
    // Proven, not just asserted on the flag: the same port on this host's own LAN address is dead.
    const external = Object.values(networkInterfaces()).flat()
      .find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
    if (external) {
      await assert.rejects(
        connect(external, s.port),
        /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/,
        `port ${s.port} answered on ${external}; Appium must never be routable`,
      );
    }
    await s.stop();
  });

  test('advertiseHost changes the advertised url and never the bind address', async () => {
    const s = await supervisor({ advertiseHost: '10.9.9.9' });
    assert.equal(await s.start(), true);
    assert.equal(s.endpoint, `http://10.9.9.9:${s.port}`);
    assert.equal(s.spawnArgs[s.spawnArgs.indexOf('--address') + 1], '127.0.0.1');
    await s.stop();
  });

  test('a process that never binds fails the attempt rather than hanging', async () => {
    const s = await supervisor({
      readyTimeoutMs: 400,
      maxRestarts: 0,
      fakeEnv: { FAKE_MODE: 'no-listen' },
    });
    assert.equal(await s.start(), false);
    assert.equal(s.healthy(), false);
    assert.ok(await until(() => s.state === 'failed'), `state=${s.state}`);
  });
});

// ---------------------------------------------------------------- crash handling

describe('crash handling', () => {
  test('restarts a crashed server and comes back ready', async () => {
    const s = await supervisor({ maxRestarts: 20, fakeEnv: { FAKE_CRASH_AFTER_MS: '300' } });
    assert.equal(await s.start(), true);
    const firstPid = s.pid;
    assert.ok(firstPid);

    assert.ok(
      await until(() => s.startAttempts >= 2 && s.healthy() && s.pid !== firstPid),
      `expected a restart; state=${s.state} attempts=${s.startAttempts}`,
    );
    assert.equal(s.endpoint, `http://127.0.0.1:${s.port}`);
    await s.stop();
  });

  test('backoff grows between consecutive failures, and is capped', async () => {
    const s = await supervisor({
      baseBackoffMs: 30,
      maxBackoffMs: 120,
      maxRestarts: 6,
      fakeEnv: { FAKE_MODE: 'exit' },
    });
    assert.equal(await s.start(), false);
    assert.ok(await until(() => s.restartDelays.length >= 5, 8_000), 'expected repeated restarts');

    assert.deepEqual(s.restartDelays.slice(0, 5), [30, 60, 120, 120, 120]);
    await s.stop();
  });

  test('gives up after the threshold and stays unhealthy forever', async () => {
    let reason: string | undefined;
    let calls = 0;
    const s = await supervisor({
      baseBackoffMs: 10,
      maxRestarts: 2,
      fakeEnv: { FAKE_MODE: 'exit' },
      onPermanentFailure: (r) => { calls++; reason = r; },
    });

    assert.equal(await s.start(), false);
    assert.ok(await until(() => s.state === 'failed', 5_000), `state=${s.state}`);

    // One initial attempt plus maxRestarts restarts, and then nothing, ever again.
    assert.equal(s.startAttempts, 3);
    assert.equal(calls, 1);
    assert.match(reason ?? '', /consecutive failed starts/);
    assert.equal(s.healthy(), false);
    assert.equal(s.endpoint, undefined);

    await sleep(400);
    assert.equal(s.startAttempts, 3, 'a supervisor that gave up must not restart-loop');
    assert.equal(s.state, 'failed');
    assert.equal(s.healthy(), false);

    // Permanent means permanent — the agent gets restarted, this object does not re-arm itself.
    await assert.rejects(s.start(), /gave up permanently/);
  });
});

// ---------------------------------------------------------------- shutdown

describe('stop', () => {
  test('SIGKILLs a process that ignores SIGTERM, without hanging the drain', async () => {
    const s = await supervisor({ stopGraceMs: 150, fakeEnv: { FAKE_IGNORE_SIGTERM: '1' } });
    assert.equal(await s.start(), true);
    const pid = s.pid!;
    assert.ok(alive(pid));

    const t0 = Date.now();
    await s.stop();
    const took = Date.now() - t0;

    assert.ok(await until(() => !alive(pid), 2_000), `pid ${pid} survived stop()`);
    assert.ok(took >= 150, `stop() returned in ${took}ms — SIGTERM never got its grace period`);
    assert.ok(took < 3_000, `stop() took ${took}ms; a drain must not wait on a wedged driver`);
    assert.equal(s.state, 'stopped');
    assert.equal(s.healthy(), false);
    assert.equal(s.endpoint, undefined);
  });

  test('stops cleanly mid-backoff instead of waiting it out', async () => {
    const s = await supervisor({ baseBackoffMs: 5_000, fakeEnv: { FAKE_MODE: 'exit' } });
    assert.equal(await s.start(), false);
    assert.equal(s.state, 'backoff');

    const t0 = Date.now();
    await s.stop();
    assert.ok(Date.now() - t0 < 1_000, 'stop() waited out the backoff instead of interrupting it');
    assert.equal(s.state, 'stopped');

    const attempts = s.startAttempts;
    await sleep(200);
    assert.equal(s.startAttempts, attempts, 'the supervision loop kept running after stop()');
  });

  test('is idempotent', async () => {
    const s = await supervisor();
    assert.equal(await s.start(), true);
    await s.stop();
    await s.stop();
    assert.equal(s.state, 'stopped');
  });
});

// ---------------------------------------------------------------- environment isolation

describe('child environment', () => {
  test('never hands Appium the fleet registration token', async () => {
    const dump = join(dir, 'env-dump.json');
    // Exactly what the agent process holds in production: the shared secret that authenticates
    // POST /workers/register for the whole fleet, plus the address to spend it at.
    process.env.WORKER_REGISTRATION_TOKEN = 'fleet-wide-secret';
    process.env.CONTROL_PLANE_URL = 'http://control-plane.internal:3000';
    try {
      const s = await supervisor({ fakeEnv: { FAKE_ENV_DUMP: dump } });
      assert.equal(await s.start(), true);

      const seen: string[] = JSON.parse(await readFile(dump, 'utf8'));
      // Appium loads third-party drivers and, with --allow-insecure, runs host-side code on
      // request. A process that is a shell-equivalent on the device must not also be able to
      // enroll new hosts into the fleet.
      assert.ok(!seen.includes('WORKER_REGISTRATION_TOKEN'), 'the registration token reached Appium');
      assert.ok(!seen.includes('CONTROL_PLANE_URL'), 'the control-plane address reached Appium');
      // Still a usable environment, or the allowlist has simply broken Appium instead.
      assert.ok(seen.includes('PATH'), 'PATH must survive the allowlist');
      await s.stop();
    } finally {
      delete process.env.WORKER_REGISTRATION_TOKEN;
      delete process.env.CONTROL_PLANE_URL;
    }
  });

  test('allowlists by name and prefix, and lets an operator widen it deliberately', () => {
    const parent = {
      PATH: '/usr/bin',
      WORKER_REGISTRATION_TOKEN: 'secret',
      CONTROL_PLANE_URL: 'http://cp',
      DATABASE_URL: 'postgres://secret',
      ANDROID_HOME: '/opt/android',
      APPIUM_HOME: '/opt/appium',
      WEIRD_DRIVER_VAR: 'needed',
    };
    const tight = childEnv(parent);
    assert.deepEqual(
      Object.keys(tight).sort(),
      ['ANDROID_HOME', 'APPIUM_HOME', 'PATH'],
      'an allowlist must fail closed — anything not named or prefixed is dropped',
    );

    // Fails closed, but not shut: a driver that genuinely needs something says so by name.
    assert.equal(childEnv(parent, {}, ['WEIRD_DRIVER_VAR']).WEIRD_DRIVER_VAR, 'needed');
    // ...and widening it still cannot be used to smuggle the token in by accident.
    assert.equal(childEnv(parent, {}, ['WEIRD_DRIVER_VAR']).WORKER_REGISTRATION_TOKEN, undefined);
    // Explicit `env` wins, because that is the caller stating an intent rather than inheriting one.
    assert.equal(childEnv(parent, { FAKE_MODE: 'ok' }).FAKE_MODE, 'ok');
  });
});

// ---------------------------------------------------------------- capability honesty

describe('health notification', () => {
  test('reports every crossing of healthy(), not just permanent failure', async () => {
    const seen: Array<[boolean, string]> = [];
    const s = await supervisor({
      maxRestarts: 20,
      baseBackoffMs: 20,
      fakeEnv: { FAKE_CRASH_AFTER_MS: '250' },
      onHealthChange: (healthy, state) => { seen.push([healthy, state]); },
    });

    assert.equal(await s.start(), true);
    assert.deepEqual(seen, [[true, 'ready']], 'becoming ready is the first crossing');

    // The failure ADR-0003 exists to prevent: a TRANSIENT crash. The supervisor recovers on its
    // own, so nothing about the process state says anything went wrong afterwards — but for the
    // whole backoff-plus-cold-start window the host is advertising a capability it cannot serve.
    // Unless that window is announced, the agent cannot withdraw and the ADR's central claim is
    // just a comment.
    assert.ok(await until(() => seen.length >= 3, 8_000), `only saw ${JSON.stringify(seen)}`);
    assert.equal(seen[1]![0], false, 'a crash must report unhealthy');
    assert.equal(seen[2]![0], true, 'recovery must report healthy again');
    assert.equal(s.healthy(), true);
    await s.stop();
  });

  test('reports unhealthy when the supervisor gives up for good', async () => {
    const seen: boolean[] = [];
    const s = await supervisor({
      baseBackoffMs: 10,
      maxRestarts: 1,
      fakeEnv: { FAKE_MODE: 'exit' },
      onHealthChange: (healthy) => { seen.push(healthy); },
    });
    assert.equal(await s.start(), false);
    assert.ok(await until(() => s.state === 'failed', 5_000), `state=${s.state}`);
    // Never became ready, so there was never a healthy edge to fall from — and the agent must not
    // be told to withdraw something it never advertised.
    assert.deepEqual(seen, []);
  });

  test('a throwing listener cannot take the supervisor down with it', async () => {
    const s = await supervisor({ onHealthChange: () => { throw new Error('listener is broken'); } });
    assert.equal(await s.start(), true, 'a broken listener must not stop Appium from being supervised');
    assert.equal(s.healthy(), true);
    await s.stop();
  });
});

// ---------------------------------------------------------------- orphan reclamation

/** A detached Appium-alike nobody is supervising — what an agent that died without draining leaves. */
async function spawnOrphan(port: number): Promise<ChildProcess> {
  const c = spawn(process.execPath, [fakePath, '--port', String(port), '--address', '127.0.0.1'], {
    detached: true, stdio: 'ignore',
  });
  c.unref();
  strays.push(c);
  assert.ok(await until(() => true) && await occupied(port), `orphan never bound ${port}`);
  return c;
}

async function occupied(port: number): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try { await connect('127.0.0.1', port, 200); return true; } catch { await sleep(25); }
  }
  return false;
}

describe('orphan reclamation', () => {
  test('reclaims its own port from an Appium a dead agent left behind', async () => {
    // The scenario the STABLE port makes inevitable rather than unlucky: the previous agent was
    // SIGKILLed, its Appium survived, and the replacement derives the very same port. Without
    // reclamation every attempt gets EADDRINUSE and the supervisor burns its whole restart budget
    // on a process it leaked itself — permanently unhealthy before it ever ran.
    const port = await freePort();
    const pidFile = join(dir, `reclaim-${port}.pid`);
    const orphan = await spawnOrphan(port);
    await writeFile(pidFile, JSON.stringify({ pid: orphan.pid, port }));

    const s = await supervisor({ port, pidFile, maxRestarts: 0, readyTimeoutMs: 3_000 });
    assert.equal(await s.start(), true, 'the supervisor did not get its port back');

    assert.ok(await until(() => !alive(orphan.pid!), 3_000), `orphan ${orphan.pid} survived`);
    assert.notEqual(s.pid, orphan.pid);
    assert.equal(s.endpoint, `http://127.0.0.1:${port}`);
    await s.stop();
    assert.equal(existsSync(pidFile), false, 'the pid file outlived the process it names');
  });

  test('records a pid file while running and removes it on stop', async () => {
    const port = await freePort();
    const pidFile = join(dir, `lifecycle-${port}.pid`);
    const s = await supervisor({ port, pidFile });
    assert.equal(await s.start(), true);

    // Nothing else remembers which pid holds the port once this process is gone, so this file is
    // the only thing that makes the orphan reclaimable at all.
    assert.deepEqual(JSON.parse(await readFile(pidFile, 'utf8')), { pid: s.pid, port });
    await s.stop();
    assert.equal(existsSync(pidFile), false);
  });

  test('killSync leaves nothing behind, from a context where nothing async can run', async () => {
    const port = await freePort();
    const pidFile = join(dir, `sync-${port}.pid`);
    const s = await supervisor({ port, pidFile, fakeEnv: { FAKE_IGNORE_SIGTERM: '1' } });
    assert.equal(await s.start(), true);
    const pid = s.pid!;

    // This is what runs in process.on('exit'). It has to work on a server ignoring SIGTERM, since
    // that is precisely the one that would otherwise outlive the agent.
    s.killSync();
    assert.ok(await until(() => !alive(pid), 2_000), `pid ${pid} survived killSync()`);
    assert.equal(existsSync(pidFile), false);
  });

  test('never kills a process it cannot prove it started', async () => {
    // Pid files outlive reboots and pids get recycled. Killing whatever now wears a remembered
    // number is far worse than the orphan: the port is one service, an arbitrary pid is any of
    // them. So the port being busy is not enough — the process must still look like ours.
    const port = await freePort();
    const pidFile = join(dir, `bystander-${port}.pid`);

    const squatter = createServer();
    squatters.push(squatter);
    await new Promise<void>((r) => squatter.listen(port, '127.0.0.1', () => r()));

    // Alive, and named by the pid file, but its argv says nothing about this port.
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: 'ignore',
    });
    bystander.unref();
    strays.push(bystander);
    await writeFile(pidFile, JSON.stringify({ pid: bystander.pid, port }));

    const s = await supervisor({ port, pidFile, maxRestarts: 0, readyTimeoutMs: 800 });
    assert.equal(await s.start(), false, 'a port held by a stranger must not become "ready"');

    await sleep(200);
    assert.ok(alive(bystander.pid!), 'reclamation killed an innocent process by recycled pid');
    assert.ok(squatter.listening, 'the real port holder was disturbed');
    await s.stop();
  });
});
