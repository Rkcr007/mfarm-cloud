/**
 * The farm, as this console talks to it.
 *
 * Same-origin and cookie-authenticated. There is no sign-in here yet: the cookie is minted by the
 * old console at `/`, and `GET /v1/auth/me` hands the CSRF token back so a reloaded page can
 * recover it — which its own comment in `routes/auth.ts` says is exactly what it is for.
 */

export interface Device {
  id: string;
  model: string;
  state: string;
  platform: string;
  osVersion: string;
  tier: string;
  region: string;
  profile?: string;
  screen?: { width: number; height: number; density: number };
  capabilities?: string[];
}

export interface SessionDataPlane {
  endpoint: string;
  browserEndpoint: string;
  token: string;
  expiresInSeconds: number;
}

export interface SessionDetail {
  session: { id: string; state: string; deviceId: string | null; region: string };
  dataPlane?: SessionDataPlane;
  /**
   * TURN credentials, and THEY LIVE BESIDE `session` RATHER THAN INSIDE IT.
   *
   * Called out because the old console shipped this bug: spreading `out.session` alone produced a
   * viewer with no relay, which works perfectly on the farm's own network and fails from anywhere
   * else with an empty peer connection, no error, and nothing in coturn's log to say nobody called.
   */
  ice?: { iceServers: RTCIceServer[] };
}

export class ApiError extends Error {
  /**
   * Declared then assigned, NOT a parameter property.
   *
   * `readonly status` in the signature is TypeScript that Node cannot strip — it emits an
   * assignment, so it is syntax rather than a type. `erasableSyntaxOnly` in the tsconfig makes that
   * a compile error rather than something a test discovers at import time.
   */
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let csrf: string | null = null;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  // Double-submitted on every mutation. A GET must not send it — the header is what proves the
  // request came from a page that could read the login response, and GETs are not protected by it.
  if (method !== 'GET' && method !== 'HEAD' && csrf) headers.set('x-mfarm-csrf', csrf);

  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    const message = (body && typeof body === 'object' && 'message' in body
      ? String((body as { message: unknown }).message)
      : null) ?? `The farm answered ${res.status}.`;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

export interface Me {
  user: { id: string; email: string };
  org: { id: string; name: string; slug: string; maxConcurrent: number };
  role: string;
  csrfToken?: string;
}

/** Also the sign-in check: a 401 here is what "not signed in" means for this console. */
export async function whoami(): Promise<Me> {
  const me = await request<Me>('/v1/auth/me');
  if (me.csrfToken) csrf = me.csrfToken;
  return me;
}

export async function listDevices(): Promise<Device[]> {
  const body = await request<{ devices: Device[] }>('/v1/devices');
  return body.devices ?? [];
}

/**
 * Take a device, then read the session back.
 *
 * TWO CALLS ON PURPOSE, and this is not laziness. `POST /v1/sessions` returns `session` and
 * `dataPlane` but NOT `ice` — the relay credentials are minted only by `GET /v1/sessions/:id`.
 * Connecting from the POST alone gives a viewer with no TURN, which is invisible on the farm's own
 * network and broken from everywhere else.
 */
export async function startSession(d: Device): Promise<SessionDetail> {
  const created = await request<{ session: { id: string; deviceId: string | null } }>('/v1/sessions', {
    method: 'POST',
    // Region, platform and tier only — the same three the old console sends.
    //
    // NO `requireCapabilities: ['screen-stream']`, which was the first thing written here and is
    // wrong. A device with no video is not unusable by this screen: `nostream` is a supported state
    // in `live.js`, and on such a device the socket, the buttons, the logs and the screenshots all
    // still work. Demanding the capability would make every physical handset unschedulable from
    // here in exchange for turning a screen that says why it is blank into an allocation error.
    body: JSON.stringify({ region: d.region, platform: d.platform, tier: d.tier }),
  });
  // A queued session has no device yet. The caller polls; it is not an error.
  return getSession(created.session.id);
}

export async function getSession(id: string): Promise<SessionDetail> {
  return request<SessionDetail>(`/v1/sessions/${encodeURIComponent(id)}`);
}

export async function releaseSession(id: string): Promise<void> {
  await request<void>(`/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Test seam: the CSRF token is module state, and a test that mutates must be able to set it. */
export function __setCsrfForTest(v: string | null): void { csrf = v; }
