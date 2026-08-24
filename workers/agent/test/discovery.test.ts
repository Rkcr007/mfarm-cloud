/**
 * USB discovery's pure decisions (ADR-0008, spec §6).
 *
 * These are parsing problems dressed as hardware problems, and every wrong answer here presents to
 * a person as "my phone is plugged in and MFARM cannot see it" — with nothing in the console, and
 * nothing in the log, saying why. So the tests are mostly about the states that are NOT `device`:
 * losing one of those to a misparse is indistinguishable from losing the phone.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseAdbDevices, localIdForSerial } from '../src/devices/discovery.ts';

describe('parseAdbDevices', () => {
  test('reads a plain usable device', () => {
    const out = parseAdbDevices('List of devices attached\n39121FDH2003VK\tdevice\n');
    assert.deepEqual(out.map((d) => [d.serial, d.state]), [['39121FDH2003VK', 'device']]);
    assert.equal(out[0].remedy, undefined, 'a usable device needs no instruction');
  });

  test('reads the -l descriptors without mistaking them for state', () => {
    const out = parseAdbDevices(
      'List of devices attached\n'
      + '39121FDH2003VK         device usb:1-1.4 product:tokay model:Pixel_9 device:tokay transport_id:3\n',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].state, 'device');
  });

  /**
   * THE ONE THAT MATTERS MOST. `no permissions` contains a space, and every naive parser —
   * `line.split(/\s+/)[1]` — reads it as `no` and classifies the device `unknown`. The person then
   * gets a generic "adb reported a state this agent does not recognise" instead of the udev-rules
   * instruction that is the actual fix.
   */
  test('reads "no permissions", space and all', () => {
    const out = parseAdbDevices(
      'List of devices attached\n'
      + '39121FDH2003VK\tno permissions (user in plugdev group; are your udev rules wrong?)\n',
    );
    assert.equal(out[0].state, 'no permissions');
    assert.match(out[0].remedy ?? '', /udev/i, 'and the remedy names the thing to fix');
  });

  test('reads unauthorized, and says to tap Allow', () => {
    const out = parseAdbDevices('List of devices attached\n39121FDH2003VK\tunauthorized\n');
    assert.equal(out[0].state, 'unauthorized');
    assert.match(out[0].remedy ?? '', /Allow USB debugging/i);
  });

  test('reads offline, and mentions the cable', () => {
    const out = parseAdbDevices('List of devices attached\nABC123\toffline\n');
    assert.equal(out[0].state, 'offline');
    assert.match(out[0].remedy ?? '', /cable/i);
  });

  test('ignores the header, blank lines and adb daemon chatter', () => {
    const out = parseAdbDevices(
      '* daemon not running; starting now at tcp:5037\n'
      + '* daemon started successfully\n'
      + 'List of devices attached\n'
      + '\n'
      + 'ABC123\tdevice\n'
      + '\n',
    );
    assert.deepEqual(out.map((d) => d.serial), ['ABC123']);
  });

  test('reads several devices in mixed states', () => {
    const out = parseAdbDevices(
      'List of devices attached\n'
      + 'AAA\tdevice\n'
      + 'BBB\tunauthorized\n'
      + 'CCC\toffline\n',
    );
    assert.deepEqual(out.map((d) => [d.serial, d.state]),
      [['AAA', 'device'], ['BBB', 'unauthorized'], ['CCC', 'offline']]);
  });

  test('an empty list is empty, not an error', () => {
    assert.deepEqual(parseAdbDevices('List of devices attached\n\n'), []);
  });
});

describe('localIdForSerial', () => {
  /**
   * The id is what the control plane, the metering rows and the gateway path use, so it has to
   * survive a replug and an agent restart. Deriving it from the serial is what makes that true;
   * an index would rename every phone the moment someone unplugged the first one.
   */
  test('is stable and derived from the serial', () => {
    assert.equal(localIdForSerial('39121FDH2003VK'), 'phone-39121FDH2003VK');
    assert.equal(localIdForSerial('39121FDH2003VK'), localIdForSerial('39121FDH2003VK'));
  });

  test('a wireless target does not put a colon in a url path segment', () => {
    const id = localIdForSerial('10.0.0.4:5555');
    assert.equal(id, 'phone-10-0-0-4-5555');
    assert.ok(!id.includes(':'), 'the gateway path must not need percent-encoding');
    assert.equal(encodeURIComponent(id), id, 'and must survive a round trip unchanged');
  });

  test('distinct serials stay distinct', () => {
    assert.notEqual(localIdForSerial('AAA'), localIdForSerial('BBB'));
  });
});
