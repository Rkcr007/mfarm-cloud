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

## 3. Enrolling the host

The host needs a credential. **Do not paste the fleet secret into a laptop** — it never expires,
names nobody, and revoking it revokes every machine. Mint a single-use enrollment token instead
(admin only; there is no console screen for this yet, so it is the API):

```bash
curl -X POST https://<farm>/v1/account/agent-enrollments \
  -H "Authorization: Bearer <admin-api-key>" \
  -H 'content-type: application/json' \
  -d '{"label":"Ravi laptop","ttlHours":24}'
```

`ttlHours` defaults to 24 and caps at 168. The plaintext comes back **exactly once**, as
`plaintextShownOnce`, and begins `mae_`. It is single-use, expiring, revocable, and scoped to your
org — and the host it enrolls carries that org, which is what keeps its phones out of the shared
pool (see §6). Revoke an unused one with
`DELETE /v1/account/agent-enrollments/<prefix>`.

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

| adb state | What it means | What the log tells you to do |
|---|---|---|
| `device` | usable | — (it enrolls) |
| `unauthorized` | nobody tapped Allow | Unlock the phone and tap "Allow USB debugging" |
| `offline` | adb sees it, cannot talk to it | Replug; try a different cable before anything else |
| `no permissions` | host udev rules | Install vendor udev rules and re-plug, or join `plugdev` |

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

## 6. What a reset does, and does not, do (spec §17)

Between sessions the agent runs a **package-level cleanup**: `pm clear` on every third-party
package, minus a keep list, then HOME. It never factory-resets — §17 forbids it, and the agent could
not re-authorize adb afterwards anyway.

This is **weaker than a snapshot restore, and the difference is deliberate.** Clearing app data
leaves accounts, keychain items, clipboard contents, WebView caches and granted permissions behind.
So a physical device declares `session-reset`, never `snapshot-reset`, and:

> **A physical device is pinned to the org that enrolled its host, and never enters the shared
> pool.** That is what makes the weaker reset safe: the next tenant is the same tenant.

This is enforced by construction, not by policy — the host carries `org_id`, devices inherit it at
registration, and `allocate_device` has always filtered on it.

Packages never cleared, whatever you configure: `io.appium.settings`,
`io.appium.uiautomator2.server`, `io.appium.uiautomator2.server.test`, `com.android.shell`.
Clearing those breaks the phone's ability to run anything.

Add your own with `PHYSICAL_KEEP_PACKAGES` (comma-separated) — a corporate VPN client, an MDM agent,
a test-account helper.

**A failed reset takes the device out of the pool.** That is the safety property: if cleanup could
not finish, the next session must not get the device.

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
- **Input latency is unmeasured over USB.** The held-shell path measures ~39ms p50 on an emulator;
  nobody has measured it on a handset. `health()` reports it, so the first real phone will say.
- **`dumpLogcat` is not session-scoped.** A phone's log buffer carries lines from before the
  session — unlike a powerwashed Cuttlefish, whose buffer starts empty. Read timestamps with that
  in mind.
- **Adding a phone restarts the agent.** It drains first, so nothing in flight is lost, but a host
  serving other devices does bounce. Adding a device in place needs the heartbeat to carry
  capabilities, which the protocol does not do yet.
- **Input latency is reported but not yet enforced.** Nothing refuses a device for being slow.
