---
id: ADR-0021
title: Both ends of the tunnel ping, because `close` is not guaranteed to fire
status: Accepted
date: 2026-09-02
authors:
  - Claude Code
tags: [tunnel, live-view, reliability, sockets, deploy]
extends: [ADR-0007, ADR-0011]
---

## Context

The data-plane tunnel is one long-lived WebSocket that the agent dials out to the control plane
(ADR-0011). Every recovery in `workers/agent/src/tunnel.ts` hangs off `ws.on('close')`: the
reconnect with its 1s→30s backoff, and `dropAllChannels`, which tears down the viewers riding the
tunnel.

**None of that runs if `close` never fires, and `close` does not fire when the far end vanishes
without a TCP FIN reaching us.**

`deploy/mfarm-deploy.sh` does exactly that on every deploy — it recreates the `mfarm-api-1`
container. Observed on the lab farm, 2026-09-02:

* 21:02:37 agent logs `data-plane tunnel connected`
* ~21:46 control plane reset; 22:41 API container recreated
* the agent journal is **completely silent** across both — no retry, no error
* `farm-check.sh` correctly reports `no agent tunnel connected — every live view is dead`

The farm looked perfect throughout. The heartbeat is plain HTTPS on a separate connection, so the
host kept beating, all four devices stayed `READY`, and the console showed a healthy fleet. Only the
live view was gone, and only until somebody restarted the worker by hand. Nobody would have known
without `mfarm_tunnel_hosts_connected`, the gauge added precisely because "devices READY" cannot
answer "can a browser see one".

Neither end sent WebSocket pings. There was no liveness probe of any kind on the one socket whose
entire job is to be there when someone opens a live view.

## Decision

**Both ends ping independently, and terminate a peer that stops answering.**

- The **agent** pings the control plane every `pingIntervalMs` (default 30s). A tick that finds the
  previous ping still unanswered calls `ws.terminate()`.
- The **control plane** pings every agent tunnel every `TUNNEL_PING_INTERVAL_MS` (default 30s), with
  the same rule.

Detection therefore takes between one and two intervals.

### Why both, and not one

They catch opposite failures and neither substitutes for the other. The agent's ping catches a
control plane that vanished under a running agent — the deploy case above. The control plane's ping
catches a device host that went away without saying so: a power cut, a network drop, a laptop lid
closing. Until such a tunnel is reaped, `tunnels.has(hostId)` answers true and `openChannel` hands
every viewer a channel whose frames go nowhere, which presents as a frozen picture rather than an
error.

`attach()` already replaces a stale socket when the *same* agent redials. That covers the agent that
comes back; the server ping covers the one that does not.

### Why `terminate()` and not `close()`

A graceful close is a handshake, and the premise is that the far end is not answering one.
`terminate()` destroys the socket locally, which **synthesises the `close` event the existing
recovery is already waiting for**. So this adds a detector and reuses the whole existing recovery
path — backoff, channel teardown, `dropHost` — rather than duplicating any of it.

### Why nothing is needed on the other end

`ws` answers a ping with a pong inside its receiver, with no application code. So each side's
keepalive works against any peer, including a control plane or an agent too old to ping back. The
two halves ship together here but do not depend on each other.

## Consequences

- A deploy costs at most ~60s of live view instead of costing it until a human restarts the worker.
  **The operational workaround — `systemctl restart mfarm-worker` after every deploy — is no longer
  needed**, which matters because that restart takes every Cuttlefish instance down with it.
- Both timers are `unref()`d. A keepalive must never be the reason a draining agent cannot exit, or
  the reason a test process hangs.
- Traffic is negligible: one control frame per side per 30s per host.

## What is deliberately not covered

**Browser channels are not pinged.** A half-open viewer socket still holds a channel against
`MAX_CHANNELS_PER_HOST` (32) until TCP notices. That is the same class of bug and it is real, but a
viewer is a short-lived socket behind a cap, not the farm-wide single point of failure this ADR is
about. Worth doing; not done here, and not to be assumed done.

## Testing

`workers/agent/test/tunnel-keepalive.test.ts` and a new block in `apps/api/test/tunnel.test.ts`, both
over **real sockets** — `app.inject()` cannot upgrade, close, or half-open a connection, and this
repo has already shipped 410 lines of green tests over a feature that worked 0% of the time through
exactly that blind spot.

The dead peer is simulated by **pausing the underlying socket** (`req.socket.pause()` server-side,
`res.socket.pause()` on the client's `upgrade` event). The connection stays ESTABLISHED and is never
closed; the paused side simply stops reading, so pings are never seen and never answered. That is the
production condition.

Both tests were verified to fail without the fix. The agent one **hangs** rather than failing — which
is the production symptom exactly — so it carries an explicit `timeout` to turn that into a named
failure instead of a CI job that runs until the runner kills it.
