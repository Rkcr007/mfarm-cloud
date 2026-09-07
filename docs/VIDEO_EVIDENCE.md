# S5 — Video evidence for virtual-device executions

**What this is.** The architecture findings `virtualdevicevideoevidence.md` asks for before any code
is written, plus the implementation plan they lead to. Produced 2026-09-07 at `796a6f0` by reading
this repository and the `android-cuttlefish` sources, not by assuming from filenames.

**The headline.** Cuttlefish already contains a host-side recorder that tees the existing WebRTC
video source and writes WebM/VP8 on the host. It is present in the version we run, it works with no
viewer attached, and **it costs the guest nothing** — 29.9 fps recorded against 29.9 fps not,
measured on the farm across twelve rounds while the same workload under `screenrecord` loses a third
of its frame rate. So S5 is mostly plumbing: a `cvd` invocation, a new artifact kind, and a
`<video>` tag.

**Everything in §7 was measured on `mfarm-lab` on 2026-09-07.** Where this document still says
"unverified", it means it.

---

## 1. The existing architecture

### A. Video source — the actual path

Traced through `android-cuttlefish` `base/cvd/cuttlefish/host/frontend/webrtc/`:

```text
Guest display (SwiftShader → virtio-gpu)
     ↓   shared memory / vsock, owned by crosvm
ScreenConnector<WebRtcScProcessedFrame>            host/libs/screen_connector
     ↓   DisplayHandler::GetScreenConnectorCallback()
DisplayHandler                                     webrtc/display_handler.{h,cpp}
     │   holds display_last_buffers_ + RepeatFramesPeriodically()
     ├──────────────┬────────────────────────┐
     ▼              ▼                        ▼
display_sinks_   ScreenshotHandler        RecordingManager
(VideoSink per   (screenshot_handler.h)   (libdevice/recording_manager.{h,cpp})
 connected                                    │
 client)                                      ▼
     ▼                                   LocalRecorder
VideoTrackSourceImpl                     (libdevice/local_recorder.{h,cpp})
     ▼                                        │
libwebrtc encoder (VP8)                  its OWN VP8 encoder + encode thread
     ▼                                        ▼
PeerConnection → browser                 mkvmuxer → recording_<instance>_<label>_<ms>.webm
```

**Everything above the guest boundary is already on the host.** The guest hands over raw frames and
does no encoding for the live view — which is why the live stream costs the guest nothing while
`screenrecord` costs it a third of its frame rate (`docs/RENDER_BASELINE.md`).

`DisplayHandler` is the fan-out point and it **already has three consumers**, not one. The
screenshot path is the precedent that matters: it is a non-WebRTC consumer, tee'd off the same
frames, driven from outside the process. A recorder is not a new shape of thing here.

### B. Encoder

`LocalRecorder::Impl` creates its own encoder:

```cpp
display->video_encoder_ = impl_->encoder_factory_->CreateVideoEncoder(
    webrtc::SdpVideoFormat("VP8"));
codec.startBitrate = 1000;   // kilobits/sec
codec.maxBitrate   = 2000;
```

- **Codec: VP8, software, host-side.** This matches what the live stream negotiates — HANDOFF
  measured `50 fps, 1080×2340, VP8` on 2026-08-29.
- **H.264 is not offered by this path.** libwebrtc's H.264 support depends on OpenH264 being
  compiled in, and `LocalRecorder` hard-codes VP8 regardless.
- **Container: Matroska/WebM**, written with `mkvmuxer::Segment` + `MkvWriter`.
- Frames reach it by `OnFrame()` → `encode_queue_` → a dedicated `EncoderLoop()` thread →
  `OnEncodedImage()` → `segment_.AddFrame(data, size, track, timestamp, is_key)`.

**The encoded packets are NOT shared with the live stream.** This is the one place the brief's
preferred design ("reuse the existing encoded stream") does not match reality: `RecordingManager`
takes a `webrtc::VideoTrackSourceInterface`, i.e. the *decoded frame source*, and encodes a second
copy. So recording costs one extra software VP8 encode **on the host**, per recording device.

That is the right trade anyway. Reusing the live stream's encoded packets would mean the recording
inherits the live stream's bitrate adaptation, its keyframe cadence, and — critically — its
*existence*: no viewer, no encoder, no recording. A CI run has no viewer by definition.

### C. WebRTC integration and the control surface

`webrtc_commands.proto` defines exactly three commands over the streamer's command channel:

```proto
StartRecordingDisplayRequest   {}
StopRecordingDisplayRequest    {}
ScreenshotDisplayRequest       { display_number, screenshot_path }
```

and `host/commands/record_cvd/record_cvd.cc` is the CLI that sends the first two. **Both it and
`libdevice/{local_recorder,recording_manager}.{h,cpp}` are present at tag `v1.55.1`, the version this
farm runs** — checked against the tag, not against `main`:

```text
record_cvd start          # --instance_num=N, --wait_for_launcher=<seconds>
record_cvd stop
```

It resolves the instance through `config->ForInstance()` and calls `StartScreenRecording()` /
`StopScreenRecording()`. **No client need be connected**: `RecordingManager::AddSource()` is called
when the streamer registers a display, not when a browser attaches, and `Start()` iterates
`sources_` — so recording a device nobody is watching is the ordinary case, not a special one.

Output path is `PerInstancePath("recording/")`:

```text
<HOME>/cuttlefish/instances/cvd-<n>/recording/recording_<instance>_<label>_<ms>.webm
```

`cuttlefish.ts` already knows both halves of that path — `instanceNum` and the group `HOME` (it
carries `HOME` for `snapshotIsStale`, and computes `<HOME>/cuttlefish/instances/cvd-<n>`).

**The binary is invoked by path, not from `PATH`.** The host tools come from
`cvd-host_package.tar.gz` (build 16102939), unpacked into `imageDir`, which is why every `cvd` call
in `cuttlefish.ts` passes `--host_path=${imageDir}`. So the recorder is `${imageDir}/bin/record_cvd`,
and its version tracks the **Android build**, not the `cuttlefish-base` deb — the two are pinned
separately and only one of them is `1.55.1`.

### D. Execution lifecycle, mapped onto our code

```text
POST /v1/sessions            apps/api/src/http/routes/…      session QUEUED
promote_queued / allocate    apps/api/src/allocator.ts       ALLOCATING, fence issued
worker beat picks it up      workers/agent/src/agent.ts      device leased
  ── mfarm:appId install     app_actions 'install'
hub creates WebDriver sess.  apps/api/src/http/routes/webdriver.ts   session_activate → ACTIVE
  ── test runs               session_commands (041) recorded per command
POST /sessions/:id/result    test_results (021/024)          pass | fail
  └─ on 'failed' → request_capture(screenshot) + request_capture(logcat)   (040)
session ends                 device → CLEANING
  └─ captureArtifacts()      workers/agent/src/agent.ts:1076  final screenshot + logcat
  └─ uploadArtifact()        POST /v1/…/artifacts → artifact_record()      (040, 10 args)
device reset                 powerwash, ~40s
```

The two hooks a recorder needs already exist and are load-bearing:

- **start**: the worker knows the exact moment a device is leased to a session, before the hub opens
  the WebDriver session. Nothing new has to be invented to know when a test begins.
- **stop + finalize**: `captureArtifacts()` runs on the `CLEANING` transition and is reached from
  *every* exit — pass, fail, timeout, cancel, expiry sweep, quarantine. It is already the
  "whatever happened, the device is coming back" hook, and it already has the swallow-and-continue
  discipline a recording finalizer needs.

---

## 2. Recommended interception point

**`record_cvd start|stop`, invoked by the worker agent, with the `.webm` uploaded as a new artifact
kind.** The agent never touches a frame; `cvd` writes the file and the agent reads bytes off disk —
which is exactly the invariant `device.ts` states and `capture.ts` already honours for physical
devices.

Concretely the recorder attaches at `workers/agent/src/devices/cuttlefish.ts`, as two methods on the
existing device control interface, beside `screenshot()` and `logcat()`.

**Why not the other candidates:**

| Option | Verdict | Why |
|---|---|---|
| guest `screenrecord` | **rejected, measured** | −33% fps on the Flutter canvas, 96.8% jank on a native list. `deploy/measure-encode-cost.mjs`, reproduced 3×. |
| `scrcpy` | **rejected** | also encodes in the guest; same cost, plus a version-matched server jar. Stays for physical devices, where the encoder is dedicated silicon. |
| headless WebRTC peer on the host (werift / libdatachannel) | **rejected** | ~600 lines of new transport, a second signaling client, RTP depacketization and a mux we would own — to arrive at the same VP8 bytes `LocalRecorder` already writes. It would also make recording depend on a peer connection staying up. |
| host-side raw-frame capture (a new `VideoSink` in cvd) | **rejected** | requires patching and shipping our own `cvd`. `RecordingManager` is that patch, already upstream. |
| reuse the live stream's *encoded* packets | **rejected, and it is what the brief asked for** | those packets exist only while a browser is attached, and they carry the live stream's adaptive bitrate. CI has no browser. |
| **`record_cvd` → `RecordingManager` → `LocalRecorder`** | **chosen** | host-side, zero guest work, upstream-maintained, one process invocation, real per-frame timestamps. |

---

## 3. Timestamps — the clock model

One reference clock: **the session's wall clock, anchored once.**

`LocalRecorder` writes `segment_.AddFrame(..., timestamp, is_key)` from the WebRTC frame's own
timestamp, so the WebM already carries true variable-rate presentation times — dropped and repeated
frames stay representable, and nothing is derived from `frame_number × interval`. What it does *not*
carry is any relationship to our execution timeline.

So the agent records **`videoStartedAt`** — the host's wall-clock time immediately after
`record_cvd start` returns — and stores it on the artifact's `context` jsonb (migration 040 added
that column for exactly this class of "why/when was this captured"). Every timeline position is then:

```text
videoPositionMs = eventAt − videoStartedAt
```

where `eventAt` comes from `execution_events.occurred_at`, `session_commands`, or
`test_results`. The anchor is a single subtraction against rows we already write, and it degrades
honestly: if the anchor is missing the player simply opens at 0 rather than seeking to a lie.

**The known error term, stated rather than hidden.** `record_cvd start` returns when the streamer
acknowledges, and the first frame reaches the encoder some milliseconds later; on a device that is
idle, `RepeatFramesPeriodically()` means the first frame may be a repeat of an older one. So the
anchor is accurate to roughly a frame interval, not to a millisecond. That is well inside what
"what happened just before the failure" needs, and it must not be represented as more.

---

## 4. Format

**WebM/VP8, as written.** Not MP4/H.264, and the tradeoff the brief asked to be explained:

- **For us**: it is what the existing host-side encoder produces. Choosing MP4 means remuxing (VP8
  in MP4 is not broadly playable) or transcoding — a second encode on the same host CPU we are
  trying to protect, for a format difference no user sees.
- **Browser playback**: WebM/VP8 plays natively in Chrome, Firefox and Edge, and in Safari 14.1+ on
  macOS. Seeking works; the muxer writes cues.
- **The honest gap**: Safari on iOS is unreliable for VP8, and some corporate video tooling expects
  MP4. If that becomes a real complaint the answer is an offline `ffmpeg -c:v copy`-style remux or a
  transcode **on the control plane at download time**, not on the device host.

Ranked against the brief's own priorities — reliability, browser playback, CPU impact, storage,
complexity — WebM wins on three of five and ties on the second. MP4 wins only on compatibility.

**Measured output**, from the runs above: VP8, 720x1280, ~300 KB for a ~20-second round of
*continuous canvas drawing* — roughly **120 kbps on the highest-motion workload this farm has**.
`ffprobe` on one recording: variable frame rate, first frame a keyframe stamped 0, three keyframes
in 19.6s, seeking works.

---

## 5. Storage and retention — the part that decides whether this is affordable

`docs/EXECUTION_MODEL.md` §4.4 did this arithmetic against an assumed 1 Mbps, and the assumption was
**about eight times too pessimistic**:

| Load | @1 Mbps (§4.4's assumption) | @120 kbps (measured) |
|---|---|---|
| 50 sessions/day | 1.9 GB/day — 24 GB gone in ~13 days | 0.23 GB/day — ~104 days |
| two devices saturated (~480/day) | 18 GB/day — **~1.3 days** | 2.2 GB/day — ~11 days |

The measured rate comes from the *worst* workload for motion, so it is an upper bound for UI testing
rather than a favourable sample. This does not make retention optional — 11 days is still a disk
that fills — but it moves video from "fills the disk before anyone notices" to "ordinary retention
policy".

**You cannot retroactively record, so the policy is record-always, keep-on-failure.**

```text
session leased      → record_cvd start
test reports failed → mark the session's recording as KEEP
session ends        → record_cvd stop, then:
                        KEEP  → upload as artifact kind 'video'
                        else  → delete the .webm on the device host, upload nothing
```

Migration 021 (`test_results`) is what makes "did this session fail" answerable at stop time, and
migration 040's `request_capture` already demonstrates the control plane telling a worker to keep
evidence off the result POST. The same signal drives this.

Three limits to set deliberately:

- `ARTIFACT_MAX_UPLOAD_BYTES` is 64 MB; at ~1 Mbps that is ~8.5 minutes. A longer session must be
  **truncated at the source with the truncation recorded**, never silently uploaded short.
- Video retention in **days**, not the fortnight logcat gets — a separate `VIDEO_RETENTION_HOURS`,
  because sharing `artifactRetentionHours` makes the disk arithmetic above unfixable without
  shortening logcat too.
- The artifact JSON gains `durationMs` and `fps` in `context`, per the brief's §8 shape.

---

## 6. Failure handling

| Case | What stops the recording | Result |
|---|---|---|
| pass | `captureArtifacts()` on CLEANING | stopped, file deleted (unless retention is "all") |
| test failure | same hook | stopped, uploaded, `context.source = 'test-failure'` |
| timeout / cancel | same hook — the reaper's release path reaches it | stopped, uploaded |
| device crash / `cvd` dies | `record_cvd stop` fails; the `.webm` on disk is whatever mkvmuxer flushed | uploaded as `context.partial = true` |
| worker process dies | nothing runs | orphan `.webm` swept at next bring-up; **never uploaded**, because nothing can vouch for it |

**A partial file is never silently a valid artifact.** mkvmuxer finalizes the segment on `Stop()`; a
file that never got one is playable-ish but has no duration and no cues. Any recording that did not
stop cleanly is uploaded with `context.partial = true` and the console labels it, or is discarded —
it is never presented as the complete record of an execution.

---

## 7. Performance test plan — the thing that must not be assumed

**The claim "host-side encode is free for the guest" is not obviously true on this box, and it is
exactly the shape of false premise that has cost this project seven shipped defects.** `mfarm-lab`
is 16 vCPU with **no GPU**: crosvm, SwiftShader's software rendering, Appium and now a software VP8
encoder all contend for the same cores. Recording four devices at 1080×2340×50fps could perturb the
guest through host CPU starvation even though nothing was added inside the guest.

So the gate is measured, with the instrument that already exists:

`deploy/measure-video-cost.mjs`, built by extending `measure-encode-cost.mjs` (import its parsers,
do not copy them — same reasoning as before, and it keeps the numbers comparable to
`RENDER_BASELINE.md`):

| Arm | What runs |
|---|---|
| A | canvas workload, nothing recording — reproduces the baseline |
| B | canvas workload, `screenrecord` — the known-bad control, so the scale is anchored |
| C | canvas workload, `record_cvd` on **this** device |
| D | canvas workload, `record_cvd` on **all four** devices — the contention case |

Measured per arm: guest fps and dropped frames (`dumpsys SurfaceFlinger --latency`, **not**
`gfxinfo` — it cannot see Flutter), host CPU and load, encoder thread CPU, artifact size, recording
duration vs wall clock, and the count of frames in the WebM against frames the guest produced.

**Acceptance:** arm C is statistically indistinguishable from A on guest fps and dropped frames, and
arm D degrades A by less than the jitter between A's own repetitions. If D fails, the answer is a
device-count cap on concurrent recordings, not shipping it anyway.

### The result — `mfarm-lab`, 2026-09-07, 3 rounds per arm interleaved

| arm | what | fps | jank | dropped | host cpu | artifact |
|---|---|---:|---:|---:|---:|---:|
| A | no recording | 29.9 | 100.0% | 84 | 31.7% | — |
| B | `screenrecord` (guest) | **20.0** | 100.0% | **137** | 35.2% | — |
| C | `record_cvd` (host, 1 device) | **29.8** | 100.0% | 83 | 33.2% | 304 KB |
| D | `record_cvd` (host, all 4 devices) | **29.9** | 100.0% | 85 | 33.2% | 292 KB |

**C is −0.2% and D is −0.0% against a baseline whose own rounds vary by ±0.2%.** B reproduces
−33.2%, which is `docs/EXECUTION_MODEL.md` §4.4's number to within a rounding step and is what makes
the other two columns believable rather than merely favourable. **The gate is passed: host-side
recording does not perturb the device under test.**

Host CPU costs about **1.5 points of a 16-core machine** while recording. Recording four devices
costs the same as recording one, because the other three publish almost no frames — see the caveat
below.

### Three things this measurement got wrong first, all of which read as a real result

Recorded because each one produced a confident number that was false, and the first two nearly ended
this work in the wrong place.

- **The first four-arm run reported host-side recording costing 31% of the frame rate.** It was
  contamination: `measure-encode-cost.mjs` stopped arm B by killing the local `adb exec-out` client,
  which does NOT reliably kill `screenrecord` inside the guest, and the orphan keeps encoding until
  the platform's 180-second cap. It ran through the arms that followed. An A/C-only run — which
  never starts `screenrecord` — then reproduced 0.1% across twelve rounds. The fix is a
  `pkill -f screenrecord` in that arm's teardown, and **arm B's own number is unchanged by it**,
  which is what says the fix did not simply flatter the result.
- **The artifact column read "no file" while six real recordings sat on disk.** The lookup returned
  the first group directory it found rather than searching all of them. A broken size instrument
  reads exactly like a recorder that never ran, which is the most expensive way for a measurement to
  be wrong: it corroborated the false 31%.
- **Host CPU appeared LOWER while recording than while not.** The window bracketed the whole round,
  including ~4s of deliberate idle waiting that only the recording arms have. Sampling across the
  gesture alone gives the honest +1.5 points above. "Recording makes the host cheaper" is the kind
  of result that should never have survived one minute of thought, and it survived a whole table.

### What this measurement does NOT prove

**Arm D records four devices but drives only one.** The other three sit idle, and an idle Cuttlefish
publishes almost no frames — measured, an untouched device records a 110-byte empty container. So D
demonstrates that three idle recorders are free; it does **not** demonstrate four busy ones. The
true contention case is four concurrent suites, which needs four driven devices and is worth
measuring before the farm runs saturated with recording on.

---

## 8. Implementation plan — PR-sized

| # | Change | Proves |
|---|---|---|
| **0** | ~~Lab probe~~ — **DONE 2026-09-07.** `record_cvd` present, `start`/`stop` verified against a live device with no viewer, output plays. | The whole plan. |
| 1 | ~~`cuttlefish.ts`: `startRecording()` / `stopRecording({keep})`~~ — **DONE.** Invokes `${imageDir}/bin/record_cvd`, finds the `.webm` that was not there before, deletes it unless kept. Seven tests. | Step 1 of the brief, standalone. |
| 2 | ~~`deploy/measure-video-cost.mjs`, arms A–D~~ — **DONE, PASSED.** | §7. **Gate: passed, so the steps below may ship.** |
| 3 | ~~Migration 045~~ — **DONE.** `'video'` in `artifacts.kind`, `'video-start'` on the action pipeline mapped to the `recording` capability, `session_should_keep_video`, `VIDEO_RECORDING` and `VIDEO_RETENTION_HOURS`. | The retention model. |
| 4 | ~~Agent lifecycle~~ — **DONE.** `video-start` on the beat; stop in `captureArtifacts()` before anything that can hang; upload-or-delete on the keep flag; `context.partial`. | §6. |
| 5 | ~~API~~ — **DONE.** `video` in `KINDS`, `video/webm`, its own retention, and **range requests** on the blob route. | §5, §9. |
| 6 | ~~Console~~ — **DONE.** A `<video controls preload="metadata">` in the Evidence card. Play/pause/seek/clock/fullscreen are the browser's. | Brief §9. |
| 7 | ~~Seek-to-failure~~ — **DONE.** A button per reported failure, seeking `reportedAt − startedAt − 5s`. | Brief §5, and the reason the anchor exists. |

**All of it is built, deployed, and verified end to end on the farm — 2026-09-07, `5c6ac36`.**
`deploy/verify-video.mjs` drives the whole chain against a real Cuttlefish through the real hub:

```text
17 passed, 0 failed
  ✓ a video-start action was queued for this session
  ✓ the worker started the recorder
  ✓ video artifact f8223720…, 271 KB
  ✓ it carries the start instant every seek is relative to
  ✓ the failure locates inside the recording (21.6s in)
  ✓ the bytes are a real Matroska/WebM container
  ✓ a range request is served as a 206
```

The artifact itself, pulled off the farm and probed: **VP8, 720×1280, 21.9s, 156 frames, 277 KB**,
and a frame extracted at 18s is the device's launcher — real evidence, not a black container.

**One defect was found by doing this that no test could have.** `VIDEO_RECORDING=failures` was set
in `deploy/.env` and the API never saw it: `.env` is *compose's* env file, and compose passes
nothing to a service that does not name the variable under `environment:`. The farm was configured
to record, recorded nothing, and reported no error — there is nothing to log, because falling back
to a documented default is exactly what the code should do. Fixed in `docker-compose.prod.yml` with
a test that checks the **deployment** rather than the code (PR #138).

**Range requests (step 5) are not optional.** Without `Accept-Ranges`, Chrome downloads the whole
file before it will play and cannot seek at all — which turns "what happened before the failure?"
back into a 40 MB download.

---

## 9. Risks

- **Host CPU contention** — **measured at +1.5 points of a 16-core host per recording, with no
  effect on guest fps** (§7). The residual is that arm D drove only one of four devices, so four
  BUSY recorded devices remain unmeasured. That is the number to take before the farm runs saturated
  with recording on; the mitigation if it fails is a concurrency cap, not abandoning the approach.
- ~~**The binary may not be in our host package.**~~ **CLOSED 2026-09-07.**
  `~/cf/image/bin/record_cvd` is present on the farm, `start`/`stop` work against a live device with
  no viewer attached, and the output plays. The tool is pinned by the Android build (16102939), not
  by the deb version, so a host-package upgrade is the thing that could take it away again.
- **A snapshot-restored device publishes no display** (ADR-0007, measured) — so it publishes no
  frames to record either. The farm runs `CF_RESET_MODE=powerwash`, so this is currently moot, and
  it becomes a hard blocker the moment anyone switches back for the 10s recycle.
- **Disk on the device host**, not just the control plane: `.webm` files accumulate under each
  instance's `recording/` until deleted. A crashed worker leaves them. The bring-up sweep must clear
  them, and `farm-check.sh` should count them.
- **Storage growth on `mfarm-cp`** — §5's whole point. Keep-on-failure plus short retention, or the
  disk fills in a day and takes the database with it.
- **Timestamp drift** — bounded and stated in §3; the anchor is host wall clock and the host's clock
  is NTP-disciplined. A device host whose clock steps mid-session would skew seeks; worth an assert
  that `videoStartedAt` precedes every event it is subtracted from.
- **Concurrent recordings** — one `LocalRecorder` per display per instance, four instances. They do
  not share state, but they do share cores; the cap in §7 is the control.
- **We do not control the bitrate.** `LocalRecorder` hard-codes 1000/2000 kbps and takes the source's
  resolution and frame rate. §4.4's plan to save cost with "10–15 fps at ~500 kbps" is **not
  available through this path** without patching cvd. The saving has to come from keep-on-failure
  and retention instead, which is where most of it was anyway.

---

## 10. What this deliberately does not become

Per the brief's §4 and ADR-0003's habit of writing the boundary down: no video analytics, no visual
regression, no frame diffing, no streaming infrastructure, no editing, no cloud recording service,
and no second display-capture architecture. S5 is one file per failed execution and a `<video>` tag
pointing at it.
