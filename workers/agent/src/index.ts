import { cpus, hostname as osHostname, totalmem } from 'node:os';
import { Agent } from './agent.ts';
import { DataPlane } from './dataplane.ts';
import { createCuttlefishBackend, CuttlefishDevice } from './devices/cuttlefish.ts';
import { createAvdBackend } from './devices/avd.ts';
import type { DeviceBackend } from './device.ts';

/**
 * Worker agent entry point.
 *
 * Chooses Cuttlefish when the host can actually run it, and says plainly why it cannot when it
 * cannot — rather than silently degrading to the slower tier and leaving someone to wonder later
 * why latency is bad.
 */

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`${key} is required`);
  return v;
}

async function chooseBackends(): Promise<DeviceBackend[]> {
  const avail = await CuttlefishDevice.available();

  if (avail.ok) {
    const count = Number(process.env.CF_INSTANCES ?? 1);
    console.log(`[agent] Cuttlefish available — starting ${count} instance(s)`);
    return Array.from({ length: count }, (_, i) =>
      createCuttlefishBackend({
        localId: `cf-${i + 1}`,
        instanceNum: i + 1,
        imageDir: env('CF_IMAGE_DIR'),
        publicHost: process.env.PUBLIC_HOST,
        gpuMode: process.env.GPU_MODE === 'none' ? 'none' : 'guest_swiftshader',
      }),
    );
  }

  console.warn(`[agent] Cuttlefish unavailable: ${avail.reason}`);
  console.warn('[agent] falling back to the AVD tier — it cannot meet the 100ms target and has no WebRTC path');
  return [createAvdBackend({ avdName: env('AVD_NAME'), localId: 'avd-1' })];
}

async function main(): Promise<void> {
  const backends = await chooseBackends();

  const agent = new Agent({
    controlPlaneUrl: env('CONTROL_PLANE_URL', 'http://localhost:3000'),
    registrationToken: env('WORKER_REGISTRATION_TOKEN'),
    hostname: env('WORKER_HOSTNAME', osHostname()),
    region: env('REGION'),
    endpoint: env('PUBLIC_ENDPOINT'),
    devices: backends,
    cores: cpus().length,
    memoryMb: Math.round(totalmem() / 1_048_576),
  });

  // Devices come up before registration so the control plane never sees a host advertising
  // capacity it cannot actually serve.
  for (const b of backends) await b.control.start();

  const state = await agent.start();
  console.log(`[agent] registered as host ${state.hostId}`);

  const byUuid = new Map<string, DeviceBackend>();
  const dp = new DataPlane({
    agent,
    backends: new Map(backends.map((b) => [b.control.info.localId, b])),
    // A session token names a control-plane uuid; this host knows only local ids. The token is
    // signed, so its `did` claim is trustworthy and teaches the mapping on first use. With a single
    // device the mapping is unambiguous anyway.
    resolveDevice: (uuid) => byUuid.get(uuid) ?? (backends.length === 1 ? backends[0] : undefined),
  });

  const port = await dp.listen(Number(process.env.DATA_PLANE_PORT ?? 8080));
  console.log(`[agent] data plane listening on :${port}`);

  agent.startHeartbeat();
  agent.startMetering();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[agent] ${signal} — draining`);
    // Order matters: flush metering before killing devices, or the final seconds of every live
    // session are given away free.
    await agent.shutdown();
    await dp.close();
    for (const b of backends) await b.control.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e: Error) => {
  console.error('[agent] fatal:', e.message);
  process.exit(1);
});
