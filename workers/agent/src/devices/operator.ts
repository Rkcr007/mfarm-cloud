import { WebSocket } from 'ws';
import type { SignalChannel, SignalOptions } from '../device.ts';

/**
 * A client for Cuttlefish's WebRTC **operator** — the local signaling server `cvd` runs beside the
 * devices (ADR-0007).
 *
 * The whole of the wire contract lives in this file, and it is short enough to state here. It comes
 * from `server_connector.js` in `android-cuttlefish`, which carries an explicit promise that it will
 * not break backward compatibility:
 *
 *   GET  /infra_config                → { ice_servers: [...] }
 *   GET  /devices                     → ["cvd-1", ...]  (or objects carrying a device id)
 *   WS   /devices/{deviceId}/connect  → first frame { device_info }, then { payload } | { error }
 *   client → server                   → the payload object, sent raw
 *
 * Everything above the envelope is opaque here ON PURPOSE. The payloads are ordinary WebRTC offers,
 * answers and ICE candidates; parsing them would buy nothing and would make a Cuttlefish release
 * that adds a field into a worker change.
 *
 * NOTHING IN THIS FILE IS AUTHORISATION. The operator is unauthenticated device control — that is
 * why it stays on loopback and why the only thing that reaches it is a data-plane connection that
 * has already presented a valid Ed25519 grant for this exact device.
 */

/** How long the operator has to answer before a viewer is told the device is not streaming. */
const CONNECT_TIMEOUT_MS = 8_000;
const HTTP_TIMEOUT_MS = 5_000;

export interface OperatorOptions {
  /**
   * Base url of the operator. Loopback by default and it must stay that way in production.
   *
   * The DEFAULT PORT IS THE ONE THING HERE THAT IS ASSERTED RATHER THAN MEASURED. Modern `cvd` runs
   * the operator on 1080 (http) / 1443 (https); `launch_cvd` used to serve it on 8443, which is
   * where `CuttlefishMedia`'s old hard-coded port came from. `CF_OPERATOR_URL` exists so that being
   * wrong costs an environment variable rather than a release.
   */
  baseUrl?: string;
  /** Our name for the device. The operator may know it by another one — see `resolveDeviceId`. */
  localId: string;
  /** cvd's instance number, used as the last resort when matching names fail. */
  instanceNum: number;
}

const DEFAULT_BASE = 'http://127.0.0.1:1080';

function base(opts: OperatorOptions): string {
  return (opts.baseUrl ?? process.env.CF_OPERATOR_URL ?? DEFAULT_BASE).replace(/\/+$/, '');
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/**
 * Pull every string that could be a device id out of whatever `GET /devices` returned.
 *
 * Tolerant for the same reason `findFleetInstance` is: this document's shape has changed across
 * Cuttlefish releases (a flat array of ids, an array of objects, a `{devices:[…]}` wrapper) and none
 * of the variants have been verified by this repo. A parse miss must degrade to "cannot find the
 * device, say so" and never to "connect to whichever one turns up first".
 */
export function extractDeviceIds(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      for (const key of ['device_id', 'deviceId', 'id', 'name']) {
        if (typeof obj[key] === 'string') { out.push(obj[key] as string); return; }
      }
      for (const v of Object.values(obj)) walk(v);
    }
  };
  walk(doc);
  return [...new Set(out)];
}

/**
 * Decide which operator device id is ours.
 *
 * `--webrtc_device_id=cf-1` is passed at create time, so an exact match is the normal case. It is
 * NOT the reliable case: a group brought back with `start --snapshot_path` loses the id it was
 * created with and re-registers as something like `cvd_1-1-1`. That is the same defect
 * `findFleetInstance` already works around for `cvd fleet`, and it is why this cannot simply
 * assume `localId`.
 *
 * The fallbacks are ordered by how much they could cost if wrong. A sole device on the host is
 * unambiguous. An id ending in the instance number is strong evidence on a host where instance
 * numbers are what distinguish devices. Anything less certain returns undefined, and the caller
 * refuses — connecting a viewer to the wrong device is a cross-tenant screen leak, which is a far
 * worse outcome than a live view that says it could not find the device.
 */
export function resolveDeviceId(
  ids: string[],
  match: { localId: string; instanceNum: number },
): string | undefined {
  if (ids.includes(match.localId)) return match.localId;
  if (ids.length === 1) return ids[0];
  const byInstance = ids.filter((id) => new RegExp(`(^|[^0-9])${match.instanceNum}$`).test(id));
  return byInstance.length === 1 ? byInstance[0] : undefined;
}

export async function fetchIceServers(opts: OperatorOptions): Promise<unknown[]> {
  try {
    const doc = await getJson(`${base(opts)}/infra_config`) as { ice_servers?: unknown[] };
    return Array.isArray(doc?.ice_servers) ? doc.ice_servers : [];
  } catch {
    // Advisory data. The control plane's minted TURN credentials are what a viewer actually relies
    // on, so an operator that will not answer this is not a reason to fail the connection.
    return [];
  }
}

export async function findDeviceId(opts: OperatorOptions): Promise<string> {
  const ids = extractDeviceIds(await getJson(`${base(opts)}/devices`));
  const id = resolveDeviceId(ids, opts);
  if (!id) {
    throw new Error(
      `the operator at ${base(opts)} does not identify a device as '${opts.localId}' ` +
      `(it lists ${ids.length ? ids.map((i) => `'${i}'`).join(', ') : 'nothing'}). ` +
      'Refusing to guess: on a multi-device host a guess is another tenant\'s screen.',
    );
  }
  return id;
}

/**
 * Open the signaling channel and resolve once the operator has identified the device.
 *
 * Resolving on `device_info` rather than on the socket opening is deliberate: an open socket to the
 * operator proves the operator is up, and says nothing about whether the device behind it is. A
 * viewer that got "connected" and then never received a frame is the failure shape ADR-0005 was
 * written about.
 */
export async function openSignalChannel(
  opts: OperatorOptions,
  handlers: SignalOptions,
): Promise<SignalChannel> {
  const [deviceId, iceServers] = await Promise.all([findDeviceId(opts), fetchIceServers(opts)]);
  const wsUrl = `${base(opts).replace(/^http/, 'ws')}/devices/${encodeURIComponent(deviceId)}/connect`;
  const ws = new WebSocket(wsUrl);

  return new Promise<SignalChannel>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error(`the operator did not describe device '${deviceId}' within ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);

    const fail = (reason: string): void => {
      clearTimeout(timer);
      if (settled) { handlers.onClose(reason); return; }
      settled = true;
      reject(new Error(reason));
    };

    ws.on('message', (raw) => {
      let msg: { device_info?: unknown; payload?: unknown; error?: string };
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (!settled && msg.device_info !== undefined) {
        settled = true;
        clearTimeout(timer);
        resolve({
          deviceInfo: msg.device_info,
          iceServers,
          send: (payload) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); },
          close: () => ws.close(),
        });
        return;
      }
      if (msg.error !== undefined) return fail(`the device signalling server reported: ${msg.error}`);
      // Everything else is the device's half of a WebRTC negotiation, passed on untouched.
      if (msg.payload !== undefined) handlers.onPayload(msg.payload);
    });

    ws.on('error', (e) => fail(`could not reach the device signalling server: ${(e as Error).message}`));
    ws.on('close', () => fail('the device signalling server closed the connection'));
  });
}
