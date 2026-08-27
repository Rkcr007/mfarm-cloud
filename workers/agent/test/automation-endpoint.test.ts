import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  automationIsTunnelled, dataPlaneEndpoint, dataPlaneIsTunnelled, gatewayBase, tunnelEnabled,
} from '../src/automation-endpoint.ts';

/**
 * Which transport a host advertises for automation — ADR-0011's precedence rule.
 *
 * WHY THIS FILE EXISTS AS ITS OWN THING. The rule is four lines and it decides whether the running
 * farm keeps the direct path it was verified on or quietly moves onto a transport nothing has run
 * on hardware yet. That is exactly the kind of change that passes review and is discovered in
 * production, so the two deployments that exist — `mfarm-lab`, which sets an advertised host, and a
 * laptop, which cannot — are asserted by name.
 */

const VARS = [
  'AUTOMATION_ADVERTISE_BASE', 'APPIUM_ADVERTISE_HOST', 'PUBLIC_HOST', 'MFARM_TUNNEL', 'PUBLIC_ENDPOINT',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARS) { saved[v] = process.env[v]; delete process.env[v]; }
});
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe('what a host advertises its automation gateway as', () => {
  test('a laptop with nothing configured advertises the tunnel, and does not throw', () => {
    // The whole defect: this used to throw, so APPIUM_ENABLED=1 could not start on the machine
    // physical devices actually arrive on.
    assert.equal(gatewayBase(8090, 'phone-RZCX61ANKGE'), 'mfarm+tunnel:/automation/phone-RZCX61ANKGE');
    assert.equal(automationIsTunnelled(), true);
  });

  test('mfarm-lab keeps the direct path it was verified on', () => {
    // Exactly what deploy/install-worker-service.sh writes: BIND_HOST, the VPC address.
    process.env.APPIUM_ADVERTISE_HOST = '10.160.0.2';
    assert.equal(gatewayBase(8090, 'cf-1'), 'http://10.160.0.2:8090/automation/cf-1');
    assert.equal(automationIsTunnelled(), false);
  });

  test('PUBLIC_HOST is the same answer, one variable down', () => {
    process.env.PUBLIC_HOST = '10.160.0.2';
    assert.equal(gatewayBase(8090, 'cf-1'), 'http://10.160.0.2:8090/automation/cf-1');
  });

  test('an explicit base wins over an advertised host, and keeps its scheme and port', () => {
    process.env.AUTOMATION_ADVERTISE_BASE = 'https://worker-1.example:8443';
    process.env.APPIUM_ADVERTISE_HOST = '10.160.0.2';
    assert.equal(gatewayBase(8090, 'cf-1'), 'https://worker-1.example:8443/automation/cf-1');
    assert.equal(automationIsTunnelled(), false);
  });

  test('a trailing slash on the explicit base does not become a double slash', () => {
    process.env.AUTOMATION_ADVERTISE_BASE = 'https://worker-1.example:8443//';
    assert.equal(gatewayBase(8090, 'cf-1'), 'https://worker-1.example:8443/automation/cf-1');
  });

  test('a local id that needs encoding is encoded, on both transports', () => {
    // localId comes from operator configuration and reaches a url; nothing else validates it.
    assert.equal(gatewayBase(8090, 'a b/c'), 'mfarm+tunnel:/automation/a%20b%2Fc');
    process.env.APPIUM_ADVERTISE_HOST = 'w1';
    assert.equal(gatewayBase(8090, 'a b/c'), 'http://w1:8090/automation/a%20b%2Fc');
  });

  test('no name and no tunnel throws, rather than advertising 127.0.0.1', () => {
    process.env.MFARM_TUNNEL = '0';
    assert.equal(tunnelEnabled(), false);
    assert.throws(() => gatewayBase(8090, 'cf-1'), /needs somewhere to advertise/);
  });

  test('MFARM_TUNNEL=0 with an advertised host is still the direct path', () => {
    process.env.MFARM_TUNNEL = '0';
    process.env.APPIUM_ADVERTISE_HOST = '10.160.0.2';
    assert.equal(gatewayBase(8090, 'cf-1'), 'http://10.160.0.2:8090/automation/cf-1');
  });

  test('only MFARM_TUNNEL=0 exactly turns the tunnel off', () => {
    // The agent reads this the same way index.ts always has; a typo must not silently strip a
    // host's only route to the control plane.
    process.env.MFARM_TUNNEL = 'false';
    assert.equal(tunnelEnabled(), true);
    assert.equal(automationIsTunnelled(), true);
  });

  /**
   * The data plane's half of the same rule.
   *
   * `PUBLIC_ENDPOINT` was required with no default until phase 0, which is why an agent on a laptop
   * enrolled a phone, started Appium, advertised `mfarm+tunnel:` for automation — and then exited on
   * `PUBLIC_ENDPOINT is required`. The automation gap had been closed and its sibling had not.
   */
  test('a laptop with no public endpoint registers the tunnel rather than refusing to start', () => {
    assert.equal(dataPlaneEndpoint(), 'mfarm+tunnel:/dp');
    assert.equal(dataPlaneIsTunnelled(), true);
  });

  test('the existing farm keeps the direct address it was verified on', () => {
    // mfarm-lab, by name: install-worker-service.sh writes PUBLIC_ENDPOINT=ws://$BIND_HOST:8080.
    process.env.PUBLIC_ENDPOINT = 'ws://10.160.0.2:8080';
    assert.equal(dataPlaneEndpoint(), 'ws://10.160.0.2:8080');
    assert.equal(dataPlaneIsTunnelled(), false);
  });

  test('an explicit endpoint wins even with the tunnel on, and is never composed from PUBLIC_HOST', () => {
    process.env.PUBLIC_HOST = 'worker-1.example';
    assert.equal(dataPlaneEndpoint(), 'mfarm+tunnel:/dp');
    process.env.PUBLIC_ENDPOINT = 'ws://worker-1.example:8080';
    assert.equal(dataPlaneEndpoint(), 'ws://worker-1.example:8080');
  });

  test('no endpoint and no tunnel throws, rather than registering 127.0.0.1', () => {
    process.env.MFARM_TUNNEL = '0';
    assert.throws(() => dataPlaneEndpoint(), /nowhere to reach this host's data plane/);
    assert.equal(dataPlaneIsTunnelled(), false);
  });

  test('a whitespace-only PUBLIC_ENDPOINT is not an address', () => {
    // `env()` accepted '   ' as a value, so this used to register a blank endpoint and fail every
    // session with "no data-plane endpoint" against a host that looked configured.
    process.env.PUBLIC_ENDPOINT = '   ';
    assert.equal(dataPlaneEndpoint(), 'mfarm+tunnel:/dp');
    assert.equal(dataPlaneIsTunnelled(), true);
  });
});
