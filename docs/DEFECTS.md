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
| D3 | S2 | Fleet / Launch | Nothing on a Fleet row can preinstall a build before handover. The capability exists only on `#/launch`, now reachable from the command palette but not from the surface where a person is choosing a device. | doc 06 nav audit |
| D4 | S3 | Fleet | The headline says "the farm hands over the moment a lease ends" and never an ETA. Document 03 wants "the next X1 Pro frees in about 12 minutes"; its own CONFIRM note says that needs lease-expiry-derived data, which exists (`expiresAt`) but is only an upper bound. | design comparison |
| D9 | S3 | Health | Zero actionable controls on the page. A device whose check failed is named and cannot be opened from the row it is named in. | clicking every control |
| D10 | S3 | Cockpit (ended) | The stage keeps its full height on an ENDED session, so the accounting below it — held for, actions, artifacts, reset — sits under a full-screen dead phone and is never seen without scrolling. Document 04 S4 puts the numbers beside the frame. | exploratory session |
| D15 | S4 | Bring-up | The build's tile sits half over the frame's top edge rather than clearly above it. Document 04 beat 05 has it outside the device until the worker confirms. | live run on the lab |
| D16 | S4 | Bring-up | A queued step's mark is a purple ring; document 04 says the two CONFIRM beats "breathe amber". The words are right, the mark is the wrong colour and shape. | live run on the lab |
| D17 | S4 | Fleet | Two unprofiled devices render as two identical "Unprofiled device" rows, distinguishable only by the short id. Honest — they are two devices — but nothing helps you tell them apart. | live run on the lab |
| D11 | S3 | Cockpit (ended) | The device rail renders every control on an ended session. They are disabled, which is right for a capability gap (stage 5) but not for this: document 04 S4 says "the live view and controls are gone", because none of them will ever work again for this session. | exploratory session |

## Fixed, awaiting verification on the farm

| # | Sev | What | How it was found |
|---|---|---|---|
| D5 | S3 | Fleet rows carried a `Details` button beside a device name that links to the same page — two controls, one destination, on every in-use row. The name is the only link now. | clicking every control |
| D6 | S3 | The Apps empty state offered "Go to Devices" pointing at `#/devices`. The route redirects so it worked, but the surface has been called Fleet since the IA change. | clicking every control |
| D7 | **S2** | "Find machine" with an empty code field returned silently — no error, no hint, nothing moved. Pressing the button before filling the field is the first thing a person does, and no test covers it. | clicking every control |
| D14 | **S2** | Pressing **Start** went straight to the cockpit, so the six-beat choreography played only from `#/launch` or when a request queued — on a warm farm nobody ever saw the device arrive. Start now routes through the bring-up screen, which hands over on its own once the socket has settled. | pressing Start on the lab |
| D13 | **S2** | The device host's boot unit failed on every boot from 3 to 5 September, exiting in one second on "BACKUP_BUCKET is empty" — a control-plane backup policy a machine with no database has no business having an opinion about. `farm-up.sh` now detects a device host (has `/dev/kvm`, has a remote `CONTROL_PLANE_URL`) and stops before the control-plane work. **Needs verifying on the lab next time it is up** — the fix is reasoned and unit-tested, not yet watched boot. | starting the lab |
| D8 | **S2** | A person in more than one org could not tell which they were in. `/v1/auth/me` now returns every membership and the header names the org — with "1 of N orgs" where there are several. A switcher still needs a re-mint endpoint; signing out and back in is the way for now. | exploratory session |
| D12 | **S1** | A session's length was rendered as `mm:ss`, so "Released by you at 14:29, after 20:00" read as two clock times. `clock()` stays where a number ticks; prose gets words. | reading a real ended session |

**D5 is verified on the farm** — the live Fleet at `886cb47` shows one button per row. The other three
are in the deployed build and verified by the suite, not yet by eye on the farm.

## Closed

| # | Sev | What | Fixed in |
|---|---|---|---|

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

## Suite health

The order-dependent `attempts.test.ts` flake is **fixed** — it was a real billing bug (the usage
window bounded by the API server's clock rather than the database's), not test ordering.

One unidentified failure in five full runs on 2026-09-05, name not captured, three clean runs after
it. Recorded rather than called resolved: an intermittent failure nobody has seen twice is not the
same as one that has gone.
