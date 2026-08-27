import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import {
  AUTOMATION_CHUNK_BYTES,
  isAutomationFrame,
  type AutomationFrame,
} from '@mfarm/protocol';

/**
 * The agent's end of an automation channel — ADR-0011, worker half.
 *
 * One of these per WebDriver command the hub sends over the tunnel. It decodes the framed request,
 * replays it against THIS HOST'S OWN GATEWAY on loopback, and frames the answer back.
 *
 * THE REPLAY IS THE DESIGN, not an implementation detail to optimise away later. The gateway is the
 * security boundary ADR-0004 built: signature, audience, device, fence, in that order, with no path
 * to the proxy that skips one. Handing a tunnelled request to it as an ordinary HTTP request — the
 * `authorization` header included, untouched — means the tunnel adds a transport and adds no second
 * opinion about who may drive a device. A version of this that called into the gateway's internals,
 * or worse re-implemented the checks, would be the same authorization decision written twice, and
 * two copies of a check are two things that can disagree.
 *
 * Nothing here reads a body. Chunks are base64 in and base64 out.
 */

export interface AutomationChannelOptions {
  /** Where this agent's own gateway listens. Loopback in every real deployment. */
  target: { host: string; port: number };
  /** Frame out, to the control plane. */
  send: (frame: AutomationFrame) => void;
  /** Tear the channel down. Called once, after `end` or `err`. */
  close: () => void;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Node gives a header as a string or an array. The hub reads exactly one of these (`content-type`)
 * and passes the body through verbatim, so joining is lossless for everything that matters and
 * lossy only for `set-cookie`, which no WebDriver response carries.
 */
function flatten(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

export class AutomationChannel {
  private readonly opts: AutomationChannelOptions;
  private upstream?: ClientRequest;
  private done = false;
  /** A channel serves exactly one request. A second `req` frame is a bug or a forgery. */
  private started = false;

  constructor(opts: AutomationChannelOptions) {
    this.opts = opts;
  }

  /** One `data` frame's payload, as it arrived on the tunnel. */
  deliver(raw: string): void {
    if (this.done) return;
    let frame: unknown;
    try { frame = JSON.parse(raw); } catch { return this.fail('unparseable automation frame'); }
    if (!isAutomationFrame(frame)) return this.fail('unrecognised automation frame');

    switch (frame.k) {
      case 'req': return this.begin(frame.method, frame.path, frame.headers);
      case 'd': {
        // Body before the head is not a request that got out of order — it is a request that never
        // named a method or a path, and there is nothing to write it to.
        if (!this.upstream) return this.fail('body before request head');
        this.upstream.write(Buffer.from(frame.b, 'base64'));
        return;
      }
      case 'end': {
        if (!this.upstream) return this.fail('end before request head');
        this.upstream.end();
        return;
      }
      // A response or an error travelling towards the agent is the control plane speaking the wrong
      // half of the protocol. Refused rather than ignored, so it shows up as a failure with a cause.
      default: return this.fail(`unexpected ${frame.k} frame from the control plane`);
    }
  }

  /** The tunnel dropped, or the control plane hung up mid-command. */
  abort(): void {
    if (this.done) return;
    this.done = true;
    // The device's Appium is busy for as long as this request is open. Dropping it is what stops a
    // vanished hub from pinning a device on a command nobody is waiting for any more.
    this.upstream?.destroy();
    this.upstream = undefined;
  }

  private begin(method: string, path: string, headers: Record<string, string>): void {
    if (this.started) return this.fail('a second request on one automation channel');
    this.started = true;

    const upstream = httpRequest(
      { host: this.opts.target.host, port: this.opts.target.port, method, path, headers },
      (res) => this.respond(res),
    );
    this.upstream = upstream;

    // No timeout of its own. The gateway already holds one (300s, >= the hub's new-session budget)
    // and the hub holds another; a third clock here could only sever a session both of the others
    // still consider live.
    upstream.on('error', (e: Error) => {
      // Not reachable in a healthy agent — the gateway is in this process. It IS reachable while the
      // agent is starting up or shutting down, which is exactly when a clear message is worth most.
      this.fail(`automation gateway unreachable: ${e.message}`);
    });
  }

  private respond(res: IncomingMessage): void {
    if (this.done) { res.resume(); return; }
    this.opts.send({ k: 'res', status: res.statusCode ?? 502, headers: flatten(res.headers) });

    res.on('data', (chunk: Buffer) => {
      // Destroying the request in `abort()` ends the response too, but not before whatever is
      // already in the socket buffer has been emitted. Those bytes belong to a channel that is gone.
      if (this.done) return;
      // Re-chunked to the tunnel's budget rather than to whatever size the socket happened to
      // deliver: a screenshot arrives as one large buffer, and one large frame is a dropped tunnel.
      for (let i = 0; i < chunk.length; i += AUTOMATION_CHUNK_BYTES) {
        this.opts.send({ k: 'd', b: chunk.subarray(i, i + AUTOMATION_CHUNK_BYTES).toString('base64') });
      }
    });
    res.on('end', () => this.finish({ k: 'end' }));
    res.on('error', (e: Error) => this.fail(`automation response failed: ${e.message}`));
  }

  private fail(message: string): void {
    this.opts.log?.('automation channel failed', { message });
    this.finish({ k: 'err', message });
  }

  /** Exactly one terminal frame per channel, then the channel goes away. */
  private finish(frame: AutomationFrame): void {
    if (this.done) return;
    this.done = true;
    this.upstream?.destroy();
    this.upstream = undefined;
    this.opts.send(frame);
    this.opts.close();
  }
}
