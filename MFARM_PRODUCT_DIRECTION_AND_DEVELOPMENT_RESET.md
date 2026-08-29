# MFARM — DEVELOPMENT DIRECTION RESET
## Build a Premium Virtual Android Device Farm, Not a Samsung Emulator

You already have an existing MFARM implementation with several features and infrastructure pieces already developed.

DO NOT throw away working functionality unnecessarily.

However, the product direction needs to be fundamentally corrected.

Before making implementation changes, understand the following product definition and reassess the current repository against it.

---

# 1. WHAT MFARM ACTUALLY IS

MFARM is a **professional self-hosted virtual Android device farm**.

The goal is to provide users with the experience of using a real modern Android device for application testing, but the underlying devices are virtual.

The product should compete at the EXPERIENCE level with platforms such as:

- BrowserStack
- LambdaTest
- Sauce Labs
- Other professional mobile device testing platforms

However, MFARM is NOT trying to reproduce Samsung firmware or claim that a virtual device is a genuine Samsung device.

The device identity, operating system presentation, hardware profile, and visual design belong to MFARM.

The user should think:

> "This feels like a real flagship Android phone."

They should NOT think:

> "This is a Cuttlefish emulator running inside a web page."

That distinction is critical.

---

# 2. PRIMARY PRODUCT OBJECTIVE

The most important capability is:

## APPLICATION TESTING

Everything else is secondary.

A user must be able to take a real Android application and use MFARM as if they were holding a real phone.

The core workflow is:

User
→ selects a device
→ starts a session
→ waits for device to become ready
→ uploads APK
→ installs application
→ launches application
→ interacts with application
→ observes behavior
→ collects logs
→ takes screenshots
→ records session
→ resets device
→ ends session

This workflow must be extremely reliable.

If the device can visually imitate a flagship phone but APK installation, launching, interaction, streaming or reset are unreliable, the product has failed.

---

# 3. PRODUCT PHILOSOPHY

Use this principle for every implementation decision:

> REAL DEVICE EXPERIENCE + VIRTUAL INFRASTRUCTURE + MFARM IDENTITY

The virtual implementation should be invisible to the user.

The user should receive:

- realistic Android behavior
- realistic screen dimensions
- realistic display characteristics
- realistic navigation
- realistic launcher
- realistic notifications
- realistic system controls
- realistic application behavior
- responsive touch interaction
- smooth rendering
- low-latency streaming

But the product should remain clearly MFARM-owned.

---

# 4. DO NOT REPLICATE SAMSUNG

This is a hard requirement.

Do NOT attempt to reproduce Samsung's proprietary:

- firmware
- One UI internals
- Knox
- Samsung framework services
- Samsung proprietary HALs
- Samsung vendor services
- Samsung proprietary applications
- Samsung hardware behavior
- Samsung branding
- Samsung device identity

Do not waste engineering time attempting to create a counterfeit Samsung firmware experience.

We previously considered creating a Samsung-like One UI.

That is no longer the primary direction.

Instead:

## Build an MFARM flagship Android experience.

The visual quality can be inspired by modern flagship Android UX, including the qualities users associate with premium phones, but the implementation, branding and device identity should belong to MFARM.

---

# 5. MFARM DEVICE IDENTITY

Create virtual device profiles owned by MFARM.

Example:

### MFARM X1 Pro

- Android 17
- Flagship-class configuration
- 6.7-inch display
- High resolution
- High DPI
- Modern aspect ratio
- 120Hz-class display configuration where technically meaningful
- High RAM profile
- Large storage profile
- Modern flagship device dimensions

Example:

### MFARM X1

- Android 17
- 6.5-inch display
- 1080p-class resolution
- 8GB RAM
- 128GB storage

The exact specifications should be based on what the virtual Android runtime can reliably support.

Do not invent specifications that the underlying runtime cannot actually represent.

---

# 6. REAL DEVICE EXPERIENCE

The device should behave like a modern Android smartphone.

The virtual Android environment should provide:

- boot animation
- lock screen
- launcher
- status bar
- navigation
- notifications
- notification shade
- quick settings
- volume controls
- power menu
- recent applications
- application lifecycle
- keyboard
- orientation changes
- screen rotation
- charging state
- battery state
- network state
- system dialogs
- permissions
- application installation
- application uninstall
- application data reset

The goal is not to recreate every Android/OEM feature.

The goal is to provide everything a mobile application tester reasonably expects when interacting with a modern Android phone.

---

# 7. MFARM VISUAL DESIGN

The visual design must be premium.

This is important because:

> If the product does not look good, users will not trust it as a professional testing platform.

The console and device presentation should feel like a commercial product, not an internal engineering tool.

Use:

- polished typography
- strong spacing system
- clear visual hierarchy
- high-quality icons
- subtle animation
- smooth transitions
- professional dark/light themes where appropriate
- responsive layouts
- polished loading states
- realistic device frames
- meaningful status indicators
- clean empty states
- professional error states

Avoid:

- generic developer-dashboard appearance
- excessive borders
- raw emulator terminology
- technical information everywhere
- placeholder-looking UI
- unnecessary visual clutter

---

# 8. DEVICE FRAME VS ANDROID SCREEN

Treat these as two separate things.

## Device frame

The device chassis displayed in the MFARM web console is a frontend presentation layer.

It should visually represent the selected MFARM device.

It can include:

- realistic proportions
- rounded corners
- speaker/camera representation
- side buttons
- realistic bezel
- realistic shadows
- device-specific frame

## Android screen

The screen content must come from the actual virtual Android device.

Do NOT fake application content in the screen.

The live pixels must come from the running virtual Android instance.

Therefore:

DEVICE FRAME
=
MFARM frontend visual asset

DEVICE SCREEN
=
real-time virtual Android framebuffer/stream

This distinction must remain in the architecture.

---

# 9. DEVICE SESSION IS THE HERO EXPERIENCE

The most important screen in the entire product is the device session.

It should feel like a professional mobile testing environment.

Conceptually:

MFARM
────────────────────────────────────────

Device / Session information

          ┌─────────────────┐
          │                 │
          │                 │
          │  LIVE ANDROID   │
          │                 │
          │   APPLICATION   │
          │                 │
          │                 │
          └─────────────────┘

Controls
Logs
Files
Network
Device
Recording
Screenshots
App information

Session duration
Connection status
Device status

────────────────────────────────────────

The live device must be the visual focus.

Do not allow secondary UI panels to overwhelm the device.

---

# 10. CORE DEVICE CONTROLS

The user must be able to perform:

- tap
- long press
- swipe
- drag
- scroll
- keyboard input
- back
- home
- recent apps
- rotate
- volume up
- volume down
- power
- screenshot
- fullscreen
- zoom
- reset

Interaction must feel immediate.

Input latency is a first-class product requirement.

---

# 11. APK TESTING WORKFLOW

This is the highest-priority engineering workflow.

Implement and verify:

## Upload

User selects APK.

MFARM uploads it to the server/device session.

## Install

MFARM installs the APK through the device control layer.

## Launch

MFARM identifies the launchable activity/package and launches it.

## Test

User interacts with the application normally.

## Observe

User can view:

- application screen
- logcat
- device information
- application information
- session events

## Evidence

User can capture:

- screenshot
- video
- logs
- timestamps/events

## Reset

User can reset the device into a clean/reproducible state.

This entire flow must be tested end-to-end.

---

# 12. DEVICE STREAMING

The live Android screen must feel like a real device.

Prioritize:

- low latency
- smooth frame delivery
- stable connection
- correct scaling
- correct aspect ratio
- touch coordinate accuracy
- orientation synchronization
- reconnection handling

Do not optimize only for visual quality.

Optimize:

PERCEPTION OF REAL-TIME INTERACTION.

If the screen looks beautiful but responds 500ms later, it will feel fake.

---

# 13. GPU ACCELERATION

Hardware-accelerated rendering is strongly preferred and should be treated as a core production requirement.

The intended virtual Android stack is:

AOSP / Cuttlefish
+
KVM
+
GPU acceleration
+
GfxStream
+
hardware-accelerated rendering

The implementation should NOT depend on software rendering for the final production-quality demonstration if hardware acceleration is available.

The target should be:

- stable 30 FPS or better
- preferably approaching 60 FPS for normal interaction
- smooth scrolling
- smooth animations
- low input latency

Measure actual performance.

Do not simply assume that GPU acceleration is working.

Expose useful runtime diagnostics so we can determine:

- renderer
- GPU usage
- FPS
- stream latency
- frame drops

---

# 14. DEVICE LIFECYCLE

MFARM must own the device lifecycle.

The system should support:

AVAILABLE
↓
ALLOCATING
↓
BOOTING
↓
INITIALIZING
↓
READY
↓
IN USE
↓
RESETTING
↓
AVAILABLE

Failures should produce explicit states:

BOOT_FAILED
UNHEALTHY
STREAM_DISCONNECTED
INSTALL_FAILED
RESET_FAILED

Do not hide lifecycle failures behind generic "Loading..." UI.

---

# 15. DEVICE CATALOGUE

The catalogue should look like a professional commercial device farm.

Example:

Android Devices

┌──────────────────────┐
│     MFARM X1 Pro     │
│                      │
│     [device image]   │
│                      │
│ Android 17           │
│ 6.7"                 │
│ 1440 × 3120          │
│                      │
│ ● Available          │
│                      │
│ [Start Session]      │
└──────────────────────┘

The catalogue should support future expansion into:

- multiple Android versions
- multiple screen sizes
- tablets
- different performance profiles
- different device configurations

But do not build dozens of devices before one device is excellent.

---

# 16. FIRST HERO DEVICE

Prioritize one device:

## MFARM X1 Pro

Make this device exceptional.

It must have:

- reliable boot
- fast startup
- GPU acceleration
- stable streaming
- accurate touch
- APK installation
- APK launch
- logs
- screenshot
- recording
- reset
- clean state restoration

Only after this is reliable should additional device profiles be created.

---

# 17. LOGGING

Provide a professional log viewer.

The user should be able to:

- view live logs
- filter
- search
- clear
- pause
- inspect errors
- distinguish system/app logs

Do not dump raw logcat into the main UI without presentation.

The raw logs can remain available in an advanced view.

---

# 18. SESSION RECORDING

Session recording is an important product capability.

The user should be able to:

- start recording
- stop recording
- see recording state
- associate recording with session
- replay/download/view the recording

Design the feature so it can later become evidence attached to automated test runs.

---

# 19. SCREENSHOTS AND TEST EVIDENCE

Screenshots should be first-class artifacts.

A session should eventually contain:

- screenshots
- video
- logs
- device metadata
- application metadata
- timestamps
- test events

This should form the foundation for future automated test reporting.

---

# 20. DEVICE RESET / SNAPSHOT

A tester needs repeatability.

Support:

- restart
- clear app data
- uninstall app
- factory/reset-like clean state
- snapshot
- restore snapshot

Do not implement complex snapshot functionality prematurely if the underlying runtime does not support it reliably.

First guarantee deterministic reset.

---

# 21. PRODUCT ARCHITECTURE

Keep these layers clearly separated:

## MFARM Console

Frontend.

Responsible for:

- catalogue
- sessions
- device presentation
- controls
- logs
- recording
- screenshots
- user experience

## MFARM API

Responsible for:

- authentication
- device catalogue
- session creation
- device allocation
- session lifecycle
- APK management
- artifact management

## MFARM Device Manager

Responsible for:

- creating devices
- starting devices
- stopping devices
- health checks
- ADB
- input
- streaming
- installation
- logs
- reset
- snapshots

## Virtual Android Runtime

Initially:

Cuttlefish
+
AOSP
+
KVM
+
GPU
+
GfxStream

The architecture must allow Cuttlefish to be replaced or extended later without rewriting the entire product.

---

# 22. AUTOMATION READINESS

Manual interaction is the first priority.

However, the architecture must be automation-ready.

Design the device control API so future integrations can support:

- ADB
- Appium
- UIAutomator
- Maestro
- Espresso
- CI/CD execution

Do not build every automation integration now.

Instead create clean interfaces so they can be added later.

---

# 23. MULTI-DEVICE

The product should eventually support:

Device A
Device B
Device C
Device D

running simultaneously.

However, the first milestone is:

ONE EXCELLENT DEVICE.

Then:

ONE SERVER
→ TWO DEVICES

Then scale horizontally.

Do not prematurely introduce Kubernetes or distributed orchestration unless the current architecture actually requires it.

---

# 24. PERFORMANCE IS A PRODUCT FEATURE

Measure:

- boot time
- APK installation time
- application launch time
- screen FPS
- frame drops
- input latency
- stream latency
- CPU
- RAM
- GPU
- device health
- session stability

Create a simple internal performance diagnostic view if necessary.

We need evidence that the device is performant.

---

# 25. SECURITY / ISOLATION

Even in the MVP, do not design the system as if every user shares unrestricted access to the host.

Think about:

- session isolation
- APK isolation
- device ownership
- authentication
- authorization
- artifact access
- cleanup
- resource limits

Keep the architecture extensible toward multi-user usage.

---

# 26. WHAT TO DO WITH THE EXISTING CODE

Do NOT immediately rewrite everything.

First inspect the repository.

Produce a technical assessment containing:

### KEEP

Existing components that are architecturally sound.

### MODIFY

Existing components that can be adapted.

### REFACTOR

Components whose responsibility or design needs to change.

### REMOVE

Components that only exist because of the previous Samsung/emulator-centric direction.

### BUILD

Missing components required by the new product definition.

### BLOCKERS

Anything blocked by:

- GPU availability
- Cuttlefish limitations
- host kernel configuration
- streaming technology
- Android build limitations
- infrastructure
- existing architectural decisions

---

# 27. IMPORTANT: DO NOT CONFUSE VISUAL SIMULATION WITH REAL FUNCTIONALITY

This is a strict requirement.

Do not create fake UI controls that only appear functional.

For example:

If the UI says:

"Install APK"

the APK must actually be installed.

If the UI says:

"Recording"

actual recording must happen.

If the UI says:

"Logs"

actual device/application logs must appear.

If the UI says:

"Reset"

the device must actually reset.

If the UI says:

"LIVE"

the screen must actually be live.

The demo must be honest.

---

# 28. DEMO QUALITY BAR

The final demonstration should be:

Open MFARM
→ Login
→ Browse devices
→ Select MFARM X1 Pro
→ Start session
→ Device boots
→ Device appears in realistic frame
→ Device becomes LIVE
→ Upload real APK
→ Install
→ Launch
→ Interact smoothly
→ Perform real application workflow
→ Open logs
→ Take screenshot
→ Record session
→ Reset
→ Start again

Someone watching this should conclude:

> "This is a real mobile testing platform."

They should NOT conclude:

> "This is an Android emulator demo."

---

# 29. PRIORITY ORDER

Use this priority order strictly.

### P0 — Application testing reliability

- device boot
- device health
- APK install
- APK launch
- touch
- swipe
- keyboard
- navigation
- screen streaming
- reset

### P1 — Performance

- GPU acceleration
- FPS
- latency
- stream stability
- boot performance

### P2 — Session experience

- device frame
- device controls
- APK workflow
- logs
- screenshots
- recording

### P3 — Product polish

- catalogue
- animations
- visual hierarchy
- responsive design
- premium device presentation

### P4 — Advanced testing

- network throttling
- GPS
- files/media
- snapshots
- multi-device
- automation
- CI/CD

Do not reverse this order.

---

# 30. FINAL PRODUCT DEFINITION

MFARM should ultimately be understood as:

> A premium self-hosted virtual Android device farm that lets engineers test real Android applications on realistic, high-performance virtual devices through a professional device-testing console.

The differentiator is NOT:

"MFARM has a Samsung clone."

The differentiator is:

"MFARM provides a real-device-like Android testing experience without requiring physical devices."

The virtual device should feel real.

The application testing should be real.

The interaction should be real.

The logs should be real.

The recordings should be real.

The device lifecycle should be real.

The console should look premium.

The underlying implementation can be virtual.

That is the product.

---

# 31. BEFORE WRITING CODE

Do NOT start coding immediately.

First:

1. Inspect the complete existing repository.
2. Understand the current architecture.
3. Run the current application.
4. Test the current device workflow.
5. Identify all currently working features.
6. Identify the current Cuttlefish configuration.
7. Determine whether GPU acceleration is currently active.
8. Measure current FPS and input latency.
9. Trace APK installation from frontend to Android runtime.
10. Trace live screen streaming.
11. Trace device lifecycle.
12. Identify the current frontend architecture.
13. Identify reusable components.
14. Identify technical debt.
15. Identify what was built specifically around the previous Samsung-replication idea.

Then produce:

## MFARM CURRENT STATE REPORT

with:

- Current architecture
- Working functionality
- Broken functionality
- Performance measurements
- Current device capabilities
- Current console capabilities
- Reusable components
- Components requiring redesign
- Missing components
- Infrastructure blockers

Then produce:

## MFARM TARGET ARCHITECTURE

including:

- frontend
- API
- device manager
- virtual Android runtime
- streaming
- input
- APK management
- logs
- recording
- artifacts
- lifecycle
- persistence
- future automation

Then produce:

## MFARM IMPLEMENTATION PLAN

broken into incremental milestones.

Only after these three documents are complete should implementation begin.

Do not make architectural changes based on assumptions.

The repository and the running system are the source of truth.

The ultimate objective is simple:

# Make MFARM feel like a real premium mobile device testing platform.

Not an emulator demo.

Not a Samsung clone.

Not a Cuttlefish showcase.

A real product.