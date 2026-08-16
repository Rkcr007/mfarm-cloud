# Running your tests on MFARM from CI

Your existing Appium / Espresso / XCUITest suite does not change. The action allocates a device,
puts its coordinates in your test command's environment, runs the command, and releases the device
on every exit path — including a cancelled job.

## GitHub Actions

Add one secret, then drop this in:

```yaml
name: Mobile tests

on: [push, pull_request]

jobs:
  device-tests:
    runs-on: ubuntu-latest
    steps:
      # Pinned to a commit SHA, not to `@v5`. A tag is a mutable pointer its owner can move to any
      # commit at any time, and your workflow would execute that new code with your secrets on the
      # next run. Same rule as the note at the bottom of this page — it applies to the snippet we
      # hand you, not only to our own CI.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      # `@v1` is our tag and is mutable in exactly the same way. It is the friendly default, but if
      # your threat model does not include "MFARM's release process", pin this to a SHA too.
      - uses: mfarm/mfarm-cloud@v1
        with:
          api-key: ${{ secrets.MFARM_API_KEY }}
          region: us-east
          command: npx appium-test
```

**The secret:** `MFARM_API_KEY`, at *Settings → Secrets and variables → Actions → New repository
secret*. The value is the key from your MFARM dashboard (it starts with `mfk_`). Never inline it —
the action masks it, but a key committed to a workflow file is a key you have to rotate.

### Inputs

| input | required | default | maps to |
|---|---|---|---|
| `api-key` | yes | — | `MFARM_API_KEY` in the environment (never a CLI argument) |
| `region` | yes | — | `--region` |
| `command` | yes | — | the child process the CLI runs |
| `platform` | no | `android` | `--platform` (`android` \| `ios`) — set it to `''` to omit the flag entirely |
| `tier` | no | server picks | `--tier` |
| `ttl` | no | 30 minutes | `--ttl` |
| `wait` | no | 300 seconds | `--wait` — how long to sit in the queue before giving up |
| `api-url` | no | `https://api.mfarm.dev` | `--api` |
| `working-directory` | no | `.` | directory `command` runs from |

### Outputs

| output | description |
|---|---|
| `session-id` | the MFARM session |
| `device-id` | the device you were given |
| `exit-code` | raw exit code from the CLI (see the table below) |
| `verdict` | that code classified: `pass`, `test-failure`, `setup-failure`, `capacity`, `interrupted` |

Branch on `verdict`, not on `exit-code` — it is what separates the two quite different things exit
`1` can mean.

A composite action does not reliably publish outputs once it has failed the job — which is exactly
when you want the session id. The same values are therefore also exported to the job environment
as `MFARM_SESSION_ID`, `MFARM_DEVICE_ID`, `MFARM_EXIT_CODE` and `MFARM_VERDICT`. Read those from an
`if: always()` step:

```yaml
      - if: always()
        run: echo "session was $MFARM_SESSION_ID on device $MFARM_DEVICE_ID"
```

### What your test command sees

The CLI exports these into the child process before running it:

```
MFARM_SESSION_ID
MFARM_DEVICE_ID
MFARM_REGION
MFARM_WEBDRIVER_URL        <api-origin>/wd/hub, with the auth and this run's session
                           id already embedded — point Appium at it and change nothing else
MFARM_DATA_PLANE_ENDPOINT
MFARM_SESSION_TOKEN
```

`MFARM_WEBDRIVER_URL` is the whole migration: point your Appium client at that one variable.
Nothing else in the suite changes — not even `mfarm:region`, because the URL already names the
session this run allocated and that session already has a device in a region. (Setting
`mfarm:region` to something else is an error rather than a silent move; the session wins.)

`mfarm run` allocates a device that can serve WebDriver, which is what makes that URL work. If your
command speaks only the raw data plane, pass `--no-webdriver` so a fleet without Appium can still
serve it.

## Exit codes

| code | `verdict` | meaning | what to do | annotation |
|---|---|---|---|---|
| *child's own code* | `test-failure` | your command ran; this is its code, verbatim | it's your suite | `::error::` |
| `1` | `test-failure` | your command ran and exited 1 | it's your suite | `::error::` |
| `1` | `setup-failure` | allocation, auth, or config failed **before** your command started | check the `api-key` secret and the region | `::error::` |
| `75` | `capacity` | `EX_TEMPFAIL` — no device became available before `--wait` expired | **retry.** Your tests never ran | `::warning::` |
| `130` | `interrupted` | SIGINT/SIGTERM, e.g. a cancelled job | nothing; the device was released | `::error::` |
| `0` | `pass` | everything worked | — | `::notice::` |

The two meanings of `1` are told apart for you: the action knows whether your command ever started.

`75` is the one that gets a `::warning::` rather than an `::error::`, titled *MFARM capacity
(retryable)*. The job still fails — your tests did not run, and a green build would be a lie — but
the annotation says plainly that the cause was us and not your code. That distinction is the whole
reason to trust a device cloud in CI, so it is asserted on in
`.github/workflows/action-test.yml` rather than left to good intentions.

### Retrying a capacity failure

Read the whole block before adapting it. There is one trap, and it is not obvious: **`MFARM_VERDICT`
is a job-level variable, so the retry overwrites it.** A guard written against `env.MFARM_VERDICT`
after the retry has run is reading the *retry's* verdict while believing it is the first attempt's —
which fails the job precisely when the retry succeeded. So attempt 1's verdict is snapshotted into
its own variable before anything can clobber it, and one final step decides the outcome:

```yaml
      - id: tests
        continue-on-error: true
        uses: mfarm/mfarm-cloud@v1
        with:
          api-key: ${{ secrets.MFARM_API_KEY }}
          region: us-east
          command: npx appium-test

      # Snapshot attempt 1's verdict NOW, before a second invocation of the action can overwrite
      # MFARM_VERDICT. `always()` so it also runs when the first attempt failed, which is the only
      # case that matters.
      - name: Remember the first attempt
        if: always()
        run: echo "ATTEMPT1_VERDICT=${MFARM_VERDICT:-unknown}" >> "$GITHUB_ENV"

      # Only a capacity timeout is worth retrying. A failing suite will just fail again.
      - id: retry
        if: env.ATTEMPT1_VERDICT == 'capacity'
        continue-on-error: true
        uses: mfarm/mfarm-cloud@v1
        with:
          api-key: ${{ secrets.MFARM_API_KEY }}
          region: us-east
          wait: '600'
          command: npx appium-test

      # The only step allowed to decide the job's colour. Both attempts absorbed their own failure
      # with continue-on-error, so nothing else can.
      - name: Decide the job
        if: always()
        env:
          ATTEMPT1: ${{ env.ATTEMPT1_VERDICT }}
          # 'success', 'failure', or 'skipped' when the retry never ran.
          RETRY: ${{ steps.retry.outcome }}
        run: |
          set -euo pipefail
          case "${ATTEMPT1}" in
            pass)
              exit 0 ;;
            capacity)
              if [ "${RETRY}" = "success" ]; then
                echo "::notice::First attempt hit a capacity timeout; the retry passed."
                exit 0
              fi
              echo "::error::Capacity retry did not pass (retry outcome: ${RETRY})."
              exit 1 ;;
            *)
              echo "::error::Mobile tests failed (verdict: ${ATTEMPT1})."
              exit 1 ;;
          esac
```

Two details worth keeping if you rewrite this:

- **Branch on the snapshot, not on `steps.tests.outcome`.** `outcome` is `failure` for a capacity
  timeout and for a broken suite alike; that distinction only exists in the verdict.
- **Use `MFARM_VERDICT` / `MFARM_EXIT_CODE` from the environment rather than
  `steps.tests.outputs.*`.** A composite action that has failed the job does not reliably publish
  its outputs, and a capacity timeout is by definition a run that failed.

Or skip the plumbing entirely and raise `wait` — the CLI polls the queue for you, and `wait: '900'`
costs nothing when capacity is free. That is the recommended option for most teams; the block above
exists for jobs where holding a runner slot for fifteen minutes is itself expensive.

## Other CI systems

There is no wrapper yet for GitLab, CircleCI, Buildkite or Jenkins, but there is nothing to wrap:
the action is a thin shell around one command. Anywhere you can run Node 22:

```bash
export MFARM_API_KEY="$MFARM_API_KEY"   # from your CI's secret store, never an argument

# The package is SCOPED and the version is PINNED, both deliberately:
#   @mfarm/cli   an unscoped `mfarm` on npm is a name we do not own, and this process holds your
#                API key — `npx mfarm` would hand it to whoever registered that name.
#   @0.1.0       a floating dist-tag means an unreviewed publish executes with your key on your
#                next CI run. Bump it when you choose to, not when we do.
#   --package    the binary is `mfarm` but the package is `@mfarm/cli`; npx cannot infer that.
npx --yes --package "@mfarm/cli@0.1.0" mfarm run --region us-east -- npx appium-test
```

The exit code table above applies unchanged. Set `MFARM_REGION`, `MFARM_PLATFORM`, `MFARM_TIER`,
`MFARM_TTL` and `MFARM_WAIT` in the environment instead of passing flags if that suits your
runner better.

---

## Contributing: this repo's own CI

`.github/workflows/ci.yml` runs on every push and pull request. It stands up a `postgres:16-alpine`
service that replicates `apps/api/docker-compose.yml` (user `mfarm`, database `mfarm`, published on
host port **5433** because that is the fallback hardcoded in `apps/api/src/db.ts` and
`scripts/migrate.mjs`), then runs migrations, a role-verification guard, the tests, and
`tsc --noEmit` as four separately visible steps.

The guard is not ceremony. Migrations run as the owner `mfarm`, a superuser; the app connects as
`mfarm_app`, which has neither `SUPERUSER` nor `BYPASSRLS`. A superuser bypasses row-level security
unconditionally, so if `APP_DATABASE_URL` ever pointed at `mfarm`, every policy in `002_rls.sql`
would still read as enabled while enforcing nothing, and the tenant-isolation tests would pass
green against a database with isolation switched off. The guard asserts the role's catalog flags,
`ENABLE`+`FORCE ROW LEVEL SECURITY` on all six tenant tables, and — connecting the way the app
actually connects — that `is_superuser` is `off`.

`.github/workflows/action-test.yml` exercises `action.yml` in two layers:

- **`scenarios`** drives a bash stub CLI. It checks that only contract-defined flags are passed,
  that no flag is ever passed with an empty value, that the API key reaches the CLI through the
  environment and **never** appears in argv, and that each exit code produces the right verdict.
- **`real-cli`** drives the actual `apps/cli/src/bin.ts` against a stub control-plane HTTP server
  and asserts on the recorded requests. A stub CLI written from the same contract document as the
  action can only prove that one reading of the contract is self-consistent; this job is the only
  thing covering the `apps/cli` ↔ `action.yml` seam, and a live bug was found there — the action
  passed `--platform` unconditionally while the CLI reads `--platform ''` as a value rather than
  as an absence.

Both jobs run locally, against the same matrix and the same assertion scripts, with:

```bash
python3 .github/scripts/action-selftest-local.py        # -v for full output, -k to filter
```

That harness invokes each step as `bash --noprofile --norc -eo pipefail`, which is exactly how the
GitHub runner invokes `shell: bash`. The distinction matters: `-e` is **injected by the runner** and
is already on before a step's own `set` line executes, so `set -uo pipefail` does not clear it and a
bare non-zero command aborts the step and discards its outputs. That is not visible by reading the
YAML, and it is the specific bug this harness was written to catch.

Every third-party action is pinned to a full commit SHA, in the workflows *and* in the snippets on
this page. A tag is a mutable pointer, so `@v5` is an unaudited-code-execution hole in every
workflow that trusts it. `ci.yml` enforces this rather than trusting the reviewer: see the
"Workflow hygiene" step, which also runs `bash -n` over every `run:` block in the repo.
