# MFARM — MASTER ENGINEERING PROMPT
## Priority: Production-Grade Automation Execution Engine

You are the lead distributed-systems engineer and test-infrastructure architect for MFARM.

MFARM is a self-hosted Android device farm designed to provide organizations with reliable dedicated Android testing devices.

The immediate and highest-priority objective is:

> **Build an automation execution system that feels effortless to the user and is extremely reliable under real-world test workloads.**

Do NOT treat this as simply “running Appium on an emulator.”

The product we are building is a **device execution platform**.

The user should submit an automation suite and target device, and MFARM must take responsibility for the entire lifecycle:

```text
TEST REQUEST
    ↓
VALIDATE
    ↓
QUEUE
    ↓
RESERVE DEVICE
    ↓
PREPARE DEVICE
    ↓
INSTALL BUILD
    ↓
START AUTOMATION
    ↓
EXECUTE
    ↓
STREAM STATUS
    ↓
COLLECT ARTIFACTS
    ↓
CLEAN DEVICE
    ↓
HEALTH CHECK
    ↓
RELEASE DEVICE
    ↓
FINAL RESULT
```

The user should NOT need to understand:

- Cuttlefish
- QEMU
- KVM
- ADB
- emulator processes
- device boot state
- Appium internals
- device allocation
- cleanup
- recovery
- infrastructure failures

MFARM must abstract all of this.

---

# 1. FIRST: UNDERSTAND THE EXISTING REPOSITORY

Before writing code:

1. Explore the entire repository.
2. Identify:
   - frontend
   - backend
   - API layer
   - database
   - device management
   - Cuttlefish lifecycle
   - device agent
   - WebSocket/SSE infrastructure
   - authentication
   - existing execution code
   - logging
   - artifact handling
   - test infrastructure
3. Map the existing architecture.
4. Identify what already exists versus what is missing.
5. Do NOT replace working architecture unnecessarily.
6. Reuse existing abstractions where they are sound.
7. Identify architectural weaknesses that will prevent reliable automation execution.

Before implementation, produce:

```text
CURRENT ARCHITECTURE
EXECUTION ARCHITECTURE
GAPS
RISKS
PROPOSED CHANGES
IMPLEMENTATION PLAN
```

Then proceed to implementation.

---

# 2. CORE PRODUCT PRINCIPLE

The execution engine is MFARM's most important component.

Optimize for:

1. Reliability
2. Deterministic execution
3. Device isolation
4. Fast startup
5. Automatic recovery
6. Correct resource allocation
7. Observability
8. Idempotency
9. Failure containment
10. Excellent developer experience

Do NOT optimize only for raw execution speed.

A test that starts 5 seconds faster but randomly fails because the device was dirty is worse than a test that starts 5 seconds slower and succeeds consistently.

The target should be:

> **Predictable execution over maximum theoretical throughput.**

---

# 3. USER EXPERIENCE

The ideal user experience is:

```text
Select Project
      ↓
Select Test Suite
      ↓
Select Device
      ↓
RUN
```

After clicking RUN:

```text
Queued
  ↓
Device reserved
  ↓
Preparing device
  ↓
Installing APK
  ↓
Starting automation
  ↓
Running
  ↓
Collecting results
  ↓
Cleaning device
  ↓
Completed
```

The user should always know:

- current state
- what is happening
- why something is waiting
- estimated queue position where possible
- failure reason
- whether MFARM automatically recovered
- final result
- artifacts

Never expose vague errors such as:

```text
Execution failed
```

Instead provide actionable states:

```text
DEVICE_PREPARATION_FAILED

ADB connection could not be established after
3 recovery attempts.

MFARM automatically restarted the device.

The device has been quarantined and will not receive
another test until health validation succeeds.
```

---

# 4. DESIGN THE EXECUTION STATE MACHINE

Implement an explicit execution state machine.

Do NOT rely on scattered booleans.

Example:

```text
CREATED
  ↓
VALIDATING
  ↓
QUEUED
  ↓
ALLOCATING_DEVICE
  ↓
DEVICE_RESERVED
  ↓
PREPARING_DEVICE
  ↓
INSTALLING_BUILD
  ↓
STARTING_DRIVER
  ↓
RUNNING
  ↓
COLLECTING_ARTIFACTS
  ↓
CLEANING_DEVICE
  ↓
HEALTH_CHECK
  ↓
COMPLETED
```

Failure branches:

```text
FAILED
CANCELLED
TIMEOUT
DEVICE_FAILURE
INFRASTRUCTURE_FAILURE
TEST_FAILURE
```

Recovery states:

```text
RECOVERING
RETRYING
QUARANTINED
```

Every transition must be explicit and persisted.

Example:

```text
execution_id
previous_state
new_state
timestamp
reason
metadata
```

The system must be able to reconstruct exactly what happened during an execution.

---

# 5. EXECUTION MUST BE IDEMPOTENT

Assume every distributed operation can fail halfway through.

Examples:

```text
APK installation starts
network disappears
request times out
```

The retry must NOT create corruption.

Design operations so they are idempotent where possible:

```text
reserveDevice()
prepareDevice()
installBuild()
startExecution()
collectArtifacts()
releaseDevice()
```

A retry must safely determine:

> “Did this operation already complete?”

Do not blindly execute the operation again.

Use:

- execution IDs
- operation IDs
- idempotency keys
- persisted state
- leases
- heartbeats

where appropriate.

---

# 6. DEVICE ALLOCATION

Build a proper device allocator/scheduler.

Never allow clients to directly acquire devices.

Architecture:

```text
Client
   ↓
Execution API
   ↓
Scheduler
   ↓
Device Allocator
   ↓
Device Agent
```

A device must have an explicit state:

```text
PROVISIONING
READY
RESERVED
PREPARING
RUNNING
CLEANING
RECOVERING
OFFLINE
QUARANTINED
```

Only `READY` devices may be allocated.

When a device is allocated:

```text
READY
 ↓
RESERVED
```

The reservation must have:

- execution ID
- owner
- timestamp
- expiration/lease
- heartbeat

Prevent:

- double allocation
- stale reservations
- orphaned sessions
- race conditions

---

# 7. DEVICE LEASES

Use a lease mechanism.

Example:

```text
device-01
lease:
    execution_id = exec-123
    acquired_at = ...
    expires_at = ...
    heartbeat = ...
```

If the execution process crashes:

```text
heartbeat stops
      ↓
lease expires
      ↓
device recovery
      ↓
health validation
      ↓
device returns to READY
```

A crashed client must never permanently lock a device.

---

# 8. DEVICE PREPARATION

Before every execution, MFARM must establish a known baseline.

Define a deterministic preparation pipeline.

Example:

```text
CHECK DEVICE
    ↓
ADB CONNECTIVITY
    ↓
BOOT COMPLETED
    ↓
DEVICE HEALTH
    ↓
CLEAR PREVIOUS SESSION
    ↓
STOP PREVIOUS DRIVER
    ↓
CLEAN TEST APP STATE
    ↓
INSTALL REQUIRED APK
    ↓
VERIFY INSTALLATION
    ↓
CONFIGURE TEST ENVIRONMENT
    ↓
READY FOR EXECUTION
```

Do not assume the device is clean.

Always verify.

---

# 9. DEVICE CLEANUP

After EVERY execution:

```text
STOP AUTOMATION
      ↓
STOP DRIVER
      ↓
COLLECT LOGS
      ↓
COLLECT SCREENSHOTS
      ↓
COLLECT VIDEO
      ↓
RESET APP STATE
      ↓
REMOVE TEMPORARY FILES
      ↓
RESET TEST ENVIRONMENT
      ↓
ADB HEALTH CHECK
      ↓
DEVICE HEALTH CHECK
      ↓
READY
```

Cleanup must execute even when:

- test fails
- test times out
- user cancels
- automation crashes
- Appium crashes
- client disconnects
- execution service crashes

Use `finally`/deferred cleanup semantics or equivalent durable workflow handling.

---

# 10. DEVICE HEALTH SYSTEM

Implement a dedicated health monitor.

Monitor at minimum:

```text
ADB connectivity
Android boot completion
Device responsiveness
CPU
RAM
Disk
Network
Cuttlefish process
Virtualization process
Automation driver
```

Define health checks such as:

```text
adb devices
adb shell getprop sys.boot_completed
adb shell echo health
```

and other appropriate checks for the actual architecture.

Health should not simply mean:

```text
ADB device exists
```

A device can have ADB connectivity while being unusable.

Define:

```text
HEALTHY
DEGRADED
UNHEALTHY
```

---

# 11. AUTOMATIC RECOVERY

This is a core differentiator.

When something fails, MFARM should attempt recovery automatically before declaring failure.

Example:

```text
ADB failure
   ↓
Retry ADB
   ↓
Restart ADB connection
   ↓
Verify device
```

If still failing:

```text
Restart automation driver
```

If still failing:

```text
Restart device/emulator
```

If still failing:

```text
Quarantine device
```

Then:

```text
Execution
   ↓
DEVICE_FAILURE
```

Do NOT endlessly retry.

Every recovery mechanism must have:

- retry count
- timeout
- backoff
- maximum recovery duration
- final failure state

---

# 12. FAILURE CLASSIFICATION

Separate:

### Test failure

The application/test itself failed.

Example:

```text
Assertion failed
Element not found
Expected result mismatch
```

This should NOT mark the device unhealthy.

---

### Device failure

The device became unusable.

Example:

```text
ADB disconnected
device frozen
boot failure
```

The device should be recovered/quarantined.

---

### Infrastructure failure

Example:

```text
Scheduler failure
database unavailable
artifact storage failure
```

The execution should be handled independently of test failure.

---

### User/configuration failure

Example:

```text
Invalid APK
Invalid credentials
Invalid test configuration
```

Do not waste retries on these.

---

# 13. NEVER CONFUSE TEST FAILURE WITH INFRASTRUCTURE FAILURE

This is critical.

Example:

```text
Test failed
```

does NOT automatically mean:

```text
Device failed
```

Likewise:

```text
ADB disconnected
```

does NOT mean:

```text
Test assertion failed
```

The execution result model should explicitly represent:

```text
test_status
device_status
infrastructure_status
execution_status
```

---

# 14. AUTOMATION DRIVER LIFECYCLE

Design the Appium/automation driver lifecycle explicitly.

Example:

```text
CREATE DRIVER
    ↓
HEALTH CHECK
    ↓
START SESSION
    ↓
EXECUTE
    ↓
STOP SESSION
```

Driver failure:

```text
DRIVER FAILURE
     ↓
attempt recovery
     ↓
restart driver
     ↓
reconnect
```

Do not let driver processes leak.

Every execution must have strict process ownership.

---

# 15. PROCESS ISOLATION

Every execution should have a unique execution context.

Example:

```text
/var/lib/mfarm/executions/{execution_id}/
```

Store:

```text
logs/
screenshots/
video/
reports/
driver/
metadata/
```

No execution may accidentally read or overwrite another execution's files.

Avoid global temporary paths.

---

# 16. ARTIFACT COLLECTION

Capture:

```text
Test report
Screenshots
Video
Automation logs
ADB logcat
Device logs
Driver logs
Execution metadata
Failure diagnostics
```

Artifacts must be available even when the test fails.

For example:

```text
Execution #1234

FAILED

Reason:
Element not found

Artifacts:
✓ Test report
✓ Screenshot
✓ Video
✓ Logcat
✓ Appium log
✓ Execution timeline
```

---

# 17. LIVE EXECUTION EVENTS

The frontend should receive live events.

Example:

```text
EXECUTION_QUEUED
DEVICE_RESERVED
DEVICE_PREPARING
APK_INSTALLING
AUTOMATION_STARTING
TEST_RUNNING
TEST_STEP
ARTIFACT_CREATED
TEST_FAILED
CLEANUP_STARTED
DEVICE_READY
EXECUTION_COMPLETED
```

Use the existing WebSocket/SSE infrastructure if appropriate.

Do not make the frontend poll aggressively.

---

# 18. EXECUTION TIMELINE

Every execution should have a timeline.

Example:

```text
10:30:01  Execution created
10:30:01  Device allocated
10:30:04  Device healthy
10:30:06  APK installed
10:30:08  Appium started
10:30:11  Test started
10:31:43  Test failed
10:31:44  Screenshot captured
10:31:45  Logcat captured
10:31:48  Device cleanup started
10:31:52  Device healthy
10:31:52  Device released
```

This is extremely valuable for debugging reliability problems.

---

# 19. QUEUEING

Support queued executions.

Example:

```text
Device 01
   ↓
RUNNING

Execution A → RUNNING
Execution B → QUEUED
Execution C → QUEUED
```

When A finishes:

```text
cleanup
 ↓
health check
 ↓
B starts
```

Do not start B until the device is confirmed healthy.

---

# 20. FAIRNESS

Avoid starvation.

If ten users submit tests, don't let one user monopolize the device forever.

Design a scheduler that can eventually support:

- FIFO
- priority
- team quotas
- organization quotas
- reserved devices
- dedicated devices
- shared device pools

For V1, implement a clean FIFO scheduler with architecture that allows future scheduling policies.

---

# 21. DEDICATED DEVICE SEMANTICS

MFARM must support:

```text
Device:
android-primary
```

The user requests:

```text
device = android-primary
```

The scheduler resolves that logical device to the actual underlying device.

The user should NOT need:

```text
Cuttlefish instance ID
ADB serial
VM ID
internal hostname
```

The abstraction should be:

```text
MFARM DEVICE
```

not infrastructure identifiers.

This is critical because the same logical device abstraction should eventually support:

```text
Cuttlefish
Android Emulator
Real Android Device
```

without changing the customer's automation.

---

# 22. CI/CD EXECUTION

Design the execution API so CI systems can invoke MFARM without using the UI.

Example:

```http
POST /api/v1/executions
```

Conceptually:

```json
{
  "project": "payments",
  "suite": "regression",
  "device": "android-primary",
  "build": "app.apk"
}
```

Return immediately:

```json
{
  "execution_id": "exec-123",
  "status": "QUEUED"
}
```

Then provide:

```text
GET /executions/{id}
```

and an event/status mechanism.

CI should be able to:

```text
submit
 ↓
wait
 ↓
receive final status
 ↓
fail/pass pipeline
```

Do not make CI depend on browser sessions.

---

# 23. API IDEMPOTENCY

CI systems retry requests.

Therefore:

```http
Idempotency-Key: <unique-key>
```

or equivalent must be supported for execution creation.

If the same request arrives twice:

```text
DO NOT CREATE TWO TEST RUNS
```

Return the original execution.

---

# 24. CANCELLATION

Users must be able to cancel queued and running executions.

Queued:

```text
QUEUED
 ↓
CANCELLED
```

Running:

```text
RUNNING
 ↓
STOP AUTOMATION
 ↓
COLLECT ARTIFACTS
 ↓
CLEAN DEVICE
 ↓
HEALTH CHECK
 ↓
CANCELLED
```

Never simply kill the execution and leave the device dirty.

---

# 25. TIMEOUTS

Everything needs explicit timeouts.

Examples:

```text
Queue timeout
Device allocation timeout
Boot timeout
APK installation timeout
Driver startup timeout
Test timeout
Artifact collection timeout
Cleanup timeout
Health-check timeout
```

Never allow an execution to hang forever.

---

# 26. OBSERVABILITY

Build observability into the execution engine.

Metrics:

```text
execution_success_rate
execution_failure_rate
device_failure_rate
device_recovery_rate
queue_time
device_start_time
apk_install_time
driver_start_time
test_duration
cleanup_duration
total_execution_duration
```

Device metrics:

```text
device_uptime
device_utilization
device_error_rate
adb_disconnect_rate
recovery_count
quarantine_count
```

These metrics will eventually determine whether MFARM is actually reliable.

---

# 27. CORRELATION IDs

Every execution must have a unique ID.

Every related log must contain:

```text
organization_id
project_id
execution_id
device_id
user_id/service_account
```

Example:

```text
[exec-123]
[device-01]
[project-payments]
APK installation started
```

This should allow an engineer to trace an execution from API request to final result.

---

# 28. SECURITY / TENANCY

Execution resources must be organization-scoped.

Never allow:

```text
Organization A
```

to access:

```text
Organization B
```

artifacts, devices, executions or logs.

Every execution must have:

```text
organization_id
```

and authorization must be enforced server-side.

Do not trust frontend filtering.

---

# 29. RESOURCE LIMITS

Protect the infrastructure.

Each execution should have limits for:

```text
CPU
memory
disk
execution duration
artifact size
APK size
log size
parallel execution count
```

Prevent one broken test from taking down the farm.

---

# 30. DEVICE QUARANTINE

If a device repeatedly fails health checks:

```text
READY
 ↓
FAILURE
 ↓
RECOVERY
 ↓
FAILURE
 ↓
QUARANTINED
```

A quarantined device must NOT receive new executions.

Expose:

```text
Device unavailable

Reason:
Repeated ADB failures

Last recovery:
10:42 AM

Attempts:
3

Action:
Device quarantined
```

Admin can:

```text
[Recover Device]
```

---

# 31. CRASH RECOVERY

Assume every component can crash.

Examples:

```text
Frontend crashes
Backend crashes
Scheduler crashes
Device agent crashes
Appium crashes
Cuttlefish crashes
Network disconnects
Machine reboots
```

After recovery, the system must reconcile reality with persisted state.

Example:

```text
Database says:
device = RUNNING

Actual device:
no execution running
```

MFARM must detect this and recover the device.

Do not rely solely on in-memory state.

---

# 32. RECONCILIATION LOOP

Implement a background reconciliation process.

Periodically:

```text
Database state
      ↕
Actual device state
```

Detect:

```text
orphaned execution
stale lease
dead driver
dead device
missing artifact
incorrect device state
```

Repair automatically where safe.

This is a key distributed-systems reliability pattern.

---

# 33. DATABASE MODEL

Design persistent entities around:

```text
Organization
User
Team
Project
Device
DeviceCapability
Execution
ExecutionAttempt
ExecutionEvent
DeviceLease
Artifact
ServiceAccount
```

Do not overload a single `execution` table with everything.

Consider:

```text
Execution
   ↓
ExecutionAttempt
   ↓
Device
```

because an execution may require an infrastructure retry without becoming a new user-visible test run.

Example:

```text
Execution #123
   Attempt #1 → device failure
   Attempt #2 → successful
```

The user should still see:

```text
Execution #123 → PASSED
```

with the recovery history available.

---

# 34. RETRIES

Be extremely careful with retries.

Do NOT blindly rerun failed tests.

Distinguish:

```text
TEST FAILURE
```

from:

```text
INFRASTRUCTURE FAILURE
```

Only infrastructure failures should normally trigger automatic execution recovery.

Example:

```text
Assertion failed
→ no automatic rerun

ADB disconnected
→ recovery allowed

Device crashed
→ recovery allowed

Scheduler timeout
→ retry allocation

APK invalid
→ no retry
```

This prevents false green results.

---

# 35. EXECUTION ATTEMPTS

Represent infrastructure recovery as attempts.

Example:

```text
Execution 123

Attempt 1
Device: android-primary
Result: DEVICE_FAILURE
Recovery: device restarted

Attempt 2
Device: android-primary
Result: TEST_FAILURE
```

Final result:

```text
TEST_FAILURE
```

This is far better than simply:

```text
FAILED
```

---

# 36. PERFORMANCE

Optimize the execution critical path.

Measure:

```text
request → queue
queue → device
device → ready
ready → APK installed
APK → driver started
driver → test started
test → completed
completed → device ready
```

Do not guess where performance problems are.

Measure them.

Avoid unnecessary:

- device reboots
- APK reinstallations
- process startup
- network round trips
- polling
- serialization
- artifact copying

But NEVER sacrifice device isolation/reliability simply to save a few seconds.

---

# 37. DEVICE WARMNESS

Design the architecture so devices can remain warm.

A ready device should ideally already be:

```text
booted
ADB-connected
healthy
```

Therefore:

```text
RUN REQUEST
    ↓
RESERVE READY DEVICE
    ↓
INSTALL BUILD
    ↓
START TEST
```

instead of:

```text
RUN REQUEST
    ↓
BOOT DEVICE
    ↓
WAIT
    ↓
CONNECT ADB
    ↓
PREPARE
    ↓
TEST
```

However, never assume a warm device is healthy.

Always perform a lightweight health check.

---

# 38. TEST DATA / APP STATE

Design a clear strategy for test isolation.

Determine which state is reset between executions:

```text
Application data
Application installation
Accounts/session
Permissions
Database state
Network state
Device settings
```

Make the policy explicit.

For example:

```text
FULL_RESET
APP_RESET
PRESERVE_DEVICE
```

Do not let individual tests accidentally contaminate subsequent tests.

---

# 39. LOGGING POLICY

Logs must be structured.

Example:

```json
{
  "timestamp": "...",
  "level": "INFO",
  "organization_id": "...",
  "execution_id": "...",
  "device_id": "...",
  "component": "device-agent",
  "event": "APK_INSTALL_STARTED"
}
```

Avoid relying entirely on free-form logs.

Structured events should power the execution timeline.

---

# 40. TESTABILITY

The execution engine must be highly testable.

Create tests for:

### Scheduler

- device available
- device unavailable
- concurrent requests
- stale lease
- cancellation
- fairness

### Device lifecycle

- normal boot
- ADB failure
- driver failure
- emulator crash
- cleanup failure

### Execution

- test pass
- test failure
- timeout
- cancellation
- infrastructure failure
- retry

### Recovery

- successful recovery
- failed recovery
- quarantine

### Crash recovery

- scheduler restart
- agent restart
- backend restart

### Idempotency

- duplicate execution request
- duplicate device reservation
- duplicate cleanup
- duplicate release

---

# 41. FAILURE INJECTION

Do not only test the happy path.

Create controlled failure scenarios.

Simulate:

```text
ADB disconnect
Appium crash
Device freeze
Cuttlefish crash
Network failure
Database restart
Scheduler restart
Agent restart
APK installation failure
Artifact upload failure
Client disconnect
```

Then verify:

> Does MFARM recover automatically and leave the system in a consistent state?

This is more important than simply having hundreds of unit tests.

---

# 42. DO NOT OVERENGINEER V1

Build the smallest architecture that provides the reliability guarantees above.

Do NOT prematurely add:

- Kubernetes if unnecessary
- Kafka if unnecessary
- microservices everywhere
- distributed databases
- complex scheduling algorithms
- excessive abstraction

A reliable modular monolith + device agent can be better than five unreliable microservices.

Use the existing MFARM architecture wherever practical.

---

# 43. PRODUCTION QUALITY BAR

Before declaring the execution engine complete, it must satisfy:

```text
✓ No double device allocation
✓ No orphaned device leases
✓ No permanently locked devices
✓ No cross-organization execution access
✓ No silent execution failures
✓ No infinite hangs
✓ Cleanup after every execution
✓ Health check after every execution
✓ Automatic recovery for infrastructure failures
✓ Device quarantine after repeated failures
✓ Idempotent execution creation
✓ Persistent execution state
✓ Crash recovery
✓ CI/CD API
✓ Live execution status
✓ Complete execution timeline
✓ Complete artifacts
✓ Structured logs
✓ Metrics
✓ Failure classification
✓ Automated integration tests
✓ Failure-injection tests
```

---

# 44. DEVELOPMENT PROCESS

Implement in phases.

## Phase 1 — Execution foundation

Build:

```text
Execution model
Execution state machine
Device lease
Device allocator
Execution API
Persistent execution state
```

---

## Phase 2 — Device lifecycle

Build:

```text
Device preparation
ADB validation
APK installation
Driver lifecycle
Cleanup
Health checks
```

---

## Phase 3 — Reliability

Build:

```text
Timeouts
Retries
Recovery
Quarantine
Reconciliation
Crash recovery
Idempotency
```

---

## Phase 4 — User experience

Build:

```text
Live execution status
Execution timeline
Logs
Artifacts
Failure diagnostics
```

---

## Phase 5 — CI/CD

Build:

```text
Execution API
Service accounts
API tokens
CI polling/events
CLI if appropriate
```

---

## Phase 6 — Reliability testing

Build:

```text
Integration tests
Concurrency tests
Failure injection
Crash recovery tests
Load tests
```

---

# 45. IMPORTANT: DO NOT JUST WRITE CODE

For every major implementation decision, explain:

```text
Problem
Decision
Why
Alternatives considered
Trade-offs
Failure modes
```

Prefer simple, deterministic designs.

Do not introduce a dependency merely because it is popular.

---

# 46. FINAL DELIVERABLE

At the end, provide:

```text
1. Current architecture
2. New execution architecture
3. Architecture diagram
4. Database model
5. Execution state machine
6. Device state machine
7. API
8. Scheduler design
9. Device lifecycle
10. Recovery strategy
11. Failure classification
12. Security model
13. Observability model
14. Test strategy
15. Failure-injection strategy
16. Implementation changes
17. Files changed
18. Remaining risks
19. Next implementation steps
```

Most importantly:

> **Do not optimize MFARM to merely execute automation. Optimize it to execute automation repeatedly, predictably, recover from infrastructure failures, isolate users, clean devices correctly, and leave the farm healthy after every run.**

The end-user experience should feel like:

```text
                MFARM

Select test
    ↓
Select device
    ↓
       RUN
        ↓
   MFARM handles
   everything else
        ↓
      RESULT
```

The complexity belongs inside MFARM.

The user should experience simplicity.
The infrastructure should provide engineering-grade reliability.