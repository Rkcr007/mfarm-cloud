# LambdaTest App Automation — agent context

How this repo puts sessions on LambdaTest, how the **App Automation** dashboard is organized, and how to read a run without guessing.

Last explored: 2026-09-08.

**UI note:** [appautomation.lambdatest.com/build](https://appautomation.lambdatest.com/build?pageType=build) redirected this session to Google OAuth (`accounts.lambdatest.com` → Google). Hub credentials in `config.properties` (`lt.username` / `lt.accessKey`) are **not** the dashboard password. The workflow below is reconstructed from (1) this org’s live Mobile Automation API, (2) `CreateMobileDriver` / `TestHooks`, (3) URLs already used in `docs/work-tracker.md`, and (4) LambdaTest App Automation docs. Do not paste access keys into this file or into chat.

---

## Two different LambdaTest products

Do not mix them.

| Product | Host | Protocol | This repo |
|---|---|---|---|
| **App Automation** (what we run) | [appautomation.lambdatest.com](https://appautomation.lambdatest.com/build?pageType=build) | Appium on **real devices** via `mobile-hub.lambdatest.com/wd/hub` | Primary. Android first. |
| **Browser / Web Automation** | `automation.lambdatest.com` (Selenium grid, not the app URL) | Selenium / Playwright on desktop browsers | Stub only: `CreateWebDriver.getCapabilities("lambdatest")` sets Chrome + Windows 11 + `LT:Options`. Not the mobile suite. |
| **Real Time App Testing** | Live/manual device | Human in the loop | Not used by CI. |

The URL the user opened — `https://appautomation.lambdatest.com/build?pageType=build` — is the **App Automation Build view**. That is the landing page after a Maven/CI run.

---

## How a test becomes a row on that page

```
Maven/TestNG suite XML
        │  parameter platform=mobile_lt_android  (thread-count=2)
        ▼
TestHooks.@BeforeAll
        │  xmlPath = {suiteFileWithoutXml}_{dd_MM_yyyy_HH_mm_ss}
        │  example: Android_UAE_Expenses_08_09_2026_06_53_38
        ▼
TestHooks.@Before (each Cucumber scenario)
        │  getLambdaTestCaps("android")
        │  lt:options.name = scenario.getName()
        │  createLambdaTestDriver → POST createSession to mobile-hub
        ▼
LambdaTest allocates a real Pixel (regex Pixel.* × OS 13|14|15)
        │  installs lt.app (lt://APP…)
        │  Appium UiAutomator2 session starts
        ▼
Dashboard: one BUILD (xmlPath) containing one TEST per scenario
        │  test_id like RMAA-AND-{orgId}-{id}
        │  session_id = Appium session UUID
        ▼
TestHooks.@After
        │  executeScript("lambda-status=" + passed|failed)
        │  driver.quit()
        ▼
Build status_ind rolls up: running | passed | failed
```

### Capabilities this org actually sends

From `CreateMobileDriver.getLambdaTestCaps`:

- `platformName=Android`, `isRealMobile=true`, `automationName=UiAutomator2`
- `deviceName` / `platformVersion` from `lt.devices` / `lt.os_versions` (regex, round-robin per thread)
- `app` = `lt.app` in `config.properties` (uploaded APK id, not a file in git)
- `lt:options`: `project=AlaanPay`, `build=xmlPath`, `name=scenario name`, `video/visual/console=true`, `idleTimeout=600`
- Hub: `https://{lt.username}:{lt.accessKey}@mobile-hub.lambdatest.com/wd/hub`

Session create is bounded: **3 attempts × 120s**, with backoff on fast failures. Healthy allocations in this repo historically land in **30–70s**.

Status on the dashboard is **not** inferred from Appium exceptions alone. Teardown sends `lambda-status=passed|failed` (failed also if healing debt blocks). If quit happens before that hook, LT may still show a generic `remark=completed`.

### What you will see as names

| Dashboard field | Source |
|---|---|
| Project | `AlaanPay` |
| Build name | TestNG XML basename + timestamp |
| Test name | Cucumber scenario name (overwrites the default `Thread-N`) |
| Device / OS | Whatever LT matched: live examples Pixel 7/8/9 / 9 Pro XL on 13, 14, 15 |
| User | `rakeshbarik` (org `2467030`) |

Live org snapshot 2026-09-08: **496 builds**, **6185 sessions**.

---

## Dashboard workflow (Build → Test → artifacts)

This is the click path the App Automation SPA implements. Query params are enough to deep-link.

### 1. Build list — `pageType=build`

URL: `https://appautomation.lambdatest.com/build?pageType=build`

This is a **grouped** view: one card/row per `build_id`, not per scenario.

Each build shows:

- Name (`xmlPath`)
- Status (`running` / `passed` / `failed`)
- Project (`AlaanPay`)
- Duration and timestamps
- Username who opened the sessions

Recent live examples (same afternoon):

| build_id | name | status |
|---|---|---|
| 26916719 | `Android_UAE_laneA_08_09_2026_16_46_33` | running |
| 26916717 | `Android_UAE_laneB_08_09_2026_16_46_33` | running |
| 26914135 | `testng_debugMobile_08_09_2026_15_54_38` | failed |
| 26903779 | `Android_UAE_Expenses_08_09_2026_06_53_38` | failed (119 tests, ~3.2h) |

Click a build → Test view for that build.

### 2. Test view — all sessions in one build

URL: `https://appautomation.lambdatest.com/test?build={build_id}`

Example: [Expenses build 26903779](https://appautomation.lambdatest.com/test?build=26903779)

Left/list: every scenario that opened a session. Filters: status, device, OS, search by name.

Each row is **one Appium session = one Cucumber scenario** in this framework (we do not reuse a session across scenarios; `@Before` always creates, `@After` always quits).

Live rows from 26903779 (API, newest first):

- failed — *Verify the Expense Status of New Comment Notification in Unread Notification Page* — Pixel 7, 104s — test_id `RMAA-AND-2467030-1788861686352371394AKJ`
- passed — *… Read Notification Page* — Pixel 8, 144s
- failed / passed pairs for Expense Rejected notifications
- passed — *search and view pending expenses* — Pixel 9, 138s

### 3. Session detail — video + logs

URL shape already used in the tracker:

```
https://appautomation.lambdatest.com/test?build={build_id}&testID={test_id}&selectedTab=home
```

Example: [New Comment Unread](https://appautomation.lambdatest.com/test?build=26903779&testID=RMAA-AND-2467030-1788861686352371394AKJ&selectedTab=home)

`selectedTab` switches the right-hand pane. Treat `home` as the summary. Other artifacts exist as API endpoints even when the tab name differs slightly in the SPA:

| Artifact | Why it exists for this repo | API (Basic auth, same hub user) |
|---|---|---|
| **Video** | `lt:options.video=true` | `data.video_url` on the session |
| **Screenshots zip** | `visual=true` | `data.screenshot_url` |
| **Command logs** | Every Appium/WebDriver call | `/sessions/{session_id}/log/command` |
| **Appium server logs** | Grid-side Appium | `/sessions/{session_id}/log/appium` |
| **Device logs** | logcat | `/sessions/{session_id}/log/devicelog` |
| **Console** | `console=true` | `/sessions/{session_id}/log/console` |
| **Network** | if captured | `/sessions/{session_id}/log/network` |
| **Crash** | native crash | `/sessions/{session_id}/log/crashlog` |

IDs to keep straight:

- **`build_id`** — integer, URL `?build=`
- **`test_id`** — `RMAA-AND-{org}-{suffix}`, URL `?testID=`
- **`session_id`** — UUID logged by `TestHooks` as `Driver CREATED | SessionId: …`. This is what Appium and Allure dumps belong to. The dashboard test page maps `test_id` → `session_id`.

Share link: builds also have `public_url` (`https://appautomation.lambdatest.com/share/…`).

### 4. How to debug a failed scenario from the dashboard (order)

1. Open the **build** named after the suite XML + timestamp (not “latest” — two lanes can run the same day).
2. Filter **failed**.
3. Open the scenario. Watch **video** first for product vs locator (blank list, OTP, picker, toast already gone).
4. Skim **command logs** around the last `findElement` / `click` / `setValue`. Idle timeout shows as a session that dies with no further commands.
5. If the video shows the wrong screen, pull **Allure page source** from the local/CI report — that dump is the locator source of truth in this repo, not LT’s screenshot zip.
6. Do **not** treat `remark=completed` as “passed”. Status is `status_ind`. A 9s `failed` + `completed` (seen on lane A 2026-09-08) is a session that opened and died immediately, not a 25-minute flow.

Official dashboard tour (Browser Automation sibling; App Automation uses the same Build/Test/detail idea): [Explore the Automation Dashboard](https://www.testmuai.com/support/docs/inside-testmu-platform/). Appium-specific hooks that *would* label command logs (`lambda-testCase-start/end`) are documented [here](https://www.lambdatest.com/support/docs/appium-testmu-hooks/). This repo currently only sends `lambda-status=`.

---

## Local vs CI — same dashboard, different starter

| Path | How | Concurrency |
|---|---|---|
| Local | `./mvnw test -Dsuite=… -Dallure.open=false` with suite XML `platform=mobile_lt_android` | Cap **2** Appium sessions (`thread-count="2"`). Do not raise. |
| CI | `.github/workflows/_run-suite.yml` on `runs-on: [self-hosted, Linux, X64, qa]` | `concurrency-group: lambdatest-sessions`, `cancel-in-progress: false`. One device job repo-wide. |

Creds always from `src/test/resources/environmentvariables/config.properties`. CI masks username/key in logs; it does not inject GitHub Secrets.

App binary: `lt://APP…` already uploaded to LT. Git does not ship the APK.

---

## REST API (use this when the SPA needs Google login)

Base: `https://mobile-api.lambdatest.com/mobile-automation/api/v1/`  
Auth: HTTP Basic `lt.username`:`lt.accessKey`.

| Call | Use |
|---|---|
| `GET /builds?limit=` | Build list (same as `pageType=build`) |
| `GET /builds/{build_id}` | One build + `public_url` |
| `GET /sessions?limit=` | Cross-build test stream |
| `GET /sessions?build_id=` | Tests inside a build |
| `GET /sessions/{session_id}` | Full artifact URLs |

`GET …/app-automation/api/v1/builds` on `api.lambdatest.com` returned **404** from this environment; use `mobile-api` only.

---

## Browser automation (out of scope for Android healing)

If someone opens **Automation** (web) instead of **App Automation**, they are on a different grid. This repo’s web LT caps are placeholders (`build=Build 1`, `name=My Test Session`). Mobile healing, dumps, and locator loop stay on **appautomation.lambdatest.com**.

---

## Mapping for agents

When the user pastes an LT URL:

- `…/build?pageType=build` → list builds; pick the suite XML + timestamp.
- `…/test?build=N` → all scenarios in that Maven invocation.
- `…/test?build=N&testID=RMAA-AND-…` → one scenario; fetch video + command logs; correlate `session_id` with Allure.

When a scenario “failed on LT”:

1. Confirm the **build name** matches the suite you ran.
2. Confirm **device family** is Pixel (regex). Mixed form factors are avoided on purpose.
3. Classify from video + dump: locator vs seed-not-surfaced vs OTP vs idle vs session-create stall. Do not xpath a seed/data failure.
