import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { withTenant, withSystem } from '../../db.ts';
import { allocate, activate, release } from '../../allocator.ts';
import { requireTenant } from '../server.ts';
import { ApiError } from '../errors.ts';
import { parseCapabilities } from '../webdriver/capabilities.ts';
import {
  WebDriverError, invalidSessionId, sessionNotCreated, toW3cBody, fromApiError,
} from '../webdriver/errors.ts';

/**
 * The W3C WebDriver hub — v2 decision 10, and the actual adoption path.
 *
 * A team migrates by changing one URL and adding two capabilities. Their existing Appium suite,
 * their existing client library, their existing CI config: unchanged. That is the whole point, and
 * it is why the wire protocol is the product and the UI is the demo.
 *
 * ---
 *
 * THIS ENDPOINT PROXIES, AND THAT IS A DELIBERATE EXCEPTION TO "never proxy the data plane".
 *
 * Interactive input goes browser -> worker directly, because a human notices 30 ms. WebDriver does
 * not get the same treatment, for two reasons:
 *
 *   1. A WebDriver client resolves ONE base URL and uses it for the session's entire life. There is
 *      no redirect in the protocol and no client-side hook to move a live session to another host.
 *      "One hub URL" and "connect straight to the worker" are mutually exclusive; the hub URL wins,
 *      because that is the thing customers are buying.
 *   2. The automation server must not be publicly reachable. An exposed Appium port is
 *      unauthenticated device control — anyone who finds it owns the device and every session on it.
 *      Proxying means the tenant boundary is enforced in front of it, by code that knows about orgs.
 *
 * The cost is one extra hop of a few milliseconds on commands that already take tens to hundreds of
 * milliseconds inside the device. It does not touch the glass-to-glass number the product is sold on.
 * Media and artifacts never come through here.
 */

/** Appium session creation installs apps and boots drivers; minutes is normal, not pathological. */
const NEW_SESSION_TIMEOUT_MS = Number(process.env.MFARM_WD_NEW_SESSION_TIMEOUT_MS ?? 300_000);
const COMMAND_TIMEOUT_MS = Number(process.env.MFARM_WD_COMMAND_TIMEOUT_MS ?? 180_000);

/**
 * Far above the global limit on purpose. A suite with an implicit wait polls `findElement` in a
 * tight loop, so the control plane's 120/min would fail honest tests as abuse — the exact
 * first-hour experience a migration cannot survive.
 */
const WD_RATE_LIMIT_MAX = Number(process.env.MFARM_WD_RATE_LIMIT_MAX ?? 6_000);

/** `pushFile` and `setClipboard` carry base64 payloads that blow past the 1 MB global limit. APKs
 *  are not meant to travel this way — `appium:app` takes a URL — but a few MB has to work. */
const WD_BODY_LIMIT = Number(process.env.MFARM_WD_BODY_LIMIT ?? 16 * 1024 * 1024);

const POLL_INTERVAL_MS = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface UpstreamReply {
  status: number;
  contentType: string;
  text: string;
}

async function callUpstream(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<UpstreamReply> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? 'application/json; charset=utf-8',
    text: await res.text(),
  };
}

const parseJson = (text: string): unknown => {
  try { return JSON.parse(text); } catch { return undefined; }
};

/**
 * Pull the session id out of an upstream reply, accepting either dialect.
 *
 * Appium 2 answers W3C (`value.sessionId`); some drivers and every 1.x server answer JSONWP
 * (top-level `sessionId`). We speak to whatever is actually there rather than requiring the fleet to
 * be homogeneous.
 */
function readUpstreamSession(body: unknown): { id: string; capabilities: Record<string, unknown> } | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const value = (typeof b.value === 'object' && b.value !== null ? b.value : {}) as Record<string, unknown>;
  const id = (typeof value.sessionId === 'string' ? value.sessionId : undefined)
    ?? (typeof b.sessionId === 'string' ? b.sessionId : undefined);
  if (!id) return null;
  const caps = (typeof value.capabilities === 'object' && value.capabilities !== null
    ? value.capabilities
    : value) as Record<string, unknown>;
  return { id, capabilities: caps };
}

/** Whatever the upstream said went wrong, in one line a test author can act on. */
function upstreamFailureMessage(reply: UpstreamReply): string {
  const body = parseJson(reply.text) as { value?: { message?: string; error?: string } } | undefined;
  const detail = body?.value?.message ?? body?.value?.error ?? reply.text.slice(0, 500);
  return detail?.trim() ? detail.trim() : `automation server returned HTTP ${reply.status}`;
}

/** Capability values a suite may legitimately send that must not end up sitting in our database. */
const SECRET_KEY = /pass(word)?|secret|token|credential|apikey|api_key|authorization/i;

function redact(caps: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(caps)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : v;
  return out;
}

export async function webdriverRoutes(app: FastifyInstance) {
  // Registered under two prefixes (Appium 2 serves at `/`, Selenium Grid and Appium 1 at `/wd/hub`),
  // so the proxy has to know which one it was reached through to reconstruct the upstream path.
  const prefix = app.prefix;

  /**
   * Every failure under this prefix must come back in the W3C envelope. The control plane's own
   * `{error:{...}}` shape is opaque to a WebDriver client, which is how an expired API key turns
   * into "unknown server-side error" in someone's CI log.
   */
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof WebDriverError) {
      return reply.code(err.statusCode).type('application/json').send(toW3cBody(err, req.id));
    }
    if (err instanceof ApiError) {
      const w = fromApiError(err.statusCode, err.code, err.message);
      return reply.code(w.statusCode).type('application/json').send(toW3cBody(w, req.id));
    }
    // 413 from bodyLimit, 415 from a content-type Appium's HTTP layer chose, 429 from the limiter:
    // all thrown with a status attached, and all indistinguishable from a crash without this.
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const w = fromApiError(status, 'client_error', err.message);
      return reply.code(status).type('application/json').send(toW3cBody(w, req.id));
    }
    req.log.error({ err, reqId: req.id }, 'unhandled error in webdriver hub');
    const w = new WebDriverError('unknown error', 'Internal error. Quote the requestId when reporting it.', { mfarmCode: 'internal' });
    return reply.code(500).type('application/json').send(toW3cBody(w, req.id));
  });

  const routeOpts = {
    bodyLimit: WD_BODY_LIMIT,
    config: {
      rateLimit: {
        max: WD_RATE_LIMIT_MAX,
        timeWindow: '1 minute',
        // Returns an Error, not a body: the plugin throws this, so a plain object would arrive at
        // the error handler unrecognised and come back as a 500 instead of a 429.
        errorResponseBuilder: (_req: FastifyRequest, ctx: { ttl: number; statusCode: number }) =>
          fromApiError(
            ctx.statusCode,
            'rate_limited',
            `Rate limit exceeded. Retry after ${Math.ceil(ctx.ttl / 1000)}s.`,
          ),
      },
    },
  };

  // ---------------------------------------------------------------- status

  /**
   * Unauthenticated by design: clients call it to check the hub is alive before they have done
   * anything, and it discloses nothing tenant-specific.
   */
  app.get('/status', routeOpts, async () => ({
    value: {
      ready: true,
      message: 'mfarm WebDriver hub. Send platformName plus mfarm:region to POST /session.',
      build: { version: process.env.MFARM_VERSION ?? 'dev' },
    },
  }));

  // ---------------------------------------------------------------- new session

  app.post('/session', routeOpts, async (req, reply) => {
    const { orgId } = requireTenant(req);
    const caps = parseCapabilities(req.body, {
      defaultRegion: process.env.MFARM_DEFAULT_REGION,
    });

    const alloc = await allocate({
      orgId,
      userId: null,
      region: caps.region,
      platform: caps.platform,
      tier: caps.tier ?? null,
      ttlMinutes: caps.ttlMinutes,
      // A device with no automation server cannot serve this session. Demanding the capability up
      // front is the difference between "no capacity" and allocating, failing, and trying again.
      requireCapabilities: ['webdriver'],
    });

    let deviceId = alloc.deviceId;
    let fence = alloc.fence;

    if (deviceId === null) {
      const promoted = await waitForCapacity(req, orgId, alloc.sessionId, caps.queueTimeoutSeconds);
      if (!promoted) {
        await release(orgId, alloc.sessionId, 'no_capacity');
        throw sessionNotCreated(
          caps.queueTimeoutSeconds > 0
            ? `No ${caps.platform} device with an automation server became free in ${caps.queueTimeoutSeconds}s in region ${caps.region}.`
            : `No ${caps.platform} device with an automation server is free in region ${caps.region}. Set the \`mfarm:queueTimeoutSeconds\` capability to wait for one instead of failing.`,
          'no_capacity',
        );
      }
      deviceId = promoted.deviceId;
      fence = promoted.fence;
    }

    // From here on the device is OURS and every exit path has to give it back. A device left in
    // RESERVED because Appium failed to start is capacity that is billed to nobody and usable by
    // nobody until the reaper notices.
    try {
      const target = await withSystem(async (c) => {
        const { rows } = await c.query(
          `SELECT d.local_id, h.automation_endpoint
             FROM devices d JOIN hosts h ON h.id = d.host_id
            WHERE d.id = $1`,
          [deviceId],
        );
        return rows[0] as { local_id: string | null; automation_endpoint: string | null } | undefined;
      });

      if (!target?.automation_endpoint) {
        throw sessionNotCreated(
          'The allocated device has no automation server. Its host must register an automationEndpoint before it can serve WebDriver sessions.',
          'no_automation_endpoint',
        );
      }

      const base = target.automation_endpoint.replace(/\/+$/, '');
      const upstreamCaps: Record<string, unknown> = { ...caps.upstream };
      // Overridden, never merged: a client that picks its own udid is choosing a device, and the
      // device it chooses may belong to another tenant right now.
      if (target.local_id) upstreamCaps['appium:udid'] = target.local_id;

      const upstreamRes = await callUpstream(
        `${base}/session`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ capabilities: { alwaysMatch: upstreamCaps, firstMatch: [{}] } }),
        },
        NEW_SESSION_TIMEOUT_MS,
      ).catch((e: Error) => {
        throw sessionNotCreated(
          `Could not reach the automation server for the allocated device: ${e.message}`,
          'automation_unreachable',
        );
      });

      const created = upstreamRes.status < 400 ? readUpstreamSession(parseJson(upstreamRes.text)) : null;
      if (!created) {
        throw sessionNotCreated(upstreamFailureMessage(upstreamRes), 'upstream_rejected');
      }

      await withTenant(orgId, (c) =>
        c.query(
          `INSERT INTO webdriver_sessions
             (session_id, org_id, device_id, upstream_session_id, upstream_base_url, capabilities)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
          [alloc.sessionId, orgId, deviceId, created.id, base, JSON.stringify(redact(created.capabilities))],
        ),
      );

      // The WebDriver session being live IS the session being active — there is no separate signal
      // to wait for, and leaving it ALLOCATING would have the reaper collect a working session.
      await activate(orgId, alloc.sessionId, fence!);

      // The session id we hand back is the mfarm session id, not Appium's. One id in the test log,
      // the API, the artifact index and the invoice.
      const value = { sessionId: alloc.sessionId, capabilities: created.capabilities };
      return reply
        .code(200)
        .send(caps.protocol === 'jsonwp'
          ? { sessionId: alloc.sessionId, status: 0, value: created.capabilities }
          : { value });
    } catch (err) {
      await release(orgId, alloc.sessionId, 'session_not_created').catch(() => {});
      throw err;
    }
  });

  // ---------------------------------------------------------------- list sessions

  app.get('/sessions', routeOpts, async (req) => {
    const { orgId } = requireTenant(req);
    const rows = await withTenant(orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT w.session_id, w.capabilities, w.created_at
           FROM webdriver_sessions w JOIN sessions s ON s.id = w.session_id
          WHERE s.state IN ('ALLOCATING','ACTIVE')
          ORDER BY w.created_at`,
      );
      return rows;
    });
    return {
      value: rows.map((r) => ({ id: r.session_id, capabilities: r.capabilities, createdAt: r.created_at })),
    };
  });

  // ---------------------------------------------------------------- quit

  app.delete<{ Params: { sessionId: string } }>('/session/:sessionId', routeOpts, async (req) => {
    const { orgId } = requireTenant(req);
    const row = await lookup(orgId, req.params.sessionId);

    // Best effort, and deliberately not fatal. Telling the automation server to clean up is polite;
    // giving the device back is the part that must happen, because the snapshot restore that
    // follows erases whatever the upstream would have tidied anyway.
    await callUpstream(
      `${row.upstream_base_url}/session/${encodeURIComponent(row.upstream_session_id)}`,
      { method: 'DELETE' },
      30_000,
    ).catch((e: Error) => {
      req.log.warn({ err: e, sessionId: req.params.sessionId }, 'upstream session delete failed; releasing anyway');
    });

    await withTenant(orgId, (c) =>
      c.query('DELETE FROM webdriver_sessions WHERE session_id = $1', [req.params.sessionId]),
    );
    await release(orgId, req.params.sessionId, 'webdriver_quit');

    return { value: null };
  });

  // ---------------------------------------------------------------- command proxy

  /**
   * Everything else. The hub does not model WebDriver commands and must not start: the automation
   * server is the authority on what exists, and a hub that enumerates commands is a hub that breaks
   * every time Appium adds one.
   */
  app.all<{ Params: { sessionId: string; '*': string } }>(
    '/session/:sessionId/*',
    routeOpts,
    async (req, reply) => {
      const { orgId } = requireTenant(req);
      const row = await lookup(orgId, req.params.sessionId);

      // Rebuilt from the raw URL rather than from the parsed wildcard so percent-encoding in
      // element ids and selectors survives exactly as the client sent it.
      const suffix = req.url.slice(prefix.length);
      const upstreamPath = suffix.replace(
        `/session/${req.params.sessionId}`,
        `/session/${encodeURIComponent(row.upstream_session_id)}`,
      );

      const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE';
      const res = await callUpstream(
        `${row.upstream_base_url}${upstreamPath}`,
        {
          method: req.method,
          headers: hasBody ? { 'content-type': 'application/json' } : {},
          body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
        },
        COMMAND_TIMEOUT_MS,
      ).catch((e: Error) => {
        // A dead host is not a dead session yet — a restart or a blip is survivable, and ending the
        // session here would throw away a device the client may still recover. The TTL collects it
        // if it really is gone.
        throw new WebDriverError(
          e.name === 'TimeoutError' ? 'timeout' : 'unknown error',
          `The device's automation server did not answer: ${e.message}`,
          { mfarmCode: 'automation_unreachable' },
        );
      });

      await touch(orgId, req.params.sessionId, row.last_command_at);

      // Passed through verbatim: the upstream body is already a W3C response, and re-encoding it
      // would mean this hub has an opinion about payloads it does not understand.
      return reply.code(res.status).type(res.contentType).send(res.text);
    },
  );

  // ---------------------------------------------------------------- helpers

  interface SessionRow {
    upstream_session_id: string;
    upstream_base_url: string;
    last_command_at: Date;
  }

  /**
   * Resolve a WebDriver session id for this tenant.
   *
   * RLS scopes both tables, so another org's session id is indistinguishable from one that never
   * existed — the same disclosure boundary the REST API keeps. The state filter matters just as
   * much: an expired session whose device has been reset and handed to someone else must stop
   * accepting commands here, not just upstream.
   */
  async function lookup(orgId: string, sessionId: string): Promise<SessionRow> {
    // A malformed id would make Postgres raise on the uuid cast, which is a 500 for what is really
    // a client error. The shape is checked exactly, not loosely — `------...` is 36 characters too.
    if (!UUID.test(sessionId)) throw invalidSessionId();

    const row = await withTenant(orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT w.upstream_session_id, w.upstream_base_url, w.last_command_at
           FROM webdriver_sessions w JOIN sessions s ON s.id = w.session_id
          WHERE w.session_id = $1 AND s.state IN ('ALLOCATING','ACTIVE')`,
        [sessionId],
      );
      return rows[0] as SessionRow | undefined;
    });
    if (!row) throw invalidSessionId();
    return row;
  }

  /** Idle tracking, written at most once per 10 s so a polling suite does not turn every
   *  findElement into a database write. */
  async function touch(orgId: string, sessionId: string, last: Date): Promise<void> {
    if (Date.now() - new Date(last).getTime() < 10_000) return;
    await withTenant(orgId, (c) =>
      c.query('UPDATE webdriver_sessions SET last_command_at = now() WHERE session_id = $1', [sessionId]),
    );
  }

  /**
   * Block until the queued session gets a device, or give up.
   *
   * A WebDriver client cannot be told "queued, come back later" — the protocol has one answer, and
   * it is a session or an error. So waiting happens here, holding the request open, which is what
   * every device cloud does and what CI actually wants.
   *
   * Promotion itself is `promote_queued()`, driven by the reaper. Nothing schedules the reaper yet
   * (see buildServer's `reaperIntervalMs`), so a deployment that leaves it off makes this wait
   * always time out.
   */
  async function waitForCapacity(
    req: FastifyRequest,
    orgId: string,
    sessionId: string,
    timeoutSeconds: number,
  ): Promise<{ deviceId: string; fence: number } | null> {
    if (timeoutSeconds <= 0) return null;
    const deadline = Date.now() + timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      // A cancelled CI job is the common case for a long wait ending early. Nothing aborts the
      // handler when the socket closes, so without this the promotion still lands and a device is
      // held for the session's whole TTL for a client that stopped listening minutes ago.
      if (req.raw.destroyed) return null;

      const row = await withTenant(orgId, async (c) => {
        const { rows } = await c.query(
          'SELECT state, device_id, fence FROM sessions WHERE id = $1',
          [sessionId],
        );
        return rows[0] as { state: string; device_id: string | null; fence: string | null } | undefined;
      });
      if (!row) return null;
      if (row.state === 'ALLOCATING' && row.device_id) {
        return { deviceId: row.device_id, fence: Number(row.fence) };
      }
      // Ended or failed while queued: someone cancelled it, or the reaper did. Stop waiting.
      if (row.state !== 'QUEUED') return null;
    }
    return null;
  }
}
