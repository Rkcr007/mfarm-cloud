# ADR-0044 — nothing is started that cannot finish

**Status:** Accepted · 2026-09-26 · no migration · amends ADR-0043 (AI runs)

## Context

On 2026-09-26 a person started an AI run from the console while the model provider's daily token
allowance for the farm's key was used up. The run was queued, the runner claimed it, the hub allocated
a device and installed their app, the agent asked the model — and only then learned what the previous
call had already been told. The run ended "no verdict" after 15 seconds; the run page said only "The
model could not be reached"; and the list the person went back to was stuck on "Loading…" (D49), so
the run looked as if it had never happened.

Nothing in that chain was wrong on its own terms. What was missing was a rule: **a thing that depends
on another thing must know whether that thing is working before it acts, and must say so when it is
not.** An AI run depends on four things, and each was discovered only by failing:

| Dependency | How it failed before |
|---|---|
| The farm has a model key | Checked — the form said "not switched on". The only one that was. |
| The model provider answers | Found out on the first model call, after a device was taken |
| A device of the platform can take a run | A stopped host: the run queued, waited 300s at allocation, failed "no device" |
| The budget can pay a step | Checked at the door — the only other one |

## Decision

**1. Every model call reports to a health tracker** (`ai/health.ts`), a circuit breaker per configured
provider. Failures are classified from the provider's HTTP status and its own retry hint — never from
prose: 429 → *limited* until the time it asked for (60s when it did not say); 402 / 401 / 403 / 404 →
*down* for 15 minutes (a key problem needs a person); 5xx, 408 and no answer at all → *down* for 60s.
A 400 or 413 is the request's own fault, says nothing about the provider, and is not recorded. Both
adapters throw one error type (`ModelError`) so this is decided once. The tracker is process memory:
the farm runs one API process, and a restart re-learns in one request.

**2. A provider that is down is not contacted.** `resilientModel` tries the configured providers in
order and skips one known to be down or limited; when none can serve it throws
`ModelUnavailableError` at once, naming the reason and the earliest time one can be tried again.

**3. An optional fallback provider** (`MFARM_AI_FALLBACK_API_KEY` / `_PROVIDER` / `_BASE_URL` /
`_MODEL`) serves while the primary cannot. Each provider is asked for its own model, and every step
records the model that actually answered, so a run half-served by the fallback says so. It is
validated at boot as strictly as the primary. A different vendor is the useful kind: a second key on
the same provider shares its outage and, on a free tier, its allowance.

**4. One go / no-go, `GET /v1/ai/readiness`**, answers "can a run start now" for a platform: configured,
model, devices, budget — each with a sentence a person can act on, when it lifts by itself (`retryAt`),
and where to fix it (`action`, e.g. *Open Infrastructure* for a stopped host). Devices count as able to
take a run when READY, busy, resetting or booting; quarantined, offline and evicted are not.

**5. The doors apply the same answer the page shows.** `POST /v1/ai/runs` and a saved test's Run
refuse with `503 ai_not_ready` (with `blocking`, `retryAt`, `action`) — nothing is queued that would
only fail later holding a device. **A run started by an upload is deferred instead** when only the
model is down: nobody is on the page to press Run again, so it waits in the queue. No devices, or no
key, still refuses it, and the upload's answer names the check (`aiRunsSkipped: devices`).

**6. The runner takes the model first, then a device.** Before every claim it asks whether a provider
can serve; one let back in only by the clock gets a one-token probe (at most one per 30s), so a
provider that is still down costs one request and never a device. A queued run that waits more than
six hours is given up with the reason and nothing billed.

**7. The console gates its controls on readiness** and polls it every five seconds while an AI screen
is open: *Start AI run* and each saved test's *Run* are disabled with the reason, until when, and a
button to the fix; *Explain this failure* needs the model and the budget but not a device. When the
dependency comes back the buttons enable themselves. If readiness itself cannot be read, the page says
so and does not block on a guess — the doors still check server-side.

## Consequences

- A person can no longer start a run the farm already knows cannot finish, and is told why and when.
- A run that would have been refused for a person is still possible from an upload, and starts on its
  own when the provider returns — the "fallback" for work nobody is watching.
- One extra request per cool-down while a provider is recovering (the probe). None while it is well,
  none while nothing is queued.
- The health tracker forgets on restart. Accepted: it re-learns in one call, and persisting a fact that
  is true for minutes is not worth a schema.
- Not covered: the MCP server (C1) needs devices, not a model, and already answers from the hub; the
  WebDriver hub's own capacity queue is unchanged.
