# Worker agent

Runs on a device host. Registers with the control plane, serves the data plane the browser connects
to, meters usage, and returns devices to the pool after a snapshot reset.

```bash
npm test          # 22 tests, against a real control plane on a real port
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
| `APPIUM_ENABLED` | no | supervise an Appium 2 server for the device (see WebDriver below) |
| `APPIUM_PATH` | no | binary to spawn, default `appium` on PATH |
| `APPIUM_BASE_PORT` | no | first port of the derived range, default 4723 |
| `APPIUM_ADVERTISE_HOST` | no | this host's externally-reachable name, used to compose the gateway url; the Appium bind is always 127.0.0.1 |
| `AUTOMATION_GATEWAY_PORT` | no | port the ADR-0004 automation gateway listens on, default 8090 |
| `AUTOMATION_ADVERTISE_BASE` | no | full public base url of the gateway, e.g. `https://worker-1.example:8443`. Wins over `APPIUM_ADVERTISE_HOST`; set it for a TLS deployment |
| `APPIUM_ENV_PASSTHROUGH` | no | extra env var names Appium may inherit; it gets an allowlist, not `process.env` |
| `APPIUM_UNHEALTHY_GRACE_MS` | no | how long this host may still advertise `webdriver` after Appium stops answering before the agent drains to withdraw it, default 60000 |
| `AGENT_DRAIN_TIMEOUT_MS` | no | hard deadline on a drain, default 30000 |
| `AUTOMATION_ENDPOINT` | no | escape hatch for an externally-managed Appium; ignored when `APPIUM_ENABLED` is set |

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

## App install

The other half of the heartbeat's job. A beat can carry down `installs` as well as `resets`, and the
agent handles them the same way and for the same reasons — an in-flight guard, because the request is
re-offered every beat and an install outlives one; not awaited inside the beat, because an install is
a download plus a dexopt pass and a beat that waited for it would look like a dead host.

The one difference is what a failure means. A failed reset must leave the device stuck in `CLEANING`,
because a device that cannot be cleaned must never rejoin the pool. A failed install is a fact about
the tenant's APK — wrong ABI, bad signature, no space — so it is reported as `FAILED` with adb's own
words, which is what the person waiting on it needs to read.

**The digest is checked on both paths.** The agent caches APKs by sha256 under `appCacheDir`, so
installing one build on both devices downloads it once; it re-hashes a cache hit anyway, because
that file was written by a process that may have been killed mid-write and lives in a directory
anything on the host can write to. A mismatch re-downloads rather than installs.

`installApp` is an **optional** method on `DeviceControl`. A tier that cannot sideload does not
define it, rather than defining one that throws — the capability is what the control plane schedules
on, and `app-install` is advertised from whether the method exists.

## Bugs the tests caught

**Empty body with a JSON content-type returned 500.** The agent's heartbeat sends no body, and
Fastify's default parser throws on empty input when content-type is `application/json`. A routine
heartbeat returning 500 is an alert nobody should be woken for. Fixed on both sides: the agent no
longer claims a content-type it isn't sending, and the control plane now treats an empty JSON body as
`{}` (a genuinely malformed body still 400s, not 500s).

**Parameter properties break the no-build-step setup.** `constructor(private readonly x: T)` emits
runtime code, so Node's strip-only type removal rejects it. All fields are declared and assigned
explicitly. Worth knowing before adding a class here — `npm run typecheck` at the repo root now
enforces it with `erasableSyntaxOnly`, so this fails the check instead of the runtime.

**A second `hello` on one socket restarted the billing clock.** `onHello` re-entered `beginSession`,
which resets `startedAt`, so the seconds already elapsed stopped being billed — and the socket would
rebind to whatever device the new token named, without the first one's fence being consulted again.
One socket, one session; a repeat handshake is now refused.

## WebDriver

The control plane's hub proxies WebDriver commands to an automation server on this host. Set
`AUTOMATION_ENDPOINT` to it (e.g. `http://10.0.3.14:4723`) and the agent advertises the `webdriver`
capability on the host and its devices; leave it unset and the host simply never receives WebDriver
traffic. The capability is tied to the endpoint rather than to the device tier because the same
Cuttlefish instance serves WebDriver on one deployment and not on another.

**The endpoint must not be publicly routable.** An open Appium port is unauthenticated device
control — anyone who finds it owns every session on the host. The hub is the only ingress, because it
is the only thing that knows about orgs.

### Supervising Appium (`appium.ts`)

Set `APPIUM_ENABLED=1` and the agent spawns Appium itself, bound to **127.0.0.1 only**, on a port
derived from the device's local id (`cf-1` → 4723, `cf-2` → 4724). The `webdriver` capability is then
advertised only after `GET /status` has actually answered — reporting ready on spawn alone means the
first session of a freshly booted host hits a port Appium has not bound yet. A crash is restarted
with exponential backoff (1s doubling to 60s); after 5 consecutive failed starts the supervisor goes
permanently unhealthy instead of looping.

**Withdrawal.** The capability has to come back off when Appium stops answering, and there is no
in-place way to do that: the control plane writes `hosts.capabilities` at registration and nowhere
else, the heartbeat ignores its body, and re-registering would also force `state = 'UP'` and clear
any quarantine. So withdrawal is a drain and a non-zero exit, letting the process supervisor restart
the agent into an honest registration. That now happens for a **transient** outage too, not only a
permanent one: if Appium is unready for longer than `APPIUM_UNHEALTHY_GRACE_MS` (default 60s, sized
to survive one ordinary crash plus cold start) while this host advertises `webdriver`, the agent
drains. Recovery inside the window cancels it. The heartbeat also carries the current capability set
already, which is inert until the control plane reads it — that is the real fix, and it is a
protocol change.

**Appium's environment is an allowlist, not an inheritance.** The agent's own environment holds
`WORKER_REGISTRATION_TOKEN`, the credential that enrolls hosts fleet-wide; an automation server that
loads third-party drivers must not have it. `PATH`, `HOME`, `JAVA_HOME`, the `ANDROID_*`/`APPIUM_*`/
`ADB_*` families and a few locale and TLS variables pass through. Anything else a driver needs goes
in `APPIUM_ENV_PASSTHROUGH` (comma-separated names).

**Orphans.** Because the derived port is deliberately stable, an Appium that outlives its agent
collides with the next one by design. The agent drains on `uncaughtException`/`unhandledRejection`
as well as on signals, SIGKILLs the child's process group from a `process.on('exit')` backstop, and
on the way in reclaims its port from a pid recorded in `<tmpdir>/mfarm-appium-<port>.pid` — only
after confirming the live process still has `--port <port>` in its argv, so a recycled pid is never
killed. A port held by anything else is reported, not seized.

**Both of the things this used to leave unsolved are solved as of 2026-08-17.** A host with more than
one device no longer refuses to start Appium: protocol v2 carries `automationEndpoint` per device, so
each one advertises its own address and a device with no ready server simply does not claim
`webdriver`. And a loopback-bound server no longer needs an operator-supplied tunnel — the automation
gateway (`src/gateway.ts`, ADR-0004) terminates the hop on this host and authenticates every request
with a two-minute signed grant. `AUTOMATION_ENDPOINT` remains available for one operator-managed
Appium fronting several devices.

The supervision logic is tested against a fake server (`test/appium.test.ts`, no database). It has
never spoken to a real Appium — see the header of `src/appium.ts` for the specific things that stay
unverified until there is hardware.

## Not yet built

App **launch** and **uninstall** (install is done — see above), logcat streaming, and video
recording. `resolveDeviceIds`
returns an empty map — the agent currently learns a device's control-plane uuid from the signed token
that arrives for it, which is authenticated and therefore trustworthy, but a future protocol revision
should return the mapping at registration.

The Cuttlefish `cvd` flags track a moving upstream. `spikes/bootstrap_cuttlefish.sh` pins a working
environment; verify against the version it installs before trusting the defaults in
`devices/cuttlefish.ts`.
