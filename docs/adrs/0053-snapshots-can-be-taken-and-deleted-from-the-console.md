# ADR-0053 — snapshots can be taken and deleted from the console; nothing else about the estate can

**Status:** Accepted · 2026-10-09 · migration 070 · extends ADR-0038 (named operations) to two cloud
resources

## Context

Since 2026-09-13 the Cloud page has shown everything the project contains and what it costs. It
could show that the control plane's disk had no restore point, and that the device host's were from
August, and it could do nothing about either. The audit of 2026-10-09 found both.

Taking a snapshot and pruning old ones is recurring work: before a risky change, and afterwards.
Everything else on that page is done once.

## Decision

1. **Two operations.** `POST /v1/infra/cloud/disks/:name/snapshot` and
   `POST /v1/infra/cloud/snapshots/:name/delete`. Fleet operators only, audited as `snapshot-disk`
   and `delete-snapshot` with a new target kind, `cloud` (migration 070).
2. **An allow-list of disks.** `MFARM_SNAPSHOT_DISKS` names the disks the console may snapshot.
   Unset, the page stays read-only and `capabilities.snapshots` is false.
3. **A snapshot is deletable only if the provider says it came from a listed disk.** Not because of
   its name, which is a string anybody can choose and which arrives from a browser.
4. **The newest READY snapshot of a disk cannot be deleted from here.** Pruning is for the old
   ones. The inventory sends `deletable` and, when it is false, `keptBecause`, and the page prints
   the reason on the row.
5. **The snapshot's name is not an input.** The server chooses `<disk>-YYYYMMDD-HHMM` in UTC. Two
   presses in the same minute land on one name and the second answers "already exists".
6. **An outcome is never guessed.** Refused by the provider is `failed`; never acknowledged is
   `unknown`; still being written is `accepted`, and a reconciler settles it from the snapshot's own
   state.

## Consequences

- **It needs one more role on the control plane's service account**: `compute.disks.createSnapshot`
  and `compute.snapshots.create`, `.get`, `.delete` and `.setLabels`. `docs/RUNBOOK.md` has the
  command. The role is bound at the project because a snapshot is a project-level resource; the
  allow-list is what narrows it.
- **A snapshot of a running machine is crash-consistent.** Restoring it is like that machine coming
  back from a power cut. The dialog says so.
- **A disk with one snapshot can never be pruned to none from the console**, and one with two can be
  pruned to one. That is the intent.
- **The provider's own refusals are passed through.** A name that already exists, a disk that has
  been deleted, a quota: each arrives as `failed` with the provider's sentence.
- **Verified against a fake provider, not against the cloud.** Every test in
  `infra-snapshots.test.ts` runs against an in-memory `fetch`. The first real snapshot taken from
  the console is the first time these requests meet GCE.

## Not done here, on purpose

- **Releasing a reserved address.** Both of this farm's addresses are attached to an instance, and
  the provider refuses to release an attached address. Freeing `mfarm-ip` means detaching it from
  the device host first and giving that host an ephemeral address, which is three `gcloud` commands
  run once. A console control for it would be a button that is never enabled.
- **A snapshot schedule.** It is a standing cost and a retention decision. With Snapshot and Delete
  on the page it is also less needed.
- **Restoring from a snapshot.** It replaces a disk under a machine, and is not something to put
  behind one click.

## Alternatives

- **Probe the permission instead of configuring a list.** `testIamPermissions` could tell the page
  what the credential may do. It answers "may I", not "should this console be able to", and the
  second is the question a delete needs answered.
- **Let any snapshot in the project be deleted.** Simpler, and it makes every restore point somebody
  made by hand one mistyped name away from gone.
- **Let the operator name the snapshot.** A free-text field that reaches a cloud API, for a name
  nobody needs to choose.
- **A `DELETE` method.** Every operation in this API is a POST with its verb in the URL, so that the
  audit log's `action` is the route's own name.
