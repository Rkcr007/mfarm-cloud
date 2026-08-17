import type { FastifyInstance } from 'fastify';
import { timingSafeEqual, createHash } from 'node:crypto';
import { withSystem } from '../../db.ts';
import { generateWorkerToken } from '../../auth.ts';
import { negotiate, deviceAutomationEndpoint, type WorkerRegistration } from '@mfarm/protocol';
import { resetComplete } from '../../allocator.ts';
import { ingest, type MeterKind } from '../../metering.ts';
import { requireWorker } from '../server.ts';
import { unauthorized, badRequest } from '../errors.ts';

const digest = (s: string) => createHash('sha256').update(s).digest();

function registrationTokenValid(presented: string | undefined): boolean {
  const expected = process.env.WORKER_REGISTRATION_TOKEN;
  if (!expected || !presented) return false;
  // Hash both sides so the comparison is fixed-length regardless of input.
  return timingSafeEqual(digest(presented), digest(expected));
}

export async function workerRoutes(app: FastifyInstance) {
  /**
   * Bootstrap. Authenticated by a shared registration token, not a bearer credential — this is the
   * one endpoint a worker can reach before it has an identity.
   *
   * Registration is the credential-issuing operation: it returns a worker token the host persists
   * and uses for everything afterwards, plus the public key it needs to verify session tokens
   * offline. The worker never learns the signing key, so a compromised host cannot mint access to
   * the rest of the fleet.
   */
  app.post<{ Body: WorkerRegistration }>('/workers/register', async (req, reply) => {
    if (!registrationTokenValid(req.headers['x-worker-registration-token'] as string | undefined)) {
      throw unauthorized('Invalid or missing X-Worker-Registration-Token.');
    }

    const reg = req.body;
    if (!reg?.hostname || !reg?.region) throw badRequest('hostname and region are required.');

    const result = negotiate(reg);
    if (!result.ok) throw badRequest(result.reason);

    const token = generateWorkerToken();

    const host = await withSystem(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO hosts (region, hostname, state, protocol_version, capabilities,
                            cores, memory_mb, endpoint, automation_endpoint,
                            token_prefix, token_hash, last_heartbeat_at)
         VALUES ($1,$2,'UP',$3,$4::jsonb,$5,$6,$7,$8,$9,$10, now())
         ON CONFLICT (hostname) DO UPDATE SET
           region = EXCLUDED.region, state = 'UP',
           protocol_version = EXCLUDED.protocol_version,
           capabilities = EXCLUDED.capabilities,
           cores = EXCLUDED.cores, memory_mb = EXCLUDED.memory_mb,
           endpoint = EXCLUDED.endpoint,
           automation_endpoint = EXCLUDED.automation_endpoint,
           token_prefix = EXCLUDED.token_prefix, token_hash = EXCLUDED.token_hash,
           last_heartbeat_at = now(),
           quarantined_at = NULL, quarantine_reason = NULL
         RETURNING id`,
        [reg.region, reg.hostname, result.version, JSON.stringify(reg.capabilities),
         reg.cores ?? null, reg.memoryMb ?? null, reg.endpoint ?? null,
         reg.automationEndpoint ?? null, token.prefix, token.hash],
      );
      const hostId = rows[0].id;

      const schedulable = new Set(result.schedulable);
      const deviceIds: Record<string, string> = {};
      for (const d of reg.devices ?? []) {
        const { rows: dev } = await c.query(
          `INSERT INTO devices (host_id, region, platform, tier, model, os_version,
                                capabilities, local_id, state, automation_endpoint,
                                adb_serial, system_port, mjpeg_server_port)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (host_id, local_id) WHERE local_id IS NOT NULL DO UPDATE SET
             capabilities = EXCLUDED.capabilities,
             os_version = EXCLUDED.os_version,
             model = EXCLUDED.model,
             -- Re-asserted on every registration, and allowed to become NULL. This is the write
             -- that WITHDRAWS an automation endpoint: an agent whose Appium did not come back
             -- re-registers without one, and a stale url left behind here would keep the hub
             -- dialling a server that is gone (ADR-0003 decision 3).
             automation_endpoint = EXCLUDED.automation_endpoint,
             -- Same rule for identity: a rebuilt host can legitimately hand a device a different
             -- serial or port, and the last registration is the truth.
             adb_serial = EXCLUDED.adb_serial,
             system_port = EXCLUDED.system_port,
             mjpeg_server_port = EXCLUDED.mjpeg_server_port,
             updated_at = now()
           RETURNING id`,
          [hostId, reg.region, d.platform, d.tier, d.model, d.osVersion,
           JSON.stringify(d.capabilities), d.localId,
           // A device missing snapshot-reset or persistent input registers so it stays visible and
           // monitorable, but starts OFFLINE — it is never handed to a tenant.
           schedulable.has(d.localId) ? 'READY' : 'OFFLINE',
           // v1 workers name one server for the whole host; v2 names one per device. Resolved in
           // `packages/protocol` so the hub's COALESCE and this write cannot drift apart.
           deviceAutomationEndpoint(reg, d) ?? null,
           d.adbSerial ?? null, d.systemPort ?? null, d.mjpegServerPort ?? null],
        );
        if (d.localId && dev[0]?.id) deviceIds[d.localId] = dev[0].id as string;
      }
      return { hostId, deviceIds };
    });

    return reply.code(201).send({
      hostId: host.hostId,
      protocolVersion: result.version,
      // Capabilities we know about that this worker did not advertise. Told plainly so an operator
      // can see what the host is missing rather than discovering it when a feature silently no-ops.
      degradedCapabilities: result.degraded,
      schedulableDevices: result.schedulable,
      workerToken: token.plaintext,
      sessionPublicKey: app.signingKey.publicKeyPem,
      // v2. The worker cannot authorize an automation grant without this: a grant names a device
      // uuid and the gateway's path names a local id, and only the control plane knows both.
      deviceIds: host.deviceIds,
    });
  });

  /** Liveness. A host that stops heartbeating is a candidate for quarantine. */
  app.post('/workers/heartbeat', async (req) => {
    const { hostId } = requireWorker(req);
    const row = await withSystem(async (c) => {
      const { rows } = await c.query(
        `UPDATE hosts SET last_heartbeat_at = now() WHERE id = $1 RETURNING state`,
        [hostId],
      );
      return rows[0];
    });
    // Told on every beat so a host that was quarantined while partitioned learns it must drain.
    return { ok: true, hostState: row?.state ?? 'DOWN' };
  });

  /**
   * Worker-reported facts: metering and device state transitions.
   *
   * Batched because a busy host emits continuously and a request per event would cost more than the
   * work being measured. Metering is idempotent by worker-supplied event id, so retrying a batch
   * after a network failure cannot double-bill.
   */
  app.post<{
    Body: {
      // `orgId` is accepted and IGNORED. Older agents still send it; the org that gets charged is
      // derived from the session inside record_metering, because a worker that can name the paying
      // org can bill any org (migration 008).
      metering?: Array<{ eventId: string; sessionId?: string | null; deviceId?: string | null;
                         kind: MeterKind; quantity: number; occurredAt: string; orgId?: string }>;
      resets?: Array<{ deviceId: string; fence: number }>;
    };
  }>('/workers/events', async (req) => {
    const { hostId } = requireWorker(req);
    const { metering = [], resets = [] } = req.body ?? {};

    const meter = await ingest(
      hostId,
      metering.map((e) => ({
        eventId: e.eventId, sessionId: e.sessionId ?? null,
        deviceId: e.deviceId ?? null, kind: e.kind, quantity: e.quantity,
        occurredAt: new Date(e.occurredAt),
      })),
    );

    // Rejection means a host reported usage for a session that is not on it. That is either a bug in
    // the agent or a host reaching past its own hardware, and both need a human — a counter in a
    // response body nobody reads is not a signal.
    if (meter.rejected > 0) {
      req.log.warn(
        { hostId, rejected: meter.rejected, sent: metering.length },
        'metering events rejected: the sessions they name are not on this host',
      );
    }

    // A stale fence is expected, not exceptional: it means this worker was partitioned and the
    // device has since moved on. Report it back rather than failing the batch. So is a device that
    // is not ours — same answer, because telling a caller which of the two it was would let any
    // worker probe the fleet's device ids.
    const resetResults = [];
    for (const r of resets) {
      resetResults.push({
        deviceId: r.deviceId,
        accepted: await resetComplete(hostId, r.deviceId, r.fence),
      });
    }

    return {
      meteringRecorded: meter.recorded,
      meteringDuplicates: meter.duplicates,
      meteringRejected: meter.rejected,
      resets: resetResults,
    };
  });
}
