# Master Development Prompt — Two-Device Mobile Cloud MVP

You are a principal software architect, senior full-stack engineer, mobile automation engineer, DevOps engineer, and product designer.

Build a **production-quality MVP of a mini mobile device cloud**, inspired by the core experience of BrowserStack/LambdaTest/DeviceFarm, but intentionally limited to:

- 1 Android Emulator
- 1 iOS Simulator

This is a real working system, **not a mockup, prototype-only UI, or simulated demo**.

The goal is to prove that we can build our own small mobile testing cloud where a user can remotely access a virtual Android/iOS device, interact with it, install an application, execute automation, stream the screen, and collect test artifacts.

---

## 1. Product Vision

Build a product that feels like a small, polished commercial mobile testing platform.

The user should be able to:

1. Open the web application.
2. See available Android/iOS devices.
3. Select a device.
4. Start a session.
5. See the live device screen.
6. Interact with the device using:
   - Tap
   - Swipe
   - Long press
   - Keyboard input
   - Back/Home/Recent actions
   - Orientation change
7. Upload an application.
8. Install the application.
9. Launch/uninstall/reset the application.
10. Execute Appium automation.
11. View live logs.
12. Capture screenshots.
13. Record the session.
14. Stop the session.
15. Review execution artifacts.

The experience should feel fast, reliable, and polished.

---

# 2. Devices

## Android

Use:

- Pixel-class high-end Android device profile
- Latest stable Android version available in the development environment
- Android Emulator
- ADB
- Appium

The Android device must be treated as a device worker, not hardcoded directly into the frontend.

Example:

```text
Android Worker
 ├── Emulator lifecycle
 ├── ADB
 ├── Appium Server
 ├── Screen capture
 ├── Input control
 ├── App installation
 ├── Logs
 └── Health monitoring
```

## iOS

Use:

- Latest/high-end iPhone Simulator profile available in the installed Xcode version
- Latest supported iOS Simulator runtime
- Xcode
- simctl
- Appium/XCUITest

The iOS Simulator must also be treated as a worker.

Example:

```text
Mac Worker
 ├── Simulator lifecycle
 ├── simctl
 ├── Appium/XCUITest
 ├── Screen capture
 ├── Input control
 ├── App installation
 ├── Logs
 └── Health monitoring
```

Do not fake iOS support.

If the development environment cannot run iOS Simulator, clearly isolate the Mac worker and provide a clean worker architecture so it can be connected remotely later.

---

# 3. Critical Architecture Principle

The frontend must NEVER directly control an emulator/simulator.

Use this architecture:

```text
                    Web Application
                          |
                          v
                     Farm API
                          |
                          v
                  Session Manager
                          |
                          v
                   Device Manager
                    /           \
                   /             \
                  v               v
        Android Worker       Mac/iOS Worker
             |                    |
        Android Emulator     iOS Simulator
             |                    |
           ADB/Appium        simctl/Appium
```

The device should be abstracted behind a common interface.

Create a `DeviceAdapter` abstraction.

Conceptually:

```typescript
interface DeviceAdapter {
  getInfo(): Promise<DeviceInfo>;
  getStatus(): Promise<DeviceStatus>;

  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  reset(): Promise<void>;

  installApp(app: AppArtifact): Promise<void>;
  uninstallApp(packageId: string): Promise<void>;
  launchApp(packageId: string): Promise<void>;

  tap(x: number, y: number): Promise<void>;
  swipe(...): Promise<void>;
  type(text: string): Promise<void>;
  pressKey(key: string): Promise<void>;

  screenshot(): Promise<Buffer>;
  startRecording(): Promise<void>;
  stopRecording(): Promise<Artifact>;

  getLogs(): AsyncIterable<LogEntry>;

  healthCheck(): Promise<HealthStatus>;
}
```

Implement:

```text
AndroidEmulatorAdapter
IOSSimulatorAdapter
```

The system must be designed so that later we can add:

```text
AndroidPhysicalDeviceAdapter
IOSPhysicalDeviceAdapter
```

without changing the frontend or core session architecture.

---

# 4. Recommended Technology Stack

Use a pragmatic stack.

## Frontend

Prefer:

- React
- TypeScript
- Vite or Next.js
- Tailwind CSS
- shadcn/ui
- WebSocket client
- WebRTC client

The UI must be modern and polished.

Design inspiration:

- Linear
- Vercel
- BrowserStack
- Raycast
- GitHub

Do not copy their UI.

---

## Backend

Use:

- Node.js
- TypeScript
- Fastify or NestJS

Prefer a modular architecture.

Core modules:

```text
auth
devices
sessions
applications
automation
artifacts
logs
streaming
workers
health
```

---

## Database

Use:

- PostgreSQL

Store:

```text
devices
sessions
applications
test_runs
artifacts
logs
users
```

Keep the schema simple.

---

## Cache / messaging

Use:

- Redis

Initially Redis should handle:

- device locks
- session state
- worker heartbeat
- event messaging

Do not introduce Kafka/RabbitMQ unless genuinely necessary.

---

## Object storage

Use an S3-compatible abstraction.

Store:

```text
applications/
screenshots/
recordings/
logs/
reports/
```

For local development, allow MinIO.

For production, support S3-compatible storage.

---

# 5. Worker Architecture

Workers are critical.

Create a Worker Agent that registers itself with the Farm API.

Example:

```text
Worker
  |
  | register
  v
Farm API
  |
  | heartbeat
  v
Worker Registry
```

Worker registration should include:

```text
workerId
platform
hostname
capabilities
deviceIds
version
status
```

Example:

```json
{
  "workerId": "android-worker-01",
  "platform": "android",
  "devices": ["pixel-01"],
  "capabilities": [
    "app-install",
    "appium",
    "screen-stream",
    "recording"
  ]
}
```

The iOS worker follows the same contract.

---

# 6. Device Lifecycle

Implement a real lifecycle:

```text
OFFLINE
   ↓
STARTING
   ↓
BOOTING
   ↓
READY
   ↓
RESERVED
   ↓
SESSION_ACTIVE
   ↓
CLEANING
   ↓
READY
```

Handle failure:

```text
READY
 ↓
CRASHED
 ↓
RECOVERING
 ↓
HEALTH_CHECK
 ↓
READY
```

Never leave a device permanently locked because of a failed browser session or crashed test.

Implement session timeout and automatic cleanup.

---

# 7. Session Management

When a user selects a device:

```text
POST /sessions
```

The Farm API should:

1. Validate device.
2. Acquire device lock.
3. Start device if necessary.
4. Perform health check.
5. Create session.
6. Connect streaming.
7. Connect control channel.
8. Return session information.

Example:

```text
Session
 ├── sessionId
 ├── userId
 ├── deviceId
 ├── status
 ├── startedAt
 ├── expiresAt
 └── streamEndpoint
```

Only one active session is allowed for the MVP device.

---

# 8. Live Screen Streaming

This is a core feature.

Do NOT continuously send full-resolution screenshots through the REST API.

Use:

**WebRTC for interactive live streaming.**

Architecture:

```text
Device
   ↓
Screen Capture
   ↓
Encoder
   ↓
WebRTC
   ↓
Browser
```

Control messages can use:

```text
WebSocket
```

Example:

```text
Browser
  |
  +---- WebRTC ----> Screen
  |
  +---- WebSocket --> Touch/Swipe/Keyboard
```

The user should experience low-latency interaction.

Implement:

- connection state
- reconnect
- session timeout
- graceful shutdown

---

# 9. Device Interaction

Support:

### Pointer

- tap
- double tap
- long press
- swipe
- drag

### Keyboard

- text input
- backspace
- enter
- escape

### Device controls

- Home
- Back
- Recent Apps
- Rotate
- Lock/unlock where supported

Coordinates must be translated correctly between:

```text
Browser viewport
      ↓
Rendered device screen
      ↓
Device coordinate system
```

Account for:

- scaling
- aspect ratio
- device pixel ratio
- orientation

---

# 10. Application Management

Implement:

```text
Upload
Install
Launch
Stop
Uninstall
Reset
```

Android:

```text
.apk
```

iOS Simulator:

```text
.app
```

Validate uploaded artifacts.

Do not execute arbitrary uploaded files directly on the backend.

Keep application execution isolated inside workers.

---

# 11. Appium Automation

Appium must be a first-class component.

Allow the user to:

1. Select device.
2. Select/upload application.
3. Start automation.
4. View live execution.
5. View logs.
6. View screenshots.
7. View final result.

Start with a simple test model.

Example:

```text
Open App
↓
Find Element
↓
Tap
↓
Type
↓
Assert
↓
Screenshot
```

Support Appium capabilities.

Store test configuration separately from execution state.

---

# 12. Test Execution Model

Create:

```text
TestDefinition
TestRun
Step
Artifact
```

Example:

```text
TestDefinition
 ├── name
 ├── platform
 ├── deviceId
 ├── appId
 └── steps
```

A TestRun should contain:

```text
status
startedAt
completedAt
duration
logs
screenshots
video
error
```

Statuses:

```text
QUEUED
RUNNING
PASSED
FAILED
CANCELLED
TIMED_OUT
```

---

# 13. Logs

Provide:

```text
System Logs
Appium Logs
Worker Logs
Test Logs
```

The UI should support live streaming.

Example:

```text
14:31:02 Starting session
14:31:04 Device ready
14:31:06 Installing application
14:31:10 Application installed
14:31:11 Launching application
14:31:13 Appium session created
14:31:14 Finding Login button
14:31:15 Tap successful
```

---

# 14. Screenshots and Video

Every test/session should be able to generate:

- screenshot
- recording
- logs

Artifacts should be linked to the session/test run.

Example:

```text
Test Run #1024

✓ Login
✓ Dashboard
✓ Search
✗ Checkout

Artifacts:
[Video]
[Screenshot]
[Logs]
```

---

# 15. Device Health

Create a health-monitoring system.

Monitor:

```text
worker heartbeat
device availability
CPU
memory
disk
Appium status
ADB status
simulator status
stream status
```

Expose:

```text
HEALTHY
DEGRADED
OFFLINE
RECOVERING
```

The dashboard should clearly communicate device health.

---

# 16. Frontend UX

The frontend must feel like a real product.

Primary navigation:

```text
Dashboard
Devices
Sessions
Tests
Artifacts
Settings
```

## Dashboard

Show:

```text
Devices
Active Sessions
Tests Today
System Health
```

## Devices

Show:

```text
Pixel 10
Android 16
Available

iPhone 17 Pro Max
iOS 26
Available
```

Device cards should show:

- platform
- OS
- model
- status
- capabilities
- current session

---

# 17. Device Session Screen

This is the most important screen.

Layout:

```text
---------------------------------------------------
 Device: Pixel 10                 ● Connected
---------------------------------------------------

        ┌─────────────────────────┐
        │                         │
        │                         │
        │       LIVE DEVICE       │
        │                         │
        │                         │
        └─────────────────────────┘

      [Tap] [Swipe] [Type] [Rotate]

---------------------------------------------------
Console | Logs | Network | Screenshot | Recording
---------------------------------------------------
```

Make this experience extremely polished.

Animations should be subtle.

No unnecessary gradients.

No fake loading animations.

Everything shown should represent real state.

---

# 18. Security

Even though this is an MVP, do not ignore security.

Implement:

- authentication
- authorization
- session isolation
- API validation
- rate limiting
- secure WebSocket authentication
- signed artifact access
- worker authentication
- secrets through environment variables
- no hardcoded credentials

Never expose ADB/Appium ports directly to the public internet.

Workers should communicate through authenticated channels.

---

# 19. Observability

Provide structured logs.

Use:

```text
requestId
sessionId
deviceId
workerId
testRunId
```

in relevant logs.

Make debugging easy.

---

# 20. Local Development

The entire backend must be runnable with:

```bash
docker compose up
```

Where possible.

Expected local services:

```text
PostgreSQL
Redis
MinIO
Farm API
Frontend
```

Device workers may run directly on the host because emulators/simulators require host-level capabilities.

Document this clearly.

---

# 21. Repository Structure

Use a clean monorepo.

Example:

```text
mobile-cloud/
│
├── apps/
│   ├── web/
│   └── api/
│
├── workers/
│   ├── android/
│   └── ios/
│
├── packages/
│   ├── shared/
│   ├── device-protocol/
│   ├── session-protocol/
│   └── types/
│
├── infrastructure/
│   ├── docker/
│   └── scripts/
│
├── docs/
│
├── docker-compose.yml
└── README.md
```

---

# 22. API Design

Create clean APIs.

Examples:

```text
GET    /api/devices
GET    /api/devices/:id
POST   /api/devices/:id/start
POST   /api/devices/:id/restart
POST   /api/devices/:id/reset

POST   /api/sessions
GET    /api/sessions/:id
DELETE /api/sessions/:id

POST   /api/apps
POST   /api/apps/:id/install

POST   /api/tests
POST   /api/tests/:id/run
GET    /api/tests/:id
POST   /api/tests/:id/cancel

GET    /api/artifacts/:id
```

Use WebSockets for:

```text
/session/:id/events
/session/:id/control
/session/:id/logs
```

---

# 23. Error Handling

The platform must survive:

- emulator crash
- simulator crash
- Appium crash
- worker disconnect
- browser refresh
- network interruption
- session timeout
- failed app installation
- failed app launch
- test timeout

Do not simply return an error and leave the device unusable.

Implement recovery.

---

# 24. Production-Ready Principles

Although this is only two devices, write the system so it can eventually scale to:

```text
2 devices
↓
10 devices
↓
100 devices
↓
1000 devices
```

But DO NOT over-engineer the MVP.

Do not introduce:

- Kubernetes
- Kafka
- microservices everywhere
- service mesh
- distributed databases

unless there is a concrete need.

Use modular monolith + workers.

---

# 25. Development Method

Work in phases.

## Phase 1 — Architecture

Before writing code:

1. Inspect the repository.
2. Create architecture document.
3. Create repository structure.
4. Define domain models.
5. Define DeviceAdapter interface.
6. Define worker protocol.
7. Define session lifecycle.
8. Define API contracts.

Do not start by building the UI.

---

## Phase 2 — Android Vertical Slice

Get exactly one Android device working end-to-end.

Success criteria:

```text
Browser
 ↓
Dashboard
 ↓
Android device
 ↓
Start session
 ↓
Live screen
 ↓
Tap
 ↓
Swipe
 ↓
Upload APK
 ↓
Install
 ↓
Launch
 ↓
Appium
 ↓
Test
 ↓
Screenshot
 ↓
Video
 ↓
Logs
```

Do not proceed until this works.

---

## Phase 3 — iOS Vertical Slice

Implement the same experience for iOS Simulator.

Success criteria should match Android.

Do not create a separate architecture for iOS.

Only the Worker/DeviceAdapter implementation should differ.

---

## Phase 4 — Reliability

Add:

- heartbeat
- health checks
- recovery
- cleanup
- timeouts
- session locking
- reconnect
- artifact management

---

## Phase 5 — Product Polish

Then improve:

- UX
- animations
- loading states
- error states
- empty states
- responsive layout
- accessibility
- keyboard shortcuts
- notifications
- dark mode

---

# 26. Definition of Done

The MVP is complete only when I can demonstrate this:

### Android

```text
Open browser
→ Select Pixel
→ Start session
→ See live emulator
→ Tap/swipe/type
→ Upload APK
→ Install APK
→ Launch app
→ Run Appium test
→ See test executing
→ View logs
→ Capture screenshot
→ Record session
→ Stop session
→ Device automatically returns to READY
```

### iOS

Exactly the same workflow:

```text
Open browser
→ Select iPhone Simulator
→ Start session
→ See live simulator
→ Interact
→ Install application
→ Launch
→ Run Appium/XCUITest
→ View logs
→ Screenshot
→ Recording
→ Stop
→ Automatic cleanup
```

---

# 27. Critical Development Rule

Do NOT create fake implementations for core functionality.

Do not use:

```text
fake device status
fake screen streaming
fake test results
fake logs
fake Appium responses
fake screenshots
```

If something cannot currently be implemented because the host environment does not support it:

1. Identify the environmental limitation.
2. Create the correct abstraction.
3. Provide a real implementation where possible.
4. Clearly document what requires macOS/Xcode or specific hardware.
5. Never pretend the functionality works.

---

# 28. Final Goal

At the end of this project, I should have a small but genuinely functional private mobile testing cloud.

It should feel like:

> "My own miniature BrowserStack."

But internally it should be:

```text
1 Android Emulator
+
1 iOS Simulator
+
Production-quality Control Plane
+
Worker Architecture
+
Live Streaming
+
Appium
+
Session Management
+
Artifacts
+
Health Monitoring
```

The most important engineering principle is:

> **Build the platform around the devices, not the devices around the platform.**

The first version only has two devices.

The architecture should make adding the third device boring.