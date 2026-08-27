import { automationPath, DATA_PLANE_TUNNEL_ENDPOINT, tunnelAutomationEndpoint } from '@mfarm/protocol';

/**
 * Where this host's gateways are advertised, and therefore how they are bound — ADR-0011.
 *
 * BOTH endpoints live here, not just automation. They answer the same question — "how is this host
 * reached?" — with the same three-step precedence, and phase 0 found out what happens when only one
 * of them is fixed: `APPIUM_ENABLED=1` started fine on a NAT'd laptop and the agent then died on
 * `PUBLIC_ENDPOINT is required` two lines later. Keeping them apart is what let the second one keep
 * a requirement the first had already dropped.
 *
 * ITS OWN MODULE SO IT CAN BE TESTED. `index.ts` runs `main()` on import, so nothing in it can be
 * exercised without starting an agent — and the precedence below is the single rule that decides
 * whether the existing farm keeps its verified direct path or silently moves onto the tunnel. A
 * rule that important should not be the one thing no test can reach.
 *
 * Every function here reads `process.env` at CALL TIME rather than at module scope: the agent reads
 * these while starting up, and a module-scope snapshot would be taken before a test — or a
 * bootstrap that configures the process — had set anything.
 */

/** Whether this agent will hold a tunnel to the control plane. The gateway's transport depends on it. */
export const tunnelEnabled = (): boolean => process.env.MFARM_TUNNEL !== '0';

/**
 * How this host's automation gateway is to be reached, as a base url per device.
 *
 * THREE ANSWERS, IN THIS ORDER, and the order is the decision ADR-0011 records.
 *
 * 1. `AUTOMATION_ADVERTISE_BASE` wins outright and is what a TLS deployment sets
 *    (`https://worker-1.example:8443`) — the worker already terminates TLS for the data plane, and
 *    ADR-0004 point 3 puts automation on that same public listener rather than inventing a second
 *    exposure class.
 * 2. `APPIUM_ADVERTISE_HOST`/`PUBLIC_HOST` composes the same direct url, keeping exactly the
 *    meaning ADR-0004 gives it: the externally-reachable name for the worker. This is what the
 *    existing farm sets, so it stays on the path it was verified on.
 * 3. Otherwise, the TUNNEL — and this is the case that used to throw.
 *
 * A laptop with a phone on it has no answer to 1 or 2. It is behind NAT, it has no certificate and
 * no stable name, and demanding one was the last place in the product that assumed a worker is
 * dialable — ADR-0008 had already inverted the data plane for exactly this reason. Throwing here
 * meant `APPIUM_ENABLED=1` could not start on the machine physical devices actually arrive on.
 *
 * Falling back rather than defaulting to it. An operator who has named a public address has said
 * something about their deployment, and quietly routing around it would be this code overruling
 * them — the direct path is one hop shorter and it is theirs to choose.
 *
 * With no public name AND no tunnel there is genuinely nowhere to advertise, and that still throws:
 * the alternative is registering an endpoint only this machine can reach.
 */
const advertisedHost = (): string | undefined =>
  process.env.APPIUM_ADVERTISE_HOST ?? process.env.PUBLIC_HOST;

/**
 * Whether automation will ride the tunnel rather than a listener anyone can dial.
 *
 * Read in two places that must not disagree: what gets advertised, and which interface the gateway
 * binds. A host advertising `mfarm+tunnel:` while binding `0.0.0.0` would be publishing the private
 * answer and exposing the public one — the worst of both, and invisible.
 */
export function automationIsTunnelled(): boolean {
  if (process.env.AUTOMATION_ADVERTISE_BASE) return false;
  if (advertisedHost()) return false;
  return tunnelEnabled();
}

/**
 * The data-plane address this host registers — `hosts.endpoint`.
 *
 * SAME THREE ANSWERS IN THE SAME ORDER as `gatewayBase`, and for the same reasons:
 *
 * 1. `PUBLIC_ENDPOINT` wins outright. The existing farm sets it (`ws://10.160.0.2:8080`) and stays
 *    on the direct path it was verified on — this ships without a flag day, exactly as ADR-0011 did.
 * 2. Otherwise the TUNNEL, which is the case that used to throw. ADR-0008 had already inverted this
 *    plane — the browser reaches `/dp/<hostId>` through the control plane's ingress, over the socket
 *    the agent dialled out — so the address was already unused on a tunnelled host. It was still
 *    mandatory, which is why a laptop could not start an agent at all.
 * 3. With no public endpoint AND no tunnel there is genuinely nowhere, and that still throws.
 *
 * There is no `PUBLIC_HOST` step here on purpose. `PUBLIC_HOST` names an HTTP host for the
 * automation gateway; the data plane is a WebSocket on a different port, and composing one from the
 * other would invent an address rather than read one.
 */
export function dataPlaneEndpoint(): string {
  const explicit = process.env.PUBLIC_ENDPOINT?.trim();
  if (explicit) return explicit;
  if (tunnelEnabled()) return DATA_PLANE_TUNNEL_ENDPOINT;
  throw new Error(
    'PUBLIC_ENDPOINT is unset and MFARM_TUNNEL=0 has ruled out the tunnel, so there is nowhere to ' +
    'reach this host\'s data plane. Set PUBLIC_ENDPOINT to the ws:// address a browser or the ' +
    'control plane can dial — or leave the tunnel on, which is the answer for a host that is not ' +
    'dialable. Registering 127.0.0.1 would publish an address only this machine can reach.',
  );
}

/** Whether the data plane will be reached through the tunnel rather than a listener anyone can dial. */
export function dataPlaneIsTunnelled(): boolean {
  return !process.env.PUBLIC_ENDPOINT?.trim() && tunnelEnabled();
}

export function gatewayBase(port: number, localId: string): string {
  if (automationIsTunnelled()) return tunnelAutomationEndpoint(localId);
  const explicit = process.env.AUTOMATION_ADVERTISE_BASE;
  if (explicit) return `${explicit.replace(/\/+$/, '')}${automationPath(localId)}`;
  const host = advertisedHost();
  if (host) return `http://${host}:${port}${automationPath(localId)}`;
  throw new Error(
    'APPIUM_ENABLED needs somewhere to advertise the automation gateway, and MFARM_TUNNEL=0 has ' +
    'ruled out the tunnel. Set AUTOMATION_ADVERTISE_BASE to its full public base url, or ' +
    'APPIUM_ADVERTISE_HOST/PUBLIC_HOST to this host\'s externally-reachable name — or leave the ' +
    'tunnel on, which is the answer for a host that is not dialable. Advertising 127.0.0.1 would ' +
    'register an endpoint only this machine can reach.',
  );
}
