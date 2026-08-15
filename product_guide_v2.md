# Master Development Prompt v2 — Cost- and Latency-Optimised Mobile Device Cloud

> **What this is.** A replacement for `product_guide.md`, rebuilt around the two properties that
> actually differentiate this product: **cost per device-second** and **glass-to-glass latency**.
>
> v1 described a system that works. This describes a system that wins on two numbers. Everything
> here is subordinate to those numbers — if a feature does not improve one of them or is not required
> to sell them, it is deferred.

---

## 0. What changed from v1, and why

| # | v1 said | v2 says | Why it matters |
|---|---------|---------|----------------|
| 1 | Android Emulator (AVD) as *the* device | **Cuttlefish** as the default device, AVD as a premium fidelity tier | Cuttlefish is headless-first, denser, snapshot-capable, and ships a **native WebRTC display+input stack**. It serves both north stars at once. AVD is a desktop tool wearing a server hat. |
| 2 | "Use WebRTC" | A **line-item latency budget** with an owner per line and a hard 100 ms cap | "Use WebRTC" is not a latency strategy. The default browser jitter buffer alone can eat 60 ms of your 100. |
| 3 | Silent on hosting | **Bare metal with unmetered egress. Not AWS/GCP.** | At 4 Mbps of stream, hyperscaler egress costs *more per hour than the compute*. This single choice is a 10–20× cost swing before any clever engineering. |
| 4 | `adb shell input tap` implied | **Never shell out for input.** Persistent control socket only | **Measured: p50 121 ms, p95 418 ms per event.** One tap blows the entire latency budget. The cost is the adb shell round trip (77 ms before running anything), not the `input` binary — so the ban covers every command, not just `input`. |
| 5 | Streaming always on | **No encoder runs unless a human is watching** | Automated runs are the majority of volume and nobody is looking at them. Encoding for nobody is ~20–30% of your CPU bill. |
| 6 | `CLEANING` state | **Reset = snapshot restore**, always | Cold boot is 30–60 s. On a 40 s test that makes you 2.5× more expensive than necessary, for zero customer value. |
| 7 | Redis holds device locks | **Postgres allocates**, Redis caches | Lock expiry vs. long sessions gives you two tenants on one device. |
| 8 | Region unmentioned | **Region is a scheduling dimension** | Latency is a placement problem. You cannot hit 100 ms across an ocean at any codec quality. |
| 9 | Bespoke `TestDefinition`/`Step` model | Deleted | Nobody rewrites their suite to try you. Run *their* Appium/Maestro/Espresso code. |
| 10 | UI is the product | CLI + WebDriver-compatible endpoint is the product | Migration must be a one-line hub URL change. |

---

## 1. The two north-star numbers

Everything in this document exists to move one of these. Both are measured continuously in
production and displayed to the user, not just tracked internally.

### N1 — Glass-to-glass latency ≤ 100 ms (p50), ≤ 150 ms (p95), same-region

**Definition:** the time from a pixel changing on the virtual device to that pixel being visible on
the user's monitor.

**How it is measured — and this is not negotiable:** a high-frame-rate camera pointed at a running
stopwatch app and the browser window side by side, then count frames. Console timestamps measure
your instrumentation, not your product. Do this on day one, before any architecture is committed.

**In production:** a synthetic probe flips a known screen region on a schedule; the browser reports
when it observed the change. Emit p50/p95 per session, per region, per device tier. **Publish it in
the UI.** No competitor shows a live latency number. Doing so is both a forcing function on your own
engineering and a claim nobody else can casually copy.

**Also track, separately and honestly:** *input round-trip* (tap → visible response) will be roughly
N1 + input path + device reaction, so ~150–200 ms. Do not conflate the two or quote the better one.

### N2 — Cost ≤ $0.02 per Android device-hour, ≤ $0.03 per iOS simulator-hour (all-in)

All-in means compute + storage + egress + the amortised idle of your warm pool. Metered from the
worker as first-class events, not reconstructed later from session timestamps.

Target sell price $0.10–0.20/device-hour. That is a 5–10× gross margin *and* roughly an order of
magnitude under incumbent effective rates.

---

## 2. The latency budget

Build to this table. Every line has an owner and a mechanism. If a line exceeds budget, the fix is
named — do not "optimise generally."

| Stage | Budget | Mechanism | Failure mode if ignored |
|---|---:|---|---|
| Frame availability | 8 ms | 60 fps source; capture on vsync, never poll | Polling capture adds a full frame period of jitter |
| Encode | 10 ms | H.264, encode **once at source**, zero-latency tuning, no B-frames, intra-refresh instead of periodic keyframes | Periodic keyframes cause visible 100 ms+ hitches every 2 s |
| Packetise + RTP | 2 ms | No transcode, no remux through ffmpeg | A host-side transcode turns a 70 ms pipeline into 300 ms |
| Network (one way) | 10 ms | Same-region placement, **UDP only** | TURN/TCP fallback is a latency cliff, not a degradation |
| Jitter buffer | 20 ms | `playoutDelayHint = 0` / `jitterBufferTarget` tuned low | **Browser default is 40–80 ms — this line alone decides whether you hit 100 ms** |
| Decode | 8 ms | Hardware decode; keep resolution at or below 1080p | Software decode on the client machine, silently |
| Composite + display | 16 ms | Plain `<video>`, no canvas round trip | Canvas/WebGL compositing adds a frame for no benefit |
| **Total** | **74 ms** | | Leaves 26 ms of headroom against the 100 ms cap |

### The five levers that actually matter

**L1 — Never transcode.** Encode once, at the source, in the format the browser will decode. Any
ffmpeg in the path is a bug. This is also a cost lever: transcoding is the most expensive CPU in the
system, and you would be paying it to make the product worse.

**L2 — Tune the jitter buffer.** This is the highest-value hour of work in the entire project.
Chrome's default playout delay is tuned for conference video, where smoothness beats latency. You
want the opposite. Set it explicitly and verify with `getStats()`.

**L3 — Input never shells out.** A persistent control channel that injects at the input-device layer.
**Measured 2026-08-15** (M1, AVD, Android 34): `adb shell input tap` is **p50 121 ms, p95 418 ms** —
one tap exceeds the entire budget. The cause is not the `input` binary (on Android 34 it is a thin
wrapper over a `cmd input` binder call); it is the **adb shell round trip itself**, which costs
57–77 ms before running anything. A held shell improves it to p50 39 ms / p95 70 ms — 3× better, and
still too slow. So the rule is absolute: **no per-event `adb shell` round trip, ever, whatever the
command.** Only an in-guest agent on a persistent socket is fast enough. Cuttlefish takes input over
its WebRTC data channel natively.
For AVD, use the emulator's gRPC control service. For physical Android, scrcpy's control socket. For
iOS, `idb` with a held companion connection — never `simctl` per command.

**L4 — Region is a scheduling dimension.** Add `region` to devices, sessions and the allocator on day
one. A user in Frankfurt allocated a device in Virginia has 90 ms of one-way network and cannot be
saved by anything else in this table. Start with one region; make the *model* multi-region
immediately, because retrofitting a region key into a live scheduler is miserable.

**L5 — Optimistic input feedback.** Render the touch indicator locally the instant the user clicks,
before the frame comes back. This does not reduce latency; it reduces *perceived* latency
substantially, and it is honest — it indicates "sent", not "happened". Distinguish it visually from
device-confirmed state.

---

## 3. The cost model

| Line | Decision | Impact |
|---|---|---|
| **Hosting** | Bare metal with unmetered or cheap egress (Hetzner AX/RX class, OVH, Latitude, Equinix). **Not AWS/GCP.** | 10–20× on the compute line, and egress goes from a dominant cost to ~zero |
| **Egress** | 4 Mbps × 1 hr ≈ 1.8 GB. At hyperscaler rates (~$0.09/GB) that is **~$0.16/device-hour — more than the compute** | The cost line nobody models. Kills the thesis on its own if hosted wrong |
| **Virtualisation** | KVM required, which rules out most cheap VPS tiers (no nested virt). Bare metal is not optional | Without KVM you are in software emulation and 10–20× slower |
| **Boot** | Snapshot restore, 1–3 s. Never cold boot into a session | **Measured: 2.88 s restore vs 35.5 s cold — 12.3×.** Cold boot on a 40 s test means paying for 100 s. Budget ~1 GB of disk per snapshot |
| **Rendering** | ⚠️ **Open question, not yet a finding.** A laptop run suggested an idle emulator burns ~100% of a core at ~1 GB — but it was measured with `ps -o pcpu` (lifetime average, inflated by the 35 s boot), so treat it as unverified | If it holds, **CPU binds density before RAM** and the figures below are optimistic. `spikes/spike2_android_density.sh` settles it by ramping twice — rendering on vs `--gpu_mode=none` — and reports the density ratio. A ratio ≥ 1.5 means the "no encoder without a viewer" rule extends to *rendering*, and the automated tier gets its own lower price |
| **Idle** | Warm pool sized to a moving average of demand; everything else is a file on disk. Auto-terminate interactive sessions after N seconds without input, with warning | Idle capacity is the largest cost in this industry. Most incumbent revenue is people who left a tab open |
| **Encoding** | **No encoder unless a viewer is attached.** Pause on `visibilitychange`. Automated runs encode nothing unless recording was requested | 20–30% of CPU, spent on video nobody watches |
| **GPU** | Software rendering (SwiftShader) as default; GPU-backed as a separate, more expensive device class | GPUs are expensive and hard to share. Most functional testing does not need one |
| **Memory** | Enable KSM. Identical guest images share most pages | 30–50% RAM reclaim, and RAM is your binding constraint on density |
| **Artifacts** | Delete video for passing runs by default. Screenshots as WebP/AVIF, not PNG. Logs gzipped. Hot 7 days, cold at 30 | Video is the sleeper cost that has killed testing startups. PNG→WebP alone is 5–10× |

### Worked example — Android

A 16-core / 128 GB bare-metal box at roughly $115–160/month is about **$0.16–0.22/hour**. At 14–18
concurrent Cuttlefish instances that is **$0.009–0.016 per device-hour**, with egress included rather
than metered. The equivalent hyperscaler instance lands at $0.05–0.08 for compute *plus* ~$0.16 of
egress while streaming.

> Verify these against live pricing before committing — providers change, and the density figure is
> exactly what spike 2 exists to measure. The *ratio* is the durable part, not the digits.

### iOS

Owned Apple-silicon Mac minis, colocated. Roughly $0.05–0.09/hour all-in on a three-year
amortisation, 6–10 concurrent simulators, so **$0.01–0.02 per simulator-hour**.

**Do not build on rented cloud Macs.** The dedicated-host model with a 24-hour minimum allocation is
structurally incompatible with per-second billing — you would pay by the day and sell by the second.

---

## 4. Device tiers — the substrate decision

This is the largest change from v1 and the one that makes both north stars reachable.

### Tier B (default) — Cuttlefish

Google's own virtual Android device (`cvd`), built for servers rather than desktops.

- Headless by design; no display server, no window, no desktop assumptions
- **Ships a native WebRTC display and input stack** — you are not bolting a capture pipeline onto a
  desktop app, you are using the streaming path the platform already has
- Input arrives over the WebRTC data channel, so L3 is satisfied by construction
- Snapshot save/restore, which is what makes both fast reset and per-second billing work
- Runs arm64 and x86_64 guests; needs KVM on the host

This should be the device the majority of your traffic lands on, and it should be the one you price
aggressively.

### Tier A (premium) — Android Emulator / AVD

For work that needs Google Play services, a specific Pixel profile, or maximum fidelity to what a
real user sees. Control via the emulator's gRPC service (`-grpc`), never via shelled `adb`. Priced
higher because it costs more.

### Tier C (experimental) — containerised Android

Android running as containers on a shared Linux kernel — no per-device QEMU, no per-device kernel.
Density is several times higher and boot is effectively instant. The trade-off is fidelity: AOSP-ish,
no Play services by default, and behaviour that diverges from a stock device in ways that matter for
some apps.

Spike it, measure the density gain, and if it holds, offer it as an explicitly-labelled cheap tier
for high-volume smoke and unit-style UI runs. Never present it as equivalent to a real device.

### iOS — simulators, honestly labelled

Simulator-first, bin-packed on owned Macs. Control via `idb` with a held companion connection —
`simctl` spawns a process per command and cannot meet the input budget. Reset by swapping the data
container rather than rebooting the simulator: 1–2 s instead of 15–30 s.

Publish plainly what simulators cannot cover: biometrics, camera, cellular radio, real GPU and
thermal behaviour, DRM, certain vendor SDKs. Promote to physical hardware only for those. Overselling
virtual is how you lose the first enterprise reference.

---

## 5. Non-negotiable technical decisions

Each of these has a named failure mode. Ignoring one does not degrade the product gracefully.

1. **`org_id` on every table from row zero, with row-level security as default-deny.** Retrofitting
   tenancy into live data is the most expensive migration in SaaS. Costs one day now.
2. **The control plane never carries a frame.** The API mints a short-lived signed token and returns
   a worker endpoint; the browser connects directly to the worker. Otherwise your p99 tap latency is
   a function of your API's garbage collector, and you can never place a worker in a customer's own
   datacentre.
3. **Postgres allocates devices.** `SELECT … FOR UPDATE SKIP LOCKED` on the device row inside the
   same transaction that inserts the session row, plus a monotonic fencing token the worker validates
   on every command. Redis keeps pub/sub, heartbeats and hot cache — things where a lost write is
   survivable.
4. **Split the device abstraction in three.** `DeviceControl` — narrow, typed, idempotent
   request/response. `MediaSource` — entirely out of band, never in the same interface as `tap()`.
   `Capabilities` — devices declare what they support and the platform degrades gracefully. A single
   fat interface returning `Buffer` and `AsyncIterable` across a network boundary will hold for two
   emulators and shatter at the first physical device.
5. **Reset means snapshot restore.** Uninstalling an app leaves accounts, keychain items, clipboard,
   WebView caches and granted permissions behind. You are running untrusted third-party binaries and
   handing the same device to the next tenant.
6. **Metering is a first-class event stream** from the worker: device-seconds and artifact bytes,
   append-only, idempotent by event id. Two days now, a quarter-long forensic project later.
7. **The worker protocol is versioned and negotiates capabilities.** You will permanently run mixed
   versions from the second host onward, because these are physical machines you cannot redeploy in
   lockstep.
8. **`QUARANTINED` and `EVICTED` exist in the device lifecycle.** A host failing health checks twice
   is drained, snapshot-restored and alerted on — never silently retried into a customer's session.
9. **One network namespace per session**, default-deny egress, routed through a per-session proxy.
   That single mechanism gives you tenant isolation for untrusted APKs, the record/replay engine for
   deterministic tests, and the network waterfall artifact. Build once, sell three times.
10. **A W3C WebDriver-compatible endpoint.** Migration from an incumbent must be one hub URL and two
    capabilities. Plus `npx mfarm run` and a GitHub Action. The UI is your demo and debugging
    surface; the wire protocol is your product.

---

## 6. Architecture

Three planes, not one pipeline.

**Control plane** — stateless, boring, Postgres is truth. Auth and orgs, the scheduler/allocator,
metering, artifact index, the WebDriver hub. Modular monolith. This plane may be slow; nobody
notices.

**Data plane** — latency-critical, never proxied. Worker agent, media out, input in, log tail.
Browser talks directly to worker, authorised by the signed token minted above. This plane's p99 is
the product.

**Fleet plane** — the host is the unit of scheduling, not the device. Host agent owns lifecycle,
snapshots, quarantine, capacity reporting, and bin-packing so hosts can be drained and powered down.

---

## 7. Phases, with numeric exit criteria

A phase is not done because the demo works. It is done when the number is met.

### Week 0 — two spikes, both throwaway

Only two things can kill this. Measure them before designing anything.

> **Status as of 2026-08-15: both spikes BLOCKED on hardware.** Harnesses are written and ready in
> `spikes/`. Spike 1 and 2a need a Linux box with `/dev/kvm`; 2b needs full Xcode. Single-instance
> measurements taken on the dev laptop already confirmed the snapshot and input-latency assumptions
> and corrected the density model — see `spikes/README.md`.

- **Spike 1 — latency.** Cuttlefish with `--start_webrtc`, one instance, browser on the same LAN.
  Measure glass-to-glass with a camera and a stopwatch app. **Pass: under 120 ms before any tuning.**
  If it will not go under 120 ms untuned, the 100 ms target is not reachable and the positioning must
  change.
- **Spike 2 — density.** Start instances on one box until it degrades; separately, boot simulators on
  one Mac mini until it degrades. **Pass: ≥ 12 Android instances on a 128 GB box, ≥ 6 simulators on a
  24 GB mini**, each still meeting spike 1's latency.

Write the architecture document *after* these two numbers exist, not before.

### Phase 1 — vertical slice, tenancy-correct (~4 weeks)

One Android device end to end, on `org_id` + RLS, the Postgres allocator, metering events, and a
versioned worker protocol.
**Exit: glass-to-glass p50 ≤ 100 ms measured by camera. Metering events reconcile to wall-clock
within 1%.**

### Phase 2 — the wedge, not iOS (~4 weeks)

Snapshot reset, per-second metering, CLI and GitHub Action, WebDriver-compatible endpoint.
**Exit: an external team migrates a real Android Appium suite by changing one URL, and their bill is
demonstrably lower. Device reset ≤ 3 s. Cost per device-hour ≤ $0.02 measured, not modelled.**

This is the counter-intuitive call: iOS makes the product *complete*, this phase makes it *sellable*.
Get the evidence before spending on Apple hardware.

### Phase 3 — iOS simulator density (~4 weeks)

New `DeviceControl` and `MediaSource` implementations only. If this phase requires touching the
scheduler or the API, decision 4 was implemented wrong and you should stop and fix it.
**Exit: parity on latency and reset time. ≥ 6 simulators per host.**

### Phase 4 — determinism (~6 weeks)

Clock injection, pinned locale/timezone/font scale, animations off, network record and replay through
the session proxy, seeded data, a published flake score per test.
**Exit: the same suite run 100× produces identical results.** This is the first thing a competitor
cannot copy in a quarter.

### Phase 5 — agent surface (~4 weeks)

MCP server, semantic screen description from the accessibility tree, intent-level actions, per-run
spend ceilings, a session flight recorder. Cheap to build, widest distribution available to you.

### Phase 6 — triage and default artifacts (ongoing)

Failure clustering, new-versus-known ranking, locator healing that opens a pull request rather than
healing silently. Cold start, jank, memory, network waterfall and accessibility audit attached to
every session automatically, not as a separate SKU.

### Phase 7 — physical devices (on customer pull only)

Highest capex, lowest margin, and the reason incumbents cannot move quickly. Never before a paying
requirement.

---

## 8. Deleted from v1

- **The `TestDefinition` / `Step` model.** Do not invent a test DSL. Teams have Appium, Maestro,
  Espresso and XCUITest suites and will not rewrite them to try you. Store runs and artifacts; execute
  *their* code. Be a runtime, not a framework.
- **"One active session per device" as a domain assumption.** Fine as an initial limit; as a model it
  is what lets you skip building a scheduler, which is the actual hard problem here.
- **Architecture-document-first sequencing.** Replaced by the week-0 spikes.
- **Any path where a screenshot loop substitutes for a video stream.** Not as a fallback, not for
  local dev. It sets the wrong performance baseline and it will survive into production.

---

## 9. Rules that carry over from v1 unchanged

These were right and should be restated to whoever builds this:

- No fake device status, streaming, logs, test results or screenshots. If the environment cannot do
  it, name the limitation and build the correct abstraction around it.
- The frontend never controls a device directly.
- No Kubernetes, Kafka, service mesh or microservices without a concrete need. Modular monolith plus
  workers.
- Never expose ADB or Appium ports to the public internet.
- Structured logs carrying `requestId`, `sessionId`, `deviceId`, `workerId`, `testRunId`.
- Everything except the device workers runs under `docker compose up`.

---

## 10. What to tell whoever builds this, in one paragraph

Build a mobile device cloud whose entire differentiation is two numbers: under 100 ms glass-to-glass
and under two cents per device-hour. Use Cuttlefish on bare metal with KVM and unmetered egress, take
its native WebRTC path rather than building a capture pipeline, never transcode, never shell out for
input, tune the browser jitter buffer explicitly, and reset devices by snapshot restore so they are
disposable rather than tended. Meter device-seconds from the worker as a first-class event. Put
`org_id` and `region` in the schema on day one. Keep frames out of the control plane. Measure latency
with a camera, not a console, and put the number in the product UI. Everything else — the dashboard,
the artifact browser, the test model — is table stakes that follows once those hold.
