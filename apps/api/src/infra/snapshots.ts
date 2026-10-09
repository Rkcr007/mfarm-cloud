import type { FastifyRequest } from 'fastify';
import { forbidden } from '../http/errors.ts';
import { loadConfig } from '../config.ts';
import { audited, settle, type StepResult } from './audit.ts';
import { giveUpMs } from './reconcile.ts';
import { infraChanged } from './stream.ts';
import { withSystem } from '../db.ts';
import {
  CloudError, createSnapshot, deleteSnapshot, listSnapshots, snapshotDisk, snapshotInfo,
  snapshotsConfigured, type SnapshotInfo, type SnapshotState,
} from './cloud.ts';
import { resetInventoryCache } from './inventory.ts';
import { cleanReason, type OperationOutcome } from './operations.ts';

/**
 * Taking a snapshot of a disk, and deleting one, from the console — ADR-0053.
 *
 * ---------------------------------------------------------------- why these two, and only these
 *
 * The Cloud page could show that the control plane's disk had no restore point and that the device
 * host's were from August, and could do nothing about either. Both are things an operator does
 * repeatedly: take one before a risky change, and prune the old ones afterwards. Everything else
 * about the estate — creating a disk, releasing an address, resizing a machine — is done once and
 * is a command in the runbook.
 *
 * ---------------------------------------------------------------- the same four rules as power
 *
 * NAMED OPERATIONS. The browser sends a disk or snapshot NAME and a reason. The name is never put in
 * a command; it is looked up, and acted on only if the lookup lands on the allow-list.
 *
 * AN ALLOW-LIST. `MFARM_SNAPSHOT_DISKS` names the disks this console may snapshot. A snapshot may be
 * deleted only if THE PROVIDER says it was taken from one of those disks — never because of what it
 * is called, which is a string anybody can choose.
 *
 * THE NEWEST RESTORE POINT OF A DISK CANNOT BE DELETED FROM HERE. Pruning is for the old ones. The
 * button that removes the last way back from a bad day is not one this page should have; `gcloud`
 * still can.
 *
 * AN OUTCOME IS NEVER GUESSED. A request the provider never answered settles as `unknown`, a
 * snapshot still being written as `accepted`, and the reconciler finishes the row later.
 */

interface Step {
  result: StepResult;
  detail?: string;
  value: { result: StepResult; message: string; changed?: Record<string, number | string> };
}

/** How long to watch the provider before answering. A snapshot of a busy disk takes longer. */
function settleMs(): number {
  return Number(process.env.INFRA_SNAPSHOT_SETTLE_MS ?? 25_000);
}

/**
 * `<disk>-YYYYMMDD-HHMM`, in UTC. Chosen HERE, never by the caller: a name is a place to put a
 * string, and this feature takes no strings it does not need. To the minute, so two presses in the
 * same minute land on one name and the second is answered "already being taken" instead of making
 * a second copy.
 */
export function snapshotName(disk: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  // 63 is the provider's limit for a resource name; the stamp and its hyphen take 14.
  return `${disk.slice(0, 49).replace(/-+$/, '')}-${stamp}`;
}

/** Poll one snapshot until it reaches one of `want`, or the deadline passes. Never throws on time. */
async function watch(project: string, name: string, want: SnapshotState[]): Promise<SnapshotInfo> {
  const deadline = Date.now() + settleMs();
  let last: SnapshotInfo = { state: 'unknown', raw: '', sourceDisk: null, createdAt: null };
  for (;;) {
    try {
      last = await snapshotInfo(project, name);
      if (want.includes(last.state)) return last;
    } catch (e) {
      if (e instanceof CloudError && e.answered) throw e;
    }
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, Math.min(2_000, Math.max(50, settleMs() / 10))));
  }
}

/** A provider failure, as the step it should be recorded as. `answered` is the whole distinction. */
function refused(err: CloudError, unreachable: string): Step {
  const result: StepResult = err.answered ? 'failed' : 'unknown';
  return { result, detail: err.message, value: { result, message: err.answered ? err.message : unreachable } };
}

/* ------------------------------------------------------------------ take one */

export async function takeSnapshot(
  req: FastifyRequest, diskName: string, reasonRaw: unknown,
): Promise<OperationOutcome> {
  const target = snapshotDisk(diskName);
  if (!target) {
    throw forbidden(
      `${diskName} is not on this control plane's snapshot list, so it cannot be snapshotted from `
      + 'here. That list is configuration on the control plane (MFARM_SNAPSHOT_DISKS).');
  }
  const reason = cleanReason(reasonRaw, 'snapshot requested by an operator from the console');
  const name = snapshotName(target.disk);

  return audited(req, {
    action: 'snapshot-disk',
    targetKind: 'cloud',
    targetId: target.disk,
    targetLabel: target.disk,
    params: { reason, snapshot: name, zone: target.zone },
  }, async (): Promise<Step> => {
    let existing: SnapshotInfo;
    try {
      existing = await snapshotInfo(target.project, name);
    } catch (e) {
      return refused(e as CloudError,
        'Could not reach the cloud provider, so nothing was attempted.');
    }
    if (existing.state !== 'missing') {
      const message = `A snapshot of ${target.disk} named ${name} already exists `
        + `(${existing.raw.toLowerCase() || 'state unknown'}). Nothing changed.`;
      return { result: 'noop', detail: message, value: { result: 'noop', message } };
    }

    try {
      await createSnapshot(target, name, reason);
    } catch (e) {
      return refused(e as CloudError,
        `The request to snapshot ${target.disk} was sent and never acknowledged, so it may have `
        + 'been taken. Check the list on this page before pressing again.');
    }
    resetInventoryCache();
    infraChanged();

    let after: SnapshotInfo;
    try {
      after = await watch(target.project, name, ['ready', 'failed']);
    } catch {
      after = { state: 'unknown', raw: '', sourceDisk: null, createdAt: null };
    }
    resetInventoryCache();
    infraChanged();

    if (after.state === 'ready') {
      const message = `${name} is ready: a restore point for ${target.disk}.`;
      return { result: 'succeeded', detail: message, value: { result: 'succeeded', message, changed: { snapshot: name } } };
    }
    if (after.state === 'failed') {
      const message = `The provider reports that ${name} FAILED. Nothing was kept; try again.`;
      return { result: 'failed', detail: message, value: { result: 'failed', message } };
    }
    return {
      result: 'accepted',
      detail: `Accepted; last seen ${after.raw || 'unknown'} after ${Math.round(settleMs() / 1000)}s.`,
      value: {
        result: 'accepted',
        message: `${name} is being taken. A busy disk takes a few minutes; this page follows it.`,
        changed: { snapshot: name },
      },
    };
  });
}

/* ------------------------------------------------------------------ delete one */

/** The newest READY snapshot of a disk, by the provider's own timestamp. */
function newestOf(disk: string, all: Array<Record<string, unknown>>): string | null {
  const leaf = (u: unknown) => (typeof u === 'string' ? u.slice(u.lastIndexOf('/') + 1) : '');
  const ready = all
    .filter((s) => leaf(s.sourceDisk) === disk && s.status === 'READY')
    .sort((a, b) => String(b.creationTimestamp ?? '').localeCompare(String(a.creationTimestamp ?? '')));
  return ready.length ? String(ready[0].name ?? '') : null;
}

export async function removeSnapshot(
  req: FastifyRequest, name: string, reasonRaw: unknown,
): Promise<OperationOutcome> {
  if (!snapshotsConfigured()) {
    throw forbidden(
      'This control plane is not set up to change snapshots. MFARM_SNAPSHOT_DISKS names the disks '
      + 'whose snapshots it may take and delete.');
  }
  const project = loadConfig().gcpProject!;
  const reason = cleanReason(reasonRaw, 'deletion requested by an operator from the console');

  return audited(req, {
    action: 'delete-snapshot',
    targetKind: 'cloud',
    targetId: name,
    targetLabel: name,
    params: { reason },
  }, async (): Promise<Step> => {
    let info: SnapshotInfo;
    let all: Array<Record<string, unknown>>;
    try {
      info = await snapshotInfo(project, name);
      all = info.state === 'missing' ? [] : await listSnapshots(project);
    } catch (e) {
      return refused(e as CloudError, 'Could not reach the cloud provider, so nothing was attempted.');
    }

    const settled = (message: string): Step => ({ result: 'noop', detail: message, value: { result: 'noop', message } });
    const declined = (detail: string, message: string): Step =>
      ({ result: 'failed', detail, value: { result: 'failed', message } });

    if (info.state === 'missing') return settled(`${name} does not exist. Nothing changed.`);
    if (info.state === 'deleting') return settled(`${name} is already being deleted. Nothing changed.`);

    /**
     * WHAT THE PROVIDER SAYS IT WAS TAKEN FROM, not what it is called. A snapshot named after an
     * allow-listed disk and taken from another is not one this console may touch.
     */
    if (!info.sourceDisk || !snapshotDisk(info.sourceDisk)) {
      return declined('Refused: not a snapshot of a disk on the snapshot list.',
        `${name} was not taken from a disk this control plane may snapshot`
        + `${info.sourceDisk ? ` (it is a snapshot of ${info.sourceDisk})` : ''}, so it cannot be `
        + 'deleted from here.');
    }
    if (newestOf(info.sourceDisk, all) === name) {
      return declined(`Refused: the newest snapshot of ${info.sourceDisk}.`,
        `${name} is the newest restore point for ${info.sourceDisk}. Take a newer snapshot first; `
        + 'this page does not delete the last way back.');
    }

    try {
      await deleteSnapshot(project, name);
    } catch (e) {
      return refused(e as CloudError,
        `The request to delete ${name} was sent and never acknowledged, so it may have been `
        + 'carried out. Check the list on this page before pressing again.');
    }
    resetInventoryCache();
    infraChanged();

    let after: SnapshotInfo;
    try {
      after = await watch(project, name, ['missing']);
    } catch {
      after = { state: 'unknown', raw: '', sourceDisk: null, createdAt: null };
    }
    resetInventoryCache();
    infraChanged();

    if (after.state === 'missing') {
      const message = `${name} is deleted. ${info.sourceDisk} still has a newer restore point.`;
      return { result: 'succeeded', detail: message, value: { result: 'succeeded', message } };
    }
    return {
      result: 'accepted',
      detail: `Accepted; last seen ${after.raw || 'unknown'} after ${Math.round(settleMs() / 1000)}s.`,
      value: { result: 'accepted', message: `${name} is being deleted. This page follows it.` },
    };
  });
}

/* ------------------------------------------------------------------ finishing what was left open */

/**
 * Settle snapshot operations that answered `accepted`.
 *
 * The same job `reconcileOperations` does for power, and for the same reason: an operation that
 * outlives the request that started it has to be finished by something, or the log fills with rows
 * that say "in progress" about things that ended an hour ago. The snapshot's own state is the truth
 * — READY, FAILED, or gone — and past the give-up horizon the honest answer is `unknown`.
 */
export async function reconcileSnapshots(): Promise<{ checked: number; settled: number; gaveUp: number }> {
  const out = { checked: 0, settled: 0, gaveUp: 0 };
  const project = loadConfig().gcpProject;
  if (!project) return out;

  const rows = await withSystem(async (c) => (await c.query<{
    id: string; action: string; target_id: string; requested_at: Date; snapshot: string | null;
  }>(
    `SELECT id, action, target_id, requested_at, params->>'snapshot' AS snapshot
       FROM infra_operations
      WHERE result = 'accepted' AND action IN ('snapshot-disk', 'delete-snapshot')
      ORDER BY requested_at
      LIMIT 20`)).rows);
  out.checked = rows.length;

  for (const row of rows) {
    const age = Date.now() - row.requested_at.getTime();
    const name = row.action === 'snapshot-disk' ? row.snapshot : row.target_id;
    const giveUp = async (detail: string) => { await settle(row.id, 'unknown', detail); out.gaveUp++; };
    if (!name) { if (age > giveUpMs()) await giveUp('The operation recorded no snapshot name to check.'); continue; }

    let info: SnapshotInfo;
    try {
      info = await snapshotInfo(project, name);
    } catch (e) {
      if (age > giveUpMs()) await giveUp(`The outcome was never confirmed: ${(e as Error).message}`);
      continue;
    }

    if (row.action === 'snapshot-disk') {
      if (info.state === 'ready') { await settle(row.id, 'succeeded', `${name} is ready.`); out.settled++; }
      else if (info.state === 'failed') { await settle(row.id, 'failed', `The provider reports that ${name} failed.`); out.settled++; }
      else if (age > giveUpMs()) await giveUp(`Still ${info.raw || info.state} ${Math.round(age / 60_000)} minutes after the request.`);
    } else if (info.state === 'missing') {
      await settle(row.id, 'succeeded', `${name} is deleted.`); out.settled++;
    } else if (age > giveUpMs()) {
      await giveUp(`${name} still exists ${Math.round(age / 60_000)} minutes after the request to delete it.`);
    }
  }

  if (out.settled || out.gaveUp) { resetInventoryCache(); infraChanged(); }
  return out;
}
