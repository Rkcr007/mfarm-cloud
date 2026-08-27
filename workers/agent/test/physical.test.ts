/**
 * What a handset TELLS the control plane about itself (ADR-0008).
 *
 * These are the values registration sends, and every one of them is a decision the scheduler acts
 * on without re-checking. The capability list especially: `negotiate()` reads it to decide whether
 * the device may take a tenant session at all, so a wrong entry here is either a phone that never
 * schedules (silent, and the failure ADR-0008 exists to prevent) or a dirty phone handed to
 * somebody (loud, and much worse).
 *
 * No adb is spawned by any of this — a constructor reads nothing from the device. That is the
 * point: this is the part that can be tested without a phone on the desk, so it is the part that
 * gets tested properly.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PhysicalDevice, createPhysicalBackend } from '../src/devices/physical.ts';

const opts = {
  serial: '39121FDH2003VK',
  localId: 'phone-39121FDH2003VK',
  model: 'Pixel 9',
  osVersion: '16',
  manufacturer: 'Google',
  sdkVersion: 36,
};

describe('what a physical device declares', () => {
  test('it is the physical tier, so the console can call it a real device', () => {
    assert.equal(new PhysicalDevice(opts).info.tier, 'physical');
  });

  /**
   * THE ONE THAT KEEPS A PHONE OUT OF THE SHARED POOL. `snapshot-reset` means "restores to a clean
   * image", which is what lets the allocator hand a device to a DIFFERENT org. A handset cannot do
   * that, and declaring it here to make scheduling work would leak one tenant's logins to the next.
   */
  test('it declares install-reset by default, and NEVER snapshot-reset', () => {
    // The default moved from `session-reset` to `install-reset` in ADR-0012: a release undoes what
    // the session installed rather than sweeping the owner's apps. The capability has to move with
    // it, because it is what the scheduler reads to decide the device can be handed on.
    const caps = new PhysicalDevice(opts).info.capabilities;
    assert.ok(caps.includes('install-reset'), 'without a reset it would never be schedulable');
    assert.ok(!caps.includes('session-reset'),
      'claiming the sweep while doing an install-scoped reset promises clean apps it does not deliver');
    assert.ok(!caps.includes('snapshot-reset'),
      'a phone cannot restore an image; claiming it would put it in the shared pool');
  });

  test('opting into the sweep declares session-reset instead', () => {
    const caps = new PhysicalDevice({ ...opts, resetMode: 'full-sweep' }).info.capabilities;
    assert.ok(caps.includes('session-reset'));
    assert.ok(!caps.includes('install-reset'), 'a device does one of these, never both');
  });

  /**
   * ADR-0008 refuses a screenshot-loop "stream" because it sets a false performance baseline that
   * survives into production. Until scrcpy-over-RTP is built and measured, the honest answer is no.
   */
  test('it does not claim to stream, and its media source agrees', async () => {
    const backend = createPhysicalBackend(opts);
    assert.ok(!backend.control.info.capabilities.includes('screen-stream'));
    assert.equal(await backend.media.endpoint(), null,
      'endpoint() and the capability list must say the same thing');
    assert.equal(backend.media.signal, undefined, 'and there is nothing to negotiate with');
  });

  test('it still offers a single frame, which is a different question from a stream', () => {
    const d = new PhysicalDevice(opts);
    assert.ok(d.info.capabilities.includes('screenshot'));
    assert.equal(typeof d.screenshot, 'function');
  });

  /**
   * B3: UiAutomator2 matches `appium:udid` against the ADB serial, not against our local id. A
   * device that does not publish one cannot serve WebDriver, and the hub refuses rather than
   * guessing — on a multi-device host a guess lands on another tenant's phone.
   */
  test('it publishes its adb serial, distinct from the local id', () => {
    const d = new PhysicalDevice(opts);
    assert.equal(d.info.adbSerial, '39121FDH2003VK');
    assert.notEqual(d.info.adbSerial, d.info.localId);
  });

  test('metadata it was given is what it reports', () => {
    const d = new PhysicalDevice(opts);
    assert.equal(d.info.model, 'Pixel 9');
    assert.equal(d.info.osVersion, '16');
  });

  /**
   * §4: "Do NOT assume every field is available on every device." An OEM that answers no getprop
   * must still enroll — with a usable screen geometry, because the console divides by it to turn a
   * click into a coordinate and zeroes would put every tap at the origin.
   */
  test('a device that reported nothing still enrolls with usable defaults', () => {
    const d = new PhysicalDevice({ serial: 'ABC123', localId: 'phone-ABC123' });
    assert.equal(d.info.model, 'ABC123', 'falls back to something identifying, never empty');
    assert.equal(d.info.osVersion, 'unknown');
    assert.ok(d.info.screen.width > 0 && d.info.screen.height > 0);
    assert.ok(d.info.screen.density > 0);
  });

  test('a real panel geometry is used when discovery read one', () => {
    const d = new PhysicalDevice({ ...opts, screen: { width: 1344, height: 2992, density: 480 } });
    assert.deepEqual(d.info.screen, { width: 1344, height: 2992, density: 480 });
  });

  /**
   * `stop()` must not power a phone off — the agent could never turn it back on, and the farm
   * would need someone to walk to the desk. Asserted through the interface rather than by reading
   * the source, so a future implementation that adds a shutdown fails here.
   */
  test('stopping a phone does not need it to have been started', async () => {
    const d = new PhysicalDevice(opts);
    await d.stop(); // no shell was ever opened; this must be a no-op, not a throw
  });
});
