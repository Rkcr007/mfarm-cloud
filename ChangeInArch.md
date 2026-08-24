# MFARM — Production-Grade Virtual Android Device Farm

## Mission

Build MFARM as a **self-hosted virtual Android device farm** whose primary goal is:

> Provide a virtual Android device experience that feels as close as reasonably possible to using a physical Android phone for application, UI, functional, and automation testing — while achieving significantly lower cost and easier scalability than maintaining a fleet of physical devices.

The product is NOT simply "two Cuttlefish VMs."

The product is a **virtual device platform** with:

- high-performance Android virtualization
- hardware-accelerated graphics
- responsive remote interaction
- configurable device profiles
- APK installation
- ADB access
- Appium compatibility
- device lifecycle management
- snapshots/reset
- test execution
- live device streaming
- CI integration
- health monitoring

The fundamental optimization target is:

> **Physical-device-like testing experience at virtual-device economics.**

---

# 1. Architectural Decision

For the MVP/production foundation, use:

- **Cuttlefish** as the Android virtual-device runtime
- **KVM** for CPU virtualization
- **GfxStream** for GPU-accelerated Android graphics
- **Dedicated host GPU**
- **Cuttlefish WebRTC** for remote display/input where practical
- **ADB** for device control
- **Appium** for automation compatibility
- **COW/snapshots/powerwash** for fast device reset
- A custom **MFARM Device Manager** above Cuttlefish

Do NOT use software rendering/SwiftShader as the normal production path.

The current prototype screenshot shows:

> `software rendered, low frame rate`

Treat this as a configuration/architecture problem that must be fixed, not as the expected performance ceiling of Cuttlefish.

The desired production path is:

```text
Android Application
        ↓
Android Framework
        ↓
OpenGL / Vulkan
        ↓
Cuttlefish
        ↓
GfxStream
        ↓
Host GPU
        ↓
Hardware-accelerated rendering
        ↓
Video capture/encoding
        ↓
WebRTC
        ↓
MFARM Console
```

CPU virtualization:

```text
Android Guest
     ↓
Cuttlefish
     ↓
KVM
     ↓
Host CPU
```

---

# 2. Do NOT blindly implement

Before changing code:

1. Inspect the existing repository completely.
2. Understand the current MFARM architecture.
3. Identify how Cuttlefish is currently launched.
4. Identify the current GPU configuration.
5. Identify why the current console reports:
   - software rendered
   - low frame rate
6. Identify the current streaming implementation.
7. Identify how ADB connectivity works.
8. Identify how device lifecycle is currently managed.
9. Identify current GCP infrastructure assumptions.
10. Produce a short architecture assessment before making major changes.

Do not rewrite working components unnecessarily.

Preserve existing functionality wherever possible.

---

# 3. Core Product Architecture

MFARM should be structured around a **Device abstraction**, not around individual Cuttlefish processes.

Conceptually:

```text
                    MFARM
                      │
              ┌───────┴────────┐
              │                │
         Device API         Job API
              │                │
              └───────┬────────┘
                      │
                Device Manager
                      │
              Runtime Abstraction
                      │
             Cuttlefish Runtime
                      │
            ┌─────────┴─────────┐
            │                   │
       Device #1            Device #2
       Android 17           Android 17
       Pixel profile        Pixel profile
```

The console should never need to know the internal implementation details of Cuttlefish.

---

# 4. Create a Runtime Abstraction

Design an internal runtime interface similar to:

```text
VirtualDeviceRuntime

start()
stop()
restart()
reset()
snapshot()
restoreSnapshot()

installApk()
uninstallApk()

getStatus()
getHealth()

getAdbEndpoint()

sendInput()
sendTouch()
sendSwipe()
sendKeyEvent()

getLogs()

startStreaming()
stopStreaming()
```

Cuttlefish should initially be the only implementation:

```text
VirtualDeviceRuntime
        │
        └── CuttlefishRuntime
```

But architect the system so that a future runtime can be added:

```text
VirtualDeviceRuntime
        ├── CuttlefishRuntime
        ├── AndroidEmulatorRuntime   (future)
        └── PhysicalDeviceRuntime    (future)
```

Do not implement the Android Emulator runtime now unless required.

---

# 5. Device Definition

Create an AVD-like MFARM device-definition abstraction.

Example:

```yaml
id: pixel-8-api-35

identity:
  manufacturer: Google
  model: Pixel 8
  display_name: Pixel 8

android:
  api_level: 35
  architecture: x86_64
  image: google_apis

hardware:
  cpu:
    cores: 4

  memory:
    ram_mb: 8192

  display:
    width: 1080
    height: 2400
    density: 420

graphics:
  acceleration: host
  backend: gfxstream

storage:
  userdata_gb: 16

network:
  mode: nat

sensors:
  gps: virtual
  accelerometer: virtual
  gyroscope: virtual

camera:
  front: virtual
  rear: virtual
```

The exact schema can be changed if the repository has a better architecture.

The important principle is:

> Device configuration must be independent from the runtime implementation.

---

# 6. GPU Acceleration — CRITICAL

Investigate and implement the correct production GPU path.

Target:

```text
Cuttlefish
   ↓
GfxStream
   ↓
Host GPU
```

Do NOT silently fall back to:

```text
Cuttlefish
   ↓
SwiftShader
   ↓
CPU
```

unless explicitly configured as a development fallback.

The device health/status API should expose graphics information:

```json
{
  "graphics": {
    "mode": "gfxstream",
    "accelerated": true,
    "renderer": "...",
    "gpu": "...",
    "software_rendered": false
  }
}
```

If the device is running software rendering, MFARM should visibly report:

```text
GPU acceleration unavailable
```

rather than pretending the device is healthy.

---

# 7. Host Infrastructure

The target production host should support:

```text
Linux
KVM
64–128 GB RAM
NVMe SSD
16–24+ strong CPU cores
Dedicated GPU
```

Initially optimize for running:

```text
2 virtual Android devices
```

with enough headroom for:

- MFARM API
- Device Manager
- ADB
- Appium
- WebRTC
- logging
- monitoring
- test execution

Do not optimize only for maximum device count.

The priority is:

1. responsiveness
2. reliability
3. isolation
4. predictable performance
5. then density

---

# 8. Streaming Architecture

Treat Android rendering and remote streaming as two separate performance pipelines.

Rendering:

```text
Android
  ↓
GPU
  ↓
Cuttlefish display
```

Remote experience:

```text
Cuttlefish display
      ↓
frame capture
      ↓
hardware video encoding where available
      ↓
WebRTC
      ↓
browser
```

The user should experience:

- low input latency
- smooth scrolling
- smooth animations
- minimal frame drops
- fast screen updates

Avoid unnecessarily re-encoding frames multiple times.

Reuse Cuttlefish's existing WebRTC capabilities where practical instead of building a completely independent streaming stack.

---

# 9. Target User Experience

The device should feel like:

> "I am holding an Android phone remotely."

The console should support:

- tap
- long press
- swipe
- drag
- scroll
- keyboard/text input
- back
- home
- recent apps
- rotation
- volume
- power
- APK installation
- app launch
- app stop
- device restart
- device reset

The user should NOT be aware that the Android device is virtual unless they inspect device information.

---

# 10. Performance Targets

Establish measurable targets.

At minimum benchmark:

### Device runtime

- boot time
- reboot time
- APK installation time
- app launch time
- CPU usage
- RAM usage
- GPU utilization
- GPU memory
- Android frame rate
- jank/frame drops

### Remote experience

- input-to-screen latency
- WebRTC latency
- frame rate
- dropped frames
- bandwidth
- encode latency

### Stability

- 1 device for 8+ hours
- 2 devices concurrently for 8+ hours
- repeated APK installation/reset cycles
- repeated device restart cycles
- repeated snapshot restore cycles

Do not claim "physical-device equivalent performance" without measurements.

The goal is:

> Make the virtual device sufficiently responsive and consistent that normal application/UI/functional testing does not require a physical device.

---

# 11. Device Lifecycle

Implement a deterministic lifecycle:

```text
CREATED
   ↓
STARTING
   ↓
BOOTING
   ↓
READY
   ↓
IN_USE
   ↓
RESETTING
   ↓
READY
```

Failure states:

```text
FAILED
UNHEALTHY
OFFLINE
```

The Device Manager must know:

- process state
- Android boot state
- ADB state
- graphics state
- streaming state
- health state
- current session
- current user/job

---

# 12. Reset / Snapshot Strategy

Use a golden device state.

Conceptually:

```text
Golden Android Image
        │
        ├── Device A overlay
        ├── Device B overlay
        ├── Device C overlay
        └── Device D overlay
```

After a test:

```text
Device
  ↓
destroy/reset overlay
  ↓
clean state
```

Use Cuttlefish's existing snapshot/COW/powerwash capabilities wherever appropriate.

The goal is to make:

```text
"Reset device"
```

take seconds rather than requiring a complete OS installation.

---

# 13. Automation

ADB must remain a first-class interface.

Support:

```text
adb install
adb uninstall
adb shell
adb logcat
adb exec-out
adb devices
```

Appium should be able to connect to the virtual devices.

The architecture should support:

```text
MFARM
  │
  ├── Manual testing
  │
  ├── ADB
  │
  ├── Appium
  │
  └── CI/CD
```

---

# 14. Device Performance vs Physical Hardware

Do NOT attempt to fake hardware-specific performance.

MFARM is intended to replace the majority of:

- UI testing
- functional testing
- regression testing
- automation testing
- APK validation
- navigation testing
- basic performance/jank investigation
- Android-version testing
- screen-size/density testing

Physical devices remain appropriate for:

- real modem/SIM behavior
- battery/thermal testing
- exact OEM GPU behavior
- proprietary sensors
- camera hardware behavior
- biometric hardware
- OEM-specific bugs
- final release validation

This distinction should be reflected in the product architecture.

---

# 15. Future Physical Device Support

Design the system so that physical devices can eventually exist alongside virtual devices:

```text
                     MFARM
                       │
             ┌─────────┴─────────┐
             │                   │
       Virtual Farm        Physical Farm
             │                   │
        Cuttlefish          Android phones
             │                   │
             └─────────┬─────────┘
                       │
                  Same Console
```

The UI should simply show:

```text
Pixel 8 Virtual
READY

Samsung S24 Physical
READY
```

The underlying runtime should be different, but the user experience should be unified.

---

# 16. Do Not Overbuild

For this phase, do NOT build:

- Kubernetes
- multi-region infrastructure
- thousands of devices
- complex billing
- public cloud multi-tenancy
- sophisticated user management
- hardware-device marketplace
- complex scheduling algorithms

First make:

> **One Linux host → two excellent virtual Android devices**

extremely reliable.

Then scale horizontally.

---

# 17. Development Process

Work in these phases.

## Phase 1 — Repository/Infrastructure Assessment

Inspect the current implementation and document:

- current Cuttlefish version
- launch mechanism
- GPU mode
- KVM configuration
- host OS
- CPU/RAM
- GPU
- networking
- WebRTC
- ADB
- device lifecycle
- API architecture

Identify exactly why the current UI says:

```text
software rendered, low frame rate
```

Do not proceed until the root cause is understood.

---

## Phase 2 — Production GPU Path

Implement:

```text
KVM
+
GfxStream
+
Host GPU
```

Verify from inside the running device that GPU acceleration is genuinely active.

Do not rely only on launch flags.

Expose GPU health in MFARM.

---

## Phase 3 — High-Performance Remote Device

Make one device excellent.

Target:

```text
smooth UI
smooth scrolling
low input latency
stable WebRTC
stable ADB
fast APK installation
```

Do not move to multi-device optimization until one device is good.

---

## Phase 4 — Two-Device Concurrency

Run two devices simultaneously.

Measure:

- CPU contention
- RAM
- GPU contention
- GPU memory
- WebRTC
- frame rate
- input latency

Tune resource allocation.

---

## Phase 5 — Device Profiles

Add configurable device definitions.

Start with only a small number:

```text
Pixel-like Android 17
Pixel-like Android 16
```

Do not create dozens of fake device models yet.

---

## Phase 6 — Automation

Integrate:

```text
ADB
Appium
APK install
logs
test execution
```

---

## Phase 7 — Production Hardening

Add:

- health checks
- automatic recovery
- process supervision
- device reset
- snapshot management
- monitoring
- structured logs
- failure diagnostics
- resource limits

---

# 18. Important Engineering Principle

Do not optimize for:

> "How do I make Cuttlefish run?"

Optimize for:

> **"How do I make a virtual Android device behave like a reliable product-grade testing device?"**

The runtime is an implementation detail.

MFARM is the product.

---

# 19. Deliverables

Before coding, provide:

1. Current architecture assessment
2. Proposed production architecture
3. Current-vs-target architecture comparison
4. GPU acceleration plan
5. Host hardware requirements
6. Cuttlefish configuration
7. Device-definition schema
8. Runtime abstraction
9. Streaming architecture
10. Device lifecycle state machine
11. Snapshot/reset strategy
12. Performance benchmark plan
13. Implementation plan

Then implement incrementally.

For every major architectural change:

- explain why
- show what is changing
- preserve working functionality
- verify it
- provide measurable evidence

Do not make assumptions about GPU support, KVM, GfxStream, WebRTC, or Cuttlefish behavior. Inspect the actual environment and verify them.

---

# Final Success Criteria

MFARM MVP is successful when:

```text
Linux host
   ↓
KVM
   ↓
Cuttlefish
   ↓
GfxStream
   ↓
Host GPU
   ↓
Android 17
   ↓
WebRTC
   ↓
MFARM Console
```

provides a virtual Android phone where a tester can:

1. open the device
2. see a smooth live Android UI
3. tap/swipe/type naturally
4. install an APK
5. launch the application
6. navigate the application normally
7. run automated tests through Appium/ADB
8. inspect logs
9. reset the device
10. repeat the process reliably

The primary optimization goal is:

> **Maximum practical testing capability per dollar of infrastructure cost.**

Do not sacrifice user experience merely to increase virtual-device density.

The first priority is:

**Physical-device-like experience → reliability → performance → density → scale.**