import { TUNNEL_CAPABILITY, isProxyFrame, type ProxyFrame, type ProxyErrorCode } from '@mfarm/protocol';
import type { FastifyInstance } from 'fastify';
import { withSystem } from '../db.ts';
import type { ProxyOpen } from './tunnel.ts';
import type { CustomerTunnelRegistry } from './customer-tunnel.ts';

/**
 * Route a device's proxied request to its org's tunnel (migration 052).
 *
 * THIS IS WHERE THE TWO TUNNELS MEET, and it is the only place that knows both exist. The agent
 * tunnel brought a request UP from a device; the customer tunnel carries it OUT to a private
 * network. Everything in between is this function deciding, from rows, which customer tunnel that
 * device is entitled to reach.
 *
 * **THE AGENT NAMES A DEVICE AND NOTHING ELSE.** Architecture rule 4 on the path where breaking it
 * would be worst: a worker that could name an org or a tunnel would be a worker that could route
 * one tenant's device into another tenant's private network. So the chain is:
 *
 *     host + local_id  ->  the device row        (the agent can only name its own devices)
 *     device           ->  its LIVE session      (no session means nothing may be routed at all)
 *     session          ->  org_id               (the paying tenant, from the row)
 *     session          ->  mfarm:tunnel         (which of that org's tunnels, from the caller's caps)
 *
 * Every link is a row this control plane wrote. Nothing in the request contributes to it.
 *
 * A SESSION IS REQUIRED, and that is a security property rather than bookkeeping. A device with no
 * live session is a device between tenants — freshly reset, or waiting in the pool — and letting it
 * reach anything would mean whatever the last tenant left running on it could still phone home
 * into the next tenant's network.
 */

/** How the router answers when it cannot route. The device sees these as 403/502/503 — see
 *  `device-proxy.ts` for which code maps to which, and why they are different. */
function refuse(o: ProxyOpen, message: string, code: ProxyErrorCode): void {
  o.send(JSON.stringify({ k: 'err', message, code } satisfies ProxyFrame));
  o.close(message);
}

interface Routed {
  orgId: string;
  tunnel: string;
  sessionId: string;
}

/**
 * Resolve which tunnel this device may use, or a sentence saying why not.
 *
 * Exported so the test can assert the chain directly, and so the reasoning above is checkable
 * rather than merely stated.
 */
export async function routeFor(hostId: string, localId: string): Promise<Routed | { refusal: string }> {
  if (!hostId || !localId) return { refusal: 'this request did not name a device.' };

  /**
   * ONE QUERY, on the SYSTEM pool. There is no tenant to scope by yet — finding out which tenant
   * this is, is the query's whole purpose — and that is the same exception `authenticate()` takes
   * for the same reason. Everything downstream of this uses the org it returns.
   */
  const row = await withSystem(async (c) => (await c.query<{
    org_id: string; session_id: string; constraints: Record<string, unknown>; requested: Record<string, unknown>;
  }>(
    `SELECT s.org_id, s.id AS session_id, s.constraints, s.requested
       FROM devices d
       JOIN sessions s ON s.device_id = d.id
      WHERE d.host_id = $1
        AND d.local_id = $2
        AND s.state IN ('ACTIVE', 'ALLOCATING')
      ORDER BY s.started_at DESC NULLS LAST
      LIMIT 1`,
    [hostId, localId],
  )).rows[0]);

  if (!row) {
    return {
      refusal:
        'this device is not holding a session right now, so it has no tunnel to use. A device '
        + 'between tenants must not reach anybody’s network.',
    };
  }

  /**
   * The tunnel the SUITE asked for, read from what it sent at session creation.
   *
   * Looked for in both places a capability lands because the hub stores the requested capabilities
   * and the allocator stores the constraints it derived, and which one carries a given key has
   * changed once already. Reading both is two property lookups and removes a whole class of "it
   * works on the hub but not from the CLI".
   */
  const named = pickTunnel(row.requested) ?? pickTunnel(row.constraints);
  if (!named) {
    return {
      refusal:
        `this session did not ask for a tunnel. Set ${TUNNEL_CAPABILITY} in your capabilities to `
        + 'the name of a tunnel your organisation has running.',
    };
  }

  return { orgId: row.org_id, tunnel: named, sessionId: row.session_id };
}

function pickTunnel(bag: Record<string, unknown> | null | undefined): string | undefined {
  if (!bag || typeof bag !== 'object') return undefined;
  const v = (bag as Record<string, unknown>)[TUNNEL_CAPABILITY]
    ?? (bag as Record<string, unknown>).tunnel;
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Build the router `attachTunnel` installs.
 *
 * Returns a function rather than being one, so the two registries are closed over instead of being
 * module state — the same reason both are decorated on the app: two servers in one test must not
 * share a fleet.
 */
export function makeProxyRouter(app: FastifyInstance, customers: CustomerTunnelRegistry) {
  return async function onProxyOpen(o: ProxyOpen): Promise<void> {
    let routed: Routed | { refusal: string };
    try {
      routed = await routeFor(o.hostId, o.localId);
    } catch (err) {
      app.log.error({ err, localId: o.localId }, 'could not resolve a tunnel for a proxied request');
      return refuse(o, 'the farm could not work out which tunnel this device should use.', 'no_tunnel');
    }

    if ('refusal' in routed) return refuse(o, routed.refusal, 'no_tunnel');

    const channel = customers.open(routed.orgId, routed.tunnel, {
      onFrame: (f) => o.send(JSON.stringify(f)),
      onClose: (reason) => o.close(reason),
    });

    if (!channel) {
      /**
       * NAMES THE TUNNEL. "No tunnel is connected" sends somebody to check the farm; "no tunnel
       * called `staging` is connected — start it with `npx @mfarm/cli tunnel --name staging`" sends
       * them to the one machine that can fix it, which is their own.
       */
      return refuse(
        o,
        `no tunnel called "${routed.tunnel}" is connected for your organisation right now. `
        + `Start it with: npx @mfarm/cli tunnel --name ${routed.tunnel} --allow <your host>`,
        'no_tunnel',
      );
    }

    // From here this is a relay in both directions and decides nothing further.
    o.onInbound((d) => {
      let f: unknown;
      try { f = JSON.parse(d); } catch { return; }
      if (isProxyFrame(f)) channel.send(f);
    });
    o.onClosed(() => channel.close());

    app.log.debug({ tunnel: routed.tunnel, sessionId: routed.sessionId }, 'proxied a request through a customer tunnel');
  };
}
