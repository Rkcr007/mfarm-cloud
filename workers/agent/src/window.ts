import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WINDOW_PAGE } from './window-page.ts';
import type { AdbState } from './devices/discovery.ts';

/**
 * The agent's window — ADR-0009 §1, milestone M2.
 *
 * A person plugs a phone into their laptop and wants to know one thing: is it working? Today the
 * only answer is a scrolling log from a process started with eleven environment variables. This
 * serves that answer as a page on `127.0.0.1`, and it is the whole difference between a farm and
 * something somebody runs.
 *
 * Everything it shows is ALREADY COMPUTED inside the agent — adb state, the remedy for each
 * unusable one, registration, the tunnel, health. `index.ts` composes a `WindowState` from what it
 * already has; this file does no discovery, drives no device, and knows nothing about adb. That is
 * why the milestone is small.
 *
 * THIS FILE IS A SECURITY BOUNDARY, for a reason that has embarrassed a long line of desktop
 * software: A SERVER ON LOOPBACK IS NOT PRIVATE. Every process on the machine can reach it, and so
 * can any website the user visits — the browser will happily let `evil.com` issue requests to
 * `http://127.0.0.1:7317`. ADR-0009 §3 names three mitigations and says all three are required:
 *
 *   1. BIND LOOPBACK ONLY, never `0.0.0.0`. Not configurable. There is no deployment in which the
 *      agent's own control surface should be answerable from another machine, so unlike the
 *      automation gateway there is no bind-host variable here to drift off.
 *   2. A SESSION TOKEN minted at start-up, carried in the URL the agent opens, never written to
 *      disk. A website can send requests to loopback; it cannot guess 32 random bytes. This is the
 *      check that actually stops the attack — the other two are what stop it from being bypassed.
 *   3. `Origin` AND `Host` VALIDATED on every request. Origin stops a page on another origin from
 *      using the browser's own credentials against us; Host stops DNS rebinding, where an attacker
 *      points a name they control at 127.0.0.1 so that their page IS same-origin with this server.
 *      Checking Origin without Host leaves rebinding open, which is why both are here.
 *
 * There is deliberately no unauthenticated path through `handle()` — not one behind a flag, not one
 * for the page itself. The page is inlined into a single token-checked response precisely so that
 * no asset needs an exemption.
 */

/** What the window is allowed to say about one device. Presentation only — no handles, no adb. */
export interface WindowDevice {
  serial: string;
  /** Our name for it, once the agent has adopted it. Absent for a phone it cannot use yet. */
  localId?: string;
  model: string;
  manufacturer?: string;
  osVersion?: string;
  /**
   * What `adb devices` says right now. Absent for a tier adb has never heard of — a Cuttlefish
   * instance is not "on USB", and printing a state for it would invent one.
   */
  adbState?: AdbState;
  /** Registered with the control plane, and therefore reachable by the org. */
  shared: boolean;
  status: 'ready' | 'busy' | 'starting' | 'unhealthy' | 'blocked';
  /** What a person should DO. Present exactly when there is something to do. */
  remedy?: string;
  /**
   * Whether this phone would refuse an `adb install` right now — M1's other half.
   *
   * `'on'` is the state that needs a person: Play Protect will show "Harmful app blocked" and no
   * session can run. The window offers the fix rather than logging it, because the log is not where
   * anybody is looking at the moment the phone lights up.
   */
  installVerification?: 'on' | 'off' | 'unknown';
  sessions: number;
}

export interface WindowNotice {
  level: 'info' | 'warn' | 'error';
  title: string;
  detail: string;
}

/**
 * The pairing code, while there is one — ADR-0014.
 *
 * Present ONLY while the agent has no credential. Its presence is what tells the page to lead with
 * the code instead of the device list: an unpaired agent has exactly one thing worth saying, and
 * burying it under a fleet summary would be showing somebody the answer to a question they have not
 * reached yet.
 *
 * NEVER CARRIES THE DEVICE CODE. That is the credential authenticating the poll; this is the eight
 * characters a human reads. They are different secrets doing different jobs, and only one of them
 * belongs on a screen.
 */
export interface WindowPairing {
  userCode: string;
  expiresAt: string;
  status: 'waiting' | 'approved';
  attempt: number;
}

export interface WindowState {
  pairing?: WindowPairing;
  host: {
    hostname: string;
    region: string;
    controlPlaneUrl: string;
    hostId?: string;
    /** The data-plane address, for a host that publishes one. Ignored when `tunnel` is true. */
    endpoint: string;
    tunnel: boolean;
  };
  /** Shown beside the code, so the person approving can tell this machine from another. */
  agentVersion?: string;
  devices: WindowDevice[];
  notices: WindowNotice[];
}

/**
 * The things the page may ASK the agent to do, and the entire list of them.
 *
 * Narrow on purpose, and it will stay narrow. A local page that can drive devices is a local page
 * that any process on the machine can drive devices with once it has the token — so what is exposed
 * here is only what a person must consent to in the moment, never anything the agent could have
 * done for itself.
 */
export interface WindowActions {
  /** Flip `verifier_verify_adb_installs`, with the button press as the consent. */
  setInstallVerification?(localId: string, enabled: boolean): Promise<void>;
}

export interface WindowOptions {
  /** Composed by the caller from what it already knows. Cheap: called on every push and every GET. */
  snapshot: () => WindowState;
  actions?: WindowActions;
  /** Supplied only by tests. Production mints one and never persists it. */
  token?: string;
  port?: number;
  /** Keep-alive comment interval on the event stream, so an idle tab is not silently dropped. */
  keepAliveMs?: number;
}

/** Every value of `Host` this server will answer to. Anything else is a rebinding attempt. */
const hostAllowed = (header: string | undefined, port: number): boolean =>
  header === `127.0.0.1:${port}` || header === `localhost:${port}`;

/** Likewise for `Origin`, in the two spellings a browser can arrive with. */
const originAllowed = (header: string, port: number): boolean =>
  header === `http://127.0.0.1:${port}` || header === `http://localhost:${port}`;

/**
 * Constant-time token comparison.
 *
 * `===` on a secret leaks its prefix through timing. That is a stretch against a local attacker who
 * can make a million requests a second — which is exactly what a page in the user's browser can do.
 * `timingSafeEqual` throws on a length mismatch, so the length is checked first and separately;
 * the length of a fixed-size token is not a secret.
 */
function tokenMatches(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const MAX_BODY = 64 * 1024;

type Denial = { status: number; error: string; message: string };

function deny(res: ServerResponse, d: Denial): void {
  const body = JSON.stringify({ error: d.error, message: d.message });
  res.writeHead(d.status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

export class AgentWindow {
  private readonly opts: WindowOptions;
  private readonly _token: string;
  private server?: Server;
  private _port?: number;
  /**
   * Open event streams, each remembering the last payload IT was sent.
   *
   * Per client rather than one shared "last pushed", and the difference is a staleness bug. With a
   * single shared value, a tab opening is enough to record a payload nobody else received — and the
   * next identical push is then skipped for the tabs that never saw it, which sit on a stale device
   * list forever. The map costs one string per open tab and makes the dedupe exactly true.
   */
  private readonly clients = new Map<ServerResponse, string>();
  private keepAlive?: NodeJS.Timeout;

  constructor(opts: WindowOptions) {
    this.opts = opts;
    // 32 bytes, so guessing is not a strategy. base64url because it goes in a URL and a `+` or `/`
    // that gets re-encoded somewhere in the chain would fail the comparison for no visible reason.
    this._token = opts.token ?? randomBytes(32).toString('base64url');
  }

  get port(): number | undefined { return this._port; }

  /** The address to open. Contains the token — it is the credential, so treat the whole url as one. */
  get url(): string { return `http://127.0.0.1:${this._port}/?t=${encodeURIComponent(this._token)}`; }

  /**
   * Bind loopback, on the requested port or an ephemeral one.
   *
   * A BUSY PORT IS NOT FATAL. The likeliest cause is a second agent on the same laptop, and
   * refusing to start the window — or worse, refusing to start the agent — over a cosmetic port
   * number would be the wrong trade: the url is printed and opened, so an ephemeral port is just as
   * usable. This is the opposite of the automation gateway, which must bind the exact port it
   * already advertised.
   */
  async listen(port = this.opts.port ?? 7317): Promise<number> {
    const bind = async (p: number): Promise<Server> => {
      const server = createServer((req, res) => { void this.handle(req, res); });
      // A socket that connects and says nothing costs a file descriptor until it does.
      server.headersTimeout = 15_000;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      return server;
    };

    try {
      this.server = await bind(port);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      console.warn(`[window] port ${port} is in use — taking an ephemeral one instead`);
      this.server = await bind(0);
    }

    this._port = (this.server.address() as { port: number }).port;
    this.keepAlive = setInterval(() => {
      for (const c of this.clients.keys()) c.write(': keep-alive\n\n');
    }, this.opts.keepAliveMs ?? 15_000);
    this.keepAlive.unref?.();
    return this._port;
  }

  /**
   * Recompose the state and send it to every open tab, if anything actually changed.
   *
   * Called by whoever knows something moved — a discovery pass, a health flip. The window does not
   * poll: a second `adb devices` timer beside the one that already exists would double the load on
   * a USB stack that is, on a bad day, the thing being diagnosed.
   */
  push(): void {
    if (this.clients.size === 0) return;
    let payload: string;
    try {
      payload = JSON.stringify(this.opts.snapshot());
    } catch (e) {
      console.error(`[window] could not compose the state: ${(e as Error).message}`);
      return;
    }
    // SSE frames are newline-delimited, so a payload containing one would split into two events.
    // JSON.stringify never emits a raw newline, which is why this can be a single `data:` line.
    const frame = `event: state\ndata: ${payload}\n\n`;
    for (const [c, last] of this.clients) {
      // The discovery poll pushes on every tick whether or not anything moved. Re-rendering an
      // idle page every ten seconds forever is how a window meant to be left open gets closed.
      if (last === payload) continue;
      this.clients.set(c, payload);
      c.write(frame);
    }
  }

  async close(): Promise<void> {
    if (this.keepAlive) clearInterval(this.keepAlive);

    /**
     * FLUSH BEFORE DESTROY, and this ordering is a bug fix rather than tidiness.
     *
     * `closeAllConnections()` destroys sockets, discarding whatever is still queued on them — and
     * the last thing written to an event stream is very often the frame that matters most. The
     * window pushes and the agent drains IN THE SAME TICK on the one path that matters: a phone
     * arrives, `onPass` pushes the row, the arrival drains the agent. Whatever else is true, the
     * row must not be a casualty of the drain it triggered.
     *
     * Suspected in a lost frame on hardware and NOT confirmed as its cause — the payload there was
     * one small device, which loopback absorbs during the synchronous write. The race is real
     * regardless: the test for it fails with these lines removed.
     *
     * `end(cb)` fires when the response has actually been flushed. Bounded, because a client that
     * has stopped reading must not be able to hold a drain open.
     */
    const flushed = [...this.clients.keys()].map((c) =>
      new Promise<void>((resolve) => {
        const done = (): void => resolve();
        const t = setTimeout(done, 250);
        t.unref?.();
        c.end(() => { clearTimeout(t); done(); });
      }));
    this.clients.clear();
    await Promise.all(flushed);

    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      /**
       * `close()` alone stops accepting and then WAITS for every open connection, and a browser
       * holds its keep-alive socket open for as long as it likes. Measured at four seconds of dead
       * time in the tests before this line existed — four seconds added to every drain, for a
       * cosmetic server whose only client is a page that reconnects on its own. Safe now that the
       * streams above have been flushed and ended.
       */
      server.closeAllConnections();
    });
  }

  // ---------------------------------------------------------------------------- request handling

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = this._port ?? 0;

    /**
     * Host first, because a rebinding attempt must be refused before anything else looks at the
     * request. `Host` is what the browser was aiming at; if it is a name we do not serve, the
     * request reached us through a name pointed at 127.0.0.1 by somebody else.
     */
    if (!hostAllowed(req.headers.host, port)) {
      return deny(res, {
        status: 421, error: 'bad_host',
        message: 'This server answers to 127.0.0.1 and localhost only.',
      });
    }

    /**
     * Origin, when the browser sent one.
     *
     * ABSENT IS ALLOWED ON A READ, and that is not a hole. Browsers omit `Origin` on same-origin
     * navigations and same-origin GETs — the two requests that load this page — so requiring it
     * would break the product to add nothing: a cross-origin request from a page always carries
     * one, and a non-browser client that omits it still has to produce the token.
     *
     * ON A WRITE IT IS REQUIRED. `fetch` sends `Origin` on every POST, including same-origin ones,
     * so demanding it costs the page nothing and closes the one shape where a missing header would
     * otherwise be indistinguishable from a form post smuggled in by another site.
     */
    const origin = req.headers.origin;
    const writing = req.method !== 'GET' && req.method !== 'HEAD';
    if (origin !== undefined && !originAllowed(origin, port)) {
      return deny(res, {
        status: 403, error: 'bad_origin',
        message: 'That request came from another origin.',
      });
    }
    if (writing && origin === undefined) {
      return deny(res, {
        status: 403, error: 'origin_required',
        message: 'Requests that change something must carry an Origin header.',
      });
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    // In the query for the page load and the event stream, because neither can set a header:
    // `EventSource` has no way to, and neither does typing an address. In a header for everything
    // else, so a token does not have to travel in a url a person might copy out of devtools.
    const supplied = url.searchParams.get('t')
      ?? (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : undefined);
    if (!tokenMatches(supplied ?? undefined, this._token)) {
      return deny(res, {
        status: 401, error: 'bad_token',
        message: 'Open the address the agent printed when it started.',
      });
    }

    if (url.pathname === '/' && !writing) return this.servePage(res);
    if (url.pathname === '/api/state' && !writing) return this.serveState(res);
    if (url.pathname === '/api/events' && !writing) return this.serveEvents(req, res);

    const verification = /^\/api\/devices\/([^/]+)\/install-verification$/.exec(url.pathname);
    if (verification && req.method === 'POST') {
      return this.setVerification(decodeURIComponent(verification[1]), req, res);
    }

    return deny(res, { status: 404, error: 'not_found', message: `No route for ${url.pathname}.` });
  }

  private servePage(res: ServerResponse): void {
    const body = Buffer.from(WINDOW_PAGE, 'utf8');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // Defence in depth behind the token: even if this page were somehow made to render foreign
      // content, it may not fetch, frame, or exfiltrate to anywhere. `self` is loopback, which is
      // where the event stream lives.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
        + "connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      // The token is in this page's own url. Without this, any navigation away would hand it to the
      // destination in a `Referer` — the one realistic way a local secret leaves the machine.
      'referrer-policy': 'no-referrer',
    });
    res.end(body);
  }

  private serveState(res: ServerResponse): void {
    const body = JSON.stringify(this.opts.snapshot());
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  }

  private serveEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'connection': 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    // Nagle would hold a small frame waiting for company, which on a stream of one small frame per
    // event means the row appears when the next one does.
    req.socket.setNoDelay(true);
    // The current state immediately, so a tab opened between two events is not blank until one.
    const payload = JSON.stringify(this.opts.snapshot());
    this.clients.set(res, payload);
    res.write(`event: state\ndata: ${payload}\n\n`);
    const drop = () => { this.clients.delete(res); };
    req.on('close', drop);
    res.on('close', drop);
  }

  private async setVerification(localId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const act = this.opts.actions?.setInstallVerification;
    if (!act) {
      return deny(res, {
        status: 501, error: 'unsupported',
        message: 'This agent has no device that can change that setting.',
      });
    }
    let body: { enabled?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as { enabled?: unknown };
    } catch (e) {
      return deny(res, { status: 400, error: 'bad_body', message: (e as Error).message });
    }
    if (typeof body.enabled !== 'boolean') {
      return deny(res, { status: 400, error: 'bad_body', message: '`enabled` must be true or false.' });
    }
    try {
      await act(localId, body.enabled);
    } catch (e) {
      // The phone refused, or is gone. A message, not a stack: this renders next to the button.
      return deny(res, { status: 502, error: 'device_refused', message: (e as Error).message });
    }
    const out = JSON.stringify({ ok: true });
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(out),
      'cache-control': 'no-store',
    });
    res.end(out);
    // The device's state just changed, so say so rather than waiting for the next discovery pass.
    this.push();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Open the window in whatever browser the person already uses.
 *
 * BEST EFFORT, ALWAYS. A headless box has no opener and a locked-down laptop may refuse; neither is
 * a reason for the agent to fail, and the url is printed either way. Failures are swallowed rather
 * than logged, because "xdg-open: not found" on a server is noise about something nobody wanted.
 */
export function openInBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'explorer'
    : 'xdg-open';
  try {
    // The url is composed by this process from a random token — it is never operator input — so
    // there is nothing here to escape. execFile takes an argv, so there is no shell either way.
    execFile(opener, [url], () => { /* best effort */ });
  } catch { /* best effort */ }
}
