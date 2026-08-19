import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';

/**
 * Control-plane client.
 *
 * Zero runtime dependencies, deliberately. This is the thing a CI job runs with `npx` on a cold
 * cache before every test run: each transitive package is another download on the critical path,
 * another audit finding, and another supply-chain edge on a machine that holds the customer's
 * signing keys. `fetch` and `node:util` cover all of it.
 *
 * Nothing in this file logs. The API key lives in an Authorization header and in the WebDriver URL,
 * and the cheapest way to guarantee neither ever lands in a CI log — which is world-readable on
 * public repos and retained for months on private ones — is to have no code path that could print
 * a request.
 */

export interface SessionSummary {
  id: string;
  state: string;
  deviceId: string | null;
  fence?: number | null;
  region?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  expiresAt?: string | null;
  endedAt?: string | null;
  endReason?: string | null;
}

export interface DataPlaneCoordinates {
  endpoint: string;
  token: string;
  expiresInSeconds: number;
}

export interface CreateSessionInput {
  region: string;
  platform: 'android' | 'ios';
  tier?: string;
  ttlMinutes?: number;
  /** Capabilities the device must declare. `['webdriver']` for anything that will drive the hub. */
  requireCapabilities?: string[];
}

export interface SessionResult {
  session: SessionSummary;
  /** Null while the session is queued and once it has ended; non-null while it is live. */
  dataPlane: DataPlaneCoordinates | null;
}

export interface CreateSessionResult extends SessionResult {
  /** 202 rather than 201: the session is real and holds a place in line, but has no device yet. */
  queued: boolean;
}

export interface DeviceSummary {
  id: string;
  region: string;
  platform: string;
  tier: string;
  model: string | null;
  osVersion: string | null;
  state: string;
  dedicated: boolean;
}

export interface DeviceListResult {
  devices: DeviceSummary[];
  available: number;
}

export interface DeviceFilter {
  region?: string;
  platform?: string;
  state?: string;
}

export interface AppSummary {
  id: string;
  packageName: string;
  versionName: string | null;
  versionCode: number | null;
  label: string | null;
  minSdk: number | null;
  sha256: string;
  sizeBytes: number;
  filename: string | null;
  createdAt?: string;
}

export interface UploadResult {
  app: AppSummary;
  /** True when this org had already uploaded these exact bytes. The upload is keyed on the digest. */
  deduplicated: boolean;
}

export type AppActionKind = 'install' | 'launch' | 'uninstall';

export interface ActionSummary {
  id: string;
  kind: AppActionKind | string;
  appId: string;
  sessionId: string;
  deviceId: string;
  state: 'PENDING' | 'DONE' | 'FAILED' | string;
  error: string | null;
  requestedAt?: string;
  finishedAt?: string | null;
}

/**
 * A failure the server described. `requestId` is the only handle support has on a specific request
 * once the customer's log is all that survives, so it is folded into the message rather than left
 * on a field that whoever prints the error has to remember to read.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly serverMessage: string;

  constructor(status: number, code: string, message: string, requestId: string | null) {
    super(requestId ? `${message} (requestId ${requestId})` : message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.serverMessage = message;
  }
}

/** Transport never reached a server that answered, so no requestId exists to quote. */
export class TransportError extends Error {
  readonly attempts: number;

  constructor(message: string, attempts: number) {
    super(message);
    this.name = 'TransportError';
    this.attempts = attempts;
  }
}

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Retries AFTER the first attempt. Three, so a rolling API deploy is invisible to a test run. */
  retries?: number;
  backoffBaseMs?: number;
  requestTimeoutMs?: number;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 2_000;

/**
 * A request that hangs forever is worse than one that fails: CI has no way to tell it apart from a
 * slow test, so it burns the job's whole timeout and reports nothing useful.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface RawResponse {
  status: number;
  body: unknown;
  text: string;
}

export class ControlPlaneClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly retries: number;
  private readonly backoffBaseMs: number;
  private readonly requestTimeoutMs: number;

  constructor(opts: ClientOptions) {
    // Trailing slashes are the difference between /v1/sessions and //v1/sessions, and some
    // reverse proxies 404 the second one.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.retries = opts.retries ?? DEFAULT_RETRIES;
    this.backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async createSession(
    input: CreateSessionInput,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<CreateSessionResult> {
    // The key is minted once and reused by every retry below. A fresh key per attempt would turn
    // "the 503 we retried" into two allocated devices and two billed device-hours, one of which
    // nobody is holding a handle to.
    const res = await this.request('POST', '/v1/sessions', {
      body: {
        region: input.region,
        platform: input.platform,
        ...(input.tier ? { tier: input.tier } : {}),
        ...(input.ttlMinutes ? { ttlMinutes: input.ttlMinutes } : {}),
        ...(input.requireCapabilities?.length ? { requireCapabilities: input.requireCapabilities } : {}),
      },
      headers: { 'idempotency-key': idempotencyKey },
    });

    const payload = res.body as { session?: SessionSummary; dataPlane?: DataPlaneCoordinates };
    if (!payload?.session?.id) {
      throw new TransportError(
        `The control plane answered ${res.status} without a session. Body: ${snippet(res.text)}`,
        1,
      );
    }
    return {
      queued: res.status === 202,
      session: payload.session,
      dataPlane: payload.dataPlane ?? null,
    };
  }

  /**
   * Fetch a session, with its data-plane coordinates when it has any.
   *
   * `dataPlane` is null for a session that is still queued or already over, and non-null for a live
   * one — including a session that was queued when it was created and has since been promoted,
   * which is the case `POST` cannot answer because there was no device yet. The token is short
   * lived (120s), so this is also the only way to refresh coordinates during a long run.
   *
   * An older control plane returns no block at all; `?? null` keeps that a degraded run rather than
   * a crash.
   */
  async getSession(id: string): Promise<SessionResult> {
    const res = await this.request('GET', `/v1/sessions/${encodeURIComponent(id)}`);
    const payload = res.body as { session?: SessionSummary; dataPlane?: DataPlaneCoordinates };
    if (!payload?.session) {
      throw new TransportError(`Malformed session response: ${snippet(res.text)}`, 1);
    }
    return { session: payload.session, dataPlane: payload.dataPlane ?? null };
  }

  /**
   * Release a session. Returns false when the server says there was nothing to release.
   *
   * A 404 is success from the caller's point of view — the reaper got there first, or a previous
   * release already landed and only its response was lost. Treating it as an error would make the
   * idempotent retry that release depends on report a failure every second time.
   *
   * `signal` lets the caller stop waiting. This is the longest call the CLI makes — a 5xx is
   * retried three times at a 30s timeout each — and an operator pressing ^C during it needs the
   * process to actually stop, which means cancelling the socket and not merely ignoring it.
   */
  async deleteSession(id: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.request('DELETE', `/v1/sessions/${encodeURIComponent(id)}`, { signal });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return false;
      throw err;
    }
  }

  async listDevices(filter: DeviceFilter = {}): Promise<DeviceListResult> {
    const qs = new URLSearchParams();
    if (filter.region) qs.set('region', filter.region);
    if (filter.platform) qs.set('platform', filter.platform);
    if (filter.state) qs.set('state', filter.state);
    const suffix = qs.size > 0 ? `?${qs}` : '';
    const res = await this.request('GET', `/v1/devices${suffix}`);
    const payload = res.body as DeviceListResult | undefined;
    return { devices: payload?.devices ?? [], available: payload?.available ?? 0 };
  }

  /**
   * Upload an APK.
   *
   * Streamed from disk, never read into memory: this is the one call in the CLI whose payload is
   * measured in hundreds of megabytes, and `readFile` on a 400 MB build is a 400 MB allocation on a
   * CI runner that has other things to do.
   *
   * Retried like everything else, and safe to retry for a reason the generic path cannot rely on:
   * the server keys an upload on the file's own digest, so a second attempt after a lost response
   * returns the same build rather than creating a duplicate. The stream is reopened per attempt —
   * a consumed one cannot be replayed, which is exactly the trap that makes most upload retries
   * silently send an empty body.
   */
  async uploadApp(filePath: string, signal?: AbortSignal): Promise<UploadResult> {
    // Checked before the loop, because a path that does not exist is not a transport failure and
    // must not be retried three times with backoff before saying so. `createReadStream` fails
    // asynchronously, inside `fetch`, where it is indistinguishable from a dropped connection.
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw new Error(`Not a file: ${filePath}`);

    const url = `${this.baseUrl}/v1/apps?filename=${encodeURIComponent(basename(filePath))}`;
    let lastTransport = '';

    for (let attempt = 0; ; attempt++) {
      // No per-attempt timeout here, unlike `request`. A large upload over a slow link legitimately
      // exceeds 30s, and aborting it would make the CLI unable to upload exactly the builds people
      // most want a farm for. The caller's own signal still cancels.
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            accept: 'application/json',
            'content-type': 'application/vnd.android.package-archive',
          },
          body: Readable.toWeb(createReadStream(filePath)) as ReadableStream,
          // Required by fetch for a streaming request body: we send before the response arrives.
          duplex: 'half',
          signal,
        } as RequestInit & { duplex: 'half' });
      } catch (err) {
        lastTransport = describe(err);
        if (signal?.aborted) throw new TransportError('The upload was cancelled by the caller.', attempt + 1);
        if (attempt >= this.retries) {
          throw new TransportError(`Uploading ${filePath} failed after ${attempt + 1} attempt(s): ${lastTransport}`, attempt + 1);
        }
        await sleep(this.backoffFor(attempt));
        continue;
      }

      if (res.status >= 500 && attempt < this.retries && !signal?.aborted) {
        await res.text().catch(() => '');
        await sleep(this.backoffFor(attempt));
        continue;
      }

      const text = await res.text().catch(() => '');
      const body = parseJson(text);
      if (!res.ok) throw toApiError(res.status, body, text);
      const payload = body as { app?: AppSummary; deduplicated?: boolean };
      if (!payload?.app?.id) {
        throw new TransportError(`The control plane answered ${res.status} without an app. Body: ${snippet(text)}`, attempt + 1);
      }
      return { app: payload.app, deduplicated: payload.deduplicated === true };
    }
  }

  async listApps(packageName?: string): Promise<AppSummary[]> {
    const suffix = packageName ? `?package=${encodeURIComponent(packageName)}` : '';
    const res = await this.request('GET', `/v1/apps${suffix}`);
    return (res.body as { apps?: AppSummary[] })?.apps ?? [];
  }

  /**
   * Ask for a build to be installed, launched or uninstalled on the device a session holds.
   *
   * Returns as soon as the job exists, which is the honest shape: nothing has reached the device
   * yet. The worker collects it on its next heartbeat — poll `getAction` for the outcome.
   */
  async requestAction(sessionId: string, appId: string, kind: AppActionKind = 'install'): Promise<ActionSummary> {
    const res = await this.request('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/app-actions`, {
      body: { appId, kind },
    });
    const payload = res.body as { action?: ActionSummary };
    if (!payload?.action?.id) {
      throw new TransportError(`Malformed app-action response: ${snippet(res.text)}`, 1);
    }
    return payload.action;
  }

  async getAction(actionId: string): Promise<ActionSummary> {
    const res = await this.request('GET', `/v1/app-actions/${encodeURIComponent(actionId)}`);
    const payload = res.body as { action?: ActionSummary };
    if (!payload?.action?.id) throw new TransportError(`Malformed app-action response: ${snippet(res.text)}`, 1);
    return payload.action;
  }

  private async request(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<RawResponse> {
    const url = `${this.baseUrl}${path}`;
    let lastTransport = '';

    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(this.requestTimeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            accept: 'application/json',
            ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(opts.headers ?? {}),
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          // Per-attempt timeout, plus the caller's own cancellation if it gave us one.
          signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
        });
      } catch (err) {
        lastTransport = describe(err);
        // The caller withdrew the request. Retrying would be doing work nobody is waiting for, on
        // a socket the caller explicitly asked us to drop.
        if (opts.signal?.aborted) {
          throw new TransportError(`${method} ${path} was cancelled by the caller.`, attempt + 1);
        }
        if (attempt >= this.retries) {
          throw new TransportError(
            `${method} ${path} failed after ${attempt + 1} attempt(s): ${lastTransport}`,
            attempt + 1,
          );
        }
        await sleep(this.backoffFor(attempt));
        continue;
      }

      // 5xx only. A 4xx is the caller's fault and will be the caller's fault again in 250ms — the
      // retry just multiplies the rate-limit pressure that produced the 429 in the first place.
      if (res.status >= 500 && attempt < this.retries && !opts.signal?.aborted) {
        // Draining is not optional: undici keeps the socket in the pool until the body is consumed,
        // so an abandoned response leaks a connection per retry.
        await res.text().catch(() => '');
        lastTransport = `HTTP ${res.status}`;
        await sleep(this.backoffFor(attempt));
        continue;
      }

      const text = await res.text().catch(() => '');
      const body = parseJson(text);
      if (!res.ok) throw toApiError(res.status, body, text);
      return { status: res.status, body, text };
    }
  }

  /**
   * Exponential with jitter. Without the jitter a fleet of CI runners that all hit the same 503
   * comes back in lockstep and re-lands the outage they were waiting out.
   */
  private backoffFor(attempt: number): number {
    const ceiling = Math.min(this.backoffBaseMs * 2 ** attempt, BACKOFF_CAP_MS);
    return ceiling / 2 + Math.random() * (ceiling / 2);
  }
}

/**
 * The exact substring that carries the credential inside a WebDriver URL.
 *
 * Exported because *this*, not the raw key, is what appears in `MFARM_WEBDRIVER_URL` — so this is
 * what anything registering a redaction (GitHub's `::add-mask::`, a log scrubber) has to be given.
 * Masking only the raw key leaves the URL form unredacted the first time an Appium client logs its
 * own configuration.
 *
 * Today the two forms are identical: `generateApiKey` in `apps/api/src/auth.ts` mints
 * `mfk_` + base64url(32 bytes), whose alphabet (`A-Za-z0-9-_`) contains nothing the userinfo
 * component encodes. The encoding is here so that stays true if the key format ever changes, and
 * because it removes a silent failure the URL setter has independently of any alphabet: assigning
 * to `url.username` *strips* tab, CR and LF rather than encoding them, so a key that picked up a
 * stray newline (a secret pasted with one, a `$(cat key.txt)`) would produce a URL carrying a
 * different credential than the one we were handed, and a 401 nobody can explain.
 * `encodeURIComponent` encodes every one of those, so the round trip always holds.
 */
export function webdriverCredential(apiKey: string): string {
  return encodeURIComponent(apiKey);
}

/**
 * `<api-origin>/wd/hub` with the key as HTTP Basic userinfo.
 *
 * This single string is the migration story: an Appium suite reads it, changes nothing else, and
 * runs on the cloud. Any path on the configured API base is dropped, because the hub is mounted at
 * the origin and a base of `https://api.mfarm.dev/v1` must not produce `/v1/wd/hub`.
 *
 * `sessionId` goes in the password half, and it is what stops `mfarm run` from paying twice.
 * Without it the hub has no way to know a session already exists, so it allocates its own from the
 * client's capabilities — two devices held, two billed, and the one this CLI allocated never
 * touched (ADR-0002 D1). The hub reads it as "drive this session", not as a credential; it grants
 * nothing the API key does not already grant.
 *
 * The password field is the only carrier available. The path is fixed by the protocol, a query
 * string does not survive the `base + '/session'` string concatenation most WebDriver clients do,
 * and a capability would mean editing the customer's suite — which is precisely the thing this
 * whole file exists to avoid.
 */
export function webdriverUrl(apiBaseUrl: string, apiKey: string, sessionId?: string): string {
  const url = new URL(apiBaseUrl);
  url.username = webdriverCredential(apiKey);
  url.password = sessionId ?? '';
  url.pathname = '/wd/hub';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Anything derived from the API key is a credential. Log the masked form or nothing. */
export function maskUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return url.toString();
    url.username = '***';
    url.password = '';
    return url.toString();
  } catch {
    return value;
  }
}

function toApiError(status: number, body: unknown, text: string): ApiError {
  const envelope = (body as { error?: { code?: string; message?: string; requestId?: string } })?.error;
  if (envelope?.message) {
    return new ApiError(status, envelope.code ?? 'unknown', envelope.message, envelope.requestId ?? null);
  }
  // Not our envelope, so it came from something in front of the API — a load balancer, a proxy, a
  // captive portal on a corporate network. Show the snippet; guessing is worse than quoting.
  return new ApiError(status, 'unknown', `HTTP ${status} from the control plane: ${snippet(text)}`, null);
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat || '(empty body)';
}

export function describe(err: unknown): string {
  if (err instanceof Error) {
    // fetch buries the useful half ("ECONNREFUSED") in `cause` and surfaces only "fetch failed".
    const cause = (err as { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? `: ${cause.message}` : '';
    return `${err.message}${causeText}`;
  }
  return String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
