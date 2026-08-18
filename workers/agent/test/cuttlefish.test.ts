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

import { CuttlefishDevice, findFleetInstance } from '../src/devices/cuttlefish.ts';

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
    assert.deepEqual(findFleetInstance(json, { adbSerial: '0.0.0.0:6520', localId: 'cf-1' }),
      { group: 'cvd_1', status: 'Running' });
  });

  test('finds an instance in the flat launch_cvd-era shape', () => {
    const json = JSON.stringify([
      { webrtc_device_id: 'cf-1', adb_serial: '0.0.0.0:6520', status: 'Starting' },
    ]);
    assert.deepEqual(findFleetInstance(json, { adbSerial: '0.0.0.0:6520', localId: 'cf-1' }),
      { group: undefined, status: 'Starting' });
  });

  test('matches on the webrtc device id when the serial differs', () => {
    const json = JSON.stringify({ groups: [{ group_name: 'g', instances: [{ webrtc_device_id: 'cf-1' }] }] });
    assert.equal(findFleetInstance(json, { adbSerial: 'nope', localId: 'cf-1' })?.group, 'g');
  });

  test('another device on the same host is not mistaken for this one', () => {
    const json = JSON.stringify({ groups: [{ group_name: 'g', instances: [{ adb_serial: '0.0.0.0:6521', instance_name: 'cf-2' }] }] });
    assert.equal(findFleetInstance(json, { adbSerial: '0.0.0.0:6520', localId: 'cf-1' }), undefined);
  });

  test('an unparseable or unrecognised document is undefined, never a throw', () => {
    // The caller cold boots on undefined, which is what it did before any of this existed — so a
    // shape change upstream costs 30 seconds, not a broken worker.
    assert.equal(findFleetInstance('not json at all', { adbSerial: 's', localId: 'l' }), undefined);
    assert.equal(findFleetInstance('{"something":"else"}', { adbSerial: 's', localId: 'l' }), undefined);
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
