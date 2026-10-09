# ADR-0048 — a phone's stream follows its viewer's link

**Status:** Accepted · 2026-10-09 · extends M6 (ADR-0047's "next gap") · the narrow-link case that
motivated it is **not yet verified end to end in Chrome**; see the last section

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

**Not yet done:** the case that motivated it. That is Chrome on a link narrower than 4 Mbit/s,
relayed, with the stream stepping down until the round trip comes back to its floor, then stepping
up again once the link clears. Until that run, this ADR says what the code does, not that it fixes
the 1.7 s stall.
