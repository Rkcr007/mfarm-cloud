/**
 * Cuttlefish backend tests.
 *
 * DATABASE-FREE and Linux-free, and the second one takes explaining. `CuttlefishDevice.available()`
 * is a hard platform check — Linux, /dev/kvm, cvd on PATH — so on a developer machine none of this
 * code could otherwise be executed at all, only read. Everything below therefore runs against:
 *
 *   - a `probe` seam that stands in for that environment check, and
 *   - real `cvd` and `adb` shell scripts on a temporary PATH, which record every argv they are
 *     handed and answer from a scripted fixture.
 *
 * The fakes are real child processes, so what is being asserted is the actual command line the real
 * binary would receive — flag order included, which matters here more than usual: cvd takes
 * selectors BEFORE the verb, and getting that wrong fails in a way that reads like a boot problem
 * (HANDOFF.md issue 11).
 *
 * What this CANNOT tell you: whether cvd agrees. The invocations were verified by hand on the lab
 * VM on 2026-08-18 (cvd 1.55.1, build 16102939) and these tests only keep them from drifting.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CuttlefishDevice, findFleetInstance, profileFlags } from '../src/devices/cuttlefish.ts';
import { DEVICE_PROFILES } from '../src/devices/profiles.ts';

/**
 * Stands in for `cvd` and `adb`.
 *
 * Appends its own argv to $FAKE_LOG (one line per call), then answers from $FAKE_DIR/<verb>.out if
 * that file exists, or exits 1 with $FAKE_DIR/<verb>.fail if THAT exists. The verb is the first
 * argument that is neither a flag nor the value of `-s`, so `cvd --group_name=g start --daemon` is
 * keyed on "start" and `adb -s 0.0.0.0:6520 shell …` on "shell", exactly as a reader would expect.
 */
const FAKE = `#!/bin/sh
name=$(basename "$0")
printf '%s %s\\n' "$name" "$*" >> "$FAKE_LOG"
verb=""
skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    -s) skip=1 ;;
    -*) ;;
    *) verb="$a"; break ;;
  esac
done
# A getprop is keyed on the PROPERTY as well as the verb, because one device answers several and
# they are not interchangeable: sys.boot_completed must say 1 while ro.product.cpu.abilist says
# something else entirely. Without this every getprop shares one answer, and scripting either one
# breaks the other. (No backticks in this comment -- the whole script is a JS template literal.)
prop=""
seen_getprop=0
for a in "$@"; do
  if [ "$seen_getprop" = 1 ]; then prop="$a"; break; fi
  [ "$a" = "getprop" ] && seen_getprop=1
done
if [ -n "$prop" ]; then
  if [ -f "$FAKE_DIR/$name.getprop.$prop.fail" ]; then
    cat "$FAKE_DIR/$name.getprop.$prop.fail" >&2
    exit 1
  fi
  if [ -f "$FAKE_DIR/$name.getprop.$prop.out" ]; then
    cat "$FAKE_DIR/$name.getprop.$prop.out"
    exit 0
  fi
fi
if [ -f "$FAKE_DIR/$name.$verb.fail" ]; then
  cat "$FAKE_DIR/$name.$verb.fail" >&2
  exit 1
fi
if [ -f "$FAKE_DIR/$name.$verb.out" ]; then
  cat "$FAKE_DIR/$name.$verb.out"
fi
exit 0
`;

let dir: string;
let bin: string;
let log: string;
let imageDir: string;
let snapshotDir: string;
let savedPath: string | undefined;

const ok = async () => ({ ok: true as const });

/** Scripted answer for `<tool> <verb>`. */
async function answer(tool: string, verb: string, stdout: string): Promise<void> {
  await writeFile(join(dir, `${tool}.${verb}.out`), stdout);
}
/** Scripted answer for `<tool> … getprop <prop>`, which beats the generic `shell` answer. */
async function answerProp(tool: string, prop: string, stdout: string): Promise<void> {
  await writeFile(join(dir, `${tool}.getprop.${prop}.out`), stdout);
}
async function failsProp(tool: string, prop: string, stderr = 'nope'): Promise<void> {
  await writeFile(join(dir, `${tool}.getprop.${prop}.fail`), stderr);
}
async function fails(tool: string, verb: string, stderr = 'nope'): Promise<void> {
  await writeFile(join(dir, `${tool}.${verb}.fail`), stderr);
}
async function calls(): Promise<string[]> {
  return (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
}
/** The one recorded call whose tool and verb match, or a failed assertion naming what was seen. */
async function callTo(tool: string, verb: string): Promise<string> {
  const all = await calls();
  const hit = all.find((c) => c.startsWith(`${tool} `) && c.split(/\s+/).includes(verb));
  assert.ok(hit, `no ${tool} ${verb} in:\n${all.join('\n')}`);
  return hit;
}

function device(overrides: Record<string, unknown> = {}) {
  return new CuttlefishDevice({
    localId: 'cf-1',
    instanceNum: 1,
    imageDir,
    snapshotDir,
    probe: ok,
    // The real default is 5 minutes. Nothing here needs to wait for a device that is never coming.
    bootTimeoutMs: 2_000,
    ...overrides,
  } as ConstructorParameters<typeof CuttlefishDevice>[0]);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cf-test-'));
  bin = join(dir, 'bin');
  log = join(dir, 'calls.log');
  imageDir = join(dir, 'image');
  snapshotDir = join(dir, 'snapshots', 'cf-1');
  await mkdir(bin, { recursive: true });
  await mkdir(imageDir, { recursive: true });
  for (const tool of ['cvd', 'adb']) {
    await writeFile(join(bin, tool), FAKE);
    await chmod(join(bin, tool), 0o755);
  }
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  process.env.FAKE_LOG = log;
  process.env.FAKE_DIR = dir;
  // Booted, unless a test says otherwise.
  await answer('adb', 'shell', '1');
});

afterEach(async () => {
  if (savedPath !== undefined) process.env.PATH = savedPath;
  delete process.env.FAKE_LOG;
  delete process.env.FAKE_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe('findFleetInstance', () => {
  test('finds an instance in the grouped shape, carrying the group name down', () => {
    const json = JSON.stringify({
      groups: [{
        group_name: 'cvd_1',
        instances: [
          { instance_name: 'cf-2', adb_serial: '0.0.0.0:6521', status: 'Running' },
          { instance_name: 'cf-1', adb_serial: '0.0.0.0:6520', status: 'Running' },
        ],
      }],
    });
    assert.deepEqual(findFleetInstance(json, { adbSerial: '0.0.0.0:6520', localId: 'cf-1', instanceNum: 1 }),
      { group: 'cvd_1', status: 'Running' });
  });

  test('finds an instance in the flat launch_cvd-era shape', () => {
    const json = JSON.stringify([
      { webrtc_device_id: 'cf-1', adb_serial: '0.0.0.0:6520', status: 'Starting' },
    ]);
    assert.deepEqual(findFleetInstance(json, { adbSerial: '0.0.0.0:6520', localId: 'cf-1', instanceNum: 1 }),
      { group: undefined, status: 'Starting' });
  });

  test('matches on the webrtc device id when the serial differs', () => {
    const json = JSON.stringify({ groups: [{ group_name: 'g', instances: [{ webrtc_device_id: 'cf-1' }] }] });
    assert.equal(findFleetInstance(json, { adbSerial: 'nope', localId: 'cf-1', instanceNum: 1 })?.group, 'g');
  });

  test('another device on the same host is not mistaken for this one', () => {
    const json = JSON.stringify({ groups: [{ group_name: 'g', instances: [{ adb_port: 6521, adb_serial: '0.0.0.0:6521', instance_name: '2' }] }] });
    assert.equal(findFleetInstance(json, { adbSerial: '0.0.0.0:6520', localId: 'cf-1', instanceNum: 1 }), undefined);
  });

  test('matches on the adb port after a restore has rewritten the webrtc device id', () => {
    // Exactly what a restored group looks like: the id it was created with is gone.
    const json = JSON.stringify({ groups: [{ group_name: 'cvd_1', instances: [
      { adb_port: 6520, instance_name: '1', status: 'Running', webrtc_device_id: 'cvd_1-1-1' },
    ] }] });
    assert.deepEqual(findFleetInstance(json, { adbSerial: '0.0.0.0:6520', localId: 'cf-1', instanceNum: 1 }),
      { group: 'cvd_1', status: 'Running' });
  });

  test('an unparseable or unrecognised document is undefined, never a throw', () => {
    // The caller cold boots on undefined, which is what it did before any of this existed — so a
    // shape change upstream costs 30 seconds, not a broken worker.
    assert.equal(findFleetInstance('not json at all', { adbSerial: 's', localId: 'l', instanceNum: 1 }), undefined);
    assert.equal(findFleetInstance('{"something":"else"}', { adbSerial: 's', localId: 'l', instanceNum: 1 }), undefined);
  });
});

describe('start() picks the cheapest correct route', () => {
  test('cold boots with the verified flags when cvd knows nothing', async () => {
    await answer('cvd', 'fleet', '[]');
    await answer('cvd', 'create', 'group:cvd_1|instance(s):1');
    const d = device();
    await d.start();

    const create = await callTo('cvd', 'create');
    assert.match(create, /--host_path=/);
    assert.match(create, /--product_path=/);
    assert.match(create, /--gpu_mode=guest_swiftshader/);
    assert.match(create, /--enable_virtiofs=false/);
    assert.match(create, /--daemon/);
    // start is the verb for an existing group only; a fresh host has none.
    assert.equal((await calls()).some((c) => /^cvd (?!fleet).*\bstart\b/.test(c)), false);
  });

  test('adopts a running group instead of creating a second one', async () => {
    await answer('cvd', 'fleet', JSON.stringify({
      groups: [{ group_name: 'cvd_1', instances: [{ adb_serial: '0.0.0.0:6520', status: 'Running' }] }],
    }));
    const d = device();
    await d.start();

    const all = await calls();
    assert.equal(all.some((c) => c.includes('create')), false, `should not create:\n${all.join('\n')}`);
    assert.equal(all.some((c) => c.startsWith('cvd ') && / start /.test(` ${c} `)), false);
  });

  test('restores a stopped group from its snapshot, selector before the verb', async () => {
    await answer('cvd', 'fleet', JSON.stringify({
      groups: [{ group_name: 'cvd_1', instances: [{ adb_serial: '0.0.0.0:6520', status: 'Stopped' }] }],
    }));
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(join(snapshotDir, 'snapshot.pb'), 'x');
    const d = device();
    await d.start();

    const start = await callTo('cvd', 'start');
    assert.equal(start, `cvd --group_name=cvd_1 start --snapshot_path=${snapshotDir} --daemon`);
    // The device configuration comes back out of the snapshot; passing these again is a documented
    // way to get a confusing failure.
    assert.doesNotMatch(start, /--gpu_mode/);
    assert.doesNotMatch(start, /--enable_virtiofs/);
    assert.equal((await calls()).some((c) => c.includes('create')), false);
  });

  test('restarts a stopped group with no snapshot rather than building a second one', async () => {
    await answer('cvd', 'fleet', JSON.stringify({
      groups: [{ group_name: 'cvd_1', instances: [{ adb_serial: '0.0.0.0:6520', status: 'Stopped' }] }],
    }));
    const d = device();
    await d.start();

    const start = await callTo('cvd', 'start');
    assert.equal(start, 'cvd --group_name=cvd_1 start --daemon');
    assert.equal((await calls()).some((c) => c.includes('create')), false);
  });

  test('a group that claims Running but does not answer adb is restarted, not adopted', async () => {
    await answer('cvd', 'fleet', JSON.stringify({
      groups: [{ group_name: 'cvd_1', instances: [{ adb_serial: '0.0.0.0:6520', status: 'Running' }] }],
    }));
    // cvd reported "Running" for a device crosvm never actually built — the exact shape of issue 12.
    await fails('adb', 'shell', 'device offline');
    const d = device();
    await assert.rejects(d.start(), /did not boot/);
    await callTo('cvd', 'start');
  });

  test('falls back to cvd fleet when create does not name the group', async () => {
    // cf-1 worked all day with an unparsed group name, because with one group cvd falls back to the
    // only one there is. cf-2 then failed its snapshot with "Multiple groups found". So a scrape
    // that comes back empty must be repaired before any later command needs a selector.
    await answer('cvd', 'fleet', JSON.stringify({
      groups: [
        { group_name: 'cvd_1', instances: [{ adb_serial: '0.0.0.0:6520' }] },
        { group_name: 'cvd_2', instances: [{ adb_serial: '0.0.0.0:6521', webrtc_device_id: 'cf-2' }] },
      ],
    }));
    await answer('cvd', 'create', 'nothing here matches the expected format');
    await mkdir(snapshotDir.replace('cf-1', 'cf-2'), { recursive: true });

    const d = new CuttlefishDevice({
      localId: 'cf-2', instanceNum: 2, imageDir,
      snapshotDir: snapshotDir.replace('cf-1', 'cf-2'),
      probe: ok, bootTimeoutMs: 2_000,
    });
    await d.start();
    await d.takeSnapshot();

    // Without the fallback this is a bare `cvd snapshot_take`, which cvd refuses outright on a host
    // running two groups.
    assert.match(await callTo('cvd', 'snapshot_take'), /^cvd --group_name=cvd_2 snapshot_take/);
  });

  test('refuses to start when the environment probe says no', async () => {
    const d = device({ probe: async () => ({ ok: false, reason: 'no /dev/kvm' }) });
    await assert.rejects(d.start(), /no \/dev\/kvm/);
    assert.deepEqual(await calls(), []);
  });
});

describe('snapshot-reset is claimed only when it is true', () => {
  test('a fresh device is not schedulable until its snapshot exists', async () => {
    const d = device({ snapshotDir: undefined });
    assert.equal(d.info.capabilities.includes('snapshot-reset'), false,
      'a device with nowhere to snapshot must not advertise reset — it would throw on release and ' +
      'strand itself in CLEANING');
  });

  test('the first boot takes a snapshot and only then advertises reset', async () => {
    await answer('cvd', 'fleet', '[]');
    await answer('cvd', 'create', 'group:cvd_1|instance(s):1');
    // The fake cvd cannot write a snapshot, so stand one up as the take would have.
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(join(snapshotDir, 'snapshot.pb'), 'x');

    const d = device();
    assert.equal(d.info.capabilities.includes('snapshot-reset'), false);
    await d.start();
    assert.equal(d.info.capabilities.includes('snapshot-reset'), true);
  });

  test('a failed snapshot leaves the device up and unschedulable, not the worker dead', async () => {
    await answer('cvd', 'fleet', '[]');
    await answer('cvd', 'create', 'group:cvd_1|instance(s):1');
    await fails('cvd', 'suspend', 'cannot suspend');

    const d = device();
    await d.start();  // must not throw
    assert.equal(d.info.capabilities.includes('snapshot-reset'), false,
      'no snapshot means the control plane must not schedule tenants here');
  });

  test('an empty snapshot directory does not count as a snapshot', async () => {
    // snapshot_take creates the directory before it fills it, so an empty one is the signature of a
    // take that failed. Restoring from it would fail during a tenant release instead of here.
    await answer('cvd', 'fleet', '[]');
    await answer('cvd', 'create', 'group:cvd_1|instance(s):1');
    await mkdir(snapshotDir, { recursive: true });
    await fails('cvd', 'suspend', 'cannot suspend');

    const d = device();
    await d.start();
    assert.equal(d.info.capabilities.includes('snapshot-reset'), false);
  });
});

describe('snapshot take and restore', () => {
  test('take is suspend -> snapshot_take -> resume, in that order', async () => {
    // A take on a running device is refused outright: "The device is not suspended".
    const d = device();
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(join(snapshotDir, 'snapshot.pb'), 'x');
    await d.takeSnapshot();

    const verbs = (await calls()).filter((c) => c.startsWith('cvd ')).map((c) => c.split(/\s+/).find((a) => !a.startsWith('--') && a !== 'cvd'));
    assert.deepEqual(verbs, ['suspend', 'snapshot_take', 'resume']);
  });

  test('a failed take still resumes the device', async () => {
    await fails('cvd', 'snapshot_take', 'out of disk');
    const d = device();
    await assert.rejects(d.takeSnapshot(), /out of disk/);
    // Otherwise the device is left suspended and every later health probe times out with nothing
    // explaining why.
    await callTo('cvd', 'resume');
  });

  test('reset stops then starts from the snapshot', async () => {
    const d = device();
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(join(snapshotDir, 'snapshot.pb'), 'x');
    await d.resetToSnapshot();

    const start = await callTo('cvd', 'start');
    assert.match(start, new RegExp(`start --snapshot_path=${snapshotDir} --daemon$`));
    await callTo('cvd', 'stop');
  });

  test('reset without a configured snapshot directory says so plainly', async () => {
    const d = device({ snapshotDir: undefined });
    await assert.rejects(d.resetToSnapshot(), /snapshot reset is unavailable/);
  });
});

/**
 * Powerwash mode (ADR-0007).
 *
 * The reason this mode exists is a measurement, not a preference: a snapshot-restored Cuttlefish
 * publishes no display, so a farm that recycles by restore has no live view at all. These tests
 * pin the two things that would silently undo that — resetting the wrong way, and dropping the
 * capability that keeps a device schedulable.
 */
describe('powerwash is a reset, and keeps the device schedulable', () => {
  test('reset powerwashes instead of restoring, and never touches the snapshot', async () => {
    const d = device({ resetMode: 'powerwash' });
    await d.resetToSnapshot();

    await callTo('cvd', 'powerwash');
    const verbs = (await calls()).filter((c) => c.startsWith('cvd ')).map((c) => c.split(/\s+/).find((a) => !a.startsWith('--') && a !== 'cvd'));
    assert.ok(!verbs.includes('start'), 'a powerwash is not a stop-and-start from a snapshot');
    assert.ok(!verbs.includes('snapshot_take'), 'nothing is snapshotted in this mode');
  });

  test('a device with NO snapshot on disk still declares snapshot-reset', async () => {
    // The capability's name says snapshot; what reads it (REQUIRED_FOR_TENANT_USE) means "can be
    // handed to a second tenant". Powerwash satisfies that, and withholding the capability would
    // make every device in this mode unschedulable for the sake of a word.
    const d = device({ resetMode: 'powerwash', snapshotDir: undefined });
    await d.start();
    assert.ok(d.info.capabilities.includes('snapshot-reset'));
  });

  test('a snapshot left on disk is IGNORED — the device cold boots instead of restoring', async () => {
    // The bug this pins: powerwash mode changed how a device is RESET and not how it BOOTS, so a
    // snapshot from before the mode was set was still restored on startup. The farm came up
    // restored, published no display, and the live view was gone — which is the one thing this
    // mode exists to prevent.
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(join(snapshotDir, 'snapshot.pb'), 'x');

    const d = device({ resetMode: 'powerwash' });
    await d.start();

    const started = (await calls()).filter((c) => c.startsWith('cvd ') && c.includes(' start'));
    for (const c of started) {
      assert.ok(!c.includes('--snapshot_path'), `booted from a snapshot in powerwash mode: ${c}`);
    }
  });

  test('start does no snapshot work at all in powerwash mode', async () => {
    const d = device({ resetMode: 'powerwash' });
    await d.start();
    const verbs = (await calls()).filter((c) => c.startsWith('cvd ')).map((c) => c.split(/\s+/).find((a) => !a.startsWith('--') && a !== 'cvd'));
    assert.ok(!verbs.includes('snapshot_take'), 'no 4 GB snapshot is taken for a path that never restores');
    assert.ok(!verbs.includes('suspend'), 'and the device is never suspended to take one');
  });
});

/**
 * cvd's instance database outlives the host, and a group that exists is not a group that works.
 * Both shapes were found on the lab VM on 2026-08-18, and both left the farm permanently
 * unschedulable with no human-visible cause beyond "no devices".
 */
describe('a group that exists but does not work is rebuilt, once', () => {
  const countOf = (all: string[], verb: string) =>
    all.filter((c) => c.startsWith('cvd ') && c.split(/\s+/).includes(verb)).length;

  test('a ghost group left by a host reboot is removed and cold booted', async () => {
    // What `cvd fleet` actually reports after the host reboots under a running farm: the group is
    // still recorded, with the start_time from before the reboot, and every process behind it gone.
    await answer('cvd', 'fleet', JSON.stringify({
      groups: [{ group_name: 'cvd_1', instances: [{ adb_port: 6520, instance_name: '1', status: 'Unreachable' }] }],
    }));
    // …and cvd refuses the restore path outright, which is what bricked the farm.
    await fails('cvd', 'start', 'Selected instance group is already started, use `cvd create` to create a new one.');
    await answer('cvd', 'create', 'group:cvd_9|instance(s):1');

    const d = device();
    await d.start();

    const all = await calls();
    assert.equal(countOf(all, 'rm'), 1, `should discard the ghost exactly once:\n${all.join('\n')}`);
    assert.match(await callTo('cvd', 'rm'), /--group_name=cvd_1 rm/);
    assert.equal(countOf(all, 'create'), 1, 'and cold boot exactly one replacement');
  });

  const fleetRunningAt = (instanceDir: string) => JSON.stringify({
    groups: [{
      group_name: 'cvd_1',
      instances: [{ adb_port: 6520, instance_name: '1', status: 'Running', instance_dir: instanceDir }],
    }],
  });

  test('an adopted group whose snapshot names a different HOME retakes it', async () => {
    // The drift this catches: the group was rebuilt while this agent was not running — by an
    // operator, a `cvd reset`, or an older build — so the adopt path finds a healthy device sitting
    // beside a snapshot that can no longer restore into it.
    await answer('cvd', 'fleet', fleetRunningAt('/var/tmp/cvd/1001/NEW/home/cuttlefish/instances/cvd-1'));
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(join(snapshotDir, 'snapshot.pb'), 'x');
    await writeFile(
      join(snapshotDir, 'snapshot_meta_info.json'),
      JSON.stringify({ HOME: '/var/tmp/cvd/1001/OLD/home' }),
    );

    const d = device();
    await d.start();

    const { readdir } = await import('node:fs/promises');
    assert.equal((await readdir(snapshotDir).catch(() => [] as string[])).includes('snapshot.pb'), false);
    await callTo('cvd', 'snapshot_take');
  });

  test('an adopted group whose snapshot matches is left alone', async () => {
    // The expensive false positive: a snapshot is ~4 GB and a needless retake suspends a device a
    // tenant could be using.
    await answer('cvd', 'fleet', fleetRunningAt('/var/tmp/cvd/1001/SAME/home/cuttlefish/instances/cvd-1'));
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(join(snapshotDir, 'snapshot.pb'), 'x');
    await writeFile(
      join(snapshotDir, 'snapshot_meta_info.json'),
      JSON.stringify({ HOME: '/var/tmp/cvd/1001/SAME/home' }),
    );

    const d = device();
    await d.start();

    const all = await calls();
    assert.equal(all.some((c) => c.includes('snapshot_take')), false, `must not retake:\n${all.join('\n')}`);
    assert.equal(d.info.capabilities.includes('snapshot-reset'), true);
  });

  test('metadata it cannot read is never treated as stale', async () => {
    // A snapshot is expensive and the shapes have changed across cvd versions; guessing destroys a
    // good one. Only a HOME actually read and compared may condemn a snapshot.
    await answer('cvd', 'fleet', fleetRunningAt('/var/tmp/cvd/1001/NEW/home/cuttlefish/instances/cvd-1'));
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(join(snapshotDir, 'snapshot.pb'), 'x');
    await writeFile(join(snapshotDir, 'snapshot_meta_info.json'), 'not json at all');

    const d = device();
    await d.start();

    const { readdir } = await import('node:fs/promises');
    assert.equal((await readdir(snapshotDir)).includes('snapshot.pb'), true);
  });

  test('a ghost group takes its stale snapshot down with it', async () => {
    // The trap this closes: bring-up succeeds, the device registers READY advertising
    // `snapshot-reset`, the first session runs green, and then EVERY reset fails, because the
    // snapshot pins the absolute HOME of the group that no longer exists. Seen on the lab VM.
    await answer('cvd', 'fleet', JSON.stringify({
      groups: [{ group_name: 'cvd_1', instances: [{ adb_port: 6520, instance_name: '1', status: 'Unreachable' }] }],
    }));
    await fails('cvd', 'start', 'Selected instance group is already started');
    await answer('cvd', 'create', 'group:cvd_9|instance(s):1');
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(join(snapshotDir, 'snapshot.pb'), 'taken under the group we are about to destroy');

    const d = device();
    await d.start();

    const { readdir } = await import('node:fs/promises');
    const left = await readdir(snapshotDir).catch(() => [] as string[]);
    assert.equal(left.includes('snapshot.pb'), false, 'the stale snapshot must not survive the rebuild');
    // …and a fresh one is taken against the group that now exists.
    await callTo('cvd', 'snapshot_take');
  });

  test('a restarted group that cannot snapshot is discarded and rebuilt', async () => {
    // Snapshot support is a boot-time property, so a group booted without it restarts, boots, and
    // answers adb while being permanently unable to suspend.
    await answer('cvd', 'fleet', JSON.stringify({
      groups: [{ group_name: 'cvd_1', instances: [{ adb_port: 6520, instance_name: '1', status: 'Stopped' }] }],
    }));
    await fails('cvd', 'suspend', 'LauncherResponse::kError');
    await answer('cvd', 'create', 'group:cvd_9|instance(s):1');

    const d = device();
    await d.start();

    const all = await calls();
    assert.equal(countOf(all, 'rm'), 1, `the unusable group must be discarded:\n${all.join('\n')}`);
    assert.equal(countOf(all, 'create'), 1, 'and replaced by a cold boot');
    // Bounded: the rebuild is attempted once, not until the host falls over.
    assert.equal(countOf(all, 'suspend'), 2, 'one snapshot attempt per group, and no more');
  });

  test('a freshly created group that cannot snapshot is NOT rebuilt', async () => {
    // The distinction the retry turns on: a group this agent just built and which still cannot
    // snapshot is a host problem — kernel, apparmor, disk — and rebuilding it is a boot loop that
    // hides the real cause.
    await answer('cvd', 'fleet', '[]');
    await answer('cvd', 'create', 'group:cvd_1|instance(s):1');
    await fails('cvd', 'suspend', 'LauncherResponse::kError');

    const d = device();
    await d.start();

    const all = await calls();
    assert.equal(countOf(all, 'rm'), 0, `nothing to discard on a fresh group:\n${all.join('\n')}`);
    assert.equal(countOf(all, 'create'), 1, 'and no second cold boot');
    assert.equal(d.info.capabilities.includes('snapshot-reset'), false, 'and it stays unschedulable');
  });

  test('a failed take leaves no directory behind to be mistaken for a snapshot', async () => {
    await answer('cvd', 'fleet', '[]');
    await answer('cvd', 'create', 'group:cvd_1|instance(s):1');
    await fails('cvd', 'snapshot_take', 'out of disk');

    const d = device();
    await d.start();

    // `snapshotOnDisk` reads any content as a usable snapshot, so a partial take advertised as
    // `snapshot-reset` would fail on a tenant's session rather than here.
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(snapshotDir).catch(() => []), []);
    assert.equal(d.info.capabilities.includes('snapshot-reset'), false);
  });
});

/**
 * Device profiles (ADR-0016).
 *
 * The first test is the important one, and it is a REGRESSION TEST FOR DEVICES THAT ARE NOT BEING
 * CHANGED. `cf-3` and `cf-4` join a host that is already serving `cf-1` and `cf-2`, and the whole
 * safety argument for doing that rests on one claim: a device with no profile is handed exactly the
 * command line it was handed before profiles existed. So that claim is asserted as a whole string
 * equality rather than a set of `assert.match` calls — a subset assertion cannot catch a flag ADDED
 * to the shared path, which is precisely the mistake that would re-boot the working pair into a
 * configuration nobody chose.
 */
describe('device profiles', () => {
  const UNPROFILED_CREATE = (image: string) => 'cvd create'
    + ` --host_path=${image}`
    + ` --product_path=${image}`
    + ' --instance_nums=1'
    + ' --start_webrtc=true'
    + ' --webrtc_device_id=cf-1'
    + ' --gpu_mode=guest_swiftshader'
    + ' --enable_virtiofs=false'
    + ' --report_anonymous_usage_stats=n'
    + ' --daemon';

  test('a device with NO profile cold boots exactly as it did before profiles existed', async () => {
    await answer('cvd', 'fleet', '[]');
    await answer('cvd', 'create', 'group:cvd_1|instance(s):1');

    const d = device();
    await d.start();

    // Whole-line equality on purpose. If this fails because a flag was added deliberately, the fix
    // is to update this string AND to understand that every unprofiled device on every existing
    // farm changes its boot configuration the next time it is created.
    assert.equal(await callTo('cvd', 'create'), UNPROFILED_CREATE(imageDir));
    assert.equal(d.info.model, 'cuttlefish');
    assert.deepEqual(d.info.screen, { width: 720, height: 1280, density: 320 });
    assert.equal(d.info.profile, undefined);
  });

  test('a profiled device carries its panel, memory and cores to cvd', async () => {
    await answer('cvd', 'fleet', '[]');
    await answer('cvd', 'create', 'group:cvd_1|instance(s):1');

    const d = device({ profile: DEVICE_PROFILES['galaxy-s25-ultra'] });
    await d.start();

    const create = await callTo('cvd', 'create');
    assert.match(create, /--display0=width=1080,height=2340,dpi=450,refresh_rate_hz=60/);
    assert.match(create, /--memory_mb=8192/);
    assert.match(create, /--cpus=4/);
    // The flags it shares with every other device are still there — a profile ADDS, it never
    // replaces, and a profiled device that lost --enable_virtiofs=false could never be snapshotted.
    assert.match(create, /--enable_virtiofs=false/);
    assert.match(create, /--daemon/);
  });

  test('a profiled device reports the profile it was built from', () => {
    const d = device({ profile: DEVICE_PROFILES['galaxy-s25'] });
    assert.equal(d.info.model, 'Samsung Galaxy S25');
    assert.deepEqual(d.info.screen, { width: 1080, height: 2340, density: 480 });
    assert.equal(d.info.profile, 'galaxy-s25');
  });

  test('ABIs are READ FROM THE GUEST, never assumed', async () => {
    // This was hard-coded to ['x86_64','x86'] and both entries were wrong — the real image reports
    // `x86_64,arm64-v8a`. The install preflight acts on this list, so a guess here refuses builds
    // the platform would have accepted. Asserted against a scripted getprop for that reason.
    await answer('cvd', 'fleet', '[]');
    await answer('cvd', 'create', 'group:cvd_1|instance(s):1');
    await answerProp('adb', 'ro.product.cpu.abilist', 'x86_64,arm64-v8a');

    const d = device();
    assert.equal(d.info.abis, undefined, 'nothing is claimed before the device has been asked');
    await d.start();
    assert.deepEqual(d.info.abis, ['x86_64', 'arm64-v8a']);
  });

  test('a device that cannot answer getprop claims no ABIs rather than none', async () => {
    // undefined and [] are read differently downstream: "nobody looked" blocks no install, while
    // "executes nothing" would block every one of them.
    await answer('cvd', 'fleet', '[]');
    await answer('cvd', 'create', 'group:cvd_1|instance(s):1');
    await failsProp('adb', 'ro.product.cpu.abilist', 'device offline');

    const d = device();
    await d.start().catch(() => {});
    assert.equal(d.info.abis, undefined);
  });

  test('profileFlags is empty without a profile', () => {
    // Stated on its own because it is the single fact cf-1 and cf-2 depend on.
    assert.deepEqual(profileFlags(undefined), []);
  });
});

/**
 * A profiled device's IDENTITY does not survive a wipe — measured, not assumed.
 *
 * `cvd powerwash` wipes the overlayfs the build properties live in, so a device that was a Galaxy
 * before the reset comes back a Cuttlefish. Geometry is unaffected, because that is a boot flag in
 * cvd's instance database rather than guest state. This farm resets by powerwash, so without
 * re-application the very first reset silently un-names every profiled device.
 */
describe('a reset re-establishes the device identity', () => {
  async function poweredWash(overrides: Record<string, unknown> = {}) {
    await answer('cvd', 'fleet', '[]');
    await answer('cvd', 'create', 'group:cvd_1|instance(s):1');
    const d = device({ resetMode: 'powerwash', ...overrides });
    await d.start();
    await d.resetToSnapshot();
    return d;
  }

  test('a profiled device rewrites its build properties after a powerwash', async () => {
    await answerProp('adb', 'ro.product.model', 'SM-S938B');
    await poweredWash({ profile: DEVICE_PROFILES['galaxy-s25-ultra'] });

    const all = await calls();
    // Joined, because the heredoc argument spans lines and the fake logs argv verbatim — so a
    // single `adb shell` call appears in the log as several lines.
    const log = all.join('\n');
    assert.match(log, /cat >> \/system\/build\.prop/, `no system write:\n${log}`);
    assert.match(log, /cat >> \/vendor\/build\.prop/, 'vendor properties go to the vendor partition');
    // The partition-scoped keys, not just the bare one — Android has DERIVED ro.product.model from
    // them since 10, so writing only the bare key looks like it worked and changes nothing.
    assert.match(log, /ro\.product\.vendor\.model=SM-S938B/, 'vendor-scoped model');
    assert.match(log, /ro\.product\.system\.model=SM-S938B/, 'system-scoped model');
    // remount is worthless until the device has rebooted, so the sequence has to include one.
    assert.match(log, /remount/, 'the overlay has to be enabled');
    assert.ok(all.filter((c) => /\breboot\b/.test(c)).length >= 2, 'one reboot for the overlay, one for the props');
  });

  test('an UNPROFILED device pays none of that cost', async () => {
    // cf-1 and cf-2 reset by powerwash several times a day. None of the above may run for them.
    await poweredWash();
    const all = await calls();
    assert.equal(all.some((c) => c.includes('build.prop')), false, `nothing written:\n${all.join('\n')}`);
    assert.equal(all.some((c) => c.includes('remount')), false, 'and no remount');
  });

  test('an identity that will not take is logged, not thrown — the device still works', async () => {
    // A device that resets but comes back named `cuttlefish` is wrong about its name and completely
    // serviceable. Failing the reset would pull a working device out of the pool over a property.
    await answerProp('adb', 'ro.product.model', 'Cuttlefish x86_64 phone 64-bit only');
    await assert.doesNotReject(poweredWash({ profile: DEVICE_PROFILES['galaxy-s25-ultra'] }));
  });
});

/**
 * A RESTART MUST NOT SILENTLY RESIZE A PROFILED DEVICE.
 *
 * Measured on hardware: `cvd start --daemon` brought cf-3 back at the image default 720x1280
 * instead of its profile's own panel, while the guest kept reporting itself as a Galaxy S25 Ultra.
 * A device that lies about its size is worse than one that never claimed a size, and this is the
 * path a host reboot takes.
 */
describe('a restart preserves the profile geometry', () => {
  async function restarted(overrides: Record<string, unknown> = {}) {
    // A group cvd knows about but that is not running: the restart path, not adopt and not create.
    await answer('cvd', 'fleet', JSON.stringify({
      groups: [{ group_name: 'cvd_1', instances: [{ adb_port: 6520, instance_name: '1', status: 'Stopped' }] }],
    }));
    const d = device({ resetMode: 'powerwash', ...overrides });
    await d.start();
    return d;
  }

  test('a profiled device restarts WITH its display, memory and cores', async () => {
    await restarted({ profile: DEVICE_PROFILES['galaxy-s25-ultra'] });
    const start = (await calls()).find((c) => /^cvd .*\bstart\b/.test(c) && !c.includes('fleet'));
    assert.ok(start, 'expected a restart');
    assert.match(start, /--display0=width=1080,height=2340,dpi=450/);
    assert.match(start, /--memory_mb=8192/);
    assert.match(start, /--cpus=4/);
  });

  test('an unprofiled device restarts exactly as it always did', async () => {
    await restarted();
    const start = (await calls()).find((c) => /^cvd .*\bstart\b/.test(c) && !c.includes('fleet'));
    assert.ok(start);
    assert.doesNotMatch(start, /--display0|--memory_mb|--cpus/, 'cf-1 and cf-2 gain no flags');
  });
});
