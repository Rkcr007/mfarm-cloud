import { describe } from './client.ts';

/**
 * The smallest WebDriver client that can drive a farm device through `/wd/hub` — for `mfarm mcp`.
 *
 * WHY NOT A WEBDRIVER LIBRARY. The CLI ships zero runtime dependencies (see `wire.ts`), and what an
 * agent needs is eight commands, every one of them a JSON POST or GET. The hub forwards everything
 * under `/session/:id/*` verbatim (ADR-0018 Model A), so this file only has to speak W3C, never
 * MFARM: allocation, app install, recording and release all happen hub-side from the capabilities.
 *
 * THE CREDENTIAL IS BASIC `key:` — the same one `examples/python-pytest` sends. The hub reads an
 * empty password as "allocate from my capabilities" and a session id there as "drive that session";
 * this client always allocates, so the password is always empty.
 */

/** Allocation waits out a queue (`mfarm:queueTimeoutSeconds`) plus an install; everything else is one command. */
const NEW_SESSION_TIMEOUT_MS = 330_000;
const COMMAND_TIMEOUT_MS = 90_000;

/** A W3C error from the hub or the device's automation server, with the spec's error code kept. */
export class HubError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HubError';
    this.status = status;
    this.code = code;
  }
}

export interface HubSession {
  sessionId: string;
  capabilities: Record<string, unknown>;
}

export class HubClient {
  readonly hubUrl: string;
  private readonly authorization: string;

  constructor(opts: { apiBaseUrl: string; apiKey: string }) {
    // The hub is mounted at the ORIGIN — a base of `https://api.mfarm.dev/v1` must not become
    // `/v1/wd/hub`. Same rule as `webdriverUrl` in client.ts.
    const url = new URL(opts.apiBaseUrl);
    this.hubUrl = `${url.origin}/wd/hub`;
    this.authorization = `Basic ${Buffer.from(`${opts.apiKey}:`).toString('base64')}`;
  }

  async newSession(alwaysMatch: Record<string, unknown>): Promise<HubSession> {
    const value = await this.call('POST', '/session', { capabilities: { alwaysMatch, firstMatch: [{}] } }, NEW_SESSION_TIMEOUT_MS) as
      { sessionId?: string; capabilities?: Record<string, unknown> } | null;
    if (!value?.sessionId) throw new HubError(502, 'unknown error', 'The hub answered without a session id.');
    return { sessionId: value.sessionId, capabilities: value.capabilities ?? {} };
  }

  /** One command on a session. Returns the W3C `value`. */
  command(sessionId: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    const suffix = path ? `/${path.replace(/^\//, '')}` : '';
    return this.call(method, `/session/${encodeURIComponent(sessionId)}${suffix}`, body, COMMAND_TIMEOUT_MS);
  }

  /** `driver.quit()`. For a hub-allocated session this is also what gives the device back. */
  async deleteSession(sessionId: string): Promise<void> {
    await this.call('DELETE', `/session/${encodeURIComponent(sessionId)}`, undefined, COMMAND_TIMEOUT_MS);
  }

  private async call(method: string, path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.hubUrl}${path}`, {
        method,
        headers: {
          authorization: this.authorization,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new HubError(0, 'unknown error', `${method} ${path}: ${describe(err)}`);
    }
    const text = await res.text().catch(() => '');
    let parsed: { value?: unknown } | null = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON — handled below */ }
    const value = parsed?.value;
    if (!res.ok) {
      const v = value as { error?: string; message?: string } | undefined;
      throw new HubError(
        res.status,
        v?.error ?? 'unknown error',
        v?.message ?? `HTTP ${res.status} from the hub: ${text.slice(0, 200) || '(empty body)'}`,
      );
    }
    return value ?? null;
  }
}

/** The W3C element-reference key. Appium also answers the legacy `ELEMENT`. */
export function elementId(value: unknown): string | null {
  const v = value as Record<string, unknown> | null;
  const id = v?.['element-6066-11e4-a52e-4f735466cecf'] ?? v?.ELEMENT;
  return typeof id === 'string' ? id : null;
}

/** A tap at a point, as W3C pointer actions — the one gesture every automation server agrees on. */
export function tapActions(x: number, y: number): unknown {
  return {
    actions: [{
      type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 80 },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  };
}

export function swipeActions(x1: number, y1: number, x2: number, y2: number, durationMs: number): unknown {
  return {
    actions: [{
      type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: Math.round(x1), y: Math.round(y1) },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 50 },
        { type: 'pointerMove', duration: Math.max(50, Math.round(durationMs)), x: Math.round(x2), y: Math.round(y2) },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  };
}

/** Android keycodes for the keys an agent needs. iOS has only a home button to press. */
export const ANDROID_KEYCODES = { back: 4, home: 3, enter: 66, app_switch: 187, delete: 67 } as const;
export type DeviceKey = keyof typeof ANDROID_KEYCODES;
