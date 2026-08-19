/**
 * The operator client's two pure decisions (ADR-0007).
 *
 * Both are parsing problems dressed as connectivity problems, and both have a wrong answer that is
 * far worse than failing: connecting a viewer to a device that is not the one the session holds
 * shows one tenant another tenant's screen. So these tests are mostly about what the code REFUSES.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractDeviceIds, resolveDeviceId } from '../src/devices/operator.ts';

describe('operator device listing', () => {
  test('reads a flat array of ids', () => {
    assert.deepEqual(extractDeviceIds(['cvd-1', 'cvd-2']), ['cvd-1', 'cvd-2']);
  });

  test('reads an array of objects, whichever id field they use', () => {
    assert.deepEqual(
      extractDeviceIds([{ device_id: 'cvd-1' }, { deviceId: 'cvd-2' }, { id: 'cvd-3' }]),
      ['cvd-1', 'cvd-2', 'cvd-3'],
    );
  });

  test('reads a wrapped document', () => {
    assert.deepEqual(extractDeviceIds({ devices: [{ device_id: 'cf-1' }] }), ['cf-1']);
  });

  test('an unrecognisable document yields nothing rather than garbage', () => {
    // The caller turns an empty list into a refusal with a message naming the operator. Anything
    // this returns is treated as a device id, so inventing one here is how a viewer ends up
    // connected to something nobody asked for.
    assert.deepEqual(extractDeviceIds(42), []);
    assert.deepEqual(extractDeviceIds(null), []);
  });

  test('duplicates collapse', () => {
    assert.deepEqual(extractDeviceIds([{ id: 'cvd-1' }, 'cvd-1']), ['cvd-1']);
  });
});

describe('resolving which operator device is ours', () => {
  const match = { localId: 'cf-1', instanceNum: 1 };

  test('an exact local id wins', () => {
    assert.equal(resolveDeviceId(['cf-2', 'cf-1'], match), 'cf-1');
  });

  test('a sole device is unambiguous even under a name we did not choose', () => {
    // This is the snapshot-restore case: a group brought back with --snapshot_path loses the
    // --webrtc_device_id it was created with and re-registers as something like cvd_1-1-1.
    assert.equal(resolveDeviceId(['cvd_1-1-1'], match), 'cvd_1-1-1');
  });

  test('an instance-number suffix resolves a renamed device on a multi-device host', () => {
    assert.equal(resolveDeviceId(['cvd-1', 'cvd-2'], match), 'cvd-1');
    assert.equal(resolveDeviceId(['cvd-1', 'cvd-2'], { localId: 'cf-2', instanceNum: 2 }), 'cvd-2');
  });

  test('a digit that is only part of a larger number is not a match', () => {
    // '21' ends in 1 as a substring. Treating that as instance 1 is precisely the guess that lands
    // on the wrong device.
    assert.equal(resolveDeviceId(['cvd-21', 'cvd-31'], match), undefined);
  });

  test('two equally plausible candidates refuse rather than pick', () => {
    assert.equal(resolveDeviceId(['a-1', 'b-1'], match), undefined);
  });

  test('nothing listed resolves to nothing', () => {
    assert.equal(resolveDeviceId([], match), undefined);
  });
});
