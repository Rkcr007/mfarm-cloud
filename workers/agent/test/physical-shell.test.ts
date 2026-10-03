/**
 * The held shell, across a phone that leaves and comes back — D61.
 *
 * `adb shell` dies with the connection. The handle used to stay in place looking open, so every
 * later command went down a dead pipe and timed out: a phone that had rebooted was `offline` until
 * the agent itself was restarted, which is why a returning phone was treated as a new arrival.
 *
 * A fake adb on disk, for the reason physical-reset.test.ts gives. Its held shell is a real `sh`
 * reading stdin, and it dies the way the real one does — when the phone is gone, on the next thing
 * sent to it.
 */
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let PhysicalDevice: typeof import('../src/devices/physical.ts').PhysicalDevice;

const unplug = () => writeFile(join(dir, 'gone'), '');
const replug = () => rm(join(dir, 'gone'), { force: true });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mfarm-shell-'));
  const adb = join(dir, 'adb');
  await writeFile(adb, `#!/bin/sh
# args: -s SERIAL shell [...]
shift 2
[ "$1" = shell ] || exit 0
shift
d="${dir}"
if [ $# -eq 0 ]; then
  [ -f "$d/gone" ] && exit 1
  while IFS= read -r line; do
    [ -f "$d/gone" ] && exit 1
    eval "$line" 2>/dev/null
  done
  exit 0
fi
[ -f "$d/gone" ] && { echo "adb: device 'FAKE' not found" >&2; exit 1; }
case "$*" in
  "getprop sys.boot_completed") echo 1 ;;
esac
exit 0
`);
  await chmod(adb, 0o755);
  process.env.ADB_PATH = adb;
  ({ PhysicalDevice } = await import('../src/devices/physical.ts'));
});

after(async () => { await rm(dir, { recursive: true, force: true }); });
beforeEach(replug);

describe('the held shell across a phone that leaves and returns', () => {
  test('a phone that is there is healthy', async () => {
    const p = new PhysicalDevice({ serial: 'FAKE', localId: 'phone-FAKE' });
    await p.start();
    assert.equal((await p.health()).status, 'healthy');
    await p.stop();
  });

  test('a phone that leaves is offline, and said so at once rather than after a timeout', async () => {
    const p = new PhysicalDevice({ serial: 'FAKE', localId: 'phone-FAKE' });
    await p.start();
    await unplug();
    const t0 = performance.now();
    const h = await p.health();
    assert.equal(h.status, 'offline');
    assert.ok(performance.now() - t0 < 2_000, 'a shell that has closed is not a slow phone');
    await p.stop();
  });

  /** THE DEFECT. Without a restart of the agent, this stayed offline for good. */
  test('and it is healthy again when it comes back, with nothing restarted', async () => {
    const p = new PhysicalDevice({ serial: 'FAKE', localId: 'phone-FAKE' });
    await p.start();
    await unplug();
    assert.equal((await p.health()).status, 'offline');
    assert.equal((await p.health()).status, 'offline', 'still gone: one attempt per check, no loop');
    await replug();
    assert.equal((await p.health()).status, 'healthy');
    await p.stop();
  });

  test('a phone never started is not quietly opened by a health check', async () => {
    const p = new PhysicalDevice({ serial: 'FAKE', localId: 'phone-FAKE' });
    assert.equal((await p.health()).status, 'offline');
  });

  test('stopping means stopped — a later check does not reopen it', async () => {
    const p = new PhysicalDevice({ serial: 'FAKE', localId: 'phone-FAKE' });
    await p.start();
    await p.stop();
    assert.equal((await p.health()).status, 'offline');
  });
});

/**
 * M4. Measured on the OnePlus's PIN-entry screen: `screencap` exits 1 on the device and `exec-out`
 * hands back zero bytes with exit 0. That is a refusal, not a broken device.
 */
describe('a screen that forbids capture', () => {
  test('zero bytes from screencap is a refusal, named as one', async () => {
    const { CaptureRefusedError } = await import('../src/devices/physical.ts');
    const p = new PhysicalDevice({ serial: 'FAKE', localId: 'phone-FAKE' });
    // This fake answers `exec-out` with nothing at all — what the secure screen produced.
    await assert.rejects(p.screenshot(), (e: Error) => {
      assert.ok(e instanceof CaptureRefusedError, `got ${e.name}: ${e.message}`);
      assert.match(e.message, /cannot be captured/);
      return true;
    });
  });
});
