import { spawn, type ChildProcess } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { webdriverUrl, maskUrl, describe } from './client.ts';
import type {
  ControlPlaneClient, CreateSessionResult, DataPlaneCoordinates, SessionSummary,
} from './client.ts';

/**
 * `mfarm run` — a wrapper, not a test runner.
 *
 * Allocate a device, put its coordinates in the child's environment, get out of the way, and give
 * the device back. We never parse the child's output and never touch its exit code, because the
 * moment we do, adopting mfarm stops being a one-line change to a CI file.
 *
 * ---
 *
 * THE DEVICE IS RELEASED ON EVERY EXIT PATH. That is the load-bearing property of this file.
 *
 * A leaked device is billable time the customer did not use and capacity nobody can reclaim until
 * the reaper notices — and the reaper only notices at TTL, which is thirty minutes by default. One
 * CI job that leaks on every run takes a device out of the pool permanently. So release is a single
 * idempotent closure, installed once, reachable from the normal return, the throw, both signals,
 * and the unhandled-rejection handler.
 */

export const EXIT_FAILURE = 1;

/** EX_TEMPFAIL. Distinguishable from a test failure, so CI can retry the job instead of alerting. */
export const EXIT_QUEUE_TIMEOUT = 75;

export const EXIT_INTERRUPTED = 130;

/** Contract: 500ms, doubling to a 5s ceiling. Fast enough to feel instant, slow enough to not DoS. */
const POLL_MIN_MS = 500;
const POLL_MAX_MS = 5_000;

/**
 * How long a child gets to honour SIGINT before it gets SIGKILL. A runner that traps the signal to
 * flush a JUnit report legitimately needs seconds; one that ignores it entirely would otherwise
 * hold the device — and this process — open forever, which is the leak we are here to prevent.
 */
const KILL_GRACE_MS = 10_000;

/** A device is ours once the server has attached one; ALLOCATING is ACTIVE that has not booted. */
const READY_STATES = new Set(['ACTIVE', 'ALLOCATING']);
const TERMINAL_STATES = new Set(['ENDING', 'ENDED', 'FAILED']);

export interface RunOptions {
  client: ControlPlaneClient;
  apiBaseUrl: string;
  apiKey: string;
  region: string;
  platform: 'android' | 'ios';
  tier?: string;
  ttlMinutes: number;
  waitSeconds: number;
  /**
   * Demand a device that can serve WebDriver. On by default, because `MFARM_WEBDRIVER_URL` is what
   * this command exists to hand over and a device without an automation server cannot honour it —
   * the failure would otherwise surface at the hub, after allocation, as a confusing mid-run error.
   * `--no-webdriver` turns it off for suites that only speak the raw data plane.
   */
  webdriver: boolean;
  command: string;
  args: string[];
  json: boolean;
  quiet: boolean;
}

class InterruptedError extends Error {}
class QueueTimeoutError extends Error {}

export async function run(opts: RunOptions): Promise<number> {
  // Progress on stderr, results on stdout. `mfarm run --json | jq` has to stay a working sentence.
  const progress = (msg: string) => {
    if (!opts.quiet) process.stderr.write(`mfarm: ${msg}\n`);
  };
  const warn = (msg: string) => process.stderr.write(`mfarm: ${msg}\n`);

  progress(`allocating an ${opts.platform} device in ${opts.region}…`);

  let created: CreateSessionResult;
  try {
    created = await opts.client.createSession({
      region: opts.region,
      platform: opts.platform,
      tier: opts.tier,
      ttlMinutes: opts.ttlMinutes,
      requireCapabilities: opts.webdriver ? ['webdriver'] : undefined,
    });
  } catch (err) {
    // Nothing was allocated, so there is nothing to release — the only clean exit in this file.
    return reportFailure(opts, warn, describe(err));
  }

  const sessionId = created.session.id;
  const { release, abandon: abandonRelease } = makeRelease(opts.client, sessionId, progress, warn);

  let child: ChildProcess | null = null;
  let interrupted = false;
  let wake: (() => void) | null = null;

  /**
   * Set for the duration of the release. Release is the longest window in the program — a DELETE
   * that 5xxs is retried three times at a 30s timeout each — so it is the last place that should be
   * running without a signal handler.
   */
  let releasing = false;
  let abandoned = false;

  const uninstallGuards = installGuards({
    onSignal(sig) {
      // ^C while giving the device back. The run itself is over and its exit code is already
      // decided, so the only thing left to interrupt is the *wait* for the server to answer.
      // Stop waiting, say so, and let the reaper finish the job — ADR-0002 decision 5 is that a
      // release which does not land never changes the exit code, and that holds for an abandoned
      // one too. The DELETE is already in flight and may well still land.
      if (releasing) {
        if (!abandoned) {
          abandoned = true;
          warn(
            `${sig} received while releasing — not waiting any longer. ` +
            `The server-side reaper will collect session ${sessionId} at TTL.`,
          );
          abandonRelease();
        } else {
          // Already abandoned; the handlers come off within microseconds of here, after which a
          // further ^C gets its default disposition. Still say something: a signal that produces
          // no output at all is indistinguishable from a hang.
          warn(`${sig} received — already shutting down.`);
        }
        return;
      }
      // A second ^C means the operator has stopped waiting. Skip the grace period and kill the
      // child now — the release still runs, because it is on the way out of this function and not
      // in this handler.
      if (interrupted) {
        warn('second signal — killing the child immediately');
        child?.kill('SIGKILL');
        return;
      }
      interrupted = true;
      warn(`${sig} received — stopping the run and releasing the device`);
      wake?.();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill(sig);
        armKiller(child, warn);
      }
    },
    onFatal(err) {
      // Our own bug must not become the customer's leaked device.
      warn(`internal error: ${describe(err)}`);
      void release().finally(() => process.exit(EXIT_FAILURE));
    },
  });

  const interruptibleSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => { wake = null; resolve(); }, ms);
      wake = () => { clearTimeout(timer); wake = null; resolve(); };
    });

  let exitCode = EXIT_FAILURE;
  let session: SessionSummary = created.session;
  let dataPlane: DataPlaneCoordinates | null = created.dataPlane;
  let failure: string | null = null;

  try {
    if (created.queued) {
      progress(`no device is free — session ${sessionId} is queued (waiting up to ${opts.waitSeconds}s)`);
      session = await waitForDevice(opts, sessionId, {
        interrupted: () => interrupted,
        sleep: interruptibleSleep,
      });
    }
    if (interrupted) throw new InterruptedError();

    progress(`device ${session.deviceId} is ready — running ${opts.command}`);
    child = spawn(opts.command, opts.args, {
      // The user's test output is theirs. Piping it would mean buffering it, colour-stripping it,
      // and breaking every runner that checks isTTY to decide whether to draw a progress bar.
      stdio: 'inherit',
      env: childEnvironment(opts, session, dataPlane),
    });
    exitCode = await waitForChild(child, () => interrupted);
  } catch (err) {
    if (err instanceof InterruptedError) {
      exitCode = EXIT_INTERRUPTED;
    } else if (err instanceof QueueTimeoutError) {
      failure = `no device became available within ${opts.waitSeconds}s`;
      warn(`${failure}. Releasing the queued session; the job is safe to retry.`);
      exitCode = EXIT_QUEUE_TIMEOUT;
    } else {
      failure = describe(err);
      warn(failure);
      exitCode = EXIT_FAILURE;
    }
  } finally {
    // Guards stay installed ACROSS the release, and only come off once it has settled or been
    // abandoned. The other ordering — uninstall, then await — leaves the longest window in the
    // program with no handler at all, so a ^C there hard-kills the process mid-DELETE. The reason
    // the guards ever come off is still valid (a handler left installed after this point would make
    // ^C do nothing at all, which looks exactly like a hang), it just applies *after* release, not
    // before it.
    releasing = true;
    await release();
    releasing = false;
    uninstallGuards();
  }

  if (opts.json) {
    emitJson({
      sessionId,
      deviceId: session.deviceId,
      region: session.region ?? opts.region,
      // Masked: this string embeds the API key, and --json output ends up in build artifacts.
      webdriverUrl: maskUrl(webdriverUrl(opts.apiBaseUrl, opts.apiKey, sessionId)),
      exitCode,
      ...(failure ? { error: failure } : {}),
    });
  }
  return exitCode;
}

interface ReleaseHandle {
  /** Idempotent: the first call starts the DELETE, later calls await the same one. */
  release: () => Promise<void>;
  /**
   * Stop waiting for the server, and cancel the request while we are at it.
   *
   * Cancelling is not decoration. Merely stopping the `await` would be a lie to the operator: the
   * in-flight socket keeps the event loop alive, so the process would sit there for the rest of the
   * retry budget after announcing that it had given up. Aborting makes "I have stopped waiting"
   * true, and lets the normal exit path — including the `--json` summary — still run.
   */
  abandon: () => void;
}

/**
 * Release, once, whatever happens.
 *
 * Best-effort by contract: a failed release is logged and then forgotten. Turning a green test run
 * red because a cleanup call timed out would train people to ignore mfarm's exit code, and the
 * server-side reaper is the real backstop for the case we cannot handle.
 */
function makeRelease(
  client: ControlPlaneClient,
  sessionId: string,
  progress: (m: string) => void,
  warn: (m: string) => void,
): ReleaseHandle {
  const controller = new AbortController();
  let started: Promise<void> | null = null;

  return {
    release() {
      if (started) return started;
      // Announced before the call, not after it. This is the one part of the run that can take
      // minutes, so an operator deciding whether to reach for ^C needs to know it has begun.
      progress(`releasing session ${sessionId}…`);
      started = (async () => {
        try {
          const released = await client.deleteSession(sessionId, controller.signal);
          progress(released ? `released session ${sessionId}` : `session ${sessionId} was already released`);
        } catch (err) {
          // An abandoned release was already reported by whoever abandoned it; saying it twice
          // only makes the log look like two separate failures.
          if (controller.signal.aborted) return;
          warn(
            `could not release session ${sessionId}: ${describe(err)}. ` +
            'The server-side reaper will collect it at TTL; this does not affect the exit code.',
          );
        }
      })();
      return started;
    },
    abandon() {
      controller.abort();
    },
  };
}

async function waitForDevice(
  opts: RunOptions,
  sessionId: string,
  ctx: { interrupted: () => boolean; sleep: (ms: number) => Promise<void> },
): Promise<SessionSummary> {
  const deadline = Date.now() + opts.waitSeconds * 1_000;
  let delay = POLL_MIN_MS;

  for (;;) {
    if (ctx.interrupted()) throw new InterruptedError();
    // `--wait 0` lands here before the first poll, which is the point: a job that would rather fail
    // fast and be retried by CI should not sit in a queue holding a runner slot.
    if (Date.now() >= deadline) throw new QueueTimeoutError();

    await ctx.sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    if (ctx.interrupted()) throw new InterruptedError();

    const session = await opts.client.getSession(sessionId);
    if (session.deviceId && READY_STATES.has(session.state)) return session;
    if (TERMINAL_STATES.has(session.state)) {
      const reason = session.endReason ? `: ${session.endReason}` : '';
      throw new Error(`Session ${sessionId} reached ${session.state} before a device was attached${reason}.`);
    }
    delay = Math.min(delay * 2, POLL_MAX_MS);
  }
}

function childEnvironment(
  opts: RunOptions,
  session: SessionSummary,
  dataPlane: DataPlaneCoordinates | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MFARM_SESSION_ID: session.id,
    MFARM_DEVICE_ID: session.deviceId ?? '',
    MFARM_REGION: session.region ?? opts.region,
    // The session id travels in the URL so the hub drives THIS device instead of allocating another
    // one. Everything in ADR-0002 rests on the CLI being the single lifecycle owner, and it was not
    // one until this argument existed — the hub was allocating a second device per WebDriver suite
    // and billing for it (D1).
    MFARM_WEBDRIVER_URL: webdriverUrl(opts.apiBaseUrl, opts.apiKey, session.id),
  };
  if (dataPlane) {
    env.MFARM_DATA_PLANE_ENDPOINT = dataPlane.endpoint;
    env.MFARM_SESSION_TOKEN = dataPlane.token;
  } else {
    // Only reachable on the queued path: GET /v1/sessions/:id carries no data-plane block, so a
    // promoted session has no endpoint or token to hand down. WebDriver still works — it gets its
    // coordinates from the hub — but anything speaking the raw data plane needs to know why the
    // variables are missing rather than reading an empty string as "no device".
    delete env.MFARM_DATA_PLANE_ENDPOINT;
    delete env.MFARM_SESSION_TOKEN;
  }
  return env;
}

function waitForChild(child: ChildProcess, interrupted: () => boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', (err) => {
      // Almost always ENOENT: the command does not exist on PATH. The child never ran, so there is
      // no child exit code to pass through and this is a configuration failure.
      reject(new Error(`could not start ${child.spawnfile}: ${describe(err)}`));
    });
    child.once('exit', (code, signal) => {
      if (interrupted()) return resolve(EXIT_INTERRUPTED);
      if (code !== null) return resolve(code);
      // Killed by something we did not send — OOM killer, a crash, a `kill` from another terminal.
      // 128+n is what a shell would have reported, and CI parses exit codes like a shell.
      const signum = signal ? (osConstants.signals[signal] ?? 0) : 0;
      resolve(128 + signum);
    });
  });
}

function armKiller(child: ChildProcess, warn: (m: string) => void): void {
  const timer = setTimeout(() => {
    warn(`the child ignored the signal for ${KILL_GRACE_MS / 1_000}s — sending SIGKILL`);
    child.kill('SIGKILL');
  }, KILL_GRACE_MS);
  // Never let the grace timer be the reason the process stays alive after the child is gone.
  timer.unref();
  child.once('exit', () => clearTimeout(timer));
}

function installGuards(handlers: {
  onSignal: (sig: NodeJS.Signals) => void;
  onFatal: (err: unknown) => void;
}): () => void {
  const onSigint = () => handlers.onSignal('SIGINT');
  const onSigterm = () => handlers.onSignal('SIGTERM');
  const onFatal = (err: unknown) => handlers.onFatal(err);

  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);

  // Removed as soon as the run is over. Leaving a SIGINT handler installed past the release would
  // make a ^C during shutdown do nothing at all, which looks exactly like a hang.
  return () => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    process.off('uncaughtException', onFatal);
    process.off('unhandledRejection', onFatal);
  };
}

function reportFailure(opts: RunOptions, warn: (m: string) => void, message: string): number {
  warn(message);
  if (opts.json) emitJson({ sessionId: null, exitCode: EXIT_FAILURE, error: message });
  return EXIT_FAILURE;
}

function emitJson(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
