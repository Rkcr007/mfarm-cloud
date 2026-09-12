/**
 * The sweep that turns a device's proxy on and off — ADR-0037's last hop.
 *
 * WHY THIS FILE EXISTS AT ALL. ADR-0037 shipped with `DeviceProxy` tested end to end over real
 * sockets and with no caller anywhere outside that test: nothing started a listener and nothing
 * ever told a guest to use one, so the feature could not work on a farm however green the suite
 * was. These tests are about the JOIN — that a beat naming a device produces a listener and a
 * setting on that device, and that a beat no longer naming it takes both away again.
 *
 * No control plane and no adb. `syncProxies` reads only the devices it was constructed with, which
 * is what makes the seam testable; what it does to them is asserted on a fake that records calls.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent.ts';
import type { ProxyFrame } from '@mfarm/protocol';
import type { DeviceBackend, DeviceControl, DeviceHealth, DeviceInfo } from '../src/device.ts';

/** A device that can be pointed at a proxy, and remembers every value it was pointed at. */
class ProxyableDevice implements DeviceControl {
  readonly info: DeviceInfo;
  readonly proxySet: Array<string | null> = [];
  /**
   * Loopback, because a test host has no cvd tap to bind. What is being asserted is that the
   * listener binds WHATEVER THE DEVICE ANSWERED WITH — on a farm that is the guest's own gateway,
   * and `cuttlefish.ts` is what reads it off the guest.
   */
  gateway: string | undefined = '127.0.0.1';
  failSet = false;

  constructor(localId: string) {
    this.info = {
      localId, platform: 'android', tier: 'cuttlefish', model: 'fake', osVersion: '17',
      capabilities: ['network-proxy'],
      screen: { width: 720, height: 1280, density: 320 },
      adbSerial: `0.0.0.0:adb-${localId}`,
    };
  }
  async proxyHost() { return this.gateway; }
  async setHttpProxy(v: string | null) {
    if (this.failSet) throw new Error('adb: device offline');
    this.proxySet.push(v);
  }
  async start() {}
  async stop() {}
  async resetToSnapshot() {}
  async tap() {}
  async swipe() {}
  async key() {}
  async text() {}
  async health(): Promise<DeviceHealth> { return { status: 'healthy', inputLatencyMs: 1 }; }
}

/** A device from a tier that has no `settings` to put — an iOS simulator, in shape. */
class UnproxyableDevice extends ProxyableDevice {
  constructor(localId: string) {
    super(localId);
    this.info.capabilities = [];
  }
  proxyHost = undefined as unknown as () => Promise<string | undefined>;
  setHttpProxy = undefined as unknown as (v: string | null) => Promise<void>;
}

const backend = (control: DeviceControl): DeviceBackend =>
  ({ control, media: { endpoint: async () => null } });

const agentWith = (...devices: DeviceControl[]) => new Agent({
  controlPlaneUrl: 'http://127.0.0.1:1', // never dialled: nothing here beats.
  registrationToken: 'unused',
  hostname: 'proxy-sweep-test',
  region: 'test',
  endpoint: 'ws://127.0.0.1:1',
  devices: devices.map(backend),
});

/** A transport that hands out channels and counts them, standing in for the agent tunnel. */
function fakeTransport() {
  const opened: string[] = [];
  return {
    opened,
    open(localId: string) {
      opened.push(localId);
      return { send(_f: ProxyFrame) {}, close() {} };
    },
  };
}

const live: Agent[] = [];
const make = (...devices: DeviceControl[]) => {
  const a = agentWith(...devices);
  live.push(a);
  return a;
};
afterEach(async () => {
  // Every listener closed between tests: these bind real ports, and a leaked one outlives the file.
  for (const a of live.splice(0)) await a.syncProxies([]);
});

describe('the device proxy sweep', () => {
  test('a device the beat names gets a listener and is pointed at it', async () => {
    const cf1 = new ProxyableDevice('cf-1');
    const agent = make(cf1);
    agent.attachProxyTransport(fakeTransport());

    await agent.syncProxies([{ deviceId: 'dev-1', localId: 'cf-1' }]);

    const proxied = agent.proxiedDevices();
    assert.ok(proxied['cf-1'], 'cf-1 should be proxied');
    // BOUND TO THE ADDRESS THE DEVICE ANSWERED WITH, not to loopback and not to the world: a
    // request arriving on this listener came from this device's own subnet, by construction.
    const [host, port] = proxied['cf-1'].split(':');
    assert.equal(host, '127.0.0.1', 'the listener binds the address the DEVICE named');
    assert.ok(Number(port) > 0, 'the OS should have assigned a real port');
    // The guest was pointed at exactly that listener — the one command ADR-0037 shipped without.
    assert.deepEqual(cf1.proxySet, [`127.0.0.1:${port}`]);
  });

  test('a device the beat stops naming has its setting cleared', async () => {
    const cf1 = new ProxyableDevice('cf-1');
    const agent = make(cf1);
    agent.attachProxyTransport(fakeTransport());

    await agent.syncProxies([{ deviceId: 'dev-1', localId: 'cf-1' }]);
    // A session ending IS the device no longer appearing. There is no teardown message to lose,
    // which is the whole reason this is a sweep over a desired set.
    await agent.syncProxies([]);

    assert.deepEqual(agent.proxiedDevices(), {});
    assert.equal(cf1.proxySet.at(-1), null, 'the guest must be un-pointed, not merely abandoned');
  });

  test('a repeated beat is idempotent — one listener, one setting', async () => {
    const cf1 = new ProxyableDevice('cf-1');
    const agent = make(cf1);
    agent.attachProxyTransport(fakeTransport());

    const want = [{ deviceId: 'dev-1', localId: 'cf-1' }];
    await agent.syncProxies(want);
    const first = agent.proxiedDevices()['cf-1'];
    await agent.syncProxies(want);
    await agent.syncProxies(want);

    assert.equal(agent.proxiedDevices()['cf-1'], first, 'the port must not move under a live session');
    assert.equal(cf1.proxySet.length, 1, 'a beat every 10s must not cost an adb call every 10s');
  });

  test('nothing is proxied before there is a tunnel to carry it', async () => {
    // A listener with nowhere to send a request answers every one of them 503, which in an app is
    // indistinguishable from the farm being broken. No listener at all is the honest state.
    const cf1 = new ProxyableDevice('cf-1');
    const agent = make(cf1);

    await agent.syncProxies([{ deviceId: 'dev-1', localId: 'cf-1' }]);

    assert.deepEqual(agent.proxiedDevices(), {});
    assert.deepEqual(cf1.proxySet, [], 'a guest must not be pointed at a port nothing is behind');
  });

  test('a device that cannot be pointed anywhere is skipped, not half-started', async () => {
    const sim = new UnproxyableDevice('sim-1');
    const agent = make(sim);
    agent.attachProxyTransport(fakeTransport());

    await agent.syncProxies([{ deviceId: 'dev-1', localId: 'sim-1' }]);

    assert.deepEqual(agent.proxiedDevices(), {});
  });

  test('a guest that answers no gateway gets no listener', async () => {
    const cf1 = new ProxyableDevice('cf-1');
    cf1.gateway = undefined;
    const agent = make(cf1);
    agent.attachProxyTransport(fakeTransport());

    await agent.syncProxies([{ deviceId: 'dev-1', localId: 'cf-1' }]);

    assert.deepEqual(agent.proxiedDevices(), {});
    assert.deepEqual(cf1.proxySet, []);
  });

  test('a device whose adb is wedged does not stop the sweep reaching the others', async () => {
    // The one that matters: the failing device is the one being turned ON, and the device being
    // turned OFF is the one holding a route into somebody's private network.
    const bad = new ProxyableDevice('cf-1');
    bad.failSet = true;
    const good = new ProxyableDevice('cf-2');
    const agent = make(bad, good);
    agent.attachProxyTransport(fakeTransport());

    await agent.syncProxies([{ deviceId: 'd1', localId: 'cf-1' }, { deviceId: 'd2', localId: 'cf-2' }]);

    assert.equal(agent.proxiedDevices()['cf-1'], undefined, 'a device that threw must not be recorded');
    assert.ok(agent.proxiedDevices()['cf-2'], 'the healthy device is still proxied');
  });

  test('a device the beat names and this host does not have is ignored', async () => {
    const agent = make(new ProxyableDevice('cf-1'));
    agent.attachProxyTransport(fakeTransport());
    await agent.syncProxies([{ deviceId: 'dev-9', localId: 'cf-9' }]);
    assert.deepEqual(agent.proxiedDevices(), {});
  });

  test('shutdown clears every guest, not just every listener', async () => {
    // The listener dies with the process; the SETTING is on the guest and does not. A device left
    // pointed at a dead port fails every request in the app rather than using the network it has.
    const cf1 = new ProxyableDevice('cf-1');
    const agent = make(cf1);
    agent.attachProxyTransport(fakeTransport());
    await agent.syncProxies([{ deviceId: 'dev-1', localId: 'cf-1' }]);

    await agent.shutdown();

    assert.deepEqual(agent.proxiedDevices(), {});
    assert.equal(cf1.proxySet.at(-1), null);
  });
});
