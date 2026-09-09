# Java / TestNG / Cucumber on MFARM

`MfarmCapabilities.java` is a file to **copy into your suite and edit**, not a dependency. It is
about sixty lines of `setCapability`, and the one thing you must be able to do is read every line
that touches your driver.

It is written against the shape a suite arriving from LambdaTest actually has: a
`CreateMobileDriver` that builds capabilities, and a `TestHooks` that opens one Appium session per
Cucumber scenario and reports `lambda-status` in its teardown.

## The whole migration

```bash
export MFARM_HUB=https://farm.mfarm.dev
export MFARM_API_KEY=mfk_…              # console → Settings → API keys
export MFARM_REGION=lab
export MFARM_APP_ID=com.example.app@latest
export MFARM_DEVICE_CLASS=mfarm-x1-pro  # optional — omit for any device
```

```java
// @Before
driver = new AndroidDriver(
    MfarmCapabilities.hub(),
    MfarmCapabilities.forScenario(scenario.getName(), System.getenv("GITHUB_RUN_ID"), xmlPath));

// @After
MfarmCapabilities.reportStatus(driver, !scenario.isFailed());
driver.quit();
```

## What maps onto what

| LambdaTest | MFARM | note |
|---|---|---|
| `mobile-hub.lambdatest.com/wd/hub` | `farm.mfarm.dev/wd/hub` | one origin serves the console, the hub and the API — there is no separate `mobile-api` host |
| username + access key | one API key, as the Basic **username** | the password half stays empty |
| `lt:options.build` | `mfarm:runId` **and** `mfarm:runName` | see below — one field could not be both |
| `lt:options.name` | `mfarm:name` | the session is named from the moment it is created |
| `lt:options.project` | — | not built. `mfarm:runId` is the only grouping today |
| `app: "lt://APP…"` | `mfarm:appId` | takes `com.example.app@1.4.2`, `@latest`, or a uuid |
| `deviceName: "Pixel.*"` + `platformVersion: "13\|14\|15"` | `mfarm:deviceClass` | **a class, not a device** — see below |
| `idleTimeout: 600` | `mfarm:ttlMinutes` | a lease, not an idle timer |
| — | `mfarm:queueTimeoutSeconds` | wait for capacity instead of failing. LambdaTest queues implicitly; here you ask |
| `executeScript("lambda-status=passed")` | `executeScript("mfarm-status=passed")` | before `quit()`, same as there |

### Two fields for one LambdaTest capability

`lt:options.build` was doing two jobs. `mfarm:runId` is the id CI already has (`$GITHUB_RUN_ID` — a
number, and the only thing that will match the Actions run); `mfarm:runName` is what a person scans
a list for (`Android_UAE_Expenses_08_09_2026_06_53_38`). Set both. The **first** session of a run
sets the name; later ones do not change it.

> `mfarm:build` does not exist, and the collision is why. In MFARM a **build** is an APK in the app
> library — it is the word on the Apps screen and the column header on the Runs table. A second
> meaning for it on the same page would be unreadable.

### You choose the kind of device; the farm chooses the device

There is no `deviceName` regex and no `platformVersion` list, and that is the allocator's contract
rather than a missing feature: a suite that names a device is a suite that can be handed one another
tenant is using. `mfarm:deviceClass` names a **profile id** from the console's Fleet page
(`mfarm-x1-pro`), and the farm returns a concrete device from that class.

Omit it entirely to take any device that can run WebDriver — the right default on a small fleet. Ask
for a class this farm has none of and the session fails **naming the class**, rather than running
your suite on the wrong screen geometry.

## Concurrency

LambdaTest's 2-session ceiling is a plan limit. Here it is `max_concurrent` on your org plus the
size of the fleet, and the difference matters: with `mfarm:queueTimeoutSeconds` set, a third session
**queues** rather than failing, and the console's Queue screen shows where it stands.

That is what lets you drop a `concurrency-group` from GitHub Actions — the serialisation most teams
add because the farm queue was opaque. Raise `thread-count` when the fleet supports it; the farm
will queue the overflow rather than refusing it.

## What the hook cannot carry

`mfarm-status` is a status word and nothing else. For a failing test the stack is worth having, so
post the full result from the same teardown:

```
POST {MFARM_HUB}/v1/sessions/{driver.getSessionId()}/result
Authorization: Bearer {MFARM_API_KEY}
{"name": "...", "status": "failed", "failure": "<stack>", "durationMs": 1200,
 "failureReason": "assertion-failure"}
```

`driver.getSessionId()` is the **farm's** session id — the hub hands back its own rather than
Appium's — so one id spans your test log, the console, the artifacts and the invoice, with no
correlation step.

## Credentials

Take the key from the environment, not from `config.properties`. A key in a properties file is a key
in the git history, and the log-masking step a CI job runs to keep it out of build output is a
mitigation for a problem that does not need to exist. MFARM's key is a single credential for the
hub, the REST API and artifact reads.

## What is not here

**iOS.** Out of scope for now, deliberately.

**A tunnel.** If your app under test talks to a private staging host, MFARM has no equivalent of
LambdaTest's tunnel binary yet. (MFARM's own agent tunnel is a different thing pointing the other
way — it lets the control plane reach a device host behind NAT.)

**A runnable suite.** For one of those, see [`../medishop-suite`](../medishop-suite) — a working
WebdriverIO suite with its own CI workflow. This directory is the Java translation of its `farm.js`.
