# Defects

**How defects are found, recorded and closed here.** One of three documents:
[`STATUS.md`](STATUS.md) is where things stand, [`DIRECTION.md`](DIRECTION.md) is why they are that
way, and this is what is wrong with them.

## The rule

A defect leaves this file when it is **fixed AND verified on the deployed farm** — not when a patch
is written and not when CI is green. Twice this month a fix was reasoned, unit-tested, merged and
completely inert; only a watched boot and a real click said so.

## Where they come from

**All twenty-five entries were found by USING the product. None came from the test suite.** That is
not a complaint about the suite — 1441 tests catch different things, and they caught two security
regressions and a 500 this month. It is the reason an exploratory pass is part of the work rather
than a nicety: clicking every control on a real farm, with console exceptions and failed requests
instrumented, finds things no fixture can.

The `FOUND` column records how each one surfaced, because that is the reusable half.


One row per thing that is wrong or missing.

**Severity** is about what it costs a person, not how hard it is to fix:

| | meaning |
|---|---|
| **S1** | wrong information a person would act on, or a control that does the wrong thing |
| **S2** | a capability that is missing or unreachable, with no workaround on the page |
| **S3** | the console is right but says it badly, or the design specifies something not built |
| **S4** | cosmetic |

`FOUND` says how, because that is the part that tends to be reusable.

---

## Open

**Nothing, as of 2026-09-07** — twenty-six recorded, twenty-six closed. D26 is below and is the
most interesting entry this file has: it is the first defect the SUITE could not have found *by
construction*, and the reason is worth reading before writing another fixture.

### D26 — the run screen's Failures card had never rendered

| | |
|---|---|
| **Severity** | **S2** — a capability that is missing, with no workaround on the page |
| **Found** | reading `loadRunDetail` while building the execution timeline |
| **Closed** | 2026-09-07, PR for `EXECUTION_ROADMAP.md` S4 |

`GET /v1/runs/:id` has returned `failures` and `incidents` since they were built.
`loadRunDetail` spread `run` and `sessions` and dropped both, so `d.failures?.length` was
`undefined?.length` on every run anybody has ever opened. The **Failures** card — whose own comment
in `console.js` calls it *"the whole payoff of runs plus outcomes"* — and the **"What the farm saw"**
card have never appeared. The optional chaining is what made it silent: the cards did not throw,
they simply were not there, and the screen looked finished.

**Why 229 console-screen tests were green through all of it.** `console-screens.test.ts` seeds
`failures` *directly into `state.runDetail`*. A fixture that supplies what the loader is supposed to
supply cannot see the loader failing to supply it. Every assertion about that card was true, and
true about a code path no user ever reached.

That is the sixth defect of this shape in the register (see *"Controls on a false premise"*), and
the first where the blind spot is structural rather than incidental. **The lesson to carry: a test
that seeds state tests the renderer, never the loader.** The fix ships with a test that drives
`loadRunDetail` against a stubbed `fetch` and asserts on what lands in state — verified by
reverting the loader and watching it go red.

That is a statement about this list, not about the console. Every entry here was found by USING the
thing: clicking every control, reading every sentence on a real farm, watching a real device arrive.
Not one came from the test suite, which was green throughout. An empty register means the last pass
found everything it found — the next hour of use is what says whether it is empty.

One thing is deliberately not on this list because it is not a defect: **the farm's SM-S918B row is
still nine days stale**, and it corrects itself the moment a current agent registers that phone.
`npx @mfarm/agent` on the machine it is plugged into, and nothing else.

| # | Sev | Area | What | Found |
|---|---|---|---|---|

## Fixed, awaiting verification on the farm

| # | Sev | What | How it was found |
|---|---|---|---|
| D2 | S3 | "Screen: not reported" read as a fact about the device when it was a fact about the FARM — the row had not been written since its host stopped beating on 2026-08-29. `GET /v1/devices` now carries `hostLastSeenAt` (a system-pool read keyed to what RLS already allowed, never a join — migration 002 revokes `hosts` from `mfarm_app`), and a blank geometry says "last heard from this device 9d ago" where the host is silent, and stays a bare "not reported" where it is beating. **The stated cause was always false** — see the note below. The handset's own row corrects itself the moment a current agent registers it: `npx @mfarm/agent` on that machine, nothing else. | farm screenshot |
| D18 | **S2** | Nothing reported the gap between a released commit and a deployed one. `deploy/check-deployed.sh` answers "is this farm running main?" for the image, the control plane's checkout and the device host's — and `verify-live.sh`, the script already run after every `instances start`, now asks it too. `unknown` never scores as up to date, which is the assertion that matters: a check that goes green on a farm it could not reach is worse than no check. | reading the running image |
| D19 | S3 | Both checkouts drifted silently — `mfarm-cp` on a detached HEAD, `mfarm-lab` 66 commits behind on the tree the worker and boot unit both `ExecStart` from. Same check, and the device host's line is labelled "worker runs this" because that is the drift which changes what the DEVICES do. A stopped lab is reported as stopped, never as up to date. | starting the lab |
| D20 | S4 | `mfarm-farm.service` lived only on the VM, which is how it came to declare `CF_INSTANCES=2` on a host running four devices — inert since the device-host guard, and contradicted by the fleet. The unit is `deploy/mfarm-farm.service` now, installed by `deploy/install-farm-service.sh`, with no `CF_INSTANCES` at all: how many devices a host runs is the worker's business and lives in `deploy/.state/worker.env`. | reading the unit while verifying D13 |
| D5 | S3 | Fleet rows carried a `Details` button beside a device name that links to the same page — two controls, one destination, on every in-use row. The name is the only link now. | clicking every control |
| D6 | S3 | The Apps empty state offered "Go to Devices" pointing at `#/devices`. The route redirects so it worked, but the surface has been called Fleet since the IA change. | clicking every control |
| D7 | **S2** | "Find machine" with an empty code field returned silently — no error, no hint, nothing moved. Pressing the button before filling the field is the first thing a person does, and no test covers it. | clicking every control |
| D14 | **S2** | Pressing **Start** went straight to the cockpit, so the six-beat choreography played only from `#/launch` or when a request queued — on a warm farm nobody ever saw the device arrive. Start now routes through the bring-up screen, which hands over on its own once the socket has settled. | pressing Start on the lab |
| D8 | **S2** | A person in more than one org could not tell which they were in. `/v1/auth/me` now returns every membership and the header names the org — with "1 of N orgs" where there are several. A switcher still needs a re-mint endpoint; signing out and back in is the way for now. | exploratory session |

**CORRECTED 2026-09-05.** This paragraph used to read "the other three are in the deployed build".
They were not. The farm ran `886cb47` until 13:08 today, so **D6, D7 and D12 were deployed** (they
came in `f632e86`, under PR #101) and **D14 and D8 were not** — they merged as PR #102 at 11:28,
released at 11:34, and then sat in the registry for ninety minutes while the farm went on serving
the previous image. "Merged" and "released" had been read as "deployed"; nothing in the chain says
so. See D18. All five are on the farm now, at `c5f0af5`.

**D5 is verified on the farm by eye** — the live Fleet at `886cb47` showed one button per row. The
rest are in the deployed build and covered by the suite, not yet confirmed by eye.

**The seven UI defects are closed and were watched on the deployed farm at `45683f9`** — signed in
to `https://farm.mfarm.dev` in a real browser, build badge asserted on every capture so a cached
bundle could not pass for a fix. The bring-up ones needed a live worker: "With a build…" was pressed
for real, which allocated an MFARM X1, queued a build, and installed it.

They are also covered by twenty tests that render the screen and read the tree, each checked against
a negative control: reverted to the previous console, 16 of the 20 fail. The four that pass either
way are the "must not offer" guards — an empty library, a busy row, a host-sourced quarantine, a
member without the admin route — which are absence assertions and correctly hold in both
directions.

### FIXED — the agent no longer restarts to withdraw a capability (ADR-0027)

The outage underneath migration 038 is gone, and the fix was almost entirely deletion.

**The protocol change ADR-0003 called "not yet made" shipped on 2026-09-01.** `POST /workers/heartbeat`
reconciles the per-device automation map the agent had always been sending: an endpoint that
disappears strips `webdriver` from that device, one that appears puts it back, host-scoped, never
touching `state`. `http.test.ts` has covered all of it since.

**Nothing removed the drain it replaced, and the comment justifying it outlived the constraint by
five days.** `index.ts` went on saying "capabilities are written at registration only… That needs
the heartbeat to carry capabilities." It carried them already. So one device's Appium exiting still
drained and exited the whole agent — every backend stopped, all four devices cold-booted, thirteen
minutes — and that is what produced the escalation 038 now guards against.

`onHealth` withdraws in place and stops there; there is no grace window, because a window was only
ever a hedge against the cost of withdrawing and that cost is now one field in a beat already being
sent. A permanent Appium failure does not drain either: the device keeps install, launch, logcat,
screenshot and the live view, none of which need Appium. **A device ARRIVING still re-registers** —
the heartbeat reconciles devices it knows and cannot create one.

`agent.test.ts` gains the end-to-end assertion the deletion rests on: withdraw an endpoint at
runtime, and the next beat strips `webdriver` from that device only, leaves the sibling advertised,
leaves the device READY, and restores it on a later beat.

### FIXED — a silent host no longer burns a device's reset budget (migration 038)

`count_stalled_resets` counted an attempt against any CLEANING device past the timeout, with no
check that its host was there to be offered one. Migration 038 adds that check: the host must have
beaten inside the same window the reset is judged over.

**The two mechanisms were both firing on one outage, and only one of them heals.** A silence
quarantine is undone by the next heartbeat — the evidence for it is falsifiable, which is migration
016's whole point. A reset escalation is deliberately terminal and waits for a human. Letting a host
outage produce the non-self-healing one meant every agent restart permanently cost a device.

It does NOT make the budget forgiving: a host that is beating and failing to reset burns its budget
exactly as before, which is the case 032 was written for. Three tests, including the contrast.

**Still open underneath it:** the agent drains and EXITS to withdraw a capability, which stops every
backend on the host and cold-boots all of them — thirteen minutes of no resets because one device's
Appium stopped. 038 stops that costing a device permanently; it does not stop the outage. Withdrawal
in place needs a protocol change (`POST /workers/heartbeat` ignores its body, and only `register`
writes capabilities — ADR-0003 decision 3).

### How it was found: cf-4's reset escalated whenever Appium restarted

Found while exploring, and the more serious finding of the session. **MFARM X1 (`cf-4`) burned two
full reset budgets in thirty minutes** — timed out at 19:56 and 20:00, escalated at 20:03, having
already escalated at 19:34.

The worker log gives the cause. At `19:51:23` Appium for cf-4 exited after 759s; the agent logged
`incident on cf-4: appium-failure`, began `restart 1/5` and announced *"Withdrawing by draining in
60000ms unless it recovers first."* **No `resetting cf-4` line appears anywhere in that window** —
so the control plane offered a reset three times, the worker never carried it out, and migration
032's budget did exactly what it is designed to do to a device that will not reset.

The two recovery mechanisms are fighting: the agent withdraws a device because its AUTOMATION server
is unhealthy, and the control plane escalates it because its RESET did not happen. A reset is a
`cvd`/adb operation and has nothing to do with Appium — a device that cannot take a WebDriver
session can still be restored to a clean snapshot, and should be.

The visible consequence is D21: the device leaves the pool, the console shows RESTORING forever, and
only `curl` gets it back.

---

### What D1 caught on its first day

The X1 read **"reset gave up 12m ago"** in red while its state pill said `RESTORING`. That was real:
a session left un-released when the lab was stopped mid-reset had exhausted its budget (migration
032). The pill said the device was busy restoring; only the new line said the restore had given up
twelve minutes earlier. Cleared with `clear-reset-escalation`, and the device came back READY within
80 seconds — which is exactly the gap between "not allocatable" and "not allocatable and nobody is
coming", and the reason the design puts an outcome on this row.

---

### D2 is the one that was not a defect — and what was fixed instead

Recorded as "the worker registers no `screen` for real devices". It does, and has since twelve days
before the note was written. Three hops were read and all three carry it — `discovery.ts` reads the
panel, `physical.ts` supplies a fallback so the field is never empty, `agent.ts` sends
`info.screen` for every tier — and the API's upsert stores it with `screen = EXCLUDED.screen`. The
live proof is on the farm: both Cuttlefish devices report geometry through that same line.

`apps/api/test/device-health-fields.test.ts` now registers a handset with a panel through the real
route and asserts it comes back out of the tenant list. **That test passes against unmodified
code**, which is the point — it is the guard that was missing, not a fix.

What is actually true: the handset's row has not been written since `2026-08-29 01:32`, because its
host last beat at `01:30` that morning. `SELECT last_heartbeat_at` said so in one query, and nothing
in the console contradicts it — device detail already shows "Host last seen". The row is eight days
stale and will correct itself the moment a current agent registers that phone.

---

## Closed

| # | Sev | What | Fixed in |
|---|---|---|---|
| D21 | **S2** | An escalated device was invisible and unrecoverable in the console. Device detail carries its own amber panel and an admin-gated **Resume recovery**; the Fleet row stops claiming a restore is in progress. **Watched on the farm at `1eba6c6`**: escalation induced on `523581b7`, the row read "its reset gave up · 12m ago — open it to resume", the panel explained why it still reads CLEANING, the dialog authorised **Queue a reset**, the escalation cleared and the device was READY again. | exploratory session |
| D22 | **S2** | The Live lens listed 50 ENDED sessions under a badge counting only live ones. `liveSessions()` feeds both now. **Watched on the farm**: 0 rows and "No sessions", where it listed 50. | exploratory session |
| D23 | **S2** | The log defaulted to a scope matching 0 of 270 lines. **Watched on the farm**: 600 lines rendered by default on a fresh session, where the pane was empty. | exploratory session |
| D24 | S3 | Releasing left a live 14-button rail on screen for ~7–12s. **Re-measured on the farm**: `mode=ended`, rail 0, at **t+2s**. | exploratory session |
| D25 | S4 | "after 7 seconds" beside "00:06 held for". Both floor now. Seen on the farm as "after 1 minute" beside "01:01 held for". | exploratory session |
| D1 | S3 | Health showed a state pill and nothing else per device. `GET /v1/devices` carries `lastResetAt` now and each row says what the farm last confirmed and when. **Watched on the farm at `0141e8e`**: "reset gave up 12m ago" in red on an X1 whose pill said RESTORING, "reset confirmed 6h ago" on the X1 Pro, "reset confirmed 9d ago" on the handset. Deliberately NOT the `device_reset_attempts` join this file proposed — that table holds only timed-out and escalated resets, so a healthy device has no rows and the join would have said "nothing recorded" for most of the fleet. | design comparison |
| D4 | S3 | The Fleet headline never gave an ETA. **Watched on the farm at `0141e8e`** with the farm full and one session queued: *"Every device is in use. One person is waiting — the next Unprofiled device frees in at most 25 minutes."* "At most" rather than document 03's "about", because `expiresAt` is an upper bound — a holder can release early, and somebody ahead takes the device first — and the bound is what the data supports. | design comparison |
| D3 | **S2** | No Fleet row could preinstall a build before handover. `startSession` carries one now; "With a build…" is on the fleet row, the catalogue card and device detail. **Watched end to end on the farm**: the dialog allocated an MFARM X1, queued Alaan staging, and the worker confirmed the install. | `45683f9` |
| D9 | S3 | Health named a device whose check had failed and gave no way to reach it. The name is the same `fleet-open` control the Fleet uses, and `Recover` appears on a quarantined device an admin can actually recover. **Seen on the farm**: `Recover` on the quarantined SM-S918B, absent everywhere else. | `45683f9` |
| D10 | S3 | The stage kept full height on an ENDED session. **Seen on the farm**: the frame is small, dim and flat on the left, with `01:23 held for / 2 actions / 2 artifacts / snapshot reset` beside it and the release sentence leading — all above the fold. | `45683f9` |
| D11 | S3 | The device rail rendered every control, disabled. **Seen on the farm**: no rail at all on the ended session; Tools says "This session has ended. Nothing can be sent to the device." | `45683f9` |
| D12 | **S1** | A session's length rendered as `mm:ss`. **Now confirmed by eye** on the farm for the first time: "ran 1 minute", "Released by you at 18:51, after 1 minute". | `f632e86`, seen at `45683f9` |
| D15 | S4 | The tile was anchored to the stage, so on a tall screen it overlapped the bezel. **Watched at 1500×1500 — the failing case**: it waits clearly above the frame while queued, and lands inside the screen, green, when the worker confirms. | `45683f9` |
| D16 | S4 | A queued step's mark was a spinning purple ring on the two beats a worker answers for. **Seen on the farm**: "Installing Alaan staging" carries an amber ring while "Device ready" above it keeps the purple one, and "Opening …" turns amber when it becomes the beat being waited on. | `45683f9` |
| D17 | S4 | Two unprofiled devices rendered as identical rows. **Seen on the farm**: `523581b7` and `861fb15a` carry boxed, readable ids while MFARM X1, X1 Pro and SM-S918B keep the quiet caption. | `45683f9` |
| D13 | **S2** | The device host's boot unit failed on every boot from 3 September, exiting in one second on "BACKUP_BUCKET is empty" — a control-plane backup policy a machine with no database has no business having an opinion about. **It took two fixes.** The first (PR #103) added the right guard reading the right variable out of the *wrong file*: `farm-up.sh` sources `deploy/.env`, which has never held `CONTROL_PLANE_URL` — `install-worker-service.sh` writes it to `deploy/.state/worker.env`, the worker unit's `EnvironmentFile`. So the guard could not fire, and the unit went on failing identically. The second moves the decision into `deploy/lib/host-role.sh` as a function whose inputs are arguments, so it can be executed in a test. | `aec22ad` (did not work), `dc7299c` (works) |

---

## Verified working on real hardware, 2026-09-05

Lab started for 14 minutes at `886cb47`. Everything below was watched, not inferred:

- **A live Cuttlefish device streams into the frame** at 1080×2340, 50 fps, 2518 kbit/s, 35ms round
  trip, direct path. The punch-hole sits over the device's own reserved status-bar region, so the
  one element allowed over the panel is telling the truth.
- **The six beats track real events.** A full Launch — pick a device, pick a build, Start — ran
  through acquire → ready → attach → stream → install → open, with the install confirmed by the
  worker in about 8 seconds, and the beat cleared correctly on handover to the cockpit.
- **The build's tile waits outside the frame** while the install is queued, which is document 04's
  own fallback for having no byte progress.
- **Release works end to end**: three sessions released, devices moved to CLEANING and came back
  READY on their own.
- **Allocation by class holds on real devices** — asked for `mfarm-x1`, got an X1; asked for the
  unprofiled class, got an unprofiled device; a caller naming no class was unaffected. 4/4.
- **`verify-console.sh` 63/63** and **`verify-device-detail.mjs` 7/7** against the live console.

**No exceptions and no failed requests** across the whole session — the launch flow, the cockpit,
and the release path were all instrumented for both.

---

## Watched on hardware, 2026-09-05 (second lab window)

Started to settle D13, which had been recorded as "reasoned and unit-tested, not watched boot". The
boot was the point: **the fix did not work, and only the boot said so.**

- **The bug reproduced on the VM at `c5f0af5`** — `mfarm-farm.service` failed 13:11:42 → 13:11:43,
  `status=1/FAILURE`, on the shipped fix. Same one-second exit as before it.
- **The cause**: the guard read `CONTROL_PLANE_URL` after sourcing `deploy/.env`; the lab's
  `deploy/.env` has no such key (its real keys are Postgres, backup, port and Grafana settings) and
  the value lives in `deploy/.state/worker.env` — `CONTROL_PLANE_URL=https://34-100-138-213.sslip.io`.
- **The test could not have caught it.** It asserted the guard's line number was below the
  `. "$ENV_FILE"` line. That is a true statement about the text of the script and says nothing about
  whether the variable is in the file. Guard and test were wrong in the same direction.
- **After `dc7299c`: `active (exited)`, `status=0/SUCCESS`** at 13:22:09, printing
  `==> Device host / this machine has /dev/kvm, and a control plane at … that is not here`. First
  clean boot of that unit since 3 September.
- **The farm came back around it**: `verify-live.sh` reports the control plane at `c5f0af5`, public
  HTTPS on `farm.mfarm.dev`, **3 devices READY** declaring screen-stream, coturn answering.
- **`verify-console.sh` 62/62** against the live console.
- **The fleet is four devices, not two.** `CF_INSTANCES=4` with
  `CF_PROFILES=cf-3=mfarm-x1-pro,cf-4=mfarm-x1`, and all four came back READY on their own. The
  count read 3 mid-window and 4 at the end, which was a cold boot finishing rather than a leak —
  checked against `adb devices` on the host (`6520`–`6523`), not inferred from the API. The boot
  unit still says two; see D20.

One thing the new lib is deliberately built to survive: it rejects a loopback control plane **by
value**, not by the absence of `worker.env`. Relying on a file's absence is the shape of reasoning
that produced the first fix.

Not checked in this window: D14, D8 and D12 by eye. They reached the farm at 13:08 today and are
covered by the suite only.

---

## Suite health

The order-dependent `attempts.test.ts` flake is **fixed** — it was a real billing bug (the usage
window bounded by the API server's clock rather than the database's), not test ordering.

One unidentified failure in five full runs on 2026-09-05, name not captured, three clean runs after
it. Recorded rather than called resolved: an intermittent failure nobody has seen twice is not the
same as one that has gone. A sixth full run, later the same day on `dc7299c`, was clean — which
raises the clean count and settles nothing, for the same reason.
