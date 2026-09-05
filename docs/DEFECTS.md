# Open defects and gaps

One row per thing that is wrong or missing, found by using the console rather than by a test. A
defect leaves this file when it is fixed **and** verified on the deployed farm — not when a patch is
written.

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

| # | Sev | Area | What | Found |
|---|---|---|---|---|
| D1 | S3 | Health | Per-device rows show a state pill; document 05 §06 shows the last health-check outcome and its age ("check passed 4m ago"). `GET /v1/devices` carries neither the last attempt's outcome nor its time, so this needs either a lateral join onto `device_reset_attempts` in the list projection or N per-device reads. | design comparison |
| D2 | S3 | Device detail | `Screen` reads "not reported" on every physical handset. The worker registers no `screen` for real devices, so the design's geometry row is empty on exactly the device class the frame system was drawn around. Worker-side. | farm screenshot |
| D4 | S3 | Fleet | The headline says "the farm hands over the moment a lease ends" and never an ETA. Document 03 wants "the next X1 Pro frees in about 12 minutes"; its own CONFIRM note says that needs lease-expiry-derived data, which exists (`expiresAt`) but is only an upper bound. | design comparison |
| D18 | **S2** | Deploy | A merged, CI-green, released commit is not on the farm until someone runs `mfarm-deploy.sh`, and nothing reports the gap. PR #102's fixes were released at 11:34 and served at 13:08, discovered only by reading `docker ps` for another reason. The console's build badge shows what IS serving; nothing shows what SHOULD be. | reading the running image |
| D19 | S3 | Deploy | Both boxes' git checkouts drift silently from `main` and nothing notices. `mfarm-cp` was on a **detached HEAD at 886cb47**; `mfarm-lab` was **66 commits behind**, on PR #81. The lab's checkout is not decorative — the worker unit and the boot unit both execute from it, so the farm was running agent code from 66 commits ago. | starting the lab |
| D20 | S4 | Deploy | `mfarm-farm.service` on the lab still declares `Environment=CF_INSTANCES=2`, and the farm runs **four** devices from `CF_INSTANCES=4` in `deploy/.state/worker.env`. Since the D13 fix the device host exits before `farm-up.sh` reads that variable, so the unit's value is now inert as well as wrong — a declaration that contradicts the running system and no longer does anything. | reading the unit while verifying D13 |

## Fixed, awaiting verification on the farm

| # | Sev | What | How it was found |
|---|---|---|---|
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

## Closed

| # | Sev | What | Fixed in |
|---|---|---|---|
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
