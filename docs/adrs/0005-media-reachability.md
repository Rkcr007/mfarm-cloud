---
id: ADR-0005
title: Media reaches the browser through a TURN relay, not an overlay network
status: Accepted
date: 2026-08-19
authors:
  - Claude Code
tags: [media, webrtc, routing, deployment, product]
supersedes: []
resolves: [HANDOFF blocker 6]
---

> **Update 2026-08-19 — implemented and extended by [ADR-0007](0007-live-view-signaling-relay.md).**
> Everything decided here now exists and has run on hardware: coturn with per-session credentials,
> the split bind, and a browser driving a real device without client software. ADR-0007 answers the
> question this one left open — how the browser and the device *negotiate* — and records two things
> measurement contradicted: relayed media was not needed on the LAN path (a direct candidate won),
> and a snapshot-restored device publishes no display at all, which turns "media reachability" into
> a reset-mode decision this ADR could not have anticipated.

## Context

`dataplane.ts` carries control and input. **Media is not proxied**: the browser negotiates WebRTC
straight to Cuttlefish's own WebRTC server, which works only when the client can route to the
addresses the host puts in its ICE candidates. On the lab VM it could not, and the result was the
worst possible failure shape — a populated device list over a dead stream, with nothing in any log
saying why (HANDOFF known issue 13).

The situation got narrower, not wider, while this was open. To let the containerised control plane
reach the automation gateway, the worker now binds the data plane to the compose bridge address
(`172.18.0.1`). That is host-local by construction: a browser anywhere else cannot reach it at all.
Automation is unaffected — it is HTTP and TCP end to end, and it is the path `verify-webdriver.mjs`
exercises — but interactive video has no route to a client today.

ADR-0004 rejected a VPN and **that reasoning does not transfer here**, which is the thing most likely
to be misread. ADR-0004 rejected a VPN as an *authorisation* mechanism, because a network grants
every peer access to every device — the exposure loopback binding exists to prevent, moved inside the
perimeter. Media reachability is a *routing* problem. The signed Ed25519 grant already answers the
authorisation half and keeps answering it here: `dataplane.ts` verifies the token offline, per
request, whatever route the packets took.

## Decision

**Media reaches the browser through a TURN relay. The farm requires no client software.**

The deciding requirement is a product one, and it is not reversible by cleverness later: the farm is
to be used by people the operator does not administer, through a browser, and those people cannot be
asked to enrol a device in a tailnet before they can look at a phone. An overlay makes the client a
participant in the operator's network; a relay does not.

Concretely:

- **coturn on the host**, with credentials minted by the control plane per session, scoped to the
  session's lifetime — the same shape as the automation grant, so there is one story for "a
  credential names a session" rather than two.
- **The signed grant remains the authorisation**, unchanged. The relay is a route and is never
  treated as proof of anything. Anyone who can reach the relay still cannot drive a device without a
  token naming session, device, org, fence and host.
- **The data plane stops binding to the docker bridge.** That binding was a workaround for the hub
  reaching the automation gateway (known issue 15); it makes the data plane unreachable to every
  client. The two needs are separated: the automation gateway keeps a host-local bind, and the data
  plane binds where a client can reach it.

## Consequences

**What this costs, stated plainly.** A relay is a process to run and bandwidth to pay for, and
relayed media is strictly worse than a direct path — an extra hop of latency and an egress bill that
scales with concurrent viewers rather than with devices. Interactive video is now the one part of
this system whose marginal cost is not "a device for a while". That is the price of a browser-only
product and it was accepted knowingly.

**What it buys.** A user with a URL and a password can see a device. No enrolment, no client, no
support burden explaining why a tailnet is required to view a phone. It also removes the last reason
a *public* product could not be built on this architecture, which the overlay option would have
foreclosed.

**ICE, honestly.** TURN is the fallback tier of ICE, not a replacement for it. Where a direct or
reflexive candidate does work, it will still be used and should be — the relay exists so that
connectivity does not *depend* on it. This means the media path has two modes in production and both
must be exercised; a viewer tested only on a LAN has not been tested.

**Not decided here.** Relay placement (same host as devices, or separate), whether egress needs
per-org accounting, and TLS termination for the relay. All three are deployment questions that this
decision makes it possible to answer, and none of them change the shape above.

## Alternatives

**Tailscale overlay.** Already installed on the lab VM and already chosen for `deploy/` ingress, so
it is close to free to adopt and costs no relay bandwidth. Rejected on the product requirement: every
end user needs a client and an invitation to the operator's tailnet. It remains entirely appropriate
for *operator* access — SSH, dashboards, the observability stack — and this decision does not remove
it from there.

**Proxying media through the data plane.** The worker already terminates a listener the browser
reaches, so it could carry frames too. Rejected because it puts a transcode-or-forward path in the
worker's hot loop for every viewer, and Cuttlefish's native WebRTC stack — the reason this tier was
chosen over the AVD emulator at all — already produces exactly what a browser consumes. TURN relays
that stream without re-originating it.

**Doing nothing until a viewer is built.** Rejected explicitly: the binding choice is already made
today, wrongly, and every hour of viewer work done against a host-local data plane is work done
against a route no user has.
