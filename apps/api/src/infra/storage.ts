import { readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * What the control plane's own disks look like — the measurements, separated from who reports them.
 *
 * WHY THIS FILE EXISTS RATHER THAN A SECOND COPY IN THE INFRA ROUTES. `metrics.ts` has measured the
 * backup directory since the backups existed, and it does it correctly: from the FILES, never from
 * a sidecar's claim of success, with `-1` for "cannot see" so that a missing mount and an old backup
 * are different alerts. The Infrastructure page needs exactly those numbers.
 *
 * Two readers with the same intent drift — one gets the `.dump.partial` filter right and the other
 * counts a half-written file as a backup — and then the dashboard and the alert disagree during the
 * incident where it matters. So the measurement moved here and `collectBackups` sets its gauges from
 * it. The `-1` convention is preserved verbatim, because alerts.yml is written against it.
 */

/** `-1` means the measurement is unavailable. It never means zero, and never means fine. */
export interface BackupState {
  /** Seconds since the newest verified dump was written. */
  ageSeconds: number;
  /** How many dumps are currently retained. 0 is a real answer here, not an unavailable one. */
  count: number;
  /** Seconds since the newest dump was confirmed to exist off this machine. */
  offsiteAgeSeconds: number;
}

const UNAVAILABLE: BackupState = { ageSeconds: -1, count: 0, offsiteAgeSeconds: -1 };

/**
 * Read the backup directory.
 *
 * Every failure lands on `-1`. An unset BACKUP_DIR, a directory that is not mounted, a permission
 * error — none of them mean "the backups are fine" and none of them mean "the backups are old".
 */
export async function backupState(): Promise<BackupState> {
  const dir = process.env.BACKUP_DIR?.trim();
  if (!dir) return { ...UNAVAILABLE };
  try {
    // Read FIRST and independently of the dumps, so that "no backups at all" and "backups that
    // never left the box" stay separable. Inside the dump branch, an empty directory would silently
    // imply an offsite failure it says nothing about.
    const receipt = await stat(join(dir, '.offsite-receipt')).catch(() => null);
    const offsiteAgeSeconds = receipt ? (Date.now() - receipt.mtimeMs) / 1000 : -1;

    // `mfarm-*.dump` exactly. The dump is written as `.dump.partial`, verified with
    // `pg_restore --list` and only then renamed, so this suffix means a backup proven readable. The
    // companion `.globals.sql` is deliberately not counted: it is written first, and counting it
    // would make a run that died halfway through pg_dump look like a fresh, complete backup.
    const names = (await readdir(dir)).filter((n) => n.startsWith('mfarm-') && n.endsWith('.dump'));
    if (!names.length) return { ageSeconds: -1, count: 0, offsiteAgeSeconds };

    let newest = 0;
    for (const n of names) {
      const st = await stat(join(dir, n)).catch(() => null);
      if (st && st.mtimeMs > newest) newest = st.mtimeMs;
    }
    return {
      ageSeconds: newest ? (Date.now() - newest) / 1000 : -1,
      count: names.length,
      offsiteAgeSeconds,
    };
  } catch {
    return { ...UNAVAILABLE };
  }
}

/** Free and total bytes on one path, or nulls when it cannot be measured. */
export interface VolumeState {
  path: string;
  freeBytes: number | null;
  totalBytes: number | null;
}

/**
 * The volume holding a directory.
 *
 * NULL, NEVER A GUESS, for the reason `hoststats.ts` gives about the same measurement on the device
 * host: a zero here reads as a full disk, and "we cannot see the disk" is a different incident from
 * "the disk is fine". The agent already reports this for the machines that run devices; this is the
 * same fact about the machine that runs the control plane, which nothing has ever reported.
 */
export async function volumeState(path: string): Promise<VolumeState> {
  try {
    const fs = await statfs(path);
    // `bavail`, not `bfree`: the difference is the root reserve, and a process that is not root
    // cannot use it. Reporting `bfree` would promise space the API cannot actually write into.
    return {
      path,
      freeBytes: Number(fs.bsize) * Number(fs.bavail),
      totalBytes: Number(fs.bsize) * Number(fs.blocks),
    };
  } catch {
    return { path, freeBytes: null, totalBytes: null };
  }
}
