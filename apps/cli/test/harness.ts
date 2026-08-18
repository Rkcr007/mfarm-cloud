import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * A real control plane on a real ephemeral port, and the real `mfarm` binary as a real child
 * process.
 *
 * Mocking the HTTP layer here would test our idea of fetch rather than the CLI: signal delivery,
 * exit-code propagation and stdio inheritance are all properties of an actual process, and a mocked
 * transport cannot fail the way a socket does. The parts worth trusting are exactly the parts a
 * mock removes.
 */

export const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
export const API_KEY = 'mfk_test_0123456789abcdef';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  /** Byte count as it arrived. An APK upload is binary, so `body` is not a useful record of it. */
  bodyBytes: number;
}

export interface FakeSession {
  id: string;
  state: string;
  deviceId: string | null;
  region: string;
}

export interface FakeControlPlaneOptions {
  /** Status codes returned by POST /v1/sessions, consumed in order; the last one repeats. */
  createStatuses?: number[];
  /** States returned by GET /v1/sessions/:id, consumed in order; the last one repeats. */
  pollStates?: string[];
  region?: string;
  deleteStatus?: number;
  /**
   * Hold DELETE /v1/sessions/:id open this long before answering. Models the case the release
   * window exists for at all: a control plane that is slow, not down.
   */
  deleteDelayMs?: number;
  /** Answer GET without a data-plane block, as a control plane older than the known-issue-9 fix
   *  does. The CLI must degrade rather than crash. */
  omitPolledDataPlane?: boolean;
  /** States returned by GET /v1/installs/:id, consumed in order; the last one repeats. */
  installStates?: string[];
  /** Error text attached to a FAILED install, as a worker would have reported it. */
  installError?: string;
  /** Answer POST /v1/apps with this status instead of 201. 200 means "already in the library". */
  uploadStatus?: number;
}

export interface FakeControlPlane {
  url: string;
  requests: RecordedRequest[];
  of: (method: string, prefix: string) => RecordedRequest[];
  close: () => Promise<void>;
}

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const DEVICE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
export const APP_ID = '99999999-8888-7777-6666-555555555555';
export const INSTALL_ID = '12121212-3434-5656-7878-909090909090';
export { SESSION_ID };

/** Deliberately different from the values POST hands back, so a test can tell WHICH response the
 *  child's environment actually came from. */
export const POLLED_ENDPOINT = 'wss://worker-2.mfarm.dev/ws';
export const POLLED_TOKEN = 'v1.polled.token';

export async function startControlPlane(opts: FakeControlPlaneOptions = {}): Promise<FakeControlPlane> {
  const createStatuses = [...(opts.createStatuses ?? [201])];
  const pollStates = [...(opts.pollStates ?? ['ACTIVE'])];
  const region = opts.region ?? 'us-east';
  const installStates = [...(opts.installStates ?? ['INSTALLED'])];
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    collect(req).then(({ body, bytes }) => {
      const path = req.url ?? '';
      requests.push({
        method: req.method ?? '',
        path,
        headers: req.headers as Record<string, string>,
        body,
        bodyBytes: bytes,
      });

      if (req.method === 'POST' && path === '/v1/sessions') {
        const status = createStatuses.length > 1 ? createStatuses.shift()! : createStatuses[0]!;
        return respondToCreate(res, status, region);
      }
      if (req.method === 'GET' && path.startsWith('/v1/sessions/')) {
        const state = pollStates.length > 1 ? pollStates.shift()! : pollStates[0]!;
        const live = state === 'ALLOCATING' || state === 'ACTIVE';
        return json(res, 200, {
          session: {
            id: SESSION_ID,
            state,
            deviceId: state === 'QUEUED' ? null : DEVICE_ID,
            region,
            endReason: state === 'FAILED' ? 'no_capacity' : null,
          },
          // Mirrors the real route since known issue 9 was fixed: a live session carries its
          // coordinates here too, which is the ONLY place a promoted session can get them — POST
          // answered 202 with no device, so it had no endpoint and no token to give.
          ...(live && !opts.omitPolledDataPlane
            ? { dataPlane: { endpoint: POLLED_ENDPOINT, token: POLLED_TOKEN, expiresInSeconds: 120 } }
            : {}),
        });
      }
      if (req.method === 'DELETE' && path.startsWith('/v1/sessions/')) {
        const status = opts.deleteStatus ?? 204;
        const answer = () => {
          if (res.writableEnded || res.destroyed) return;
          if (status === 204) {
            res.writeHead(204).end();
            return;
          }
          json(res, status, {
            error: { code: 'not_found', message: 'Active session not found.', requestId: 'req-del' },
          });
        };
        if (opts.deleteDelayMs) {
          // unref'd: a pending slow release must never be the reason `server.close()` hangs the
          // test run after the assertions have already passed.
          setTimeout(answer, opts.deleteDelayMs).unref();
          return;
        }
        return answer();
      }
      // --- app library ---------------------------------------------------------------------
      if (req.method === 'POST' && path.startsWith('/v1/apps')) {
        const status = opts.uploadStatus ?? 201;
        return json(res, status, {
          app: {
            id: APP_ID, packageName: 'dev.mfarm.example', versionName: '1.4.2', versionCode: 42,
            label: 'Example', minSdk: 26, sha256: 'a'.repeat(64), sizeBytes: 4096,
            filename: 'example.apk', platform: 'android', createdAt: '2026-08-19T00:00:00.000Z',
          },
          deduplicated: status === 200,
        });
      }
      if (req.method === 'GET' && path.startsWith('/v1/apps')) {
        return json(res, 200, {
          apps: [{
            id: APP_ID, packageName: 'dev.mfarm.example', versionName: '1.4.2', versionCode: 42,
            label: 'Example', minSdk: 26, sha256: 'a'.repeat(64), sizeBytes: 4096,
            filename: 'example.apk', platform: 'android', createdAt: '2026-08-19T00:00:00.000Z',
          }],
        });
      }
      if (req.method === 'POST' && /^\/v1\/sessions\/[^/]+\/installs$/.test(path)) {
        return json(res, 202, {
          install: {
            id: INSTALL_ID, appId: APP_ID, sessionId: SESSION_ID, deviceId: DEVICE_ID,
            state: 'PENDING', error: null,
          },
          message: 'Queued.',
        });
      }
      if (req.method === 'GET' && path.startsWith('/v1/installs/')) {
        const state = installStates.length > 1 ? installStates.shift()! : installStates[0]!;
        return json(res, 200, {
          install: {
            id: INSTALL_ID, appId: APP_ID, sessionId: SESSION_ID, deviceId: DEVICE_ID,
            state,
            error: state === 'FAILED' ? (opts.installError ?? 'adb: Failure [INSTALL_FAILED_OLDER_SDK]') : null,
          },
        });
      }

      if (req.method === 'GET' && path.startsWith('/v1/devices')) {
        return json(res, 200, {
          devices: [{
            id: DEVICE_ID, region, platform: 'android', tier: 'cuttlefish',
            model: 'Pixel 8', osVersion: '15', state: 'READY', dedicated: false,
          }],
          available: 1,
        });
      }
      return json(res, 404, {
        error: { code: 'not_found', message: `No route for ${req.method} ${path}.`, requestId: 'req-404' },
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');

  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    of: (method, prefix) => requests.filter((r) => r.method === method && r.path.startsWith(prefix)),
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      // A deliberately-slow handler can still be holding a socket. The test is over; drop it
      // rather than letting cleanup outlive the assertions.
      server.closeAllConnections();
    }),
  };
}

function respondToCreate(res: ServerResponse, status: number, region: string): void {
  if (status === 201) {
    return json(res, 201, {
      session: { id: SESSION_ID, state: 'ALLOCATING', deviceId: DEVICE_ID, fence: 1, region },
      dataPlane: { endpoint: 'wss://worker-1.mfarm.dev/ws', token: 'v1.signed.token', expiresInSeconds: 1800 },
    });
  }
  if (status === 202) {
    return json(res, 202, {
      session: { id: SESSION_ID, state: 'QUEUED', deviceId: null },
      message: 'No device is free right now.',
    });
  }
  // Mirrors apps/api/src/http/errors.ts exactly — the requestId is what support asks for, so the
  // CLI has to surface it and the test has to be able to prove it did.
  return json(res, status, {
    error: {
      code: status >= 500 ? 'internal' : 'bad_request',
      message: status >= 500 ? 'Internal error. Quote the requestId when reporting it.' : 'region is required.',
      requestId: `req-${status}`,
    },
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function collect(req: IncomingMessage): Promise<{ body: unknown; bytes: number }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const raw = buf.toString('utf8');
      if (!raw) return resolve({ body: null, bytes: 0 });
      try {
        resolve({ body: JSON.parse(raw), bytes: buf.length });
      } catch {
        // An APK, or anything else that is not JSON. The byte count is the useful record.
        resolve({ body: raw, bytes: buf.length });
      }
    });
  });
}

export interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface CliRunOptions {
  env?: Record<string, string | undefined>;
  /** Called per stderr chunk with a killer, so signals can be timed against real progress output. */
  onStderr?: (chunk: string, kill: (sig: NodeJS.Signals) => void) => void;
  /** Same, for stdout — the grandchild's own output arrives here through stdio inheritance. */
  onStdout?: (chunk: string, kill: (sig: NodeJS.Signals) => void) => void;
}

export function runCli(args: string[], opts: CliRunOptions = {}): Promise<CliResult> {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', BIN, ...args],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MFARM_API_KEY: API_KEY, ...opts.env },
      // Its own process group, so a signal sent to the CLI is not also delivered to the whole
      // test run by the OS. Signal forwarding is the thing under test; it has to be ours.
      detached: true,
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => {
    stdout += c;
    opts.onStdout?.(c, (sig) => child.kill(sig));
  });
  child.stderr.setEncoding('utf8').on('data', (c: string) => {
    stderr += c;
    opts.onStderr?.(c, (sig) => child.kill(sig));
  });

  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/** A child that writes its mfarm environment to `path` as JSON and exits with `code`. */
export function envDumper(path: string, code = 0): string[] {
  return [
    '-e',
    `const fs=require('fs');` +
    `const keys=Object.keys(process.env).filter(k=>k.startsWith('MFARM_'));` +
    `fs.writeFileSync(process.argv[1],JSON.stringify(Object.fromEntries(keys.map(k=>[k,process.env[k]]))));` +
    `process.exit(${code});`,
    path,
  ];
}
