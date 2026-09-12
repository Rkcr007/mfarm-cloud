import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import {
  CUSTOMER_TUNNEL_PATH, isProxyFrame, tunnelAllows, isValidTunnelName,
  type ProxyFrame, type TunnelAllowRule, type TunnelHello,
} from '@mfarm/protocol';

/**
 * `mfarm tunnel` — let a device on the farm reach a host on YOUR network.
 *
 * WHY THIS EXISTS. An app under test talks to `staging.acme.internal`, not to production. That host
 * is on your network and has no route from a device farm, so the most common thing a team wants to
 * test is the one thing a farm cannot do. This is the program that closes the gap, and it runs on
 * your side of the boundary on purpose.
 *
 * THE DIRECTION IS OUT. This dials the farm and holds one socket open; nothing listens, no port is
 * opened, and no inbound rule is needed. That is the same shape the agent uses and it is chosen for
 * the same reason — asking a customer to open a port is asking them to do the thing their security
 * team exists to prevent.
 *
 * **THE ALLOW-LIST IS ENFORCED HERE AND NOWHERE ELSE, AND THAT IS THE POINT.** The control plane is
 * a switch between two sockets: it cannot know that `10.0.0.7` is a payroll database and
 * `staging.acme.internal` is the thing under test. This program runs inside your network, was
 * started by you, and is the only party that can refuse from a position of knowledge. A rule the
 * farm enforced would be a rule you had to take our word for.
 *
 * So the default is DENY. `--allow` is required, and `--allow '*'` is a thing you have to type.
 */

/** What `runTunnel` needs. Separated from argv parsing so a test can drive it directly. */
export interface TunnelOptions {
  /** `https://farm.mfarm.dev` — the same base the rest of the CLI uses. */
  baseUrl: string;
  apiKey: string;
  name: string;
  allow: TunnelAllowRule[];
  /** Shown in the console so a person can tell two machines apart. */
  client?: string;
  /** Where human-readable progress goes. */
  out?: (line: string) => void;
  /** Called once the farm has acknowledged. Exists so a test need not poll. */
  onReady?: (info: { name: string; allow: TunnelAllowRule[] }) => void;
  /** Stop dialling after this many consecutive failures. `Infinity` in normal use. */
  maxRetries?: number;
}

/**
 * Parse `--allow host[:port]`, the way a person writes it.
 *
 * `staging.acme.internal`, `*.acme.internal`, `localhost:3000`, `*`. A bare `*` is accepted and
 * deliberately not warned about: a customer who means "everything on this machine's network" should
 * be able to say so in one flag rather than being nagged into writing a rule they do not believe.
 * What is refused is a rule that cannot be read — silently dropping a malformed one would mean a
 * tunnel narrower than its owner thinks, which fails as a confusing 502 hours later.
 */
export function parseAllowRule(raw: string): TunnelAllowRule {
  const value = raw.trim();
  if (!value) throw new Error('--allow needs a host, e.g. --allow staging.acme.internal');

  // Split on the LAST colon so an IPv6 literal in brackets survives, and so `host:port` is read as
  // a port rather than as part of the name.
  const colon = value.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(value.slice(colon + 1))) {
    const port = Number(value.slice(colon + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`"${value}" has a port outside 1-65535.`);
    }
    return { host: value.slice(0, colon).toLowerCase(), port };
  }
  return { host: value.toLowerCase() };
}

/**
 * The WebSocket this runs on.
 *
 * NODE'S OWN, with no dependency added. This package ships zero runtime dependencies and that is a
 * property worth keeping for a program a customer runs inside their own network — every dependency
 * here is a dependency their security review has to read. The cost is a hard floor at Node 22,
 * where `WebSocket` became available unflagged, and the floor is stated rather than discovered:
 * without this check the failure is `WebSocket is not defined` on a machine somebody else owns.
 */
function requireWebSocket(): typeof globalThis.WebSocket {
  const WS = (globalThis as { WebSocket?: typeof globalThis.WebSocket }).WebSocket;
  if (!WS) {
    throw new Error(
      `mfarm tunnel needs Node 22 or newer (this is ${process.version}), which is where WebSocket `
      + 'became available without a flag. The rest of the CLI runs on Node 20.3+.',
    );
  }
  return WS;
}

/** `https://farm.mfarm.dev` → `wss://farm.mfarm.dev/v1/tunnel`. */
export function tunnelUrl(baseUrl: string): string {
  const u = new URL(CUSTOMER_TUNNEL_PATH, baseUrl);
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  return u.toString();
}

/**
 * Hold the tunnel open until the process is stopped.
 *
 * RECONNECTS, because the thing this replaces is an SSH port-forward that dies with the laptop's
 * wifi and takes the suite with it. Backoff is capped low: a CI job that loses the tunnel for
 * thirty seconds has probably already failed, so the value of coming back quickly is higher than
 * the cost of a few extra dials.
 */
export async function runTunnel(opts: TunnelOptions): Promise<void> {
  const WS = requireWebSocket();
  const out = opts.out ?? ((l: string) => process.stderr.write(`${l}\n`));
  if (!isValidTunnelName(opts.name)) {
    throw new Error(
      `"${opts.name}" is not a usable tunnel name. Use lowercase letters, digits and dashes — it is `
      + 'what your suite puts in `mfarm:tunnel`.',
    );
  }
  if (opts.allow.length === 0) {
    throw new Error(
      'A tunnel with no --allow rules could not reach anything, so this refuses to start rather '
      + 'than looking like it worked. Name what the devices may reach, e.g. '
      + '--allow staging.acme.internal — or --allow "*" if you mean everything.',
    );
  }

  const url = tunnelUrl(opts.baseUrl);
  const maxRetries = opts.maxRetries ?? Infinity;
  let attempt = 0;

  for (;;) {
    const clean = await once(WS, url, opts, out);
    if (clean === 'stopped') return;
    attempt += 1;
    if (attempt > maxRetries) throw new Error('The tunnel could not be established.');
    // 1s, 2s, 4s, capped at 15. See the note above on why the cap is low.
    const waitMs = Math.min(1000 * 2 ** Math.min(attempt - 1, 4), 15_000);
    out(`reconnecting in ${Math.round(waitMs / 1000)}s…`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/** One connection's lifetime. Resolves when the socket closes. */
function once(
  WS: typeof globalThis.WebSocket,
  url: string,
  opts: TunnelOptions,
  out: (l: string) => void,
): Promise<'closed' | 'stopped'> {
  return new Promise((resolve) => {
    const ws = new WS(url);
    /**
     * One entry per request in flight.
     *
     * `abort` stops an upstream call whose channel closed; `body` is where the DEVICE's request
     * body goes. Both are per channel because several devices proxy at once and their frames
     * interleave on one socket.
     */
    const inflight = new Map<number, { abort(): void; body(f: ProxyFrame): void }>();
    let stopped = false;

    ws.addEventListener('open', () => {
      const hello: TunnelHello = {
        t: 'hello',
        key: opts.apiKey,
        name: opts.name,
        allow: opts.allow,
        client: opts.client,
      };
      ws.send(JSON.stringify(hello));
    });

    ws.addEventListener('message', (ev: { data: unknown }) => {
      let frame: unknown;
      try { frame = JSON.parse(String(ev.data)); } catch { return; }
      if (!frame || typeof frame !== 'object') return;
      const f = frame as { t?: unknown; ch?: unknown; d?: unknown; name?: unknown; allow?: unknown };

      if (f.t === 'ready') {
        out(`tunnel "${String(f.name)}" is up — devices may reach:`);
        for (const r of (f.allow as TunnelAllowRule[] | undefined) ?? []) {
          out(`  ${r.host}${r.port ? `:${r.port}` : ''}`);
        }
        out('Set mfarm:tunnel in your capabilities to use it. Ctrl-C to stop.');
        opts.onReady?.({ name: String(f.name), allow: (f.allow as TunnelAllowRule[]) ?? [] });
        return;
      }

      if (typeof f.ch !== 'number') return;
      const ch = f.ch;

      if (f.t === 'close') {
        inflight.get(ch)?.abort();
        inflight.delete(ch);
        return;
      }
      if (f.t === 'open') {
        // Nothing to do until the request head arrives; the channel exists from here.
        return;
      }
      if (f.t !== 'data' || typeof f.d !== 'string') return;

      let inner: unknown;
      try { inner = JSON.parse(f.d); } catch { return; }
      if (!isProxyFrame(inner)) return;

      if (inner.k === 'req') {
        handleRequest(ws, ch, inner, opts, inflight, out);
        return;
      }
      /**
       * A BODY CHUNK OR AN END, for a request already in flight. A POST is the ordinary case for an
       * app talking to staging — a login, a form — so a client that only carried the head would
       * fail on the second screen of every app it was pointed at.
       */
      inflight.get(ch)?.body(inner);
    });

    const finish = (why: 'closed' | 'stopped') => {
      for (const entry of inflight.values()) entry.abort();
      inflight.clear();
      resolve(why);
    };

    // Typed structurally rather than as `CloseEvent`: this workspace compiles without the `dom`
    // lib (it is a CLI), and the two fields below are all this needs from the event.
    ws.addEventListener('close', (ev: { code: number; reason: string }) => {
      if (stopped) return finish('stopped');
      /**
       * A REFUSAL IS NOT A RETRY. 1008 is "that key was not accepted" and 1002 is a malformed
       * hello; dialling again cannot fix either, and a client that loops on a revoked credential is
       * a client nobody can debug and a log nobody can read.
       */
      if (ev.code === 1008 || ev.code === 1002) {
        out(`the farm refused this tunnel: ${ev.reason || `close ${ev.code}`}`);
        stopped = true;
        return finish('stopped');
      }
      out(`tunnel closed${ev.reason ? `: ${ev.reason}` : ''}`);
      finish('closed');
    });

    ws.addEventListener('error', () => { /* `close` always follows; recovery lives there */ });

    const stop = () => { stopped = true; try { ws.close(1000, 'stopping'); } catch { /* gone */ } };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/**
 * Fetch one thing on the customer's behalf, if the rules allow it.
 *
 * THE CHECK IS FIRST AND IT IS THE WHOLE JOB. Everything after it is ordinary HTTP.
 */
function handleRequest(
  ws: globalThis.WebSocket,
  ch: number,
  req: Extract<ProxyFrame, { k: 'req' }>,
  opts: TunnelOptions,
  inflight: Map<number, { abort(): void; body(f: ProxyFrame): void }>,
  out: (l: string) => void,
): void {
  const send = (f: ProxyFrame) => {
    try { ws.send(JSON.stringify({ ch, t: 'data', d: JSON.stringify(f) })); } catch { /* closed */ }
  };
  const end = () => {
    inflight.delete(ch);
    try { ws.send(JSON.stringify({ ch, t: 'close' })); } catch { /* closed */ }
  };

  let target: URL;
  try {
    target = new URL(req.url);
  } catch {
    send({ k: 'err', message: `"${req.url}" is not a url this tunnel can fetch.`, code: 'unreachable' });
    return end();
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    send({ k: 'err', message: `${target.protocol} is not proxied.`, code: 'unreachable' });
    return end();
  }

  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  if (!tunnelAllows(opts.allow, target.hostname, port)) {
    /**
     * NAMED IN THE ERROR AND IN THE LOG, because the person who will see this is the person who
     * wrote the rules. "Forbidden" sends them to read our documentation; "staging.acme.internal:443
     * is not in this tunnel's --allow rules" sends them to their own command line.
     */
    const what = `${target.hostname}:${port}`;
    out(`refused ${what} — not in this tunnel's --allow rules`);
    send({
      k: 'err',
      message: `${what} is not in this tunnel's --allow rules. Add it with --allow ${what}.`,
      code: 'not_allowed',
    });
    return end();
  }

  const call = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstream = call(target, {
    method: req.method,
    /**
     * The device's headers, forwarded as they arrived, minus the hop-by-hop ones. `host` is
     * rewritten by `new URL` targeting — passing the device's would make a virtual-hosted staging
     * server answer for the wrong site, which looks like the app being broken.
     */
    headers: forwardable(req.headers, target.host),
  }, (res) => {
    send({
      k: 'res',
      status: res.statusCode ?? 502,
      headers: Object.fromEntries(
        Object.entries(res.headers)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]),
      ),
    });
    res.on('data', (chunk: Buffer) => send({ k: 'd', b: chunk.toString('base64') }));
    res.on('end', () => { send({ k: 'end' }); end(); });
    res.on('error', (e: Error) => { send({ k: 'err', message: e.message, code: 'unreachable' }); end(); });
  });

  inflight.set(ch, {
    abort: () => { try { upstream.destroy(); } catch { /* already done */ } },
    /**
     * The device's request body, streamed through as it arrives rather than buffered.
     *
     * Buffering would mean holding an arbitrary upload in memory on the customer's own machine, on
     * a program they run because we asked them to. Streaming is also what makes a large POST work
     * at all: the frame cap is 8 MB and a body is not.
     */
    body: (f) => {
      if (f.k === 'd') { try { upstream.write(Buffer.from(f.b, 'base64')); } catch { /* aborted */ } return; }
      if (f.k === 'end') { try { upstream.end(); } catch { /* aborted */ } }
    },
  });

  upstream.on('error', (e: NodeJS.ErrnoException) => {
    /**
     * The system error code, translated once, here. `ECONNREFUSED` is the single most common thing
     * this hits and it has a specific cause — the staging host is not listening — which is worth
     * saying instead of passing through Node's phrasing about a socket.
     */
    const message = e.code === 'ECONNREFUSED'
      ? `nothing is listening on ${target.host}. Is your staging environment up?`
      : e.code === 'ENOTFOUND'
        ? `${target.hostname} did not resolve from this machine. The tunnel resolves names on YOUR network, so this is your DNS rather than the farm's.`
        : (e.message || 'the request failed');
    out(`${target.host}: ${message}`);
    send({ k: 'err', message, code: 'unreachable' });
    end();
  });

  /**
   * NOT ENDED HERE. The upstream request stays open until the device's `end` frame arrives, which
   * is what carries a POST body across. A GET's `end` arrives immediately — the device proxy sends
   * one as soon as its own request stream finishes — so there is no extra round trip for the common
   * case, and no branch here that could get the two wrong in different ways.
   */
}

/**
 * Hop-by-hop headers, which belong to one connection and must not be forwarded (RFC 9110 §7.6.1).
 *
 * Forwarding `connection: keep-alive` or a `te` to an upstream is how a proxy ends up holding a
 * socket the other end thinks it closed. `host` is replaced rather than dropped, because a
 * virtual-hosted staging server needs the one it is being asked for.
 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);

export function forwardable(headers: Record<string, string>, host: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (k.toLowerCase() === 'host') continue;
    out[k] = v;
  }
  out.host = host;
  return out;
}
