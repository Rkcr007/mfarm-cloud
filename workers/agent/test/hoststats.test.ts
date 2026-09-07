/**
 * What the host itself is doing — measured, not guessed.
 *
 * Every assertion here is about the difference between "fine" and "cannot see", because that is the
 * whole family of failures this module can have. A stats reader that answers 0 for an unreadable
 * disk publishes the most alarming possible number about a machine it never looked at; one that
 * answers a large number publishes the most reassuring. Null is the only honest third option, and
 * the control plane stores it as null.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHostStats } from '../src/hoststats.ts';

describe('readHostStats', () => {
  test('measures the filesystem the path is on', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mfarm-hoststats-'));
    try {
      const s = await readHostStats(dir);
      assert.ok(s.diskTotalBytes! > 0, 'a real directory must report a real size');
      assert.ok(s.diskFreeBytes! >= 0);
      // The one relationship that must hold whatever the platform: you cannot have more free than
      // there is. A `bsize`/`bavail` mix-up — the easy mistake here — breaks exactly this.
      assert.ok(s.diskFreeBytes! <= s.diskTotalBytes!,
        `free ${s.diskFreeBytes} exceeds total ${s.diskTotalBytes}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * A path that does not exist is the ORDINARY case on a first boot, before the agent has written
   * anything. It must not throw — a stats read that can fail the heartbeat would trade a metric for
   * the liveness signal that keeps the host in service.
   */
  test('an unreadable path reports null disk, and does not throw', async () => {
    const s = await readHostStats('/definitely/not/a/real/path/mfarm');
    assert.equal(s.diskFreeBytes, null);
    assert.equal(s.diskTotalBytes, null);
    // The rest of the machine is still measurable, and is still measured.
    assert.ok(s.cores! > 0, 'a failed statfs must not zero the other fields');
  });

  test('reports a load average and a core count to normalise it against', async () => {
    const s = await readHostStats(tmpdir());
    assert.ok(s.load1 !== null && s.load1 >= 0, `load1 was ${s.load1}`);
    assert.ok(s.cores! > 0);
  });

  /**
   * MEMORY IS LINUX-ONLY AND SAYS SO. `os.freemem()` is `MemFree`, which excludes the page cache
   * and reads as almost nothing on a healthy long-running Linux box — alerting on it would page
   * constantly and then be silenced. `MemAvailable` is the kernel's own estimate of what a new
   * allocation could get.
   *
   * On a platform with no `/proc/meminfo` this is null rather than a substitute, so a developer's
   * macOS box never publishes a number that means something different from production's under the
   * same metric name.
   */
  test('memory is MemAvailable on Linux and null everywhere else', async () => {
    const s = await readHostStats(tmpdir());
    if (process.platform === 'linux') {
      assert.ok(s.memTotalMb! > 0, 'Linux must report MemTotal');
      assert.ok(s.memAvailableMb! >= 0);
      assert.ok(s.memAvailableMb! <= s.memTotalMb!);
    } else {
      assert.equal(s.memAvailableMb, null, 'no /proc means no number, not a substitute');
      assert.equal(s.memTotalMb, null);
    }
  });

  test('every field is null-or-number, never undefined', async () => {
    const s = await readHostStats(tmpdir());
    for (const [k, v] of Object.entries(s)) {
      assert.ok(v === null || typeof v === 'number', `${k} was ${typeof v}`);
    }
  });
});
