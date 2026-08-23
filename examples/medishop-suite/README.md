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
MEDISHOP_APK=/home/rkcr070707/apks/way2automation.apk  # a path ON THE DEVICE HOST

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
by hand beforehand is gone before your suite starts. `appium:app` is the only reliable route.

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
