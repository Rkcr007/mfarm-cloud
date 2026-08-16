import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Appium 2 process supervisor — the missing half of the WebDriver hub (v2 decision 10).
 *
 * The hub in `apps/api/src/http/routes/webdriver.ts` is finished, but until now nothing ran an
 * Appium server next to a device. The agent merely re-advertised whatever `AUTOMATION_ENDPOINT` an
 * operator typed, so the `webdriver` capability was honest only by hand: set the variable with no
 * server behind it and the control plane happily allocates real tenant sessions to this host, every
 * one of which fails at `POST /session`. This class makes the flag mean something — the endpoint is
 * derived from a process this code started and has *proved* is answering.
 *
 * NOT VERIFIED AGAINST A REAL APPIUM. There is no Android device and no `appium` binary in the
 * environment this was written in, and per HANDOFF.md that remains true until the bare-metal box is
 * booked. What is tested (against a fake server, in test/appium.test.ts) is all of the process
 * supervision: readiness gating, crash detection, backoff, give-up, kill escalation, port
 * derivation. What is NOT tested, and must be re-checked the first time real hardware exists:
 *
 *   - that `appium --address --port --base-path` are still the flags Appium 2 accepts, and that
 *     `--base-path /` really puts `POST /session` where the hub expects it
 *   - that a real Appium answers `GET /status` with 200 only once it can actually take a session
 *     (if it answers earlier, READY_TIMEOUT is not the problem — the readiness predicate is)
 *   - that SIGTERM is enough for a real Appium mid-session, i.e. that STOP_GRACE_MS is long enough
 *   - what a driver crash looks like from out here: a process exit, or a live server whose driver
 *     is wedged. Only the first is detected. The second needs a deeper probe than `/status`.
 */

export type AppiumState =
  | 'stopped'    // never started, or stop() completed
  | 'starting'   // process spawned, /status not answering yet
  | 'ready'      // /status answered; the only state in which healthy() is true
  | 'backoff'    // died; waiting out the delay before the next attempt
  | 'stopping'   // stop() in progress
  | 'failed';    // gave up permanently — no further restarts, healthy() is false forever

export interface AppiumOptions {
  /** Device this server fronts. Names the log lines and, by default, derives the port. */
  localId: string;
  /** Defaults to `appium` on PATH. Overridden by tests and by pinned installs. */
  command?: string;
  /**
   * Arguments BEFORE the flags this class controls, for installs reached through a wrapper —
   * `command: 'npx', commandArgs: ['appium']`, or `command: node, commandArgs: [path/to/main.js]`.
   */
  commandArgs?: string[];
  /** Appended after the flags this class controls. Never use it to re-set --address. */
  extraArgs?: string[];
  /** Defaults to derivePort(localId). */
  port?: number;
  /**
   * Host to put in the ADVERTISED url only. Does not change the bind address, which is always
   * loopback. Set it when a private overlay (WireGuard, an mTLS tunnel) forwards to loopback on
   * this host — see the bind comment in spawnChild for why the two are deliberately separate.
   */
  advertiseHost?: string;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Consecutive failed attempts tolerated before going permanently unhealthy. */
  maxRestarts?: number;
  /** Time ready that counts as recovered, resetting the consecutive-failure count. */
  stableAfterMs?: number;
  stopGraceMs?: number;
  /**
   * Extra variables for the child, applied ON TOP of the allowlisted inheritance. This is the only
   * way to hand Appium something outside the allowlist, and it is deliberately explicit — see
   * ENV_ALLOWLIST for why the child does not simply inherit `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /** Additional names the child may inherit from this process. See ENV_ALLOWLIST. */
  envPassthrough?: readonly string[];
  /**
   * Where the running child's pid is recorded so a LATER agent can find it after a crash.
   * Defaults to `<tmpdir>/mfarm-appium-<port>.pid`. Keyed by port because the port is the resource
   * being contended: see reclaimPort.
   */
  pidFile?: string;
  /** Called once, when the supervisor gives up for good. */
  onPermanentFailure?: (reason: string) => void;
  /**
   * Called on every change of `healthy()`, with the state that caused it.
   *
   * This is the hook ADR-0003 decision 3 hangs on. Without it the agent learns about a crash only
   * if the supervisor gives up permanently, so a transient outage — crash, backoff, cold start —
   * passes with the host still advertising `webdriver` and the allocator still routing WebDriver
   * sessions at a device that has no Appium behind it. Fires synchronously; a throwing callback is
   * logged and swallowed rather than allowed to kill the supervision loop.
   */
  onHealthChange?: (healthy: boolean, state: AppiumState) => void;
}

const DEFAULTS = {
  command: 'appium',
  readyTimeoutMs: 90_000,
  pollIntervalMs: 500,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  maxRestarts: 5,
  stableAfterMs: 120_000,
  stopGraceMs: 15_000,
};

/** Lines of child output kept for the crash log. A process that died with no explanation attached
 *  is an incident nobody can act on without ssh access to the host. */
const TAIL_LINES = 20;

/**
 * What the Appium child is allowed to inherit from the agent's own environment.
 *
 * An ALLOWLIST, not a denylist, and the difference matters. The agent's environment holds
 * `WORKER_REGISTRATION_TOKEN` — the shared secret that mints worker identities for the whole fleet
 * (`apps/api/src/http/routes/workers.ts` authenticates `POST /workers/register` with it and nothing
 * else) — alongside `CONTROL_PLANE_URL`, which says exactly where to spend it. Appium loads
 * third-party drivers and plugins by design, and with any `--allow-insecure` feature enabled it
 * executes host-side code on request. This repo's own argument for binding Appium to loopback is
 * that an open Appium port is a shell-equivalent on the device (decision 4); a shell-equivalent
 * must not also be handed the credential that enrolls new hosts. Inheriting `process.env` gave it
 * both. A denylist would have to be updated every time someone adds a secret; an allowlist fails
 * closed instead, and anything genuinely missing is added deliberately via `envPassthrough`
 * (`APPIUM_ENV_PASSTHROUGH` in index.ts) or `env`.
 */
const ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM',
  'TMPDIR', 'TEMP', 'TMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  // A driver that drives a real emulator window needs an X display.
  'DISPLAY', 'XAUTHORITY',
  'JAVA_HOME',
  // Corporate TLS interception: without these a driver cannot fetch anything over https.
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];

/** Whole families Appium and the Android tooling legitimately need. None of these namespaces holds
 *  a control-plane credential; every mfarm secret lives outside them. */
const ENV_ALLOW_PREFIXES: readonly string[] = ['ANDROID_', 'APPIUM_', 'ADB_', 'GRADLE_', 'XDG_'];

/**
 * The environment an Appium child actually gets.
 *
 * Exported for the test that proves `WORKER_REGISTRATION_TOKEN` cannot reach the child.
 */
export function childEnv(
  parent: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv = {},
  passthrough: readonly string[] = [],
): NodeJS.ProcessEnv {
  const allow = new Set([...ENV_ALLOWLIST, ...passthrough]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (allow.has(k) || ENV_ALLOW_PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  return { ...out, ...extra };
}

/**
 * Port for a device's Appium server, derived from its local id.
 *
 * Two devices on one host need two servers, so 4723 cannot be the only answer. Derived rather than
 * assigned so it is the SAME port across an agent restart: the control plane persists
 * `automation_endpoint` from registration, and firewall rules and tunnels are written against a
 * fixed number. A random free port would silently invalidate all three.
 *
 * `cf-1`, `avd-2` and friends land densely at basePort + n - 1. Anything else is hashed, which can
 * collide.
 *
 * Nothing checks for that collision today, and nothing can: index.ts refuses to run Appium at all
 * on a host with more than one device (blocker B2 — registration carries one host-level
 * `automationEndpoint`), so exactly one port is ever derived per host. index.ts used to carry a
 * collision loop over the supervisor list; it could never see two entries and has been removed
 * rather than left reading as a live defence. Reinstate it in createSupervisors the moment B2 is
 * fixed and a host can run more than one supervisor.
 */
export function derivePort(localId: string, basePort = 4723, span = 100): number {
  const trailing = /(\d+)$/.exec(localId);
  if (trailing) {
    const n = Number(trailing[1]);
    // Euclidean remainder, not `%`. JavaScript's `%` keeps the sign of the dividend, so an operator
    // who numbered a device from zero — `cf-0` — got `(0 - 1) % 100 === -1` and a port of
    // basePort - 1: outside the span this function promises, and quite possibly owned by something
    // else. A long digit run that is not an exact integer aliases unpredictably, so it hashes.
    if (Number.isSafeInteger(n)) return basePort + ((((n - 1) % span) + span) % span);
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < localId.length; i++) {
    h = Math.imul(h ^ localId.charCodeAt(i), 0x01000193) >>> 0;
  }
  return basePort + (h % span);
}

/**
 * One GET /status against loopback.
 *
 * Deliberately not `fetch`: undici keeps pooled sockets to a server we are about to SIGKILL, which
 * both holds the event loop open at shutdown and makes the next probe reuse a socket to a dead
 * process. A one-shot agentless request has neither problem.
 */
function probeStatus(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path: '/status', method: 'GET', agent: false, timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { if (body.length < 4096) body += c; });
        res.on('end', () => resolve(res.statusCode === 200 && !declaresNotReady(body)));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * Trust a 200 unless the body actively says otherwise.
 *
 * Requiring `value.ready === true` would be stricter, but drivers disagree about what they put in
 * `/status` and a supervisor that refuses to believe a working server is worse than one that
 * believes a starting one — the readiness poll only has to outlast the bind, and a server that is
 * still loading drivers reports `ready: false` explicitly.
 */
function declaresNotReady(body: string): boolean {
  try {
    const v = (JSON.parse(body) as { value?: { ready?: unknown } }).value;
    return typeof v === 'object' && v !== null && v.ready === false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- orphan reclamation
//
// derivePort is deliberately STABLE across restarts, which makes an orphaned Appium collide with
// its successor by design rather than by luck: the next agent asks for exactly the port the dead
// agent's child is still holding, fails to bind on every attempt, and spends its entire restart
// budget before going permanently unhealthy. So the orphan has to be reclaimed, not waited out.

interface PidRecord { pid: number; port: number }

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** True once something accepts a loopback connection on `port`. */
function portOccupied(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const c = new Socket();
    const done = (v: boolean) => { c.destroy(); resolve(v); };
    c.setTimeout(timeoutMs);
    c.once('connect', () => done(true));
    c.once('timeout', () => done(false));
    c.once('error', () => done(false));
    c.connect(port, '127.0.0.1');
  });
}

async function waitPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await portOccupied(port, 200))) return true;
    await sleep(50);
  } while (Date.now() < deadline);
  return !(await portOccupied(port, 200));
}

/**
 * Guard against pid reuse before killing anything.
 *
 * A pid file survives a reboot in the worst case, and pids recycle. Killing whatever now happens to
 * wear that number would be far worse than the orphan. Every child this class spawns has
 * `--port <port>` in its own argv, so requiring that string in the live process's command line is a
 * cheap, portable identity check that a recycled pid will essentially never satisfy.
 */
function looksLikeOurServer(pid: number, port: number): boolean {
  try {
    const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return args.includes(`--port ${port}`);
  } catch {
    // No `ps`, or the process vanished between the liveness check and here. Refuse rather than
    // guess: an unreclaimed port is a loud, diagnosable failure; killing a stranger is not.
    return false;
  }
}

/** SIGTERM the process group, then SIGKILL it. Group, because Appium forks its own helpers. */
async function killTree(pid: number, graceMs: number): Promise<void> {
  const signal = (s: NodeJS.Signals): void => {
    // Negative pid targets the group, which only exists because spawnChild uses `detached`.
    try { process.kill(-pid, s); } catch { try { process.kill(pid, s); } catch { /* gone */ } }
  };
  signal('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await sleep(25);
  }
  signal('SIGKILL');
}

export class AppiumSupervisor {
  readonly localId: string;
  readonly port: number;
  /** Backoff delays actually slept, in order. Exposed so the growth is assertable. */
  readonly restartDelays: number[] = [];

  private readonly opts: AppiumOptions;
  private readonly cfg: typeof DEFAULTS;
  private readonly tail: string[] = [];

  private _state: AppiumState = 'stopped';
  private _attempts = 0;
  private child?: ChildProcess;
  /** Resolves with a human-readable cause when the current child goes away. */
  private exited?: Promise<string>;
  private loop?: Promise<void>;
  private stopRequested = false;
  private failures = 0;
  private readySince = 0;
  private wake?: () => void;
  private settleFirst?: (ready: boolean) => void;
  private _args: string[] = [];

  // Explicit assignment rather than a constructor parameter property: those emit runtime code, so
  // Node's strip-only type removal rejects them and the no-build-step setup breaks.
  constructor(opts: AppiumOptions) {
    this.opts = opts;
    this.cfg = { ...DEFAULTS, ...stripUndefined(opts) };
    this.localId = opts.localId;
    this.port = opts.port ?? derivePort(opts.localId);
  }

  get state(): AppiumState { return this._state; }
  get pid(): number | undefined { return this.child?.pid; }
  /** Spawn attempts since construction. Includes the first one. */
  get startAttempts(): number { return this._attempts; }
  get spawnArgs(): readonly string[] { return this._args; }

  /** Where the hub would be told to reach this server. Valid regardless of state; see `endpoint`. */
  get baseUrl(): string {
    return `http://${this.opts.advertiseHost ?? '127.0.0.1'}:${this.port}`;
  }

  /**
   * The url to advertise, or undefined.
   *
   * Undefined in every state but `ready`, on purpose: this getter is what index.ts turns into the
   * `webdriver` capability, and the whole point of the supervisor is that the capability cannot be
   * claimed by a host whose Appium is not answering right now.
   */
  get endpoint(): string | undefined {
    return this._state === 'ready' ? this.baseUrl : undefined;
  }

  healthy(): boolean {
    return this._state === 'ready';
  }

  /**
   * Single writer for `_state`, so no transition can skip the health notification.
   *
   * Every `this._state = x` in this class goes through here. That is the whole reason a transient
   * crash is now visible to the agent: `ready -> backoff` and `starting -> ready` both cross the
   * healthy boundary, and both have to reach index.ts for the `webdriver` capability to track
   * reality instead of tracking what was true at registration.
   */
  private setState(next: AppiumState): void {
    if (next === this._state) return;
    const was = this.healthy();
    this._state = next;
    if (this.healthy() === was) return;
    try {
      this.opts.onHealthChange?.(this.healthy(), next);
    } catch (e) {
      // A broken listener must not take the supervisor down with it — the supervisor is the thing
      // keeping Appium alive.
      console.error(`[appium:${this.localId}] onHealthChange threw: ${(e as Error).message}`);
    }
  }

  /**
   * Start supervising, and resolve with the outcome of the FIRST attempt.
   *
   * Does not throw on a failed start and does not keep the caller waiting through the backoff:
   * registration must not block for minutes because a driver is slow. A false here means "register
   * without the capability"; the loop keeps trying in the background either way.
   */
  async start(): Promise<boolean> {
    if (this._state === 'failed') {
      throw new Error(`[appium:${this.localId}] gave up permanently; restart the agent`);
    }
    if (this.loop) return this.healthy();
    this.stopRequested = false;
    const first = new Promise<boolean>((resolve) => { this.settleFirst = resolve; });
    this.loop = this.runLoop();
    return first;
  }

  /** Wait across restarts. Returns early on a permanent failure rather than burning the timeout. */
  async waitUntilReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this._state === 'ready') return true;
      if (this._state === 'failed' || this._state === 'stopped') return false;
      await sleep(Math.min(50, this.cfg.pollIntervalMs));
    }
    return this._state === 'ready';
  }

  async stop(): Promise<void> {
    if (!this.loop && this._state === 'stopped') return;
    this.stopRequested = true;
    if (this._state !== 'failed') this.setState('stopping');
    this.wake?.();
    await this.killChild();
    await this.loop;
    this.loop = undefined;
    if (this._state !== 'failed') this.setState('stopped');
    this.log('stopped');
  }

  // ---------------------------------------------------------------- supervision loop

  private async runLoop(): Promise<void> {
    let first = true;
    while (!this.stopRequested) {
      const ready = await this.attempt();
      if (first) { this.settleFirst?.(ready); this.settleFirst = undefined; first = false; }
      if (this.stopRequested) break;
      if (ready) await this.awaitCrash();
      if (this.stopRequested) break;
      if (!this.countFailure()) return;
      await this.backoffSleep();
    }
    if (this._state !== 'failed') this.setState('stopped');
    this.settleFirst?.(false);
    this.settleFirst = undefined;
  }

  private async attempt(): Promise<boolean> {
    // Counted here rather than in spawnChild: reclaiming the port is part of the attempt, and an
    // attempt that dies trying to clear an orphan is still an attempt that happened.
    this._attempts++;
    // Cleared here, not in spawnChild, so a "port is occupied" note from reclaimPort survives into
    // the crash log instead of being wiped by the spawn that then fails because of it.
    this.tail.length = 0;
    this.setState('starting');
    await this.reclaimPort();
    this.spawnChild();
    if (await this.awaitReady(this.exited!)) {
      this.setState('ready');
      this.readySince = Date.now();
      this.log(`ready at ${this.baseUrl} (pid ${this.child?.pid})`);
      return true;
    }
    // Timed out, or died during startup. Either way the child must not be left behind still holding
    // the port: the next attempt would fail to bind and the supervisor would spend its whole restart
    // budget blaming Appium for a process it leaked itself.
    await this.killChild();
    return false;
  }

  /**
   * Poll /status until the server answers.
   *
   * Reporting ready on spawn alone is the tempting shortcut and it is wrong: Appium loads drivers
   * before it binds, which takes seconds. The host would advertise `webdriver`, the control plane
   * would allocate, and the first session of a freshly booted host would hit a closed port.
   */
  private async awaitReady(exited: Promise<string>): Promise<boolean> {
    let dead = false;
    void exited.then(() => { dead = true; });
    const deadline = Date.now() + this.cfg.readyTimeoutMs;
    while (!dead && !this.stopRequested && Date.now() < deadline) {
      if (await probeStatus(this.port, this.cfg.pollIntervalMs * 2)) return true;
      await sleep(this.cfg.pollIntervalMs);
    }
    if (!dead && !this.stopRequested) {
      this.log(`no answer on /status within ${this.cfg.readyTimeoutMs}ms${this.tailText()}`);
    }
    return false;
  }

  private async awaitCrash(): Promise<void> {
    const cause = await this.exited!;
    if (this.stopRequested) return;
    // A server that ran for hours and then died is a new incident, not the continuation of a crash
    // loop. Without this reset, a host that loses Appium once a week reaches the give-up threshold
    // months later and goes permanently unhealthy for no reason anyone can reconstruct.
    const upMs = Date.now() - this.readySince;
    if (upMs >= this.cfg.stableAfterMs) this.failures = 0;
    this.log(`exited (${cause}) after ${Math.round(upMs / 1000)}s ready${this.tailText()}`);
  }

  /** @returns false when the give-up threshold is crossed and the loop must end. */
  private countFailure(): boolean {
    this.failures++;
    if (this.failures <= this.cfg.maxRestarts) return true;
    // Permanently unhealthy beats restarting forever. A crash loop that never ends burns the host's
    // CPU, fills the disk with Appium logs, and — worse — keeps flickering into `ready` long enough
    // to take a session it will drop. Stopping makes the failure visible and the host honest.
    this.setState('failed');
    const reason = `${this.failures} consecutive failed starts for ${this.localId}${this.tailText()}`;
    console.error(`[appium:${this.localId}] giving up permanently — ${reason}`);
    this.opts.onPermanentFailure?.(reason);
    return false;
  }

  private async backoffSleep(): Promise<void> {
    const ms = Math.min(this.cfg.baseBackoffMs * 2 ** (this.failures - 1), this.cfg.maxBackoffMs);
    this.setState('backoff');
    this.restartDelays.push(ms);
    this.log(`restart ${this.failures}/${this.cfg.maxRestarts} in ${ms}ms`);
    const ac = new AbortController();
    this.wake = () => ac.abort();
    // Exponential, so a permanently broken install is not probed at 1 Hz for hours; capped, so a
    // transient failure does not leave the device unusable for the rest of the day.
    try { await sleep(ms, undefined, { signal: ac.signal }); } catch { /* woken by stop() */ }
    this.wake = undefined;
  }

  // ---------------------------------------------------------------- process handling

  private spawnChild(): void {
    // BOUND TO LOOPBACK, ALWAYS. An Appium port reachable from a routable interface is
    // unauthenticated device control: anyone who finds it installs apps, reads the screen and owns
    // every session on the box, with no org boundary anywhere in the path. The hub is the sole
    // ingress by design (see the header of apps/api/src/http/routes/webdriver.ts), so reaching this
    // server from off-host is a job for a private tunnel terminating here — never for --address.
    this._args = [
      ...(this.opts.commandArgs ?? []),
      '--address', '127.0.0.1',
      '--port', String(this.port),
      // The hub builds `${base}/session`, so the server has to serve at the root. Explicit because
      // an appium config file on the host could otherwise move it and break every session.
      '--base-path', '/',
      ...(this.opts.extraArgs ?? []),
    ];
    const child = spawn(this.cfg.command, this._args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // NOT `process.env`. The agent's environment carries the fleet registration token; see
      // ENV_ALLOWLIST for why an automation server must never be handed it.
      env: childEnv(process.env, this.opts.env, this.opts.envPassthrough),
      // Its own process group. Appium forks helpers of its own — adb, driver-side servers — and
      // signalling only the parent leaves those behind holding the device. `process.kill(-pid)`
      // reaches the whole tree, and that is only legal for a group leader.
      detached: true,
    });
    this.child = child;
    // Recorded before anything else can fail, so a crash one line later still leaves a trail for
    // the NEXT agent to find and clean up. This file is the only reason an orphan is reclaimable:
    // once this process is gone, nothing else remembers which pid was holding the port.
    this.writePidFile(child.pid);
    child.stdout?.on('data', (d: Buffer) => this.record(d));
    child.stderr?.on('data', (d: Buffer) => this.record(d));
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.clearPidFile();
        resolve(signal ? `signal ${signal}` : `code ${code}`);
      });
      // `appium` not on PATH emits 'error' and never 'exit'. Without this the readiness poll would
      // run to its full timeout on every single attempt, turning a five-second "not installed" into
      // minutes of pointless waiting before the first useful log line.
      child.once('error', (e) => {
        this.clearPidFile();
        this.record(Buffer.from(`spawn failed: ${e.message}`));
        resolve(`error ${e.message}`);
      });
    });
  }

  // ---------------------------------------------------------------- orphan handling

  private pidFilePath(): string {
    return this.opts.pidFile ?? join(tmpdir(), `mfarm-appium-${this.port}.pid`);
  }

  private writePidFile(pid: number | undefined): void {
    if (pid === undefined) return;
    const rec: PidRecord = { pid, port: this.port };
    try { writeFileSync(this.pidFilePath(), JSON.stringify(rec), { mode: 0o600 }); }
    catch (e) { this.log(`could not write ${this.pidFilePath()}: ${(e as Error).message}`); }
  }

  private readPidFile(): PidRecord | undefined {
    try {
      const rec = JSON.parse(readFileSync(this.pidFilePath(), 'utf8')) as PidRecord;
      return Number.isInteger(rec?.pid) && rec.port === this.port ? rec : undefined;
    } catch {
      return undefined;
    }
  }

  private clearPidFile(): void {
    try { rmSync(this.pidFilePath(), { force: true }); } catch { /* best effort */ }
  }

  /**
   * Make sure the port is free before spawning onto it.
   *
   * The case this exists for: the agent died without draining — a panic, a SIGKILL, an OOM — and
   * left Appium running. Because derivePort is stable on purpose, the replacement agent wants that
   * exact port, gets EADDRINUSE on every attempt, and reaches the give-up threshold without ever
   * having had a chance. Reclaiming turns that permanent failure into a two-second hiccup.
   *
   * A port held by something that is NOT one of ours is left strictly alone and reported. That is a
   * deployment mistake, and decision 5's answer to those is to fail loudly rather than to start
   * killing processes we cannot identify.
   */
  private async reclaimPort(): Promise<void> {
    if (!(await portOccupied(this.port))) return;

    const rec = this.readPidFile();
    if (rec && rec.pid !== process.pid && pidAlive(rec.pid) && looksLikeOurServer(rec.pid, this.port)) {
      this.log(`port ${this.port} held by orphaned pid ${rec.pid} from an earlier agent — reclaiming`);
      await killTree(rec.pid, this.cfg.stopGraceMs);
      if (await waitPortFree(this.port, this.cfg.stopGraceMs)) {
        this.clearPidFile();
        this.log(`reclaimed port ${this.port}`);
        return;
      }
    }

    // Named in the tail so the eventual give-up reason says "someone else has the port" instead of
    // blaming Appium for failing to start.
    const who = rec ? `pid ${rec.pid} (unverifiable)` : 'an unknown process';
    this.record(Buffer.from(
      `port ${this.port} is already in use by ${who} that this agent did not start; ` +
      'stop it or move APPIUM_BASE_PORT',
    ));
    console.error(`[appium:${this.localId}] port ${this.port} is occupied by ${who} — cannot reclaim it`);
  }

  /**
   * Synchronous, last-ditch kill. Safe from a `process.on('exit')` handler, where no async work can
   * run and this is the only chance left to avoid orphaning the child.
   */
  killSync(): void {
    const child = this.child;
    const pid = child?.pid;
    if (pid !== undefined && child!.exitCode === null && child!.signalCode === null) {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    this.clearPidFile();
  }

  /**
   * SIGTERM, then SIGKILL.
   *
   * Appium traps SIGTERM to close its driver sessions, which is worth waiting for — an abandoned
   * UiAutomator2 server keeps running on the device and the next session fails to start. But a
   * wedged driver swallows the signal entirely, and a drain that waits forever for a graceful exit
   * is a host that never finishes shutting down.
   */
  private async killChild(): Promise<void> {
    const child = this.child;
    const exited = this.exited;
    if (!child || !exited || child.exitCode !== null || child.signalCode !== null) return;
    this.signalGroup(child, 'SIGTERM');
    const hard = setTimeout(() => {
      this.log(`ignored SIGTERM for ${this.cfg.stopGraceMs}ms — SIGKILL`);
      this.signalGroup(child, 'SIGKILL');
    }, this.cfg.stopGraceMs);
    hard.unref?.();
    await exited;
    clearTimeout(hard);
    this.clearPidFile();
  }

  /** Signals the child's whole group, falling back to the child alone if the group is already gone. */
  private signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
    const pid = child.pid;
    if (pid === undefined) return;
    try { process.kill(-pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } }
  }

  private record(chunk: Buffer): void {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      this.tail.push(line.trimEnd());
      if (this.tail.length > TAIL_LINES) this.tail.shift();
    }
  }

  private tailText(): string {
    return this.tail.length === 0 ? '' : `\n  last output:\n    ${this.tail.join('\n    ')}`;
  }

  private log(msg: string): void {
    console.log(`[appium:${this.localId}] ${msg}`);
  }
}

/** `{...DEFAULTS, ...opts}` would let an omitted-but-present `undefined` erase a default. */
function stripUndefined(opts: AppiumOptions): Partial<typeof DEFAULTS> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined && k in DEFAULTS) out[k] = v;
  }
  return out as Partial<typeof DEFAULTS>;
}
