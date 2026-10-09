# ADR-0048 — a phone's stream follows its viewer's link

**Status:** Accepted · 2026-10-09 · extends M6 (ADR-0047's "next gap") · **amended the same day
(D77–D79): a constant bitrate, a frame-rate ladder, the agent's own round trip and a consent wait
that allows for the queue. Verified in Chrome on the OnePlus over a 2 Mbit/s link**; see the last two
sections

## Context

Since M6 the agent is a phone's WebRTC peer, and it encoded the screen at a **fixed 4 Mbit/s**.
Nothing told the encoder when a viewer's link could not carry that. Measured on 2026-10-04 on a
3 Mbit/s downlink, through the relay:

- the round trip queued to **1.7 s**;
- Chrome asked for what it lost, and the retransmissions joined the same queue;
- **1,992 packets arrived, of which 106 were new.**

A fixed rate that is too high gives a stall, not a softer picture. Relayed viewers (ADR-0047) are the
ones most likely to be on such a link.

## Decision

**The agent moves the encoder's rate from what its viewers report.** `BitrateGovernor` in
`workers/agent/src/devices/phone-stream.ts` decides it, and `H264Fanout` puts it into effect.

1. **The signal is the queue, not an estimate.** The round trip of the RTCP sender and receiver
   reports travels with the media, so a congested link shows as the round trip rising above that
   viewer's own floor. Loss counts too, but only over 30 or more packets: on a still screen one
   lost packet out of two read as "50% lost". Chrome's REMB is not used. It starts near
   300 kbit/s and grows only while traffic flows, and a phone's screen is mostly still, so it reads
   as congestion at the start of every session.
2. **Five tiers: 4.0, 2.5, 1.5, 0.8 and 0.4 Mbit/s.** The rate never rises above the starting rate,
   and the resolution does not change: 576×1280 stays readable at the bottom tier.
3. **Down fast, up slowly.** Two congested reports in a row step down one or two tiers, depending on
   how deep the queue is, and steps down are at least 4 s apart. Up is one tier, after 15 s of a
   healthy link. A step up that fails within 20 s doubles the wait for the next one, up to 120 s,
   so the rate does not saw between two tiers on a link that sits between them.
4. **A queue the stream is not filling is not its to answer.** Below 30% of its rate, nothing steps
   down. Found live: on a still screen the round trip drifted from 115 to 300 ms on a home link at
   4 a.m., and the stream was stepped down twice for a queue it was not causing.
5. **One encoder per phone, so the slowest viewer sets the rate.** A viewer that leaves takes its
   vote with it.
6. **A new rate is a new scrcpy server.** scrcpy 4.1 has no control message for the bitrate; its
   message types were read from the jar. The old capture stops first, because a phone serves one
   server per forwarded port. Viewers keep their connections: the new encoder starts on a keyframe
   with its parameter sets, and the stream re-bases its clock, the same path a keyframe request
   takes.
7. **werift's sender clock is replaced (`fixSenderClock`)**, because the round trip is the signal and
   werift 0.24.4 got it wrong. Running it gave 4 ms and −56 ms on a path whose floor is about 90 ms.
   That was enough on its own to step a healthy stream down to 0.8 Mbit/s. There were two defects:
   - its NTP fraction is decimal digits written as binary;
   - the report's timestamp is the last RTP packet's, which repeats on a still screen.

**Knobs:**
- `PHYSICAL_VIDEO_BIT_RATE` sets the starting rate (default 4,000,000).
- `PHYSICAL_ADAPT_BITRATE=0` pins the stream at that rate, as before this ADR.
- `PHYSICAL_BITRATE_UP_HOLD_MS` sets the first wait before a step up.
- `PHYSICAL_VIDEO_CBR=0` leaves the encoder its own rate control (see the amendment).

## Rejected

- **Driving the rate from REMB.** It is wrong at the start of every session; see point 1.
- **Stepping one tier at a time on the way down.** A queue of seconds needs relief now, and the next
  step is four seconds away.
- **An encoder per viewer.** scrcpy binds one server per device (see `H264Fanout`), and a second one
  would fight the first for the port.

## Consequences

- **Every rate change is a short hitch.** It costs one encoder restart and one keyframe. That is why
  steps are rate-limited and steps up wait.
- **Every viewer of a phone gets the slowest viewer's picture.**
- **A restart that fails is not retried.** The viewers keep their connections, but their picture
  freezes until one of them reconnects, which starts a capture again. The agent logs
  `[video] restarting the encoder at … failed`.
- **The werift version stays pinned.** The governor reads private fields (`rtt`, the reports'
  `packetsLost`) and replaces `ntpTimestamp`. An upgrade has to re-check both.

## Verification

**Done:**
- 18 tests in `workers/agent/test/phone-stream.test.ts`. They cover the governor's decisions, the
  starting rate as a ceiling, a restart that keeps the viewers and the control socket, the
  still-screen guard, the off switch and the clock.
- Writing this ADR found that a start below the top tier was not a ceiling. With
  `PHYSICAL_VIDEO_BIT_RATE=2500000`, a clear link climbed to 4 Mbit/s. The test named "never above
  the start" only tried a start equal to the top tier. The start is now the top of the ladder, and a
  test fails without that change.
- On the OnePlus, the werift clock defects and the still-screen false step-down were each found by
  running it. That is what points 4 and 7 answer.

### In Chrome on a narrow link, 2026-10-09 — the verdict

**The control loop works; on this phone it cannot do its job.** The setup:
- the OnePlus 8T streams to Chrome, which is forced onto the relay over UDP;
- the screen is kept scrolling over adb;
- the agent's UDP to the relay is shaped on the Mac with dummynet to 2 Mbit/s, with 400 KB of
  buffer, which is about the 1.7 s queue of the original measurement;
- the agent runs `main` at `4e271dc`.

| Phase | What happened | Verdict |
|---|---|---|
| **A** — clear link, adaptation on | 4.8 Mbit/s received at 60 fps; round trip 73–75 ms; 0 lost, 0 NACKs, 0 freezes; no rate change. The agent's round trip matched Chrome's (69–72 ms), where werift had read 4 ms or −56 ms before `fixSenderClock`. | **Pass**: no false step-down. |
| **B** — 2 Mbit/s link, adaptation on | Steps 4 → 2.5 → 1.5 → 0.8 → 0.4 Mbit/s in about 16 s, each a scrcpy restart, and the viewer stayed connected through them. At 20 s: 57 fps, 0 lost, 0 freezes. But the round trip held at 600–945 ms, because the encoder kept producing about 2 Mbit/s at the 0.4 tier (**D77**). All four decisions cited the same frozen 266 ms (**D78**). Within the 2 min 17 s the link stayed narrow, werift's consent expired and the view closed (**D79**). | **Fail**: the queue never drained. |
| **C** — link cleared | Back up one tier per 15 s, 0.4 → 0.8 → 1.5 → 2.5 → 4.0, with the round trip at 62–72 ms throughout. | **Pass**. |
| **D1** — 2 Mbit/s link, adaptation OFF | Within 14 s: 16.8 fps, two freezes totalling 9.4 s, 3,371 packets lost, 1,101 NACKs. At 30 s: 1.2 fps and a 730 ms round trip. Then 0 fps, consent expired (**D79**), and the view closed. | The stall it was built for, reproduced. |
| **D2** — clear link, pinned at 0.4 Mbit/s | 2.1–2.5 Mbit/s received at 60 fps, with scrcpy confirmed at `video_bit_rate=400000`. | Settles **D77**: the floor is the encoder, not the link. |

**What it bought.** Against the same link with adaptation off, the adaptive stream replaced heavy
loss and multi-second freezes with a smooth but delayed picture. That lasted until D79 closed it.

**What it did not.** The round trip never came back to its floor, so it did not fix the 1.7 s stall.

**Before this ADR's claim holds:**
- **D77:** a lever the encoder obeys, most likely frame rate.
- **D78:** a round trip the agent computes itself, from LSR and DLSR.
- **D79:** a consent wait that allows for the queue.

None of these needs a new decision: each one completes this one.

## Amendment, 2026-10-09 — what it took, and the run that shows it works

**D77: the encoder is asked for a constant bitrate, and the bottom tiers drop the frame rate.**
Measured on the OnePlus first, with `createCapture` alone and the screen scrolling:

| | 60 fps | 30 fps | 20 fps | 15 fps | 10 fps |
|---|---|---|---|---|---|
| default rate control, floor | ~2.0 Mbit/s | ~1.7 | ~1.4 | 1.22 | 0.93 |
| constant bitrate, floor | 1.37 | 0.80 | 0.58 | 0.44 | 0.40 |

- Frame rate alone is a weak lever: halving it cut the output by about 15%. The encoder clamps its
  rate rather than spending a budget per frame.
- A constant bitrate (MediaFormat `bitrate-mode` 2, passed through scrcpy's `video_codec_options`)
  holds every target down to its frame rate's floor.
- So each rate runs at the highest frame rate whose floor is under it (`frameRateFor`): 4, 2.5 and
  1.5 Mbit/s at 60 fps, 0.8 at 30, and 0.4 at 15. The tiers produced 4.13, 2.66, 1.49, 0.81 and
  0.44 Mbit/s.
- On a still screen a constant bitrate costs 0.03–0.18 Mbit/s against 0.02–0.05: it does not pad.
- **An encoder that refuses a constant bitrate falls back to its own rate control**, once, and keeps
  it. Only the OnePlus has been run, and without the fallback, a refusal would mean no live view at all.
- The size does not change.

**D78: the round trip is the agent's own.** `fixSenderClock` now logs every NTP time it hands werift.
A receiver report's LSR is looked up in that log, so an echo of an older sender report still gives
the round trip, queue and all. werift's `rtt` is no longer read.

**D79: the ICE pair is given that round trip** (`stretchConsentWait`). werift's consent wait,
2 × the pair's `rtt` + 200 ms, then grows with the queue.

**Three changes to the governor, all found running the above:**
- **A step up that fails goes back to the tier it came from.** By the queue's depth, a failed probe
  from 1.5 to 2.5 had gone on down to 0.8.
- **A queue that is visibly draining is given 8 s, not 4,** before a second step down. Draining means
  the round trip is under four fifths of what it was at the step. Without this, a working step to 1.5
  was followed by a second one, to 0.4 Mbit/s and 15 fps.
- **The doubled wait goes back to 15 s once a step up holds for 20 s.** It had stayed doubled for
  good, so a link that cleared took a minute per tier to climb back.

**Verified in Chrome on the OnePlus,** under the same conditions as the verdict above:

| | Before | After |
|---|---|---|
| Clear link | 4.8 Mbit/s (bursts to 6.9), 60 fps, 73–75 ms | 4.17 Mbit/s, 59.8 fps, 64 ms; the agent's round trip matches Chrome's |
| 2 Mbit/s link | steps to 0.4 Mbit/s, the queue never drains (600–945 ms), the view closes | one step, 4 → 1.5 Mbit/s (citing 1,187 ms). Then 1.5 Mbit/s at 60 fps, 60–100 ms, 0 loss, 0 freezes in Chrome. Probes to 2.5 fail back to 1.5, waiting 15, 30, then 60 s |
| Link cleared | a minute per tier | 1.5 → 2.5 → 4.0, the second step 15 s after the first; full rate about 25 s after the link cleared |
| 2 Mbit/s, adaptation off | 16.8 fps, then 0; the view closed (D79) | a 1.7 s queue held for 80 s (the agent read 1,560–1,698 ms against Chrome's 1,698), no `viewer failed`; back to 60 fps and 4 Mbit/s by itself when the link cleared |

Tests: each fix's tests fail with that fix removed, eight mutations in all. That includes a real werift
receiver report echoing an older sender report, which werift ignores and the agent measures.
