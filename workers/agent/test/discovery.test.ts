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
import { parseAdbDevices, localIdForSerial, watchForChanges } from '../src/devices/discovery.ts';

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

  /**
   * THE LINE THAT BROKE IT, copied verbatim from `adb devices -l` on macOS 24.6 with
   * platform-tools 34.0.5 and a Samsung SM-S918B attached.
   *
   * Darwin prints the USB path as a bare `1-1`; Linux prints it as `usb:1-1`. Every test above uses
   * the Linux form, so the suite was fully green while no physical device could enroll on a Mac at
   * all — the state parsed as "device 1-1", matched nothing, and the phone was refused as being in
   * an unrecognised state. ADR-0009's gate is a stranger's laptop, and half of those are this one.
   */
  test('a bare USB path, as macOS prints it, is a descriptor and not part of the state', () => {
    const out = parseAdbDevices(
      'List of devices attached\n'
      + 'RZCX61ANKGE            device 1-1 product:dm3qxxx model:SM_S918B device:dm3q transport_id:1\n');
    assert.equal(out.length, 1);
    assert.equal(out[0].serial, 'RZCX61ANKGE');
    assert.equal(out[0].state, 'device');
    assert.equal(out[0].remedy, undefined, 'a usable device needs no remedy');
  });

  test('a bare USB path does not swallow a non-usable state either', () => {
    const out = parseAdbDevices(
      'List of devices attached\nRZCX61ANKGE            unauthorized 1-1 transport_id:1\n');
    assert.equal(out[0].state, 'unauthorized');
    assert.match(out[0].remedy ?? '', /Allow USB debugging/);
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

/**
 * The USB watch (spec §6).
 *
 * The failure this guards against is not "a phone was missed" — it is a RESTART LOOP. An arrival
 * drains and exits the agent, so anything that reports a spurious arrival takes the whole host
 * down every ten seconds, and it would do so only on a machine with a flaky cable: exactly the
 * machine nobody can easily debug.
 *
 * `discover()` shells out to adb, so these drive the comparison through a stubbed `adb devices`
 * rather than a real one. The subject is the change detection, not the parser — that is tested
 * above.
 */
describe('watchForChanges', () => {
  /** A scripted sequence of worlds — `adb devices` output, already parsed. */
  const worlds = (...states: string[][]) => {
    let i = 0;
    return async () => {
      const now = states[Math.min(i, states.length - 1)];
      i += 1;
      return now.map((serial) => ({ serial, state: 'device' as const }));
    };
  };

  /** Long enough for several ticks at the 10ms interval these use. */
  const settle = () => new Promise((r) => setTimeout(r, 120));

  test('a phone appearing is reported as added', async () => {
    const seen: Array<[string[], string[]]> = [];
    const w = watchForChanges(['AAA'], (a, r) => seen.push([a, r]), 10, worlds(['AAA'], ['AAA', 'BBB']));
    await settle();
    w.stop();
    assert.equal(seen.length, 1, 'exactly one arrival, however many times it was polled');
    assert.deepEqual(seen[0][0], ['BBB']);
    assert.deepEqual(seen[0][1], []);
  });

  test('a phone leaving is reported as removed', async () => {
    const seen: Array<[string[], string[]]> = [];
    const w = watchForChanges(['AAA', 'BBB'], (a, r) => seen.push([a, r]), 10, worlds(['AAA']));
    await settle();
    w.stop();
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0][1], ['BBB']);
    assert.deepEqual(seen[0][0], []);
  });

  /**
   * THE RESTART-LOOP TEST. An arrival drains and exits the agent, so a watch that re-reported a
   * steady fleet would take the host down every interval — and would do it only on the machine
   * with the flaky cable, which is the one nobody can easily debug.
   */
  test('an unchanged set never fires, however often it is polled', async () => {
    let calls = 0;
    const w = watchForChanges(['AAA'], () => { calls += 1; }, 10, worlds(['AAA']));
    await settle();
    w.stop();
    assert.equal(calls, 0);
  });

  /**
   * Tapping "Allow USB debugging" is the most common way a phone becomes usable, and it is a state
   * transition rather than a plug event — a watch built on plug events would miss it entirely.
   */
  test('unauthorized becoming device counts as an arrival', async () => {
    const seen: string[][] = [];
    let i = 0;
    const probe = async () => {
      const state = i++ === 0 ? 'unauthorized' as const : 'device' as const;
      return [{ serial: 'AAA', state }];
    };
    const w = watchForChanges([], (a) => seen.push(a), 10, probe);
    await settle();
    w.stop();
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], ['AAA']);
  });

  /** An unusable phone is not an arrival. Reporting one would restart the agent for nothing. */
  test('a phone that is merely plugged in is not an arrival', async () => {
    let calls = 0;
    const w = watchForChanges([], () => { calls += 1; }, 10,
      async () => [{ serial: 'AAA', state: 'unauthorized' as const }]);
    await settle();
    w.stop();
    assert.equal(calls, 0);
  });

  /**
   * A failing probe must not read as "every phone was unplugged". adb hiccups, and a transient
   * failure that reported the whole fleet gone would be acted on as real.
   */
  test('a probe that throws changes nothing', async () => {
    let calls = 0;
    const w = watchForChanges(['AAA'], () => { calls += 1; }, 10,
      async () => { throw new Error('adb server died'); });
    await settle();
    w.stop();
    assert.equal(calls, 0, 'a broken probe is not evidence of a fleet change');
  });

  /** And the baseline survives it: the phone is still known once the probe recovers. */
  test('the baseline survives a failed probe', async () => {
    const seen: Array<[string[], string[]]> = [];
    let i = 0;
    const probe = async () => {
      i += 1;
      if (i === 1) throw new Error('adb server died');
      return [{ serial: 'AAA', state: 'device' as const }];
    };
    const w = watchForChanges(['AAA'], (a, r) => seen.push([a, r]), 10, probe);
    await settle();
    w.stop();
    assert.deepEqual(seen, [], 'AAA was known before and is present after — nothing changed');
  });

  test('stop() means stop', async () => {
    let calls = 0;
    const w = watchForChanges(['AAA'], () => { calls += 1; }, 10, worlds(['AAA'], ['AAA', 'BBB']));
    w.stop();
    await settle();
    assert.equal(calls, 0);
  });
});
