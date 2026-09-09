# LambdaTest **Automation** — clone specification

Scope: the **Automation** product only (Web Automation + App Automation), as observed logged-in on 2026-09-08 with org `2467030`, user `rakeshbarik`. Real Time, Real Device, KaneAI, Test Manager, Smart UI, HyperExecute, Accessibility, Web Scanner and Settings are siblings in the navbar and are **out of scope**.

Exploration was stopped deliberately after the Automation surfaces below; anything not listed here was not opened.

> Secrets: the live UI prints the hub URL with username **and access key in plaintext** (Connection Details, and the "Retrieve Logs via API" snippet on the Logs tab). A clone should mask by default with a reveal/copy action. Do not copy real keys into this repo.

---

## 1. Product shell

Three levels of navigation, all persistent:

1. **Left product rail** — Home, KaneAI, Kane CLI, Test Manager, Agent Testing, Real Time, Real Device, **Automation**, Smart UI, HyperExecute, Insights, Accessibility, Web Scanner, More Tools, Settings. Footer of the rail: Help, Credentials, Quick Actions.
2. **Automation submenu** (opens on clicking Automation) — exactly two children:
   - **Web Automation** → `automation.lambdatest.com`
   - **App Automation** → `appautomation.lambdatest.com`
   Selecting one swaps the whole host; the rail stays.
3. **Top header**, per product:

| Header item | Web Automation | App Automation |
|---|---|---|
| Parallels Available | `2 2 2 0` chips | single counter (`0` while both sessions busy) |
| Configure Tunnel | yes | yes |
| Go to Analytics | yes | — |
| Connection Details | yes (hub URL / username / access key) | — |
| Upload App | — | yes |
| Notifications, Profile avatar | yes | yes |

**Parallels popover** (App Automation): `Usage Breakdown` → `Real Mobile App Automation` `2/2`, Running `2`, Available `0`, Queued `0/150`. That is the plan ceiling this repo's 2-session rule comes from.

**Configure Tunnel** dialog: `Local Connection`, tabs `Command Line` / `Desktop App`, a ready-to-run `./LT --user <email> --key <key>` command, `Tunnel Config` / `Internal Website` / `Folder` options, binary download link, four-step instructions.

**Upload App** dialog (App Automation): tabs `App` / `Files and Media`; inside App: `Real Device` / `Virtual Device`; `Browse File` for `.apk` / `.aab` / `.ipa`; returns `{"app_url":"lt://<app_url>"}` with a copy button and the `setCapability("app", "lt://<app_url>")` hint.

---

## 2. Core domain model

Everything in Automation is three nested entities:

```
Project (AlaanPay)
  └── Build            build_id 26903779, name Android_UAE_Expenses_08_09_2026_06_53_38
        └── Test        test_id RMAA-AND-2467030-…AKJ  ==  one Appium session
              └── Commands, Logs, Network, Metadata, Media, Video
```

| Field | Where it comes from | Example |
|---|---|---|
| `build_id` | server, integer | `26903779` |
| build `name` | client capability `build` | `Android_UAE_Expenses_08_09_2026_06_53_38` |
| `test_id` | server, prefixed | `RMAA-AND-{orgId}-{ts}{3 letters}` (app) / `RMA-AND-…` (web) |
| test `name` | capability `name` | Cucumber scenario name |
| `session_id` | Appium | `b85c4002-d6b1-43aa-bfbc-955397f182d6` |
| framework | detected | `appium` / `Selenium` badge per row |

Status vocabulary: `running`, `passed`, `failed`, `completed`. A build's status is the rollup of its tests. `remark: completed` is **not** a pass — a 9s `failed`/`completed` row exists in the live data.

Build/test counters observed: 496 builds, 6185 tests for this org.

---

## 3. Screen: Build list

URL: `/build?pageType=build` (both products).

- Rows grouped under **relative day headers**: `today`, `yesterday`, and for web `30th July 2026`.
- Each row: build name (links to `/test?build=<id>&testID=<first test id>`), **test count**, **duration** (`3h 9m 50s`), status pill, relative time (`2hr ago`), owner, framework icon, and a **Build Status Summary** progress bar with the total as a clickable number.
- Row overflow menu: **Delete**, **Share**.
- Search box: App Automation `Search Build Name/ID...`; Web Automation splits it into a **Build Name | Build Id** selector plus the input.
- View switcher (`Builds` ⇄ `Tests`) is a radio menu on the list title; it rewrites `pageType`.
- **Configure** menu = Filters + Actions:

| | App Automation | Web Automation |
|---|---|---|
| Filters | Date, Frameworks, Status, Users, Project, Build Tags, Test Tags, Features | Build Tags, Date, Project, Status, Test Tags, Type, Users |
| Sort | — | Sort By (Date) |
| Actions | Delete Build | Delete Builds… |

---

## 4. Screen: Test list

URL: `/build?pageType=test`.

Same shell, flattened to one row per session: test name (deep link), parent build name as a chip, duration, status pill + relative time, owner, framework icon, overflow menu. Search placeholder `Search Test Name...` (web: `Test Name | Test ID` selector).

Filters drop the build-only ones: **Date, Status, Users, Project, Builds, Test Tags, Features**.

---

## 5. Screen: Test/session detail

URL: `/test?build=<build_id>&testID=<test_id>&selectedTab=<tab>`. Three panes.

### 5.1 Left rail — sibling tests
`Tests` header, search, and **status count chips** (live example `(72)` failed / `(47)` passed). Each row: name + duration, links to its own `testID`. Collapsible via `close-sidebar` / `expand button`.

### 5.2 Top summary
Breadcrumb `Builds › <build name>`, status icon + `failed`, test name. Then:
- **Time Taken** (`2m 7s`)
- **Configuration** chips: App Automation shows `Physical`, `Pixel 7`, `13`, framework icon, `OFF`; Web Automation shows device/browser, OS, `1080 x 2340 px`, build type, `OFF`.
- `Updated 2hr ago` + owner.
- Actions: **View Test History**, **Fullscreen**, **Create an issue**, **Test ID** (copy), and an overflow with **Rename Test…**, **Share Test…**, **Delete…**.

### 5.3 Artifact tabs

| Tab | `selectedTab` | Behaviour |
|---|---|---|
| All Commands | `home` | Search Commands, `View: All`, header `4 Commands` / `4 Passed` / `0 Exception`; web rows expose per-command screenshot buttons (`New Session`, `Get Page Source`, `Execute JavaScript`, `Delete Session`…) |
| Logs | `logs` | Sub-tabs **Appium / Device / Crash / Terminal** (web: **Appium / Console / Terminal**, `selectedTabSubType=selenium`). Panel shows `Retrieve Logs via API` with a copyable authenticated URL, then `Raw Appium Logs` with its own search and `N matches` |
| Network | `network` | Empty state: *Network Logs are not enabled for this test* + `{ capability = network : true }` |
| Meta Data | `meta-data` | Sub-tabs below |
| App Profiling | `app-profiling` | Empty state + `{ capability = appProfiling : true }` |
| Accessibility | `accessibility` | Empty state + `'capabilities': { accessibility: true }` + **See Documentation** |
| Smart UI | web only | visual comparison |

`App Profiling` and `Accessibility` live behind a **More** overflow when the tab strip is narrow.

**Meta Data** sub-tabs:
- *Basic Info* — Session ID, Automation Name (`UiAutomator2`), Create/Start/End Time, Tunnel Name, Tunnel ID.
- *App Info* — App Main Activity, App Bundle ID, App URL (`lt://APP…`), App Version, App Version Code.
- *Input Config* — `Show JSON` toggle over Capabilities `{...}`, CustomData `{}`, DesiredCapabilities `{...}`, IdleTimeout `600`, QueueTimeout `600`.
- *Media* — `N Files`, `Download All`, per-file entries (`2026-09-08_10-03-31-921673807.png`).

### 5.4 Video player
Docked bottom-right, always present: play/pause, elapsed `0:00`, scrubber, total `1:47`, playback-speed menu, **Download Video**, **Rotate Left**, **Fullscreen**. Shows `Loading Video…` until the artifact resolves.

---

## 6. Analytics (reachable from Automation header)

`Go to Analytics` → `analytics.lambdatest.com`, product **Insights**, whose own submenu is Dashboards, Build Insights, Test Insights, App Profiling, Usage, Project, Private Real Devices, Private Desktop, Sub Organizations, Cypress Insights. Landing screen: dashboard list table (`2 Dashboards`, name / last updated / actions), name filter, **Create New** menu, pagination. Treat as a separate app that the Automation clone links out to.

---

## 7. Backing API (what a clone would implement)

Base `https://mobile-api.lambdatest.com/mobile-automation/api/v1/`, HTTP Basic with username + access key.

| Endpoint | Serves |
|---|---|
| `GET /builds?limit=&offset=` | Build list; `Meta.result_set.total` drives pagination |
| `GET /builds/{build_id}` | Build detail incl. `public_url` share link |
| `GET /sessions?build_id=&limit=` | Test list for a build |
| `GET /sessions?limit=` | Cross-build test stream |
| `GET /sessions/{session_id}` | Detail + artifact URLs |
| `GET /sessions/{session_id}/log/{appium\|devicelog\|crashlog\|console\|network\|command}` | Log panes |
| `video_url` / `screenshot_url` | Time-signed CDN links (`?verify=…`) |

`api.lambdatest.com/app-automation/api/v1/builds` is **404**; only `mobile-api` works for app automation.

Filter/status query params are not all public — `?status=failed` on `/sessions` returned an empty set while the UI filtered fine, so a clone should filter server-side on its own schema rather than mirror that param.

---

## 8. Build-order recommendation for the clone

1. **Ingest**: a hub endpoint that accepts `build` / `name` / `project` capabilities and opens a session row. Status is written by the client (`lambda-status=passed|failed`), not inferred.
2. **Two list screens** sharing one component: group-by-day, row summary, status pill, progress rollup, day headers, search, filter menu, view switcher, row overflow (Delete/Share).
3. **Detail screen**: three panes, tab router keyed on `selectedTab`, sibling list with status chips, video dock.
4. **Artifact tabs** with real empty states — each disabled capability must name the exact flag that enables it (`network`, `appProfiling`, `accessibility`). This is the highest-value copy in the product.
5. **Header services**: parallels/usage popover, tunnel setup, app upload returning `lt://` ids, connection details.
6. **Retention + signing** for video/screenshots (observed `60d` in the artifact path, `retentionDays: 60` in the signed payload).

Deliberately skipped in this pass: Insights internals, Real Device, KaneAI, Smart UI comparisons, Settings, and all destructive actions (Delete/Rename/Re-run were opened but never executed).
