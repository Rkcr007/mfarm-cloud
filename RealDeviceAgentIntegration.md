# MFARM — Real Device Agent Integration

## Context

You are working on an existing project called **MFARM**, a self-hosted Android device farm.

The current system already supports **virtual Android devices using Cuttlefish running on a Linux/GCP host**.

Current conceptual architecture:

```text
                    MFARM CONSOLE
                         |
                      MFARM API
                         |
                  Device Management
                         |
              +----------+----------+
              |                     |
        Virtual Devices         Future Real Devices
              |
         Cuttlefish
              |
          /dev/kvm
              |
          GCP Linux VM
```

The existing Cuttlefish implementation is already working or under active development.

### IMPORTANT

Do NOT replace, rewrite, or destabilize the existing Cuttlefish architecture.

The goal of this task is to **extend MFARM to support physical Android devices through a lightweight MFARM Agent**, while preserving the existing virtual-device functionality.

The final MFARM architecture should support both:

```text
Virtual Android Device
        +
Physical Android Device
```

through the same MFARM Console and Device Management abstraction.

---

# 1. Product Goal

Implement support for physical Android devices using a lightweight **MFARM Agent**.

The intended user experience is:

1. A team installs MFARM Agent on a Linux, Windows, or eventually macOS machine.
2. An Android phone is connected to that machine using USB.
3. MFARM Agent detects the phone through ADB.
4. Agent performs device health/enrollment checks.
5. Agent registers the device with MFARM Cloud/API.
6. The device automatically appears in the MFARM Console.
7. A user can reserve/open the device.
8. User can view the live screen.
9. User can interact with the device remotely.
10. User can install an APK.
11. User can launch/stop/clear the application.
12. User can execute automated tests against the physical device.
13. Agent executes automation locally near the physical device.
14. Results, logs, screenshots, video and artifacts are sent back to MFARM.
15. If the device disconnects, the Agent attempts recovery.
16. The console clearly distinguishes:
   - Virtual devices
   - Real devices
   - Available
   - Busy
   - Offline
   - Unhealthy

The physical device should feel like a first-class MFARM device.

---

# 2. Core Architectural Principle

Do NOT make the cloud execute every ADB/Appium command through the Internet.

Use this architecture:

```text
                         MFARM CLOUD
                              |
                   +----------+----------+
                   |                     |
             Device Manager          Job Manager
                   |                     |
                   +----------+----------+
                              |
                       Secure Agent
                          Connection
                              |
                         MFARM AGENT
                              |
                +-------------+-------------+
                |             |             |
               ADB          Appium       Test Runner
                |             |             |
                +-------------+-------------+
                              |
                         Physical Android
                              |
                             USB
```

The cloud should primarily handle:

- authentication
- device registry
- scheduling
- reservations
- jobs
- orchestration
- metadata
- results
- artifacts
- console state

The Agent should handle:

- ADB
- Appium
- UiAutomator2
- test execution
- screen capture
- video capture
- logcat
- APK installation
- device health
- recovery
- local execution
- device cleanup

This minimizes network latency and makes automation significantly more reliable.

---

# 3. Preserve the Existing Virtual Device Architecture

The existing architecture should remain conceptually:

```text
MFARM
 |
 +-- VirtualDeviceProvider
 |       |
 |       +-- Cuttlefish
 |
 +-- RealDeviceProvider
         |
         +-- MFARM Agent
                 |
                 +-- Physical Android
```

Do not duplicate business logic unnecessarily.

Create a common device abstraction.

For example:

```text
Device
 |
 +-- VirtualDevice
 |
 +-- RealDevice
```

or use the project's existing abstraction if one already exists.

The scheduler, console and job system should operate on the common abstraction rather than directly knowing about Cuttlefish or physical Android implementation details.

---

# 4. Device Model

Extend the existing device model only as necessary.

A physical device should expose information such as:

```json
{
  "id": "real-pixel9-001",
  "type": "real",
  "platform": "android",
  "manufacturer": "Google",
  "model": "Pixel 9",
  "androidVersion": "16",
  "sdkVersion": 36,
  "serial": "ABC123",
  "agentId": "agent-office-01",
  "connection": "usb",
  "status": "available"
}
```

Do NOT assume every field is available on every device.

Use capability-based detection.

Potential capabilities:

```text
adb
appInstall
appUninstall
shell
screenCapture
screenStreaming
input
logcat
appium
uiautomator2
videoRecording
networkControl
deviceReset
```

---

# 5. MFARM Agent

Create a standalone component:

```text
mfarm-agent
```

It should be designed to run on:

- Linux
- Windows

Architecture should avoid unnecessary OS-specific coupling so macOS can be added later.

The Agent should be independently installable and versioned.

Example:

```text
mfarm-agent
   |
   +-- Agent Runtime
   +-- Device Discovery
   +-- ADB Manager
   +-- Appium Manager
   +-- Test Runner
   +-- Streaming
   +-- Health Monitor
   +-- Recovery Manager
   +-- Artifact Manager
   +-- Secure Cloud Connection
```

Use the existing backend language/framework if there is a strong reason.

Do NOT introduce a new programming language merely for this feature unless there is a compelling technical justification.

---

# 6. Device Discovery

The Agent should continuously monitor connected Android devices.

Initial implementation should use:

```bash
adb devices
```

or the equivalent ADB API/library.

When a new device appears:

```text
USB connected
      |
      v
ADB detected
      |
      v
Collect device metadata
      |
      v
Run health checks
      |
      v
Register with MFARM
```

When a device disappears:

```text
ADB disconnected
      |
      v
Mark device as temporarily unavailable
      |
      v
Attempt reconnect
      |
      v
If recovered -> AVAILABLE
If not -> OFFLINE
```

Do not immediately delete the device from MFARM when it disconnects.

---

# 7. Device Enrollment

Implement an enrollment/registration flow.

When a new phone is detected:

```text
NEW DEVICE

Google Pixel 9
Android 16
Serial ABC123

[Enroll]
```

The Agent should perform checks such as:

```text
ADB available
ADB authorized
Device reachable
Android version
SDK version
Manufacturer
Model
Serial
Battery
Storage
Screen state
App installation
Shell access
```

If possible, also validate:

```text
Appium
UiAutomator2
Screen capture
Input control
```

Only mark the device:

```text
AVAILABLE
```

after successful validation.

If checks fail:

```text
NEEDS_ATTENTION
```

with a useful reason.

---

# 8. Phone Prerequisites

Document the prerequisites for a physical Android device.

Initial supported configuration:

- Android device
- Developer Options enabled
- USB debugging enabled
- ADB authorization accepted
- USB connection to Agent host
- Reliable USB cable
- Device powered
- Device available to ADB

Prefer devices configured to:

- stay awake while charging
- avoid automatic system updates during testing
- maintain sufficient storage
- avoid aggressive battery optimization where applicable

Do not silently modify security-sensitive device settings.

Any configuration that requires user action should be surfaced clearly.

---

# 9. USB First

The first implementation MUST prioritize:

```text
Physical Android
      |
     USB
      |
MFARM Agent
```

Do NOT make wireless ADB a prerequisite for MVP.

Design the connection abstraction so that later we can support:

```text
USB
Wi-Fi ADB
```

without redesigning the device model.

Example:

```text
DeviceConnection
 |
 +-- UsbAdbConnection
 |
 +-- WirelessAdbConnection
```

---

# 10. Secure Agent ↔ Cloud Communication

The Agent should establish an outbound secure connection to MFARM.

Do not expose ADB directly to the public Internet.

Preferred conceptual architecture:

```text
Agent
  |
  | outbound TLS/WebSocket
  |
  v
MFARM Gateway
```

The Agent should authenticate using a device/agent enrollment token or equivalent secure mechanism.

Never send raw ADB ports publicly.

Never require users to expose port 5555 to the Internet.

Design the protocol so the cloud can:

```text
register agent
heartbeat
report device state
receive jobs
send control commands
upload artifacts
report results
```

---

# 11. Agent Heartbeat

Implement an Agent heartbeat.

Example:

```text
Agent heartbeat
    |
    +-- agentId
    +-- version
    +-- timestamp
    +-- connected devices
    +-- resource health
```

The cloud should detect:

```text
HEALTHY
DEGRADED
OFFLINE
```

Agent heartbeat failure must not immediately destroy device records.

---

# 12. Device Lifecycle

Define explicit device states.

At minimum:

```text
DISCOVERING
ENROLLMENT_REQUIRED
AVAILABLE
RESERVED
BUSY
CLEANING
UNHEALTHY
DISCONNECTED
OFFLINE
```

Define valid transitions.

Example:

```text
DISCOVERING
    |
    v
AVAILABLE
    |
    v
RESERVED
    |
    v
BUSY
    |
    v
CLEANING
    |
    v
AVAILABLE
```

Failure:

```text
BUSY
  |
  v
ADB DISCONNECTED
  |
  v
RECOVERING
  |
  +----> BUSY
  |
  +----> UNHEALTHY
```

Do not allow multiple jobs to control the same physical device simultaneously.

---

# 13. Device Reservation / Locking

Before executing tests:

```text
User
 |
 v
Reserve Device
 |
 v
Device Scheduler
 |
 v
Device LOCKED
 |
 v
Run Job
```

A reservation should have:

- owner
- job ID
- start time
- expiration/lease
- device ID

Implement lease expiry so abandoned sessions don't permanently lock a device.

---

# 14. Local Automation Execution

This is extremely important.

When a test job is assigned to a physical device:

```text
MFARM Cloud
      |
      | Job
      v
MFARM Agent
      |
      +-- Test Runner
      |
      +-- Appium
      |
      +-- UiAutomator2
      |
      v
Physical Android
```

Do NOT route every individual Appium/UI command through the cloud.

The Appium server and test runner should run as close to the physical device as practical.

The cloud should receive:

```text
job state
test state
logs
screenshots
video
results
artifacts
```

---

# 15. Appium Integration

Use Appium with UiAutomator2 for Android automation unless the existing project has a stronger established automation implementation.

The Agent should be capable of:

```text
start Appium
create session
install application
launch application
execute test
collect results
terminate session
cleanup
```

Do not assume one Appium session should remain alive for hundreds of tests.

Design for session recreation/recovery.

---

# 16. Test Execution Strategy

Do not initially execute:

```text
200 tests
|
single Appium session
|
test 1 → test 2 → ... → test 200
```

Prefer job/batch execution:

```text
Test Job
 |
 +-- Batch
 |     +-- Test 1
 |     +-- Test 2
 |     +-- Test 3
 |
 +-- Batch
 |     +-- Test 4
 |     +-- Test 5
 |
 +-- ...
```

Define recovery boundaries.

If Appium crashes after test 57:

```text
Restart Appium
Reinitialize device
Resume from appropriate boundary
```

Do not blindly rerun tests without recording why they were rerun.

---

# 17. Device Cleanup

Real devices do not naturally provide the clean snapshot/reset behavior available with virtual machines.

Therefore implement a device cleanup pipeline.

After a test or test batch:

```text
Stop app
    |
Clear app state
    |
Reset test data
    |
Reset permissions where appropriate
    |
Remove temporary files
    |
Verify device health
    |
AVAILABLE
```

Use safe Android mechanisms such as package-level cleanup.

Do NOT perform destructive device-wide factory resets automatically.

The reset strategy must be configurable.

---

# 18. Failure Classification

Do NOT classify every failure as an application/test failure.

Introduce failure categories:

```text
TEST_FAILURE
APPLICATION_CRASH
ASSERTION_FAILURE

INFRASTRUCTURE_FAILURE
ADB_FAILURE
APPIUM_FAILURE
DEVICE_DISCONNECTED
USB_FAILURE
AGENT_FAILURE
NETWORK_FAILURE

DEVICE_HEALTH_FAILURE
LOW_STORAGE
LOW_BATTERY
DEVICE_LOCKED
DEVICE_UNRESPONSIVE
```

This is essential for trustworthy reporting.

Example:

```text
Test #87 FAILED

Category:
INFRASTRUCTURE_FAILURE

Reason:
ADB connection lost

Action:
Agent attempted reconnect
Appium session recreated
Test marked infrastructure failure
```

---

# 19. Automatic Recovery

Implement recovery progressively.

For example:

```text
ADB failure
    |
    v
Check device
    |
    +-- connected -> restart ADB/Appium
    |
    +-- disconnected -> wait/reconnect
    |
    +-- unavailable -> mark device unhealthy
```

For Appium:

```text
Appium failure
    |
    v
Terminate session
    |
    v
Restart Appium
    |
    v
Create new session
    |
    v
Continue according to retry policy
```

Never create infinite retries.

All retries must have:

- maximum attempts
- timeout
- reason
- logging

---

# 20. Screen Streaming

Physical-device screen streaming should use the Agent as the capture point.

Conceptually:

```text
Phone
  |
  | ADB / screen capture
  v
MFARM Agent
  |
  | encoded stream
  v
MFARM Gateway
  |
  v
Browser
```

Do not stream raw frames inefficiently.

Use an appropriate low-latency encoding approach.

Keep streaming separate from automation execution.

If screen streaming fails:

```text
Automation should NOT automatically fail.
```

Streaming is an observability/control feature, not the core execution transport.

---

# 21. Manual Interaction

The console should support:

- tap
- swipe
- long press
- text input
- back
- home
- recent apps
- screenshot
- app launch
- APK installation

All manual commands should ultimately be handled by the Agent.

---

# 22. Device Information

For physical devices expose:

```text
Manufacturer
Model
Android version
SDK
ABI
Serial
Resolution
Density
Battery
Storage
Connection type
Agent
Agent version
Capabilities
Status
Last heartbeat
Last seen
```

Do not assume every device reports identical information.

---

# 23. Multi-Device Agent

The Agent must support multiple phones.

Example:

```text
MFARM Agent
 |
 +-- Pixel 9
 +-- Galaxy S24
 +-- OnePlus 13
 +-- Motorola Edge
```

Each device must have independent:

- ADB state
- Appium state
- test process
- logs
- screen stream
- reservation
- artifacts
- lifecycle

One broken device must not bring down the Agent or other devices.

Use process isolation where appropriate.

---

# 24. Security

Treat physical-device access as privileged.

Implement:

- Agent authentication
- TLS
- device authorization
- user authorization
- device reservation
- command authorization
- audit logging

Never expose unrestricted shell access to every MFARM user unless explicitly authorized.

A device's ADB shell is effectively privileged access.

---

# 25. Console UX

Extend the existing device grid rather than creating an entirely separate product.

Example:

```text
DEVICES

┌───────────────────────────────┐
│ Pixel 9                       │
│ REAL DEVICE                   │
│ Android 16                   │
│ 🟢 Available                  │
│ Agent: Office-01             │
│                               │
│ [Open] [Reserve] [Run Tests] │
└───────────────────────────────┘
```

Virtual:

```text
┌───────────────────────────────┐
│ Cuttlefish-01                 │
│ VIRTUAL DEVICE                │
│ Android 17                   │
│ 🟢 Available                  │
│ GCP / mfarm-host              │
│                               │
│ [Open] [Reserve] [Run Tests] │
└───────────────────────────────┘
```

Both should use the same UI patterns.

Add filters:

```text
Type:
  All
  Virtual
  Real

Status:
  Available
  Busy
  Offline
  Unhealthy

Android:
  Version

Manufacturer:
  Google
  Samsung
  OnePlus
  etc.
```

---

# 26. Architecture Before Coding

Before making code changes:

1. Explore the existing repository.
2. Identify:
   - current backend
   - API layer
   - device model
   - Cuttlefish integration
   - scheduler
   - WebSocket/streaming architecture
   - authentication
   - database
   - frontend device UI
   - execution engine
3. Produce a concise architecture map.
4. Identify the minimum integration points.
5. Identify reusable existing components.
6. Do not duplicate existing infrastructure.
7. Do not rewrite working Cuttlefish functionality.

Then propose the implementation plan.

Only after the plan is reviewed internally should implementation begin.

---

# 27. Implementation Requirements

Implement incrementally.

### Milestone 1 — Agent foundation

- Agent process
- Configuration
- Authentication/enrollment
- Cloud connection
- Heartbeat

### Milestone 2 — Device discovery

- ADB detection
- Device metadata
- Device registration
- Connect/disconnect handling

### Milestone 3 — Device lifecycle

- Available
- Reserved
- Busy
- Offline
- Unhealthy
- Recovery

### Milestone 4 — Manual control

- Screenshot
- Screen streaming
- Tap
- Swipe
- Text
- Keys
- APK installation

### Milestone 5 — Automation

- Appium
- UiAutomator2
- Local test execution
- Results
- Logs
- Screenshots
- Video

### Milestone 6 — Reliability

- cleanup
- reconnect
- Appium restart
- ADB recovery
- test retry policies
- infrastructure failure classification

### Milestone 7 — Multi-device

- multiple phones per Agent
- concurrent jobs
- per-device isolation
- scheduler integration

---

# 28. Do Not Overengineer the MVP

Do NOT initially implement:

- Kubernetes-based Agent orchestration
- complex distributed databases
- wireless Android as a requirement
- remote ADB exposed publicly
- device virtualization
- Android cloning
- factory-reset automation
- complex multi-region architecture

The first production-quality milestone should be:

```text
Linux Agent
     |
     +-- USB Pixel/Samsung/OnePlus
     |
     v
MFARM Cloud
     |
     v
MFARM Console

User can:

✓ See device
✓ Reserve device
✓ Open device
✓ Stream screen
✓ Interact
✓ Install APK
✓ Run Appium tests
✓ Collect results
✓ Recover from common failures
```

---

# 29. Compatibility Strategy

Do not promise universal Android compatibility immediately.

Define supported device profiles.

Start with a small matrix:

```text
Google Pixel
Samsung Galaxy
OnePlus
```

Then expand.

Record compatibility information per device.

Example:

```text
device
 |
 +-- adb
 +-- appium
 +-- streaming
 +-- installation
 +-- reset
 +-- automation
```

This will allow MFARM to learn which OEM/device combinations are reliable.

---

# 30. Performance Goal

The Agent architecture must ensure:

```text
Cloud network latency
```

does not become part of every automation action.

Target:

```text
Cloud → Agent:
job/control messages

Agent → Phone:
ADB/Appium/UI operations

Agent → Cloud:
results/artifacts/events
```

This is the primary performance architecture.

---

# 31. Reliability Goal

Design for long-running execution.

The system should be able to execute:

```text
100–200 tests
```

on a physical device without requiring manual intervention under normal conditions.

This does NOT mean pretending physical devices are perfectly deterministic.

Instead:

- detect failures
- recover automatically
- isolate infrastructure failures
- reset application state
- recreate Appium sessions
- collect evidence
- report accurate failure reasons

The goal is **high operational reliability**, not unrealistic zero-failure claims.

---

# 32. Important Design Decision

Do not create separate automation systems for virtual and physical devices.

Use:

```text
             MFARM Device
                  |
       +----------+----------+
       |                     |
    Virtual                  Real
       |                     |
  Cuttlefish              Agent
       |                     |
      ADB                   ADB
       |                     |
       +----------+----------+
                  |
            Common Device
              Interface
                  |
             Test Runner
```

This allows the same automation framework to execute against:

```text
Cuttlefish-01
Cuttlefish-02
Pixel 9
Galaxy S24
OnePlus 13
```

---

# 33. Expected Final Architecture

The target architecture is:

```text
                           MFARM CONSOLE
                                |
                             MFARM API
                                |
                     +----------+----------+
                     |                     |
                Device Manager        Job Scheduler
                     |                     |
                     +----------+----------+
                                |
                       Device Abstraction
                                |
              +-----------------+-----------------+
              |                                   |
       Virtual Device Provider             Real Device Provider
              |                                   |
         Cuttlefish                         MFARM Agent
              |                                   |
         GCP Linux VM                   +---------+---------+
              |                          |         |         |
           /dev/kvm                     ADB     Appium    Runner
                                          |         |         |
                                          +---------+---------+
                                                    |
                                             Physical Android
                                                    |
                                                   USB
```

---

# 34. Deliverables

After implementation, provide:

1. Architecture summary.
2. List of files/components changed.
3. MFARM Agent architecture.
4. Cloud ↔ Agent protocol.
5. Device lifecycle/state machine.
6. Device enrollment flow.
7. API changes.
8. Database/schema changes.
9. Console/UI changes.
10. Automation execution flow.
11. Recovery strategy.
12. Security model.
13. Local development instructions.
14. Linux Agent installation instructions.
15. Windows Agent installation instructions.
16. Device prerequisites.
17. Test strategy.
18. Integration tests.
19. Failure/recovery tests.
20. Known limitations.
21. Future Wi-Fi-device architecture.

---

# 35. Testing Requirements

Do not consider the feature complete merely because a phone appears in the UI.

Verify the complete lifecycle:

```text
Agent starts
    ↓
Phone connected
    ↓
ADB detected
    ↓
Device enrolled
    ↓
Device appears in console
    ↓
Reserve
    ↓
Open
    ↓
Stream
    ↓
Manual interaction
    ↓
Install APK
    ↓
Launch app
    ↓
Run automated test
    ↓
Collect screenshot
    ↓
Collect logs
    ↓
Finish test
    ↓
Cleanup
    ↓
Release device
    ↓
Device available again
```

Also test:

```text
USB disconnect during test
ADB crash
Appium crash
Agent restart
Cloud disconnect
Cloud reconnect
Phone reboot
Phone locked
APK installation failure
App crash
Low storage
Device already reserved
Agent with multiple phones
Two jobs requesting same device
```

---

# 36. Critical Constraints

1. Preserve existing Cuttlefish functionality.
2. Reuse existing MFARM architecture wherever possible.
3. Avoid unnecessary rewrites.
4. Avoid public ADB exposure.
5. Execute automation locally on the Agent.
6. Treat physical devices as unreliable infrastructure and design recovery.
7. Keep virtual and physical devices behind one common abstraction.
8. Keep Agent independently deployable.
9. Support multiple devices per Agent.
10. Do not assume OEM-independent behavior.
11. Do not hide infrastructure failures as test failures.
12. Do not introduce unnecessary distributed-system complexity.

---

# 37. First Task

Before writing implementation code:

### Explore the repository deeply.

Identify exactly how the current MFARM implementation handles:

- Cuttlefish lifecycle
- device registration
- device state
- API
- WebSocket
- streaming
- authentication
- database
- frontend device cards
- job execution
- test execution

Then produce:

```text
CURRENT ARCHITECTURE
        ↓
INTEGRATION POINTS
        ↓
PROPOSED REAL DEVICE ARCHITECTURE
        ↓
FILES TO CHANGE
        ↓
IMPLEMENTATION PLAN
        ↓
RISKS
```

Do not blindly start creating files.

Use the existing architecture as the source of truth.

After understanding the repository, implement the **smallest clean production-quality change** that adds the Real Device Provider + MFARM Agent without destabilizing the current Cuttlefish implementation.    