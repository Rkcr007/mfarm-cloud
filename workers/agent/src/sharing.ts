import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Which phones on this machine the org may actually reach — ADR-0009 §2.
 *
 * **Discovery is a read. Sharing is a decision.** Until this file existed, every handset discovery
 * found was registered, and that is correct for an operator-owned box and wrong for a laptop:
 * plugging a personal phone into a work machine silently offered somebody's banking and 2FA apps to
 * their colleagues. Nothing warned them, and nothing asked.
 *
 * THE DEFAULT IS OFF, and only for physical devices. A Cuttlefish instance is infrastructure
 * somebody provisioned on purpose and its whole reason for existing is to be scheduled; a phone on
 * the end of a USB cable belongs to whoever is standing next to it. Defaulting the whole fleet off
 * would take the existing farm out of service to fix a problem it does not have — see
 * `sharedByDefault`.
 *
 * PERSISTED, because the choice must survive a restart. The agent drains and re-registers whenever
 * its device set changes, so a decision held only in memory would be forgotten by the very
 * mechanism that applies it — a phone would be shared, the agent would restart to register it, and
 * it would come back unshared.
 *
 * STORED AS AN ALLOW LIST, never a deny list. The failure mode of a lost or corrupt file has to be
 * "nothing is shared" rather than "everything is": the first is an inconvenience somebody notices
 * immediately, and the second is the exact harm this file exists to prevent, silently.
 */

export function sharingPath(override?: string): string {
  return override ?? join(process.env.HOME ?? '/tmp', '.mfarm', 'shared.json');
}

/**
 * Whether a tier is shared unless somebody says otherwise.
 *
 * `physical` is the one that is not. This is a property of who owns the hardware rather than of
 * what it can do: nobody accidentally has a Cuttlefish instance on their desk.
 */
export const sharedByDefault = (tier: string): boolean => tier !== 'physical';

interface SharingFile {
  /** adb serials the owner has explicitly shared. Absent means never asked; never means "no". */
  shared?: string[];
  /** Serials explicitly UNSHARED, so a default-on tier can be turned off and stay off. */
  withheld?: string[];
}

async function read(path: string): Promise<SharingFile> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as SharingFile;
    return {
      shared: Array.isArray(parsed.shared) ? parsed.shared.filter((s) => typeof s === 'string') : [],
      withheld: Array.isArray(parsed.withheld) ? parsed.withheld.filter((s) => typeof s === 'string') : [],
    };
  } catch {
    // Missing, unreadable, or corrupt — all mean the same thing here, and it is the safe thing.
    return { shared: [], withheld: [] };
  }
}

/** The whole picture, so a caller can decide for a device it has not seen before. */
export interface SharingPolicy {
  shared: Set<string>;
  withheld: Set<string>;
  /** Should this device be registered? Applies the default for its tier. */
  allows(serial: string | undefined, tier: string): boolean;
}

export async function loadSharing(override?: string): Promise<SharingPolicy> {
  const file = await read(sharingPath(override));
  const shared = new Set(file.shared ?? []);
  const withheld = new Set(file.withheld ?? []);
  return {
    shared,
    withheld,
    allows(serial, tier) {
      // A device with no serial cannot be named in this file, so it can only follow its tier's
      // default. That is every Cuttlefish instance, and it is why the default is per tier.
      if (!serial) return sharedByDefault(tier);
      if (shared.has(serial)) return true;
      if (withheld.has(serial)) return false;
      return sharedByDefault(tier);
    },
  };
}

/**
 * Record a decision. Writing BOTH lists rather than one, so that "shared" and "not shared" are
 * distinguishable from "never asked" — which matters for a tier whose default is on.
 */
export async function setShared(serial: string, share: boolean, override?: string): Promise<void> {
  const path = sharingPath(override);
  const file = await read(path);
  const shared = new Set(file.shared ?? []);
  const withheld = new Set(file.withheld ?? []);
  if (share) { shared.add(serial); withheld.delete(serial); }
  else { withheld.add(serial); shared.delete(serial); }
  await mkdir(dirname(path), { recursive: true });
  // 0600 like the state file beside it. It is not a credential, but it IS a statement about whose
  // phone may be driven by strangers, and that is not something another local user should edit.
  await writeFile(path, JSON.stringify({ shared: [...shared], withheld: [...withheld] }, null, 2), { mode: 0o600 });
}
