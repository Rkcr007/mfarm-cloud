import { cloudGet, instanceFor, CloudError, powerConfigured } from './cloud.ts';
import { loadConfig } from '../config.ts';

/**
 * EVERYTHING THIS APP HAS IN THE CLOUD — not just the machines running an agent.
 *
 * ---------------------------------------------------------------- the gap this closes
 *
 * Until now the Infrastructure page knew about `hosts`: machines that registered a worker agent. On
 * this farm that is one VM. The project actually contains:
 *
 *   TWO instances, because the CONTROL PLANE is infrastructure too and had never appeared anywhere
 *     in the product — so every cost figure excluded the machine serving the page;
 *   180 GB of persistent disk, which is billed whether or not either VM is running;
 *   THREE snapshots totalling ~21 GB of stored bytes, which nobody has looked at since August;
 *   TWO reserved static addresses, which are billed whenever they are NOT attached to a running
 *     instance — so stopping the device host quietly starts a charge rather than ending one.
 *
 * **"THE FARM COSTS NOTHING WHILE IT IS OFF" WAS NEVER TRUE**, and the product had no way to say so.
 * `docs/STATUS.md` says the device host is ~95% of the bill and is stopped between sessions; that is
 * right about the VARIABLE cost and silent about the floor underneath it. This module is the floor.
 *
 * ---------------------------------------------------------------- read-only, and separately scoped
 *
 * Listing is a PROJECT-level operation — you cannot list per instance — so it cannot use the
 * narrow, per-instance binding that power control uses. It gets its own role: list and get, no
 * verbs, bound at the project. That asymmetry is deliberate and worth keeping visible: the
 * dangerous permissions stay attached to two named machines, and the harmless ones are allowed to be
 * broad. See `docs/RUNBOOK.md`.
 *
 * ---------------------------------------------------------------- prices are configuration
 *
 * MFARM is self-hosted. What a disk costs is a fact about somebody's cloud bill and a number
 * invented here would be rendered as though the farm had measured it — the rule `config.ts` already
 * follows for `HOST_HOURLY_COST`. Every rate is unset by default, and an unpriced resource is shown
 * with its SIZE and no money, which is still the useful half: "you have three snapshots you forgot
 * about" does not need a currency.
 */

/** How long an inventory answer is reused. The estate changes when somebody runs a gcloud command. */
const CACHE_MS = 60_000;

/** GCE bills a reserved address whenever it is not attached to a RUNNING instance. */
const ADDRESS_BILLED_WHEN = 'not attached to a running instance';

export interface CloudInstance {
  name: string;
  zone: string;
  status: string;
  machineType: string;
  /** The disks attached, by name, so a disk row can say what it belongs to. */
  disks: string[];
  /** Per hour, from configuration. Null when this deployment has not priced it. */
  rateHourly: number | null;
  /** True when a worker agent on this machine is registered with the control plane. */
  isFleetHost: boolean;
}

export interface CloudDisk {
  name: string;
  zone: string;
  sizeGb: number;
  type: string;
  /** The instance it is attached to, or null — an unattached disk is pure waste. */
  attachedTo: string | null;
  costPerMonth: number | null;
}

export interface CloudAddress {
  name: string;
  address: string;
  region: string;
  status: string;
  attachedTo: string | null;
  /**
   * Whether this address is COSTING MONEY RIGHT NOW.
   *
   * The counter-intuitive one, and the reason this field exists rather than a status string: GCE
   * charges for a reserved address that is NOT attached to a running instance. Stopping a VM
   * therefore starts a charge on its address. Nobody discovers that by reading a status of IN_USE.
   */
  billed: boolean;
  costPerMonth: number | null;
}

export interface CloudSnapshot {
  name: string;
  /** What it would restore to. Not what it costs — snapshots are billed on bytes STORED. */
  diskSizeGb: number;
  storageBytes: number | null;
  sourceDisk: string | null;
  createdAt: string | null;
  costPerMonth: number | null;
}

export interface CloudInventory {
  /** False when this deployment has no cloud credential or no project — the page says so. */
  configured: boolean;
  project: string | null;
  fetchedAt: string | null;
  /** Present when the last attempt failed. The previous answer is still returned beside it. */
  error: string | null;
  instances: CloudInstance[];
  disks: CloudDisk[];
  addresses: CloudAddress[];
  snapshots: CloudSnapshot[];
  cost: {
    currency: string;
    /**
     * WHAT THIS ESTATE COSTS WITH EVERY MACHINE SWITCHED OFF.
     *
     * The number this module exists for. Disks, snapshots and addresses do not care whether anything
     * is running, so this is the floor under every "we stopped it, so it costs nothing" conversation.
     * Null when nothing is priced.
     */
    floorPerMonth: number | null;
    /** What the machines add on top, at their current state. */
    runningPerHour: number | null;
    /** Per category, so the biggest line is obvious. Null entries are unpriced, not zero. */
    byKind: { instances: number | null; disks: number | null; addresses: number | null; snapshots: number | null };
    /** Which rates are missing, named, so the gap is actionable rather than mysterious. */
    unpriced: string[];
  };
}

const EMPTY = (project: string | null, error: string | null): CloudInventory => ({
  configured: false, project, fetchedAt: null, error,
  instances: [], disks: [], addresses: [], snapshots: [],
  cost: {
    currency: loadConfig().costCurrency, floorPerMonth: null, runningPerHour: null,
    byKind: { instances: null, disks: null, addresses: null, snapshots: null },
    unpriced: [],
  },
});

let cache: { at: number; value: CloudInventory } | null = null;

/** Test seam, and the way a forced refresh is expressed. */
export function resetInventoryCache(): void {
  cache = null;
}

/** The last path segment of a GCE self-link — `.../zones/asia-south1-c` becomes `asia-south1-c`. */
const leaf = (url: unknown): string =>
  typeof url === 'string' ? url.slice(url.lastIndexOf('/') + 1) : '';

/**
 * Walk an aggregated list, which GCE returns as a map of scope -> { items } and, for scopes with
 * nothing in them, { warning }.
 */
function aggregated<T>(body: Record<string, unknown>, key: string): T[] {
  const items = body.items as Record<string, Record<string, unknown>> | undefined;
  if (!items) return [];
  const out: T[] = [];
  for (const scope of Object.values(items)) {
    const list = scope?.[key] as T[] | undefined;
    if (Array.isArray(list)) out.push(...list);
  }
  return out;
}

const money = (n: number | null): number | null => (n === null ? null : Number(n.toFixed(2)));

/**
 * The whole estate, cached.
 *
 * ONE FAILURE DOES NOT EMPTY THE PAGE. A cached answer is returned with the error beside it, for the
 * same reason `refreshInfra` keeps its previous numbers: this page is opened when somebody suspects
 * something is wrong, and a blank screen is the least useful thing it could do at that moment.
 */
export async function cloudInventory(fleetHostnames: Set<string>): Promise<CloudInventory> {
  const cfg = loadConfig();
  const project = cfg.gcpProject;

  if (!project || !powerConfigured()) {
    return EMPTY(project, null);
  }
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const path = (p: string) => `/projects/${encodeURIComponent(project)}${p}`;
  let instancesBody; let disksBody; let addressesBody; let snapshotsBody;
  try {
    [instancesBody, disksBody, addressesBody, snapshotsBody] = await Promise.all([
      cloudGet(path('/aggregated/instances')),
      cloudGet(path('/aggregated/disks')),
      cloudGet(path('/aggregated/addresses')),
      cloudGet(path('/global/snapshots')),
    ]);
  } catch (e) {
    const message = e instanceof CloudError
      ? e.message
      : `Could not read the project inventory: ${(e as Error).message}`;
    if (cache) return { ...cache.value, error: message };
    return { ...EMPTY(project, message), configured: true };
  }

  /* ---------------------------------------------------------------- instances */

  const rawInstances = aggregated<Record<string, unknown>>(instancesBody, 'instances');
  const instances: CloudInstance[] = rawInstances.map((i) => {
    const name = String(i.name ?? '');
    const disks = (i.disks as Array<Record<string, unknown>> | undefined ?? [])
      .map((d) => leaf(d.source) || String(d.deviceName ?? ''))
      .filter(Boolean);
    return {
      name,
      zone: leaf(i.zone),
      status: String(i.status ?? 'UNKNOWN'),
      machineType: leaf(i.machineType),
      disks,
      rateHourly: cfg.cloudInstanceRates.get(name) ?? cfg.hostHourlyCost,
      /**
       * MATCHED ON THE INSTANCE NAME THE ALLOW-LIST MAPS TO, not on the hostname a worker chose.
       * A host registers under its internal FQDN on GCE, so a naive comparison would say none of
       * these machines is in the fleet — which is how the runbook's own example came to be wrong.
       */
      isFleetHost: [...fleetHostnames].some((h) => instanceFor(h)?.instance === name),
    };
  });

  /* ---------------------------------------------------------------- disks */

  const diskRate = cfg.cloudDiskRatePerGbMonth;
  const disks: CloudDisk[] = aggregated<Record<string, unknown>>(disksBody, 'disks').map((d) => {
    const sizeGb = Number(d.sizeGb ?? 0);
    const users = (d.users as string[] | undefined ?? []).map(leaf);
    return {
      name: String(d.name ?? ''),
      zone: leaf(d.zone),
      sizeGb,
      type: leaf(d.type),
      attachedTo: users[0] ?? null,
      costPerMonth: diskRate === null ? null : money(sizeGb * diskRate),
    };
  });

  /* ---------------------------------------------------------------- addresses */

  const addressRate = cfg.cloudAddressRatePerHour;
  const runningInstances = new Set(
    instances.filter((i) => i.status === 'RUNNING').map((i) => i.name));
  const addresses: CloudAddress[] = aggregated<Record<string, unknown>>(addressesBody, 'addresses')
    .map((a) => {
      const attachedTo = leaf((a.users as string[] | undefined ?? [])[0]) || null;
      /**
       * BILLED WHEN IT IS NOT ON A RUNNING MACHINE. GCE's rule, and the surprising one: stopping a
       * VM starts a charge on its reserved address rather than ending one. An address showing
       * `IN_USE` against a TERMINATED instance is costing money every hour.
       */
      const billed = !attachedTo || !runningInstances.has(attachedTo);
      return {
        name: String(a.name ?? ''),
        address: String(a.address ?? ''),
        region: leaf(a.region),
        status: String(a.status ?? 'UNKNOWN'),
        attachedTo,
        billed,
        costPerMonth: addressRate === null || !billed ? null : money(addressRate * 730),
      };
    });

  /* ---------------------------------------------------------------- snapshots */

  const snapshotRate = cfg.cloudSnapshotRatePerGbMonth;
  const snapshots: CloudSnapshot[] = ((snapshotsBody.items as Array<Record<string, unknown>>) ?? [])
    .map((s) => {
      /**
       * BILLED ON BYTES STORED, not on the size of the disk it came from. A 150 GB disk that is
       * mostly empty snapshots to a few gigabytes, and showing 150 GB here would overstate the cost
       * by an order of magnitude — and understate how cheap keeping one is.
       */
      const storageBytes = s.storageBytes === undefined ? null : Number(s.storageBytes);
      const storedGb = storageBytes === null ? null : storageBytes / 1024 ** 3;
      return {
        name: String(s.name ?? ''),
        diskSizeGb: Number(s.diskSizeGb ?? 0),
        storageBytes,
        sourceDisk: leaf(s.sourceDisk) || null,
        createdAt: typeof s.creationTimestamp === 'string' ? s.creationTimestamp : null,
        costPerMonth: snapshotRate === null || storedGb === null
          ? null : money(storedGb * snapshotRate),
      };
    });

  /* ---------------------------------------------------------------- what it all costs */

  const sum = (values: Array<number | null>): number | null => {
    const known = values.filter((v): v is number => v !== null);
    return known.length ? money(known.reduce((a, b) => a + b, 0)) : null;
  };

  const diskCost = sum(disks.map((d) => d.costPerMonth));
  const addressCost = sum(addresses.map((a) => a.costPerMonth));
  const snapshotCost = sum(snapshots.map((s) => s.costPerMonth));
  const runningPerHour = sum(
    instances.filter((i) => i.status === 'RUNNING').map((i) => i.rateHourly));
  const instanceMonthly = runningPerHour === null ? null : money(runningPerHour * 730);

  const unpriced: string[] = [];
  if (diskRate === null) unpriced.push('disks (CLOUD_DISK_RATE)');
  if (snapshotRate === null) unpriced.push('snapshots (CLOUD_SNAPSHOT_RATE)');
  if (addressRate === null) unpriced.push('reserved addresses (CLOUD_ADDRESS_RATE)');
  if (instances.some((i) => i.rateHourly === null)) {
    unpriced.push('one or more instances (CLOUD_INSTANCE_RATES or HOST_HOURLY_COST)');
  }

  const value: CloudInventory = {
    configured: true,
    project,
    fetchedAt: new Date().toISOString(),
    error: null,
    instances: instances.sort((a, b) => a.name.localeCompare(b.name)),
    disks: disks.sort((a, b) => b.sizeGb - a.sizeGb),
    addresses: addresses.sort((a, b) => a.name.localeCompare(b.name)),
    snapshots: snapshots.sort((a, b) => (b.storageBytes ?? 0) - (a.storageBytes ?? 0)),
    cost: {
      currency: cfg.costCurrency,
      /**
       * THE FLOOR: what this estate costs with every machine switched off. Disks, snapshots and the
       * addresses that are billed while nothing is running. This is the number that makes "we
       * stopped it, so it costs nothing" checkable.
       */
      floorPerMonth: sum([
        diskCost,
        snapshotCost,
        addressRate === null ? null : money(addresses.length * addressRate * 730),
      ]),
      runningPerHour,
      byKind: {
        instances: instanceMonthly, disks: diskCost,
        addresses: addressCost, snapshots: snapshotCost,
      },
      unpriced,
    },
  };

  cache = { at: Date.now(), value };
  return value;
}
