/**
 * Device profile catalog (ADR-0017).
 *
 * Three things worth testing here, and none of them is "does the object literal have the fields I
 * typed".
 *
 *   1. The DENSITY ARITHMETIC. A profile exists to give a device a real dp geometry, because dp is
 *      what layout bugs are expressed in. A density that yields 512dp on a phone profile is not a
 *      cosmetic error — every layout result taken on that device is measuring the wrong device, and
 *      nothing else in the system would ever notice.
 *   2. `parseProfileAssignments`, which is the mechanism protecting the devices this feature is NOT
 *      supposed to touch. Its failure modes matter more than its success one.
 *   3. That a profile CONFIGURES AND DOES NOT CLAIM. ADR-0017 removed the guest build-property
 *      spoofing, and the test below is what stops it coming back by accident — a profile carrying a
 *      `props`-shaped field again is the regression, and it would otherwise be invisible.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DEVICE_PROFILES, parseProfileAssignments, profileById } from '../src/devices/profiles.ts';

/** Android's own conversion. What an app's layout is actually written against. */
const dp = (px: number, density: number) => (px * 160) / density;

describe('the catalog', () => {
  test('every profile is self-consistent and keyed by its own id', () => {
    for (const [key, p] of Object.entries(DEVICE_PROFILES)) {
      assert.equal(p.id, key, `${key} is filed under a different id than it reports`);
      assert.ok(p.model.length > 0, `${key} has no model`);
      assert.ok(p.screen.width > 0 && p.screen.height > 0 && p.screen.density > 0, `${key} has an impossible panel`);
      assert.ok(p.screen.height > p.screen.width, `${key} is landscape; profiles describe phones held upright`);
      assert.ok(p.memoryMb >= 2048, `${key} would not boot in ${p.memoryMb}MB`);
      assert.ok(p.cpus >= 1);
    }
  });

  test('each profile lands on a plausible phone dp width', () => {
    // The range a phone actually occupies. A profile outside it is either a tablet or an arithmetic
    // slip, and both produce layout results that describe a device nobody is shipping to.
    for (const [key, p] of Object.entries(DEVICE_PROFILES)) {
      const width = dp(p.screen.width, p.screen.density);
      assert.ok(width >= 320 && width <= 420, `${key} is ${width}dp wide, which is not a phone`);
    }
  });

  test('the two MFARM devices are the geometries they claim', () => {
    // Spelled out rather than derived, so a change to either number is a change a reviewer sees.
    // Same panel on both; DENSITY is the whole difference, and dp is what a layout can see.
    // QHD+ was measured off on SwiftShader — see the comment on the catalog.
    assert.equal(dp(DEVICE_PROFILES['mfarm-x1-pro'].screen.width, 450), 384);
    assert.equal(dp(DEVICE_PROFILES['mfarm-x1'].screen.width, 480), 360);
  });

  test('the two devices differ in dp, not merely in name', () => {
    // The trap this catches: giving both profiles the same density while changing the marketing
    // name. Two devices with the same dp width differ in NOTHING a layout can observe, so a farm
    // offering both would be offering the same test twice under two labels.
    const pro = DEVICE_PROFILES['mfarm-x1-pro'];
    const base = DEVICE_PROFILES['mfarm-x1'];
    assert.notEqual(
      dp(pro.screen.width, pro.screen.density),
      dp(base.screen.width, base.screen.density),
      'both MFARM devices present the same dp width, so one of them tests nothing new',
    );
  });

  test('a profile configures a device and makes no claim about its identity', () => {
    /**
     * ADR-0017, and the reason this assertion is worth a test of its own.
     *
     * Profiles used to carry a `props` map that wrote `ro.product.model = SM-S938B` and
     * `ro.product.manufacturer = samsung` into the guest. It was removed because it could not be
     * finished — a Samsung device is Samsung FIRMWARE, and an app branching on
     * `Build.MANUFACTURER === "samsung"` took a code path AOSP cannot answer — and because it cost
     * two reboots on every reset.
     *
     * Nothing in the type system prevents somebody adding it back, so this checks the SHAPE rather
     * than any particular key: a profile is geometry and capacity, and identity is not a field.
     */
    const allowed = new Set(['id', 'model', 'label', 'screen', 'diagonalIn', 'memoryMb', 'cpus']);
    for (const [key, p] of Object.entries(DEVICE_PROFILES)) {
      const extra = Object.keys(p).filter((k) => !allowed.has(k));
      assert.deepEqual(extra, [], `${key} carries ${extra.join(', ')} — a profile does not spoof guest state`);
    }
  });

  test('no device is named after a manufacturer this farm is not', () => {
    // The devices are MFARM's own (ADR-0017). This is a cheap guard against the rename being
    // half-done — one profile relabelled and the other left as a handset somebody else makes.
    for (const [key, p] of Object.entries(DEVICE_PROFILES)) {
      assert.match(p.model, /^MFARM /, `${key} is called "${p.model}", which is not an MFARM device`);
    }
  });
});

describe('parseProfileAssignments', () => {
  test('unset or empty assigns nothing', () => {
    // The state every existing farm is in. It must mean "change nothing", not "default everything".
    assert.equal(parseProfileAssignments(undefined).size, 0);
    assert.equal(parseProfileAssignments('').size, 0);
    assert.equal(parseProfileAssignments('   ').size, 0);
  });

  test('assigns only the local ids named, leaving every other device alone', () => {
    const m = parseProfileAssignments('cf-3=mfarm-x1-pro,cf-4=mfarm-x1');
    assert.equal(m.get('cf-3')?.model, 'MFARM X1 Pro');
    assert.equal(m.get('cf-4')?.model, 'MFARM X1');
    // The assertion this whole feature's safety rests on.
    assert.equal(m.get('cf-1'), undefined);
    assert.equal(m.get('cf-2'), undefined);
  });

  test('tolerates whitespace around the entries a human typed into a unit file', () => {
    const m = parseProfileAssignments(' cf-3 = mfarm-x1-pro , cf-4 = mfarm-x1 ');
    assert.equal(m.get('cf-3')?.id, 'mfarm-x1-pro');
    assert.equal(m.get('cf-4')?.id, 'mfarm-x1');
  });

  test('an unknown profile id throws, naming what it knows', () => {
    // Skipping it would boot the device at the default 720x1280 while everyone involved believed it
    // was an X1 Pro — a mismatch only discovered by someone puzzling over a screenshot later.
    assert.throws(() => parseProfileAssignments('cf-3=mfarm-x2-pro'), /unknown profile/);
    assert.throws(() => parseProfileAssignments('cf-3=mfarm-x2-pro'), /mfarm-x1-pro/);
  });

  test('the retired Samsung ids are not silently still accepted', () => {
    // A farm whose unit file still reads `cf-3=galaxy-s25-ultra` must FAIL LOUDLY at start rather
    // than boot the device unprofiled at 720x1280 while the console shows it as an X1 Pro.
    assert.throws(() => parseProfileAssignments('cf-3=galaxy-s25-ultra'), /unknown profile/);
    assert.throws(() => parseProfileAssignments('cf-4=galaxy-s25'), /unknown profile/);
  });

  test('a malformed entry throws rather than being silently dropped', () => {
    assert.throws(() => parseProfileAssignments('mfarm-x1-pro'), /is not <localId>=<profileId>/);
    assert.throws(() => parseProfileAssignments('=mfarm-x1'), /is not <localId>=<profileId>/);
  });
});

describe('profileById', () => {
  test('resolves a known id and is undefined for anything else', () => {
    assert.equal(profileById('mfarm-x1')?.model, 'MFARM X1');
    assert.equal(profileById(undefined), undefined);
    assert.equal(profileById('nope'), undefined);
  });
});
