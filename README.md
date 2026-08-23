# MFARM

A **self-hosted Android device farm**. Point an existing Appium or WebdriverIO suite at one extra
URL and it runs on real Android devices the farm allocates, resets and accounts for — instead of on
an emulator on somebody's laptop.

Devices are [Cuttlefish](https://source.android.com/docs/devices/cuttlefish) instances on a Linux
host with KVM. The bet is physical-device-like testing at virtual-device economics.

```js
// the entire migration, in a wdio.conf.js
capabilities: {
  platformName: 'Android',
  'appium:automationName': 'UiAutomator2',
  'mfarm:region': 'lab',
  'mfarm:appId': process.env.APP_ID,        // the farm installs it before the session opens
  'mfarm:runId': process.env.GITHUB_RUN_ID, // twenty tests become one run
}
```

## → [docs/INDEX.md](docs/INDEX.md) — the one page

Everything is curated there: what is built, every decision and what it rejected, the roads
deliberately not taken, the invariants that fail silently if broken, and every number we actually
measured. Nothing else needs to be read first.

Shortcuts, if you already know what you want:

| | |
|---|---|
| Get it running | [docs/START_HERE.md](docs/START_HERE.md) |
| Run your suite on it | [examples/medishop-suite/](examples/medishop-suite/README.md) · [docs/ci.md](docs/ci.md) |
| How execution works | [docs/EXECUTION_MODEL.md](docs/EXECUTION_MODEL.md) |
| State of play, known issues | [HANDOFF.md](HANDOFF.md) |
| Why things are the way they are | [docs/adrs/](docs/adrs/) |

## Layout

```
apps/api/          control plane, app library, web console, WebDriver hub
apps/cli/          the mfarm CLI
workers/agent/     worker agent, Appium supervisor, Cuttlefish backend
packages/protocol/ the shared contract
deploy/            deploy scripts, and the checks that verify a farm is really live
docs/              start with INDEX.md
examples/          a worked suite: 8 tests, one build, one run, real outcomes
```

## Verifying it

Nothing here is trusted because a command exited zero.

```bash
npm test                    # 652 tests against a real PostgreSQL 16, no mocks that matter
./deploy/farm-online.sh     # start both machines
./deploy/farm-check.sh      # API, fleet, data plane, media relay
```

Against a live farm, `deploy/verify-runs.mjs` drives every execution-model capability end to end on
a real device; `deploy/verify-queue.mjs` fills the farm and proves the queue actually queues.
