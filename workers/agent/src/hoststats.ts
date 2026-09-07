/**
 * What the host itself is doing — S7.4.
 *
 * WHY THIS EXISTS. Every number on the MFARM dashboard is sampled from Postgres by the control
 * plane: devices by state, sessions by state, queue depth, host heartbeat age. All of them describe
 * the FLEET. Nothing describes the MACHINE — and the machine is what runs out of disk.
 *
 * The roadmap's S7 row used to claim queue depth and capacity were unobservable. They are not; they
 * have been graphed and alerted for weeks. This is the gap that is actually there, and two things
 * make it worth closing now:
 *
 *   * a device host fills its disk. Four Cuttlefish instances, a 4 GB snapshot each, an app cache
 *     that `fetchApk` never prunes, and logcat dumps. When it fills, devices fail to reset and the
 *     farm degrades in a way that looks like a device problem for as long as it takes somebody to
 *     ssh in and run `df`.
 *   * `docs/RENDER_BASELINE.md` and the encode measurement in `EXECUTION_ROADMAP.md` S5 both landed
 *     on the same conclusion: on this farm the HOST's CPU is the binding constraint. A farm whose
 *     limiting resource is invisible is a farm nobody can size.
 *
 * NULL IS A REAL ANSWER AND IS NEVER REPLACED BY A GUESS. Each field is null when it could not be
 * measured — a platform without `/proc`, a path that does not exist, a `statfs` that failed — and
 * the control plane stores the null. "We cannot see the disk" and "the disk is fine" are different
 * incidents, which is the same rule `mfarm_backup_age_seconds` follows with -1.
 */
import { statfs } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { loadavg, cpus } from 'node:os';

export interface HostStats {
  /** Bytes available to an ordinary user on the filesystem holding the agent's working files. */
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  /** One-minute load average. Meaningless without a core count, which `hosts.cores` already holds. */
  load1: number | null;
  /** Cores as the KERNEL sees them, so a load average can be normalised against the right number. */
  cores: number | null;
  /**
   * Linux `MemAvailable`, in MiB — NOT `os.freemem()`.
   *
   * `os.freemem()` is `MemFree`, which excludes the page cache and therefore reads as almost zero
   * on any long-running Linux box that is perfectly healthy. Alerting on it would page constantly
   * and then be turned off. `MemAvailable` is the kernel's own estimate of what a new allocation
   * could actually get, which is the question being asked.
   */
  memAvailableMb: number | null;
  memTotalMb: number | null;
}

const EMPTY: HostStats = {
  diskFreeBytes: null, diskTotalBytes: null, load1: null,
  cores: null, memAvailableMb: null, memTotalMb: null,
};

/**
 * `MemAvailable` and `MemTotal` out of `/proc/meminfo`.
 *
 * Absent everywhere but Linux, and that is reported as null rather than substituted from
 * `os.freemem()`. A macOS developer box would otherwise publish a number that means something
 * different from the one production publishes under the same metric name, which is worse than
 * publishing nothing.
 */
async function readMeminfo(): Promise<{ availableMb: number | null; totalMb: number | null }> {
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const kb = (key: string): number | null => {
      // The unit is asserted rather than assumed. Every field in /proc/meminfo is kB today; a value
      // parsed without checking would silently become a 1024x error if that ever stopped being true.
      const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm').exec(text);
      return m ? Number(m[1]) : null;
    };
    const a = kb('MemAvailable');
    const t = kb('MemTotal');
    return {
      availableMb: a === null ? null : Math.round(a / 1024),
      totalMb: t === null ? null : Math.round(t / 1024),
    };
  } catch {
    return { availableMb: null, totalMb: null };
  }
}

/**
 * Measure the machine. Never throws, and never reports a zero it did not measure.
 *
 * `path` names the filesystem worth watching — the agent's own working directory, which on a device
 * host is the same volume as the cvd images, the snapshots and the app cache. One number, for the
 * disk that fills.
 *
 * `bavail`, not `bfree`: the difference is the root reserve, and a farm's agent does not run as
 * root. Reporting `bfree` would say there is space right up until writes start failing.
 */
export async function readHostStats(path: string): Promise<HostStats> {
  const stats: HostStats = { ...EMPTY };

  try {
    const fs = await statfs(path);
    stats.diskFreeBytes = Number(fs.bavail) * Number(fs.bsize);
    stats.diskTotalBytes = Number(fs.blocks) * Number(fs.bsize);
  } catch {
    // Left null. A path that does not exist yet is the ordinary case on a first boot.
  }

  try {
    const [one] = loadavg();
    // 0 is a legitimate load average and must survive; only a platform that does not implement it
    // (where node returns exactly [0,0,0] on Windows) is unmeasured — and this never runs there.
    stats.load1 = typeof one === 'number' && Number.isFinite(one) ? one : null;
    stats.cores = cpus().length || null;
  } catch { /* left null */ }

  const mem = await readMeminfo();
  stats.memAvailableMb = mem.availableMb;
  stats.memTotalMb = mem.totalMb;

  return stats;
}
