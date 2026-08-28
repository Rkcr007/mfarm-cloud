# Physical devices

A phone on a USB cable, in the same console as the virtual fleet. See
[ADR-0008](adrs/0008-physical-devices-behind-the-existing-agent.md) for why it is built this way —
a third backend behind the existing agent, not a second agent.

**What works today:** enrollment, discovery, reservation, APK install, launch, logcat, screenshots,
the UI inspector, and Appium/WebDriver automation.

**What does not:** the live view. A handset publishes no WebRTC stream the way Cuttlefish does, and
the honest options are scrcpy-over-RTP (unbuilt) or a screenshot loop (refused — it sets a
performance baseline that is a lie). A real device shows no live screen and no interactive control
in the console. It runs tests.

---

## 1. Phone prerequisites (spec §8)

On the handset:

- **Developer Options enabled** — tap Build Number seven times in Settings → About phone.
- **USB debugging enabled**, in Developer Options.
- **ADB authorization accepted** — plug it in, then unlock the phone and tap **Allow USB
  debugging**. Tick *Always allow from this computer*, or you will do this again after every reboot.
- **Stay awake while charging** (Developer Options). A locked screen fails most automation.
- **Enough storage.** The agent reports the device degraded below 500 MB free, because an APK
  install needs headroom and the failure otherwise reads like a broken test.
- **Enough charge.** Below 15% the agent reports degraded; below ~10% installs and launches start
  failing outright.
- A **reliable cable**. More physical-farm tickets are bad cables than are bad phones.

The agent never changes these for you. Anything that needs a human is surfaced with the instruction
attached — see §4.

## 2. Host prerequisites

- **Linux or macOS** today. Windows is not supported yet: the installer is bash + systemd.
- **adb on PATH**, or `ADB_PATH` / `ANDROID_HOME` set.
- On Linux, **udev rules for the phone's vendor**, or adb reports `no permissions` and the device
  is never enrolled.
- **Appium + UiAutomator2**, if the host is to serve WebDriver.
- **No inbound port, no public name, no certificate.** A laptop behind NAT is the expected case:
  the agent dials out and both the live view and WebDriver ride that one socket (ADR-0008 for the
  data plane, ADR-0011 for automation). With no `APPIUM_ADVERTISE_HOST` set, the automation gateway
  binds `127.0.0.1` and is advertised as `mfarm+tunnel:/automation/<localId>`. Set an advertised
  address only on a host the control plane can genuinely dial, and only if you want the one-hop-
  shorter direct path.

## 3. Enrolling the host

The host needs a credential. **Do not paste the fleet secret into a laptop** — it never expires,
names nobody, and revoking it revokes every machine. Mint a single-use enrollment token instead.

**Minting is admin-only and there is no console screen for it yet, so it is the API — but not with
an API key.** `POST /v1/account/agent-enrollments` is guarded by `requireOrgAdmin`, which resolves a
**logged-in user**: it needs the `mfarm_session` cookie from `POST /v1/auth/login`, plus that
login's `csrfToken` echoed back in the `x-mfarm-csrf` header (the double-submit applies to every
non-GET request a cookie authenticates). An `Authorization: Bearer mfk_…` API key is a different
principal kind and is refused here, whatever its role.

```bash
FARM=https://farm.mfarm.dev
JAR=$(mktemp)

# 1. Log in as an org owner/admin. The cookie lands in the jar; the CSRF token comes back in the body.
#    The seeded console password is in deploy/.state/console_password on the control-plane host.
CSRF=$(curl -sS -c "$JAR" -X POST "$FARM/v1/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"admin@mfarm.local","password":"<console password>"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).csrfToken')

# 2. Mint. Cookie jar + CSRF header, and the plaintext is nested under `enrollment`.
curl -sS -b "$JAR" -X POST "$FARM/v1/account/agent-enrollments" \
  -H "x-mfarm-csrf: $CSRF" \
  -H 'content-type: application/json' \
  -d '{"label":"Ravi laptop","ttlHours":24}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).enrollment.plaintextShownOnce'
```

`ttlHours` defaults to 24 and caps at 168. The plaintext comes back **exactly once**, at
`enrollment.plaintextShownOnce`, and begins `mae_`. It is single-use, expiring, revocable, and
scoped to your org — and the host it enrolls carries that org, which is what keeps its phones out of
the shared pool (see §6). Revoke an unused one with `DELETE /v1/account/agent-enrollments/<prefix>`,
which needs the same cookie and the same CSRF header. Listing them
(`GET /v1/account/agent-enrollments`) needs the cookie but no CSRF header, because it is a GET.

Then run the agent. The enrollment token goes in the **same variable** the fleet secret would —
registration tells the three credential kinds apart by prefix, so enrolling a laptop is a different
value in an existing variable, not a new config key:

```bash
PHYSICAL_ENABLED=1 \
CONTROL_PLANE_URL=https://<farm> \
WORKER_REGISTRATION_TOKEN=mae_<the token> \
APPIUM_ENABLED=1 \
npm start -w @mfarm/agent
```

`PHYSICAL_ENABLED` is **opt-in on purpose**. Discovery is only a read, but enrolling what it finds
puts a handset somewhere other people's sessions can drive it — that should never happen because
somebody started an agent with a phone plugged in for unrelated reasons.

## 4. What the agent says about a phone it cannot use

Every unusable state is reported with the fix, because a plugged-in phone missing from the console
with no explanation is the most common support ticket there is:

| adb state | What it means | What you are told to do |
|---|---|---|
| `device` | usable | — (it enrolls) |
| `unauthorized` | nobody tapped Allow | Unlock the phone and tap "Allow USB debugging" |
| `offline` | adb sees it, cannot talk to it | Replug; try a different cable before anything else |
| `no permissions` | host udev rules | Install vendor udev rules and re-plug, or join `plugdev` |

It says all of it **on a page**, not only in the log — see below.

## 4a. The window

The agent prints a link when it starts and opens it:

```
[agent] window at http://127.0.0.1:7317/?t=KD_neIJ-DA4JvNQfrzjfilTg5G8LZnlBnBzPY8hAGmA
```

That page lists every phone adb can see on this machine — including the ones the agent is **not**
using — with the sentence that unblocks each one, and it updates on its own as phones come and go.
It also carries the Play Protect offer (§6a), because a security setting on somebody's own handset
is a decision to put in front of them rather than in an environment variable.

**The whole URL is the credential.** A server on `127.0.0.1` is not private — every process on the
machine can reach it, and so can any website you visit — so the page is gated three ways
(ADR-0009 §3), and all three are required:

- it binds loopback only, with no variable that can widen it;
- the token in that link is minted at start-up, never written to disk, and checked in constant time
  on every request;
- `Origin` and `Host` are validated on every request, so neither a page on another site nor a DNS
  name rebound to 127.0.0.1 can pose as the window.

| Variable | Default | What it does |
|---|---|---|
| `MFARM_WINDOW` | on | `MFARM_WINDOW=0` to serve no window at all |
| `MFARM_WINDOW_PORT` | `7317` | A busy port is not fatal — the agent takes an ephemeral one and prints it |
| `MFARM_WINDOW_OPEN` | on | `MFARM_WINDOW_OPEN=0` to print the link without launching a browser. Never launches one when stdout is not a terminal, so a service box is unaffected |

**The agent now stays up with no devices at all** when `PHYSICAL_ENABLED=1`. It registers with an
empty device list and waits, so you can start it, open the window, and *then* go and find a cable —
which was impossible before, because the agent exited at startup asking for an emulator nobody
wanted.

What the window does **not** yet do is survive a registration failure: a bad or spent enrollment
token still exits the process, so the "not registered yet" line is only visible while a registration
is in flight. Retrying a *transient* control-plane failure with the window up is the obvious next
step and is not built.

## 5. Adding or removing a phone

**Just plug it in.** The agent watches USB and picks up a new phone on its own — including a phone
that was already plugged in and becomes usable the moment somebody taps *Allow USB debugging*.

Arrival and departure are handled differently, on purpose:

- **A phone arrives.** It cannot be added in place — `hosts.capabilities` and the device list are
  written by registration and nothing else — so the agent **drains and exits**, and systemd's
  `Restart=always` brings it back with both phones. The drain waits for live sessions to finish, so
  plugging in a second phone does not interrupt a suite running on the first.
- **A phone leaves.** Nothing restarts. Health checks report it offline, an incident is recorded,
  and the control plane stops scheduling it — while every other device on the host keeps working.

If you run the agent by hand rather than under systemd, an arrival will exit the process and it is
on you to start it again. Under the supplied unit this is invisible.

Tune the poll with `PHYSICAL_DISCOVERY_INTERVAL_MS` (default 10000).

A host that has registered once keeps its own worker token (`mwk_…`) and re-registers with that
whenever its device set changes — so you do **not** need a second enrollment token to add a second
phone, and the enrollment token should not stay in the environment after the first successful
start.

Device ids are derived from the adb serial (`phone-39121FDH2003VK`), so they survive a replug and an
agent restart. An index would not: `phone-1` would become a different handset the moment someone
unplugged the first one.

## 6. What a reset does, and does not, do (spec §17, ADR-0012)

**By default, a release undoes exactly what the session installed and touches nothing else.** The
agent keeps a ledger of the packages it installed during the session and uninstalls those, in
reverse order, then presses HOME. If the session installed nothing, the release changes nothing.

That default exists because of what the alternative does to a borrowed phone. On the first handset
ever enrolled, `pm list packages -3` returned **134 packages** — banking, an Aadhaar authenticator,
chat, ride-hailing. The old behaviour cleared the data of all of them, and a session that *fails*
still allocates and releases, so it still reset: two failed attempts each fired a full sweep before
the product had ever worked once. A default that is safe only when an operator remembers a variable
is not a safe default when the failure is unrecoverable.

| Mode | What a release does | Capability declared |
|---|---|---|
| `install-scoped` **(default)** | Uninstalls what this session installed | `install-reset` |
| `full-sweep` | `pm clear` on every third-party package minus the keep list | `session-reset` |

Opt into the sweep with `PHYSICAL_RESET_MODE=full-sweep`, and only on a device you own. Run
`node deploy/verify-physical.mjs` first — it prints exactly what would be cleared on that handset
and clears nothing.

**Installing over an app the device already has is refused**, because a release could not undo it:
uninstalling would take the owner's copy and their data, and there is no version to put back. The
refusal needs `aapt2` from the SDK build-tools to read the APK's package name before installing —
without it the agent can only report the overwrite afterwards, and says so at startup. Fix with
`./deploy/install-build-tools.sh`.

**What `install-reset` does not promise.** An app the owner already had, which a session drove,
keeps whatever state that session left in it — and the next session in the same org can see it.
That is the irreducible property of borrowing somebody's phone; the only alternative is wiping
their apps. Anyone sharing a personal device should be told this.

Neither mode ever factory-resets — §17 forbids it, and the agent could not re-authorize adb
afterwards anyway.

Both are **weaker than a snapshot restore, and the difference is deliberate.** Clearing app data
leaves accounts, keychain items, clipboard contents, WebView caches and granted permissions behind.
So a physical device declares `session-reset` or `install-reset`, never `snapshot-reset`, and:

> **A physical device is pinned to the org that enrolled its host, and never enters the shared
> pool.** That is what makes the weaker reset safe: the next tenant is the same tenant.

This is enforced by construction, not by policy — the host carries `org_id`, devices inherit it at
registration, and `allocate_device` has always filtered on it.

Packages never cleared or uninstalled, whatever you configure — in either mode:
`io.appium.settings`, `io.appium.uiautomator2.server`, `io.appium.uiautomator2.server.test`,
`com.android.shell`. Removing those leaves a phone that enrols, schedules, and fails every session
it is given.

Add your own with `PHYSICAL_KEEP_PACKAGES` (comma-separated) — a corporate VPN client, an MDM agent,
a test-account helper. It matters most in `full-sweep`; in the default mode the ledger is already
the whole blast radius.

**A failed reset takes the device out of the pool.** That is the safety property: if cleanup could
not finish, the next session must not get the device.

## 6a. Play Protect will refuse your APK, and what to do about it

On a stock Android phone **every `adb install` is refused**. Play Protect vets APKs pushed over USB
and rejects debug-signed builds — which includes Appium's own automation helpers, so the device
cannot run a session at all, not merely your app. On the phone it reads *"Harmful app blocked"*; in
the farm it used to surface as `upstream_rejected` after a 60-second adb timeout, several hops from
the cause.

Three things happen now:

1. **It is read at start-up**, once, per phone — one `adb shell settings get`. You are told before a
   session needs it rather than 60 seconds into your first test.
2. **A refusal is a farm fault, not a test failure.** It is classified `install-blocked` (§18) with
   the remedy attached, so a suite is never blamed for it.
3. **The window offers the fix, and the button is the consent.** `verifier_verify_adb_installs 0`
   is the standard device-farm answer and it is a security setting on somebody's own phone, so the
   agent proposes and the owner disposes. It is captured before it is changed and **put back exactly
   as it was found when the agent stops** — including deleting the row again if it was never set.

`PHYSICAL_ALLOW_INSTALL_VERIFICATION_OFF=1` does the same thing without a person, for a dedicated
farm phone provisioned from a script. It is the wrong shape for a borrowed handset — it asks
somebody to decide about a phone before they have seen it — which is why the window exists.

The third option is neither: tap through the prompt on the device itself each time.

## 7. Running tests against a phone

Exactly as against a virtual device — that is the whole point of one abstraction (§32). The device
declares `webdriver` when a supervised Appium answers for it, and the hub allocates it like anything
else:

```bash
MFARM_API_KEY=mfk_... node deploy/verify-webdriver.mjs
```

To pin a suite to real devices, ask for the tier:

```json
{ "platformName": "Android", "mfarm:region": "lab", "mfarm:tier": "physical" }
```

## 8. When something goes wrong, who gets blamed

An ADB drop, a dead Appium, a flat battery or a full disk are **not** test failures, and MFARM does
not report them as any (spec §18). The agent watches every device and records what it saw as an
*incident* against the session; the run detail shows these on their own card, "What the farm saw",
beside the failures your suite reported.

The two are deliberately never merged. A test can genuinely fail its assertion during a session that
also had a cable glitch, so relabelling it would hide a real defect. You see both and decide.

Your suite can classify its own failures too, which is the half only it can know:

```js
await fetch(`${MFARM}/v1/sessions/${sessionId}/result`, {
  method: 'POST',
  headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'checkout applies a promo',
    status: 'failed',
    failure: String(err?.stack ?? err),
    failureReason: 'application-crash',   // or 'assertion-failure'
  }),
});
```

Omitting `failureReason` is fine and means *unclassified* — never "the app's fault".

## 9. Known limitations

- **No live view or interactive control.** §20/§21 are unbuilt for this tier. Screenshots and the
  UI inspector work; a moving picture does not.
- **No Windows agent.**
- **Input latency over USB is ~33-55ms p50.** Measured 2026-08-25 on a Samsung SM-S918B (Android
  16): 33ms p50 / 55ms p95 over 100 key events, well inside the 100ms budget `health()` degrades at.

  Getting that number required fixing what `health()` was timing. It ran `true` down the held shell
  and reported the result as `inputLatencyMs` — that is **1ms p50**, because it measures how fast
  the shell echoes a marker, not how fast an input event lands. The real path costs 20-50× more,
  nearly all of it spawning Android's `input` binary. The budget was therefore unreachable: no
  device could be slow enough to trip a threshold applied to a shell round trip. It now times
  `input keyevent 0` (`KEYCODE_UNKNOWN`), which travels the whole path and does nothing on arrival.
- **`dumpLogcat` is not session-scoped.** A phone's log buffer carries lines from before the
  session — unlike a powerwashed Cuttlefish, whose buffer starts empty. Read timestamps with that
  in mind.
- **Adding a phone restarts the agent.** It drains first, so nothing in flight is lost, but a host
  serving other devices does bounce. Adding a device in place needs the heartbeat to carry
  capabilities, which the protocol does not do yet.
- **Input latency is reported but not yet enforced.** Nothing refuses a device for being slow.
- **Nothing checks the §1 prerequisites.** "Stay awake" and an unlocked screen are asked of a human
  in §1 and then confirmed by no code anywhere. A locked, dozing handset enrolls, schedules, and
  fails everything — and §18 files those as test failures, because nothing knows better. On the
  first handset this was run against, three capture runs reported 2.2 fps, a single keyframe and
  0.01 Mbps, and all three were measurements of an always-on-display clock rather than of anything
  in the agent. `deploy/verify-physical.mjs` reports all three states; the agent still does not.
  This is what the phase-1 window in [AGENT_BUILD_PLAN.md](AGENT_BUILD_PLAN.md) exists to show.

---

## 10. Verifying a handset before you enroll it

`deploy/verify-physical.mjs` runs the physical backend against a phone **without clearing
anything** — it exists because the honest way to test §6 is to run it, and running it on somebody's
daily driver wipes 133 applications:

```bash
node deploy/verify-physical.mjs              # first device adb sees
node deploy/verify-physical.mjs --all        # list every package a reset would clear
```

It reports the reset's blast radius with the launcher, keyboard, device-admin and accessibility
packages called out by name; whether a failed `pm clear` is actually detected; held-shell latency;
and each read path with the OEM output its regex has to survive. Read it before `PHYSICAL_ENABLED=1`
on a machine whose phone you care about.
