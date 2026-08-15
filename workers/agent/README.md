# Worker agent

Runs on a device host. Registers with the control plane, serves the data plane the browser connects
to, meters usage, and returns devices to the pool after a snapshot reset.

```bash
npm test          # 21 tests, against a real control plane on a real port
npm start         # requires the env below
```

| Variable | Required | Notes |
|---|---|---|
| `CONTROL_PLANE_URL` | no | defaults to `http://localhost:3000` |
| `WORKER_REGISTRATION_TOKEN` | yes | bootstrap secret, must match the control plane |
| `REGION` | yes | scheduling dimension — latency is a placement problem |
| `PUBLIC_ENDPOINT` | yes | where browsers reach this host's data plane |
| `CF_IMAGE_DIR` | Cuttlefish | directory holding the device image |
| `CF_INSTANCES` | no | instances to start, default 1 |
| `AVD_NAME` | AVD fallback | only used when Cuttlefish is unavailable |
| `DATA_PLANE_PORT` | no | default 8080 |

## Structure

```
device.ts              the three-way split (DeviceControl / MediaSource / capabilities)
devices/cuttlefish.ts  target tier — Linux + KVM
devices/avd.ts         fallback tier — runs on macOS, cannot meet the latency target
agent.ts               registration, credentials, heartbeat, metering, reset
dataplane.ts           WebSocket the browser connects to; offline token verification
index.ts               picks a tier and wires it together
```

## Why the device abstraction is not v1's `DeviceAdapter`

v1 proposed one fat interface returning `Buffer` and `AsyncIterable` across what becomes a network
boundary, with every device implementing every method. That holds for two emulators and shatters at
the first physical device, leaving adapters full of `throw new NotSupported()`.

Split three ways instead: `DeviceControl` (narrow, typed, idempotent commands), `MediaSource`
(entirely out of band — never in the same interface as `tap()`), and declared capabilities so the
platform degrades gracefully. Phase 3's real test is whether adding iOS touches only these two
implementations; if it reaches the scheduler or the API, the split was wrong.

## Two tiers, and why the fallback is labelled loudly

`index.ts` picks Cuttlefish when the host can run it and prints the reason when it cannot, rather
than silently degrading and leaving someone to wonder later why latency is bad.

|  | Cuttlefish | AVD |
|---|---|---|
| Host | Linux + `/dev/kvm` | anywhere, incl. macOS |
| Media | native WebRTC | **none** |
| Input | WebRTC data channel | held adb shell, p50 39ms |
| Meets 100ms target | yes (to be confirmed by spike 1) | no |

The AVD tier exists so the control plane and agent can be developed without a Linux box. It does not
advertise `screen-stream`, because claiming a capability it does not have is a lie the scheduler
would act on. It does advertise `input-datachannel` — the held shell genuinely is a persistent
channel with no per-event process spawn — it is simply a slow one.

## Data plane

The control plane already authorised the session and is out of the loop. The agent verifies the
Ed25519 token **offline** against the public key it received at registration, so nothing on the input
path calls back to the API — that is what keeps p99 tap latency independent of the control plane's
availability and distance.

Media is not proxied. For Cuttlefish the browser negotiates WebRTC directly with Cuttlefish's own
server; this socket carries control and input only. A transcode here would turn a ~70ms pipeline into
~300ms and burn the CPU that instance density depends on.

Three gates before any input reaches a device: signature (audience-bound to this host id), fence
(rejects a partitioned client whose allocation has been superseded), and sequence number (a late
arrival never replays a stale position).

### Input handling: coalesce positional, queue discrete

A test caught this, and it is worth stating plainly because the naive version looks fine.

The first implementation kept one input in flight and dropped anything arriving behind it. That is
right for taps and swipes — a coordinate the user has already moved past is worthless, and queueing
them builds a backlog that makes the device act on gestures finished seconds ago.

It is wrong for keypresses and text. Each is discrete and distinct, and dropping one is data loss the
user sees instantly: type "hello" quickly and get "hlo". Discrete input now queues (bounded at 64,
overflow reported as `input_overrun`); positional input still coalesces.

## Metering

Event ids are **deterministic** — `sha256(sessionId:tick)`, not random. If the agent crashes after
emitting a tick but before the control plane acknowledges it, the restart re-emits the same id and
`ON CONFLICT DO NOTHING` absorbs it. With random ids that crash double-bills the customer and nobody
notices until they complain.

A failed flush retains its events rather than dropping them; buffer overflow is logged at error
level with a count, never silently evicted.

## Reset

`resetAndRelease()` reports a device free **only after** the snapshot restore completes. Reporting on
entry would return a device still carrying the previous tenant's accounts, keychain and caches. A
failed restore leaves the device `CLEANING` — out of the pool — which is the safe direction.

## Bugs the tests caught

**Empty body with a JSON content-type returned 500.** The agent's heartbeat sends no body, and
Fastify's default parser throws on empty input when content-type is `application/json`. A routine
heartbeat returning 500 is an alert nobody should be woken for. Fixed on both sides: the agent no
longer claims a content-type it isn't sending, and the control plane now treats an empty JSON body as
`{}` (a genuinely malformed body still 400s, not 500s).

**Parameter properties break the no-build-step setup.** `constructor(private readonly x: T)` emits
runtime code, so Node's strip-only type removal rejects it. All fields are declared and assigned
explicitly. Worth knowing before adding a class here.

## Not yet built

App install/launch, logcat streaming, video recording, and the WebDriver endpoint. `resolveDeviceIds`
returns an empty map — the agent currently learns a device's control-plane uuid from the signed token
that arrives for it, which is authenticated and therefore trustworthy, but a future protocol revision
should return the mapping at registration.

The Cuttlefish `cvd` flags track a moving upstream. `spikes/bootstrap_cuttlefish.sh` pins a working
environment; verify against the version it installs before trusting the defaults in
`devices/cuttlefish.ts`.
