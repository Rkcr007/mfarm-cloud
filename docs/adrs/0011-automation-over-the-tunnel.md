---
id: ADR-0011
title: Automation rides the agent's tunnel, and the gateway binds loopback
status: Accepted
date: 2026-08-26
authors:
  - Claude Code
tags: [transport, webdriver, appium, security, physical-devices, nat]
supersedes: []
extends: [ADR-0004, ADR-0008, ADR-0009]
---

## Context

ADR-0004 decided that the worker terminates the automation transport on **its own public listener**,
and that decision was right for the fleet it was written about: rented bare metal, priced hourly,
across three providers, each box with a public name and a certificate it already needed for the data
plane. `automation_endpoint` became `https://<host>:<port>/automation/<localId>`, and the hub dials
it.

ADR-0008 then put a physical handset behind the same agent, and in doing so inverted the **data**
plane: `/dp/<hostId>` stopped being an ingress rule pointing at one worker and became a channel on a
socket the agent dials out. The reason it gives is exactly the case physical devices arrive in — *"a
phone on a teammate's laptop, behind NAT, with nothing listening and no address to put in a config
file."*

**Automation was not inverted with it, and the gap is load-bearing.** `gatewayBase()` in
`workers/agent/src/index.ts` throws unless `AUTOMATION_ADVERTISE_BASE` or
`APPIUM_ADVERTISE_HOST`/`PUBLIC_HOST` names a reachable host. On `mfarm-lab` that is
`10.160.0.2` — its VPC address, which works only because the control plane is on the same private
network and dials it directly. A laptop has no equivalent. `deploy/install-worker-service.sh`
derives it from `hostname -I`, which does not exist on macOS at all, so the enrollment path for the
machine this product is *for* fails before it starts.

Three things follow from that, and they are why this is an ADR rather than a config change:

1. **`APPIUM_ENABLED=1` cannot start on a NAT'd host.** Not "degrades" — throws at boot. So the
   cheap MVP split named in the physical-device work (automation-only physical devices first,
   live view second) is blocked on its *only* feature.
2. **It contradicts ADR-0009 §3.** That ADR's security model states plainly that *"nothing listens
   on the network (the agent dials out, so there is no inbound port to find)"*. With automation on a
   public listener that sentence is false on any host serving WebDriver, and it is false in the
   security section of the document that decides how this ships to strangers.
3. **There is no tunnel path for automation to fall back to.** The data plane is tunnelled and the
   automation gateway is not; nothing in the tree bridges them.

## Decision

**Automation rides the socket the agent already holds open, and the agent serves it by replaying the
request against its own gateway on loopback.**

### 1. A second channel kind on the existing tunnel

`TunnelFrame`'s `open` gains `kind?: 'dp' | 'automation'`. Absent means `dp`, which is what an agent
built before this reads it as, and a new control plane only ever sends `automation` to an agent that
advertised a tunnelled endpoint — so version skew resolves itself with no version check.

Not a second WebSocket. The agent already holds one authenticated, backoff-managed, replace-on-
reconnect connection per host, and a second one would be a second thing to get wrong on a lid-close.

### 2. `mfarm+tunnel:` is how a device says it is not dialable

`automation_endpoint` becomes `mfarm+tunnel:/automation/<localId>` on a tunnelled host. A scheme
rather than a flag column, because that column is **already** the one string that says how to reach a
device's automation, and the hub already concatenates onto it (`base + '/session'` still works
untouched). It carries no authority component: the agent composes it *before* it has registered and
therefore does not know its own host id — and does not need to, because the hub reads the host from
`devices.host_id`, which it has already joined in order to mint the grant's `aud`.

Nothing in Node knows what to do with this scheme, which is the point: an endpoint that must not be
fetched cannot be fetched by accident.

### 3. The agent replays against its OWN gateway — the checks do not move

This is the decision the rest of it exists to protect. The tunnelled request is turned back into an
ordinary HTTP request to `127.0.0.1:<gatewayPort>`, `Authorization` header and all, so
`gateway.ts` performs signature, audience, device and fence verification exactly as it does for a
directly-dialled request, in the same code, with no branch that knows a tunnel exists.

The alternatives were to verify in the tunnel handler, or to trust the control plane because the
tunnel is authenticated. Both were rejected for the reason ADR-0008 gives about the data plane: *an
authorization check that exists twice is a check that will eventually disagree with itself.* The
second is worse than it looks — it would make the control plane's compromise equal to the fleet's,
which is precisely what ADR-0004's refusal of a VPN was protecting against.

The cost is one loopback hop per command, on a path already measured in tens to hundreds of
milliseconds inside the device.

### 4. On the tunnelled path, the gateway binds `127.0.0.1`

Since the only client is the agent itself, the listener does not belong on any other interface. This
is what makes ADR-0009 §3 true rather than aspirational: on a laptop there is now genuinely nothing
listening on the network. An explicit `AUTOMATION_BIND_HOST` is still honoured — an operator who set
one is describing a deployment we cannot see — but nothing widens it by default, and the tunnel
connects to whatever was actually bound rather than assuming loopback.

### 5. Precedence: an operator's public address still wins

`AUTOMATION_ADVERTISE_BASE`, then `APPIUM_ADVERTISE_HOST`/`PUBLIC_HOST`, then the tunnel. The
existing farm sets the second and therefore **stays on the path it was verified on** — this ships
without a flag day. The tunnel is the fallback, not the default, because an operator who named a
public address has said something about their deployment and quietly routing around it would be this
code overruling them. With neither a public name nor a tunnel (`MFARM_TUNNEL=0`) it still throws:
there is genuinely nowhere to advertise, and registering an endpoint only that machine can reach is
the failure this check exists to prevent.

### 6. Automation channels get their own budget

`MAX_CHANNELS_PER_HOST` (32) exists because `/dp/*` takes no credential. Automation channels are
opened by the hub for a device it has already allocated, so they are counted separately against
`MAX_AUTOMATION_CHANNELS_PER_HOST` (64). Sharing one budget would let anyone who knows a host id
open 32 unauthenticated sockets and stop that host serving WebDriver — a denial of service on the
paid path, mounted from the free one.

### Why not ngrok, cloudflared or Tailscale

They solve exactly this and are the reason the shape is familiar. They are refused here as a
*requirement*: each is a third-party dependency in the automation path, a second credential to
provision and rotate per host, and a second thing that can be down between the hub and every worker.
The agent already holds a tunnel that has none of those properties. An operator who wants one can
still have it — it terminates at `APPIUM_ADVERTISE_HOST`, which keeps working.

### Why not make the tunnel the only path

It would delete the precedence rules and a branch in `callUpstream`. It would also move the verified
farm onto an unverified transport on the same commit that introduces it, and the direct path is one
hop shorter for a host where it genuinely works.

## Consequences

**Positive.** A laptop behind NAT can serve WebDriver, which unblocks the physical-device MVP split.
`APPIUM_ENABLED=1` no longer needs an externally-reachable name, a certificate, or an open port on
any host. ADR-0009 §3's security claim becomes literally true. The data plane and the automation
plane now reach a worker the same way, so there is one story about NAT rather than two.

**Negative — the control-plane process is now in the WebDriver path in a new way.** It was already
the proxy (ADR-0004 point 3 note, and the hub's own header comment), but a dropped tunnel now fails
commands as well as viewers. `mfarm_tunnel_hosts_connected` already alerts on it.

**Negative — the hub buffers whole request and response bodies on this path.** It already did:
`callUpstream` ends in `res.text()`. The agent's side streams, which is the end that holds a device's
Appium open. Bodies are chunked at 512 KB because a tunnel frame is capped at 8 MB and the hub's body
limit is 16 MB — a `pushFile` of a large APK is a real request a single-frame encoding would drop.

**Negative — one more encoding to keep in step.** Request and response framing now exists on both
sides of the fleet boundary. Both are driven by types in `packages/protocol` and neither may
reinterpret them, which is the same containment the data plane's `d`-is-an-opaque-string rule uses.

**Unverified.** No real Appium and no real handset have been through this path. The hop it replaces
was itself only ever tested against a fake until `deploy/verify-webdriver.mjs` ran on the farm; this
one has not run on hardware at all yet.

## Verification

```bash
npm run typecheck
cd workers/agent && node --test --test-concurrency=1 --experimental-strip-types test/automation-tunnel.test.ts
cd apps/api      && node --test --test-concurrency=1 --experimental-strip-types test/automation-tunnel.test.ts
```

Both files bind real sockets, for the reason `apps/api/test/tunnel.test.ts` states: `app.inject()`
cannot upgrade a connection, and this repo has already shipped a green suite over a feature that
worked 0% of the time by testing everything except the socket.

**Worker side (11 tests)** — a real `AgentTunnel`, a real `AutomationGateway` and an HTTP server
standing in for Appium. A command reaches Appium path-transparently and its answer comes back; a
query string survives both hops; a request with **no grant** is refused 401 and Appium is never
reached; a valid grant **for another device on the same host** is refused 403; the grant **never
reaches Appium**; bodies and responses larger than one chunk arrive whole; an upstream 404 is
relayed verbatim; a host serving no automation refuses the channel with a reason; a second request
on one channel is refused; a dropped tunnel reconnects and serves the next command.

The middle three are the ADR: they are the ADR-0004 checks, still running, reached through a
transport that did not get an opinion about them.

**Hub side (8 tests)** — the real `TunnelRegistry` behind a real Fastify server, with an agent that
answers frames by hand. Round trip with the grant travelling intact; chunked request and response
reassembly; an agent-side failure surfacing as a rejection carrying its message; a host with no
tunnel rejecting rather than hanging; a tunnel dropping mid-command failing that command rather than
stranding it; a silent agent tripping a deadline that is *named* `TimeoutError`, because the proxy
route reads `e.name` to tell a timeout from a dead host; and 32 unauthenticated viewers failing to
starve the automation budget.

**Still required, and not done here:** `deploy/verify-webdriver.mjs` against a real handset over
this transport. That is the gate ADR-0008 set and it stays open until it runs.

## Related

- `ADR-0004` — the transport this extends; its gateway, grant and refusals are unchanged
- `ADR-0008` — the data-plane inversion this completes for automation
- `ADR-0009` §3 — the security claim this makes true
- `workers/agent/src/automation-tunnel.ts`, `apps/api/src/http/automation-tunnel.ts` — the two halves
- `docs/PHYSICAL_DEVICES.md` — the enrollment path this unblocks
