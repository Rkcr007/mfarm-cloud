# MFARM — direction

**What changed, why, and what we have as a result.** The decisions are the valuable half of this
repo: each one names the alternative it turned down, and that is usually the more useful record.

For where things stand today read [`STATUS.md`](STATUS.md); for what is wrong with it read
[`DEFECTS.md`](DEFECTS.md). This document is the reasoning behind both.

---

## 1. The pivots, in order

Four times the direction changed materially. Each is dated, and each reversed something that had
been written down as settled — which is why they are listed together rather than buried in the
document that each one contradicted.

### 2026-08-17 — from a hosted SaaS to a self-hosted two-device farm

`MVP_PLAN.md` replaced the SaaS framing of `product_guide_v2.md`. The bet became: prove the whole
loop on hardware somebody can actually afford to leave running, rather than build for a scale that
did not exist. **The console was never the mock — the devices were.**

### 2026-08-24 — physical devices are in scope after all

[ADR-0008](adrs/0008-physical-devices-behind-the-existing-agent.md). `E2E_MVP_PLAN.md` §4 and Phase
7 of `product_guide_v2.md` both said physical devices were "not needed, not planned, not blocking".
That was true of a two-device virtual farm and stopped being true. They became a third **backend**
behind the existing agent, reached over a tunnel the agent dials out — because a phone arrives on a
laptop behind NAT, where a listening port does not work.

### 2026-08-29 — MFARM's own hardware, not a Samsung clone

[ADR-0017](adrs/0017-devices-are-mfarm-hardware.md) supersedes
[ADR-0016](adrs/0016-virtual-devices-present-as-named-handsets.md).
`MFARM_PRODUCT_DIRECTION_AND_DEVELOPMENT_RESET.md` at the repo root is the instruction. Configuring
devices to *be* a Galaxy S25 cost real things — apps taking Samsung code paths AOSP cannot answer, an
x86_64 device named after an arm64 phone, 60s on every reset — for a capability the product does not
want. The devices are *MFARM X1 Pro* and *MFARM X1*; a profile configures geometry, density, RAM and
cores and writes **no identity into the guest**.

### 2026-09-01 — MFARM owns the execution RECORD, not the test process

[ADR-0018](adrs/0018-an-execution-is-a-record-the-client-drives.md). `AutomationExecutionPlan.md`
§3/§22 asked for a console RUN button and `POST /executions {suite}` — MFARM holding and running the
customer's test code. That contradicts [ADR-0002](adrs/0002-cli-is-a-wrapper.md) and costs a sandbox,
per-framework knowledge, custody of customer source and CI secrets. **The test process stays the
customer's; the end of a run is declared, never derived.**

---

## 2. What we have, as capabilities

- Device lifecycle: allocate, lease, fence, powerwash reset, release, reap — multi-tenant, RLS-enforced
- W3C WebDriver hub — an existing suite migrates with one URL and two capabilities
- App library: upload once, name a build by id or `com.acme.app@latest`
- `mfarm:appId` — the farm installs your build before the session opens
- `mfarm:runId` + runs — twenty tests are one run, not twenty unrelated leases
- Outcome reporting — the suite says what passed; a run that says nothing reads "Not reported"
- On-demand screenshots, captured while the app is still on screen
- Execution timeline — what the farm DID during a run, append-only, in order
- A live event stream — SSE with the backlog replayed on connect
- A declared end — so `failed = 0` stops meaning "so far"
- Artifacts: logcat + screenshots, content-addressed, 14-day retention
- Web console: sign-in, fleet, catalogue, apps, sessions, runs, queue, health, and a live cockpit
- Live device view over WebRTC at 49–53 fps, with touch, logcat and screenshots
- Physical handsets behind the same agent, org-pinned, reset by what they installed
- Bounded reset recovery — a reset that will never succeed stops being retried and says so
- Capability withdrawal in place — an unhealthy Appium costs that device its `webdriver`, not the host
- CLI (`@mfarm/cli`), a GitHub Action, CI, and a commit-tagged deploy pipeline
- Failure injection — breaks real things on real hardware and asks whether the farm comes back clean

---

## 3. Every decision, and what it rejected

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
| [0018](adrs/0018-an-execution-is-a-record-the-client-drives.md) | An execution is a **record MFARM owns**, not a suite MFARM runs. The test process stays the customer's; the end of a run is **declared**, never derived | The hosted runner — upload a suite, MFARM installs deps and executes it. Rejected for now: it buys a RUN button and costs a sandbox, per-framework knowledge, custody of customer source and CI secrets, and ADR-0002's exit-code contract. BrowserStack has no RUN button for Appium either. |
| [0019](adrs/0019-a-reset-that-cannot-succeed-escalates-rather-than-retrying.md) | A reset that keeps failing **escalates** after three counted attempts and stops being offered — an attempt is measured on the reaper's clock, not per heartbeat | Quarantining after N failures. It stops the only mechanism that could recover the device. Counting per heartbeat offer, which makes the budget a function of beat frequency. |
| [0020](adrs/0020-the-farm-absorbs-its-own-infrastructure-retries.md) | An infrastructure retry is **the farm's cost, not the customer's** — one `origin='user'` attempt per session, enforced by a partial unique index | Counters on the runs rollup: cheaper to query, but it loses which device caused which retry. A separate `executions` table, which duplicates `sessions`. |
| [0021](adrs/0021-the-tunnel-pings-because-close-is-not-guaranteed.md) | **Both ends ping** and terminate a peer that stops answering — `terminate()`, not `close()`, so it synthesises the `close` the existing recovery already waits for | Pinging from one end only. They catch opposite failures: the agent's ping finds a vanished control plane, the server's finds a host that went away without saying so and would otherwise hand viewers a channel whose frames go nowhere. |
| [0022](adrs/0022-the-live-view-is-shared-not-ported.md) | ~~The React console **imports `live.js`** rather than reimplementing it~~ — **Obsolete 2026-09-06**: that console is deleted, so there is one consumer again and nothing to share. The decision it defended still holds — `live.js` remains the single implementation of Cuttlefish's signalling vocabulary | Rewriting it in TypeScript: 779 lines was never the cost, maintaining the protocol twice against a device platform we do not control was. |
| [0023](adrs/0023-the-published-cli-is-compiled-and-scoped.md) | The published `@mfarm/cli` is **compiled JavaScript** and checks its Node floor at startup; the repo keeps running TypeScript directly | Publishing the TypeScript and requiring Node 22.6+. It makes the customer's Node version our problem forever to save a 40-line build. A bundler — the package has zero dependencies, there is nothing to bundle. |
| [0024](adrs/0024-releasing-a-quarantine-authorises-an-attempt.md) | Releasing a quarantine **authorises a recovery attempt**, never availability — the device goes to `PREPARING`, and only a completed reset plus a passing health check reported by its own host reaches `READY` | Release sets `READY`, which makes the quarantine a pause. A condition on `QUARANTINED` — that state stops the reset offers that ARE the preparation flow. A condition on `CLEANING`, which makes one word mean two things on every screen, metric and alert. |
| [0025](adrs/0025-the-allocator-hands-over-a-device-class.md) | The allocator hands over a **device class**, on the immediate path and off the queue — and "no profile" is one of those classes, which is why it takes a flag as well as a value | One nullable parameter: it cannot express "the unprofiled devices", so "Start Unprofiled device" would allocate an X1 Pro. Carrying the class inside `requested`, which is documented as an opaque tenant blob distinct from scheduling input. Matching on geometry instead — deferred, and the right shape for opt-in substitution. |
| [0026](adrs/0026-the-console-shows-a-heartbeat-not-a-hostname.md) | The device page shows **`Host last seen`** and never the hostname — a heartbeat only sharpens a fact the tenant already reads off the device's state, while a hostname is a stable label that groups their devices beside somebody else's, permanently, and cannot be acted on | Hostname to org admins only — still a tenant, still cannot act on it. A pseudonymous `host-3` — leaks exactly the co-tenancy signal and none of the operator value. `devices.updated_at` as "Last registered" — honest, and answers a question nobody has. |
| [0027](adrs/0027-a-capability-is-withdrawn-in-place.md) | An unhealthy Appium withdraws **that device's** `webdriver` on the next heartbeat and the agent does **not** restart — the protocol change ADR-0003 called "not yet made" shipped 2026-09-01, and the blunt drain it justified outlived it by five days and cost a 13-minute farm outage | A short grace window — re-introduces a period advertising what cannot be served, to save seconds of correct unavailability. Keeping the drain for the "permanent" case — that is the supervisor's judgement about Appium, not evidence the device is unusable. Superseding ADR-0003 — its decision is unchanged; only its implementation note is obsolete. |
| [0028](adrs/0028-the-queue-is-round-robin-across-orgs.md) | The queue is ranked per org: **round-robin across orgs, strict FIFO within one** — and the `max_concurrent` cap check does not move | The old window of the twenty oldest queued sessions fleet-wide: one capped org with twenty queued filled it, and every other org's session was never read while devices sat `READY`. Priority or quotas now — a policy knob with one customer and no evidence behind its default. |
| [0029](adrs/0029-the-hub-writes-down-what-it-forwards.md) | The proxy records the **shape of every command it forwards** — method, path, status, duration, W3C error code — and nothing about its meaning: **no bodies, no headers** | Asking the suite to report steps: every customer instruments their tests in every framework, forever — the thing the product exists to avoid. Parsing the Appium log: a format nobody promises, held in a ring buffer that is never uploaded. |
| [0030](adrs/0030-the-box-pulls-main-on-a-timer.md) | A **systemd timer on the control plane pulls `main` every five minutes** and deploys it; a commit that fails a one-minute health gate is **rolled back and never retried** | CI pushing the deploy: a standing SSH credential into production in a repo secret. Retrying a failed commit: every tick would redeploy it, forever — a restart loop strictly worse than the manual deploy it replaces. |
| [0031](adrs/0031-a-host-reports-its-own-machine.md) | A host's **disk, load and memory ride the heartbeat**, and an **unmeasured value emits no series at all** | Zero-filling a missing reading, as the fleet gauges do: a zero disk gauge reads as a full disk, and would have paged for every host on an older agent at the first scrape. `os.freemem()`: it excludes the page cache, sits near zero on a healthy box, pages constantly and gets turned off. |
| [0032](adrs/0032-video-evidence-comes-from-the-host-not-the-guest.md) | Video is recorded **on the host by cvd's own recorder** (`record_cvd`); every session is recorded and **almost every recording is deleted** — `failures` keeps only sessions whose suite reported one | Guest-side encode: `screenrecord` measured costing the Flutter canvas a third of its frame rate (29.9 → 20.0 fps), and `scrcpy` encodes in the guest too. A `video-stop` verb: a second mechanism that works in the common case and fails in precisely the cases video exists to explain. |
| [0033](adrs/0033-the-hub-takes-the-labels-a-dashboard-is-built-on.md) | The hub takes **`mfarm:name`, `mfarm:runName` and `mfarm:deviceClass`**, and the outcome through **`executeScript("mfarm-status=…")`** — the labels and the teardown a suite already has | Requiring `POST …/result` for an outcome: a Cucumber `@After` cannot call it without a new HTTP client, a dependency and somewhere to put the key. `mfarm:build` as the run label — in MFARM a build is an APK. One field as both CI join key and readable name — both are wanted at once and they disagree. |
| [0034](adrs/0034-a-key-says-what-it-is-for.md) | An API key **carries a required label, a scope and an expiry**; new keys default to `automation`, which **cannot delete evidence** | A capability list: eleven strings of which the code checks one — reads as a security feature while enforcing nothing. One-click creation with only the columns added: an unlabelled key is exactly what makes rotation impossible. Per-key rate limits, for now: a second in-memory structure with the limiter's multi-instance problem. |
| [0035](adrs/0035-a-host-costs-money-while-it-is-ready.md) | **Usage and cost are reported separately**: cost is host-hours powered on, from `hosts.up_since` × a **configured** rate — a ready host costs money the meter cannot see | A per-org usage view alone: `metering_events` recorded a few minutes across a twenty-hour burn. Alerting instead of a display — the person who leaves a farm on is looking at the console. Auto-stopping an idle host — the farm cannot tell idle from between two CI suites. |
| [0036](adrs/0036-a-failure-can-be-shown-to-somebody-with-no-account.md) | A failure can be shared as a **revocable, expiring link scoped to one test result**, on its own page — **partially superseded by 0040**: its exclusion of the logcat and the recording no longer holds | A session or run share: every widening is a disclosure nobody reviewed. A signed URL: it cannot be withdrawn, and `revoked_at` is what makes a mistaken share recoverable. Sending the recipient the console: they would get a login form. |
| [0037](adrs/0037-a-device-reaches-the-customers-own-network.md) | **The side with the private network dials out**: `npx @mfarm/cli tunnel` holds a socket to the control plane, and the **allow-list is enforced only in the customer's client** | Asking the customer to open a port — what their security team exists to prevent. Putting the farm on their VPN — it authenticates the network rather than the request, as ADR-0004 refused. An allow-list in the control plane — a rule the customer would have to take our word for. |
| [0038](adrs/0038-operating-the-farm-is-a-capability-not-a-role.md) | **Operating the farm is a capability** (`users.operator`), orthogonal to org role; every operation is **written down before it is attempted**, and cost comes from a trigger-derived power ledger — **amended by 0041** | A fourth `memberships.role` value: it models the wrong relationship and makes a farm-wide grant per-tenant. A `fleet_operators` join table: a LEFT JOIN on the hottest query for one boolean. Cost from `metering_events`: right for billing a tenant, wrong for operating a farm. |
| [0039](adrs/0039-a-failure-is-read-against-its-own-history.md) | A failing test shows **the last 20 runs of the same name in the org**, and a run's cost prices each session at **the host rate divided by the devices on its host** | Whole-host rate × device-minutes: ~4× overstated on a four-device host. Rate × host-hours overlapped: double counts shared hours, so per-run costs sum to more than the bill. Dividing by devices busy at the time: a lone nightly run pays for the whole host. A test id: a protocol change on every reporter. |
| [0040](adrs/0040-a-share-can-carry-the-log-and-the-recording.md) | A share **can carry the logcat and the recording**: two per-link flags, **false in the API and checked by default in the console's dialog**, chosen once at creation — supersedes those sections of 0036 | Keeping both excluded: the log travelled anyway, pasted into chat with no expiry. Default-on in the API too: it would silently widen what every existing API caller discloses. Server-side redaction: a promise of safety the product cannot keep. |
| [0041](adrs/0041-the-console-is-a-workspace-not-a-page.md) | The console is a **workspace: the page never scrolls, panels do**, and the cockpit is the device beside one tabbed dock — amends 0038 to return one host fact, **for fleet operators only** | The stacked session screen, where reading a log line scrolled the phone out of sight. A window media query for the stacking breakpoint — collapsing the rail changes the space without changing the window. The handoff's Unicode glyphs — they render at whatever weight and baseline each platform picks. |
| [0042](adrs/0042-a-stopped-host-is-not-capacity.md) | **A stopped host is not capacity**: a DOWN host withdraws its devices, a beat restores them unless a stop is still in progress, and the console shows `starting`/`stopping` — amends 0038 and 0041 | Sweeping DOWN hosts in the reaper: it sets them QUARANTINED and turns the card back to `unknown`. A trigger on `hosts.state`: it hides the restore from anybody reading the heartbeat and registration routes. Disabling Start for a fixed time: a timer is a guess about GCE. |
| [0043](adrs/0043-mfarm-ai-is-an-agent-on-our-own-hub.md) | **MFARM AI is rebuilt natively over the hub**, not by embedding Artemis; the MCP server is a WebDriver client, and **MFARM pays the model provider and bills per AI step** | Installing Artemis on each host: it speaks local ADB, which customers do not get, and would put a second runtime on every host and make it Android-only. Bring-your-own-key — recommended, and overruled by the owner. |
| [0044](adrs/0044-nothing-is-started-that-cannot-finish.md) | **Nothing is started that cannot finish**: a per-provider circuit breaker and one go/no-go (`/v1/ai/readiness`) gate the doors, and **the runner takes the model first, then a device** — amends 0043 | Discovering each dependency by failing — a run took a device and installed the app before learning the model's allowance was spent. A second key on the same provider as the fallback: it shares the outage and, on a free tier, the allowance. Persisting provider health: a fact true for minutes is not worth a schema. |
| [0045](adrs/0045-a-secret-is-named-never-written.md) | **A secret is named in a task (`{{PIN}}`), never written into it**: values live sealed in the org's store, are never returned, and **are never shown to the model** — amends 0043 | A docker secret of its own for the key: compose refuses to start without the file, breaking the next auto-deploy of any farm lacking one. `pgcrypto` with the key in SQL: the key lands in query text and logs. Masking alone (#221): it treats the symptom where it is shown. |
| [0046](adrs/0046-the-model-writes-the-test-once.md) | **The model writes a test once; the farm runs it**: a passing AI run is compiled into a plan that replays with no model call, and AI is called only where the plan misses — amends 0043 | Keeping the agent on every run with a cheaper model: ~₹5 a login instead of ₹44, forever, on every build — rejected as the end state. Export as script (C9) as enough: a file the manual-QA buyer cannot maintain, and it never heals. Bring your own key: moves the bill, not the waste. |
| [0047](adrs/0047-the-media-relay-lives-on-the-control-plane.md) | **coturn runs on the control plane**, the one machine that is always up, and **the agent never relays itself** (D70) — amends 0005 | Keeping it on the device host and that host running: ₹65/hour to relay for phones that do not use it. A small VM of its own: ~₹500/month and another machine to patch, for isolation not yet a real need. A managed TURN service: per-GB pricing on the one number that scales with viewers. |
| [0048](adrs/0048-a-phones-stream-follows-its-viewers-link.md) | **A phone's encoder rate follows its viewers' links**: the RTCP round trip steps it down fast and up slowly across five tiers, and the slowest viewer sets it — amended the same day (constant bitrate, the agent's own round trip, a consent wait that grows with the queue) and **verified in Chrome on a 2 Mbit/s relayed link, 2026-10-09** | Driving the rate from REMB: it starts near 300 kbit/s and reads a mostly still screen as congestion at the start of every session. Stepping down one tier at a time: a queue of seconds needs relief now. An encoder per viewer: scrcpy binds one server per device. |
| [0049](adrs/0049-ssh-reaches-the-farm-through-iap.md) | **SSH reaches both machines through IAP and nothing else**: port 22 admits Google's IAP range only, the device host runs as its own service account with no storage scope, and the control plane has a snapshot and deletion protection — amends 0006 | Leaving 22 open on key-only authentication: it holds until a key leaks. OS Login with two-factor: more to set up, and IAP already removes the open port. A snapshot schedule: a standing cost and a retention decision nobody asked for. |
| [0050](adrs/0050-an-enrolled-host-is-not-the-farms.md) | **A machine an org enrolled is not the farm's**: `hosts.org_id` is the kind, an enrolled host has **no rate (null, not zero)**, raises no silence alarm, and is sent in its own list, out of the rollup, the cost and the metrics — amends 0035 and 0038 | A `kind` column: a second statement of a fact the row already holds, and one a person can set wrong. Zero for the rate: a zero renders as a measurement. One list with a `kind` on each row: every count would have to remember a filter. |
| [0051](adrs/0051-a-retired-host-can-be-seen-and-put-back.md) | **A retired host is listed and can be restored** by an operator; its devices return to the state they were in, and until then they are **in no fleet list and no gauge** — amends 0038 and migration 056 | Leaving un-retiring to registration: no help to somebody who retired the wrong row. Purging the row: it throws away what the machine cost and what its devices did. |
| [0052](adrs/0052-a-device-can-be-forgotten.md) | **A device that is gone can be forgotten, not deleted**: only while it is OFFLINE or quarantined, hidden by a predicate that **can never hide an allocatable device**, and it comes back by itself when its agent sees it | Deleting the row: a session could no longer say which phone it ran on. Hiding on `retired_at` alone: one missed path leaves a device the allocator hands out and no screen shows. Staying forgotten until a person restores it: a phone plugged back in would be shown nowhere. |
| [0053](adrs/0053-snapshots-can-be-taken-and-deleted-from-the-console.md) | **Snapshots can be taken and deleted from the console, and nothing else about the estate can**: an allow-list of disks, a delete only where the provider attributes the snapshot to a listed disk, and **never the newest READY one** — extends 0038 | Probing the permission instead of a list: it answers "may I", not "should this console". Any snapshot in the project: every hand-made restore point one mistyped name from gone. Letting the operator name it: free text that reaches a cloud API. |

---

## 4. Roads not taken — and why

These are choices, not gaps. Each was considered and declined with a reason.

**A hosted test runner** — upload a suite, MFARM installs dependencies and runs it, and the console
grows a RUN button. Declined 2026-09-01 in [ADR-0018](adrs/0018-an-execution-is-a-record-the-client-drives.md).
The customer's suite runs on the customer's CI against the hub; MFARM owns everything around it and
nothing inside it. **BrowserStack has no RUN button for Appium either** — a hosted runner exists in
this market only where the framework forces it (Espresso and XCUITest put the test code on the
device) or as a separate orchestration product. The cost of building it is a sandbox with egress
control, per-framework version tracking, custody of customer source and CI secrets, and ADR-0002's
exit-code contract. Espresso/XCUITest support will eventually require it; when it does it is an
addition alongside the hub, not a replacement for it.

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

## 5. Invariants — break these and it fails silently

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

## 6. What running it taught us that tests could not

**An injection test is only as good as its ability to fail.** 2026-09-01, building
`deploy/verify-failure.mjs`: three of the first four mistakes were in the CHECKS rather than the
product. `pkill -f appium` matched its own SSH command line and killed the session, surfacing as a
connectivity error. `grep -c` exits 1 on a zero count, so the count threw in exactly the case the
scenario existed to detect. Killing Appium ONCE proved nothing, because it recovers in ~8 s inside a
10 s heartbeat — which produced a confident "ADR-0003 is violated" against a farm behaving correctly.
And "the farm recovered" passed in 0.125 s because killing Appium never takes a device out of the
pool, so the assertion was true before recovery began. Write the negative assertion first and watch
it go red before trusting the green; the SSE tests were mutation-checked for this reason.


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
