# CI, LambdaTest execution, and what MFARM must become

A development brief for the MFARM console. It is grounded in **this repo’s real pipeline** (`qa-mobile-automation`), the live LambdaTest App Automation product (org `2467030`, observed 2026-09-08), and the authenticated MFARM review (org Lab, 2026-09-09).

Do not treat LambdaTest as a screen-for-screen clone target. Treat it as the **user job** a device farm must complete: *a CI job asks for devices, the farm allocates them fairly, the suite runs, and a human can diagnose a failure without leaving the console.*

---

## 1. The two planes you must keep separate

LambdaTest looks like one product. Operationally it is two systems that meet at the Appium hub.

| Plane | Who owns it | What it does | This repo |
|---|---|---|---|
| **Orchestration** | GitHub Actions + Maven/TestNG/Cucumber on a **self-hosted runner** | Decides *which* tests to run, *when*, with *which tags*, and *how many threads*. Collects Allure, Slack, healing. | `.github/workflows/_run-suite.yml` |
| **Device farm** | LambdaTest `mobile-hub.lambdatest.com/wd/hub` | Authenticates the client, **queues** if parallels are full, **allocates** a real device, installs the app, hosts Appium, records video/logs, accepts `lambda-status`. | `CreateMobileDriver` + `TestHooks` |

MFARM already owns the second plane (allocator, leases, quarantine, APK library, hub URL). It does **not** need to become GitHub Actions. It **does** need to be a first-class citizen of the first plane: a runner must be able to start sessions, bind them to a CI run, and a QA user must be able to debug from the farm console.

If you mix the planes, you will over-build “CI inside MFARM” and under-build the hub contract that Appium actually speaks.

```
Human / schedule
        │  workflow_dispatch  (cron is parked until a measured pass)
        ▼
GitHub Actions  (self-hosted Linux X64 qa)
        │  concurrency-group: lambdatest-sessions
        │  cancel-in-progress: false
        ▼
./mvnw test -Dsuite=Android_UAE_Expenses.xml -Dallure.open=false
        │  TestNG parallel="tests" thread-count="2"
        │  platform=mobile_lt_android
        ▼
TestHooks @Before  (one Cucumber scenario)
        │  POST createSession  →  mobile-hub
        ▼
LambdaTest
        │  auth → queue → allocate Pixel.* / 13|14|15
        │  install lt://APP…  →  Appium UiAutomator2
        ▼
Scenario steps (findElement / click / sendKeys)
        │  artifacts written live (video, commands, logcat)
        ▼
TestHooks @After
        │  executeScript("lambda-status=passed|failed")
        │  driver.quit()
        ▼
CI continues: Allure generate → Pages (best-effort) → Slack → heal-analyze
```

**Implication for MFARM:** the product surface users care about during a run is almost entirely on the farm side of that arrow. GitHub already tells them pass/fail counts. They open the farm console because GitHub cannot show the phone.

---

## 2. How tests are invoked in this repo (the real contract)

### 2.1 Trigger

Domain workflows (`mobile-uae-expenses.yml`, cards, auth-profile, teamleader, alaandrop) are **dispatch-only**. Scheduling is parked until a measured Android pass exists. A human (or another workflow) starts:

- **Which suite XML** (fixed per workflow)
- **Optional Cucumber tags** (`@laneA and @batchA1`)
- **Timeout** (expenses: 210 minutes)

There is also `lt-preflight.yml`: one short session to prove hub + credentials before burning a 3-hour job.

### 2.2 Runner

`runs-on: [self-hosted, Linux, X64, qa]`. The JVM and Maven wrapper live on **the customer’s machine**, not on LambdaTest. LambdaTest never clones this git repo. That is the correct split for MFARM too: **do not execute the suite inside the farm**. Execute Appium commands against devices the farm leases.

### 2.3 Suite shape

`Android_UAE_Expenses.xml` is the canonical example:

- `parallel="tests"` `thread-count="2"` because the **LambdaTest plan allows 2 concurrent sessions**
- Two TestNG `<test>` blocks (Lane A / Lane B) with **disjoint accounts**, so two phones never log into the same user
- Parameter `platform=mobile_lt_android` is what `TestHooks` uses to pick the LT hub instead of local Appium

Each Cucumber **scenario** is one Appium **session**. `@Before` always creates; `@After` always quits. Sessions are not reused. That is the unit of billing, video, and debugging.

### 2.4 Naming that the farm must ingest

| Capability / field | Source in this repo | What the console user searches for |
|---|---|---|
| `lt:options.project` | hardcoded `AlaanPay` | product / team |
| `lt:options.build` | `TestHooks.xmlPath` = `{suiteFile}_{dd_MM_yyyy_HH_mm_ss}` | “the expenses run from this morning” |
| `lt:options.name` | overwritten with `scenario.getName()` | the failing scenario title |
| `app` | `lt.app` = `lt://APP…` already uploaded | which binary |
| `deviceName` / `platformVersion` | regex `Pixel.*` × `13\|14\|15` | which phone actually landed |

MFARM already has `mfarm:runId` (join CI job to a run) and `mfarm:bindSessionId`. That is the right idea. What is missing is treating **build + test name** as first-class list rows the way LambdaTest does.

### 2.5 What CI still does after the farm is done

These stay on GitHub. MFARM should **link** to them, not duplicate them:

- Allure HTML (page-source dumps are the locator source of truth in this repo)
- Artifact zip (`allure-results/`, `target/framework-run.log`, `target/healing/`)
- Sign-off JSON + Slack
- Optional heal-analyze PR

**Product rule:** farm console = device truth + session evidence. CI console = suite verdict + code artifacts. A deep link both ways is enough.

---

## 3. What is required to execute on LambdaTest

A working Appium-on-cloud path needs all of these. MFARM must expose an equivalent of each.

### 3.1 Identity and hub

- Username + access key (HTTP Basic on the hub URL)
- Hub: `https://{user}:{key}@mobile-hub.lambdatest.com/wd/hub`
- Same pair also authenticates `mobile-api.lambdatest.com` for builds/sessions/logs

MFARM today: Settings shows hub URL `https://farm.mfarm.dev/wd/hub` and an API-key auth rule. Good. Missing: copy-ready capability snippets, named/scoped keys, last-used, expiry.

### 3.2 App binary

- APK/AAB/IPA uploaded once; hub receives an opaque id (`lt://APP…`)
- Git never contains the APK (this repo’s CI explicitly refuses `lfs: true` for that reason)

MFARM today: checksum-keyed APK library, session-only install. Missing: IPA/AAB, URL upload, version grouping, install history on the session.

### 3.3 Device matching

- Client sends regex or exact device + OS
- Farm returns one concrete device (`Pixel 7` / Android 13) or queues / fails

MFARM today: **device classes** (geometry, density, physical/virtual, reset strategy) — actually richer than LambdaTest’s marketing list. Missing: a reliable READY pool (observed 0/5) and a matcher that reports *why* a class cannot be allocated.

### 3.4 Plan / parallels

Observed App Automation popover: **Real Mobile App Automation 2/2**, Running 2, Available 0, **Queued 0/150**. Queue timeout in metadata: `QueueTimeout 600` (seconds). Idle timeout this repo sets: `idleTimeout 600`.

Two ceilings matter:

1. **Concurrent running sessions** (plan / fleet size)
2. **Queued createSession requests** (backlog cap)

This repo also imposes a **third** ceiling in GitHub: `concurrency-group: lambdatest-sessions` with `cancel-in-progress: false`, so only one Maven job in the org holds the two sessions. That is a customer-side policy because the LambdaTest queue is expensive and opaque. If MFARM shows **queue position, wait estimate, and who holds the devices**, customers can drop that GitHub serialisation.

### 3.5 Session create resilience (client-side)

`CreateMobileDriver.createLambdaTestDriver`:

- 3 attempts
- 120s read timeout per attempt (healthy allocate is 30–70s)
- Backoff 5s then 10s on **fast** failures only (so a refused connection is not retried in 3ms)

MFARM should treat a hung `createSession` as a first-class incident: request id, queue wait, allocate wait, install wait, Appium ready. Today a QA user on LambdaTest only sees “running” until a device appears; the Java client is doing the real waiting.

### 3.6 Result reporting

Dashboard status is **not** inferred from Appium exceptions. Teardown sends:

```
executeScript("lambda-status=" + passed|failed)
```

If `quit()` happens first, LambdaTest may show `remark=completed` which is **not** a pass.

MFARM must document and implement an equivalent (capability, JS hook, or REST) and never roll up a run as passed from “session ended”.

---

## 4. How security is actually managed (and where it is weak)

### 4.1 LambdaTest

| Control | Behaviour | Risk |
|---|---|---|
| Hub auth | Username + access key in URL and `lt:options` | Keys in process lists, exception dumps, Allure if caps are logged |
| Dashboard | Google OAuth for the SPA; hub key ≠ dashboard password | Two identities; confusing for operators |
| Connection Details / tunnel snippet | **Prints access key in plaintext** | Anyone with dashboard access sees the automation key |
| Artifact URLs | Time-signed CDN (`?verify=…`), ~60 day retention | Good pattern — copy this |
| API | HTTP Basic with the same hub key | One key = grid + REST + artifacts |
| Parallels | Plan-level cap | Cost control, not row-level ACL |

A clone **must mask keys by default** with reveal/copy. Do not copy LambdaTest’s plaintext Connection Details.

### 4.2 This repo (customer CI)

Locked decision: credentials live in `config.properties` (`lt.username`, `lt.accessKey`, `lt.app`). They are **committed**. CI does **not** inject GitHub Secrets.

Mitigations that exist:

- Workflow step **masks** username, full key, and every prefix ≥ 12 characters (Selenium truncates caps in exceptions; run `32847871062` leaked 27 characters before this)
- Masking runs **before** JDK/Maven so preflight cannot print the hub URL first
- App binary is a remote id, not a git blob
- Self-hosted runner: secrets never sit on GitHub-hosted VMs
- Slack / LLM / Linear are optional; a missing webhook does not fail the suite

Known debt (P2 in the tracker): overlay `LT_USERNAME` / `LT_ACCESS_KEY` from GitHub Secrets onto `config.properties` at job start so keys leave the git history.

### 4.3 What MFARM should ship for CI-grade security

Observed MFARM issue: **New API key creates immediately** with no name, scope, expiry, or confirmation. An exploratory click minted a live org-wide credential (revoked in the same session).

Build this instead:

1. **Named keys** (e.g. `gha-qa-runner`, `rakesh-laptop`) with create dialog
2. **Scope**: hub-only vs console-admin vs artifact-read
3. **Expiry + last used + last IP / runner id**
4. **CI-specific keys** that cannot invite users or mint more keys
5. **One-time reveal** of the secret; store only a hash
6. **Audit log**: session create, key create/revoke, app upload, member change
7. **Signed artifact URLs**, never hub keys inside video links
8. **Do not echo keys** in capability JSON on the Meta tab (show `***` with reveal)
9. Org roles beyond member/admin/owner when more than one team shares the farm
10. Optional: bind a key to `mfarm:runId` namespace so a leaked CI key cannot start unbounded interactive sessions

Hub auth should stay **key-based** (Appium clients cannot do OAuth). Console auth can stay password/SSO. Never print the hub key next to the hub URL the way LambdaTest does.

---

## 5. Session lifecycle: queue, allocate, execute, reap

This is the state machine MFARM should make visible. LambdaTest mostly hides it behind “running”.

```
createSession received
        │
        ├─ auth fail → 401 (fast)
        ├─ unknown app id → fail
        ├─ no matching class → fail with reason
        ├─ matching devices exist but none READY
        │       └─ enqueue (Queued N / cap)
        │              ├─ queueTimeout → fail "queued too long"
        │              └─ device READY → dequeue
        ├─ lease device
        ├─ reset / snapshot restore (MFARM differentiator)
        ├─ install app (if requested)
        ├─ start Appium / UiAutomator2
        ├─ return sessionId to client     ← user now sees "running"
        │
        │  commands…  video encoder…  logcat tail
        │
        ├─ idleTimeout with no commands → reap (this repo hit this at 150s; now 600s)
        ├─ client lambda-status + quit
        ├─ client disconnect without quit → idle reap
        └─ device/host death → quarantine (MFARM already has this)
```

### 5.1 Two queues, not one

| Queue | Where | What the user sees today |
|---|---|---|
| **GitHub job queue** | `concurrency-group: lambdatest-sessions` | Actions UI: “pending”, waiting for the previous 3-hour expenses job |
| **Farm session queue** | LambdaTest createSession | Parallels popover Queued `n/150`; test row still looks idle/running |

QA leads currently serialise **jobs** because they cannot trust the farm queue. MFARM’s Waiting view is the right product — but on 2026-09-09 it contradicted Fleet (`all available` vs `0/5 ready`). That single inconsistency makes people keep GitHub serialisation forever.

**Fix:** one allocator read model. Every surface (header chip, Fleet, Waiting, session create error) must use the same states:

`ready` | `leased` | `resetting` | `installing` | `queued` | `quarantined` | `offline`

### 5.2 What happens while the test executes

From the client’s point of view: a blocking WebDriver command loop. From the user’s point of view, they need:

**Live (while red/green is still unknown)**

- Which device is leased (model, OS, physical/virtual, region)
- Queue wait vs allocate wait vs install wait vs test time (billing vs queue time)
- Live video or at least a recent screenshot
- Last N Appium commands (so a hang is visible: stuck on `findElement`)
- Idle countdown (so they know the farm will reap)
- Stop / quit session (kill a runaway)
- Device log tail (logcat)
- App identity (`lt://` / checksum)
- Link back to CI run / `mfarm:runId`

**Immediately on fail (the first 60 seconds of debugging)**

This is the job LambdaTest actually wins:

1. Open **build** named after the suite+timestamp (not “latest”)
2. Filter **failed**
3. Watch **video** (blank list vs OTP vs picker vs toast already gone)
4. Skim **command log** around last `findElement` / `click`
5. Optionally network / crash / profiling if enabled

This repo still pulls **Allure page source** for locators; LT video answers “what did the human see?”. MFARM currently offers a **flat evidence file list** and sessions that can show **0 WebDriver steps** even on a passing 8/8 run. That is why people will not leave LambdaTest.

### 5.3 After the session

- Status from client (`passed`/`failed`), not from “completed”
- Duration, device, app version, retry count
- Video, screenshots, command log, appium log, device log, crash
- Share link (LambdaTest `public_url`)
- Retention / expiry (MFARM already has per-artifact expiry — keep it)
- Host/agent identity for infra failures (MFARM Health said host heartbeat has **no console read endpoint** — that is an operator hole LambdaTest does not have because they operate the hosts)

---

## 6. Console information architecture (what to build)

Do not copy the LambdaTest left rail (KaneAI, Smart UI, …). Copy this hierarchy:

```
Project (optional later)
  └── Run / Build     ← mfarm:runId  or  capability build
        └── Test      ← capability name / Cucumber scenario
              └── Session (usually 1:1 with Test in this framework)
                    └── Timeline: commands + video + screenshots + logs
```

### 6.1 Header (always visible)

LambdaTest: parallels chips, tunnel, upload app, connection details.

MFARM should show:

| Widget | Why |
|---|---|
| `ready / total` **from allocator** | Can I start a session? |
| `running` | Who is burning device-minutes |
| `queued` + oldest wait | Do I dispatch another CI job? |
| `quarantined` | Is the farm sick? |
| Upload app | Same as today |
| Hub URL + **masked** key helper | Onboarding |
| Active run deep link if `mfarm:runId` is in flight | CI users |

### 6.2 Runs list (CI user’s home)

LambdaTest Build list: day headers, name, test count, duration, status rollup bar, owner, search, filters (date, status, user, project, tags), share/delete.

MFARM Runs today: a small table, aggregate pass/fail, **no search, filters, pagination, branch, commit, owner, share**. Fine for a lab; dead on daily CI.

Minimum columns: run id, status, passed/failed/skipped **test counts**, duration, device class, app, user/key name, git SHA (capability), started at.

### 6.3 Test list inside a run

One row per scenario. Status chips. This is the **largest functional gap**. Without it the farm cannot replace Allure+LambdaTest for triage.

Ingest: test name, status, duration, error message, stack, retry, session id, device.

### 6.4 Session detail (three panes)

Borrow LambdaTest’s layout; it is the industry default because it works:

- Left: sibling tests in this run
- Centre: tabs — Commands, Logs (appium / device / crash), Network, Meta, Media
- Dock: video with scrubber, speed, download

Empty states must name the capability that would have filled the tab (`network: true`). That copy is how users learn the product.

### 6.5 Live / Waiting / Fleet

Keep MFARM’s differentiators. They are better than LambdaTest for operators:

- Device classes, reset strategy, leases, recovery
- Waiting as a real queue of **allocation requests**, not a decorative page
- Health with **host heartbeat, agent version, last error** (missing today)

Unify copy with the header.

---

## 7. Gap matrix: LambdaTest user job → MFARM today

| User job | LambdaTest | MFARM (9 Sep 2026) | Priority |
|---|---|---|---|
| Start a CI suite against the hub | Documented caps + `lt://` app | Hub URL exists; no capability builder / `mfarm:runId` examples | P1 |
| See whether a session can start | Parallels 2/2, queued n/150 | Header 0/5 ready; Waiting says available | **P0** |
| Wait fairly when busy | Server-side queue + queueTimeout | Waiting/leases exist; state inconsistent | **P0** |
| Know which scenario is on which phone | Test list under build | Run aggregates; sessions with 0 steps | **P0** |
| Watch a live / recorded phone | Video player on every test | Evidence files only | P1 |
| Find the failing command | Command log + screenshots | Not in console | **P0**/P1 |
| Mark pass/fail | `lambda-status` | Suite-owned counts; session status unclear | P1 |
| Debug infra vs test | Device + appium + crash logs | logcat as a file | P1 |
| Stop a runaway session | Session actions | Need explicit kill + idle display | P1 |
| Upload and pin an app | Upload dialog → `lt://` | APK checksum library | P1 (IPA/AAB later) |
| Tunnel to staging | Configure Tunnel | Not present | P1 |
| Trust credentials | Weak (plaintext key in UI) | Worse (instant unnamed key) | P1 |
| Operator: why is the farm dead? | Opaque (LT operates hosts) | Health admits no host read model; 5/5 quarantined | **P0** |
| Search last week’s failed build | Filters + search | No | P1 |
| Share a failure | `public_url` | No | P1 |
| Usage / cost | Insights / parallels | Landing page promises device-minutes; console has no meter | P2 |
| iOS / mobile browser | First-class | Android APK composer only | P1/P2 |

---

## 8. Recommended build order (so you do not clone the wrong thing)

### Slice 0 — Make the farm truthful (blocked on this or nothing else matters)

- Restore at least one READY device
- Host heartbeat + agent version + quarantine reason on Health **and** device row
- Single allocator projection for header, Fleet, Waiting, and `createSession` errors
- Alert when allocatable count is 0

### Slice 1 — Hub contract for CI (the Appium product)

Document and implement:

- Auth (named key)
- Capabilities: device class, app id, `mfarm:runId`, `name` (test), `build`, video/logging flags
- `createSession` phases in the session record: queued / allocating / resetting / installing / running
- Queue position + queueTimeout + idleTimeout surfaced
- Result hook (`mfarm-status` or REST) **before** quit
- Error bodies that a Java client can retry on (distinguish 401, unknown app, no capacity, queue full)

Ship a copy-paste snippet that would replace `CreateMobileDriver.getLambdaTestCaps` for this repo. If this repo cannot point `platform` at MFARM with two lines of config, the console UI will not save anyone.

### Slice 2 — Test-level debugging (the reason QA opens the console)

- Tests as rows under a run
- Command timeline ingested from the Appium proxy (even without video)
- Video player + timestamp alignment
- Failed filter, search, share link
- Deep link: ` /runs/{runId}?test={name}` for Slack/GitHub

### Slice 3 — Live operator + QA during a run

- Live screenshot/video
- Kill session
- Idle countdown
- Command hang detector (no command for N seconds)

### Slice 4 — Org and onboarding

- Scoped keys, audit, tunnel, iOS, usage

---

## 9. Mapping this repo onto MFARM (acceptance test for the product)

When Slice 1–2 work, a developer should be able to:

1. Create a CI key named `gha-qa` (shown once)
2. Upload the same APK the `lt.app` id represents (or install from library by checksum)
3. Set hub to `https://farm.mfarm.dev/wd/hub` with that key
4. Set `mfarm:runId=$GITHUB_RUN_ID` and `build=Android_UAE_Expenses_$timestamp` and `name=$scenario`
5. Run `./mvnw test -Dsuite=…` with `thread-count=2`
6. Open MFARM Runs, find that run, see **two live sessions**, then **N test rows**
7. Click a failure, watch video, jump to last command, copy share link into Slack

Until step 6 shows **test rows**, MFARM is a fleet controller, not an automation product.

---

## 10. What not to copy from LambdaTest

- Product-rail sprawl (KaneAI, Smart UI, HyperExecute, …)
- Plaintext access keys in Connection Details
- Inferring pass/fail from session end
- Hiding queue/allocate/install behind a single “running” pill
- Replacing Allure page-source dumps — keep CI reports for locator healing; link them

Keep MFARM’s own strengths: self-hosting, device classes, explicit reset, leases, worker-confirmed actions, checksum apps, artifact expiry.

---

## Sources

- This repo: `.github/workflows/_run-suite.yml`, `CreateMobileDriver.java`, `TestHooks.java`, `Android_UAE_Expenses.xml`, `docs/work-tracker.md`
- LambdaTest App Automation exploration: `docs/lambdatest-app-automation-context.md`, `docs/lambdatest-automation-clone-spec.md`
- MFARM authenticated review: `docs/mfarm-product-gap-review.md` (9 Sep 2026)
