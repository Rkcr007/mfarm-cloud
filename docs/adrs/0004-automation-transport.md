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

**Both halves are implemented as of 2026-08-17**, together with the B2 protocol change they shared a
field with.

**Control-plane half.** The hub mints a grant and sends it on every upstream request — `POST /session`
and every proxied command. Against a bare Appium the header is simply ignored, which is why this was
safe to ship first.

**Worker half — `workers/agent/src/gateway.ts`.** All four points landed:

1. an HTTP listener on the worker, `/automation/:localId/*` (`AUTOMATION_GATEWAY_PORT`, default 8090);
2. `verifySessionToken(bearer, publicKey, ownHostId)`, then `claims.did === deviceIdFor(localId)`,
   then `acceptFence(did, claims.fence)` — in that order, with no path to the proxy that skips one;
3. a path-transparent proxy to `127.0.0.1:<port for that device>`, streaming both ways, bounded by
   the same 16 MB limit the hub enforces and with a 300s upstream deadline (the hub's new-session
   timeout — anything shorter severs sessions the hub is still legitimately waiting for);
4. `devices[].automationEndpoint` pointing at the gateway rather than at Appium.

Two decisions worth recording that the original spec did not state:

- **`authorization` is stripped before proxying.** Appium would not check the grant, and forwarding a
  bearer token to a process that logs its requests is how credentials reach a log file. It is in the
  hop-by-hop set alongside the RFC 9110 §7.6.1 list.
- **An unknown device and a non-automation path return an identical 404.** Distinguishing them lets
  an unauthenticated caller enumerate the host's devices.

**B2 is resolved, not merely accommodated.** `WorkerRegistration.devices[].automationEndpoint` (v2)
carries one endpoint per device, `devices.automation_endpoint` stores it (migration 010), and the hub
reads `COALESCE(d.automation_endpoint, h.automation_endpoint)` so v1 workers are unaffected.
`index.ts` no longer refuses to start Appium on a multi-device host, and the `derivePort` collision
check the old comment asked for is reinstated now that a second supervisor can actually exist.

**A third change was forced by the second.** The gateway authorizes a grant's `claims.did` — a
uuid — against a path segment that is a local id, and only the control plane knows both. Registration
now returns `deviceIds` (localId -> uuid). Before v2 `resolveDeviceIds` returned `{}` and the agent
inferred the mapping from whatever session token arrived, which is fine for the data plane and
unusable here: the gateway must decide before it proxies anything. An agent that cannot resolve the
mapping refuses rather than trusting the path.

**Unverified.** No real Appium 2, no real device, no second machine. The gateway has been tested
against a fake upstream that answers correctly; a real driver will disagree about something. The
numbers that would justify or refute the extra hop still do not exist.

## Verification

```bash
cd apps/api      && node --test --experimental-strip-types test/webdriver.test.ts
cd workers/agent && node --test --experimental-strip-types test/gateway.test.ts
cd workers/agent && node --test --test-concurrency=1 --experimental-strip-types test/agent.test.ts
```

Control-plane side: every upstream request carries a bearer grant; the grant verifies against the
server's public key; its claims name the session, the device and the host that was actually
allocated; it is not accepted for another host.

Worker side (17 tests, mostly about what is REFUSED): no grant, a grant signed by another key, an
expired grant, a grant minted for another host, **a valid grant for a different device on the same
host**, a stale fence, a fence below the high-water mark, an unregistered host. Then: path-transparent
proxying with method/query/body, `base + '/session'` unchanged, the bare base becoming `/`, the grant
not reaching Appium, verbatim upstream status, an oversized body, and an unreachable Appium as 502
rather than a hang.

The fifth refusal is the one this ADR exists for. Nothing is wrong with that grant's signature — the
authorization is wrong, and it is the check no network transport could have made.

## Superseded in part by ADR-0011

Point 3 said `automation_endpoint` advertises the gateway on the worker's own **public** listener,
and `gatewayBase()` enforced that by refusing to start without an externally-reachable name. That is
still correct for a rented box with a public interface, and it is still the first thing tried — but
it is no longer the only answer. A physical device arrives on a laptop behind NAT, which has no such
name, so ADR-0011 adds `mfarm+tunnel:` as a third option: automation rides the socket the agent
already dials out, and the agent replays each request against **this same gateway** on loopback.

Nothing in points 1, 2, 4 or 5 changes. The gateway is still the only thing that can reach Appium,
it still verifies every grant offline, and it still refuses a grant for the wrong device. That was
the condition for tunnelling anything at all.

## Related

- `ADR-0011` — the tunnelled transport for a worker nobody can dial
- `ADR-0003` — B1, the blocker this resolves, and decision 4, which it preserves
- `apps/api/src/tokens.ts`, `packages/protocol/src/tokens.ts` — the minting and verifying halves
- `workers/agent/src/appium.ts` — `advertiseHost`, the seam this names
- `HANDOFF.md` — blockers 2 and 3
