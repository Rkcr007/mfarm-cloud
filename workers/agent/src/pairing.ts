import { hostname as osHostname } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Getting a credential by showing a code — ADR-0014, agent half.
 *
 * The agent asks the control plane for a pairing, displays the short code it gets back, and polls
 * until somebody signed into the console approves it. What comes back is an ordinary `mae_`
 * enrollment token — the same credential the two-step `curl` produces — so everything downstream of
 * this file is unchanged: registration cannot tell how the token was obtained.
 *
 * THE DEVICE CODE NEVER LEAVES THIS PROCESS and is never rendered. It is the credential that
 * authenticates the poll; the short code is the one a human reads, and it authenticates nothing.
 * Keeping that distinction is the whole reason this is a module rather than a few lines in
 * `index.ts`: a window that rendered the wrong one of the two would be handing out a bearer token.
 *
 * EVERY DEPENDENCY IS INJECTABLE — `fetch`, the clock, the wait. Not for its own sake: this loop is
 * unusually easy to get wrong in ways no static reading catches (polling too fast, giving up on the
 * expected 'pending', treating an expired code as fatal), and all three are only observable by
 * driving it. `app.inject()` cannot help here because the agent is the CLIENT, so the tests run a
 * real server on a real socket.
 */

/** What the window shows while this is happening. Never contains the device code. */
export interface PairingProgress {
  /** Formatted for reading aloud — `XXXX-XXXX`. */
  userCode: string;
  expiresAt: string;
  status: 'waiting' | 'approved';
  /** Rises each time a code lapses unapproved and a fresh one is shown. */
  attempt: number;
}

interface StartResponse {
  deviceCode: string;
  userCode: string;
  expiresAt: string;
  intervalSeconds: number;
}

export interface PairOptions {
  controlPlaneUrl: string;
  hostname?: string;
  platform?: string;
  agentVersion?: string;
  /** Called whenever what a person should be looking at changes. */
  onProgress: (p: PairingProgress) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Cap on lapsed codes before giving up, so an unattended agent cannot poll a farm forever. */
  maxAttempts?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Never trust the server's interval blindly: a bad value would become a busy loop or a stall. */
const clampInterval = (seconds: unknown): number => {
  const n = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 5;
  return Math.min(60, Math.max(1, Math.round(n)));
};

export class PairingError extends Error {}

/**
 * Run the pairing to completion and return the `mae_` token.
 *
 * A LAPSED CODE IS NOT A FAILURE. Ten minutes is short by design, and the person who downloaded
 * this may well be reading the setup page, finding their phone, or making tea. When a code expires
 * this starts a new pairing and shows the new code, so the window always displays something that
 * currently works. Giving up would mean the agent has to be restarted for a reason that is entirely
 * ours, and by somebody who has already been told the software is running.
 */
export async function pairForToken(opts: PairOptions): Promise<string> {
  const http = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const base = opts.controlPlaneUrl.replace(/\/+$/, '');
  const maxAttempts = opts.maxAttempts ?? 24;   // ~4 hours at a 10-minute TTL

  const post = async (path: string, body: unknown): Promise<{ status: number; json: any }> => {
    const res = await http(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    const text = await res.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json };
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = await post('/v1/pair', {
      hostname: opts.hostname ?? osHostname(),
      platform: opts.platform ?? `${process.platform}-${process.arch}`,
      agentVersion: opts.agentVersion,
    });
    if (started.status !== 201 || typeof started.json?.deviceCode !== 'string') {
      throw new PairingError(
        `the control plane refused to start a pairing (${started.status}). `
        + `Check that CONTROL_PLANE_URL points at a farm that supports pairing.`,
      );
    }
    const pending = started.json as StartResponse;
    const waitMs = clampInterval(pending.intervalSeconds) * 1000;
    opts.onProgress({
      userCode: pending.userCode, expiresAt: pending.expiresAt, status: 'waiting', attempt,
    });

    // Poll until this code is approved or lapses. `410` means gone — which on this path means the
    // code expired unapproved, so the outer loop shows a new one.
    for (;;) {
      if (opts.signal?.aborted) throw new PairingError('pairing was cancelled');
      await sleep(waitMs);
      if (opts.signal?.aborted) throw new PairingError('pairing was cancelled');

      let polled: { status: number; json: any };
      try {
        polled = await post('/v1/pair/poll', { deviceCode: pending.deviceCode });
      } catch (e) {
        // The network went away, or the farm is restarting. Neither is a reason to abandon a code
        // somebody may be typing right now — keep the code on screen and try again.
        if (opts.signal?.aborted) throw new PairingError('pairing was cancelled');
        console.warn(`[pair] could not reach the control plane: ${(e as Error).message}`);
        continue;
      }

      if (polled.status === 410) break;                       // lapsed — show a new code
      if (polled.status === 429) continue;                    // told to slow down; the wait already did
      if (polled.status !== 200) {
        throw new PairingError(`the control plane answered ${polled.status} while pairing`);
      }
      if (polled.json?.status === 'pending') continue;
      if (polled.json?.status === 'approved' && typeof polled.json.token === 'string') {
        opts.onProgress({
          userCode: pending.userCode, expiresAt: pending.expiresAt, status: 'approved', attempt,
        });
        return polled.json.token as string;
      }
      throw new PairingError('the control plane returned a pairing response this agent cannot read');
    }
  }
  throw new PairingError(
    `no one approved this machine after ${maxAttempts} codes. Start the agent again when somebody `
    + 'is ready to approve it in the console.',
  );
}

/**
 * This agent's version, for the line a person reads before approving.
 *
 * Read from `package.json` rather than written out as a constant here. A hardcoded version is
 * always eventually wrong, and the one place it would be noticed is the approval screen — where
 * somebody is being asked to trust a machine on the strength of what it says about itself.
 */
export async function agentVersion(): Promise<string | undefined> {
  try {
    const raw = await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8');
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;   // cosmetic; never a reason not to pair
  }
}
