# `mfarm`

Run the mobile test suite you already have on a cloud device.

## Adopting it

You change one thing: where your Appium client points.

```diff
- const driver = await remote({ hostname: 'localhost', port: 4723 });
+ const driver = await remote(process.env.MFARM_WEBDRIVER_URL);
```

Then wrap the command you already run:

```diff
- npx appium-test
+ npx mfarm run --region us-east -- npx appium-test
```

`mfarm` allocates a device, sets `MFARM_WEBDRIVER_URL` (and the rest of the coordinates) in your
command's environment, runs it, and releases the device. It does not run your tests, parse your
output, or touch your exit code — it is a wrapper, and everything between `--` and the end of the
line is yours.

Set `MFARM_API_KEY` as a CI secret. That is the whole migration.

## Commands

```
mfarm run [options] -- <command> [args...]   allocate a device, run the command, release
mfarm devices [options]                      list devices visible to your organisation
mfarm session get <id>                       inspect one session
mfarm session rm <id>                        force-release a session
mfarm --version | --help
```

| flag | env | default |
|---|---|---|
| `--api <url>` | `MFARM_API_URL` | `https://api.mfarm.dev` |
| `--api-key <key>` | `MFARM_API_KEY` | — (required) |
| `--json` | | off — one JSON object on stdout |
| `--quiet` | | off — silences progress on stderr |
| `--region <r>` | `MFARM_REGION` | required for `run` |
| `--platform <android\|ios>` | `MFARM_PLATFORM` | `android` |
| `--tier <t>` | `MFARM_TIER` | unset; the server picks |
| `--ttl <minutes>` | `MFARM_TTL` | 30 |
| `--wait <seconds>` | `MFARM_WAIT` | 300 (`0` fails immediately instead of queueing) |
| `--no-webdriver` | | off — by default `run` allocates a device that can serve Appium, because `MFARM_WEBDRIVER_URL` needs one. Pass this for commands that only speak the raw data plane. |

Prefer the environment variables in CI: an API key on a command line is visible to every other
process on the runner via `ps`, and shells with `set -x` echo it into the build log.

## Environment given to your command

```
MFARM_SESSION_ID
MFARM_DEVICE_ID
MFARM_REGION
MFARM_WEBDRIVER_URL         <api-origin>/wd/hub, with your key as basic-auth userinfo
                            and this run's session id as the basic-auth password, so the hub
                            drives the device mfarm already allocated instead of taking another
MFARM_DATA_PLANE_ENDPOINT   } only when the device was allocated immediately — a session that
MFARM_SESSION_TOKEN         } waited in a queue is promoted without new data-plane coordinates
```

`MFARM_WEBDRIVER_URL` contains your API key. It is masked wherever `mfarm` prints it, but if you
echo the environment in a build step, you will publish a credential.

## Exit codes

| code | meaning |
|---|---|
| *child's own* | your command ran; its exit code is passed through untouched |
| `1` | allocation, auth or configuration failure before your command started |
| `75` | no device became available within `--wait` — `EX_TEMPFAIL`, retry the job |
| `130` | interrupted (SIGINT/SIGTERM) |

`75` exists so a capacity problem is distinguishable from a failing test. Retry on `75`; page
someone on a real failure.

## The device is always released

On a clean exit, on a crash, on `^C`, on `SIGTERM`, on an allocation error after the session
exists, and on an internal error. A device that is not released is billed to you and is out of the
pool until the server-side reaper collects it at TTL.

Release is best-effort: if the release call itself fails, `mfarm` says so on stderr and leaves the
exit code alone. A cleanup hiccup must never turn a green test run red — the reaper is the backstop.

## Requirements

Node ≥ 22.6. No build step, no runtime dependencies.

```bash
node --test --experimental-strip-types test/*.test.ts
```
