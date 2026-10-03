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

**Two, as of 2026-09-12** — forty-eight recorded, forty-six closed. The two left are the CSP
`webrtc` warning, which is deliberate, and app network capture, which is an unbuilt feature needing
its own privacy decision rather than a defect. The four below are named at the
bottom of this section under *Known and not fixed*; none blocks use, and each says why it is still
here rather than being quietly absent.

An exploratory pass over the whole console on 2026-09-08 — every screen, every control, the layout
measured rather than eyeballed — produced D31 to D34. **Two things it did NOT find are worth
recording too**, because both look like defects and are not: the sign-in screen's controls remain in
the DOM after login (all `display:none`, verified genuinely inert by calling `focus()` and checking
`document.activeElement`, so they are out of the tab order), and the Apps screen's disabled
**Install** buttons are correct when no `app-install` device is free. A predicate that reports either
as a defect is a bad predicate — the first draft of the audit had one.

### D34 — a new screen kept the previous screen's scroll position

| | |
|---|---|
| **Severity** | S3 — the screen is right and shows the wrong part of itself |
| **Found** | reasoning about D31's fix before shipping it, then confirmed in the browser |
| **Closed** | 2026-09-08, in the same series as D31 |

Introduced BY D31's fix and caught with it. While the document scrolled, the browser reset the
position on every hash change for free. Once `.main` became the scroller that stopped happening, so
opening a session from the bottom of a long Runs list showed the session's middle. `scrollTop = 0`
on navigation, not a smooth scroll: this is a navigation rather than a movement within a page, and
animating it makes the new screen appear to slide out from under the old one.

### D33 — the release dialog apologised for evidence it now captures

| | |
|---|---|
| **Severity** | S3 — the console is right and says it badly |
| **Found** | reading the dialog while adding the delete controls |
| **Closed** | 2026-09-08 |

`askRelease` promised *"The action log for this session stays available"* under a comment reading
*"The design's reassurance names screenshots, video and logcat. None of those are captured anywhere
in this system, so promising they survive would be a comforting lie."*

True the day it was written. False since the artifact store (019), the on-demand captures (022, 040)
and video (045). The dialog was apologising for not having the evidence that is now the main reason
to press the button. Another entry for *"Comments as rumour"* — the fourth.

### D32 — deleting a session's evidence freed the rows and not the bytes

| | |
|---|---|
| **Severity** | **S2** — silent, unbounded disk growth with nothing to collect it |
| **Found** | on the farm, minutes after deploying it: `{"deleted":3,"blobsDeleted":0}` |
| **Closed** | 2026-09-08, migration 047 |

A PROPERTY OF POSTGRES RATHER THAN A TYPO. Migration 046 wrote the function as one statement —
`WITH gone AS (DELETE ... RETURNING sha256) SELECT ..., NOT EXISTS (SELECT 1 FROM artifacts ...)` —
and **a data-modifying CTE's effects are not visible to other parts of the same query**. Every
sub-statement reads the snapshot taken before it ran, so the `EXISTS` found the very rows the CTE
was deleting and reported every blob as still referenced. Rows went; a 268 KB recording nothing else
referenced stayed; nothing would ever have come back for it.

`delete_artifact` was never affected — it deletes as its own statement and asks afterwards, which is
the shape 047 adopts.

**The test agreed with the bug.** It asserted the row count and not the blob count. That is this
register's most expensive recurring shape, and it is why the fix ships with `blobsDeleted` asserted
and verified by restoring the 046 form and watching it go red. Three blobs stranded on the farm by
the live bug were identified by diffing digests on disk against the table (261 rows, 264 files) and
removed; no row was left without a file, so nothing was broken by it.

### D31 — the nav and the top bar scrolled away

| | |
|---|---|
| **Severity** | **S2** — a capability that is unreachable, with no workaround on the page |
| **Found** | measuring the deployed console rather than looking at it |
| **Closed** | 2026-09-08 |

`.shell` was `min-height: 100%`, so the DOCUMENT was the scroll container and the sidebar and farm
status bar scrolled off with the content. Measured: the session screen is **2695px against an 813px
viewport**, and five of nine screens scrolled the document. A person reading the log or the steps
had scrolled 1900px and no longer had Fleet, Runs, Health or the "0 of 5 ready" line anywhere on
screen — on the one screen where *"is the farm even up?"* is the next question they will ask.

`height: 100dvh` on the shell and `overflow-y: auto` on `.main`, so the content pane is the only
vertical scroller and the chrome stays put. Verified after deploying: `docScrolls=false` on every
screen, and the sidebar's bottom edge sits exactly at the viewport height while the pane scrolls
1629px beneath it.

**It also made a piece of polish possible that was not before**: the top bar's hairline strengthens
once content passes under it, which is the cue every native application uses. Deliberately a
hairline and not a shadow — `design-tokens.css` reserves depth for the device and says so.

### Known and not fixed

| what | why it is still here |
|---|---|
| `Unrecognized Content-Security-Policy directive 'webrtc'` on every page load | Chrome does not implement CSP3's `webrtc` directive. ADR-0007 sets it deliberately; it changes nothing and costs one console warning. Removing it would lose the statement of intent, keeping it costs noise in the place a developer looks for problems. |
| ~~`mfarm-deploy.sh` reported failure on a deploy that succeeded~~ | **FIXED 2026-09-11.** The restart is no longer fatal: a name conflict clears the stale container and retries once, and **whatever happens the script continues to its verification step**, which is the only part that decides whether a deploy happened. Reporting failure on a working deploy teaches people to ignore the failure. The message parse lives in `lib/restart-conflict.sh` with its own tests, including that a busy PORT is not a container to remove. |
| No app network traffic anywhere | `network-capture` is a capability NAME in `protocol.ts` with no implementation. The Steps table is the WebDriver command trace, not what the app under test requested. A per-session proxy is real work and needs its own privacy decision (ADR-0029 stores no bodies). |
| ~~The Steps table does not collapse repeated successful commands~~ | **FIXED 2026-09-11.** Runs of three or more identical consecutive commands fold into one row that opens on click. **A slow step never folds** — surfacing a nine-second click is what the threshold is for. The card's count stays the real number and states rows-hidden separately: a table reading "1 step" when the suite made nine would be worse than the noise. |


**This section read "nothing, twenty-eight closed" for about four hours and was wrong the whole
time.** S5 shipped that afternoon and brought two defects with it: D29, found five minutes after
turning the feature on, and D30, found by reading the code that had just been merged and deployed.
Neither came from the suite. The lesson is the one this file keeps re-learning from the other
direction — **an empty register means the last pass found everything it found**, and shipping a
feature is itself a pass nobody has run yet.

### D30 — the recorder could outlive every path that stops it

| | |
|---|---|
| **Severity** | **S2** — an encoder that runs forever, and unreferenced files filling the device host |
| **Found** | reading the code four hours after it was merged and deployed, while listing open defects |
| **Closed** | 2026-09-07 |

`stopRecording` had exactly one caller, `captureArtifacts`, on the ordinary release path — and
ADR-0032 *leaned on that*, arguing there is no `video-stop` verb **because** the teardown "runs on
every path a session can end". That sentence is true of the paths a SESSION takes and false of the
paths an AGENT takes. Three of the latter:

* **an agent restarted mid-session.** The handle to the running recorder is an in-memory field, so
  the new process knows neither that a recorder is running nor which file is its. It encodes until
  the host reboots.
* **a quarantine recovery.** `release_device_quarantine` bumps the fence, so no session row matches
  and that branch skips `captureArtifacts` deliberately — there is nothing of a tenant's to collect.
  It skipped the recorder with it, and a recorder is not evidence to collect: it is a process.
* **an upload that failed.** The `unlink` was after the POST and only after it, so a control plane
  restarting, a 409, or a recording over `ARTIFACT_MAX_UPLOAD_BYTES` left a file that no artifact row
  names — invisible to every other cleanup in the system.

**The fix is a reconciliation rather than three more callers.** `reconcileRecordings(maxAge,
{stopOrphans})` runs at startup, where a running recorder cannot be ours, and again on every reset,
where it sweeps by mtime and issues no stop because there a recorder could be live. Age is measured
on mtime, which on a file being written moves continuously, so a recording in progress can never be
old enough to sweep — belt and braces beside the in-memory guard. Verified by reverting each half
and watching the matching test go red.

Same family as D28: **the correct shape was already in the repo** — `sweep()` in `allocator.ts` is a
reconciliation loop for exactly this reason — and the new code invented a promise instead.

**The fix's first draft shipped a false alarm, caught on the farm the same hour.** It reported "an
orphaned recorder was stopped" from `record_cvd stop`'s exit code — and `record_cvd stop` prints
*"stop was successful"* and exits 0 against an instance with no recorder, on a host with **no
devices booted at all**. So a clean boot of a healthy farm would have logged an abandoned-recorder
warning for every device, every morning. The stop is still issued blind, because it is a cheap
safety net; what changed is that the CLAIM now needs evidence — a `.webm` whose mtime moved in the
last two minutes, which at startup cannot be ours. A control that cries wolf every morning is not a
control.

### D29 — VIDEO_RECORDING in `deploy/.env` reached nothing

| | |
|---|---|
| **Severity** | **S2** — the farm was configured to record and recorded nothing, with no error anywhere |
| **Found** | five minutes after turning recording on, checking the container rather than the file |
| **Closed** | 2026-09-07 |

`deploy/.env` is **compose's** env file, not the container's environment. Compose reads it for
`${…}` interpolation and passes nothing to a service that does not name the variable under
`environment:`. So `VIDEO_RECORDING=failures` was set, correct, and read by nothing.

There is nothing to see in a log, because reading an unset variable and falling back to a documented
default is exactly what the code should do. `single-origin.test.ts` pins the same shape from the
other direction — *the configuration the deploy scripts actually produce was the one that could not
work*. The test added with the fix checks the **deployment** rather than the code, over a curated
list: most settings have production-correct defaults and are legitimately absent from compose, and
these are the ones whose default is deliberately not what a farm wants.

D26 is below and is the
most interesting entry this file has: it is the first defect the SUITE could not have found *by
construction*, and the reason is worth reading before writing another fixture. D28, directly under
this, is the newest member of this file's oldest family and was found the same way all six of the
others were: by running the thing on the farm.

### D28 — the auto-deploy installer's device-host guard could never fire

| | |
|---|---|
| **Severity** | **S2** — it installs a timer that fast-forwards the worker's tree under running sessions |
| **Found** | running `install-autodeploy-service.sh` on `mfarm-lab` to verify it would refuse |
| **Status** | fixed and verified on the lab, 2026-09-07 |

`deploy/install-autodeploy-service.sh` exists partly to refuse the device host. The auto-deployer
fast-forwards the checkout it runs from, and on `mfarm-lab` the worker and the boot unit both
`ExecStart` out of that tree — so a tick there would move the agent's code under whatever sessions
are running. Bringing a device host forward is a decision with a different blast radius, and the
installer's whole job in that case is to say no.

**The guard tested for `deploy/.state/api_key`,** on the premise that only a control plane has
deploy state. **`mfarm-lab` has had that file since 2026-08-18.** Run on the lab it passed, and the
installer wrote both units onto the device host. It exited 0 and printed a success line.

Two details make this worse than an ordinary mistake, and both are the point:

* **The correct answer was already in the repo, sourced, and never called.** `deploy/lib/host-role.sh`
  defines `mfarm_is_device_host` — `/dev/kvm` present *and* a `CONTROL_PLANE_URL` pointing somewhere
  other than this machine. The installer had `. host-role.sh` at the top, with `|| true` after it,
  and then invented its own weaker test three lines further down.
* **It shipped with no test at all**, and no test on the machines it runs on could have caught it:
  `mfarm_is_device_host` needs `/dev/kvm`, which exists on neither a developer's machine nor a CI
  runner, so the branch that matters was unreachable. The fix adds `MFARM_KVM_PATH` purely as a
  seam so a test can drive it, and a fixture that deliberately includes `api_key` — because the real
  lab has one, and a fixture without it would have agreed with the bug.

The refusal also now runs **before** `stat -c '%U'`, which is GNU-only: with that line first, the
guard could not be reached on any non-Linux machine, so the test could not run at all.

Verified by putting the shipped guard back and watching two of seven cases go red.

### D27 — a refused upload could leave its temp file behind

| | |
|---|---|
| **Severity** | **S2** — reachable by anyone with an API key, and it fills the control plane's disk |
| **Found** | a full-suite run on a loaded machine, while verifying unrelated work |
| **Closed** | 2026-09-07 |

`AppStore.put` writes to a `.part` file and unlinks it when an upload is refused. `createWriteStream`
opens the file **asynchronously**, and an oversized upload throws on the very first chunk — before
the open completes. The cleanup `unlink` therefore found nothing to remove, and the open then landed
and created the file that had just been "cleaned up". Nothing ever removed it.

The existing test asserted exactly this and had passed for weeks: on a quiet machine the open wins
the race. It went red once, under the load of a suite that had grown by 37 tests. **A race asserted
once is asserted by luck** — the fix ships with a second test that runs a hundred refused uploads in
parallel and loses the race reliably, verified by reverting the fix and watching it fail.

Not hypothetical: the path is reachable by anyone with a key, so a loop of oversized uploads was a
way to fill `mfarm-cp`'s disk from outside. The test's own comment had called it *"a disk-fill
primitive"* since the day it was written.

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

## Found by reading the product against a competitor, 2026-09-09

**These four were D28-D31 until 2026-09-11, and those numbers were already taken.** The 2026-09-07
video series and the 2026-09-08 exploratory series had used D28 to D34; this section started again
at D28, so the register carried two D28s, two D29s, two D30s and two D31s for two days. Nothing
outside this file pointed at the wrong one -- `STATUS.md` and `EXECUTION_ROADMAP.md` both meant the
older series -- but a register whose ids do not identify anything is worse than no ids. Renumbered
to D35-D38, which is also why a defect register needs the same "read the LIVE state first" rule as
everything else here: the next id is the one after the highest in the FILE, not the one after the
last thing you personally wrote.

Not from using the farm — from an authenticated review plus four LambdaTest specs (`docs/ltcomp/`)
read against the code. Worth separating, because the hit rate is different: **the documents claimed
eleven gaps and roughly a third of them were already built.** The command timeline, the video player
with failure-seek, the UI hierarchy inspector, per-device host heartbeat and the metering ingest were
all shipped and all listed as missing. Grep the section's verb before budgeting the work — the same
lesson as HANDOFF entry 75 and as the two wrong entries this register itself carried.

| id | what | status |
|---|---|---|
| D35 | **Four surfaces answered "can a session start?" from the SESSION table.** With five devices quarantined and nothing running, the console said "Every device is on its clean snapshot", "All devices are available" and "Every device is in use" on three panels while its own header said 0 of 5 ready. The fourth — `fleetHeadline`, whose `'Every device is in use.'` was the else-branch of `free === 0` — the review had not spotted. **Seventh instance of the false-premise family.** | Fixed 2026-09-09 by `capacityState()`, one allocator-derived read model. Three tests, each verified RED first. Deployed at `7faf06c`. **CLOSED 2026-09-11, seen with the quarantined fleet it was written for** — with `mfarm-lab` stopped and all five devices quarantined, the header said `0 of 5 ready`, Fleet said *Nothing can be allocated — 5 quarantined.*, and BOTH Waiting empty states repeated that same sentence. Four surfaces, one answer. |
| D36 | **`fleetHeadline` promised a queued caller "the farm hands over the moment a lease ends" on a farm where nobody held a lease.** Same function, separate defect: the fallback was unconditional, so an unbounded wait read as an imminent one. | Fixed 2026-09-09. **CLOSED 2026-09-11 on the same quarantined fleet as D28** — nobody held a lease and the promise was correctly absent. |
| D37 | **The hub took no name, so a session was anonymous for exactly the window somebody would look at it.** `test_results.name` arrives only when the suite posts a result — after the test ended, and never for a passing one. The Runs screen showed uuids during a run. | Fixed 2026-09-09, migration 048. **CLOSED 2026-09-11 on real Cuttlefish** — `deploy/verify-hub-contract.mjs`, 30/30. A session read back its test name before any result was posted, and the Runs screen shows `Android_UAE_Expenses_2026_09_10_23_54_48` over its CI id instead of a uuid. |
| D38 | **An error message I wrote pointed at `mfarm run --profile`, a flag that does not exist** — the CLI has `--tier`, `--ttl` and `--wait`. Caught by reading `bin.ts`, not by any test. A remedy that reads as a fix and is not costs more than no remedy. | Fixed before commit, 2026-09-09. |

**Still open from that review, and named so nobody assumes otherwise:** there is no share link and
no customer-facing tunnel.

**~~Host disk/CPU reaches Prometheus with no console read endpoint~~ and ~~the metering ingest has no
usage view~~ — CLOSED 2026-09-11, ADR-0035, migration 050.** `GET /v1/hosts` is the read model;
Health carries a Machines card with disk, load and memory **and the age of the reading**, plus a
per-day usage chart. **The "agent version" half is NOT closed and is not being claimed**: there is
no such column on `hosts`, only `protocol_version`, which is what the agent speaks rather than what
somebody shipped.

**And the review's framing would have produced the wrong feature.** It asked for a per-org usage
view. On 2026-09-11 the device host ran twenty hours idle after a two-minute check — ~₹1,350 — and
the meter correctly recorded almost nothing, because usage is what a SESSION holds and cost is what a
HOST burns while powered on. A usage page alone would have shown an empty chart while the money left.
ADR-0035 reports both and keeps them apart.

**~~Runs has no search, filter or pagination~~ — CLOSED 2026-09-11.** `GET /v1/runs` takes `q`,
`status`, `from`, `to` and a keyset `cursor`; the console has a debounced search box, status chips
and Load more. **Keyset rather than OFFSET** because a run list is a feed with writes landing at its
head, so page two under OFFSET repeats or skips rows whenever CI creates a run mid-pagination —
tested by creating one between pages. The `status` filter and the row's badge are **one derivation**
(`outcome`, returned by the API): a list that selects by one rule and labels by another is the D35
family, and this is the first feature built with that lesson applied up front rather than after.

**~~API keys have no label, scope, expiry or last-used~~ — CLOSED 2026-09-11, ADR-0034, migration
049.** Labels are required at creation, keys carry a scope (`automation` cannot delete evidence),
an optional expiry enforced in `authenticate`, an approximate last-used, and the person who minted
them. The console asks in a dialog instead of minting on click. **The framing in the review was
wrong in a way worth keeping**: this reads as a blast-radius problem and is not one — a key already
could not mint another key, because `requireOrgAdmin` needs a user session. The defect was that
rotation was impossible, since revoking one of four unlabelled prefixes is a guess about whether CI
stops.

**Verified on the farm 2026-09-11, both halves.** `examples/python-pytest` ran **3 passed in 56s**
on real Cuttlefish with an `automation`-scoped key, so the narrow scope does not cost a suite
anything; the same key asking to delete a session's evidence got **403** naming the scope that can.
The five keys minted for that check were then revoked by their labels in one statement — which is
the feature demonstrating its own point, since before 049 they would have been five indistinguishable
prefixes beside the live deploy key.

**And one entry above was written too strongly — corrected 2026-09-11 by looking at the screen.**
This paragraph used to say "a run lists only its FAILURES as test rows, so every passing test's name
is now recorded and rendered nowhere." The second half is false for the shape that matters. The run
screen's **Sessions** table has a TEST column, so with one test per session — the LambdaTest shape,
one Appium session per Cucumber scenario, and what `examples/java-testng/` migrates — every test
renders by name, passing ones with a green PASSED pill. Verified on the farm: run
`verify-hub-1789084488716` lists *Expenses: a cardholder submits a claim* · PASSED 1/1 and *Expenses:
a claim over the limit is refused* · 1 FAILED 0/1.

**What is actually missing is narrower:** a session that runs SEVERAL tests shows one row carrying
the session's name and a count. The same farm's `medishop-after-036-1788482936` is the picture of it
— two rows reading `c9dd5f62-8959-44e0-8e24-bb84675621ba` · PASSED 3/3 and PASSED 5/5, eight passing
tests counted and none named. That is the case test rows are for, and it is a smaller and later job
than "the console cannot show a test". Same lesson as HANDOFF 75 and 77, this time against my own
register: **grep the verb, then go and look at the screen.**

## Found by using the runs filter, 2026-09-11

| id | what | status |
|---|---|---|
| D39 | **A filter chip could light up over a list that ignored it, and the press was simply LOST.** Seen on the deployed farm minutes after shipping the feature: *Not reported* looked active above rows reading ALL PASSED and 1 FAILED. `render()` replaces the screen wholesale and the poll calls it whenever fleet data changed — most five-second ticks on a live farm — so a button rebuilt between a mousedown and its mouseup never receives the click. The box on the chip was a focus ring, not an active state. | Fixed 2026-09-11 by keeping the chip elements across renders and writing only their class, the same treatment the search input already had. **Verified on the farm**: five presses, five requests, five correct results (18 failed / 7 passed / 4 not reported / 0 live, each matching the API), and a second press clearing the filter. |
| D40 | **Two overlapping `refreshRuns` calls could apply their answers in either order** — a filter pressed while the route's initial load was still in flight would have the older, unfiltered answer land last. Found while investigating D39 and NOT the cause of it. | Fixed 2026-09-11 by a generation counter, the guard `loadRunDetail` already carried. **Verified RED**: exactly the two race tests fail without it. |

**THE FIRST CAUSE I WROTE FOR D39 WAS WRONG, AND THIS IS THE THIRD TIME THIS REGISTER HAS DONE
THAT.** The entry said the 5s poll's unfiltered request was landing on top of the filtered one.
**The poll does not call `refreshRuns` at all** — it refreshes devices, sessions, actions and held,
and only calls `refreshApps` on the apps screen. What gave it away was the network panel: on the
failed press there was **no request at all**, and a race would have made two. A cause that explains
the symptom is not the same as the cause, and the cheap way to tell them apart was to look at what
the page actually asked for.

**It needed a new kind of test, and that is the durable part.** Every console test in this repo
seeds `state` and calls a screen — a RENDERER test, which cannot see a bug in the code that fills
the state. `console-runs-loader.test.ts` is the first LOADER test: it stubs `fetch` so responses
resolve out of order, which is the one ordering a test awaiting its own call can never produce. It
catches D40. **It does not catch D39**, and nothing in this repo does: a click lost between a
mousedown and a re-render needs a browser, and the only instrument that found it was pressing the
button on the deployed farm.

## Found by opening the screen I had just shipped, 2026-09-11

| id | what | status |
|---|---|---|
| D42 | **The usage chart drew fourteen fully transparent bars.** `background: var(--accent)` — and this design system has no `--accent`, only `--mf-accent`. **CSS drops a property with an undefined variable silently**, so the elements existed with correct widths and heights and painted nothing: sixty-four pixels of empty card. A second one in the same two lines, `margin-top: var(--s-md)`, where `--s-*` is the SURFACE colour scale and spacing is done with utility classes. | Fixed 2026-09-11. `theme.test.ts` now refuses any `var(--x)` in `console.css` that nothing defines and that has no fallback — it caught the second one immediately. |
| D41 | **The Health screen rendered completely blank on the deployed farm.** `usageCard` passed `style` as a STRING; `h()` writes styles through CSSOM because the console's CSP kills the style attribute, and a real `CSSStyleDeclaration` throws on an indexed write. One throw inside `render()` produces no tree at all — nav and chrome present, content area empty. | Fixed 2026-09-11: static styling moved to a `.usagebars` class, only the computed height written as an object. **Verified RED** — restoring the string fails ten tests including the new one. |

**THE TEST FOR THIS ALREADY EXISTED AND COULD NOT FIRE.** `dom-shim.ts` has refused indexed style
writes since the last time this shape cost something, and `console-screens.test.ts` calls every
screen. It passed anyway, because `usageCard` returns a "Loading…" card while `state.usage.loaded`
is false — which is what every seeded test left it as. **The branch that draws the bars was
unreachable in the suite while being the only one a real farm ever renders.** A guard only guards
code that runs, and seeding state chooses which code that is. Two tests now seed past the early
return — one for the chart, one for a host reporting uptime and cost.

Same family as D39: shipped, tested, green, and broken on the first screen anybody opened.

**D42 came out of the same two lines and needed a different instrument again.** Once Health rendered,
the chart was still invisible — and every check available said it was fine: the CSS file was served,
the class matched, fourteen elements existed with correct geometry. The only thing that could see it
was asking the browser for a COMPUTED style, which returned `rgba(0, 0, 0, 0)`. The guard now in
`theme.test.ts` is the cheap source-level version of that question, and it found the second
undefined token in the same rule the moment it was written.

## Found while fixing the ones above, 2026-09-11

| id | what | status |
|---|---|---|
| D43 | **Five CSS variables were painted from their fallback and never from a token**, so those colours never changed with the theme — the exact failure `theme.test.ts` was written for. `--accent-line` for `--mf-accent-line`, `--c-ok`/`--c-bad` for `--ok-dot`/`--bad-dot`, `--t-dim` for `--t-caption`, and a `--mf-accent-text` that never existed. Two were minutes old; three had been sitting in the stylesheet. **None of them was visible** — a fallback paints. | Fixed 2026-09-11. The D42 guard could not catch these: it exempts anything with a fallback, on the grounds that a fallback cannot paint nothing. A second assertion now says a fallback must still name a token that exists. |

**A FALLBACK HIDES A TYPO; IT DOES NOT FORGIVE ONE.** This is the interesting half of D42's
follow-up. `var(--t-dim, #8A8A94)` renders correctly in dark theme and is frozen there — a token is
how a value learns about the theme, and a fallback is what it does while the theme has not loaded.
The guard written yesterday deliberately skipped these because they cannot render as *nothing*; it
took writing two more of them to notice that invisible and wrong are different failures and both
need a check.

## The first fix was a half-fix, 2026-09-11

**The recorded defect said "repeated SUCCESSFUL commands" and I implemented exactly that**, with a
rule I was pleased with: a failed step is the row the table exists for, so it never folds. Then a
real trace off this farm showed what an Appium suite makes:

```
1 POST element  no such element   ← a WebDriverWait, polling
2 POST element  no such element
3 POST element  no such element
4 POST element  200               ← the element arrived
```

One session in this register has **eighteen** of those in a row. **The dominant noise in a real
suite is repeated FAILED lookups**, so the first version fixed the complaint on paper and on no
trace this farm has ever produced.

Failures now fold too, with the difference that carries the argument: **the LAST failure of a run is
always shown**, because in a polling wait it is the attempt the suite acted on — the one before the
element appeared, or the one where it gave up. The twelve before it are the wait working. A success
run has no such special member and folds whole. A folded failure run says *"no such element — while
waiting"* in plain type rather than in the red pill an individual failure gets, because red is
reserved for a step somebody should look at and the whole claim of that row is that these are the
ones they should not.

**The lesson is about where the defect text came from.** It was written by reading the screen, so it
described the noise that was visible on a short manual session. The noise that matters was in a
trace nobody had opened. Reading a stored trace before fixing would have cost one query.

## Found by bringing the lab up to verify, 2026-09-11

| id | what | status |
|---|---|---|
| D45 | **Nine settings `config.ts` reads were declared on no service, so setting any of them did nothing.** `deploy/.env` is compose's env file, not the container's environment: an undeclared variable is read for interpolation and passed to nothing. Found because `HOST_HOURLY_COST` was set on the farm and the console still showed a powered-on host with no money beside it. **The warning was already written in the block above the one being edited** — the video section says this cost a farm on 2026-09-07 (D29) and describes the symptom exactly. | Fixed 2026-09-11. The guard that should have caught it was a HAND-KEPT LIST of five names; it now derives every `env.X` from `config.ts` and allows only an explicit, reasoned set that arrives by docker secret. Verified RED by deleting one line from compose: it names the variable. |
| D44 | **`hosts.up_since` never got stamped, so the whole cost display was dead on arrival.** Migration 050 wrote it in the registration upsert only. The farm was stopped overnight and brought back: **twelve heartbeats, zero registrations**, column still NULL. `/workers/heartbeat`'s own comment already said registration is something "a healthy agent never performs, because its stored capability fingerprint has not changed" — I had read that file to write the feature and not read that sentence. | Fixed 2026-09-11: maintained on the heartbeat, stamped when there is a GAP in beats rather than when state is not UP. **Verified RED** — all four new tests fail without it. |

**THE FEATURE WAS BUILT, TESTED, SHIPPED, DEPLOYED AND INERT.** Fourteen tests covered it, including
one asserting a stopped host reports no uptime; every one of them seeded `up_since` directly, so
none could see that nothing ever writes it. The only thing that found it was starting the machine
and looking at the column — which is the exact check the ADR's own "not yet verified" note asked for
and which I wrote down rather than performed.

**The gap rule is the interesting half.** Keying on "state is not UP" is the obvious implementation
and is wrong: an operator-quarantined host keeps beating, so it would rewrite `up_since` to `now()`
on every beat and report a machine that had been on for a week as up for five seconds. A gap in
beats is what "came up" means.

## The documents were wrong about the repo, again, 2026-09-11

| id | what | status |
|---|---|---|
| D46 | **`STATUS.md` was wrong in five places about facts anybody could count** — 1474 tests against 1607, 49 migrations against 50, 28 ADRs against 34, 27 defects against 45. `APP_CONTEXT.md`, written the same day, had decayed **within hours**. The page opens by promising every number on it "was read from the code, the farm or `git` on that day, not carried forward". | Corrected 2026-09-11, and `deploy/doc-numbers.test.mjs` now derives migrations, ADRs and the highest defect id from the filesystem and fails CI when a document disagrees. **Verified RED** by restoring one stale number: it names the figure and the real one. |

**THE TEST COUNT IS DELIBERATELY NOT ASSERTED.** It moves on most commits, so pinning it would mean
editing a document in every pull request — and a check people route around is worse than no check.
Those numbers now carry the date they were taken, which is a claim about a moment and cannot go
stale because it was never about now. The guard enforces the date rather than the number.

**This is the failure this project keeps having, and it had never been mechanised.** HANDOFF 76 is
about splitting documents by rate of change so they stop dragging each other out of date;
`DEFECTS.md` carries two entries where the register was wrong about itself; the HANDOFF summaries
have been audited for false claims twice. Every one of those corrections was a person re-reading and
noticing. The countable part of that job is now CI's.

## Found by trying to verify the last hop on hardware, 2026-09-12

| id | what | status |
|---|---|---|
| D47 | **ADR-0037's first hop had no code behind it, and both the ADR and `STATUS.md` described it as one `adb` command away from verified.** `DeviceProxy` — the listener a device points at — had exactly one caller in the repo, its own test. Nothing in `workers/agent` ever constructed one, so no farm had a listener; nothing anywhere ran `settings put global http_proxy`, so no guest was ever pointed at one. `mfarm:tunnel` allocated a device, validated the name, recorded it on the session and then did nothing at all. **Found by going to the lab to run the one command the documents said was outstanding, and looking for the port to run it against.** | Fixed 2026-09-12. The beat now carries the devices whose live session named a tunnel; the agent converges on that set, binding one listener per device and pointing the guest at it. **Verified RED twice** — deleting the heartbeat's one call fails two tests in `agent.test.ts`, and widening the control plane's session filter fails the teardown test. Verified on the lab against real guests. |

| D48 | **A device that lost a boot race declared no `network-proxy`, and nothing could ever give it back.** The capability is observed by asking the guest for its default route, and `sys.boot_completed` comes up before that route does — so on the lab, three of four guests had it and cf-2 did not. `start()` is the only thing that probes, and it does not run again until the agent restarts, so that device could never be allocated a tunnelled session. **Found by reading the fleet's capabilities on the farm five minutes after shipping the feature** — the tests could not see it, because the race is a property of a real boot. | Fixed 2026-09-12, in two halves: the probe retries on the health poll (upward only — a later loss is usually a wedged adb), and the heartbeat re-registers when the capability fingerprint changes. The second half was missing for **every** device capability, not just this one: `register()`'s comment claimed the agent re-registers whenever the fingerprint changes, and that comparison existed only in `start()`. **Verified on the farm**: on the deploying restart the race moved to cf-3, and the repair and the re-registration were both watched in the log, taking the fleet from three of four to four of four. |

**THE SHAPE IS D44'S AND D29'S, AND IT IS THE THIRD TIME.** Every piece tested, no piece joined —
and the test that gave the most confidence is the one that hid it. `tunnel-end-to-end.test.ts`
stands a real `DeviceProxy` up *itself* and points an HTTP client at it, which is a faithful model
of what an Android guest does **once the setting is in place** — so it proves every link except the
one that puts it there. The suite could not have gone red for this, because what was missing was a
caller, and a test that supplies its own caller cannot notice the absence of the real one.

**The documents were confidently specific about the wrong thing.** "What has not been run is that
one command against a live Cuttlefish guest" is a sentence that sounds like it was written by
somebody who had checked. It was written by somebody who had checked everything downstream of it.
The reusable half: when a document says one small step remains, the step to check first is whether
anything CALLS the thing the step is meant to complete — `grep` for the class name outside its own
test, which is ten seconds and would have said so.

## Found by using the AI testing tab on the farm, 2026-09-26

| id | what | status |
|---|---|---|
| D49 | **"Recent AI runs" said "Loading…" for good, so a person who started a run could not find it again.** The AI screen's three loaders run together on arrival, and `loadAiPricing` wrote `state.ai = { ...state.ai, pricing: await api(…) }` — JavaScript copies the spread BEFORE the await, so when the prices answered after the run list, that copy was written back over it, restoring `loading: true` with no runs. `loadAiRuns` refuses to start while `loading` is set, so only a full reload could recover, and a reload could lose the same race. The same write could erase an open run's page. **Every AI console test seeded `state.ai` and rendered it** — the family `console-runs-loader.test.ts` was written for, one screen over. Reported by the owner as "the run started but it went away"; the run existed, and had stopped on the model provider's daily cap, which the run page also did not say. | Fixed 2026-09-26 (#216): the spread happens after the await. `console-ai-loader.test.ts` answers the list before the prices and asserts both survive; **verified RED** with the original line restored — both tests fail. The same exploration fixed ten usability defects on the same two screens, each with a test that fails with it put back. |
| D50 | **An AI run could not type, and a run that could not type still reached a verdict.** The runner and `mfarm mcp` asked for the focused field with `POST /element/active`, the JSON Wire form; Appium 2 answers only the W3C `GET` and says "unknown command" to the POST. Seven of seven `type_text` steps failed on the farm, and the agent concluded the field "never registered" — a plausible sentence about the app built on a defect in ours. **Both fakes accepted either method**, so every typing test was green, and the MCP server's hardware check two days earlier happened never to type. | Fixed 2026-09-26 (#215). Proven on a real device through the hub before changing a line: POST → unknown command, GET → the focused EditText, "Display" typed and read back. Both fakes now answer POST as Appium does; **verified RED** — putting POST back fails the MCP test, and a new test asserts the typed value reaches the device. |

## Found by asking why a host "ran nothing today", 2026-09-26

| id | what | status |
|---|---|---|
| D51 | **Every session driven through the WebDriver hub went unbilled.** Infrastructure › Usage said a host that had run fourteen AI runs that day was "0% used — nothing ran on it". It was reading the meter correctly: the worker started metering only when a LIVE-VIEW socket connected (`dataplane.ts` → `beginSession`), and a session driven purely over WebDriver never opens one. On the farm, in the month to 2026-09-26: 42 of 42 sessions in a run (every CI suite, every AI run) carried no device-seconds; 57 of 57 console live sessions did. The hub is the product ADR-0018 sells. A second, smaller leak in the same code: a session metered in two stretches (a viewer leaves, the hub drives it again) restarted its tick count at zero, so the second stretch's first event reused the first's id and the idempotent ingest dropped it as a "retry". | Fixed 2026-09-26 (#220). The gateway reports every request whose grant verified (never a refused one) and the agent meters that session from its first command until the reset that ends the lease — the same lease rule a live session always had; a live view joining a hub-metered session keeps the running meter. Event ids carry the stretch. The process builds its gateway only through `automationGatewayFor`, which is where the metering is, and a test asserts `index.ts` has no other construction path. **Verified RED** three ways. **Verified on the device host 2026-09-27:** the lab's worker was updated to `9a46ab4` and one AI run (a saved test, passed in 2 steps) left 4 `device_seconds` rows totalling 39.2 s against its session — from the first request the gateway authorized (the app install, before the session row's own start) to the reset that ended the lease. The session row says 26.3 s; the difference is that install and the few seconds until the reset was picked up, both of which held the device. |

## Found in the break-it pass over the console, 2026-09-26

| id | what | status |
|---|---|---|
| D52 | **A PIN and a passcode written into an AI run's task were printed on the PUBLIC share page** — and on the AI run list, the run page and the Runs page. The share page hid a typed value's text (it showed only its length), but the task itself, the agent's reasoning ("enter 4812"), a finish step's own summary and the run's name all carried the values in full; the account's e-mail too. Every surface was written from the task as-is, and the run's names were its first 80 characters, cut mid-word. | Fixed 2026-09-26 (#221). `ai/secrets.ts` finds the values after a secret's label and a separator ("pin : 4812", "passcode as : 539176", "password demo1234") and masks them EXACTLY wherever they appear — list, detail, steps, summary, names, share — while the task stays whole where it is used; `GET /v1/ai/runs/:id/prompt` gives the owner their own task back for Run again. The share page also masks e-mail addresses. Names are masked, then cut at a word; a boot pass rewrote the names already stored. The share test caught two leaks the first version missed (step inputs, the run's name). **Verified RED** on the list and the share page. |

| D53 | **A farm switched off to save money read as an outage.** Infrastructure's headline said "Infrastructure down" in red with a CRITICAL "No heartbeat for 75 minutes — its devices have left the pool" and a WARNING about stale gauges, for a device host somebody had stopped on purpose — the farm's normal state between sessions, per the runbook. Two causes. A stop made anywhere but the console (a laptop, `gcloud`, the cloud console) leaves the host `UP` and silent, which the overview cannot tell from a crash; and even a console Stop, which writes `DOWN`, still counted every silent host as `down` in the rollup. The provider knew the machine was TERMINATED — the Cloud tab showed it — but the overview never asked. | Fixed 2026-09-26 (#222). The overview asks the same cached inventory the Cloud tab reads (never allowed to hold the page: 3s, then "don't know"), a silent host the provider reports stopped is `stopped`, and a stopped host raises no alert. A new component status, `off`, is used when every host is switched off — Hosts, Worker agents, Network, Device farm — and the headline says "Infrastructure switched off" in a neutral colour. A silent host that was NOT switched off is still `down` and still CRITICAL. **Verified RED** three ways. |

| D54 | **Every AI run on the farm fails at its first model call, and the go / no-go says to try again in a minute.** Groq's free tier now caps OUTPUT tokens per minute for `qwen/qwen3.8-27b` at 1,000, and refuses outright any request whose expected output is larger. The `openai` adapter sends no output cap (`provider.ts`: "No token cap is sent"), so Groq assumes 1,748 and answers 429 "Request too large … on output tokens per minute (OTPM): Limit 1000, Requested 1748". The run holds a device, takes no step, and ends `model_error`. Because the answer is a 429, `health.ts` reads it as slowing down: the provider is `limited` for a minute, the readiness strip goes green again, and the next run dies the same way — no retry of an unchanged request can ever succeed. Found 2026-09-27 verifying #224; an 11-step run on the same key worked at 13:11Z the day before. | Fixed 2026-09-27 (#226). The adapter reads a size refusal once (`tooLargeOf`: "Request too large … Limit N, Requested M") into a structured `ModelError.tooLarge`. An OUTPUT refusal is answered at once with the same call capped at half the limit (`max_completion_tokens`, 500 here — measured, a step's answer is 60 tokens at the median and 236 at the most over 48 farm steps), and the cap is kept for that endpoint and model; an INPUT refusal fails at once instead of being waited on. Either way `health.ts` records nothing, so the go / no-go no longer flips; the run ends saying the key's tier refused the request, not "could not be reached". `MFARM_AI_MAX_OUTPUT_TOKENS` sets a cap from the first call. Widening the compose guard to the AI settings also found `OPENAI_API_KEY`, documented as a fallback, never reached the container. |

| D55 | **A named secret reached the model through the SCREENSHOT, and was kept in a step.** Verifying #228 on the farm: a task typed `{{NOTE}}` into Settings' search box. The element list the model reads correctly said `{{NOTE}}` — but a search box draws what was typed into it, and the model read the value off the image: its verdict said "typed {{NOTE}} (zq7481)" (a made-up value). The run's final summary and evidence were scrubbed, but the finish step's own recorded tool input — the same words as the model wrote them — was not, so the value was kept in `ai_steps.action`. Every test passed: the stub phone's screenshot was not an image. | Fixed 2026-09-27 (#229). Wherever an element's text holds a value, its box is painted over in the screenshot before the model is sent it or the run keeps it — a minimal PNG editor (`ai/png-cover.ts`, 8-bit RGB/RGBA; anything else is withheld for the turn, never sent as it was). Every string in a step's recorded tool input is scrubbed. The stub phone now serves a real PNG so a test can check the paint pixel by pixel. |
| D56 | **Asked for several actions a turn, the farm's model could not write them — every AI run died.** ADR-0046 phase 1a (#231) told the model it may call up to six tools in one turn and turned `parallel_tool_calls` on. The first hardware eval after 1c deployed (2026-09-27, `deploy/ai-eval.mjs`, Groq `qwen/qwen3.8-27b`): 3 of 3 runs ended `model_error` on their 2nd or 6th call — `400 tool_use_failed`, "Failed to call a function", the tool call qwen wrote (`<tool_call><function=tap_element>…`) unreadable to Groq's parser. A 400 is never retried, so one bad answer ended the run. Before 1a the same model ran 48+ steps clean. The model also never batched on the calls that worked (5 calls, one field each). Every test passed: the scripted model writes whatever tool calls it is given. | Fixed 2026-09-27 (#234), **verified on the farm** the same day: `deploy/ai-eval.mjs` after `2255b96` deployed — 3 of 3 runs passed (API Demos' form in 7 calls for ₹4.33, a Settings search in 2 for ₹1.19, Android version in 4 for ₹2.56), boot log `one action an answer`. `MFARM_AI_PARALLEL_TOOLS` — unset, on for `anthropic`, OFF for `openai`-compatible servers, where one answer is one action and the prompt says so. And the openai adapter reads `tool_use_failed` as the model's sampling: asked again at once, twice at most, with one tool call an answer, remembered for that model. |

## Found by plugging a second phone in, 2026-10-03

A OnePlus 8T (KB2001, Android 14, OxygenOS) on the same MacBook the Samsung was on in August, against
`farm.mfarm.dev`. `deploy/verify-physical.mjs` passed on it — the first pass on a second
manufacturer. Everything below was found in the hour after that, by starting the agent and asking
for one session.

| id | what | status |
|---|---|---|
| D57 | **A phone that was plugged in and not shared took the agent down, so it could never be shared.** The hot-plug watch compares the usable phones adb sees against the agent's backends. A phone the owner has not shared (ADR-0009 §2) is usable and is never a backend, so it was an arrival on every start: the agent logged "plugged in and NOT shared", then one discovery pass later "new device(s) on USB — draining to re-register", and exited. Run by hand it relaunches and does it again, with a new window link each time; under a service manager it restarts for ever. The window is the only place a phone can be shared. `sharing.test.ts` and `window.test.ts` test the decision and the toggle; nothing ran the watch with a withheld phone. | Fixed 2026-10-03 (#241). `watchForChanges` takes the caller's "would this become a backend", and only those phones are in the set it compares; every pass still carries the withheld phone to the window. Three tests **verified RED** against the old code. **Verified on the handset:** the same start that drained now stays up — over a minute and six discovery passes with the unshared phone attached — and the window lists it with its toggle. |
| D58 | **Ticking Share is answered with a dropped connection.** `POST /api/devices/<serial>/shared` records the choice, then drains — and with no session to wait for the agent has exited before the reply is written. Seen as `curl: (52) Empty reply from server` beside a correct `shared.json`. In the page that is a failed request for an action that worked, and the link it was loaded from dies with the process: the window's token is minted at start-up. | Fixed 2026-10-03 (#248). The window records the choice, sends its reply, and only when the reply has left calls `applyShared`, which starts the drain — so the request is answered before the server that answers it is closed. A relaunched agent is handed the same token and port through its own environment (never a file) and opens no second tab, so the page somebody pressed Share on reconnects by itself. The reply says whether the agent comes back on its own (`restarting`), and the page says "the agent is restarting … this page reconnects by itself" or "the agent has stopped to apply it. Start it again" — whichever is true. Three window tests; all three **verified RED**. **Verified with the OnePlus, in Chrome, both ways** (`c1593f6`): Stop sharing → the agent drained and relaunched as a new process on the same address; the page that was pressed, never reloaded, reconnected and showed the phone PRIVATE, and the console's Fleet showed it OFFLINE. Share this device on the same page → STARTING within a second, READY/SHARED twenty seconds later, AVAILABLE on the Fleet, and a WebDriver session through the hub passed. |
| D59 | **A retired laptop cannot come back, and nothing says why.** Three things, one cause — migration 056 un-retires on registration and nothing un-quarantines. (a) Retiring quarantines the host; registration clears `retired_at` and leaves the quarantine, so the host returns to the fleet list as `QUARANTINED`, reason "retired: …", for good. No test registers a retired host. (b) An agent whose device set has not changed resumes with a heartbeat instead of registering, and a beat deliberately does not un-retire — so that agent sits quarantined indefinitely. Seen: six beats, no change. (c) The device it registers is `READY` on the quarantined host and the allocator hands it out: a session reached Appium on the laptop while the agent's own log said "draining, not accepting sessions". The window showed `status: ready` and no notice throughout. | Fixed 2026-10-03 (#244), all three. (a) Registration reads whether the host WAS retired before its upsert clears the mark, and if so lifts the retire's own quarantine through `release_host_quarantine` — the function the console's Resume uses — so the retire screen's "running the agent on it again brings it back" is now true; a drained host that registers stays drained. (b) The heartbeat says `retired`, and an agent that has just STARTED registers when it reads it; a running agent never does, so a process that slept through its retirement does not overrule it (056). (c) After the device upsert, a host still quarantined has its new devices taken through `quarantine_host` with its own reason and source, its `quarantined_at` put back, so Resume returns them. Ten tests through the real retire, drain, resume, register and heartbeat routes and a real agent; seven **verified RED**. API 1666/1666, agent 439/439. **Verified on the farm 2026-10-03, in the console**, with `becafaf` serving (read from `/v1/version` and the build badge): the laptop's agent stopped for thirteen minutes, the host retired from Infrastructure › Hosts — whose dialog promises "running the agent on it again brings it straight back" — then the agent started unchanged from `main`. It logged "this machine was retired from the fleet — registering, which brings it back", then "host is UP again"; the Hosts tab showed it RUNNING with its tunnel connected, the Fleet page the OnePlus AVAILABLE, and a WebDriver session through the hub passed. Part (c) is not reproducible on hardware with one phone — it needs a device the host has never registered — and rests on the API tests. |
| D63 | **A device back in service still carries the reason it was taken out.** After D59's verification the OnePlus read AVAILABLE on the Fleet page with "its host was quarantined: no heartbeat for 90s" in its holder column, and `GET /v1/devices/:id` returned the same `quarantine` object beside a state that was not quarantined. `release_host_quarantine` (053) restores each device's state from `quarantined_from` and leaves `quarantined_at`, `quarantine_reason` and `quarantine_source` as they were — the path the console's Resume takes, so it predates D59. | Fixed 2026-10-03 (#247). Migration 068 makes it the statement the other two host releases (`clear_silence_quarantine`, `lift_host_down`) already are: it clears the device's quarantine as it restores it, restarts the recovery clock of a device that was PREPARING (it used to resume with the time it had before the host went out, so a recovery could time out at once), and restores only the cascade's own rows. It cleans the rows already left stale; history stays in `device_quarantine_log`. The device read serves `quarantine` only beside QUARANTINED, so no path can put the sentence on a screen again. Four tests through the real drain, resume and device routes; three **verified RED** — two against 053's function, one without the read's guard. |
| D64 | **Releasing a phone promised a snapshot restore that would wipe what was typed into it.** The release dialog said "The device will be restored to its clean snapshot" and that it removes "session state, and anything typed or cached", and that "the recording" is captured — for every device. A handset's reset removes only what the session installed (ADR-0012); an app the phone already had keeps whatever the session typed into it, for the next session to see, and a handset records no video. The bring-up screen said "Restoring the clean snapshot" while a phone was being allocated. Seen releasing the OnePlus from the console. | Fixed 2026-10-03 (#247). `releaseStory` words the dialog from the reset the device declares: a snapshot device as before; `install-reset` — "Only what this session installed is removed. Anything typed or saved in apps the phone already had stays on it"; `session-reset` — every third-party app's data, "not a snapshot restore". The capture line names only what the device can capture. The bring-up step says a handset is "waiting for the device to confirm it is ready". Three console tests. **Verified on the farm in the console** (`cc34ad6`, migration 068): the OnePlus and the old Samsung lost their stale "its host was quarantined" lines on the Fleet; starting the OnePlus, bring-up said "Waiting for the device to confirm it is ready", and Release said "Only what this session installed is removed. Anything typed or saved in apps the phone already had stays on it" with "The logcat and a final screenshot are captured". |
| D65 | **MFARM wrote two errors a minute into every session's logcat.** D60's readiness probe (#242) ran on every discovery pass, and its `pm grant` and `pm clear` on a package that does not exist each leave a line in the phone's own log — `E PermissionManager: Unknown package: dev.mfarm.probe.no.such.package` and `W ActivityManager: Invalid packageName` — so a tester reading their session's logcat in the cockpit saw errors MFARM caused. Seen in the console: 30 such lines in the phone's last 2000. | Fixed 2026-10-03 (#249). The privileged probe runs only when its answer can have changed: never yet, after the phone has been away (the restriction moves only across a restart, and a restart is a departure), while it is restricted, and otherwise every five minutes (`PHYSICAL_PRIVILEGED_PROBE_MS`). Never while a session holds the phone. The two reads that log nothing still run every pass. Four tests; two **verified RED**. **Verified on the handset** (`c1593f6`): zero probe lines in the phone's log during a session and over a full minute idle, where the old probe wrote about twelve a minute. |
| D66 | **A screen that refused capture was shown as the screen before it.** Found verifying M4 live: on Android's PIN-entry screen the cockpit kept showing the screen-lock chooser under an error line. On the OnePlus a FLAG_SECURE screen gives `screencap` zero bytes (exit 0 through `exec-out`), not a blank image, and the agent called that "did not return a PNG" — a broken device. The same run found that one read 0.7s after a tap caught Chrome's splash screen. | Fixed 2026-10-03 (#252). Zero bytes is a `CaptureRefusedError`, the data plane says `refused: true`, and the console never keeps a picture it could not refresh: the frame shows the screen's labelled elements and says the app hides its screen from capture. An input is followed by two reads, at 0.7s and 2.6s. Five tests. **Verified in the console** (`c823783`): the PIN screen showed as its labelled elements and was operated from them; back on the home screen the picture returned by itself. |
| D60 | **A OnePlus could not run a session, and every surface said it was ready.** OxygenOS's permission monitoring — on from the factory — refuses adb's `settings put`/`delete`, `pm grant` and `pm clear` (`SecurityException`), while `dumpsys` lists all three permissions as granted; input, uninstall and force-stop are allowed. UiAutomator2 writes `hidden_api_policy_*` at session start, so `POST /session` fails in about a second and the customer is sent the Java stack trace as `session not created`. The agent logs nothing about the failure, the device goes straight back to `READY`, and the window says `ready`. The same refusal means the Play Protect fix (a `settings put`) and `full-sweep` (a `pm clear`) cannot work on this phone, and `verify-physical.mjs` ticks "a clear that fails exits non-zero" and estimates a one-second reset where no clear can ever run. Every earlier hardware run was a Samsung, which allows all of it. Told to ignore that one write (`appium:ignoreHiddenApiPolicyError`), a session got one step further and hung: the helper APK's install waited on a Play Protect dialog behind the lock screen, timed out three times, and returned a 500 after **191 seconds** — not classified `install-blocked`, because the regex wants `INSTALL_FAILED_VERIFICATION_FAILURE` and this was a timeout. | Fixed 2026-10-03 (#242), for the part that is the farm's. The agent asks each phone — three privileged commands aimed at things that do not exist, in one `adb shell`, 111–143 ms — at start-up and on every discovery pass. A phone that refuses is `blocked` in the window with the switch named, registers without `webdriver`, and loses it within a beat if it starts refusing later (`AutomationOffer`, which also stops Appium recovering from re-advertising a phone that is still blocked). The Play Protect button answers with the same sentence instead of the stack. **Verified on the handset, both ways:** factory state — window `blocked`, farm capability list without `webdriver`, `POST /session` refused in 196 ms with "No android device with an automation server is free"; switch on and phone restarted — no warning, the button works, a session in 10.9 s. **Two things the phone taught the fix:** the three commands do not move together (switching monitoring back on refused `pm grant` and `pm clear` at once and left the settings write allowed, so a probe of one called that phone ready), and the switch alone is not the remedy — settings and grant followed it only across a restart, so the instruction says to restart. A phone that is shutting down refuses nothing because nothing is left to; "allowed" now needs the settings command's own words. **Still open:** the 191-second hang is not classified, stay-awake and a lock screen are reported and do not withdraw the device, and there is no failure reason for any of it — a new one is a migration. |
| D61 | **Restarting a phone takes the agent down with it.** A phone that reboots or is replugged leaves the usable set and comes back as an arrival, and an arrival drains the agent to re-register — for a device it already has. Under a service manager or in a terminal it relaunches; started in the background without either it exits 0 and stays down. Found the moment D60's remedy became "restart the phone": following the instruction stopped the agent that gave it. **And underneath it, the reason the restart had seemed necessary:** the held `adb shell` dies with the connection and its handle stayed in place looking open, so every later command went down a dead pipe and timed out — without a restart, a phone that came back was `offline` for good. | Fixed 2026-10-03 (#243). The shell is forgotten when it exits and reopened by the next command, and a closed shell fails that command at once instead of after a 5 s timeout. The watcher reports a phone in the agent's own set as `returned`, not `added`, and only an arrival drains. While a phone is away or not yet answering, `webdriver` is withdrawn through `AutomationOffer` (`phoneBlocker`). The window said nothing about a lone phone leaving — its "no longer on USB" line was guarded on a non-empty discovery pass, which on a one-phone machine is never true — and offered to change a setting on the absent phone; both fixed. Six tests, four **verified RED**. **Verified on the handset, twice, watched in the console and the window:** reboot → shell closed and `webdriver` withdrawn within a second, the window "no longer on USB", the console's capability struck through; back → offered again about 45 s after the reboot, a session passed, same agent process. |
| D62 | **A phone that is not there reads AVAILABLE in the console.** Rebooting the OnePlus, the fleet list said `AVAILABLE` with a Start button and the headline counted it ready, while the agent knew it was gone and had withdrawn `webdriver`. Device state reaches the control plane only at registration and through leases; an agent's health checks file incidents and change nothing a scheduler reads. So a WebDriver session is refused correctly, and a session started by hand from the console is allocated to a phone that is not on its cable. | Fixed 2026-10-03 (#246). The agent says which of its devices are AWAY — not on USB, or not answering — on every heartbeat and at registration, and the control plane moves them READY → OFFLINE with the reason and back (migration 067, `away_since`/`away_reason`). Only READY is ever taken, so a lease, a reset or a quarantine is never disturbed; only what the beat took is given back, so a device OFFLINE for another reason (an unschedulable registration) is never promoted; a host quarantine keeps the mark so the release leaves something the next beat can give back. An agent too old to send the map changes nothing. The Fleet and device page say "Its agent says it is not on USB" and since when, in place of "The host has not reported it". A phone missing a prerequisite (D60) is NOT away — it is there, and a person can still use it; only WebDriver is withdrawn. Fifteen tests through the real register and heartbeat routes, a real agent and the console renderer; four **verified RED**. **Verified on the farm in the console** (`d4f6eec` serving, migration 067): rebooting the OnePlus, the Fleet row read OFFLINE, "21s ago", "Its agent says it is not on USB", with no Start button and "Nothing can be allocated" in the headline; 54 s after the reboot it was READY with `webdriver`, same agent process. Then the path D62 was about, by hand: Start KB2001 from the Fleet → bring-up → cockpit ACTIVE with logcat streaming → Release, back in the pool. |

## Found building M6 — live video for a phone, 2026-10-03

| id | what | status |
|---|---|---|
| D67 | **A phone's live view could not start while the lab host was stopped.** The console hands every session TURN credentials for `turn.mfarm.dev`, and that is coturn on `mfarm-lab` — the Cuttlefish host, stopped to save ₹65/hour. werift will not produce an offer until every candidate is gathered and puts no limit on a relay, so the agent never offered and the console sat on "negotiating" with the phone on the same desk. A Cuttlefish viewer never meets this — no lab, no Cuttlefish — which is why nothing saw it before a phone could stream. | Agent half fixed 2026-10-03 (#254): each relay is asked with a STUN Binding first (1.5 s, UDP or TCP as its URL says) and one that does not answer is left out, with a line in the agent's log; the offer has a 15 s deadline after which the viewer is told. A test runs the real stack against a relay that accepts and never answers, and fails without the probe. **Closed 2026-10-03 (ADR-0047):** the relay moved to the control plane, which is always up; `turn.mfarm.dev` points there. D70 then retired the probe — the agent no longer uses a relay at all. |
| D68 | **A still phone screen restarted its encoder every ~4 seconds for as long as anybody watched it.** Live input (#255) answers a browser's PLI by restarting scrcpy's encoder for a keyframe. Chrome also sends a PLI when no frame has come for 3 s while packets came within 5 — its stuck-stream probe, not a loss — and the restart's own frames count as packets, so 3 s after them it asked again. Measured in the console on the OnePlus: 71 PLIs and 81 keyframes in one session; 4 restarts, 59 frames and 245 KB in 20 seconds of a home screen nobody touched. It also hid itself: the bursts looked like the phone's own background activity, and they contaminated the latency measurements taken alongside. The headless werift viewer that verified #255 never sends that probe, so only Chrome could find it. | Fixed 2026-10-03: a PLI that comes after the screen has been still for 2 s (`PHYSICAL_IDLE_PLI_MS`), to a viewer that already has a keyframe, is the probe and gets no restart — a PLI for a real loss comes while frames flow, within a round trip of the frame it lost. Verified in the console: the same 20 idle seconds now cost 1 PLI, 0 keyframes and 26 KB, and the agent's trace shows the probes arriving at 3,020 and 3,015 ms. The end-to-end test sends that probe itself and fails without the fix. |
| D69 | **A released session went on streaming the phone into the browser that had held it.** Found releasing a session in the console on the OnePlus: two minutes later the tab's peer connection was still `connected` and still receiving frames, and scrcpy was still running on the phone. The agent's data plane closed a viewer only when the browser closed its socket — nothing passed the end of a lease on to it — and the cockpit kept the connection it had opened when the session ended under it. The input channel rode the same connection, so the previous holder could have touched the phone under whoever held it next, and the same socket carried the device's log stream on every tier. Cuttlefish hid it: its restore kills the WebRTC it served. A phone has no restore. A grant also outlives its session — verified offline, it lives 120 s — so a released browser could have reconnected inside that window. | Fixed 2026-10-03: the reset request — the one signal that reaches the agent on every way a session ends — now closes every live connection to the device (`session_ended`, which takes the agent's own peer, its capture and its log stream with it) and retires the ended allocation's fence, so its grants are refused as stale; the next allocation's fence is one higher and passes. The cockpit closes an ended session's connection from its side too. Verified on the OnePlus through the console: on release the frames stopped at once, the tab's connection went `disconnected` then `failed`, and scrcpy was gone from the phone. Tests take the real release path (CLEANING, then the heartbeat) and fail without either half of the agent's fix; a console test fails without the cockpit's. |
| D70 | **A reachable relay froze the phone's picture, on every path.** Found verifying ADR-0047. The moment the relay answered, the agent's werift gathered relay candidates of its own. werift sends every packet down the first pair IT nominated and never moves, and that could be one of its relay pairs while Chrome — the controlled side — settled on another. In the console, Chrome's direct path froze after its first 22 frames, with the agent sending almost nothing to it. Its relayed path received about a megabyte and accepted 116 packets of it. A headless werift viewer saw none of this, because werift accepts packets from any address, and it streamed perfectly over the same relay. For the hour before the stopgap, every Chrome viewer of the phone was affected, on and off the phone's network. | Fixed 2026-10-03: the agent's werift is given STUN only (`agentIceServers`). The browser holds the relay, and a relayed browser reaches the agent at its public address. That also retires D67's 1.5 s probe. Verified in Chrome on the OnePlus: on the direct path, 144 frames over a swipe and Back with 0 lost; with Chrome forced onto the relay, the drawer opened and closed through it, 804 of 855 packets accepted. werift's own source confirms the mechanism (`ice.js`: `this.nominated.protocol.sendData`, first nomination wins). The offer test fails — hangs — if a relay reaches werift again. |
| D71 | **A connection that dropped for a moment and recovered was announced as "connected, but no display" over a playing picture.** Found on the relay in the console: Chrome's consent checks stalled for 3.7 s behind a busy link, the connection went `disconnected` and came back. `live.js` called the first `disconnected` a failure. On the way back `ontrack` did not fire again, because it never does for an existing track, so the display grace timer decided there was no display and covered the video with a Cuttlefish explanation. The overlay also swallowed every touch. | Fixed 2026-10-04: `disconnected` gets 8 s to recover before the view says it dropped. A connection that comes back to `connected` having already delivered a display track is streaming again, even after being called dropped. Four tests drive the real negotiation with a fake peer and a mocked clock. Run against the old `live.js`, they reproduce the console exactly: `streaming → failed → nodisplay`. |
| D72 | **A browser's relay over TCP won the race against its relay over UDP, and the stream queued to a 6.2 s round trip.** werift nominates the first pair whose check succeeds and never moves (D70). Chrome gathers its relay both ways, and when the TCP allocation finished first, werift locked onto it with a UDP relay candidate sitting unused. 4 Mbit/s down TURN-over-TCP queued behind its own congestion control until consent timed out (and D71 drew "no display"). The candidate line does not say how the relay is reached — its transport is always `udp` — but its priority does: Chrome ranks UDP 3 and TCP 1 in the top byte. | Fixed 2026-10-04: the agent holds a browser's relay-over-TCP candidate for 1.5 s (`PHYSICAL_TCP_RELAY_HOLD_MS`) before adding it, so a UDP relay can be nominated first. It is held, not dropped: on a network that blocks UDP it is the only way in. Verified in the console: forced onto the relay, Chrome now takes it over UDP (88 ms round trip) where it had taken TCP twice. Tests cover Chrome's own priorities and fail without the hold. |

## Suite health

The order-dependent `attempts.test.ts` flake is **fixed** — it was a real billing bug (the usage
window bounded by the API server's clock rather than the database's), not test ordering.

One unidentified failure in five full runs on 2026-09-05, name not captured, three clean runs after
it. Recorded rather than called resolved: an intermittent failure nobody has seen twice is not the
same as one that has gone. A sixth full run, later the same day on `dc7299c`, was clean — which
raises the clean count and settles nothing, for the same reason.

Three more clean full runs on 2026-09-09 on the migration-048 branch. Same reading as the sixth: it
raises the clean count and settles nothing about a failure nobody has reproduced.

**2026-09-24, one CI failure, passed on rerun: `workers/agent/test/agent.test.ts:917`** —
*"an endpoint withdrawn at runtime strips `webdriver` on the next beat"*, assertion *"recovery needs
no registration either"* (`back[0].capabilities` lacked `webdriver`). PR #205's `Test` job, run
35925528980; the same commit passed the rerun, and 387/387 locally. The log line just before it is
the agent's own *"what this host can do has changed since it registered — re-registering"*, so the
likely shape is the re-registration and the next heartbeat racing on the same device row. Not
investigated further — nothing in #205 touched the agent — and recorded rather than called a flake,
because a race the product can hit is a defect whether or not a test catches it twice.
