import type { FastifyInstance } from 'fastify';
import { timingSafeEqual, createHash } from 'node:crypto';
import { withSystem } from '../../db.ts';
import { generateWorkerToken, sha256, safeEqualHex } from '../../auth.ts';
import { redeemEnrollment, markRedeemed } from '../../enrollment.ts';
import { negotiate, deviceAutomationEndpoint, classifyReason, type AppActionKind, type WorkerRegistration } from '@mfarm/protocol';
import { finishRecovery, resetComplete, sessionAttach } from '../../allocator.ts';
import { ingest, type MeterKind } from '../../metering.ts';
import { recordInfraRetry } from '../../attempts.ts';
import { recordSessionEvent } from '../../executionEvents.ts';
import { appActions, deviceRecoveries, hostsRecovered, meteringEvents, workerResets } from '../../metrics.ts';
import { requireWorker } from '../server.ts';
import { unauthorized, badRequest } from '../errors.ts';

const digest = (s: string) => createHash('sha256').update(s).digest();

function fleetSecretValid(presented: string): boolean {
  const expected = process.env.WORKER_REGISTRATION_TOKEN;
  if (!expected) return false;
  // Hash both sides so the comparison is fixed-length regardless of input.
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * Who is allowed to register, and as what.
 *
 * `bad` collapses every failure into one refusal. The reasons are for the server log: a person who
 * has just pasted a token wants "that token is not valid", and a stranger should not learn which
 * of the three kinds they got wrong or whether a prefix exists.
 */
type Credential =
  | { kind: 'fleet' }                                        // operator-owned host, shared devices
  | { kind: 'enrollment'; orgId: string; enrollmentId: string }
  | { kind: 'rereg'; orgId: string | null }                  // a host that already has an identity
  | { kind: 'bad'; why: string };

export async function workerRoutes(app: FastifyInstance) {
  /**
   * Bootstrap. This is the one endpoint a worker can reach before it has an identity, and it is
   * the credential-issuing operation: it returns a worker token the host persists and uses for
   * everything afterwards, plus the public key it needs to verify session tokens offline. The
   * worker never learns the signing key, so a compromised host cannot mint access to the fleet.
   *
   * THREE CREDENTIALS ARRIVE ON THE SAME HEADER, told apart by their prefix. One header rather
   * than three because the agent already sends this one: enrolling a laptop is then a different
   * value in an existing variable, not a new config key and a new code path in the agent.
   *
   *   `mae_…`  a per-agent ENROLLMENT token (migration 023). Single-use, expiring, revocable,
   *            org-scoped — and the org it names is stamped onto the host and every device the
   *            host registers, which is what keeps a phone out of the shared pool.
   *   `mwk_…`  the host's OWN worker token, for re-registration. An agent re-registers whenever
   *            its capability fingerprint changes, and an enrollment token is spent — so without
   *            this a laptop could never plug in a second phone. It also narrows the fleet secret:
   *            an existing host's row can now only be rewritten by something holding that host's
   *            credential, and only under its own hostname.
   *   anything the FLEET SECRET matches: unchanged, org-less, shared devices. This is what the
   *            Cuttlefish hosts use and nothing about them moves.
   *
   * Resolved INSIDE the registration transaction, because the enrollment path takes its row
   * `FOR UPDATE` — that lock is what makes single-use real rather than advisory when two agents
   * race with the same token.
   */
  async function resolveCredential(
    c: Parameters<Parameters<typeof withSystem>[0]>[0],
    presented: string,
    hostname: string,
  ): Promise<Credential> {
    if (presented.startsWith('mae_')) {
      const r = await redeemEnrollment(c, presented);
      return r.ok
        ? { kind: 'enrollment', orgId: r.orgId, enrollmentId: r.enrollmentId }
        : { kind: 'bad', why: `enrollment token ${r.reason}` };
    }

    if (presented.startsWith('mwk_')) {
      const { rows } = await c.query(
        'SELECT id, hostname, token_hash, org_id FROM hosts WHERE token_prefix = $1',
        [presented.slice(0, 12)],
      );
      const row = rows[0];
      if (!row) return { kind: 'bad', why: 'worker token names no host' };
      // Signature first, always. Only then is it safe to say anything about the row.
      if (!safeEqualHex(sha256(presented), row.token_hash)) {
        return { kind: 'bad', why: 'worker token does not match' };
      }
      // A worker token re-registers ITS OWN host and nothing else. Without this a compromised
      // agent could rewrite any other host's endpoint and capabilities and take its sessions.
      if (row.hostname !== hostname) {
        return { kind: 'bad', why: `worker token belongs to ${row.hostname}, not ${hostname}` };
      }
      return { kind: 'rereg', orgId: row.org_id };
    }

    return fleetSecretValid(presented) ? { kind: 'fleet' } : { kind: 'bad', why: 'fleet secret mismatch' };
  }

  app.post<{ Body: WorkerRegistration }>('/workers/register', async (req, reply) => {
    const presented = req.headers['x-worker-registration-token'] as string | undefined;
    if (!presented) throw unauthorized('Invalid or missing X-Worker-Registration-Token.');

    const reg = req.body;
    if (!reg?.hostname || !reg?.region) throw badRequest('hostname and region are required.');

    const result = negotiate(reg);
    if (!result.ok) throw badRequest(result.reason);

    const token = generateWorkerToken();

    const host = await withSystem(async (c) => {
      const cred = await resolveCredential(c, presented, reg.hostname);
      if (cred.kind === 'bad') {
        req.log.warn({ hostname: reg.hostname, why: cred.why }, 'worker registration refused');
        throw unauthorized('Invalid or missing X-Worker-Registration-Token.');
      }
      // NULL for a fleet-secret host, which is the existing behaviour and the shared pool.
      const orgId = cred.kind === 'fleet' ? null : cred.orgId;
      const enrollmentId = cred.kind === 'enrollment' ? cred.enrollmentId : null;

      const { rows } = await c.query(
        `INSERT INTO hosts (region, hostname, state, protocol_version, capabilities,
                            cores, memory_mb, endpoint, automation_endpoint,
                            token_prefix, token_hash, last_heartbeat_at, org_id)
         VALUES ($1,$2,'UP',$3,$4::jsonb,$5,$6,$7,$8,$9,$10, now(), $11)
         ON CONFLICT (hostname) DO UPDATE SET
           region = EXCLUDED.region,
           -- REGISTRATION NO LONGER LIFTS A QUARANTINE, and that is the fix rather than an
           -- oversight. It used to clear quarantined_at/quarantine_reason unconditionally, which
           -- silently overruled migration 016: an OPERATOR quarantine is a judgement no packet
           -- from the host can answer, and this path let the host answer it. It also left
           -- quarantine_source behind, so a host came back UP still claiming to be quarantined
           -- by someone.
           --
           -- Harmless for years because a healthy agent never re-registers (016's own note). A
           -- laptop whose phone set changes re-registers routinely, which turns a rare trap into
           -- the normal path. Un-quarantining now happens in exactly one place, the same
           -- clear_silence_quarantine the heartbeat calls, which also restores each device to
           -- what it was doing rather than guessing READY.
           state = CASE WHEN hosts.state = 'QUARANTINED' THEN hosts.state ELSE 'UP' END,
           protocol_version = EXCLUDED.protocol_version,
           capabilities = EXCLUDED.capabilities,
           cores = EXCLUDED.cores, memory_mb = EXCLUDED.memory_mb,
           endpoint = EXCLUDED.endpoint,
           automation_endpoint = EXCLUDED.automation_endpoint,
           token_prefix = EXCLUDED.token_prefix, token_hash = EXCLUDED.token_hash,
           last_heartbeat_at = now(),
           -- Only ever set, never cleared here: an enrolled host keeps its org across
           -- re-registrations, and a fleet-secret host stays NULL because that is what it sends.
           org_id = COALESCE(EXCLUDED.org_id, hosts.org_id)
         RETURNING id, state, quarantine_source`,
        [reg.region, reg.hostname, result.version, JSON.stringify(reg.capabilities),
         reg.cores ?? null, reg.memoryMb ?? null, reg.endpoint ?? null,
         reg.automationEndpoint ?? null, token.prefix, token.hash, orgId],
      );
      const hostId = rows[0].id as string;

      // One un-quarantine path, shared with the heartbeat. A registration is evidence the host is
      // alive, so it falsifies a SILENCE quarantine exactly the way a beat does — and has exactly
      // as little standing against an operator's.
      if (rows[0].state === 'QUARANTINED' && rows[0].quarantine_source === 'reaper') {
        const { rows: cleared } = await c.query<{ n: number }>(
          'SELECT clear_silence_quarantine($1) AS n', [hostId],
        );
        if (Number(cleared[0]?.n ?? -1) >= 0) hostsRecovered.inc();
      }

      if (enrollmentId) await markRedeemed(c, enrollmentId, hostId);

      const schedulable = new Set(result.schedulable);
      const deviceIds: Record<string, string> = {};
      for (const d of reg.devices ?? []) {
        const { rows: dev } = await c.query(
          `INSERT INTO devices (host_id, region, platform, tier, model, os_version,
                                capabilities, local_id, state, automation_endpoint,
                                adb_serial, system_port, mjpeg_server_port, org_id,
                                profile, screen, abis)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,
                   $15,$16::jsonb,$17::jsonb)
           ON CONFLICT (host_id, local_id) WHERE local_id IS NOT NULL DO UPDATE SET
             capabilities = EXCLUDED.capabilities,
             -- Re-asserted every registration, exactly like model and os_version above. A device
             -- that was re-created from a different profile — or from none — is describing itself
             -- differently, and the last registration is the truth (ADR-0016).
             profile = EXCLUDED.profile,
             screen = EXCLUDED.screen,
             abis = EXCLUDED.abis,
             -- Inherited from the host, which is what keeps a device that cannot be powerwashed
             -- out of the shared pool. allocate_device already filters on
             -- (d.org_id IS NULL OR d.org_id = p_org), so this single column is the whole of
             -- org-pinning — no scheduler change, no policy to remember to apply.
             org_id = EXCLUDED.org_id,
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
             -- Schedulability is re-asserted, but ONLY between READY and OFFLINE.
             --
             -- Registration used to leave the state column alone entirely, which is right for the
             -- states it must never disturb — a re-registering agent must not yank a device out of
             -- SESSION_ACTIVE or hand back one still in CLEANING — but it made OFFLINE a trap.
             -- A device that registers OFFLINE because it is missing a required capability stays
             -- OFFLINE forever, even after it gains one. Found on the lab VM 2026-08-18: cf-2's
             -- first snapshot failed, so it registered unschedulable; the next run took the
             -- snapshot successfully and the control plane went on reporting OFFLINE.
             --
             -- The reverse direction matters just as much and is the same rule the automation
             -- endpoint follows two lines up: a device that has LOST a required capability must
             -- leave the pool rather than keep taking tenants.
             --
             -- QUARANTINED joins the recoverable set for exactly the reason OFFLINE did. The
             -- reaper now quarantines a host that stops beating, which is right — its devices must
             -- leave the pool — but without this line that is a ONE-WAY DOOR: the host comes back,
             -- re-registers, the host row returns to UP, and every device it owns stays
             -- QUARANTINED for the life of the database. A worker re-registering is the fleet's
             -- only evidence that a device is healthy again, so it has to be allowed to say so.
             --
             -- A device quarantined by quarantine_host REMEMBERS what it was doing, and CLEANING
             -- is the case that matters: it means a session ended and no worker has confirmed the
             -- reset, so promoting it to READY here hands the next tenant the last one's data —
             -- the exact leak CLEANING exists to prevent. Only clear_silence_quarantine brings
             -- those back, because only it restores quarantined_from instead of guessing.
             -- Rows predating migration 016 have a NULL there and keep registration as their
             -- recovery, exactly as 016 said they would.
             --
             -- AND A DEVICE-LEVEL QUARANTINE THAT A PERSON OR A HEALTH CHECK PUT THERE IS NOT
             -- REGISTRATION'S TO LIFT (migration 035). This is 016's rule about hosts, one level
             -- down: a re-registration is evidence the agent can SEE the device, which falsifies
             -- "its host stopped beating" and falsifies nothing at all about "this handset failed
             -- its health checks". Without this line, unplugging a quarantined phone and plugging
             -- it back in would silently return it to the allocation pool — the button ADR-0024
             -- exists to refuse, reachable by accident.
             state = CASE
               WHEN devices.state = 'QUARANTINED'
                    AND devices.quarantine_source IN ('operator', 'health')
                 THEN devices.state
               WHEN devices.state = 'QUARANTINED' AND devices.quarantined_from IS NOT NULL
                 THEN devices.state
               WHEN devices.state IN ('READY', 'OFFLINE', 'QUARANTINED') THEN EXCLUDED.state
               ELSE devices.state
             END,
             updated_at = now()
           RETURNING id`,
          [hostId, reg.region, d.platform, d.tier, d.model, d.osVersion,
           JSON.stringify(d.capabilities), d.localId,
           // A device that can reset by neither mechanism, or lacks persistent input, registers so
           // it stays visible and monitorable, but starts OFFLINE — it is never handed to a tenant.
           schedulable.has(d.localId) ? 'READY' : 'OFFLINE',
           // v1 workers name one server for the whole host; v2 names one per device. Resolved in
           // `packages/protocol` so the hub's COALESCE and this write cannot drift apart.
           deviceAutomationEndpoint(reg, d) ?? null,
           d.adbSerial ?? null, d.systemPort ?? null, d.mjpegServerPort ?? null, orgId,
           // NULL rather than an empty object or an empty array when a worker does not send these.
           // An N-1 worker sends none of the three, and "did not say" has to stay distinguishable
           // from "said none" — an empty `abis` would otherwise read as a device that can execute
           // nothing and block every install on it (ADR-0016).
           d.profile ?? null,
           d.screen ? JSON.stringify(d.screen) : null,
           d.abis ? JSON.stringify(d.abis) : null],
        );
        if (d.localId && dev[0]?.id) deviceIds[d.localId] = dev[0].id as string;
      }

      /**
       * DEVICES THIS HOST NO LONGER HAS — the other half of "the last registration is the truth".
       *
       * Every field above is re-asserted on each registration precisely so a worker cannot leave a
       * stale claim behind. The device SET was the one thing that was not: a host that registered
       * with two phones and came back with one left the second `READY` and counted as available,
       * forever, because nothing ever looked at what was missing.
       *
       * FOUND BY VERIFYING A DEPLOY, 2026-08-28. A laptop re-registered with no devices at all —
       * the phone was unplugged — and `/v1/devices` went on reporting `SM-S918B READY, available 1`.
       * A tenant allocating it would have got a session against a device the agent has no backend
       * for, which fails at the data plane rather than driving somebody's phone; the harm is a
       * broken scheduling promise and a device listed in a fleet that does not have it.
       *
       * It also quietly weakened ADR-0009 §2. Un-sharing a phone drains and re-registers WITHOUT
       * it, and that is the entire mechanism by which taking a device back is supposed to work —
       * so without this statement, "stop sharing" removed the device from the agent and left it
       * advertised by the control plane.
       *
       * THE SAME STATE RULES AS THE UPSERT, for the same reasons. Only `READY` and `QUARANTINED`
       * move: `SESSION_ACTIVE` must never be yanked out from under a live tenant, and `CLEANING`
       * means a reset nobody has confirmed — promoting or demoting it here would lose the one fact
       * that state exists to remember. `OFFLINE` is already where this is trying to get to.
       *
       * A TRANSIENT DISCOVERY FAILURE takes devices offline for one registration, and that is the
       * right trade rather than an accident: `chooseBackends` returns an empty list when adb cannot
       * be reached, so the fleet briefly says "this host has nothing" — which is TRUE, in the sense
       * that matters, because a device the agent cannot see is a device it cannot drive. The next
       * good registration brings it back, since the upsert above allows OFFLINE -> READY.
       */
      const present = (reg.devices ?? []).map((d) => d.localId).filter((x): x is string => Boolean(x));
      const { rowCount: withdrawn } = await c.query(
        `UPDATE devices
            SET state = 'OFFLINE', updated_at = now()
          WHERE host_id = $1
            AND state IN ('READY', 'QUARANTINED')
            -- The same exception the upsert makes, and for the same reason (migration 035). OFFLINE
            -- is the honest word for a phone that is not plugged in, but it is also allocatable-
            -- adjacent: the next good registration promotes OFFLINE straight back to READY. A
            -- quarantine a person or a health check put there would be laundered into availability
            -- by a cable being pulled and pushed back in. It stays QUARANTINED, which is also not
            -- allocatable, and which still says why.
            AND (state <> 'QUARANTINED' OR quarantine_source IS DISTINCT FROM 'operator')
            AND (state <> 'QUARANTINED' OR quarantine_source IS DISTINCT FROM 'health')
            AND NOT (local_id = ANY($2::text[]))`,
        [hostId, present],
      );
      if (withdrawn) {
        req.log.info({ hostId, withdrawn, present },
          'devices absent from this registration were taken out of the pool');
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

  /** Liveness, and the one regular chance the control plane has to hand a worker work to do. */
  app.post('/workers/heartbeat', async (req) => {
    const { hostId } = requireWorker(req);
    const { row, resets, actions } = await withSystem(async (c) => {
      const { rows } = await c.query(
        `UPDATE hosts SET last_heartbeat_at = now() WHERE id = $1
          RETURNING state, quarantine_source`,
        [hostId],
      );
      /**
       * A HEARTBEAT IS THE DISPROOF OF A SILENCE QUARANTINE, so it lifts it (migration 016).
       *
       * The reaper quarantines a host that stops beating, and until now the only thing that could
       * undo that was registration — which a healthy agent never performs, because its stored
       * capability fingerprint has not changed. A host reboot is enough to trigger it: the API
       * comes up first, reaps against a `last_heartbeat_at` from before the reboot, and the worker
       * that arrives two minutes later beats forever into a control plane holding `available: 0`.
       * Restarting the agent does not help. Deleting its state file by hand was the only exit.
       *
       * Only the reaper's own quarantine clears this way. An operator quarantine is a judgement
       * about a host that a packet from that host cannot answer, and `clear_silence_quarantine`
       * re-checks the source itself rather than trusting this branch — the branch exists to keep
       * the common beat down to one write, not to decide anything.
       */
      let state = rows[0]?.state as string | undefined;
      if (state === 'QUARANTINED' && rows[0]?.quarantine_source === 'reaper') {
        const { rows: cleared } = await c.query<{ n: number }>(
          'SELECT clear_silence_quarantine($1) AS n', [hostId],
        );
        const n = Number(cleared[0]?.n ?? -1);
        if (n >= 0) {
          state = 'UP';
          hostsRecovered.inc();
          req.log.warn({ hostId, devices: n }, 'host beat again — silence quarantine cleared');
        }
      }
      /**
       * WHAT THE HOST CAN DO RIGHT NOW — reconciled on every beat (2026-09-01).
       *
       * THE BUG THIS FIXES. The agent has always sent `capabilities` and a per-device automation
       * map on every heartbeat, and this handler read NONE of it: the body was parsed and thrown
       * away, and the only writer of `devices.capabilities` was registration. A healthy agent never
       * re-registers — `capabilityFingerprint()` is consulted in `start()` and nowhere else — so an
       * Appium that died stayed advertised until somebody restarted the agent.
       *
       * `setAutomationEndpoint()` says as much in its own comment: it changes "what the AGENT now
       * reports", and "nothing here reaches the control plane until the next registration". That
       * was true, and it is what made ADR-0003's guarantee stop at the agent boundary.
       *
       * The cost was measured on hardware. With Appium at zero processes for 26 seconds,
       * `GET /v1/devices` still reported `webdriver` on every device and `POST /session` ALLOCATED
       * one before failing with `automation_unreachable` — the exact sequence ADR-0003 exists to
       * prevent: "a device that claims what it cannot do fails at connect time, after a lease is
       * spent." Reproduced by `deploy/verify-failure.mjs --only=appium`.
       *
       * ---------------------------------------------------------------- what this does NOT do
       *
       * **It never touches `state`.** Registration owns that, with careful rules about which states
       * may be disturbed (never SESSION_ACTIVE, never CLEANING). A beat is a liveness signal, not a
       * scheduling decision; withdrawing the capability is enough to stop new allocations, because
       * `allocate_device` filters on `capabilities`.
       *
       * **It never withdraws on a missing field.** `devices` absent means an agent that predates
       * this, or a malformed body; `devices: {}` means an agent saying it serves no automation
       * anywhere. Treating the first as the second would strip `webdriver` from an entire fleet on
       * one bad deploy, which is a far worse failure than the one being fixed.
       *
       * **It is host-scoped**, like every other worker-facing query (migration 008). The worker
       * names its devices by LOCAL id and they are resolved against `(host_id, local_id)`, so a
       * worker cannot describe another host's hardware however it spells the name.
       */
      const beat = (req.body ?? {}) as { devices?: unknown };
      if (beat.devices && typeof beat.devices === 'object' && !Array.isArray(beat.devices)) {
        const serving = beat.devices as Record<string, unknown>;
        // Only the devices whose advertised automation actually disagrees with what is stored, so
        // the ordinary beat — six a minute, forever — costs one indexed read and no writes.
        await c.query(
          `UPDATE devices d
              SET automation_endpoint = w.endpoint,
                  capabilities = CASE
                    WHEN w.endpoint IS NULL
                      THEN (SELECT coalesce(jsonb_agg(cap), '[]'::jsonb)
                              FROM jsonb_array_elements(d.capabilities) cap
                             WHERE cap <> '"webdriver"'::jsonb)
                    WHEN d.capabilities @> '["webdriver"]'::jsonb THEN d.capabilities
                    ELSE d.capabilities || '["webdriver"]'::jsonb
                  END,
                  updated_at = now()
             FROM (SELECT key AS local_id, nullif(value, 'null'::jsonb) #>> '{}' AS endpoint
                     FROM jsonb_each($2::jsonb)) w
            WHERE d.host_id = $1
              AND d.local_id = w.local_id
              AND (d.automation_endpoint IS DISTINCT FROM w.endpoint
                   OR (w.endpoint IS NULL) = (d.capabilities @> '["webdriver"]'::jsonb))`,
          [hostId, JSON.stringify(serving)],
        );
        // A device this host owns that the beat did NOT mention is one the agent is no longer
        // fronting with an automation server. Registration expresses this by re-registering without
        // an endpoint; a running agent has no such moment, which is the half that was missing.
        await c.query(
          `UPDATE devices d
              SET automation_endpoint = NULL,
                  capabilities = (SELECT coalesce(jsonb_agg(cap), '[]'::jsonb)
                                    FROM jsonb_array_elements(d.capabilities) cap
                                   WHERE cap <> '"webdriver"'::jsonb),
                  updated_at = now()
            WHERE d.host_id = $1
              AND NOT (d.local_id = ANY($2::text[]))
              AND (d.automation_endpoint IS NOT NULL OR d.capabilities @> '["webdriver"]'::jsonb)`,
          [hostId, Object.keys(serving)],
        );
      }

      // The other half of the reset story. A device is parked in CLEANING when its session ends and
      // stays unallocatable until a worker confirms the restore — and before this existed, nothing
      // ever ASKED for one, so `Agent.resetAndRelease()` had no caller and every device left the
      // fleet after one session (HANDOFF.md issue 16).
      //
      // Scoped to the calling host, like every other worker-facing query: a worker must never learn
      // about, let alone be able to act on, another host's devices (migration 008's rule).
      // Re-sent on every beat until the state changes, which makes a missed or failed reset
      // self-healing and costs one indexed read per ten seconds.
      //
      // `session_id` rides along so the worker can attach evidence to the run that just finished.
      // A device in CLEANING is the ONLY universal "a session ended" signal a worker gets: the data
      // plane's beginSession/endSession pair fires only when a browser attaches, so a WebDriver or
      // CI session — the case artifacts matter most for — would otherwise never trigger a capture.
      //
      // Matched on the FENCE, not on the newest row. The fence is the device's allocation counter
      // and `sessions.fence` is a copy of it taken at allocation, so this names the session that
      // held this device at this reset — not whichever session happens to have ended most recently,
      // which on a busy device is a different run.
      //
      // PREPARING IS OFFERED TOO, AND FLAGGED (migration 035). A device an operator released from
      // quarantine recovers down THIS path rather than a parallel one: the reset a recovery needs
      // is the same reset a released session needs, and a second way to prepare a device would be a
      // second thing to keep correct. The flag is what changes on the way back — a recovery is
      // confirmed with a health result, not with the bare "done" an ordinary reset reports.
      const { rows: cleaning } = await c.query(
        `SELECT d.id, d.fence, d.state,
                (SELECT s.id FROM sessions s
                  WHERE s.device_id = d.id AND s.fence = d.fence
                  ORDER BY s.created_at DESC LIMIT 1) AS session_id
           FROM devices d
          WHERE d.host_id = $1 AND d.state IN ('CLEANING', 'PREPARING')
            -- ESCALATED DEVICES ARE NOT OFFERED (migration 032). The budget exists precisely so
            -- that this loop ends; leaving the offer in place while counting attempts against it
            -- would be a counter that observes an infinite retry rather than a bound on one.
            -- A PREPARING device always has this NULL: release zeroes the budget.
            AND d.reset_escalated_at IS NULL`,
        [hostId],
      );
      /**
       * App actions waiting for this host's devices (migrations 014 and 015).
       *
       * Four conditions, and dropping any one of them puts a tenant's app on someone else's device:
       *
       *   d.host_id = $1        a worker learns about, and can act on, only its own hardware.
       *   i.state = 'PENDING'   re-offered every beat until it finishes, so a missed or failed
       *                         install self-heals with no retry logic anywhere.
       *   s.state live          a session that has ended no longer holds the device; its queued
       *                         install must never be performed for whoever holds it now.
       *   d.fence = i.fence     the same guarantee against a device that was reclaimed and
       *                         reallocated while the install sat here. Fence beats state: the
       *                         session row can still read ACTIVE for the moment it takes the
       *                         reaper to notice, and the fence has already moved.
       *
       * LIMIT bounds the beat: a tenant that queues fifty installs must not make the heartbeat
       * response — a liveness signal — grow with its backlog. The rest arrive on the next beat.
       */
      const { rows: pending } = await c.query(
        // LEFT JOIN on the build, because `screenshot` names none. As an inner join this silently
        // returned nothing for every screenshot action — the row would stay PENDING, be re-offered
        // on every beat, and be swept as an orphan when the session ended, with no error anywhere.
        `SELECT i.id, i.kind, i.device_id, i.app_id, i.session_id, i.fence,
                a.sha256, a.size_bytes, a.package_name
           FROM app_actions i
           JOIN devices d         ON d.id = i.device_id
           JOIN sessions s        ON s.id = i.session_id
           LEFT JOIN app_builds a ON a.id = i.app_id
          WHERE d.host_id = $1
            AND i.state = 'PENDING'
            AND s.state IN ('ALLOCATING','ACTIVE')
            AND d.fence = i.fence
          ORDER BY i.requested_at
          LIMIT 10`,
        [hostId],
      );

      return {
        row: { ...rows[0], state },
        resets: cleaning.map((d: { id: string; fence: string | number; state: string;
                                   session_id: string | null }) => ({
          deviceId: d.id,
          fence: Number(d.fence),
          // Absent when no session matches the fence — a device reset by an operator, or one whose
          // session row was deleted. The worker skips capture rather than inventing a target. A
          // recovery is always in this case: `release_device_quarantine` bumps the fence, so no
          // session row matches and there is nothing of a tenant's left to collect.
          ...(d.session_id ? { sessionId: d.session_id } : {}),
          // Absent rather than `false` on the ordinary path, so an older agent's payload is byte
          // for byte what it was and a newer one reads a flag that only ever means one thing.
          ...(d.state === 'PREPARING' ? { recovery: true } : {}),
        })),
        actions: pending.map((i: Record<string, unknown>) => ({
          actionId: i.id as string,
          kind: i.kind as AppActionKind,
          deviceId: i.device_id as string,
          // The artifact a `screenshot` produces is filed against this session by the control
          // plane, host-scoped. A worker that inferred it from the device it holds would attach
          // evidence to the wrong tenant the moment a device changed hands mid-beat.
          sessionId: i.session_id as string,
          // Omitted rather than sent as null for a screenshot, so a worker reading `appId` gets
          // `undefined` and not the string "null" — the shape that bit ADR-0004's grant once.
          ...(i.app_id ? { appId: i.app_id as string } : {}),
          ...(i.package_name ? { packageName: i.package_name as string } : {}),
          fence: Number(i.fence),
          // Install only. Sent for every kind would be harmless, but a launch that carries a digest
          // invites a worker to think it may fetch one.
          ...(i.kind === 'install'
            ? { sha256: i.sha256 as string, sizeBytes: Number(i.size_bytes) }
            : {}),
        })),
      };
    });
    // Told on every beat so a host that was quarantined while partitioned learns it must drain.
    return { ok: true, hostState: row?.state ?? 'DOWN', resets, actions };
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
      /**
       * The outcome of a RECOVERY the control plane asked for (migration 035, ADR-0024).
       *
       * Separate from `resets` rather than an extra field on one, because the two carry different
       * evidence and earn different things. A `resets` entry says "the restore finished" and moves
       * a device from CLEANING to READY. A `recoveries` entry says "the restore finished AND here
       * is what the device then reported about itself", and only a healthy answer leaves
       * quarantine. Folding them together would make `ok` optional on the path where its absence
       * has to mean failure, which is the shape that produces an accidental promotion.
       */
      recoveries?: Array<{ deviceId: string; fence: number; ok: boolean; reason?: string;
                           health?: Record<string, unknown> }>;
      actions?: Array<{ actionId: string; ok: boolean; error?: string }>;
      // A data-plane client attached to this session. The worker is the only party that observes
      // it — the grant is verified offline, so nothing else on the network knows a viewer arrived.
      attaches?: Array<{ sessionId: string; fence: number }>;
      /**
       * Infrastructure and device-health failures the AGENT saw (spec §18, migration 024).
       *
       * Here rather than on a route of its own because this batch is already buffered and re-sent
       * on reconnect — and an incident is most worth having in exactly the window where the
       * connection was bad, which is when a fire-and-forget POST would be lost.
       */
      incidents?: Array<{ eventId: string; deviceId: string; sessionId?: string | null;
                          reason: string; detail?: string; occurredAt: string }>;
    };
  }>('/workers/events', async (req) => {
    const { hostId } = requireWorker(req);
    const { metering = [], resets = [], actions = [], attaches = [], incidents = [],
            recoveries = [] } = req.body ?? {};

    const meter = await ingest(
      hostId,
      metering.map((e) => ({
        eventId: e.eventId, sessionId: e.sessionId ?? null,
        deviceId: e.deviceId ?? null, kind: e.kind, quantity: e.quantity,
        occurredAt: new Date(e.occurredAt),
      })),
    );

    meteringEvents.inc({ outcome: 'recorded' }, meter.recorded);
    meteringEvents.inc({ outcome: 'duplicate' }, meter.duplicates);
    meteringEvents.inc({ outcome: 'rejected' }, meter.rejected);

    // Rejection means a host reported usage for a session that is not on it. That is either a bug in
    // the agent or a host reaching past its own hardware, and both need a human — a counter in a
    // response body nobody reads is not a signal. It is now also alerted on
    // (`MfarmMeteringRejected`), which is what makes this log line a detail rather than the signal.
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
      const accepted = await resetComplete(hostId, r.deviceId, r.fence);
      /**
       * A BARE RESET CONFIRMATION FOR A DEVICE THAT IS RECOVERING FAILS THE RECOVERY.
       *
       * `device_reset_complete` matches on `state = 'CLEANING'`, so this call already returns false
       * for a PREPARING device — and without what follows, that device would sit in PREPARING until
       * the reaper expired it and reported "the host did not confirm a recovery", which is untrue
       * and would send somebody looking at the network.
       *
       * It happens for exactly one reason: an agent older than the recovery gate, which performs
       * the reset it was offered and has no health result to send. Failing closed is the only
       * honest answer — the gate's whole claim is that a completed reset is not evidence a device
       * is fit — and the reason says what to do about it.
       *
       * Only on the rejected path, so the ordinary confirmation costs nothing extra.
       */
      if (!accepted) {
        const ended = await finishRecovery(
          hostId, r.deviceId, r.fence, false,
          'the host confirmed the reset but sent no health result — this agent predates the '
          + 'recovery gate and cannot complete a release',
        );
        if (ended) {
          deviceRecoveries.inc({ outcome: 'unverified' });
          req.log.warn({ hostId, deviceId: r.deviceId },
            'recovery rejected: the worker confirmed a reset with no health result');
        }
      }
      workerResets.inc({ accepted: String(accepted) });
      resetResults.push({ deviceId: r.deviceId, accepted });
    }

    /**
     * Recovery outcomes (migration 035).
     *
     * Host-scoped and fenced inside `finish_device_recovery`, exactly like the reset above and for
     * migration 008's reason: a worker names a device id, and without the host clause it could
     * promote another host's handset out of quarantine.
     *
     * `null` back means nothing matched — a stale fence, another host's device, or a recovery that
     * the reaper already expired. Reported as `accepted: false` rather than as an error, which is
     * the same contract every other outcome in this batch follows.
     */
    const recoveryResults = [];
    for (const r of recoveries) {
      const ended = await finishRecovery(
        hostId, r.deviceId, r.fence, r.ok === true, r.reason ?? null, r.health ?? null,
      );
      deviceRecoveries.inc({
        outcome: ended === 'READY' ? 'recovered' : ended === 'QUARANTINED' ? 'failed' : 'ignored',
      });
      if (ended === 'READY') {
        req.log.info({ hostId, deviceId: r.deviceId },
          'device recovered: reset completed and the health check passed — back in the pool');
      } else if (ended === 'QUARANTINED') {
        // Warn, not info. A device that was released by a person and could not come back is the
        // one outcome here somebody has to act on.
        req.log.warn({ hostId, deviceId: r.deviceId, reason: r.reason },
          'recovery failed: the device is quarantined again, carrying the new reason');
      }
      recoveryResults.push({
        deviceId: r.deviceId, accepted: ended !== null, ...(ended ? { state: ended } : {}),
      });
    }

    /**
     * App action outcomes.
     *
     * The `FROM devices` join is the whole security of this statement, and it is the same rule
     * migration 008 had to retrofit twice: a worker names an install id, and without the join it
     * could finish — or falsely fail — an install belonging to any host in the fleet. The host id
     * comes from the authenticated credential, never from the body.
     *
     * `state = 'PENDING'` makes it idempotent. A worker whose confirmation was lost re-sends on the
     * next flush; the second UPDATE matches nothing and reports `accepted: false`, which is the
     * truthful answer ("already recorded") rather than a second state transition.
     */
    /**
     * Attaches. Host-scoped inside `session_attach`, so a worker naming another host's session
     * changes nothing — same shape as the reset above and for the same reason (migration 008).
     *
     * `accepted: false` is the normal answer on a reconnect, because the session is already ACTIVE.
     * Nothing is logged for it: a viewer whose wifi dropped is not an event.
     */
    const attachResults = [];
    for (const a of attaches) {
      attachResults.push({ sessionId: a.sessionId, accepted: await sessionAttach(hostId, a.sessionId, a.fence) });
    }

    /**
     * Incidents (spec §18).
     *
     * `FROM devices d WHERE d.host_id = $1` is the whole security of this insert, exactly as it is
     * for resets and actions above: a worker names a device id, and without the join it could file
     * incidents against any device in the fleet — quietly poisoning another tenant's failure
     * reports, which is a worse outcome than most things a worker could forge, because it is
     * invisible. The org is taken from the device's row, never from the body (architecture rule 4).
     *
     * `ON CONFLICT (event_id) DO NOTHING` is what makes the re-send safe. The agent buffers these
     * and flushes on reconnect by design, so one pulled cable arriving thirty times is the expected
     * case, not the exceptional one.
     */
    const incidentResults = [];
    for (const i of incidents) {
      const cls = classifyReason(i.reason);
      // Refused here rather than left to the CHECK: the agent is a program we ship, so an unknown
      // reason means a newer worker against an older control plane. Ignore it the way an unknown
      // capability is ignored — one line, not a failed batch that would also drop the good rows.
      if (cls !== 'infrastructure' && cls !== 'device-health') {
        req.log.warn({ hostId, reason: i.reason }, 'incident with an unknown reason ignored');
        incidentResults.push({ eventId: i.eventId, accepted: false });
        continue;
      }
      const accepted = await withSystem(async (c) => {
        const res = await c.query(
          `INSERT INTO session_incidents
             (org_id, session_id, device_id, class, reason, detail, occurred_at, event_id)
           SELECT COALESCE(s.org_id, d.org_id), s.id, d.id, $4, $5, $6, $7, $8
             FROM devices d
             -- LEFT, and host-scoped on the session too: an incident with no session is the normal
             -- idle case, and a worker naming ANOTHER host's session must not attach to it. A plain
             -- join would silently drop every incident that happened outside a session.
             LEFT JOIN sessions s ON s.id = $3 AND s.device_id = d.id
            WHERE d.id = $2 AND d.host_id = $1
           ON CONFLICT (event_id) DO NOTHING
           RETURNING id`,
          [hostId, i.deviceId, i.sessionId ?? null, cls, i.reason,
           i.detail?.slice(0, 4000) ?? null, new Date(i.occurredAt), i.eventId],
        );
        return res.rowCount === 1;
      });
      /**
       * AN INCIDENT DURING A LIVE SESSION IS THE FARM RETRYING, AND THE USER MUST NOT PAY FOR IT
       * (migration 033).
       *
       * This is the case the accounting rule exists for, stated in the plan's own terms: adb
       * dropped, the emulator went unhealthy, the handset fell off its cable. The agent recovers and
       * the session carries on — one user request, still one user attempt, plus one `infra-retry`
       * that the farm absorbs. `record_infra_retry` closes the failed attempt and opens the next,
       * and because the new row is not `origin = 'user'` the user's count cannot move.
       *
       * ONLY FOR AN ACCEPTED INCIDENT, so the idempotent re-send that `ON CONFLICT DO NOTHING`
       * absorbs above does not open a retry per redelivery. The agent buffers and flushes on
       * reconnect by design — one pulled cable arriving thirty times is the expected case, and
       * thirty retries recorded for it would make the farm look far worse than it is.
       *
       * ONLY FOR AN INCIDENT WITH A SESSION. A device that goes unhealthy while idle disrupted
       * nobody's request, so there is no attempt to fail and nothing to retry.
       *
       * `device-health` maps to `device-failure` and `infrastructure` to `infrastructure-failure`:
       * 024's split is "the device itself went bad" versus "something around it did", which is the
       * same distinction, and reusing its vocabulary is what keeps one query able to span both
       * tables. Neither is ever a test failure — the farm cannot see one (spec §13).
       */
      if (accepted && i.sessionId) {
        /**
         * ON THE TIMELINE TOO (migration 030's `incident`, declared and written by nothing until
         * now).
         *
         * §18 gave the farm somewhere to record that a device went bad; §4.6 gave a reader
         * somewhere to see what happened to their execution; and the two were never joined, so a
         * run whose device dropped adb mid-session showed a timeline of
         * `device-allocated → session-active → session-ended` and nothing about the fault. That is
         * the shape §13 exists to prevent — an infrastructure failure that a tester reads as their
         * own test being flaky.
         *
         * The ORG comes from the device row, never from the worker's body, which is the same rule
         * the insert above follows (architecture rule 4). Only for an ACCEPTED incident, so the
         * agent's idempotent re-send after a partition does not draw the same fault thirty times.
         */
        const orgForEvent = await withSystem(async (c) => {
          const { rows } = await c.query(
            'SELECT COALESCE(s.org_id, d.org_id) AS org_id FROM devices d '
            + 'LEFT JOIN sessions s ON s.id = $2 AND s.device_id = d.id WHERE d.id = $1',
            [i.deviceId, i.sessionId],
          );
          return rows[0]?.org_id as string | undefined;
        });
        if (orgForEvent) {
          await recordSessionEvent(orgForEvent, i.sessionId, 'incident', {
            class: cls, reason: i.reason,
            ...(i.detail ? { detail: i.detail.slice(0, 500) } : {}),
          });
        }
        try {
          await recordInfraRetry(
            i.sessionId,
            cls === 'device-health' ? 'device-failure' : 'infrastructure-failure',
            i.reason,
          );
        } catch (err) {
          // Swallowed like the timeline's writes: an accounting row must not fail the heartbeat
          // that carries a farm's whole liveness signal. Error level, because a lost retry makes a
          // number wrong rather than a chart sparse.
          console.error(
            `[attempts] could not record the infra retry for session ${i.sessionId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      incidentResults.push({ eventId: i.eventId, accepted });
    }

    const actionResults = [];
    for (const r of actions) {
      const accepted = await withSystem(async (c) => {
        const res = await c.query(
          `UPDATE app_actions i
              SET state = CASE WHEN $3 THEN 'DONE'::app_action_state ELSE 'FAILED' END,
                  error = CASE WHEN $3 THEN NULL ELSE $4 END,
                  finished_at = now()
             FROM devices d
            WHERE d.id = i.device_id
              AND d.host_id = $1
              AND i.id = $2
              AND i.state = 'PENDING'`,
          [hostId, r.actionId, r.ok === true, (r.error ?? 'The worker reported a failure with no detail.').slice(0, 2000)],
        );
        return (res.rowCount ?? 0) > 0;
      });
      appActions.inc({ outcome: accepted ? (r.ok ? 'done' : 'failed') : 'ignored' });
      actionResults.push({ actionId: r.actionId, accepted });
    }

    return {
      meteringRecorded: meter.recorded,
      meteringDuplicates: meter.duplicates,
      meteringRejected: meter.rejected,
      resets: resetResults,
      recoveries: recoveryResults,
      actions: actionResults,
      attaches: attachResults,
      // Reported back so the agent can drop them from its buffer. `accepted: false` on a re-send is
      // the normal, correct answer — it means "already recorded", not "lost".
      incidents: incidentResults,
    };
  });
}
