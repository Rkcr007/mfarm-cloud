---
id: ADR-0026
title: The device page shows a heartbeat, not a hostname
status: Accepted
date: 2026-09-05
authors:
  - Claude Code
tags: [console, devices, tenancy, privacy, design-package]
extends: [ADR-0016]
---

## Context

Document 05 §03 of the design package specifies the device detail screen — "the operator's page" —
and its metadata grid reads:

| | |
|---|---|
| Platform | android 16 |
| Screen | 1440 × 3088 |
| Reset story | install-reset |
| Tier | physical |
| **Host** | **lab-host-02** |
| **Last seen** | **2d ago** |

Four of those six were already available to the console. The last two were not, and they are not
missing for the same reason.

**`Last seen` had no honest source.** The obvious one, `devices.updated_at`, is written on a state
change and on a re-registration — and registration happens when the agent starts and when its
fingerprint moves, *not* on the ten-second beat. A healthy device sitting idle in the pool would
have reported "last seen 6 days ago", which is worse than showing nothing: it is a number that
looks like evidence of a problem the farm does not have. The real liveness signal is
`hosts.last_heartbeat_at`.

**`Host` had a source and a boundary.** Migration 002 states the boundary in one line —
`REVOKE ALL ON hosts FROM mfarm_app` — with the comment "hosts stay unexposed to tenants entirely".
Both fields live behind it.

## Decision

**The device page shows `Host last seen`. It does not show the hostname.**

`GET /v1/devices/:id` gains a single field, `hostLastSeenAt`, read on the system pool *after* the
tenant read has decided the device is visible — the same ordering, and the same reasoning, as
`/v1/devices/:id/reset-attempts` documents for `device_reset_attempts`. RLS on `devices` is the
authorisation; the second read is keyed to a device id that already survived it.

### Why the timestamp is not a leak and the hostname is

A heartbeat **adds no fact a tenant cannot already infer.** A host that stops beating is quarantined
by the reaper, and its devices go `OFFLINE` or `QUARANTINED` — states the tenant already reads on
this very screen. The timestamp sharpens the resolution of something visible; it does not disclose
something hidden.

A hostname is different in kind, because it is **stable and it is an identifier.** Given it, a
tenant can count the farm's machines, watch that count change over time, and — crucially — group
their own devices by host and confirm, permanently, which of their devices sit beside which of
somebody else's. Co-tenancy inferred from a shared outage is noisy and transient. Co-tenancy read
off a label is neither.

And the asymmetry that settles it: **a tenant cannot act on a hostname.** They cannot ssh to
`lab-host-02`, restart it, or file a ticket against it that anybody will route differently. The
operator who *can* act reaches the host through the farm's own tooling, where the name is already
in front of them. So the field costs a permanent co-tenancy signal and buys the reader nothing.

### The field is named for what it measures

`hostLastSeenAt`, rendered as **"Host last seen"** — not "Last seen". A device can be unplugged from
a host that is beating perfectly, and a row labelled for the *device* would then be quietly
reassuring about the wrong machine. This is ADR-0016's rule about geometry applied to liveness: the
label names its source, so a reader can tell what a stale value would mean.

## Consequences

**The design package's grid ships with five of six rows and a sixth that says something else.** That
is a visible divergence from a document this project is otherwise implementing faithfully, and it is
recorded here rather than absorbed silently — the next person to open 05 §03 beside the running
console will see `Host` missing and needs to find this file, not re-add it.

**A second pool read on a tenant route.** It is the second instance of this pattern rather than the
first, and it is bounded the same way: the tenant read is the gate, the system read is keyed to its
result, and the system read selects exactly one column. A test asserts the hostname is absent from
the *whole serialised body*, not from a named key, because the way this regresses is somebody adding
`host: { ... }` in one go and the name riding along inside it.

**If an operator console is ever built, this decision does not bind it.** The boundary here is
tenant-facing. A page authenticated as farm staff has a different reader and can show the topology;
what it must not do is reach that reader through `mfarm_app`.

## Alternatives considered

**Show the hostname to org admins only.** RLS and grants are pool-level, not role-level, so this
needs a `SECURITY DEFINER` function and a role check inside it. Rejected on the value side rather
than the cost side: an org admin is still a tenant, and the argument above — they cannot act on it —
applies to them unchanged.

**Show a stable pseudonymous host id** (`host-3`, or a hash). It preserves the grouping property
that is the actual concern while hiding the name, which makes it the *worst* of the three: it leaks
exactly the co-tenancy signal and none of the operator value.

**Use `devices.updated_at` and label it "Last registered".** No new read, no boundary crossed, and
honest as long as the label is exact. Rejected because it answers a question nobody has. "When did
this device last re-register" is a fact about the agent's restart history; "is the farm still
hearing from the machine behind this device" is what somebody staring at a quarantined handset
needs, and only the beat answers it.

**Ship the row as `Host —`, empty.** Keeps the design's shape. Rejected: an empty row invites
somebody to fill it, which is the failure this ADR exists to prevent.
