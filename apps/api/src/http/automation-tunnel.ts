import {
  AUTOMATION_CHUNK_BYTES,
  isAutomationFrame,
  type AutomationFrame,
} from '@mfarm/protocol';
import type { TunnelRegistry } from './tunnel.ts';

/**
 * The hub's end of an automation channel — ADR-0011, control-plane half.
 *
 * `callUpstream` sends a WebDriver command to a device's automation gateway. When that gateway is
 * on a machine nobody can dial — a laptop behind NAT, which is where physical devices actually
 * arrive — there is no url to `fetch`, and this carries the same request over the socket the agent
 * already holds open.
 *
 * BUFFERED, ON PURPOSE, AND ONLY BECAUSE THE HUB ALREADY IS. `callUpstream` ends in `res.text()`:
 * every reply is read whole before the hub does anything with it, so streaming here would add a
 * second buffering strategy without removing the first. The agent's side does stream, which is
 * where it matters — that is the end holding a device's Appium open.
 */

/** Matches `AbortSignal.timeout`, which is what the direct path throws. */
class TunnelTimeoutError extends Error {
  override readonly name = 'TimeoutError';
}

export interface TunnelReply {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/**
 * Send one request to `hostId`'s automation gateway through its tunnel.
 *
 * Rejects — never resolves with a synthetic status — when the host is unreachable, the agent
 * reports a failure, or the deadline passes. Every caller in the hub already turns a thrown error
 * into `automation_unreachable`, and a fabricated 502 would be indistinguishable from one Appium
 * actually sent.
 */
export async function callOverTunnel(
  tunnels: TunnelRegistry,
  hostId: string,
  path: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<TunnelReply> {
  return new Promise<TunnelReply>((resolve, reject) => {
    let head: { status: number; headers: Record<string, string> } | undefined;
    const chunks: Buffer[] = [];
    let settled = false;
    // Declared before anything that can call `finish`, so no path reaches it in the temporal dead
    // zone. Nothing below settles synchronously today; this is what keeps that from mattering.
    let channel: ReturnType<TunnelRegistry['openControlChannel']>;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Closing after `end` is not redundant with the agent's own close: whichever side finishes
      // first tells the other, and a hub that walked away without saying so would leave a channel
      // id allocated against the host's cap until its tunnel dropped.
      channel?.close();
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new TunnelTimeoutError(
        `The automation gateway did not answer within ${timeoutMs}ms.`,
      ))),
      timeoutMs,
    );
    // A pending WebDriver command must not be the reason the process cannot exit.
    timer.unref?.();

    channel = tunnels.openControlChannel(hostId, {
      onData: (d) => {
        let frame: unknown;
        try { frame = JSON.parse(d); } catch { return; }
        if (!isAutomationFrame(frame)) return;

        switch (frame.k) {
          case 'res':
            head = { status: frame.status, headers: frame.headers };
            return;
          case 'd':
            chunks.push(Buffer.from(frame.b, 'base64'));
            return;
          case 'end':
            // An `end` with no `res` before it is an agent that framed a reply wrong. Reported as a
            // failure rather than resolved as an empty 200, which a driver would act on.
            if (!head) {
              return finish(() => reject(new Error('the agent ended an automation reply without sending one')));
            }
            return finish(() => resolve({
              status: head!.status,
              headers: head!.headers,
              text: Buffer.concat(chunks).toString('utf8'),
            }));
          case 'err':
            return finish(() => reject(new Error(frame.message)));
          // A request travelling back towards the hub is the agent speaking the wrong half.
          default:
            return finish(() => reject(new Error(`unexpected ${frame.k} frame from the agent`)));
        }
      },
      onClose: (reason) => finish(() => reject(new Error(
        `the automation channel to this device's host closed: ${reason}`,
      ))),
    });

    if (!channel) {
      return finish(() => reject(new Error(
        'no agent tunnel is connected for this device\'s host, so its automation gateway cannot be reached',
      )));
    }

    const send = (f: AutomationFrame): void => channel.send(JSON.stringify(f));
    send({ k: 'req', method: init.method, path, headers: init.headers });
    if (init.body !== undefined) {
      const body = Buffer.from(init.body, 'utf8');
      for (let i = 0; i < body.length; i += AUTOMATION_CHUNK_BYTES) {
        send({ k: 'd', b: body.subarray(i, i + AUTOMATION_CHUNK_BYTES).toString('base64') });
      }
    }
    send({ k: 'end' });
  });
}
