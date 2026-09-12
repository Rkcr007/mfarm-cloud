# MFARM — what it is, what works, and how it works

**Hand this to anybody.** It is written to be read cold, by someone who has never seen the repo, and
to leave them able to reason about the system and find their way around the code.

**Every capability claim below was verified by USING the deployed farm on 2026-09-11**, not by
reading the source and not by trusting another document. Where something was verified a different
way — by a script, or only by tests — it says so. Where something does not work, it says that too,
because this project has repeatedly been bitten by documents that were true when written.

| | |
|---|---|
| Verified against | `https://farm.mfarm.dev`, commit `5a052f2`, migration `050` |
| Fleet at the time | 4 Cuttlefish devices READY, 1 physical handset quarantined |
| Test suite | 1,607 passing across four workspaces — measured 2026-09-11 |
| Related reading | [`STATUS.md`](STATUS.md) (where things stand) · [`DEFECTS.md`](DEFECTS.md) (what is wrong) · [`DIRECTION.md`](DIRECTION.md) (why) |

---

## 1. What the product is

**A self-hosted Android device farm.** You point an existing Appium or WebdriverIO suite at one
extra URL and it runs on real Android devices that the farm allocates, installs onto, resets and
accounts for — instead of on an emulator on somebody's laptop.

It is the shape of LambdaTest or BrowserStack App Automation, run on your own machines.

The devices are **Cuttlefish** virtual Android instances on a Linux host with KVM, presented under
MFARM's own hardware names (*MFARM X1 Pro*, *MFARM X1*), plus **physical handsets** on any machine
running the agent. The bet is physical-device-like testing at virtual-device economics.

### Three ways in, all of them working

| | how | verified |
|---|---|---|
| **WebDriver hub** | `https://farm.mfarm.dev/wd/hub` — one URL, an API key, two capabilities | 30/30 contract checks on real devices; a Python suite and a WebdriverIO suite both green |
| **The console** | `https://farm.mfarm.dev` — pick a device, watch it boot, tap it, install a build, read the log, release it | driven by hand today: allocate → install → launch → tap → release |
| **The CLI / CI** | `npx @mfarm/cli`, plus a GitHub Action (`action.yml`) | published to npm; exit codes classified pass / test-failure / infra-failure |

---

## 2. The thing most people get wrong about it

**The farm never decides whether your test passed.**

WebDriver has no concept of an assertion. The farm can see that a session opened, that commands were
forwarded, and that it closed. It cannot see your `expect()`. So a run that reports nothing reads
**"Not reported"** — never "0 failures", because a green number on something nobody measured is the
single most misleading thing a test dashboard can show.

Your suite tells the farm the outcome, one line in your teardown:

```js
driver.executeScript('mfarm-status=passed')   // or failed / skipped
```

This is `lambda-status` renamed on purpose, so a suite migrating from LambdaTest changes one string
rather than acquiring an HTTP client, a dependency and somewhere to put a key.

---

## 3. How a test actually runs

```
your suite                    control plane (mfarm-cp)            device host (mfarm-lab)
─────────                     ────────────────────────            ───────────────────────
POST /wd/hub/session   ──────▶ parse mfarm:* capabilities
  mfarm:region                 allocate a device (or QUEUE)
  mfarm:name                   ├─ fence token issued
  mfarm:runId                  └─ install mfarm:appId  ──────────▶ worker installs the APK
  mfarm:appId                                                      (confirmed, ~5s)
                       ◀────── sessionId (the FARM's id)
                                                                   Appium per device
element / click / …    ──────▶ proxied to Appium        ──────────▶ the real device
                               every command written down
                               (seq, duration, failed, error)
executeScript            ──────▶ "mfarm-status=failed"
  mfarm-status=failed          └─ writes a test_result
                                  └─ requests a screenshot + logcat NOW,
                                     while the device is still held
DELETE /session        ──────▶ release
                               └─ powerwash back to clean snapshot
                               └─ capture logcat, screenshot, recording
```

**Two ids, and the difference matters.** `driver.getSessionId()` returns the **farm's** session id,
not Appium's — so one id spans your test log, the console, the artifacts and the invoice, with no
correlation step.

### The capabilities

| capability | what it does |
|---|---|
| `mfarm:region` | which pool to allocate from (`lab` here) |
| `mfarm:name` | **the test**, at creation — this is what makes a live session list readable |
| `mfarm:runId` | groups sessions into one run. Use `$GITHUB_RUN_ID` |
| `mfarm:runName` | the readable name of the run (`Android_UAE_Expenses_…`). First session sets it |
| `mfarm:appId` | a build from the library: `com.example.app@latest`, `@1.4.2`, or a uuid |
| `mfarm:deviceClass` | which KIND of device (`mfarm-x1-pro`). Not a device name — the farm picks |
| `mfarm:queueTimeoutSeconds` | wait for capacity instead of failing |
| `mfarm:ttlMinutes` | lease length |

Ask for a device class this farm does not have and the session fails **naming the class**, rather
than silently running your suite on the wrong screen geometry.

---

## 4. What is verified working today

Everything in this section was done by hand or by script against the live farm on 2026-09-11.

### The manual path — driven end to end today

1. **Allocate** — pressed *Start MFARM X1 Pro* on Fleet; session opened with a 30-minute lease.
2. **Live view** — a real Android launcher streaming at **49–50 fps, 35 ms round trip, direct path**
   (no TURN relay). Full control rail: power, volume, back/home/recents, rotate, screenshot, zoom.
3. **Install** — MediShop (19 MB) queued and **confirmed by the worker in 4.5 s**.
4. **Launch** — the app opened on the device, **5.6 s** after queueing.
5. **Input** — clicked *Sign In* on the streamed screen; the app processed it and rendered
   *"Invalid credentials"* back. Browser → data channel → device → app → back.
6. **Release** — powerwash to the clean snapshot, device returned to READY, and **evidence captured
   automatically**: a 3.7 MB logcat and a 152 KB screenshot.

### The automation path

- **The hub contract**: 30/30 on real Cuttlefish (`deploy/verify-hub-contract.mjs`) — a session
  carries its test name *before any result is posted*, a device class lands on that class, an absent
  class is refused naming it, the teardown hook writes a named row, a misspelled status is refused
  without killing the session, and an ordinary `executeScript` still reaches Appium.
- **Language independence**: `examples/python-pytest/` was written on 2026-09-11 and was green on
  real devices the same hour **with zero farm-side changes**. `examples/medishop-suite/` is the
  WebdriverIO equivalent. Anything with an Appium client works — the `mfarm:` namespace is a JSON
  object any language can build.
- **Scoped keys don't cost a suite anything**: the same Python suite passed with an
  `automation`-scoped key, and that key got a 403 naming the scope when it tried to delete evidence.

### The console, screen by screen

| screen | what it does | state |
|---|---|---|
| **Fleet** | Capacity / Catalogue / Live / Waiting. Start a device, with or without a build | working |
| **Session** | live screen, control rail, install/launch/uninstall, type-on-device, stream stats, evidence, step trace | working |
| **Apps** | APK library, drag-drop upload, checksum-keyed, install into a held session | working |
| **Runs** | one row per CI job. Search, status filters, keyset pagination | working |
| **Run detail** | failures first, a *What happened* timeline, session list with test names | working |
| **Health** | fleet stats, per-device health, **Machines** (uptime, cost, disk/load/memory), **Usage** chart | working |
| **Agents** | pair a machine that has a phone plugged into it | working |
| **Team** | members and roles | working |
| **Settings** | API keys (labelled, scoped, expiring), evidence retention, hub instructions | working |

---

## 5. How it is built

### Two machines, and why

| | machine | runs | cost running | cost stopped |
|---|---|---|---|---|
| `mfarm-cp` | e2-medium | Postgres, API, console, Caddy/TLS, backups | ~₹3/hour | ~₹250/mo |
| `mfarm-lab` | n2-standard-16 | Cuttlefish devices, Appium, worker agent, coturn | **~₹65/hour** | ~₹1,260/mo |

**The device host is ~95% of the bill, so it is stopped between sessions and the control plane is
not.** That split is the single most important operational fact about this system: the thing you
look at is not the thing that costs money, so the console, the API and every link keep resolving
while the expensive half is off.

### The pieces

```
apps/api/          Fastify + Postgres. Allocation, leases, fencing, runs, artifacts,
                   the WebDriver hub, RLS tenancy, metrics. ~50 migrations.
apps/api/public/   The console — plain JavaScript, no build step, served by the API.
apps/cli/          @mfarm/cli and the GitHub Action.
workers/agent/     Runs on a device host. Owns the device lifecycle, installs, resets,
                   captures evidence, heartbeats, and tunnels back to the control plane.
packages/protocol/ The wire types shared by both sides.
deploy/            Bring-up, deploy, and ~15 verify-*.mjs scripts that check the REAL farm.
docs/adrs/         36 decisions, each with what was rejected and why (numbered to 0037;
                   there is no 0013).
```

### The ideas worth knowing before reading the code

- **Fence tokens.** Every lease carries one. A worker refuses a command whose fence has moved on, so
  a slow message about a device that has since been reassigned cannot act on somebody else's session.
- **RLS is the tenancy boundary**, not a `WHERE` clause someone might forget. Request handlers run as
  `mfarm_app`, which is row-level-security bound. Anything using the system pool says so and carries
  its scope in the SQL, because that scope *is* the authorization.
- **Two principals that never mix.** A tenant key acts on its org's data; a worker token acts on the
  fleet. A worker cannot read tenant data and a tenant key cannot register a host.
- **The worker confirms; the control plane never guesses.** Install, launch and reset are queued and
  reported after the worker says they happened. There is no "running" state to show, because a worker
  reports the outcome and not the start.
- **Append-only metering.** Usage events are idempotent on a worker-generated id, so a retry after a
  network failure is not new usage.
- **The allocator is a reconciliation loop**, not a request handler: queue promotion, idle expiry,
  stuck-install escalation, bounded reset recovery, host-silence quarantine.

---

## 6. What does NOT work, or does not exist

This section is as important as section 4. Read it before promising anything.

| | |
|---|---|
| **iOS** | Not built, deliberately. Android only. |
| **Non-WebDriver frameworks** | Espresso, native UIAutomator and Maestro do **not** work. They run through `adb shell am instrument` or their own agent, and `/wd/hub` is the only automation entrance in this system. That is a new execution path, not a new capability. |
| **One device host** | A host outage is a farm outage. Nothing in the code blocks a second host; it costs a VM, not a rewrite. |
| **One API instance** | `TunnelRegistry` is per-process and carries automation traffic, so a second instance behind a naive round-robin would fail about half of tunnel-transport sessions. Tunnel affinity first, rate-limit store second. Nothing needs it yet. |
| **The physical handset** | `SM-S918B` is quarantined behind a machine that has not beaten since 2026-08-29. The code is fine; it needs `npx @mfarm/agent` run on that machine. |
| **Test rows for multi-test sessions** | A session running several tests shows one row and a count. One test per session — the LambdaTest shape — already renders every test by name. |
| **Share links** | No public URL for a single failure. A viewer needs a console login. |
| **Customer tunnel** | No equivalent of LambdaTest's tunnel binary for reaching a private staging host. |
| **Idle-host alerting** | The console now *shows* a powered-on host and what it costs. Nothing pages about it. |

### Two things that are true but need one command

- **`up_since` is null** for both hosts until each next registers, because migration 050 deliberately
  does not backfill a boot time it never recorded. The uptime and cost display fills in from the next
  host boot.
- **`HOST_HOURLY_COST` is unset** in `deploy/.env`, so the console currently shows hours with no
  currency. Setting it to `65` turns on the money figure.

---

## 7. How to check any of this yourself

```bash
./deploy/check-deployed.sh    # is the farm running main? ask this FIRST
./deploy/farm-online.sh       # start both machines
./deploy/farm-check.sh        # wait for devices, report what is live
./deploy/verify-console.sh    # 64 checks against the deployed console, from anywhere
./deploy/verify-hub-contract.mjs   # the automation contract, on real devices
```

An hour spent verifying against a farm running something other than `main` is an hour spent
measuring nothing, which is why the first line is first.

---

## 8. How this project finds bugs, and why that matters to a reader

**Forty-eight defects are recorded. Almost none were found by the test suite.** They were found by
using the product. The suite is over sixteen hundred tests and it catches different things — it caught two security
regressions this month — but the pattern is consistent enough to be worth stating plainly to anybody
evaluating this code:

- On 2026-09-11 a feature shipped with twenty passing tests and the screen it was on rendered **blank**,
  because a style was passed as a string. A guard for exactly that existed in the test shim and could
  not fire, because the seeded state never reached the branch.
- The same feature then drew fourteen fully transparent bars, because `var(--accent)` is not a token
  in this design system and **CSS drops an undefined variable silently**. Every check said it was
  fine; only asking the browser for a computed style found it.
- A filter chip lit up over a list that ignored it, because a button rebuilt between a mousedown and
  a mouseup never receives the click. Nothing in the suite can see that.

**So: if you are evaluating this system, open it and press things.** The documents in this repo are
written by somebody who keeps being wrong about them, which is why this one names its evidence.

---

## 9. Where to start reading

1. `docs/STATUS.md` — where every part stands, with its honest caveat.
2. `docs/adrs/` — 36 decisions (numbered to 0037; there is no 0013). Each says what was rejected
   and why, which is usually the useful half.
3. `apps/api/src/allocator.ts` — the reconciliation loop the whole product turns on.
4. `apps/api/src/http/webdriver/capabilities.ts` — the contract a customer's suite meets.
5. `examples/python-pytest/` — the smallest complete example of using the farm.
6. `docs/DEFECTS.md` — read the *causes*, not the list. Several are recorded as having been diagnosed
   wrongly first, and that record is the most useful thing in the repo.
