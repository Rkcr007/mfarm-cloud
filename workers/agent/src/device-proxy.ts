import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isProxyFrame, PROXY_CHUNK_BYTES, type ProxyFrame } from '@mfarm/protocol';

/**
 * The proxy a DEVICE points at so it can reach the customer's private network (migration 052).
 *
 * WHERE THIS SITS. A device on this host sets its HTTP proxy to a port this server listens on; the
 * request arrives here, goes up the agent's existing tunnel as a `proxy` channel, and the control
 * plane routes it to whichever tunnel client that device's session named. The response comes back
 * the same way. Four hops, and this is the first.
 *
 * ONE LISTENER PER DEVICE, and that is the whole reason the control plane can answer "whose device
 * is this". A shared port would mean guessing from a source address — several Cuttlefish guests
 * NAT through the same host interface, and a guess on this path is a guess about which tenant's
 * network to open. A port per device makes it a fact: a request arriving on this listener is from
 * this device, by construction.
 *
 * IT BINDS THE HOST'S LOCAL ADDRESS, NOT THE WORLD. A device must reach it and nothing else should.
 * ADR-0009 §3's claim is that the agent opens no inbound port on the network, and this is the one
 * concession to that: a listener reachable from the device's own interface, carrying traffic that
 * is refused unless the control plane can name a live session for the device it belongs to.
 */

/** What the proxy needs from the tunnel. Kept as an interface so a test drives it with no socket. */
export interface ProxyTransport {
  /**
   * Open a `proxy` channel for `localId`, or undefined when there is no tunnel to open it on.
   *
   * `undefined` becomes a 502 naming the farm rather than a hang, because a device whose request
   * never answers is a test that fails minutes later with a timeout nobody can attribute.
   */
  open(localId: string, sink: {
    onFrame(f: ProxyFrame): void;
    onClose(reason: string): void;
  }): { send(f: ProxyFrame): void; close(): void } | undefined;
}

export interface DeviceProxyOptions {
  localId: string;
  transport: ProxyTransport;
  /** Which address devices reach this host on. Loopback in tests; the host's LAN address on a farm. */
  host?: string;
  /** 0 asks the OS, which is what a farm wants — ports are assigned, never guessed. */
  port?: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * How long a proxied request may take before the device is told.
 *
 * LONGER THAN A PAGE LOAD AND SHORTER THAN A SUITE'S PATIENCE. The failure this bounds is a
 * customer's client that accepted a request and then stopped answering — a laptop that slept — and
 * the alternative to a timeout here is a socket the device holds until its own stack gives up,
 * which on Android is minutes.
 */
const REQUEST_TIMEOUT_MS = 60_000;

export class DeviceProxy {
  private server: Server | undefined;
  private readonly opts: DeviceProxyOptions;

  constructor(opts: DeviceProxyOptions) {
    this.opts = opts;
  }

  /** Start listening. Returns the address a device should be pointed at. */
  async start(): Promise<{ host: string; port: number }> {
    const host = this.opts.host ?? '127.0.0.1';
    const server = createServer((req, res) => this.onRequest(req, res));

    /**
     * CONNECT IS REFUSED, EXPLICITLY AND WITH A REASON.
     *
     * An HTTPS request through an HTTP proxy is a `CONNECT` that expects a raw byte tunnel, and
     * this proxy cannot provide one: the frame protocol carries a REQUEST and a RESPONSE, not a
     * TLS stream. Answering 405 with a sentence is the honest failure — the alternative is
     * accepting the CONNECT and then producing a socket that speaks nothing, which surfaces in an
     * app as a TLS handshake error and sends somebody to debug their certificates.
     *
     * This is a real and stated limitation of the first version, not an oversight. See
     * `docs/adrs/0037` for what closing it costs.
     */
    server.on('connect', (_req, socket) => {
      socket.write(
        'HTTP/1.1 405 Method Not Allowed\r\n'
        + 'content-type: text/plain\r\n'
        + 'connection: close\r\n\r\n'
        + 'This MFARM tunnel proxies plain HTTP only. An https:// target needs a CONNECT tunnel, '
        + 'which it does not yet carry.\n',
      );
      socket.destroy();
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port ?? 0, host, () => resolve());
    });

    this.server = server;
    const addr = server.address() as AddressInfo;
    return { host, port: addr.port };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ---------------------------------------------------------------- the request

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    /**
     * A PROXY REQUEST CARRIES AN ABSOLUTE URL — `GET http://staging.acme.internal/orders HTTP/1.1`
     * — which is what distinguishes it from an ordinary one. A relative path means something
     * pointed at this port that is not using it as a proxy, and saying so is more useful than
     * trying to guess a host.
     */
    const url = req.url ?? '';
    if (!/^https?:\/\//i.test(url)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end(
        'This is an MFARM tunnel proxy, not a web server. Point a device\'s HTTP proxy at it '
        + 'rather than requesting a path from it directly.\n',
      );
      return;
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }

    /**
     * `responded` MEANS "A STATUS LINE HAS BEEN WRITTEN", and nothing else.
     *
     * The first version used one flag for two jobs — "the response started" and "this exchange is
     * over" — and the second meaning silently ate the body: every `d` frame after the head hit the
     * guard and was dropped, so a device got a correct `200` with zero bytes. The end-to-end test
     * caught it as `Unexpected end of JSON input`, which is exactly what an empty 200 looks like
     * from the far side.
     *
     * Its one job is to stop `fail()` writing a second status line onto a response that has already
     * begun — which throws, rather than merely looking wrong.
     */
    let responded = false;
    const fail = (status: number, message: string) => {
      if (responded) return;
      responded = true;
      try {
        res.writeHead(status, { 'content-type': 'text/plain' });
        /**
         * THE REASON IS IN THE BODY, and it is aimed at a person rather than at a browser. This
         * text is what somebody sees when their app cannot reach staging, and "502 Bad Gateway"
         * sends them to look at the farm — which is nearly always the wrong place, because the
         * usual causes are an unstarted client and an allow rule that does not cover the host.
         */
        res.end(`MFARM tunnel: ${message}\n`);
      } catch { /* the device hung up */ }
      channel?.close();
    };

    const channel = this.opts.transport.open(this.opts.localId, {
      onFrame: (f) => {
        if (f.k === 'res') {
          if (responded) return;
          responded = true;
          try { res.writeHead(f.status, f.headers); } catch { /* device hung up */ }
          return;
        }
        if (f.k === 'd') {
          try { res.write(Buffer.from(f.b, 'base64')); } catch { /* device hung up */ }
          return;
        }
        if (f.k === 'end') { try { res.end(); } catch { /* gone */ } return; }
        if (f.k === 'err') {
          // The code decides the status, because they mean different things to whoever is reading:
          // a refused host is the customer's own rule (403), an unstarted tunnel is a thing to go
          // and start (503), and an unreachable host is genuinely upstream (502).
          const status = f.code === 'not_allowed' ? 403 : f.code === 'no_tunnel' ? 503 : 502;
          fail(status, f.message);
        }
      },
      onClose: (reason) => {
        // A close after the head is the end of the body — the far end finishing, or a tunnel that
        // dropped mid-stream. Either way the device gets what arrived rather than a hang: a
        // truncated body it can see beats a socket it cannot.
        if (responded) { try { res.end(); } catch { /* gone */ } return; }
        fail(502, reason);
      },
    });

    if (!channel) {
      fail(503, 'this device host is not connected to the farm right now.');
      return;
    }

    const timer = setTimeout(() => fail(504, 'the tunnel did not answer in time.'), REQUEST_TIMEOUT_MS);
    res.on('close', () => { clearTimeout(timer); channel.close(); });

    channel.send({ k: 'req', method: req.method ?? 'GET', url, headers });

    /**
     * THE REQUEST BODY IS STREAMED IN CHUNKS, same shape as the response and as the automation
     * path. A POST is the ordinary case for an app talking to staging — a login, a form — so a
     * proxy that only carried GETs would fail on the second screen of every app.
     */
    req.on('data', (chunk: Buffer) => {
      for (let i = 0; i < chunk.length; i += PROXY_CHUNK_BYTES) {
        channel.send({ k: 'd', b: chunk.subarray(i, i + PROXY_CHUNK_BYTES).toString('base64') });
      }
    });
    req.on('end', () => channel.send({ k: 'end' }));
    req.on('error', () => channel.close());
  }
}

/** Re-exported so a caller validating frames off a socket has one import site. */
export { isProxyFrame };
