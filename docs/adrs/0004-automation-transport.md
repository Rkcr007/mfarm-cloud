---
id: ADR-0004
title: The worker terminates the automation transport — a signed grant, not a private network
status: Accepted
date: 2026-08-16
authors:
  - Claude Code
tags: [deployment, webdriver, appium, security, transport]
supersedes: []
resolves: [ADR-0003 B1]
---

## Context

ADR-0003 decision 4 binds Appium to `127.0.0.1`, because an internet-facing Appium port is
unauthenticated device control — whoever finds it owns every device behind it. The hub
(`apps/api/src/http/routes/webdriver.ts`) calls `fetch(automation_endpoint + '/session')` from the
API process. Both are right and they do not compose: a loopback-bound Appium is not reachable from
another machine, so `APPIUM_ENABLED=1` currently produces a host the hub cannot talk to.

That was recorded as blocker B1 with the shape of the answer already visible — `APPIUM_ADVERTISE_HOST`
splits the advertised address from the bind address, naming a transport that terminates on the worker
without loosening the bind — and the transport itself left undecided. **No such transport exists
anywhere in this repo or in the deployment story**, and it is on the critical path for WebDriver on
real hardware.

Four facts about this system decided the answer, and all four are already true today:

1. **Workers are not on one network.** The gate needs bare metal with `/dev/kvm`, priced hourly, and
   the candidates named in `HANDOFF.md` are three different providers. A fleet that spans providers
   has no shared L2, and it should not need one to add a host.
2. **Workers already terminate public TLS.** `hosts.endpoint` is `wss://worker-1.example:8443` and
   the *browser* connects to it directly from the internet — that is v2 decision 2, the reason
   glass-to-glass can be under 100ms. A worker is already an internet-facing server with a
   certificate. Automation is not a new exposure class; it is a second path on an existing listener.
3. **Workers already verify control-plane signatures offline.** Registration hands back
   `sessionPublicKey`, and `verifySessionToken` lives in `packages/protocol` precisely so a worker can
   verify without calling home. The worker holds the public half only and can never mint.
4. **The control plane already knows everything a grant needs to say.** At the moment the hub dials
   upstream it holds the session id, the device id, the org, the fence and the host id. Those are
   exactly the fields of `SessionClaims`.

## Decision

**The worker terminates the automation transport itself, on its own listener, and authenticates each
request with a short-lived signed grant from the control plane. No VPN, no mesh, no private network
is required, and none is assumed.**

**1. Appium stays bound to `127.0.0.1`.** Unchanged from ADR-0003 decision 4. Nothing outside the
worker ever connects to Appium.

**2. The agent runs an automation gateway** on the worker's public interface, at
`/automation/<deviceLocalId>/*`, and proxies path-transparently to that device's loopback Appium. It
is the only thing that can reach Appium, and it is code we own — unlike Appium, which has no concept
of a tenant.

**3. `automation_endpoint` advertises the GATEWAY, not Appium.** It becomes
`https://<host>:<port>/automation/<deviceLocalId>`. The hub's existing `base + '/session'`
concatenation keeps working unchanged; this is a change of what the URL points at, not of how the hub
uses it. `APPIUM_ADVERTISE_HOST` keeps its meaning as the externally-reachable name for the worker.

**4. Authorisation is a session token, reused verbatim.** The hub mints one with
`mintSessionToken({ sid, did, org, fence, aud: hostId }, …)` and sends it as
`Authorization: Bearer …` on every upstream call. The gateway verifies the signature against the
public key it already holds, requires `aud` to be its own host id, requires `did` to match the device
in the path, and rejects anything expired. **No new token type, no new key, no new distribution
problem** — the mechanism that already lets a browser prove it may drive a device is the same
mechanism that lets the hub prove it.

**5. Grants are short-lived and per-request.** 120 seconds, minted fresh for each proxied command.
A leaked grant is worth one device, on one host, for two minutes.

### Why not WireGuard

It is the obvious answer and it is worse here on both axes.

*Operationally*, it means a mesh spanning three hosting providers, key distribution and rotation for
every new host, an MTU class of bug that presents as "some screenshots hang", and one more thing that
can be down between the control plane and every worker simultaneously.

*Security*, and this is the decisive half: a VPN authenticates the **network**, not the request.
Every peer on that network can reach every worker's Appium port, which is unauthenticated device
control — so a single compromised worker owns the fleet's devices. The blast radius is exactly the
one decision 4 of ADR-0003 was written to prevent, moved inside the perimeter where nobody is looking
at it. A signed, device-scoped, two-minute grant gives a compromised worker nothing it did not
already have: its own devices.

An operator who wants a VPN as well can still have one — the gateway does not care what carried the
packet. This decision is about what the system *requires*, and it requires no network topology.

### Why not mTLS to Appium directly

Appium can serve TLS but has no authorisation model: a valid client certificate would authenticate
*a* peer, and every peer would then have full control of every device on that server. It also puts
certificate rotation on Appium's configuration surface, which ADR-0003 already flags as moving
between major versions. The gateway is a few dozen lines and is ours.

## Consequences

**Positive.** A worker is added by giving it a URL and a registration token — no network
provisioning, so the fleet can span providers and regions freely, which is what the hourly bare-metal
sourcing in the gate actually requires. Every automation request carries proof of which session and
which device it is for, so the gateway can refuse a request for a device that is not currently
allocated to that session — an authorisation check no network transport could make.

**Positive.** The fence travels with the grant. A partitioned hub replaying an old command carries a
stale fence, and the worker already knows how to reject that (`acceptFence`).

**Negative.** The agent now runs a public HTTP listener whose correctness is a security boundary. It
must be path-transparent, must not follow redirects, must cap request size, and must never fall back
to unauthenticated proxying — a bug that makes it "temporarily" skip verification is an open Appium
on the internet. It is the highest-value component in the worker to review.

**Negative.** One more hop on WebDriver commands (hub → gateway → Appium). Both hops are already
counted as acceptable in the hub's own header comment: these are commands taking tens to hundreds of
milliseconds inside the device, and none of this touches the glass-to-glass path.

**Negative.** The worker needs a certificate for its public name. It already does, for the data plane.

## What is implemented, and what is not

**Implemented (control-plane half).** The hub mints a grant and sends it on every upstream request —
`POST /session` and every proxied command. Against a bare Appium the header is simply ignored, so
this is safe to ship before the gateway exists and means the day the gateway lands, nothing in
`apps/api` has to change.

**Not implemented (worker half).** `AutomationGateway` in `workers/agent`. Until it exists,
`APPIUM_ADVERTISE_HOST` plus an operator-provided private path remains the only way to make
`APPIUM_ENABLED=1` reachable, and that is still the documented escape hatch rather than the design.
The gateway is the next piece of work on the WebDriver path, and it needs:

1. an HTTP listener on the worker, `/automation/:localId/*`;
2. `verifySessionToken(bearer, publicKey, ownHostId)`, then `claims.did === <the device with that
   localId>`, then `acceptFence(did, claims.fence)`;
3. a path-transparent proxy to `127.0.0.1:<port for that device>`, streaming both ways, with the body
   limit the hub already enforces;
4. `automationEndpoint` in the registration payload pointing at the gateway rather than at Appium.

Point 4 collides with **B2** (`automationEndpoint` is host-level, so a multi-device host cannot
advertise per-device endpoints). The gateway does not fix B2 and does not make it worse: the endpoint
is still one string per host. B2's protocol change — moving `automationEndpoint` onto the device — is
what lets the `<deviceLocalId>` in the path differ per device, and the two should land together.

**Unverified.** No real Appium 2, no real device, no second machine. Nothing here has been tested
against a real network, and the numbers that would justify or refute the extra hop do not exist yet.

## Verification

```bash
cd apps/api && node --test --experimental-strip-types test/webdriver.test.ts
```

Covers: every upstream request carries a bearer grant; the grant verifies against the server's public
key; its claims name the session, the device and the host that was actually allocated; it is not
accepted for another host.

## Related

- `ADR-0003` — B1, the blocker this resolves, and decision 4, which it preserves
- `apps/api/src/tokens.ts`, `packages/protocol/src/tokens.ts` — the minting and verifying halves
- `workers/agent/src/appium.ts` — `advertiseHost`, the seam this names
- `HANDOFF.md` — blockers 2 and 3
