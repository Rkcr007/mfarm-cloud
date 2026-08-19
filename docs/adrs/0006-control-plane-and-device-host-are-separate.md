---
id: ADR-0006
title: The control plane and the device host are separate machines
status: Accepted
date: 2026-08-19
authors:
  - Claude Code
tags: [deployment, topology, cost, data-plane, routing]
supersedes: []
resolves: [ADR-0005 "the data plane stops binding to the docker bridge", HANDOFF issue 15]
---

## Context

Everything ran on one machine: Postgres, the API and console, the worker agent, Cuttlefish, Appium.
That was never the architecture — the protocol has always assumed a control plane that many worker
hosts register with — but it was the deployment, and two costs followed from it.

**The console was only up while the device host was.** Devices need `n2-standard-16` with nested
virtualisation (~₹65/hour); the console needs a fraction of that. Keeping the fleet's UI reachable
therefore meant paying ~₹47,000/month for idle Cuttlefish, or accepting that the product disappears
whenever the expensive box is off. A weekday schedule made that concrete: the console vanished at
19:00 IST mid-upload, and the operator's first hypothesis was a crash.

**The worker bound the docker bridge.** `172.18.0.1` was the address a containerised control plane
on the SAME host could reach. It is host-local by construction, so it was never a route for anything
else — no browser could reach the data plane, and ADR-0005 recorded "the data plane stops binding to
the docker bridge" as work still to do. Colocation is what made the wrong address survivable.

## Decision

**Two machines. The control plane is always on; the device host is started when devices are needed.**

- `mfarm-cp` (`e2-medium`, ~₹2,300/month) holds Postgres, the API, the console, the backup sidecar
  and Caddy. It owns the reserved address and the certificate, and it is the only machine with an
  ingress rule.
- `mfarm-lab` (`n2-standard-16`) holds Cuttlefish, Appium and the worker agent, and is off unless
  device work is happening.

Two directions, deliberately asymmetric:

- **Worker → control plane** over the control plane's **public HTTPS URL**, even from inside the same
  VPC. It is the one TLS-terminated endpoint, and a worker that can only reach the control plane
  privately is a worker that cannot move to another network later — which is the whole point of a
  worker protocol.
- **Control plane → worker** over the **internal VPC address** (`10.160.0.x:8090`). The device host
  has no ingress rule at all; nothing it serves is reachable from the internet.

**Authorization does not change, and must not be read as changing.** ADR-0004 rejected a private
network as an authorization mechanism, and that reasoning still holds: every hub request carries an
Ed25519 grant naming session, device, org, fence and host, which the worker verifies offline. The
VPC is a route. If the network were the permission, this decision would be reopening what ADR-0004
closed; it is not.

## Consequences

**The console survives the device host.** It is up whether or not anything can run a test, which is
what makes it usable as a status surface rather than a thing that exists during sessions.

**The bridge binding is gone**, which unblocks the remaining half of ADR-0005: a browser reaching
media now needs only the relay, not a topology change as well.

**A worker restart is cheap; a device host restart is not.** `bringUp()` adopts running cvd groups in
~0.1s, but a host reboot discards device snapshots (issue 24), so starting the device host costs a
cold boot and a re-snapshot per device. Start it for a work session, not for one command.

**Two hosts, two sets of state.** The registration token must exist on both; the signing keypair,
database and app blobs belong to the control plane alone. `farm-up.sh` stops after the control plane
when the host has no `/dev/kvm` rather than registering an empty fleet beside the real one, and
`install-worker-service.sh` now requires `CONTROL_PLANE_URL` because there is no longer a sensible
default for it.

**What this does not fix.** There is still no interactive video: ADR-0005's relay is undecided in
implementation and unbuilt. And `default-allow-internal` permits any VM in the project to reach the
worker's ports; at two machines that is acceptable, and the grant is what actually gates access, but
a rule scoped to the control plane's address would be better hygiene the moment a third VM exists.

## Alternatives

**Keep one box and schedule it.** Cheapest to build, and what was in place. It makes the product's
availability a property of the device fleet's cost, which is exactly backwards: the thing a teammate
looks at should not be the expensive thing.

**Control plane on the device host, devices remote.** Inverts the sizes for no benefit — the small
always-on machine would then be the one that must never be stopped AND the one carrying 4 GB
snapshots.

**A managed database and a serverless API.** Correct at a larger scale and premature here: it moves
Postgres out of the operator's hands before anyone has run a backup drill in anger, and the restore
drill (`deploy/restore-drill.sh`) is currently the only proof the backups work at all.
