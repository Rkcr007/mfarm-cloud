---
id: ADR-0008
title: Physical devices arrive through the existing agent, on a tunnel the agent dials
status: Accepted
date: 2026-08-24
authors:
  - Claude Code
tags: [physical-devices, agent, transport, enrollment, tenancy, backups]
supersedes: []
resolves: [
  "E2E_MVP_PLAN.md 'tier: physical — not needed, not planned, not blocking'",
  "product_guide_v2.md Phase 7 'physical devices, on customer pull only'",
  "ADR-0003 'a host that re-registers un-quarantines itself'"
]
---

## Context

`RealDeviceAgentIntegration.md` asks for physical Android support through a "lightweight MFARM
Agent": a phone on USB, discovered over adb, enrolled, reserved, streamed, driven, and running
Appium locally so cloud latency stays out of every UI operation.

Three committed documents say this is out of scope — `docs/E2E_MVP_PLAN.md:62` ("Not needed, not
planned, not blocking"), `product_guide_v2.md:309` ("Phase 7 — on customer pull only. Highest capex,
lowest margin… Never before a paying requirement"), and `docs/INDEX.md` §11. **This ADR reverses
that**, on the owner's instruction, and exists so the reversal is a recorded decision rather than a
diff that contradicts the plan of record.

The spec's own structure is the thing to be careful about. Read literally — §5, "create a standalone
component `mfarm-agent`" — it asks for a second agent beside the one that already exists. But most of
what its 37 sections describe is built and hardware-verified today:

| The spec asks for | Already in the repo |
|---|---|
| §5 an agent runtime, independently deployable | `workers/agent`, systemd unit, drain-and-exit withdrawal |
| §10 an outbound secure connection | register / heartbeat / events, all agent-dialled |
| §11 heartbeat | 10s, and the channel work is *offered* on, because nothing on the host listens |
| §12/§13 lifecycle, reservation, lease | `device_state`, `allocate_device`, `expires_at`, `fence`, reaper |
| §24 security | per-request Ed25519 grants the agent verifies **offline**; mint/verify split across packages |
| §3/§32 one device abstraction | `DeviceControl` / `MediaSource` / declared capabilities |
| §4 `type: "real"` | `tier: 'physical'`, already legal in the protocol, `DeviceInfo` and the `devices` CHECK |

Building a second agent would fork a security-reviewed component in two, and the halves would drift
in `workers.ts`, `dataplane.ts` and `protocol.ts` — where a bad merge is a silent cross-tenant bug
rather than a compile error.

## Decision

**A physical device is a third BACKEND behind the existing agent, not a second agent.** Everything
above the `DeviceBackend` interface is reused unchanged.

Four things genuinely do not fit, and each is a decision rather than code:

### 1. The agent dials the data plane out (workstream B)

`/dp/<hostId>` was proxied by Caddy to ONE statically-configured worker address, and the worker ran a
WebSocket *server* for it. Two limits wearing one coat: a single device host can serve a live view,
and that host must be dialable. A phone arrives on a teammate's laptop behind NAT, where neither
holds.

So the agent holds one outbound socket open and the control plane multiplexes viewers onto it as
channels. `DataPlane` now accepts a duck-typed socket, so a tunnel channel runs the SAME hello, grant
verification, fence check, sequence gate and input coalescing — an authorization check that exists
twice is one that will eventually disagree with itself.

**This is not the VPN ADR-0004 rejected.** That ADR refused a private network because "a VPN
authenticates the network, not the request." The tunnel authenticates the AGENT and carries opaque
bytes; every frame inside still holds the browser's own 120-second grant, still verified offline by
the agent, still audience-bound and fence-checked. The control plane relays and decides nothing —
and it was already in this path, since Caddy runs there. `workers/agent/test/agent.test.ts` pins it:
a forged grant sent through the tunnel comes back `bad_signature`, from the agent, at the far end of
a relay that inspected nothing.

The direct proxy survives behind `WORKER_DATA_PLANE` so the existing farm migrates when it chooses.

### 2. Enrollment replaces the fleet secret for hosts nobody here administers (workstream A)

One shared `WORKER_REGISTRATION_TOKEN` is defensible for two machines you rebuild yourself. Pasted
into a laptop it is a credential that never expires, names nobody, and whose revocation revokes the
fleet. Migration 023 adds single-use, expiring, revocable, org-scoped enrollment tokens, redeemed
inside the registration transaction under `SELECT … FOR UPDATE` so single-use is real rather than
advisory. A host may also re-register with its own worker token, which is what lets a laptop plug in
a second phone without the fleet secret staying hot.

### 3. A phone cannot snapshot-restore, so it is org-pinned (workstream E)

`REQUIRED_FOR_TENANT_USE` gates on `snapshot-reset`; a handset would register, appear in the console,
and never be schedulable — silently. §17's package-level cleanup is explicitly rejected by
`resetToSnapshot`'s own doc comment as insufficient between tenants, and it is right.

So devices inherit `hosts.org_id` and never enter the shared pool. This needed **no allocator or RLS
change**: `allocate_device` has always filtered `(d.org_id IS NULL OR d.org_id = p_org)` and
`devices_visible` scopes SELECT the same way. One column is the whole of it. A weaker `session-reset`
capability, named honestly, will gate scheduling for pinned devices.

### 4. §30 cannot be met as written, and is restated

With the suite in the customer's CI and the phone on a laptop, every WebDriver command necessarily
crosses the cloud. Running the customer's TEST CODE on the agent is refused by ADR-0002 ("`mfarm run`
wraps your command; it is not a test runner"). What is achievable, and is §14's real point, is that
**Appium and UiAutomator2 run adjacent to the device**, so chatty per-UI-operation traffic stays
local. That is already how the system works.

### A defect found on the way

Migration 016 split operator-from-reaper quarantine so a host cannot argue with an operator's
judgement — but taught only the HEARTBEAT about it. `POST /workers/register` cleared every quarantine
unconditionally and force-promoted QUARANTINED devices without consulting `quarantined_from`, so a
device quarantined *from CLEANING* came back READY, handing the next tenant the previous one's data.
Harmless while a healthy Cuttlefish agent never re-registers; routine for laptops. Un-quarantining
now happens in exactly one place.

## Consequences

Deliberately accepted:

- **The control plane becomes a hard dependency of the live view.** A same-network browser could in
  principle have reached a worker directly. It was never the deployed path.
- **Media still does not traverse the control plane.** Frames go browser↔device over TURN
  (ADR-0005), and input for a physical device will go over the WebRTC data channel — so a tap does
  not pay a control-plane round trip.
- **`adb shell input` is not an option for physical input.** Measured p50 121ms / p95 418ms
  (`product_guide_v2.md:95`); a held shell is still 39/70ms. A backend built on it would register and
  then fail `REQUIRED_FOR_TENANT_USE` silently. scrcpy's control socket is the path.
- **The agent becomes a WebRTC peer for the first time.** Cuttlefish publishes its own stream and the
  agent relays opaque signalling; a phone publishes nothing. Packetizing scrcpy's already-hardware-
  encoded H.264 into RTP is neither a decode nor an encode, so `device.ts`'s "the agent never touches
  frames" invariant — which forbids a *transcode* — is intact. Throughput in Node is UNMEASURED and
  is the largest open risk.

Unblocked as a side effect: the single-upstream limit is gone, so a second device host of any tier is
now possible.

## Off-box backups, decided in the same window

Not physical devices, but the same session and worth recording once. Backups were six-hourly,
verified, retained 28 deep — and every copy on the same disk as the database. That is a backup of
`DROP TABLE`, not of losing the VM.

A `backup-offsite` sidecar now copies each completed pair to `gs://mfarm-backups-129651686670`
(asia-south1, 90-day lifecycle) and re-confirms the newest every 15 minutes, writing
`.offsite-receipt` whose mtime becomes `mfarm_backup_offsite_age_seconds`. The receipt is written
ONLY when the newest backup is confirmed at the right size, so a failed run leaves the old one to go
stale and page rather than refreshing into a green dashboard.

Two things found doing it, both of which look correct until they are not:

- **A GCE scope caps a token regardless of IAM.** `mfarm-cp` carried `devstorage.read_only`, so every
  binding could be right and uploads still 403. Changing it requires the instance STOPPED.
- **The default compute service account holds `roles/editor`**, which carries object delete on every
  bucket — making any narrow per-bucket binding decorative. `mfarm-cp` now runs as a dedicated
  service account with `objectCreator` + `objectViewer` on that bucket and nothing else. Verified
  from the box: write succeeds, read-back succeeds, **delete returns 403**. The control plane cannot
  destroy the backups it wrote, which is the scenario off-box copies exist for.

## Rollback

`mvp1` tags the deployed two-device farm (migration 022). Images are commit-tagged and never mutated,
so an image rollback is `deploy/mfarm-deploy.sh <sha>`. The SCHEMA does not roll back, so
`apps/api/test/rollback.test.ts` builds the baseline and current schemas in a scratch database and
fails on any backward-incompatible change — a dropped column, a tightening to NOT NULL, a new CHECK
on an existing table. Migration 023 passes it. Rolling back past a migration remains a decision, but
it is now an informed one.

## Status of the work

Milestone 0 is built and green: enrollment, org-pinning, the tunnel, the quarantine fix, off-box
backups, the rollback guard.

**THE HARDWARE GATE IS CLOSED (2026-08-24.)** It was: `deploy/verify-live.sh` and
`deploy/verify-webdriver.mjs` green against the EXISTING Cuttlefish host, through the tunnel —
because nothing about physical devices justifies regressing the virtual farm (§36.1). All three
verifiers now pass on the real farm with `WORKER_DATA_PLANE` unset, which is the tunnel path:

- `verify-live.sh` — 1 agent tunnel connected, 2 devices READY, coturn answering.
- `verify-dataplane.mjs` — 10/10, all eight hostile hellos refused, through the tunnel.
- `verify-webdriver.mjs` — a full M3 session in 9.0s.

So the inversion is proven over the internet, not only over laptop sockets.

### Phase 1 — automation-only physical devices (built, unproven on a handset)

The MVP is deliberately split: everything a real phone needs to run TESTS, with the live view left
to a second phase because it is the only piece resting on unmeasured technology (scrcpy→RTP
throughput in Node). Built:

- `session-reset` capability, and `REQUIRED_FOR_TENANT_USE` becomes a list of alternative GROUPS —
  a device satisfies a group by declaring any one of it. This is decision 3 above, finally in code:
  the gate meant "the next tenant inherits nothing", and demanded `snapshot-reset`, a mechanism.
- `workers/agent/src/devices/physical.ts` — the third backend. §17 package-level cleanup, battery
  and storage health, screenshot, UI hierarchy, logcat. No `screen-stream`, deliberately.
- `workers/agent/src/devices/discovery.ts` — `adb devices -l`, with every unusable state (
  `unauthorized`, `offline`, `no permissions`) reported alongside the instruction that fixes it.
- `PHYSICAL_ENABLED`, opt-in: discovery is a read, but enrolling what it finds is not.
- The console tells REAL from VIRTUAL, and filters by kind (§25).
- `docs/PHYSICAL_DEVICES.md` — prerequisites (§8), enrollment, what a reset does and does not do.

**Two defects found doing it**, both invisible until a non-Cuttlefish host existed:

- **The agent could present the wrong credential at re-registration.** `resolveCredential` has
  accepted `mwk_` since 023 — the branch this ADR describes as "what lets a laptop plug in a second
  phone" — but the agent only ever sent its CONFIGURED token. On an operator-owned box that is the
  fleet secret and nothing was wrong. On an enrolled laptop it is an `mae_` token spent by the end
  of the first registration, and the agent re-registers whenever its capability fingerprint changes
   — which is exactly what plugging in a second phone does. Every enrolled host could therefore be
  started once. The `mwk_` branch was unreachable in practice, so nothing had ever exercised it.
  Re-registration now presents the host's own token, falling back to the configured credential on a
  401/403 so a genuinely dead token cannot strand a host either.
- **Host-level capabilities were three hardcoded literals.** `agent.ts` claimed `screen-stream`,
  `input-datachannel` and `snapshot-reset` for every host unconditionally — true by construction
  while every device everywhere was a Cuttlefish. A phone-only laptop would have registered
  claiming both of the two it cannot do. Nothing schedules on host capabilities, so the damage was
  confined to `hosts.capabilities` and `degradedCapabilities` telling an operator the opposite of
  the truth about their own fleet. Now derived per-device, the same way `app-install` already was.

Still open, and none of it blocks a pilot: the live view and interactive control (§20/§21), USB
hot-plug (discovery runs at startup; a restart picks up a new phone), failure classification (§18 —
an ADB drop still reports as a test failure), and a Windows agent (§5).
