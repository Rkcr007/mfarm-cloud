# MFARM — self-hosted 2-device Android farm

Plan of record, 2026-08-17. Supersedes the SaaS framing in `product_guide_v2.md` **for delivery
sequencing only** — the architecture in `HANDOFF.md` and `docs/adrs/` still stands.

## What changed

The target is no longer a multi-tenant device cloud sold by the device-hour. It is **one farm, two
Cuttlefish devices, always on, owned outright**, used by Rakesh and teammates to verify Android apps
via Appium — replacing a BrowserStack/Sauce subscription.

Decisions taken 2026-08-17:

| Question | Answer |
|---|---|
| Device substrate | Cuttlefish VMs on Linux + KVM |
| Google Play Services needed | **No** — pure AOSP is fine |
| Host | Rented bare metal, in or near India |
| Access | Tailscale/WireGuard, multiple human users |
| Test stack | Appium (Java/Python/JS); native Kotlin/Java **and** Flutter/RN apps |
| Scope | All four: automation, live interactive UI, artifacts, dashboards |

### The gate no longer blocks this

`HANDOFF.md` gates everything on two unrun spikes: glass-to-glass latency < 100ms and device density
for $0.02/device-hour. **Neither gates this MVP.**

- Density is a unit-economics number. At two devices on a box you already pay for, it is irrelevant.
- Interactive latency is a *manual testing* differentiator. Appium command round-trips are tens to
  hundreds of ms inside the device; the transport hop is noise.

The spikes stay worth running — the same box runs them on day one, and they are the difference
between "it works" and "we know what it costs if we scale it" — but no longer block delivery.

### GMS risk: cleared

Cuttlefish runs AOSP with no Play Services. The app under test needs none, so the substrate choice is
sound. **Keep it that way:** the day a dependency on FCM, Google Sign-In, Maps SDK or Play Integrity
lands in the app, this farm stops being able to verify it, and no platform work fixes that. Treat it
as a standing constraint, not a solved problem. `device.ts` already declares a `physical` tier, so a
real handset can be added as a third backend without rework if that day comes.

## Findings that change the design

### 1. Snapshot/restore forces software rendering

Per [AOSP docs](https://source.android.com/docs/devices/cuttlefish/snapshot-restore), Cuttlefish
snapshot/restore requires **all** of:

- `--gpu_mode=guest_swiftshader` — "Only the SwiftShader (`guest_swiftshader`) GPU mode is supported
  for snapshots. Other accelerated graphics modes aren't supported."
- `--enable_virtiofs=false`
- x86_64 host

This is load-bearing. The whole reset story in `device.ts` — "2.9s restore vs 35.5s cold boot, so
this is also what makes per-second billing viable" — is only available with a **software GPU**.

**Why it resolves cleanly here:** a rented bare-metal server has no GPU. Without a GPU, `gfxstream`
and `drm_virgl` are unavailable anyway (both require a physical GPU with an EGL driver supporting
`GL_KHR_surfaceless_context`), and Cuttlefish falls back to SwiftShader regardless. So we are on
software rendering either way, and taking `guest_swiftshader` deliberately buys snapshot/restore for
free. **No trade-off is actually being made** — but it must be a conscious configuration, not a
default we drift off.

**What it costs, honestly:**

- Rendering is CPU-bound. Fine for a 64-core EPYC driving two devices.
- The live interactive view will be low frame rate — think usable-for-triage, not smooth. Set
  expectations accordingly; this is the one place "great UI" meets physics.
- **Flutter and React Native are the real risk.** Both are GPU-heavy renderers. Expect slower frame
  production and animation-timing flakiness that a physical device would not show. Budget explicit
  time in Phase 1 to run the actual RN/Flutter suite and measure, rather than discovering it in
  Phase 4.
- If frame rate turns out to be unacceptable, the escape hatch is a box with a consumer GPU and
  `gpu_mode=gfxstream`, giving up snapshot restore and resetting via `powerwash_cvd` instead
  (slower reset, ~cold-boot cost). At two devices that is an affordable trade.

### 2. Reset has a fallback ladder, and we should implement all three rungs

From [restart/reset](https://source.android.com/docs/devices/cuttlefish/restart):

| Rung | Command | Clears | Speed |
|---|---|---|---|
| 1 | `cvd create --snapshot_path=…` | everything, to golden state | seconds |
| 2 | `powerwash_cvd --instance_num=N` | all disk changes, preserves launch flags | ~cold boot |
| 3 | `stop_cvd --resume=false` + relaunch | everything incl. instance files | slowest |

`cuttlefish.ts` currently implements one path. A device that fails to restore must fall down the
ladder rather than going permanently offline, because at two devices losing one is losing half the
farm. **Reset failure must never silently return a device to READY** — that invariant is already
enforced control-plane side and must not regress.

### 3. Latest Android is 17 (API 37)

Android 17 stable released 2026-06-16, AOSP tag `android-17.0.0_r1`, build `CP2A.260605.016`
(quarterly release 26Q2). AOSP now publishes in Q2 and Q4 only. Target **Android 17 on both devices**
for the MVP, and keep the image reference a config value — a farm pinned to one OS version by
accident is a farm that cannot test the next one.

### 4. Known issue 1 stands and is now urgent

`devices/cuttlefish.ts` `cvd` flags are unverified against a real install, and upstream moves. They
must be checked against whatever `bootstrap_cuttlefish.sh` actually installs, on the real box, before
anything is built on top. This is the first hour of Phase 0.

## How the flow works today

What exists and is tested (267 tests, real PostgreSQL 16, no mocks where it matters):

```
1. REGISTER    worker agent boots → POST /v1/workers → credentials persisted
               → heartbeat loop reports devices + capabilities
               capabilities are OBSERVED state, never configuration (ADR-0003)

2. ALLOCATE    POST /v1/sessions {constraints, requireCapabilities, Idempotency-Key}
               → Postgres allocates atomically, FOR UPDATE SKIP LOCKED
               → monotonic fence token, session row, Ed25519 session token
               → no device free? session QUEUED, promote_queued() re-applies constraints

3a. INTERACTIVE   browser → WebSocket to the WORKER's data plane (not the API)
                  token verified OFFLINE against the registration public key
                  positional input coalesced, discrete input queued
                  media NOT proxied — browser negotiates WebRTC with Cuttlefish directly

3b. AUTOMATION    Appium client → https://<key>:<session-id>@hub/wd/hub
                  hub binds the existing session (hub_allocated=false) or allocates one
                  proxies W3C/JSONWP to the worker's Appium
                  every hop carries a 2-minute Ed25519 grant naming
                  session, device, org, fence, host (ADR-0004)

4. RELEASE     device → RELEASING → worker resets → device_reset_complete(worker_id, device_id)
               → READY. A released device is NOT allocatable until a worker confirms.

5. METER       append-only, idempotent, paying org DERIVED from the session, never
               accepted from the worker's request body
```

Reusable as-is for this MVP. **Keep multi-tenancy** — teammates are a second user class, RLS costs
nothing to leave in, and removing it means rebuilding it the first time you want a second team or a
staging org.

## What users actually do with a farm like this

The flows the MVP must serve, in rough order of frequency:

1. **CI merge gate** — a PR runs the Appium suite on a real device, sharded across both devices.
   Must distinguish *capacity exhausted* from *test failed* (already done: exit 75 / `EX_TEMPFAIL`).
2. **Local run against a real device** — `mfarm run -- npx appium-test` from a laptop over Tailscale.
3. **Manual repro of a CI failure** — open the failing session's artifacts, then grab the same device
   interactively and poke at it. This is where the live UI earns its place.
4. **Flaky-test triage** — session history, video, logcat, and screenshots for a run that failed once.
5. **Ad-hoc app check** — upload an APK, install, drive it by hand, no test suite involved.
6. **"Is the farm healthy?"** — one page that answers it, and an alert that fires before a suite does.
7. **Contention** — at two devices this is the dominant UX problem. Who holds device 2, for how long,
   and can I queue? Queueing exists; the UI must expose it and sessions must have TTLs that actually
   reap.

## Delivery plan

Each phase ends in something demonstrable. Nothing in a later phase is a prerequisite for an earlier
one.

### Phase 0 — Box, boot, and the gate (1–2 days)

Provision bare metal. Run `spikes/bootstrap_cuttlefish.sh`. Boot two Android 17 cvd instances.
**Verify the `cvd` flags in `cuttlefish.ts` against the real install** (known issue 1). Run spikes 1
and 2a while the box is fresh — they cost hours, not days, and never get cheaper.

Exit: two Android 17 devices running, `adb devices` shows both, snapshot take + restore round-trips,
and the latency/density numbers exist.

### Phase 1 — Make automation actually work end to end

The critical path. Nothing here is optional and none of it is currently proven against real hardware.

- ~~**ADR-0004 worker automation gateway** + the B2 protocol change.~~ **DONE 2026-08-17** —
  `workers/agent/src/gateway.ts`, protocol v2, migration 010. `APPIUM_ENABLED=1` no longer needs an
  operator-supplied tunnel, and a host can now serve WebDriver on more than one device.
- ~~**Blocker 4:** the real adb serial as `appium:udid`, plus a distinct `appium:systemPort`.~~
  **DONE 2026-08-17** — protocol v2, migration 011. Both backends already computed the serial and
  never published it; `systemPort` and `mjpegServerPort` are now derived per device by the worker.
  A device reporting no serial is refused rather than mis-targeted.
- Real Appium 2 + UiAutomator2 against real Cuttlefish. The hub has only ever spoken to a stub; the
  supervisor has only ever supervised a fake. **Expect disagreement.**
- Run the real Kotlin suite and the real Flutter/RN suite. Measure. This is where the SwiftShader
  question gets answered with data.

Exit: an existing Appium suite, unmodified except for one URL, runs green from a laptop over
Tailscale against both devices in parallel.

### Phase 2 — Production host

- ~~Durable Postgres.~~ **DONE 2026-08-17** — `deploy/docker-compose.prod.yml`: named volume,
  `--data-checksums` (only settable at initdb, so it had to be decided now), `restart: unless-stopped`,
  loopback-only binding, `shm_size` raised, capped logs. The tmpfs stack stays as the *test* stack and
  now says so in a header nobody can miss.
- ~~Backups with a tested restore.~~ **DONE 2026-08-17** — a sidecar on the same image as the server
  dumps the database *and the cluster roles* every 6h, verifies each archive with `pg_restore --list`,
  writes `.partial` then renames, and prunes only after a success. `deploy/restore-drill.sh` seeds a
  scratch database, destroys it, restores with the real scripts, and checks rows, checksum, RLS+FORCE,
  policies and grants. **It runs in CI.** RPO is one backup interval — there is no WAL archiving, and
  no off-box copy yet; `deploy/README.md` states both plainly rather than implying otherwise.
- ~~Dedicated owner role for the `SECURITY DEFINER` allocator functions (known issue 5).~~
  **DONE 2026-08-17, migration 012** — `mfarm_definer`, NOLOGIN/NOSUPERUSER, privileges on exactly
  the five tables the bodies touch. Also revoked PUBLIC EXECUTE from the three tenant-facing
  functions, which 008 had missed. CI asserts both.
- ~~Compose with restart policies; the box reboots and the farm comes back unattended.~~
  **DONE 2026-08-17** — `api` and `migrate` services in `deploy/docker-compose.prod.yml`, ordered
  postgres-healthy → migrate-completed → api, all loopback-bound, secrets as files.
- Rotate `mfarm_app`'s committed password (known issue 4) — an operator step, documented in
  `deploy/README.md`; `config.ts` refuses to boot in production if it is skipped.
- Tailscale ingress only. **No public ports.** TLS internally.
- Collapse `db.ts`'s duplicated connection literals into `config.ts` (known issue 7); validate
  `PG_POOL_MAX` (known issue 8).
- Prometheus + Grafana + alerting on device health, queue depth, and reset failures.

Exit: reboot the box, walk away, come back to a working farm.

### Phase 3 — Artifacts and observability

- APK upload, install, launch, and uninstall outside Appium.
- Logcat capture per session, streamed and stored.
- Video recording per session; screenshots on demand and on failure.
- Artifact store — MinIO on the same box, S3 API, retention policy.
- Fix known issue 9: `GET /v1/sessions/:id` returns no `dataPlane` block, so the CLI cannot produce
  `MFARM_DATA_PLANE_ENDPOINT` / `MFARM_SESSION_TOKEN` on the queued path.

Exit: a failed CI run links to video, logcat, and screenshots of exactly that session.

### Phase 4 — Web UI

Deliberately last, and still the thing that makes it feel like a product.

- Device grid: what exists, what state, who holds it, for how long.
- Live interactive view: WebRTC from Cuttlefish + the existing WebSocket input path.
- Session list and detail with artifacts inline.
- App library — upload, version, install to a device in one click.
- Health dashboard and queue visibility.
- Human auth. Today there are API keys only; teammates need login plus per-user keys, so a session is
  attributable to a person.

### Phase 5 — Hardening

- Blocker 5, if a second API instance is ever wanted: Redis rate limiter, and a single reaper owner
  (leader election or advisory lock). **Both are correct at N=1 and both degrade silently**, so this
  is a prerequisite for instance #2, not for launch.
- Wedged-Appium detection. The supervisor detects process death only; an Appium that answers
  `/status` 200 forever while wedged stays advertised (known issue 2).
- Per-user quotas and session TTL policy.

## Infrastructure

> **Revised 2026-08-17 (second pass).** The first pass said bare metal was mandatory and AWS was
> absurd. Both are now wrong — see "Nested virtualisation changed the answer" below. The spend
> strategy is R&D-first: **do not commit to a monthly box until the farm is scoped and proven.**

### Host requirements

The hard requirement is **x86_64 with a usable `/dev/kvm`**, not bare metal specifically.

- Snapshot/restore is x86_64-only (Finding 1), so Arm hosts — Graviton, Apple Silicon, Ampere — are
  out for the production substrate regardless of price.
- A "KVM VPS" in hosting marketing usually means *the host* uses KVM, not that you get nested
  virtualisation. Confirm `/dev/kvm` exists **inside** the machine before paying for a month of it.

Sizing for 2 devices with headroom to 6–8:

| | Minimum | Recommended |
|---|---|---|
| CPU | 8 physical cores | 16+ cores — SwiftShader is CPU-bound |
| RAM | 32 GB | 64 GB+ (~4–8 GB per cvd instance, plus host) |
| Disk | 500 GB NVMe | 1 TB+ NVMe (images, snapshots, videos, APKs) |
| OS | Ubuntu 24.04 LTS | same |

### Nested virtualisation changed the answer

**AWS, 16 Feb 2026:** nested virtualisation is now supported on *virtual* C8i / M8i / R8i instances
in all commercial regions, enabled via a `NestedVirtualization` parameter on the EC2 API. KVM is
supported, and AWS names "running emulators for mobile applications" as an intended use case. `.metal`
at $4–5/hr is no longer required. C8i is available in ap-south-1 (Mumbai).

**GCP** has supported this for years and is Cuttlefish's *reference* remote environment — AOSP ships
`device/google/cuttlefish/tools/create_base_image.go` specifically to build a GCE host image.
Restrictions: not E2, not Arm, not AMD (except N4D), Linux KVM only, no extra licence cost. Google
documents **"a 10% or greater decrease in performance for CPU-bound workloads."**

**That performance caveat lands exactly where it hurts.** SwiftShader rendering *is* the CPU-bound
workload. So:

> Spike 1 and 2a numbers measured on a nested-virt VM are **pessimistic** relative to bare metal.
> That is the safe direction for a go/no-go, but record the substrate alongside the number, or a
> future reader will mistake a nested-virt density figure for the real ceiling.

### Spend strategy — three tiers, commit late

**Tier 0 — ₹0, start immediately.** Most of the remaining work needs no device at all. The control
plane, WebDriver hub, ADR-0004 gateway, the B2 protocol change, artifacts plumbing, auth, and the
entire web UI are substrate-agnostic and already develop against fakes — that is how 267 tests run
today. Build all of it on the Mac for nothing.

Local limits worth knowing (M1, 8 cores, **8 GB RAM, 11 GB free disk** as of 2026-08-17): one AVD is
comfortable, two plus Postgres plus two Appium servers will swap. Disk is the tighter constraint —
Android system images run 2–4 GB each. Free space before attempting even one AVD.

**Tier 1 — ~$30–60 total, only when Tier 0 needs real hardware.** Rent by the hour, stop the instance
between sessions.

| | Pick | Rough cost |
|---|---|---|
| AWS | `c8i.4xlarge` (16 vCPU / 32 GiB) ap-south-1, `NestedVirtualization` enabled | ~$0.75–0.85/hr |
| AWS, more headroom | `m8i.4xlarge` (16 vCPU / 64 GiB) | ~$1.00/hr |
| GCP | `n2-standard-16` + nested virt, asia-south1 | comparable; **$300 free trial credits** |

What Tier 1 is *for* — and it is a short list, so keep sessions short:

1. Verify the `cvd` flags in `cuttlefish.ts` against a real install (known issue 1).
2. Prove snapshot take/restore with `guest_swiftshader` + `--enable_virtiofs=false`.
3. Run spikes 1 and 2a, recording "nested virt" beside the numbers.
4. Two devices in parallel, real Appium, real Kotlin **and** Flutter/RN suites — the Finding 1
   measurement.

Cost discipline: a *stopped* EC2 instance bills no compute, but the EBS volume persists at roughly
$0.08–0.10 per GB-month — ~$16–20/mo for 200 GB. To approach zero between sessions, snapshot the
volume to S3 and delete it. GCP's $300 / 90-day trial credit covers this whole tier outright; check
AWS Activate credits too if the company qualifies.

**Tier 2 — commit only after the farm is proven.** Always-on, and only now does the monthly bill make
sense:

| Option | Rough cost | Read |
|---|---|---|
| Indian dedicated EPYC (Inservers/GBNodes, Atal Networks) | ₹8,000–12,000/mo | Cheapest per core; diligence IPMI, network, support |
| E2E Networks | Higher | NSE-listed, Indian, data-sovereignty story |
| AWS c8i/m8i always-on, ap-south-1 | ~$550–750/mo | Convenient, and the worst value at this duty cycle |
| **Own mini PC in the office** | **₹50,000 once** | Full KVM, zero recurring, India-local, no nested-virt tax. You own the uptime. |

Bare metal and an owned mini PC share one advantage the clouds cannot match here: **no nested
virtualisation overhead on the CPU-bound rendering path.** At Tier 2 that is worth real money.

Against the alternative: one BrowserStack parallel is roughly $150–200/mo and you would want two. The
farm pays back in months, and the number does not scale with usage — which is the point.

### Security posture

- Tailscale/WireGuard only. Nothing listening on a public interface, including Appium — an
  internet-facing Appium port is unauthenticated device control.
- Appium stays bound to `127.0.0.1`; reachability comes from the ADR-0004 gateway plus a signed
  per-request grant, not from opening the network. A VPN authenticates the *network*; the grant
  authenticates the *request*. Tailscale is defence in depth, not the authorization model.
- Per-user API keys, revocable, attributable.
- The four rules in `HANDOFF.md` ("Rules earned the hard way") apply to every new definer function
  and DB path. They were each found by a failing test, not by review.

## Immediate next step

**Revised: start Tier 0, spend nothing.** The earlier "book the box first" advice assumed bare metal
was mandatory and therefore that hardware gated everything. It does not. Phase 1's real content — the
ADR-0004 worker gateway, the B2 protocol change, the `appium:udid` and `systemPort` fixes — is
specified, blocked by nothing, and develops against the existing fakes at zero cost.

Reorder to:

1. **Now, ₹0:** build the Phase 1 gateway + protocol change on the Mac against fakes.
2. **Then, one metered day (~$30–60):** spin up a nested-virt VM, work the four-item Tier 1 list,
   destroy it.
3. **Only then:** decide Tier 2, with real numbers instead of estimates.

Phase 0 does not disappear — it becomes a short, bounded, *metered* session rather than a
prerequisite that idles everything else.
