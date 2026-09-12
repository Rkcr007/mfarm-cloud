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

**Zero dependencies, and the wire definitions are VENDORED to keep it that way.** `@mfarm/protocol`
is `private: true` and exports raw TypeScript, so a published tarball importing it fails to resolve
on a customer's machine — and because `bin.ts` imports the tunnel module at the top level, that took
down the *whole* CLI, not just this command. CI caught it. `apps/cli/src/wire.ts` is generated from
the protocol's marked regions and committed, with a drift test that re-runs the generator in memory
— the same arrangement `apps/api/public/icons.js` already has, and the only one that keeps the
install cost at zero. There is still one source of truth; the test is what makes "copied" mean
"checked". A fifth test asserts that no file under `apps/cli/src` imports a workspace package at
all, because that is the defect rather than its symptom.

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

## Amendment, 2026-09-12 — the last hop is BUILT, and it was not before

**This ADR was accepted while the feature could not work.** Everything above is true of the parts;
nothing joined them to a device. `DeviceProxy` had exactly one caller in the repo and it was its own
test — nothing in `workers/agent` ever constructed one, so no listener existed on any farm — and
nothing anywhere ran `settings put global http_proxy`, so no guest was ever pointed at one. The
section this replaces called that gap "one `adb` command not yet run against a live guest". It was
not a command waiting to be run; it was a hop with no code behind it, described as tested because
everything *downstream* of it was.

The end-to-end test is the reason this was invisible. It stands a real `DeviceProxy` up itself and
points an HTTP client at it, which is a faithful model of what an Android guest does **once the
setting is in place** — and therefore proves every link except the one that puts it in place. A
green suite said the feature worked; a farm would have said `mfarm:tunnel` did nothing at all.

### What was added

**The control plane OFFERS, the agent CONVERGES.** `WorkerHeartbeatResponse.proxies` carries the
full set of this host's devices whose live session named a tunnel, re-sent on every beat — the same
shape as `resets`, for the reason that shape exists: nothing on a device host listens, so anything
delivered once can be missed once. The agent makes its devices match the set. A device that stops
appearing has its proxy turned off, so **a session ending is the whole teardown** — there is no
"proxy off" message to lose, which matters more here than anywhere else in the worker, because what
leaks when a teardown is missed is a live route from a device into somebody's private network and
the device is about to be handed to a different tenant. Everything uncertain resolves to OFF: a beat
that does not arrive changes nothing, and a control plane too old to send the field sends none,
which reads as "nobody".

**The offer names a device and never the tunnel.** Architecture rule 4 on the path where it matters
most, and the same chain `routeFor` walks — asked one beat earlier, because a guest has to be TOLD
to use a proxy and an Android setting is not applied by a request arriving.

**The listener binds the address the DEVICE named, read off the guest.** cvd gives every instance
its own /30 with the host at the other end — `cf-1` on 192.168.97.2 with the host at .1, `cf-2` on
.6 with the host at .5 — so the proxy binds that gateway and a request arriving on it came from that
device's subnet by construction. It is read from the guest's own routing table rather than computed
from the instance number: the arithmetic is right until cvd renumbers, and a listener bound to a
wrong-but-plausible address fails as a sixty-second timeout rather than as an error. The trap in
parsing it is real and is pinned by a test against a captured table — the guest also carries
`default dev dummy0`, Android's "this network goes nowhere" placeholder, and it comes FIRST.

### `mfarm:tunnel` now requires a capability, which reverses one paragraph above

The **NOT AN ALLOCATION CONSTRAINT** reasoning said `mfarm:tunnel` narrows nothing because "every
device on this farm can proxy". That was true only in the sense that no device could: nothing
applied the setting anywhere, so there was nothing to differ about. Now that Cuttlefish implements
it and an iOS simulator cannot, the choice is between refusing the allocation up front and handing
back a device that installs a build, runs for four minutes and reaches nothing.

So a session naming a tunnel requires **`network-proxy`**, derived by the hub and by `POST
/v1/sessions` rather than demanded of the caller — a client should not have to know the second name
to ask for the first thing. It still does not narrow by device CLASS, which is what that paragraph
was protecting. The capability is **observed, never configured**: `cuttlefish.ts` declares it only
after a guest actually answers with a gateway, which is ADR-0003's rule and the rule this repo has
broken by declaring `recording` with nothing behind it.

**Physical handsets do not declare it yet, deliberately.** `settings put global http_proxy` works
over adb on a handset; what the agent cannot honestly answer is *which* host address that phone can
reach, since it depends on a LAN nobody here has observed. Reading it from configuration would be
exactly the ADR-0003 violation named above, and the failure it produces — a proxy bound to an
address the phone cannot route to — is a silent timeout. A tunnelled session therefore does not
allocate a handset, and says so as "no capacity" rather than running and reaching nothing.

## Verified on hardware

**2026-09-12, on the lab (`mfarm-lab`, four Cuttlefish guests, AOSP 17, `CF_RESET_MODE=powerwash`).**

**The Android setting does what this ADR assumed.** `adb shell settings put global http_proxy
192.168.97.1:8899` against a live guest, with a listener on that address: an app's request arrived
as `GET http://probe.mfarm.invalid/last-hop` — an absolute-URL proxy request, which is exactly the
shape `device-proxy.ts` parses and refuses to treat as a path. The guest reaches the host at its
own gateway, and no reboot or app restart beyond the app itself was needed.

**An `https://` target arrives as a `CONNECT`, exactly as the consequence above predicts.** The
probe logged `CONNECT clientservices.googleapis.com:443` within seconds. The 405 is not theoretical.

**The setting does NOT survive the reset between sessions, and that is the answer we wanted.** A
device was allocated, released and reset through the product's own path; its `http_proxy` came back
`null` while an untouched neighbour kept the value. So the route into a customer's network cannot
outlive the tenant that opened it, and the agent must re-apply per session — which is what the
converging sweep does.

## What is still NOT verified

**`https://` through the tunnel**, and it is unbuilt rather than untested — see the consequence
above. Closing it means a byte-stream channel kind alongside the framed one.

**A handset's reachable host address**, which is why physical devices do not declare `network-proxy`.
