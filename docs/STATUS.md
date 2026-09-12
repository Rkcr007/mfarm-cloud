# MFARM — status

**Open this first.** What the product is, what works, what is left, and what it costs to run.
Re-derived 2026-09-07 at `5089232` / migration 043 / ADR-0029 — **and deployed**: the farm is running this — every number below was read from the
code, the farm or `git` on that day, not carried forward from the last version of this page. Two
numbers on the last version had decayed and are corrected here; see §5.

**Updated 2026-09-11** at `975693f` / migration 048: the hub contract is now verified on real
devices, and one claim this page made about test rows was too strong and is corrected in §4.6.

Two other documents complete the picture and nothing else is required reading:

| | |
|---|---|
| [`DEFECTS.md`](DEFECTS.md) | Everything found by USING the product, with severity by what it costs a person |
| [`DIRECTION.md`](DIRECTION.md) | What changed and why — every pivot, every decision, every road not taken |

---

## 1. What this application is

**A self-hosted Android device farm.** You point an existing Appium or WebdriverIO suite at one
extra URL, and it runs on Android devices the farm allocates, resets and accounts for — instead of
on an emulator on somebody's laptop.

The devices are **Cuttlefish** virtual Android instances on a Linux host with KVM, presented as
MFARM's own hardware (*MFARM X1 Pro*, *MFARM X1*), plus **physical handsets** on any machine running
the agent. The bet is physical-device-like testing at virtual-device economics.

Three ways in, all built:

- **WebDriver** — `https://farm.mfarm.dev/wd/hub`, one URL and two capabilities. An existing suite
  migrates without changing a test.
- **The console** — `https://farm.mfarm.dev`. Pick a device, watch it boot, tap it live, install a
  build, read logcat, release it.
- **The CLI** — `npx @mfarm/cli`, plus a GitHub Action for CI.

---

## 2. What it costs to run

This is the constraint that shapes every operational decision in the repo.

| Machine | What it is | Running | Stopped |
|---|---|---|---|
| `mfarm-cp` | control plane: Postgres, API, console, Caddy/TLS | ~₹3/hour (~₹2,300/mo) | ~₹250/mo (disk) |
| `mfarm-lab` | device host: four Cuttlefish devices, Appium, worker, coturn | **~₹65/hour** | ~₹1,260/mo (disk) |

**The device host is ~95% of the bill, so it is stopped between sessions and the control plane is
not.** That split is why ADR-0006 puts them on separate machines at all: the thing you look at is
not the thing that costs ₹65/hour, and the console, the API and every link into them keep resolving
while the expensive half is off.

Stopped VMs still bill for disks. Only deleting the disks stops that, and that throws away the farm.

**Current state: `mfarm-lab` STOPPED, `mfarm-cp` RUNNING.** That is the resting state, not a
half-finished one.

**This sentence was WRONG for three and a half hours on 2026-09-12, and the correction is the
point.** It used to end "…and returned to rest afterwards", written on 2026-09-11 about the
migration-048 verification. The machine did not return to rest: it ran from 23:39 UTC on the 11th
until it was noticed and stopped at 03:10 on the 12th — **₹230**, for nothing, while this page
asserted it was off.

That is ADR-0035's incident at one-sixth the size and with the same cause: the only signal that the
farm is on is knowing you switched it on. The difference is that the console now SAYS so — the
header read `host up 3h 1m · ~₹196` the whole time — so the instrument worked and nobody was looking
at it. **`MfarmHostIdleCost` does not exist yet**; §4 records that gap rather than this page
pretending it is closed.

**Do not trust this line. Ask the machine:**

```bash
gcloud compute instances list --project mfarm-lab --format='table(name,status)'
```

---

## 3. Where each part stands

| Area | State | The honest caveat |
|---|---|---|
| **Console (UI)** | **Working, and now the only one.** The full design package at `/`: sign-in, Fleet, catalogue, cockpit, bring-up, apps, runs, health, agents, team, settings. Both themes. Zero console exceptions across every surface. The React console at `/app` is deleted — it never reached parity, and while both were served the new sign-in screen landed on its two-screen preview instead of on the product. | Twenty-five defects have been found in it, all by USING it and **none by the test suite**. All are closed. |
| **API / control plane** | **Working** — allocation, leases, fencing, reset, quarantine and gated recovery, runs, outcomes, artifacts, RLS tenancy, metrics. 52 migrations. API keys are labelled, scoped, expiring and attributed (ADR-0034). | **Single instance only.** Rate limiting is in-memory, so a second API process silently multiplies every limit. |
| **WebDriver hub** | **Working**, hardware-verified. An existing Appium suite migrates with one URL and two capabilities. | — |
| **Virtual devices** | **Working** — four Cuttlefish on one host, ~30s cold boot, live view 49–53 fps. | One device host **today**, not by design: the control plane has been audited per-host and the tooling now takes a list, so adding a second is a VM and a runbook rather than code — [`SECOND_HOST.md`](SECOND_HOST.md). Until somebody pays for one, a host outage is still a farm outage. |
| **Physical devices** | **Built, not currently serving.** Agent, pairing (ADR-0014), org-pinning, the outbound tunnel and the reset story (ADR-0012) are all built. | The farm's one `SM-S918B` is quarantined behind a machine that has not beaten since **2026-08-29**. Nothing is wrong with the code — it needs `npx @mfarm/agent` on that machine. |
| **Agent** | **Working.** One binary, loopback window, no admin rights (ADR-0009). | A device ARRIVING still re-registers the agent — the heartbeat reconciles devices it knows and cannot create one. Deliberate (ADR-0027). |
| **Deploy / ops** | **Working.** `check-deployed.sh` answers "is this farm running `main`?" for the serving image and for **each** device host's checkout (it takes `MFARM_LABS`); `verify-live.sh` asks it too. Deploy is **automatic** — `mfarm-autodeploy.timer` pulls every five minutes, health-gates on five consecutive `/ready` answers and refuses to retry a commit that failed (ADR-0030). | The **device host** is deliberately excluded from auto-deploy: fast-forwarding its tree restarts the agent under running sessions, so it is brought forward by hand. |
| **Observability** | **Working** — Prometheus, Grafana, alert rules, host heartbeat and tunnel metrics. Host disk/load/memory and **what a powered-on host is costing** are now readable in the console (ADR-0035, migration 050). | No worker-side metrics: the agent reports incidents, not gauges. There is no ALERT on an idle host yet — the console shows it, nothing pages about it, and on **2026-09-12 that cost ₹230**: the header read `host up 3h 1m · ~₹196` for three and a half hours and nobody was looking. The instrument works; the absence of a pager is the gap. |
| **Video / recording** | **Not built. The gate is now measured (2026-09-07) and it decided the design.** `screenrecord` costs the Flutter canvas a third of its frame rate and doubles ordinary UI's dropped frames, so guest-side encode — which is both `screenrecord` and scrcpy — is not available here. | S5 must encode on the HOST, reusing `cvd`'s WebRTC encoder; that path does not exist yet. The immediate alternative is video for physical devices only. `RENDER_BASELINE.md`. |
| **Test rows** | **Built 2026-09-12.** A run's session row unfolds into a row per test, and the session screen lists everything it reported — passing tests named, not only counted. No new endpoint: `/v1/sessions/:id/results` already answered it. | A test that ran and never reported is not here and is not counted as passing — the farm cannot see an assertion. |
| **Execution timeline UI** | **Built (2026-09-07).** A *What happened* card on the run screen, and a *Steps* card on the session screen with the failing WebDriver commands in red (ADR-0029). | Red is reserved for a test failing; an incident is amber. The distinction the run screen already kept, kept here too. |
| **Failure evidence** | **Built (2026-09-07).** A failed result requests its own screenshot and logcat, each naming the test (migration 040). | Up to one beat — ten seconds — after the assertion. The step trace is what makes a late screenshot readable. |
| **Tunnel to a private host** | **Built 2026-09-12 (ADR-0037, migration 052).** `npx @mfarm/cli tunnel` dials out from the customer's network; a session sets `mfarm:tunnel` and the device's HTTP traffic reaches `staging.acme.internal`. The allow-list is enforced in the customer's own client, default deny. Console screen at `#/tunnels`. | **`https://` targets are not proxied yet** — that needs a CONNECT byte-stream channel; the proxy says so rather than failing as a certificate error. And **the Android proxy setting is unverified on hardware**: everything downstream of `adb shell settings put global http_proxy` is tested, that one command is not. |
| **Sharing a failure** | **Built 2026-09-12 (ADR-0036, migration 051).** A revocable, expiring link at `/s/<token>` shows ONE test result — its message, the screenshot captured for it, and the steps between the previous test and this one — to somebody with no account here. Its own page, not the console. | It deliberately carries **no logcat and no recording**, and those are decisions rather than gaps — see the ADR. A link can outlive the evidence it points at, since artifacts go on their org's retention schedule. |
| **Hub contract** | **Extended and DEPLOYED 2026-09-09** (`7faf06c`, migration 048, ADR-0033).** A session takes its test name at creation (`mfarm:name`), a run takes a readable one (`mfarm:runName`), a suite can ask for a device class (`mfarm:deviceClass`), and an outcome can be reported through the driver the teardown already holds (`executeScript("mfarm-status=…")`). `examples/java-testng/` is the adapter for a suite arriving from LambdaTest. | **VERIFIED ON REAL CUTTLEFISH 2026-09-11** — `deploy/verify-hub-contract.mjs`, 30/30: a session reads back its test name before any result is posted, `mfarm:deviceClass=mfarm-x1-pro` lands on the X1 Pro, an absent class is refused *naming the class*, the teardown hook writes a named row through the driver, a misspelled status is refused without killing the session, an ordinary `executeScript` still reaches Appium, and the second session joins the run without renaming it. Seen on the console: Runs shows `Android_UAE_Expenses_…` over its CI id. The remaining gap is narrower than this page used to claim — see §4.6. |
| **Queue** | **Working, fair (ADR-0028), and it says where you stand (migration 043).** FIFO within an org, round-robin across them, per-org caps, device-class matching (ADR-0025). A queued caller gets a position and, where one can be proved, an estimate. | The estimate reads the lease, so it is the LATEST a device frees — usually pessimistic — and it is omitted rather than guessed where no lease is readable. |

---

## 4. What is pending, in priority order

### 1. Decide whether a four-device farm goes in front of a second team

**Not a capability question, and still the only one that matters.** The execution model works, the
console has been used hard and its register is empty, and the farm has run real suites. What has
never happened is somebody who did not build it trying to use it for a day. Everything below is
smaller than this.

### 2. ~~Deploy is manual~~ — **CLOSED 2026-09-07, ADR-0030**

A merged, CI-green, released commit used to reach the farm when a human ran `mfarm-deploy.sh`. It
went unnoticed for ninety minutes once, while the defect register claimed those fixes were live.

`mfarm-autodeploy.timer` now asks every five minutes whether the farm is running `main`, and the box
PULLS rather than CI pushing — a deploy job in Actions would need a standing SSH credential into
production, and pulling is ADR-0006's shape. It health-gates what it deploys on five *consecutive*
`/ready` answers, rolls back the image on failure, and **refuses to retry a commit that failed** —
without that memory a timer turns one bad merge into a restart every five minutes forever.

Both halves of the old suggestion shipped: the deploy is automatic AND the divergence is alerted.
`mfarm_autodeploy_pending_seconds` is the gap as a number, and `MfarmFarmBehindMain` pages on it.

**The device host is deliberately excluded.** Fast-forwarding the worker's tree restarts the agent
under running sessions; the installer refuses that box and names the by-hand path. That guard was
itself wrong on its first attempt and is now D28.

### 3. The handset is out of the fleet, and one command puts it back

`SM-S918B` is quarantined behind a machine that last beat on 2026-08-29. `npx @mfarm/agent` on that
machine re-registers it with its panel and its capabilities. **Physical hardware — cannot be done
from the repo.**

### 4. Single-instance only — and the blocker is NOT the rate limiter

Rate limiting is in-memory (`apps/api/src/http/server.ts`), correct for one instance and named as
such in the code. It was described here as "the one module between here and running two". **That is
wrong**, and the audit in `EXECUTION_ROADMAP.md` S7.3 says why: `TunnelRegistry` is decorated per
Fastify instance and holds its hosts in a process-local `Map`, and since ADR-0011 it carries
**automation**, not only the live view. Behind a naive round-robin a second instance would not
merely double the limits — roughly half of all tunnel-transport WebDriver sessions would fail.

Correct order is tunnel affinity first, rate-limit store second. Neither is worth building until
something needs a second instance, and nothing does.

### 5. ~~Video~~ — **CLOSED 2026-09-07, ADR-0032, migration 045**

Both options this section offered turned out to be the wrong question. **Cuttlefish already ships a
host-side recorder**: `record_cvd` drives `RecordingManager`, which tees the same
`VideoTrackSourceInterface` that feeds the live view into its own VP8 encoder, on the host. Measured
on the farm: **29.8 fps recording against 29.9 not**, where guest `screenrecord` costs 33%.

Record everything, keep only what a suite reported as failed (`VIDEO_RECORDING=off|failures|all`,
the farm runs `failures`). Verified end to end by `deploy/verify-video.mjs`, 17/17 on real
Cuttlefish. Measured output ~120 kbps — about 8x cheaper than the 1 Mbps `EXECUTION_MODEL.md` §4.4
assumed, which moves a saturated farm from filling the disk in 1.3 days to 11.

**The execution engine is now complete**: every step of `EXECUTION_ROADMAP.md` is built or
deliberately deferred with a reason.

**The player is verified by eye on the deployed console (2026-09-07).** Signed in as a real user at
`https://farm.mfarm.dev`, a failed session's Evidence card renders the recording with the browser's
own controls reading **0:00 / 0:23** — a duration it can only know by fetching the header over a
range request — and a **Jump to: verify-video** button under it. That closes the D26-shaped gap:
until then the `<video>` was covered only by tests against seeded state.

**One thing about it is still unverified**, and it is not a blocker: four *busy* recorded devices.
Arm D of the perturbation measurement drove one of four, and an idle device publishes almost no
frames, so it showed that three idle recorders are free rather than that four working ones are.

### 6. ~~Test rows~~ — **CLOSED 2026-09-12**

**The half that was already fine, stated first, because this page got it wrong once.** The run
screen's **Sessions** table has a TEST column, and with **one test per session** — the LambdaTest
shape, one Appium session per Cucumber scenario, and exactly what `examples/java-testng/` migrates
— every test has rendered by name, passing ones included, since migration 048. This document and
`DEFECTS.md` both once claimed otherwise; that correction stands.

**What was genuinely missing is now built.** A session running SEVERAL tests collapsed to one row
reading `PASSED 5/5`: five ran, five were counted, and not one of their names existed anywhere in
the console. Two surfaces close it, and neither adds an endpoint —
`GET /v1/sessions/:id/results` already answers this exactly:

- **On the run screen, the count is a control.** Pressing it folds out a row per test — name,
  status, how long it took, the first line of any failure, and a Share button on a red one. One
  request per row a person opens, so a nightly run of two hundred sessions costs nothing until
  somebody asks. Several rows can be open at once, which is the point: "which of these ran the OTP
  scenario" is a comparative question.
- **On the session screen, a Tests card** lists everything that session reported, not only what
  failed. Folded past eight, with the real total on the control. A session that reported ONE test
  grows no card — the session's own name is already that test.

**What it still cannot show is a test that ran and never reported.** MFARM cannot observe an
assertion; a suite that crashes before its `afterEach` leaves nothing here, and the card says so
rather than counting it as passing.

### 7. The tunnel's last hop needs one lab session

**Everything except one `adb` command is built and tested** (ADR-0037). The path from a device's
HTTP client through both tunnels to a host on the customer's network is exercised end to end over
real sockets, with a real CLI client and a real private server — `apps/api/test/tunnel-end-to-end.test.ts`.

What has not been run is `adb shell settings put global http_proxy <host>:<port>` against a live
Cuttlefish guest, and whether that setting survives the reset between sessions. An Android guest
with that setting makes exactly the request the test makes by pointing an HTTP client at the same
listener, so what is unverified is the setting, not the path. It needs the lab up for about ten
minutes.

**Also unbuilt and deliberately so: `https://` through the tunnel.** It needs a raw byte-stream
channel kind beside the framed one, because a CONNECT is a TLS stream rather than a request and a
response. The proxy answers 405 with a sentence naming the limitation, which is the honest failure —
accepting the CONNECT and producing a socket that speaks nothing surfaces in an app as a certificate
error and sends somebody to debug the wrong machine.

### 8. Frameworks that do not speak WebDriver

**Not a capability — an execution path, and none exists.** `/wd/hub` is the only automation entrance
in this repo; there is no `adb shell am instrument` door anywhere in `apps/api` or `workers/agent`.

Anything with an Appium client already works in any language, and `examples/python-pytest/` is the
evidence: a suite in a language this repo had never used, written and green on real devices the same
hour, with zero farm-side changes. **Espresso, native UIAutomator and Maestro are the ones that do
not fit** — they are instrumentation, not WebDriver. Worth costing only if somebody actually arrives
with such a suite.

### 9. A device arriving still restarts the agent

Bounded and deliberate after ADR-0027. Worth revisiting only if hot-plug becomes common.

---

## 5. The numbers, measured

| | |
|---|---|
| Tests | **1719**, green, across three workspaces plus `deploy` — measured 2026-09-12 |
| Migrations | 52; 051 is deployed, **052 is not on the farm yet** |
| Decisions | 36 ADRs, numbered to 0037 (there is no 0013) |
| Merged PRs | 173 |
| Defects | 46 recorded, **44 closed** |
| Fleet | 4 Cuttlefish + 1 physical handset |
| Cold boot | ~30s per device |
| Live view | 49–53 fps, ~39ms round trip, direct path |
| Install → confirmed | ~8–12s, worker-reported |

**Two numbers moved down, and neither is a regression.** The suite was 1441 across five workspaces
on 2026-09-06 and is 1382 across three today: deleting the React console at `/app` (PR #122) took its
tests with it, and `packages/protocol` has no test script at all — the "five workspaces" was counting
workspaces, not workspaces with tests. Both figures were carried forward rather than re-read, which
is the failure mode this page's header exists to prevent.

**The ratio worth knowing:** every one of the 25 defects was found by clicking through a real farm.
The suite has never found a console defect. That is not an argument against the suite — it catches
different things, and it caught two security regressions this month — it is an argument for using
the product before believing it works.

---

## 6. Verifying any of this yourself

```bash
./deploy/check-deployed.sh    # is the farm running main? ask this FIRST
./deploy/farm-online.sh       # start both machines
./deploy/farm-check.sh        # wait for devices, report what is live
./deploy/verify-live.sh       # on mfarm-cp: the full post-start check
./deploy/verify-console.sh    # 62 checks against the deployed console, from anywhere
```

An hour spent verifying against a farm running something other than `main` is an hour spent
measuring nothing, which is why the first line is first.

---

## 7. Everything else in this repo

These three documents are the whole picture. The rest is reference, and each sits under one of them:

- **Operating it** — [`START_HERE.md`](START_HERE.md) (closed laptop → a device you can tap),
  [`RUNBOOK.md`](RUNBOOK.md) (start, ship, stop), [`SECOND_HOST.md`](SECOND_HOST.md) (adding a
  device host, and what is still single afterwards).
- **Building it** — [`EXECUTION_ROADMAP.md`](EXECUTION_ROADMAP.md), the sequenced plan from here to
  a production execution engine: what each step changes in the schema, in the code, and how it is
  verified.
- **Using it** — [`EXECUTION_MODEL.md`](EXECUTION_MODEL.md), [`ci.md`](ci.md),
  [`../examples/medishop-suite/README.md`](../examples/medishop-suite/README.md).
- **The record** — [`../HANDOFF.md`](../HANDOFF.md) is the numbered session log. **Trust its dated
  entries over its summary; the entries have held up under audit and the summaries decay.**
- **Historical plans** — `MVP_PLAN.md`, `E2E_MVP_PLAN.md`, `DOMAIN_PLAN.md`, and the two
  `product_guide` files at the repo root. Read for reasoning, not for current truth.
