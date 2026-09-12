/**
 * Live infrastructure status, pushed.
 *
 * ---------------------------------------------------------------- why this exists at all
 *
 * The console already polls every five seconds and that is a good design for the rest of the
 * product: the fleet is small, the page sits open on a desk, and a poll cannot get stuck
 * half-connected the way a socket can. Two things about THIS page are different.
 *
 *   AN OPERATION HAS A MOMENT. Somebody presses Drain and then watches. Five seconds of nothing is
 *   long enough to press it again, and the second press is the one that produces a support
 *   conversation. A push closes that window to the round trip.
 *
 *   THE PAYLOAD IS EXPENSIVE. `GET /v1/infra/overview` runs a database probe, five grouped queries
 *   and a fortnight of interval arithmetic. Polling that at five seconds per open tab is a real
 *   cost, and the stream computes it once per tick for every listener.
 *
 * ---------------------------------------------------------------- SSE, and not a WebSocket
 *
 * This is one direction: the server says what changed and the browser never answers. SSE is
 * therefore the whole protocol — it reconnects on its own, it carries the session cookie without
 * anything being arranged, and it survives a proxy that would need configuring for an upgrade.
 * A WebSocket would be a second transport to authorise, keep alive and reap, to carry nothing back.
 *
 * The poll is NOT removed and is not a fallback bolted on afterwards. It is what the console does
 * everywhere; this stream is an accelerator on one screen, and a browser that cannot hold an event
 * stream open simply sees the page it would have seen anyway, five seconds later.
 *
 * ---------------------------------------------------------------- the honest limit
 *
 * `infraChanged()` is an IN-PROCESS signal. With a second API process an operation performed on one
 * would not wake the streams on the other — those clients fall back to the tick below, which is
 * bounded, so the failure is latency and never staleness. The farm runs one API process today
 * (STATUS.md says so, and the rate limiter has the same property for a sharper reason), and this is
 * written down here rather than discovered later.
 */

/** Listeners waiting for something to have happened. */
const waiters = new Set<() => void>();

/**
 * Something changed; wake every open stream.
 *
 * Called by the operations module after a write lands. NOT called from the read path: a stream that
 * woke on every read would wake on its own ticks.
 */
export function infraChanged(): void {
  for (const wake of [...waiters]) {
    try { wake(); } catch { /* a dead listener must not stop the others being told */ }
  }
}

/**
 * Resolve when something changes, or after `ms`, whichever comes first.
 *
 * THE TIMEOUT IS THE FLOOR, NOT THE MECHANISM. Most of what this page shows moves without anybody
 * acting on it — a heartbeat ages, a device finishes cleaning, a disk fills — and none of that goes
 * through `infraChanged`. So the stream ticks regardless, and the signal only makes an OPERATION
 * feel immediate.
 */
export function waitForChange(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      waiters.delete(wake);
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const wake = () => finish();
    const timer = setTimeout(finish, ms);
    // Never hold the process open for a stream tick. A test or a CLI that finishes with a stream
    // still attached should exit.
    timer.unref?.();
    waiters.add(wake);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** How many listeners are attached. Read by tests and by the metrics endpoint. */
export function streamListeners(): number {
  return waiters.size;
}

/**
 * One SSE frame.
 *
 * `event:` is named rather than left default so the console can attach one handler per kind and a
 * future kind cannot silently arrive as a state update. The comment line at the end is a KEEPALIVE:
 * proxies and load balancers close an idle connection, and a stream that is healthy but quiet is
 * indistinguishable from a dead one without it.
 */
export function sseFrame(event: string, data: unknown): string {
  // Newlines inside the payload would terminate the frame early, so the JSON is emitted as one line
  // — which `JSON.stringify` already guarantees, and this comment exists so nobody "improves" it
  // into a pretty-printed body.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Sent when nothing has changed, to keep the connection from being reaped by something in between. */
export const SSE_KEEPALIVE = ': keepalive\n\n';
