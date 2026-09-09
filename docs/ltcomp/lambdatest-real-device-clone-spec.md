# LambdaTest **Real Device** — clone specification

Scope: the **Real Device** product only, observed logged-in on 2026-09-08 (org `2467030`, user `rakeshbarik`). This is **manual / exploratory live testing** on physical phones and tablets — not Appium Automation.

Home card copy: *Exploratory tests for native and web apps on real devices.*

Not opened (deliberate): **Start** was never clicked, so the in-session remote-control chrome (stream, rotate, screenshot, GPS, etc.) is not in this spec. Starting a session would consume a Real Mobile Live parallel. App Manager (`app-management.lambdatest.com`) is linked from this product but is a satellite and was not explored.

> Secrets: the Configure Tunnel dialog prints `./LT --user <email> --key <accessKey>` in plaintext. A clone should mask the key. Do not copy real keys into this repo.

---

## 1. Product shell

Same three-level nav as Automation:

1. **Left product rail** — Real Device is a sibling of Real Time, Automation, etc.
2. **Real Device submenu** — three children, all on host `applive.lambdatest.com`:

| Item | URL | Title |
|---|---|---|
| App Testing | `/app` | Real Devices - App Testing |
| Browser Testing | `/browser` | Real Devices - Browser Testing |
| Sessions | `/sessions` | — |

`/sessions` exists in the rail (`data-amplitude="sidebar: manual tests - real device"`) but **this org redirected `/sessions` back to `/app`**. Treat Sessions as a history/live list that may be gated; do not assume a working list page without a plan that enables it.

3. **Header** (both App and Browser Testing): **Parallels Available** (`2` `2` chips), **Configure Tunnel**, notifications, profile. No Upload App / Connection Details / Go to Analytics here — those belong to Automation.

**Parallels popover** (observed, not the Automation one):

| Pool | Quota | Running | Available | Notes |
|---|---|---|---|---|
| Real Mobile Live | `2/4` | `0` | `2` | `Consumed By Other 2` (Automation sessions eating the same device pool) |
| Real Mobile Live Plus | `0/2` | `0` | `2` | unused on this org |

Clone: one concurrency service with named pools; Automation vs Live must show **Consumed By Other** when they share devices.

**Configure Tunnel** is the same Local Connection dialog as Automation (Command Line / Desktop App, Internal Website / Folder). **Tunnel: Inactive** sits next to **Start** and is disabled until a tunnel is up.

---

## 2. Domain model

```
Cloud (Public | Private)
  └── OS (Android | iOS)
        └── Brand  (Samsung, Google, … / iPhone, iPad)
              └── Device + OS version  (Galaxy S26 Ultra / 16)
                    └── Payload
                          App Testing: selected App (lt://APP…) or Play Store / Firebase
                          Browser Testing: URL + browser
                    └── Session  (created only on Start — not observed)
```

App inventory is shared with Automation: the selected Android APK used `app-card-APP10160322311785827187547490`, the same `lt://APP…` id this repo already stores in `lt.app`.

Row fields on an uploaded app: filename, version (`v99.99.99`), truncated bundle id (`com.ala[...]staging`), relative time, uploader (`by rakesh`), overflow **setting**.

---

## 3. Screen: App Testing (`/app`)

Layout is a **launch composer**, not a build list.

### 3.1 Launch bar (top of main)

- Heading: `Test on blazing fast Real Devices`
- Status: `You are launching <app> on <device> <os-icon> <version>`
- Actions: `Tunnel: Inactive` (disabled) · **Start** (`data-testid=start-session-btn`)

Clone: Start is enabled only when OS + device + payload are selected. Do not auto-start.

### 3.2 OS + cloud + settings strip

- Android / iOS tabs (`os-tab-androidDeviceTab` / `os-tab-iosDeviceTab`). Switching OS **swaps the app list** (APK/AAB vs IPA) and the default device.
- **Advanced Settings** (`device-advanced-settings-config-button`) overlay:
  - Tab: **Device Control**
  - Toggle: **SIM Enabled** (`enableSim__toggle`, default Off, shortcut `s`)
  - On this org that was the **only** advanced control. Do not invent GPS/locale toggles unless a higher plan exposes them.
- **Public / Private** (`PUBLIC_CLOUD` / `PRIVATE_CLOUD`):
  - Public: brand column + device list (search `public-devices`).
  - Private empty state: *Skip the queue. Get any real device reserved exclusively for your organization, with complete custom controls.* + **Submit Request**. Also shows **Select Pre-Installed App in Session**.

### 3.3 Left: app payload

Three accordions:

1. **Uploaded Apps** (open by default)
   - Search, **filter apps**, **URL**, **Upload** (hidden `upload-app-file-input`)
   - List of org apps + a **Sample App.apk** demo row
   - Footer link **App Manager** → `https://app-management.lambdatest.com/app-management`
   - **Upload via URL** dialog: title `Upload via URL`, placeholder `Paste your URL here`, checkbox **Share my newly uploaded files with Team**, Cancel / Upload
   - Per-app **setting** dialog (not executed Delete):
     - Visibility: **Apps: All Apps**, **Only Me**, **Team**
     - Feature flags: **Biometrics Authentication**, **Image Injection**, **Video Injection**
     - **Delete App**, Cancel, **Save Changes**
2. **Install from Play Store** — copy only: *You can download your app from play store once the session starts*
3. **Install from Firebase**
   - Empty: *No Projects Added* / *Add projects to get started.* / Documentation / **Add project**
   - **Integrate with Firebase** dialog:
     - Tips: add members at project level; create a separate App Live project; set redirect URL to `https://applive.lambdatest.com/app`
     - Tabs: **Upload a Config file** | **Connect with credentials**
     - Credentials: Enter Project ID, Client ID, Secret Key, **Sign in with Google**

### 3.4 Right: device catalog

- Search devices
- Brand list (Android observed): Samsung, Google, OnePlus, Xiaomi, Huawei, OPPO, Vivo, Motorola, Microsoft
- Device rows: name + OS icon + version; **New** badge (e.g. Galaxy Z Fold8 Ultra / 17)
- iOS brands: **iPhone**, **iPad**. Default launch observed: `Alaan_21_jul_2026.ipa` on **iPhone 17 / 26**

Android default on first load: selected APK `app-staging-release_4_Aug_2026.apk` on **Galaxy S26 Ultra / 16**.

---

## 4. Screen: Browser Testing (`/browser`)

Same shell and device picker; **payload is a URL + browser**, not an app.

- Top: textbox `Paste your URL here` · Tunnel · **Start** (no “You are launching…” app sentence)
- Browser list **depends on OS**:
  - iOS: **Safari**, **Google Chrome**
  - Android: **Google Chrome**, **Firefox**, **Samsung Internet**, **Microsoft Edge**, **UC Browser Turbo**, **Opera**, **Yandex**
- Same Advanced Settings / Public / Private / Android–iOS tabs / brand+device lists

Clone: one `LaunchComposer` with a `payload` slot = `AppSource | BrowserUrl`.

---

## 5. User workflow (clone steps)

1. User opens Real Device → App Testing or Browser Testing.
2. Choose **Public** (or request Private).
3. Choose **OS**. Catalog and payload lists rebind.
4. Choose **brand** then **device+version** (or search).
5. **App Testing:** pick an uploaded app (or upload file/URL, or defer to Play Store / Firebase). Optionally set SIM, biometrics, injection flags.
6. **Browser Testing:** paste URL, pick browser.
7. Optionally start a **tunnel** if the app/site is private.
8. **Start** opens a live session (not observed) and decrements Real Mobile Live.
9. End session returns to this composer; Sessions would list history if enabled.

Do **not** model this as Project → Build → Test. There is no build name, no Cucumber scenario, no `lambda-status`.

---

## 6. Backing APIs observed

| Endpoint | Role |
|---|---|
| `GET https://beta-api.lambdatest.com/manual/v2.0/device?` | Device catalog for live/manual |
| `GET https://server-events.lambdatest.com/api/v1/sse/rdmanual` | SSE channel for Real Device manual (vs `sse/appautomation`) |
| `GET https://auth.lambdatest.com/api/v2/organization/concurrency` | Parallels / pool usage |

Device fetch from the Browser Testing origin failed CORS (`Failed to fetch`); the UI still called it on `/app`. Clone from a single API origin or proxy.

App cards use ids `APP1016…` — same app-upload namespace as Automation.

---

## 7. Build-order recommendation for the clone

1. **Catalog service**: OS → brand → device+version, Public vs Private, search, New badge. One list component shared by App and Browser.
2. **Payload service**: app inventory (search, team visibility, upload file/URL, sample app) + browser list keyed by OS + URL field.
3. **Launch composer**: sticky summary + Start gated on complete selection; tunnel chip.
4. **Concurrency**: Real Mobile Live / Live Plus with Consumed By Other.
5. **Advanced settings** as a plan-gated menu (this org: SIM only).
6. **Firebase / Play Store** as optional payload sources with the empty states above.
7. **Live session viewer** — last, after Start is implemented; this pass has no UI for it.
8. **Sessions history** — implement the `/sessions` route; expect some orgs to no-op redirect.

Deliberately skipped: live remote-control toolbar, App Manager CRUD, actually starting or deleting anything, Real Time (desktop browsers — different navbar item).
