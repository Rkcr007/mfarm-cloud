# MFARM — status

**Open this first.** What the product is, what works, what is left, and what it costs to run.
Re-derived 2026-09-07 at `bebc821` / migration 042 / ADR-0029 — every number below was read from the
code, the farm or `git` on that day, not carried forward from the last version of this page. Two
numbers on the last version had decayed and are corrected here; see §5.

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

---

## 3. Where each part stands

| Area | State | The honest caveat |
|---|---|---|
| **Console (UI)** | **Working, and now the only one.** The full design package at `/`: sign-in, Fleet, catalogue, cockpit, bring-up, apps, runs, health, agents, team, settings. Both themes. Zero console exceptions across every surface. The React console at `/app` is deleted — it never reached parity, and while both were served the new sign-in screen landed on its two-screen preview instead of on the product. | Twenty-five defects have been found in it, all by USING it and **none by the 1413-test suite**. All are closed. |
| **API / control plane** | **Working** — allocation, leases, fencing, reset, quarantine and gated recovery, runs, outcomes, artifacts, RLS tenancy, metrics. 39 migrations. | **Single instance only.** Rate limiting is in-memory, so a second API process silently multiplies every limit. |
| **WebDriver hub** | **Working**, hardware-verified. An existing Appium suite migrates with one URL and two capabilities. | — |
| **Virtual devices** | **Working** — four Cuttlefish on one host, ~30s cold boot, live view 49–53 fps. | One device host. A host outage is a farm outage; ADR-0027 and migration 038 reduce what one costs, they do not remove it. |
| **Physical devices** | **Built, not currently serving.** Agent, pairing (ADR-0014), org-pinning, the outbound tunnel and the reset story (ADR-0012) are all built. | The farm's one `SM-S918B` is quarantined behind a machine that has not beaten since **2026-08-29**. Nothing is wrong with the code — it needs `npx @mfarm/agent` on that machine. |
| **Agent** | **Working.** One binary, loopback window, no admin rights (ADR-0009). | A device ARRIVING still re-registers the agent — the heartbeat reconciles devices it knows and cannot create one. Deliberate (ADR-0027). |
| **Deploy / ops** | **Working, gaps instrumented.** `check-deployed.sh` answers "is this farm running `main`?" for the serving image and both checkouts; `verify-live.sh` asks it too. | **Deploy is manual.** A released commit reaches the farm when somebody runs `mfarm-deploy.sh`. Reported now, not closed. |
| **Observability** | **Working** — Prometheus, Grafana, alert rules, host heartbeat and tunnel metrics. | No worker-side metrics: the agent reports incidents, not gauges. |
| **Video / recording** | **Not built, deliberately.** Costed, and unbuilt until it can record only failures. | — |
| **Execution timeline UI** | **Built (2026-09-07).** A *What happened* card on the run screen, and a *Steps* card on the session screen with the failing WebDriver commands in red (ADR-0029). | Red is reserved for a test failing; an incident is amber. The distinction the run screen already kept, kept here too. |
| **Failure evidence** | **Built (2026-09-07).** A failed result requests its own screenshot and logcat, each naming the test (migration 040). | Up to one beat — ten seconds — after the assertion. The step trace is what makes a late screenshot readable. |
| **Queue** | **Working, and fair as of ADR-0028.** FIFO within an org, round-robin across them, per-org concurrency caps, device-class matching (ADR-0025). | A queued caller is told it is queued and nothing else — no position, no estimate. `EXECUTION_ROADMAP.md` S6. |

---

## 4. What is pending, in priority order

### 1. Decide whether a four-device farm goes in front of a second team

**Not a capability question, and still the only one that matters.** The execution model works, the
console has been used hard and its register is empty, and the farm has run real suites. What has
never happened is somebody who did not build it trying to use it for a day. Everything below is
smaller than this.

### 2. Deploy is manual — the largest operational gap

A merged, CI-green, released commit reaches the farm when a human runs `mfarm-deploy.sh`. It went
unnoticed for ninety minutes once, while the defect register claimed those fixes were live.
`check-deployed.sh` reports the gap; **reporting is not closing.** Either a deploy step on the
Release workflow, or an alert when the serving sha and `origin/main` diverge.

### 3. The handset is out of the fleet, and one command puts it back

`SM-S918B` is quarantined behind a machine that last beat on 2026-08-29. `npx @mfarm/agent` on that
machine re-registers it with its panel and its capabilities. **Physical hardware — cannot be done
from the repo.**

### 4. Single-instance only

Rate limiting is in-memory (`apps/api/src/http/server.ts`). Correct for one instance and named as
such in the code. It is the one module between here and running two.

### 5. Video, and a queued caller who is told nothing

The two remaining steps of [`EXECUTION_ROADMAP.md`](EXECUTION_ROADMAP.md). **S5 video** records only
failures, reusing the encoder the live view already runs, and is gated on one measurement: what
host-side encode costs against the `RENDER_BASELINE.md` Flutter-canvas workload. **S6** gives a
queued caller a position and an estimate — `POST /v1/sessions` currently says only "no device is
free right now", which over fifteen minutes of CI log is indistinguishable from a hang.

### 6. A device arriving still restarts the agent

Bounded and deliberate after ADR-0027. Worth revisiting only if hot-plug becomes common.

---

## 5. The numbers, measured

| | |
|---|---|
| Tests | **1413**, green, across three workspaces plus `deploy` |
| Migrations | **42 in the repo, 38 applied on the farm** — 039–042 land with the next deploy |
| Decisions | 28 ADRs (there is no 0013) |
| Merged PRs | 125 |
| Defects | 26 recorded, **26 closed** |
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
  [`RUNBOOK.md`](RUNBOOK.md) (start, ship, stop).
- **Building it** — [`EXECUTION_ROADMAP.md`](EXECUTION_ROADMAP.md), the sequenced plan from here to
  a production execution engine: what each step changes in the schema, in the code, and how it is
  verified.
- **Using it** — [`EXECUTION_MODEL.md`](EXECUTION_MODEL.md), [`ci.md`](ci.md),
  [`../examples/medishop-suite/README.md`](../examples/medishop-suite/README.md).
- **The record** — [`../HANDOFF.md`](../HANDOFF.md) is the numbered session log. **Trust its dated
  entries over its summary; the entries have held up under audit and the summaries decay.**
- **Historical plans** — `MVP_PLAN.md`, `E2E_MVP_PLAN.md`, `DOMAIN_PLAN.md`, and the two
  `product_guide` files at the repo root. Read for reasoning, not for current truth.
