# MediShop suite — a demonstration Appium suite on MFARM

An ordinary [WebdriverIO](https://webdriver.io) suite against the
[MediShop](https://f-droid.org) practice app, run on the farm instead of a local emulator.

It is deliberately **outside the workspaces**, with its own `package.json` and `node_modules` — the
point is that it looks like your repo, not like part of this one.

## Run it

```bash
npm install

MFARM_API_KEY=mfk_…                                    # console → Settings → API keys
MFARM_HUB=https://farm.mfarm.dev                       # your farm
MFARM_REGION=lab
MEDISHOP_APP_ID=com.way2automation.medishop@latest     # a build in the farm's app library
MFARM_RUN_ID=$(date +%s)                               # optional — groups the eight into one run

npm test
```

```
✔ the app opens on the practice portal
✔ the wrong password does not sign anyone in
✔ the real credentials reach the home screen
✔ a category opens the medicine catalogue
✔ a product can be added to the cart
✔ holds line items and an order summary
✔ orders shows history
✔ profile shows the signed-in account
```

## What changes when a suite moves onto the farm

`farm.js` is the whole of it. Everything else is WebdriverIO that would run against a local emulator
unchanged.

**One hostname and one credential.** The key goes in as HTTP Basic — the key is the username, the
password half stays empty, which is also what `https://<key>@host/wd/hub` produces.

> **Do not use WebdriverIO's `user` / `key` options.** They only become an `Authorization` header for
> hostnames WebdriverIO recognises as cloud providers. Point them at your own hub and they are
> silently dropped, and the farm answers *"Missing or invalid credentials"* for a request that looks
> perfectly correct. Set the header yourself, as `farm.js` does.

**One capability, `mfarm:region`.** The allocator picks the device; there is no way to ask for a
specific one, so nothing here pretends otherwise. `mfarm:queueTimeoutSeconds` turns "no capacity"
into a queue rather than an instant failure.

**The APK ships with the session.** Devices are powerwashed between tenants, so anything installed
by hand beforehand is gone before your suite starts, so the build has to arrive with the session
that uses it. `mfarm:appId` names a build in the farm's **app library** — by id, or as
`com.example.app@1.4.2`, or `com.example.app@latest` — and the farm installs it before the session
opens. (`appium:app` still works and takes a path on the *device host*, which is exactly the coupling
the library removes. Setting both is an error rather than a coin toss.)

**One line makes the eight tests one run.** `mfarm:runId` takes an id your CI already has —
`$GITHUB_RUN_ID`, a Jenkins build number, a uuid per `npm test`. Without it the suite arrives as
eight unrelated device leases in a flat list; with it, it is one row in the console's **Runs**
screen, showing the build under test, how many sessions it took and how many are still live. Nothing
has to be created first: the farm creates the run when the first session names it and every later
session joins it, so a suite that dies halfway leaves a run that simply stops growing. `farm.js`
falls back to `$GITHUB_RUN_ID` on its own, and omits the capability entirely when neither is set —
running locally with no run is the normal case.

A run does **not** yet know how many tests passed. WebDriver has no concept of an assertion, so the
farm sees sessions open and close and cannot tell a passing test from a failing one; it reports what
it can see and says nothing about the rest.

**One device per spec file, not per test.** Allocation takes seconds and the reset after release
takes about a minute, so a device per test spends more time recycling than testing. This is the main
thing that changes when a suite leaves a laptop.

**Always release.** `deleteSession()` in `after()`, on every path. A suite that forgets holds a
device until its lease expires, and on a two-device farm that is half the fleet.

## Selecting elements in a Compose app

MediShop is Jetpack Compose, and **Compose emits no resource-ids at all**. `By.id` has nothing to
match; `~accessibility id` and `//*[@text=…]` are the only handles that exist. Every selector here
came from the console's element inspector — open a device, turn on Inspect, tap the thing.

Text selectors are brittle by nature and this suite shows why: the catalogue's add control renders
as a bare `+` in one layout and `Add` in another, so `pages/catalogue.js` matches a union of both.
The real fix is a `testTag` in the app, which would give it an id and make it one stable selector.

## When a test fails

`withDevice()` captures a screenshot into `artifacts/` **before** anything unwinds. The farm takes
its own screenshot when the device is released, but Appium force-stops the app during
`deleteSession()`, so that one shows the launcher. The failure state only exists while the session
is still open.

The farm's own logcat artifact is unaffected and covers the whole run — find it in the console under
the session's **Evidence** card.

## Running it in CI

`ci-example.yml` is a working GitHub Actions workflow — copy it into your app's repository as
`.github/workflows/device-tests.yml` and set one secret.

**No MFARM CLI is needed.** The suite allocates and releases its own device through the WebDriver
hub, exactly as it does on a laptop. `mfarm run` exists to wrap a command that *cannot* do that for
itself; a WebdriverIO suite can.

Nothing Android is installed on the runner. That is the point: a GitHub runner has no emulator worth
testing on, and this replaces it with real Cuttlefish devices reached over HTTPS.

Three things the workflow does that are easy to leave out:

- **Its own API key.** Give CI a key nobody else uses — revoking it must not break a colleague, which
  is why keys are per-purpose rather than per-farm.
- **A concurrency group.** A two-device farm cannot serve four concurrent jobs; queueing at the
  workflow level gives a clearer signal than four suites contending and timing out in turn.
- **Uploading `artifacts/` on failure.** The farm keeps a logcat and a screenshot for every session,
  but its screenshot is taken after Appium stops the app — the failure state only exists in the ones
  this suite captures.

### Getting your build onto the device

Upload it, then name it. Nothing in your CI needs to be able to reach the device host.

```bash
curl -X POST "$MFARM_HUB/v1/apps?filename=app.apk" \
  -H "authorization: Bearer $MFARM_API_KEY" \
  -H "content-type: application/vnd.android.package-archive" \
  --data-binary @app/build/outputs/apk/debug/app-debug.apk
```

Uploads are content-addressed, so pushing an unchanged build costs one row and no bytes. The
response carries the build's `id`; `mfarm:appId` takes that, or a coordinate:

| `mfarm:appId` | resolves to |
|---|---|
| `9c3f8e1a-…` | that exact build. The reproducible one — pin it when a run must be repeatable. |
| `com.example.app@1.4.2` | the newest build whose `versionName` is `1.4.2`. |
| `com.example.app@latest` | the newest build of that package. What a nightly wants. |
| `com.example.app` | the same as `@latest`. |

The build that a session actually used comes back as `mfarm:appId` in the returned capabilities, so
a `@latest` run records which build it resolved to rather than leaving it to be guessed afterwards.

Two things to expect. The install adds **up to a heartbeat interval (10 s) plus the install itself**
to session creation, because the control plane cannot dial a worker — it queues the job and the
device's next beat collects it. And the app is installed but not *started* by the farm: the hub sets
`appium:appPackage` to the resolved package so Appium brings it to the foreground, and a suite that
needs a specific entry point sets `appium:appActivity` itself.
