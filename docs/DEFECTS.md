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
| D8 | **S2** | Whole console | A person who belongs to more than one org cannot tell which one they are in, and cannot switch. The org name appears only in the avatar's `title` tooltip. Their sessions, keys and apps silently belong to an org they did not choose — this cost me an hour of exploration against the wrong tenant. | exploratory session |
| D9 | S3 | Health | Zero actionable controls on the page. A device whose check failed is named and cannot be opened from the row it is named in. | clicking every control |
| D10 | S3 | Cockpit (ended) | The stage keeps its full height on an ENDED session, so the accounting below it — held for, actions, artifacts, reset — sits under a full-screen dead phone and is never seen without scrolling. Document 04 S4 puts the numbers beside the frame. | exploratory session |
| D11 | S3 | Cockpit (ended) | The device rail renders every control on an ended session. They are disabled, which is right for a capability gap (stage 5) but not for this: document 04 S4 says "the live view and controls are gone", because none of them will ever work again for this session. | exploratory session |

## Fixed, awaiting verification on the farm

| # | Sev | What | How it was found |
|---|---|---|---|
| D5 | S3 | Fleet rows carried a `Details` button beside a device name that links to the same page — two controls, one destination, on every in-use row. The name is the only link now. | clicking every control |
| D6 | S3 | The Apps empty state offered "Go to Devices" pointing at `#/devices`. The route redirects so it worked, but the surface has been called Fleet since the IA change. | clicking every control |
| D7 | **S2** | "Find machine" with an empty code field returned silently — no error, no hint, nothing moved. Pressing the button before filling the field is the first thing a person does, and no test covers it. | clicking every control |
| D12 | **S1** | A session's length was rendered as `mm:ss`, so "Released by you at 14:29, after 20:00" read as two clock times. `clock()` stays where a number ticks; prose gets words. | reading a real ended session |

## Closed

| # | Sev | What | Fixed in |
|---|---|---|---|
