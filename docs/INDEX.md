# MFARM — the one page

Everything about this product: what it is, what is built, every decision and why, the roads
deliberately not taken, and what running it on real hardware taught us that no test could.

Curated 2026-08-24, at `95f6701` / migration 022. **If you read one file, read this one.** Every
other document is linked from here and none of them needs to be read first.

---

## 1. What MFARM is

A **self-hosted Android device farm**. You point an existing Appium or WebdriverIO suite at one
extra URL, and it runs on real Android devices the farm allocates, resets and bills for — instead of
on an emulator on somebody's laptop.

The devices are **Cuttlefish** virtual Android instances on a Linux host with KVM. The bet is
"physical-device-like testing at virtual-device economics".

**Live now:** `https://farm.mfarm.dev`, two devices, running commit `95f6701`.

| Piece | Where | State |
|---|---|---|
| Control plane, API, console, WebDriver hub | `mfarm-cp` (e2-medium) | always on |
| Devices, Appium, worker agent, TURN relay | `mfarm-lab` (n2-standard-16) | started on demand |

The two machines are separate on purpose — [ADR-0006](adrs/0006-control-plane-and-device-host-are-separate.md).
`mfarm-lab` costs ~₹65/hour running and ~₹42/day stopped, so it is **not** left up.

---

## 2. Start here, by what you want

| I want to… | Read | Then |
|---|---|---|
| **get it running** from a closed laptop | [START_HERE.md](START_HERE.md) | `./deploy/farm-online.sh`, `./deploy/farm-check.sh` |
| **run my test suite on it** | [../examples/medishop-suite/README.md](../examples/medishop-suite/README.md) | [ci.md](ci.md) for CI |
| **understand how execution works** | [EXECUTION_MODEL.md](EXECUTION_MODEL.md) | §4 is the built/unbuilt list |
| **understand the architecture** | [../HANDOFF.md](../HANDOFF.md) | [adrs/](adrs/) for the reasoning |
| **build the installable agent** | [AGENT_BUILD_PLAN.md](AGENT_BUILD_PLAN.md) | Phased, with a hardware gate on every phase |
| **run a physical device** | [PHYSICAL_DEVICES.md](PHYSICAL_DEVICES.md) | Prerequisites, enrollment, what a reset does |
| **operate or deploy it** | [RUNBOOK.md](RUNBOOK.md) | §7 below for the invariants |
| **know what is safe to change** | §7 below | then the ADR that owns the area |

---

## 3. Every document, and whether it is still true

**Current — trust these.**

| Document | What it is |
|---|---|
| [../HANDOFF.md](../HANDOFF.md) | The state of play and every known issue. The longest and most load-bearing file in the repo. |
| [START_HERE.md](START_HERE.md) | Closed laptop → a device you can tap, in seven steps. |
| [EXECUTION_MODEL.md](EXECUTION_MODEL.md) | How a suite actually runs: capabilities, runs, outcomes, artifacts. §4 is the roadmap. |
| [RUNBOOK.md](RUNBOOK.md) | Start it, ship to it, stop it. The reference under START_HERE. |
| [RENDER_BASELINE.md](RENDER_BASELINE.md) | What SwiftShader can and cannot test. Measured, not assumed. |
| [ci.md](ci.md) | Running your suite from CI, with the GitHub Action. |
| [adrs/](adrs/) | Ten accepted decisions, each with its rejected alternatives. §5 below summarises them. |
| [../examples/medishop-suite/README.md](../examples/medishop-suite/README.md) | The worked example: 8 tests, one build, one run, real outcomes. |
| [../apps/api/README.md](../apps/api/README.md), [../apps/cli/README.md](../apps/cli/README.md), [../workers/agent/README.md](../workers/agent/README.md), [../deploy/README.md](../deploy/README.md) | Per-package detail. |

**Historical — read for reasoning, not for current truth.**

| Document | Status |
|---|---|
| [MVP_PLAN.md](MVP_PLAN.md) | Plan of record for the 2026-08-17 pivot. Delivery sequencing is now largely done; the reasoning stands. |
| [E2E_MVP_PLAN.md](E2E_MVP_PLAN.md) | The "console renders → a teammate uses it" plan. Milestones M0–M4, mostly delivered. |
| [DOMAIN_PLAN.md](DOMAIN_PLAN.md) | Decision doc for putting the farm on a domain. **Done** — see issue 29. |
| [../product_guide_v2.md](../product_guide_v2.md) | The SaaS framing, rebuilt around cost/latency. **Superseded for sequencing** by MVP_PLAN. |
| [../product_guide.md](../product_guide.md) | The original brief. **Superseded** by v2. Kept for provenance. |

> The chain is `product_guide.md` → `product_guide_v2.md` → `MVP_PLAN.md` → `E2E_MVP_PLAN.md` →
> `EXECUTION_MODEL.md`. Each narrowed the one before it. **Only the last two describe what is being
> built now.**

---

## 4. What is built, and what is deliberately not

**Built and verified on real hardware.**

- Device lifecycle: allocate, lease, fence, powerwash reset, release, reap — multi-tenant, RLS-enforced
- W3C WebDriver hub — an existing suite migrates with one URL and two capabilities
- App library: upload once, name a build by id or `com.acme.app@latest`
- **`mfarm:appId`** — the farm installs your build before the session opens
- **`mfarm:runId` + runs** — twenty tests are one run, not twenty unrelated leases
- **Outcome reporting** — the suite says what passed; a run that says nothing reads "Not reported"
- **On-demand screenshots** — captured while the app is still on screen
- Artifacts: logcat + screenshots, content-addressed, 14-day retention
- Web console: sign-in, devices, apps, sessions, runs, queue, health, and a live device cockpit
- Live device view over WebRTC at 49–53 fps, with touch, logcat and screenshots
- CLI (`mfarm`), a GitHub Action, CI, and a commit-tagged deploy pipeline

**Not built, and each for a stated reason** — this is §6.

---

## 5. Every decision, and what it rejected

The ADRs are the record. Each one names the alternative it turned down, which is usually the more
useful half.

| # | Decision | What it rejected, and why |
|---|---|---|
| [0001](adrs/0001-control-plane-service-runtime.md) | An explicit entrypoint, fail-fast config, split liveness/readiness, one owner for the reaper | A process that boots with a broken config and *looks* healthy. Also blocks multi-instance until rate limiting leaves memory. |
| [0002](adrs/0002-cli-is-a-wrapper.md) | `mfarm run` wraps your command; it is not a test runner | Owning the runner. It would have to understand every framework, and exit codes would stop being yours. |
| [0003](adrs/0003-capability-honesty-appium-supervisor.md) | A host advertises `webdriver` only while a supervised Appium is *actually* ready | Advertising a static capability list. A device that claims what it cannot do fails at connect time, after a lease is spent. |
| [0004](adrs/0004-automation-transport.md) | The worker terminates the automation hop, authorised by a signed Ed25519 grant | A private network / VPN between control plane and worker. The grant is verifiable offline; a network is a thing to keep alive. |
| [0005](adrs/0005-media-reachability.md) | Media reaches the browser through a **TURN relay** | An overlay network (Tailscale). It would require client software on every viewer's machine. |
| [0006](adrs/0006-control-plane-and-device-host-are-separate.md) | Two machines | One box. The control plane must survive the device host being stopped — and it is stopped most of the time, because it is the expensive one. |
| [0007](adrs/0007-live-view-signaling-relay.md) | Signaling relayed through the data plane; **media is not proxied** | Proxying media. It would put every frame through the control plane and make CSP a permanent fight. |
| [0008](adrs/0008-physical-devices-behind-the-existing-agent.md) | Physical devices are a third **backend** behind the existing agent, reached over a tunnel the agent dials out | A second standalone agent, and a statically-routed `/dp/*`. A phone arrives on a laptop behind NAT, where neither works. |
| [0009](adrs/0009-the-agent-is-a-product.md) | The agent is **one signed binary with a loopback window** — no installer, no admin rights | A container (USB passthrough is unsupported on macOS/Windows), WebUSB (cannot run Appium or reach iOS), and a platform installer as the *first* path (needs elevation, which QA laptops do not grant). |
| [0010](adrs/0010-ios-without-xcode.md) | iOS runs on **every host**: WebDriverAgent is built once by us, re-signed, and installed anywhere | Appium's XCUITest driver, which drags the macOS requirement back in. WDA already speaks WebDriver, and the gateway already proxies it. |
| [0011](adrs/0011-automation-over-the-tunnel.md) | Automation rides the agent's outbound tunnel; the gateway binds **loopback** | Verifying the grant in the tunnel handler. A check that exists twice eventually disagrees with itself, so the agent replays the request against its own gateway. |
| [0012](adrs/0012-borrowed-devices-reset-by-what-they-installed.md) | A release undoes **what the session installed**; the package sweep is opt-in, chosen by the device's owner | Keeping the sweep behind a mandatory keep list. An unrecoverable default that is safe only when configured — and the probe that checked it was itself wrong. |
| [0014](adrs/0014-pairing-is-a-device-authorization-grant.md) | The **agent shows a code**, the console redeems it — RFC 8628, retiring the two-step `curl` | Minting from the console instead. It puts a bearer credential back in a text field and asks the unauthenticated side to prove who it belongs to. |
| [0015](adrs/0015-the-agent-is-not-an-app-on-the-device.md) | An MFARM **app on the phone cannot be the agent** — a device cannot host the thing that tests it | Shizuku-style self-pairing. Real privileges, and still killed by Doze, wiped by a reset, and absent on iOS. |
| [0016](adrs/0016-virtual-devices-present-as-named-handsets.md) | ~~Two virtual devices are configured to **be a Galaxy S25 / S25 Ultra**~~ — **superseded by 0017** | Matching the geometry but keeping `model` honest. That is the alternative 0017 went on to choose. |
| [0017](adrs/0017-devices-are-mfarm-hardware.md) | The devices are **MFARM's own hardware** — *MFARM X1 Pro* / *X1*. A profile configures geometry, density, RAM and cores, and writes **no identity into the guest** | Keeping the Samsung profiles alongside MFARM ones. Rejected: it preserves every cost — apps taking Samsung code paths AOSP cannot answer, an x86_64 device named after an arm64 phone, and 60s added to every reset — for a capability the product direction does not want. |

---

## 6. Roads not taken — and why

These are choices, not gaps. Each was considered and declined with a reason.

**Video recording.** Costed 2026-08-24 and deliberately unbuilt. At 1 Mbps a 5-minute recording is
**~12× all other artifacts combined** (measured: 3.1 MB/session today) and would exhaust the control
plane's 24 GB in **~1.3 days** at full utilisation. It also encodes *in-guest* on a host with no
GPU, competing with SwiftShader on the workload that already shows 1350 ms frozen frames — so it
degrades the thing it is supposed to observe. Recording **only failures** makes it affordable, and
that only became expressible once outcome reporting existed. Build order is in
[EXECUTION_MODEL.md §4.4](EXECUTION_MODEL.md).

**A GPU host.** [RENDER_BASELINE.md](RENDER_BASELINE.md) measured ordinary UI at a full 60 fps in
both native and Flutter. A GPU is only justified if the app under test paints continuously. Also
blocked in practice: the billing account is free-tier, which refuses every accelerator at create
time.

**Inferring pass/fail.** The farm could guess from exit codes or logcat exceptions. It is wrong in
both directions — a suite can fail assertions and exit zero, and a session can end dirtily because
CI was cancelled. A confidently wrong green number stops people looking, so a run with no reports
says **"Not reported"** instead.

**A run `status` or `ended_at` column.** A sequential suite ends every session before starting the
next, so "the last session ended" would mark a twenty-test run finished nineteen times before it
was. Derived from the sessions instead.

**Deduplicating retries.** A test failing then passing under the same name *is* the flakiness
signal. Collapsing it would discard the most valuable thing the results table can show.

**Snapshot reset.** 8s vs 40–80s — but a snapshot-restored Cuttlefish **publishes no display**, so
the live view dies. `CF_RESET_MODE=powerwash` trades recycle speed for a working screen. On cvd
1.55.1 you cannot have both.

**Multi-instance control plane.** Blocked deliberately: rate limiting is in-memory, so a second
instance would silently double every limit ([ADR-0001](adrs/0001-control-plane-service-runtime.md)).

**MinIO / S3 for artifacts.** The S3 API buys nothing on a single box and is one more service to
keep alive. Bytes go to the existing content-addressed store.

---

## 7. Invariants — break these and it fails silently

Each was found by a failing test or a real deployment, not by review. **Check against these before
touching the areas they name.**

1. **`SECURITY DEFINER` bypasses RLS.** Authorization must be re-implemented inside the function
   body. `release_device()` once let any tenant end any other tenant's session.
2. **Never connect the app as a superuser.** Superusers bypass RLS unconditionally, so every policy
   reads as enabled while doing nothing.
3. **Coalesce positional input, queue discrete input.** Dropping a stale tap is correct; dropping a
   keypress means typing "hello" yields "hlo".
4. **Scope definer mutations on both sides of the fleet boundary, and revoke EXECUTE from PUBLIC.**
   Postgres grants EXECUTE to PUBLIC by default — never having granted it is not the same as it
   being unreachable.
5. **A column nothing writes is a claim with nothing behind it.** `video` was removed from the
   artifact kinds rather than left as an aspiration.
6. **`text` + CHECK, not an enum.** `ALTER TYPE … ADD VALUE` cannot be used in the transaction that
   adds it. Migration 022 paid for this lesson; 019 had already written it down.
7. **`app.inject()` cannot see socket-level behaviour.** Anything depending on connection lifecycle
   needs a test that binds a real port — see §8.

---

## 8. What running it taught us that tests could not

The full list is HANDOFF's numbered issues. These are the ones that changed how the code is written.

**`req.raw.destroyed` does not mean the client hung up** (issue 31). It means the request body has
been read, which Fastify does *before* the handler runs. Both of the hub's long waits used it, so
**`mfarm:appId` failed on every session** while 634 tests passed, and **`mfarm:queueTimeoutSeconds`
had never queued on any deployment**. The install wait reported "still installing after 240s" having
waited about a millisecond — the message named the configured budget, not elapsed time, so it read
as a slow device. *Rule that came out of it: never quote a limit as if it were a measurement.*

**A snapshot pins an absolute HOME and is worthless once its group is rebuilt** (issue 19), and
**cvd's instance database outlives the host**, so a restart bricked the farm until repair was scoped
to the group (issue 18).

**The device host's IP was ephemeral** while coturn advertised it, so the console worked perfectly
and video silently never arrived, with an empty relay log because nobody ever called it (issue 29).

**`docker compose up -d api` silently serves `:latest`** and reports success on an older build
(issue 29). The deploy script now writes `MFARM_IMAGE` into `.env`.

**A new named volume comes up root-owned** unless the Dockerfile creates its directory — the deploy
succeeded, the console was fine, and every artifact capture failed with `EACCES`.

**A check that reports success on no data is worse than no check.** `verify-live.sh` reported a
green "live view available" for a farm with zero devices, because it grepped an empty response.

---

## 9. Every number we actually measured

No estimates in this table.

| What | Measured |
|---|---|
| Cuttlefish cold boot | 38 s |
| Snapshot restore | 8 s (4.75× faster; snapshot 4.0 GB) |
| Powerwash reset | 40–80 s |
| Live view | 49–53 fps |
| Native UI scroll | 60 fps, 8.0% jank, 50 ms worst frame |
| Flutter UI scroll | 60 fps, 19.4% jank, 133 ms worst |
| Flutter drawing canvas | 30 fps, 69.9% jank, **1350 ms worst** |
| Session open with `mfarm:appId` | 12–15 s incl. heartbeat + `adb install` |
| Queued request promoted | 69 s (powerwash + beat + promotion) |
| Artifacts per session | logcat 2.55 MB, screenshot 0.59 MB |
| On-demand screenshot | 79,644 bytes |
| Control-plane disk | 29 GB, 24 GB free |
| Test suite | 652 tests, 0 fail, real PostgreSQL 16 |

---

## 10. Verifying it yourself

Nothing here is trusted because a command exited zero.

```bash
./deploy/farm-online.sh          # start both machines
./deploy/farm-check.sh           # API, fleet, /dp, coturn — from the control plane

# on mfarm-cp, MFARM_API_KEY=$(cat deploy/.state/api_key)
node deploy/verify-runs.mjs      # §4.1–§4.5 end to end against a real device
node deploy/verify-queue.mjs     # fills the farm and proves the queue queues
node deploy/verify-webdriver.mjs # one plain WebDriver session, every hop
node deploy/verify-render.mjs    # the rendering baseline

gcloud compute instances stop mfarm-lab --zone asia-south1-c   # it bills by the hour
```

---

## 11. What is next

1. **Physical Android devices** — decided 2026-08-24,
   [ADR-0008](adrs/0008-physical-devices-behind-the-existing-agent.md). This reverses what §4 of
   `E2E_MVP_PLAN.md` and Phase 7 of `product_guide_v2.md` said, on purpose and on instruction.
   Milestone 0 is built and green but **has never run on hardware**: agent enrollment tokens,
   org-pinned devices, and a data-plane tunnel the agent dials out so a phone on a NAT'd laptop is
   reachable. The gate before anything is built on top of it is that the EXISTING Cuttlefish farm
   still passes `verify-live.sh` and `verify-webdriver.mjs` through that tunnel.
2. **Nothing in the execution model.** §4.1–§4.5 are built and hardware-verified. Video stays
   unbuilt until it records only failures.
3. **The honest next question is still not a capability** — it is whether a two-device farm with a
   working execution model is worth putting in front of a second team.
4. **Standing constraints:** multi-instance is blocked by in-memory rate limiting; publishing is
   blocked because every package is `"private": true`; observability has no host metrics and no
   worker-side metrics.
