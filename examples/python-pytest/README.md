# Python / pytest on MFARM

A **runnable** suite, in a language this repo had never used, against the same farm and the same app
as [`../medishop-suite`](../medishop-suite) (WebdriverIO). It exists to answer one question with
evidence instead of architecture: **does a test have to be written in a particular language or
framework to run here?**

## The answer

**No, and nothing had to be built for it.** This suite was written on 2026-09-11 and ran on real
Cuttlefish the same hour with **zero farm-side changes** — no new capability, no adapter, no
migration, no deploy. Three tests, three named rows, `ALL PASSED 3/3` on the console's run screen.

That is a property of the protocol rather than of this example. The hub speaks **W3C WebDriver**, so
anything with an Appium client works: Java/TestNG, Python/pytest, C#/NUnit, Ruby, JS/WebdriverIO,
Robot Framework, Cucumber in any of them. The `mfarm:` capabilities are a JSON object — every
language can build one — and the result hook is `executeScript`, which every client already has.

**What is NOT covered by that, and would need building:** a framework that does not speak WebDriver
at all. Espresso and native UIAutomator run through `adb shell am instrument`, and Maestro drives its
own agent. There is no instrumentation door in this farm — `/wd/hub` is the only automation entrance
— so those need a new execution path, not a new capability. See `docs/STATUS.md`.

## Running it

```bash
export MFARM_HUB=https://farm.mfarm.dev
export MFARM_API_KEY=mfk_…                            # console → Settings → API keys
export MFARM_APP_ID=com.way2automation.medishop@latest
pip install -r requirements.txt
pytest -v
```

`MFARM_RUN_ID` defaults to `$GITHUB_RUN_ID` in CI and to a local timestamp otherwise, so a laptop run
is its own run rather than joining somebody else's.

## The two things worth copying

**The API key goes in a header, not in the URL.** Several HTTP stacks quietly drop
`https://key@host/…` userinfo, and the farm then answers *"Missing or invalid credentials"* for a
request that looked correct. `conftest.py` subclasses `AppiumConnection` to set `Authorization`
explicitly. The WebdriverIO suite documents the same trap in a different shape — this is a client
problem, not a farm problem.

**One session per test, named at creation.** `mfarm:name` is set from `request.node.name`, so the
console shows the scenario's name *while it runs* rather than after it posts a result. This is the
LambdaTest shape — one Appium session per Cucumber scenario — and it is why the run screen's TEST
column is readable here. `../medishop-suite` deliberately does the opposite, one device per spec
FILE, because allocation and powerwash cost real seconds. Both are fine; the farm does not care.

## What was measured, including the part that went wrong

Six pytest sessions on 2026-09-11:

| run | expected | farm recorded |
|---|---|---|
| the three sign-in tests | 3 passed | `total=3 passed=3`, three named rows |
| a deliberate failure ×4 | 1 failed each | `total=1 failed=1` each, named |
| the first deliberate-failure run | 1 failed | **`total=0`, nothing reported** |

**That last row is unexplained and is recorded rather than smoothed over.** pytest printed `1 passed`
for a test that cannot pass, and the hub's command trace for that session stops dead after six
element lookups — no `execute/sync`, no `DELETE`. The client stopped talking mid-poll. Four later
runs of the identical file failed correctly, so it is roughly one in six and has not been reproduced.

**The farm did not claim a pass.** With nothing reported it shows *"Not reported"*, which is the
designed refusal to infer an outcome from a session ending — the thing
`docs/ltcomp/mfarm-ci-session-console-analysis.md` §10 says explicitly not to copy from LambdaTest.
Only pytest claimed a pass. Verify a suite's failure path before trusting its passes; this example's
failure path is verified four times over and is still worth re-checking in your own.
