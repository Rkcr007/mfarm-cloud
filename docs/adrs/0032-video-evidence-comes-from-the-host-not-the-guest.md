---
id: ADR-0032
title: Video evidence is recorded on the host by cvd's own recorder, and almost all of it is deleted
status: Accepted
date: 2026-09-07
authors:
  - Claude Code
tags: [video, evidence, cuttlefish, artifacts, execution]
extends: [ADR-0003, ADR-0005, ADR-0018]
---

## Context

Every virtual-device execution should leave a video a person can open to understand what happened.
`docs/EXECUTION_MODEL.md` §4.4 costed this in August 2026 and deliberately did not build it, for two
reasons that had to be settled separately.

**The first was whether recording changes what the test observes.** `deploy/measure-encode-cost.mjs`
measured the naive path on the farm and the answer was decisive: guest `screenrecord` costs the
Flutter canvas **a third of its frame rate** (29.9 → 20.0 fps) and doubles dropped frames on
ordinary UI while its fps holds — which is the quieter and more dangerous half, because
`docs/RENDER_BASELINE.md`'s warning is that the risk was never red suites but timing-sensitive
assertions silently reading a device three frames behind. `scrcpy` encodes in the guest too. So
guest-side encode was ruled out for virtual devices entirely, and S5 became a question about the
host.

**The second was storage.** §4.4's arithmetic, at an assumed 1 Mbps, exhausted the control plane's
24 GB in **1.3 days** at two saturated devices. That is a feature that fills a disk before anyone
notices it is on.

## Decision

**Recording is `record_cvd start|stop`, driving Cuttlefish's own host-side `RecordingManager`. Every
session is recorded and almost every recording is deleted.**

Cuttlefish's WebRTC streamer already receives every display frame **on the host** — that is why the
live view costs the guest nothing — and `RecordingManager` tees the same `VideoTrackSourceInterface`
into its own VP8 encoder and an mkvmuxer, writing
`<instance_dir>/recording/recording_<instance>_<display>_<ms>.webm`. It is reached over the
streamer's command channel by a tool that ships in the cvd host package. Nothing runs in the guest,
and **no viewer need be attached**: sources are registered when a display is published, not when a
browser connects, which is the property CI depends on and is not obvious from the interface.

Measured on `mfarm-lab`, 2026-09-07, three rounds per arm interleaved:

| arm | what | fps | dropped | artifact |
|---|---|---:|---:|---:|
| A | no recording | 29.9 | 84 | — |
| B | `screenrecord` (guest) | **20.0** | **137** | — |
| C | `record_cvd` (host, 1 device) | **29.8** | 83 | 304 KB |
| D | `record_cvd` (host, 4 devices) | **29.9** | 85 | 292 KB |

C is −0.2% against a baseline whose own rounds vary by ±0.2%; B reproduces §4.4's −33%, which is
what makes C and D believable rather than merely convenient.

**Record everything, keep almost nothing.** A recording cannot be made retroactively, so the choice
is not which sessions to record but which recordings to upload. `VIDEO_RECORDING` is
`off | failures | all`, defaults to `off`, and `failures` — the intended setting — keeps only
sessions whose suite reported a failure. The rule is `session_should_keep_video`, one function, and
per ADR-0018 it is exactly "the customer's suite reported at least one failure": the farm may not
claim a test failed, and a session that reported nothing keeps nothing rather than being inferred
either way.

**Three consequences follow from where the recorder lives, and each is a constraint rather than a
preference:**

1. **WebM/VP8, not MP4/H.264.** `LocalRecorder` hard-codes `SdpVideoFormat("VP8")` into a Matroska
   segment. Producing MP4 means a transcode on the device host — the CPU this design exists to
   protect. WebM plays natively in Chrome, Firefox, Edge and Safari 14.1+; iOS Safari is the honest
   gap, and the answer there is a remux at download time on the control plane, not on the farm.
2. **We do not control bitrate or frame rate.** They are fixed in cvd (1000 kbps start, 2000 max,
   the source's own resolution and rate). §4.4's plan to save cost with "10–15 fps at ~500 kbps" is
   not available through this path, and does not need to be: measured output is **~120 kbps on the
   highest-motion workload this farm has**, about eight times cheaper than the assumption, which
   moves a saturated farm from 1.3 days of disk to 11.
3. **A recording of a snapshot-restored device would be empty.** ADR-0007 measured that such a
   device publishes no display at all. The farm runs `CF_RESET_MODE=powerwash`, so this is currently
   moot — and it becomes a hard blocker the moment anyone switches back for the 10-second recycle.

**Starting is a request; stopping is not.** `video-start` joins the `app_actions` pipeline
(migration 045) and inherits its host scoping, fence check, capability check and coalescing.
**There is deliberately no `video-stop` verb.** Stopping has to happen on every path a session can
end — a timeout, a killed test process, a device fault, a reaper sweep — and the worker already has
a hook that runs on all of them (`captureArtifacts` on the CLEANING transition). A stop verb would
be a second mechanism that works in the common case and fails in precisely the cases video exists to
explain. The keep decision rides the reset offer beside it.

**CORRECTED 2026-09-07, hours after this was written.** The paragraph above said the teardown "runs
on every path a session can end", and that sentence was doing load-bearing work it could not carry.
It is true of the paths a SESSION takes and false of the paths an AGENT takes, and there were three
of the latter: an agent restarted mid-session lost the in-memory handle and left a recorder encoding
forever; a quarantine recovery resets down a branch that has no session and skipped the stop
entirely; and an upload that failed left a file referenced by no artifact row, invisible to every
other cleanup in the system.

**So the design is a reconciliation, not a promise that every caller remembers.**
`reconcileRecordings(maxAgeMs, { stopOrphans })` runs at agent startup — where a running recorder
cannot be ours, so stopping one is unambiguous — and again on every reset, where it sweeps by mtime
only and issues no stop, because there a recorder could be live. The recovery branch stops its own
recorder explicitly and discards it, since the fence has moved and there is no session to file it
against. That is the same shape as the reset sweep and for the same reason: a loop that converges on
the desired state beats a rule that every future caller has to remember.

The verb decision stands. What was wrong was not "no stop verb" — it was believing one code path
covered every case without checking.

## Consequences

**`recording` is a real capability again.** It sat in `CAPABILITIES` for months with nothing behind
it — the one place this codebase broke ADR-0003's rule that a capability is observed state — and
ADR-0027 removed it in place. It returns from `refreshRecordingCapability()`, which stats the tool on
disk, never from a static list: a host package built before `RecordingManager` replaced the old
`--record_screen` flag genuinely does not have it.

**A partial recording is evidence, and is labelled.** If `record_cvd stop` cannot reach the streamer
— the device crashed, cvd died — whatever mkvmuxer wrote is still on disk and is uploaded with
`context.partial`, which the console says out loud. It is never presented as the complete record of
an execution. A recording whose worker died without stopping it is swept at the next bring-up and
never uploaded, because nothing can vouch for what it contains.

**One clock, one subtraction.** A WebM stamps its first frame at zero, so the only thing relating a
video position to a test event is `videoStartedAt`, carried on the artifact's context. Every seek is
`reportedAt − startedAt`. Both ends are approximate in the same direction — the anchor to about a
frame interval, `reportedAt` to however long the suite took to report — so the console seeks five
seconds earlier, which is what a person wants anyway: the question is what happened *before* the
failure.

**Range requests are not optional.** Without `accept-ranges` Chrome will not seek a `<video>` at all
and downloads the whole file before it plays, which turns a one-click question back into a download
and a media player. `GET /v1/artifacts/:id/blob` now serves 206s for every kind.

**Video gets its own retention**, three days against fourteen. Sharing one number with logcat means
the disk conversation can only ever be had by shortening logcat too.

**What is still unmeasured.** Arm D recorded four devices but drove only one; the other three
publish almost no frames, so it demonstrates that three idle recorders are free and not that four
busy ones are. That number is worth taking before the farm runs saturated with recording on. The
mitigation if it fails is a cap on concurrent recordings, not abandoning the approach.
