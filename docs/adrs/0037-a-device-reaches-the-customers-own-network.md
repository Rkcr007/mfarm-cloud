# ADR-0037 — a device reaches the customer's own network

**Status:** Accepted · 2026-09-12 · migration 052

## Context

An app under test almost never talks to production. It talks to `staging.acme.internal`, which lives
on the customer's network and has no route from this farm — so **the single most common thing a team
wants to test is the one thing the product cannot do**. `docs/ltcomp/mfarm-ci-session-console-analysis.md`
lists it as a P1 gap; LambdaTest sells it as *Local Connection*, and it is the largest remaining
difference between that product and this one.

The naive answers are both wrong. Asking the customer to open a port is asking them to do the thing
their security team exists to prevent. Putting the farm on their VPN authenticates the network
rather than the request, which is what ADR-0004 already refused for the worker transport.

## Decision

**The side with the private network dials out**, exactly as every other tunnel in this repo does.
`npx @mfarm/cli tunnel` holds one socket open to the control plane, and a device's HTTP traffic is
routed onto it.

### The path, and who decides what

```
device ──HTTP proxy──▶ agent DeviceProxy ──agent tunnel, kind 'proxy'──▶ control plane
       ──router: device → session → org → tunnel name──▶ customer tunnel ──▶ staging.acme.internal
```

| | decides |
|---|---|
| **The agent** | nothing. It names **one device** — the only thing it legitimately knows. |
| **The control plane** | which org and which tunnel, **from rows** — the device's live session. |
| **The customer's client** | **what may be reached.** Default deny, `--allow` required. |

**The allow-list is enforced in the customer's client and nowhere else, and that is the point.** The
control plane is a switch between two sockets; it cannot know that `10.0.0.7` is a payroll database
and `staging.acme.internal` is the thing under test. A rule it enforced would be a rule the customer
had to take our word for, and a second authorization check that will eventually disagree with the
first. The client runs inside their network, was started by them, and is the only party that can
refuse from a position of knowledge.

### A device with no live session reaches nothing

Not bookkeeping — a security property. A device between tenants is freshly reset or waiting in the
pool, and letting it reach anything would mean whatever the last tenant left running on it could
still phone home into the **next** tenant's network. `routeFor` requires an `ACTIVE`/`ALLOCATING`
session and the org comes from that row.

### `mfarm:tunnel` is a name, not a boolean

An org can hold several — one per developer laptop, one on a CI runner — and "use the tunnel" is
ambiguous the moment there are two. Naming it also means a suite that asks for a tunnel nobody
started gets a 503 saying **which** one and how to start it, rather than a session that starts
happily and silently cannot reach anything. It is validated at session creation, because a
misspelling caught four minutes later has already cost a device, an install and a run.

### The channel id space is split by parity

This is the one structural change to an existing protocol. `TunnelFrame`'s `ch` was allocated by the
control plane alone — single-writer, no collision rule to get wrong. A `proxy` channel breaks that,
because a **device** decides when it wants to fetch something, so the agent is the side that opens
it. The control plane now allocates **even** ids and the agent **odd**, which is HTTP/2's trick for
the same problem: two single-writers over disjoint ranges, no handshake, nothing to lose on a
reconnect. Ids are opaque to both ends, so an agent built before this reads even ids exactly as it
read odd ones.

### A table that carries no traffic

`tunnels` (migration 052) is a **register**, not a route. The live socket is in memory in the
process holding it, like the agent tunnels, and nothing on the data path reads the table. It exists
for the three questions a socket cannot answer: which tunnels exist (so *"mine is down"* is
distinguishable from *"I never had one"*), what each was allowed to reach, and who opened it.

## Consequences

**No route creates a tunnel.** A row appears when a client connects. A tunnel that existed in a
database and nowhere else would be a promise the product cannot keep.

**Zero dependencies, and therefore Node 22.** The client is a program a customer runs inside their
own network; every dependency it has is one their security review has to read. It uses Node's own
`WebSocket`, which is unflagged from 22 — a floor that is checked and named rather than discovered
as `WebSocket is not defined` on somebody else's machine. The rest of the CLI still runs on 20.3.

**`https://` targets are not proxied yet.** An HTTPS request through an HTTP proxy is a `CONNECT`
expecting a raw byte tunnel, and the frame protocol carries a request and a response rather than a
TLS stream. The proxy answers 405 with a sentence saying so, because accepting the CONNECT and then
producing a socket that speaks nothing surfaces in an app as a certificate error and sends somebody
to debug the wrong thing. Closing it means a byte-stream channel kind alongside the framed one.

**One proxy listener per device.** A shared port would mean guessing which device a request came
from by source address — several Cuttlefish guests NAT through one host interface — and a guess on
this path is a guess about which tenant's network to open.

## What was found while building it

Four defects, and three of them only existed because the pieces were joined:

1. **A race that made the feature not work at all.** The agent sends `open` and the request head
   immediately; the router does a database lookup before it knows where the request goes. The head
   reliably arrived before there was anywhere to put it, so every successful request timed out after
   sixty seconds with nothing wrong in any log. The end-to-end test's signature was diagnostic:
   every *refusal* passed and every *success* hung. Frames are buffered until the router answers.
2. **One flag doing two jobs ate every response body.** `settled` meant both "the response started"
   and "this exchange is over", so each body chunk after the head was dropped — a correct `200` with
   zero bytes.
3. **The client never forwarded request bodies.** A `POST` is the ordinary case for an app talking
   to staging, so this would have failed on the second screen of every app.
4. **"Forget" looked broken because it worked.** Closing with 1001 is a fault the client retries, so
   forgetting a tunnel dropped it and the client re-registered one second later — the console said
   "No tunnels yet" while the API said one was connected. It closes 1008 now, which the client
   already treats as a refusal rather than a fault. **Found in a browser against a real client;
   every test was green.**

## What is NOT verified

**The device's proxy setting on real hardware.** Everything downstream of `adb shell settings put
global http_proxy <host>:<port>` is exercised by pointing a real HTTP client at the same listener,
which is what an Android guest does once that setting is in place. What has not been run is that one
command against a live Cuttlefish guest, and whether the setting survives the reset between
sessions. That needs a lab session and is recorded in `docs/STATUS.md` §4 rather than assumed here.
