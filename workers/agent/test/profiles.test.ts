/**
 * Device profile catalog (ADR-0016).
 *
 * Two things worth testing here, and neither is "does the object literal have the fields I typed".
 *
 *   1. The DENSITY ARITHMETIC. A profile exists to reproduce a real device's dp geometry, because dp
 *      is what layout bugs are expressed in. A density that yields 512dp on a phone profile is not a
 *      cosmetic error — every layout result taken on that device is measuring the wrong device, and
 *      nothing else in the system would ever notice.
 *   2. `parseProfileAssignments`, which is the mechanism protecting the devices this feature is NOT
 *      supposed to touch. Its failure modes matter more than its success one.
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

  test('the two Samsung profiles are the geometries they claim', () => {
    // Spelled out rather than derived, so a change to either number is a change a reviewer sees.
    assert.equal(dp(DEVICE_PROFILES['galaxy-s25-ultra'].screen.width, 600), 384);
    assert.equal(dp(DEVICE_PROFILES['galaxy-s25'].screen.width, 480), 360);
  });

  test('identity props are written for every partition Android composes model from', () => {
    // The mistake this catches: setting only the bare `ro.product.model`, which Android has derived
    // rather than read since 10 — so the edit appears to work, and getprop still says Cuttlefish.
    const p = DEVICE_PROFILES['galaxy-s25-ultra'];
    for (const part of ['system', 'system_ext', 'product', 'vendor', 'odm']) {
      assert.equal(p.props[`ro.product.${part}.model`], 'SM-S938B', `missing ${part} model`);
      assert.equal(p.props[`ro.product.${part}.manufacturer`], 'samsung', `missing ${part} manufacturer`);
    }
    assert.equal(p.props['ro.product.model'], 'SM-S938B', 'the legacy key is still read by older SDKs');
    assert.ok(p.props['ro.build.fingerprint'].startsWith('samsung/'));
  });

  test('no profile spoofs the OS version', () => {
    // Deliberate: telling an app it is on an Android it is not changes which API-level-conditional
    // branch it takes, so the app under test exercises code that never runs on the real device. An
    // obviously-wrong version string is a smaller lie than a silently-wrong code path.
    for (const [key, p] of Object.entries(DEVICE_PROFILES)) {
      const versionKeys = Object.keys(p.props).filter((k) => k.startsWith('ro.build.version.'));
      assert.deepEqual(versionKeys, [], `${key} sets ${versionKeys.join(', ')}`);
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
    const m = parseProfileAssignments('cf-3=galaxy-s25-ultra,cf-4=galaxy-s25');
    assert.equal(m.get('cf-3')?.model, 'Samsung Galaxy S25 Ultra');
    assert.equal(m.get('cf-4')?.model, 'Samsung Galaxy S25');
    // The assertion this whole feature's safety rests on.
    assert.equal(m.get('cf-1'), undefined);
    assert.equal(m.get('cf-2'), undefined);
  });

  test('tolerates whitespace around the entries a human typed into a unit file', () => {
    const m = parseProfileAssignments(' cf-3 = galaxy-s25-ultra , cf-4 = galaxy-s25 ');
    assert.equal(m.get('cf-3')?.id, 'galaxy-s25-ultra');
    assert.equal(m.get('cf-4')?.id, 'galaxy-s25');
  });

  test('an unknown profile id throws, naming what it knows', () => {
    // Skipping it would boot the device at the default 720x1280 while everyone involved believed it
    // was a Galaxy — a mismatch only discovered by someone puzzling over a screenshot later.
    assert.throws(() => parseProfileAssignments('cf-3=galaxy-s26-ultra'), /unknown profile/);
    assert.throws(() => parseProfileAssignments('cf-3=galaxy-s26-ultra'), /galaxy-s25-ultra/);
  });

  test('a malformed entry throws rather than being silently dropped', () => {
    assert.throws(() => parseProfileAssignments('galaxy-s25-ultra'), /is not <localId>=<profileId>/);
    assert.throws(() => parseProfileAssignments('=galaxy-s25'), /is not <localId>=<profileId>/);
  });
});

describe('profileById', () => {
  test('resolves a known id and is undefined for anything else', () => {
    assert.equal(profileById('galaxy-s25')?.model, 'Samsung Galaxy S25');
    assert.equal(profileById(undefined), undefined);
    assert.equal(profileById('nope'), undefined);
  });
});
