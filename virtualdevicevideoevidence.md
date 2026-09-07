# S5 — Virtual Device Execution Video Evidence

## Context

We are building a self-hosted Android virtual-device farm using **Cuttlefish**.

A core product requirement is:

> Every virtual-device test execution should produce video evidence that the user can open later to understand and debug what happened during the test.

This is not a nice-to-have. Video evidence is part of the execution/debugging experience.

However, video capture must be **non-intrusive**. The act of recording must not materially change the behavior or rendering performance of the virtual device under test.

We have already measured the obvious guest-side approaches:

- `screenrecord`
- `scrcpy`

Both perform encoding in the guest.

Measured impact while recording:

| Metric | Normal | Recording | Impact |
|---|---:|---:|---:|
| Flutter canvas FPS | 29.9 | 19.9 | −33% |
| Ordinary UI jank | 56% | 97% | ~1.7× |
| Dropped frames | baseline | 2.4× | significant |

The dangerous result is not merely reduced FPS. Ordinary UI can retain apparent FPS while jank and dropped frames increase dramatically. This can cause the automation system to observe UI state that is behind the actual device state.

Therefore:

## HARD DECISION

### Do NOT use:

- Android guest `screenrecord`
- `scrcpy` as the recording mechanism
- any approach that performs video encoding inside the Android guest
- any architecture that requires the application under test to participate in recording

### Target architecture

Use **host-side video capture/encoding**, preferably by reusing the existing **Cuttlefish/WebRTC video pipeline and encoder**.

Cuttlefish already has a host-side video path capable of approximately **49–53 FPS** in our environment.

The goal is to capture that video stream without introducing meaningful load into the guest.

---

# Your Mission

Explore the existing repository and implementation first.

Do NOT immediately start coding.

Determine the smallest, cleanest architecture that allows us to:

1. capture the Cuttlefish virtual display/video stream on the host,
2. encode it without guest-side CPU/GPU impact,
3. associate the recording with a specific test execution,
4. finalize the recording when execution ends,
5. expose the resulting video as an execution artifact,
6. allow a user to replay it later for debugging.

The solution should be practical for our current product rather than a generalized video platform.

---

# Phase 1 — Repository/Architecture Investigation

Inspect the entire relevant Cuttlefish video path.

Find and document:

### A. Video source

Identify exactly:

- where Cuttlefish obtains display frames,
- how frames leave the guest,
- how they reach the host,
- where WebRTC receives them,
- what component owns the video frames,
- whether there is an existing frame sink/callback/interface that can be reused.

Trace the actual code path.

Do not rely on filenames or assumptions.

Produce:

```text
Guest display
    ↓
?
    ↓
?
    ↓
Host video pipeline
    ↓
WebRTC
    ↓
Encoder
    ↓
?
```

with actual classes/functions/files.

### B. Encoder

Find:

- the existing encoder implementation,
- codec(s) supported,
- whether H.264 is available,
- whether VP8/VP9/AV1 is available,
- hardware vs software encoding,
- how frames are passed to the encoder,
- whether encoded packets are already exposed anywhere.

Determine whether we can reuse the existing encoded stream instead of encoding a second copy.

### C. WebRTC integration

Determine:

- where the video track is created,
- how frames are published,
- whether the host already has access to the encoded output,
- whether WebRTC exposes an appropriate observer/sink,
- whether we can add a recording sink without disrupting the live stream.

Prefer **teeing an existing stream** over creating a second rendering/encoding pipeline.

### D. Execution lifecycle

Find our test execution/job lifecycle.

Determine:

```text
execution created
      ↓
device allocated
      ↓
test starts
      ↓
video recording starts
      ↓
test runs
      ↓
test completes/fails
      ↓
video recording finalized
      ↓
artifact stored
      ↓
execution result references artifact
```

Map this onto the existing code.

---

# Phase 2 — Architecture Proposal

After investigation, propose the smallest viable implementation.

The preferred architecture should look conceptually like:

```text
                 Cuttlefish
                     │
              Android display
                     │
                     ▼
             Host video pipeline
                     │
                     ▼
              Existing WebRTC
                video frames
                     │
              ┌──────┴──────┐
              │             │
              ▼             ▼
          Live stream    Recording sink
                            │
                            ▼
                     Host-side encoder
                            │
                            ▼
                       MP4/WebM
                            │
                            ▼
                     Execution artifact
                            │
                            ▼
                     UI / Debug viewer
```

But do not assume this exact design.

If the existing Cuttlefish/WebRTC implementation provides a better interception point, use that instead.

The primary optimization goal is:

> **Capture an existing host-side video stream with the minimum possible additional work.**

Avoid:

```text
Guest framebuffer
      ↓
Read pixels
      ↓
Copy pixels
      ↓
Encode again
```

if the existing WebRTC pipeline already provides suitable frames or encoded packets.

---

# Phase 3 — Define the Recording Contract

Define a simple recording abstraction.

For example:

```text
VirtualDeviceVideoRecorder

start(executionId, deviceId)
write(frame/packet)
stop()
artifact()
```

But adapt this to the repository's existing architecture.

The recorder must have:

### Start

Recording begins immediately before test execution.

### Stop

Recording stops reliably when:

- test passes,
- test fails,
- test is cancelled,
- test times out,
- device crashes,
- execution process dies.

### Finalization

A partially written recording must not be reported as a valid artifact.

If possible, preserve partial recordings separately for crash diagnosis.

---

# Phase 4 — Video Format

Choose the simplest format that gives us:

- browser playback,
- reasonable compression,
- seeking,
- timestamp preservation,
- broad compatibility.

Prefer:

**MP4 + H.264**

if the existing infrastructure makes that practical.

Do not introduce a complicated media-processing dependency unless necessary.

If WebM is substantially easier with the existing pipeline, explain the tradeoff before choosing it.

The decision should prioritize:

1. reliability,
2. browser playback,
3. CPU impact,
4. storage size,
5. implementation complexity.

---

# Phase 5 — Timestamp Correctness

This is critical.

The recording must preserve meaningful timestamps.

We need to eventually support:

```text
Test event:        00:31.420
Assertion failure: 00:32.180
Video position:    00:32.180
```

Therefore investigate:

- frame timestamps,
- monotonic clocks,
- WebRTC timestamps,
- test execution timestamps.

Define a single clock/reference model.

Do not simply assume frame number × frame interval.

Variable frame rates and dropped frames must remain representable.

---

# Phase 6 — Performance Requirement

The recorder must not meaningfully perturb the virtual device.

Add a benchmark/test comparing:

### Baseline

No recording.

### Recording

Host-side recording enabled.

Measure at minimum:

- guest FPS,
- jank,
- dropped frames,
- CPU,
- memory,
- video FPS,
- recording latency,
- encoder CPU,
- artifact size.

The acceptance criterion is:

> Host-side recording must not reproduce the severe guest performance degradation observed with `screenrecord`/`scrcpy`.

Do not claim success simply because the recording works.

We need evidence that the recording path is non-intrusive.

---

# Phase 7 — Failure Handling

Design for real CI failures.

Test:

### Normal completion

```text
test starts
→ recording starts
→ test passes
→ recording finalizes
→ artifact available
```

### Test failure

```text
test starts
→ recording starts
→ assertion fails
→ recording finalizes
→ artifact available
```

### Timeout

```text
test starts
→ timeout
→ execution terminated
→ recording finalized
→ artifact available
```

### Device crash

```text
test starts
→ Cuttlefish crashes
→ recorder detects stream termination
→ finalize what is available
→ artifact marked appropriately
```

### Process crash

Ensure we don't leave corrupt artifacts silently marked as successful.

---

# Phase 8 — Storage

Do not build a complicated media storage service.

For the current product, define a simple artifact model:

```text
execution/
    metadata.json
    video.mp4
    screenshots/
    logs/
```

or adapt to the existing artifact architecture.

The execution record should contain something equivalent to:

```json
{
  "artifacts": {
    "video": {
      "path": "...",
      "mimeType": "video/mp4",
      "durationMs": 43200,
      "fps": 50
    }
  }
}
```

Use the repository's existing storage conventions where possible.

---

# Phase 9 — UI Integration

Do not build a sophisticated video editor.

We only need:

### Execution page

```text
Execution #1234

FAILED

[ ▶ Watch execution ]

Artifacts
├── Video
├── Screenshot
└── Logs
```

Video viewer requirements:

- play/pause,
- seek,
- current time / duration,
- fullscreen if trivial,
- jump to failure timestamp if execution metadata already provides it.

The user should be able to answer:

> "What happened immediately before the failure?"

within seconds.

---

# Phase 10 — Implementation Strategy

Implement incrementally.

## Step 1

Add host-side recording capability with a minimal standalone test.

Do not integrate it with the full execution system yet.

Prove:

```text
Cuttlefish running
      ↓
host-side video capture
      ↓
record 30–60 seconds
      ↓
valid playable video
```

## Step 2

Measure performance against the baseline.

## Step 3

Integrate recorder lifecycle with execution lifecycle.

## Step 4

Persist video as an execution artifact.

## Step 5

Expose artifact through API.

## Step 6

Add minimal UI playback.

## Step 7

Add timestamp/failure seeking.

---

# Engineering Principles

Follow these strictly.

### 1. Reuse before rebuilding

If Cuttlefish/WebRTC already has the required frames or encoded packets, reuse them.

### 2. No guest instrumentation

The Android guest should not know that recording is happening.

### 3. Avoid duplicate encoding

If we can reuse an existing encoded stream, prefer that.

If we must encode separately, do it on the host.

### 4. Keep S5 narrow

S5 is:

> Reliable video evidence for virtual-device test executions.

Do not expand it into:

- video analytics,
- AI video understanding,
- visual regression,
- video streaming infrastructure,
- physical devices,
- cloud recording,
- video editing.

### 5. Production-oriented, not prototype-only

Handle:

- failures,
- cancellation,
- timeouts,
- device crashes,
- corrupted recordings,
- cleanup,
- storage,
- concurrent executions.

### 6. Don't over-engineer

Prefer the smallest implementation that can become production code.

---

# Required Deliverables

Before changing code, provide:

## 1. Existing architecture

Exact code path with:

- files,
- classes,
- functions,
- data flow.

## 2. Recommended interception point

Explain exactly where the recorder should attach.

## 3. Architecture diagram

Show:

```text
Cuttlefish → Host video → WebRTC → Recorder → Artifact → Execution UI
```

with actual components.

## 4. Alternatives considered

At minimum:

- guest `screenrecord`
- `scrcpy`
- host-side raw-frame recording
- host-side re-encoding
- reuse existing encoded WebRTC stream

Explain why each is accepted/rejected.

## 5. Implementation plan

Break into small PR-sized changes.

## 6. Performance test plan

Define exactly how to prove recording does not perturb execution.

## 7. Risks

Especially:

- encoder contention,
- frame-copy overhead,
- timestamp drift,
- WebRTC lifecycle,
- device termination,
- concurrent recordings,
- storage growth.

---

# Important Instruction

**Do not implement anything until you have inspected the repository and produced the architecture findings.**

If the current implementation does not expose a clean recording hook, identify the smallest change required to expose one.

Do not introduce a second independent display-capture architecture unless the existing Cuttlefish/WebRTC path genuinely cannot support recording.

The final goal is simple:

> **A virtual-device test runs normally, the user gets a reliable video of exactly what happened, and the recording mechanism does not change what the test observes.**