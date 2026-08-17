/**
 * `main.ts` as a PROCESS, which is the only way it is ever used in production and the only way it
 * was never tested.
 *
 * Every other test in this suite reaches `main.ts` by importing it and calling `start()`. That
 * skips the entire top of the file — the entrypoint guard, `loadConfigOrExit`, the signal handlers,
 * the `uncaughtException` handler — and ADR-0001 makes a specific promise to a process supervisor
 * about each one: 78 means "this will never start", 0 means "drained", 1 means "crashed". None of
 * those exit codes had a test.
 *
 * The gap was not theoretical. The entrypoint guard compared `import.meta.url` (which Node
 * realpaths) against `process.argv[1]` (which it does not), so under any deploy layout that goes
 * through a symlink `main()` simply never ran: no output, exit 0, and a supervisor that reads that
 * as a clean shutdown.
 *
 * These tests spawn real child processes. Nothing here touches the shared pools of the parent, so
 * the file is independent of the rest of the suite.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isEntrypoint } from '../src/main.ts';
import { DEV_APP_URL, DEV_SYSTEM_URL } from '../src/config.ts';

const API_DIR = fileURLToPath(new URL('..', import.meta.url));
const MAIN = join(API_DIR, 'src', 'main.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Temp directories created by these tests, removed at the end whatever happens. */
const scratch: string[] = [];
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Child {
  proc: ChildProcess;
  out: () => string;
  err: () => string;
  exit: Promise<Exit>;
}

/**
 * A child that inherits nothing accidental. The environment is built from scratch rather than
 * spread over `process.env`, so a `SESSION_SIGNING_KEY` or `NODE_ENV` in the developer's shell
 * cannot decide whether these tests pass.
 */
function spawnApi(entry: string, env: Record<string, string> = {}, nodeArgs: string[] = []): Child {
  const proc = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', ...nodeArgs, entry],
    {
      cwd: API_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        DATABASE_URL: process.env.DATABASE_URL ?? DEV_SYSTEM_URL,
        APP_DATABASE_URL: process.env.APP_DATABASE_URL ?? DEV_APP_URL,
        PORT: '0',
        HOST: '127.0.0.1',
        // Same reason as PORT: these children can overlap, and a fixed metrics port would have the
        // second one fail to bind and exit — a failure with nothing to do with what is being tested.
        METRICS_PORT: '0',
        METRICS_HOST: '127.0.0.1',
        LOG_LEVEL: 'info',
        // Off: the reaper is fleet-wide and this child shares a database with the rest of the suite.
        REAPER_INTERVAL_MS: '0',
        SHUTDOWN_GRACE_MS: '30000',
        ...env,
      },
    },
  );
  let out = '';
  let err = '';
  proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr?.on('data', (d: Buffer) => (err += d.toString()));
  return {
    proc,
    out: () => out,
    err: () => err,
    exit: new Promise<Exit>((resolve) =>
      proc.once('exit', (code, signal) => resolve({ code, signal })),
    ),
  };
}

async function waitFor<T>(get: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = get();
    if (v !== undefined) return v;
    await sleep(25);
  }
  return assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/** The address the child actually bound. PORT=0 means the kernel picked it, so the log line is the
 *  only place it exists. */
function boundAddress(child: Child): string | undefined {
  for (const line of child.out().split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const rec = JSON.parse(line) as { msg?: string; address?: string };
      if (rec.msg === 'control plane listening' && rec.address) return rec.address;
    } catch {
      /* a partially written line; it will be complete on the next poll */
    }
  }
  return undefined;
}

const listening = (child: Child) =>
  waitFor(() => boundAddress(child), 30_000, `${JSON.stringify(child.err().slice(-400))} — the child to listen`);

/** Kills anything still running, so a failed assertion cannot leave a process holding a port. */
async function reap(child: Child): Promise<void> {
  if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill('SIGKILL');
  await child.exit;
}

describe('the entrypoint guard', () => {
  test('argv[1] through a symlink still resolves to this module', () => {
    // The unit form of the bug. Node's ESM loader realpaths the entry point, so `import.meta.url`
    // is the real path while `process.argv[1]` is whatever was typed on the command line.
    const dir = scratchDir('mfarm-guard-');
    const real = join(dir, 'real.mjs');
    const link = join(dir, 'link.mjs');
    writeFileSync(real, '');
    symlinkSync(real, link);

    // Realpathed, because that is what Node hands to `import.meta.url` — and on macOS even
    // `tmpdir()` is itself a symlink, so this matters here too.
    const metaUrl = pathToFileURL(realpathSync(real)).href;
    assert.equal(isEntrypoint(metaUrl, real), true, 'the unsurprising case');
    assert.equal(isEntrypoint(metaUrl, link), true, 'a symlinked argv[1] is still this module');
    assert.equal(isEntrypoint(metaUrl, join(dir, 'somethingelse.mjs')), false);
    assert.equal(isEntrypoint(metaUrl, undefined), false, 'the REPL has no argv[1]');
    assert.equal(isEntrypoint(metaUrl, join(dir, 'does-not-exist.mjs')), false, 'realpathSync throws here');
  });

  test('npm start works under a Capistrano-style release symlink', async () => {
    // `/app/current -> /app/releases/2026-08-16` is the standard layout, and a bind mount that
    // traverses a symlink behaves the same. Before the fix this child printed NOTHING and exited 0,
    // which a supervisor reads as a clean shutdown — and none of the EX_CONFIG signalling below can
    // fire, because the configuration is never parsed.
    const dir = scratchDir('mfarm-deploy-');
    const current = join(dir, 'current');
    symlinkSync(API_DIR.replace(/\/$/, ''), current, 'dir');

    const child = spawnApi(join(current, 'src', 'main.ts'));
    try {
      const address = await listening(child);
      assert.match(address, /^http:\/\/127\.0\.0\.1:\d+$/);

      child.proc.kill('SIGTERM');
      const { code } = await child.exit;
      assert.equal(code, 0, child.err());
    } finally {
      await reap(child);
    }
  });
});

describe('exit codes', () => {
  test('78 (EX_CONFIG) and the whole problem list on a refused configuration', async () => {
    // Distinguishable from "crashed and might recover", which is the entire reason ADR-0001 picked
    // a specific code. The message has to carry every problem: one variable per restart is an hour
    // of deploy loop.
    const child = spawnApi(MAIN, {
      NODE_ENV: 'production',
      DATABASE_URL: DEV_SYSTEM_URL,
      APP_DATABASE_URL: DEV_APP_URL,
    });
    try {
      const { code } = await child.exit;
      assert.equal(code, 78, `stderr:\n${child.err()}`);
      assert.match(child.err(), /Refusing to start/);
      for (const needle of ['DATABASE_URL', 'APP_DATABASE_URL', 'SESSION_SIGNING_KEY']) {
        assert.ok(child.err().includes(needle), `${needle} missing from:\n${child.err()}`);
      }
      assert.equal(boundAddress(child), undefined, 'a refused configuration must never bind a port');
    } finally {
      await reap(child);
    }
  });

  test('the metrics listener is a second port, and it goes away with the process', async () => {
    // The unit tests build the metrics server directly; this is the only place that proves `main`
    // actually wires it up, on a port of its own, and tears it down on the way out. A control plane
    // that starts without it is a farm running blind, which is the failure this whole listener
    // exists to prevent.
    const child = spawnApi(MAIN, { METRICS_TOKEN: 'entrypoint-scrape-token' });
    try {
      const api = await listening(child);
      const metrics = await waitFor(
        () => {
          for (const line of child.out().split('\n')) {
            if (!line.startsWith('{')) continue;
            try {
              const rec = JSON.parse(line) as { msg?: string; address?: string; authenticated?: boolean };
              if (rec.msg === 'metrics listening' && rec.address) return rec;
            } catch { /* half-written line */ }
          }
          return undefined;
        },
        30_000,
        'the metrics listener to log its address',
      );
      assert.equal(metrics.authenticated, true);

      const port = Number(metrics.address!.split(':').pop());
      assert.notEqual(port, Number(new URL(api).port), 'it must not share the API listener');

      const url = `http://127.0.0.1:${port}/metrics`;
      assert.equal((await fetch(url)).status, 401, 'a token was set, so anonymous is refused');
      const ok = await fetch(url, { headers: { authorization: 'Bearer entrypoint-scrape-token' } });
      assert.equal(ok.status, 200);
      assert.match(await ok.text(), /mfarm_devices/);

      child.proc.kill('SIGTERM');
      const { code } = await child.exit;
      assert.equal(code, 0, child.err());
      await assert.rejects(() => fetch(url), 'the port must be released on shutdown');
    } finally {
      await reap(child);
    }
  });

  test('0 after SIGTERM drains cleanly', async () => {
    const child = spawnApi(MAIN);
    try {
      await listening(child);
      child.proc.kill('SIGTERM');
      const { code, signal } = await child.exit;
      assert.equal(signal, null, 'the process must exit on its own, not die of the signal');
      assert.equal(code, 0, child.err());
    } finally {
      await reap(child);
    }
  });

  test('1 when a second signal arrives during the drain', async () => {
    // An operator sending it twice means it. Refusing the second is how a rolling deploy stalls
    // until the kubelet SIGKILLs the pod anyway, with the pools left open instead of closed.
    //
    // The drain has to be genuinely slow for this to test anything, so a request is left in flight:
    // a POST that announces more body than it sends. `/v1/workers/register` is public, so the
    // request reaches the body parser instead of being rejected at preParsing, and Fastify's
    // close() waits for it. SHUTDOWN_GRACE_MS is 30s, so nothing resolves this on its own.
    const child = spawnApi(MAIN);
    try {
      const address = await listening(child);
      const port = Number(new URL(address).port);
      const socket = connect(port, '127.0.0.1');
      await new Promise((r) => socket.once('connect', r));
      socket.write(
        'POST /v1/workers/register HTTP/1.1\r\nHost: localhost\r\n' +
          'Content-Type: application/json\r\nContent-Length: 4096\r\n\r\n{',
      );
      await sleep(250);

      child.proc.kill('SIGTERM');
      await waitFor(() => (child.out().includes('shutting down') ? true : undefined), 5_000, 'the drain to start');
      assert.equal(child.proc.exitCode, null, 'the drain should still be waiting on the open request');

      child.proc.kill('SIGTERM');
      const { code } = await child.exit;
      assert.equal(code, 1, child.err());
      assert.match(child.err(), /exiting now, in-flight requests dropped/);
      socket.destroy();
    } finally {
      await reap(child);
    }
  });

  test('1 on an uncaught exception, with no drain attempted', async () => {
    // No drain on purpose: the shutdown path runs application code, and application code is exactly
    // what has just proven untrustworthy. The fault is injected from a preloaded module rather than
    // from main.ts, so nothing test-only exists in the shipped entrypoint.
    const dir = scratchDir('mfarm-fault-');
    const fault = join(dir, 'fault.mjs');
    writeFileSync(fault, "setTimeout(() => { throw new Error('injected fault'); }, 1500).unref();\n");

    const child = spawnApi(MAIN, {}, ['--import', pathToFileURL(fault).href]);
    try {
      await listening(child);
      const { code } = await child.exit;
      assert.equal(code, 1, child.err());
      assert.match(child.err(), /uncaughtException/);
      assert.match(child.err(), /injected fault/);
      assert.ok(!child.out().includes('shutting down'), 'no drain may be attempted after an uncaught exception');
    } finally {
      await reap(child);
    }
  });
});
