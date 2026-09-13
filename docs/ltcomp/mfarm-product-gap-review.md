# MFARM product gap review

Authenticated review of [farm.mfarm.dev](https://farm.mfarm.dev/#/) on 9 September 2026, org **Lab**, user `admin@mfarm.local`. Screens covered: Fleet (Capacity, Catalogue, Live, Waiting), device detail, Apps, Runs, run detail, session detail, Health, Agents, Team, Settings, command palette, and the Launch composer.

No device session was launched, no app was uploaded, and no team member was created. One API key was created by an immediate-action control during inspection and was revoked immediately; the account returned to one active key.

> **This review is a point-in-time record and is no longer current.** It was written on 9 September
> 2026 and its findings were acted on immediately — the commit that added this file to the repo
> (`023f608`) already closed two of its three P0s. Everything below is preserved as written. For
> what is actually still missing, read **[Status, re-verified 13 September 2026](#status-re-verified-13-september-2026)**
> first: **all three P0 gaps are closed**, and so is the whole of step 1 of the recommended sequence
> bar one ops action.

---

## Verdict

MFARM is already a credible **self-hosted device-farm control plane**. It is not yet a complete LambdaTest alternative for QA users: capacity is currently unavailable, allocator messages conflict, and test-level failure debugging is the largest product gap.

| Metric | Observed |
|---|---|
| Devices ready | **0 / 5** |
| APK builds in library | 4 |
| Prioritized gaps | 11 |
| Strong foundations | 6 |

---

## Status, re-verified 13 September 2026

Each of the eleven gaps below was checked against the code on `main` at `78083a2`, not against a
changelog and not against the comments describing the work — the function, route or alert rule was
read. Where a row is split, the split is the honest one: the part that is built is named with its
evidence, and the part that is not is still a gap.

**All three P0 gaps are closed.** So is every line of step 1 of the recommended sequence except
"restore at least one READY device", which is not a code gap: `mfarm-lab` is deliberately powered
off between sessions, and the console now says so rather than reporting it as sickness.

### P0 — closed

| Gap | Status | Evidence |
|---|---|---|
| Fleet availability | **Closed** | `GET /v1/hosts` (`apps/api/src/http/routes/hosts.ts:76`, migrations 044 and 050) returns state, `last_heartbeat_at`, quarantine reason, disk, load, memory, `up_since` and cost per host. The Infrastructure Operations Center (ADR-0038, migrations 053–056, #183–#187) adds an overview, an append-only operations log, a power ledger, drain/resume/start/stop/retire and an SSE stream. Alerting exists: `MfarmHostSilent` and `MfarmNoUsableDevice` in `deploy/observability/alerts.yml`. |
| State consistency | **Closed** | `capacityState()` (`apps/api/public/console.js:2688`) derives ready/busy/blocked once from device state; the queue card, both Waiting empty states and `fleetHeadline` all read it. Commit `023f608`. |
| Test-level debugging | **Closed** | Migrations 042 and 048 carry test name, status and run name; `GET /v1/sessions/:id/results` (`results.ts:302`) serves them, and the run screen opens per-session test rows on demand (`state.runTests`, `console.js:6418`). |

### P1 — two closed, three partial, one open

| Gap | Status | Built | Still missing |
|---|---|---|---|
| API-key safety | **Closed** | Migration 049: a key takes a label, a scope, an expiry and records last use. The migration cites this review's one-click key by name. | — |
| Session evidence | **Mostly closed** | Video (045), results timed against the video, a failure that can be shown to somebody outside the org (051, `share.html`), per-artifact retention and expiry (046, 047). | Network log, UI hierarchy viewer, artifact search. |
| Runs discovery | **Partial** | `runsQuery` (`console.js:117`) is free-text search plus status filter plus cursor pagination; failures have share links. | Projects, tags, owner, branch, commit and date filters. |
| Manual testing | **Partial** | A "No build" payload mode, locale, and a tunnel to a private staging host (migration 052). | iOS, mobile-browser URL sessions, geolocation. |
| App library | **Mostly open** | `GET /v1/apps?package=` groups by package; install history is readable through `/v1/app-actions`. | URL upload, IPA and AAB, deletion (there is no `DELETE /apps/:id`), labels, visibility controls. |

### P2 — one partial, two open

| Gap | Status | Built | Still missing |
|---|---|---|---|
| Usage and billing | **Partial** | `GET /v1/account/usage` (`account.ts:146`) meters consumption by day, drawn on Health; `GET /v1/hosts` echoes the hourly rate and currency. | Per-team and per-device cost summaries, export, queue-versus-billed reconciliation. |
| Organisation controls | **Mostly open** | A fleet-operator role and an append-only operations log (053) — but scoped to infrastructure, not to the tenant. | Teams, projects, quotas, budgets, SSO/MFA, a tenant-facing audit log. |
| Onboarding and integrations | **Open** | Nothing. There are no capability snippets in the console and no webhook of any kind. | Capability builder, framework snippets, SDK examples, webhooks, CI integrations. |

### What this leaves as the real next slice

The review's own sequence, corrected for what shipped: step 1 is done, step 2 is two thirds done
(test rows and video are in; the network log, UI hierarchy and artifact search are not), and the
largest genuinely untouched surfaces are **app lifecycle** (delete, AAB/IPA, URL upload) and
**onboarding** (snippets, webhooks) — the second of which is the cheapest thing on this page and the
one a new user hits first.

One correction to the review's P0 prose: it reports that "the Health page also states that host
heartbeat and host state have no console read endpoint". That sentence was true when written and is
now the opposite of true. `GET /v1/hosts` exists and the Health page draws from it. Note the one
thing it honestly cannot show — there is no agent *version* column; `hosts.protocol_version` is what
the agent speaks, which moves when the protocol does, not when somebody ships an agent.

---

## What is already strong

1. Device-class catalogue with geometry, density, reset strategy, region, capabilities, and physical/virtual distinction
2. Explicit allocator concepts: ready capacity, leases, waiting requests, quarantine, recovery, and automatic reset
3. Run grouping through `mfarm:runId` with suite-owned pass/fail semantics
4. Checksum-keyed APK library and session-only installs
5. Evidence retention controls and per-artifact expiry
6. Agent pairing workflow and a useful global command palette

---

## Immediate blocker (P0)

**The control plane is reachable, but the farm is not usable.**

All devices are quarantined. Four virtual devices lost host heartbeat two days ago; the physical `SM-S918B` was last heard from twelve days ago.

The Health page also states that host heartbeat and host state have no console read endpoint. Fixing that observability gap is more valuable than adding another UI tab.

---

## Prioritized gaps

### P0

| Area | What is missing | Why it matters | Recommended slice |
|---|---|---|---|
| Fleet availability | No allocatable capacity: 0 of 5 ready; all five devices are quarantined. | The product cannot complete its core promise while no session can start. | Restore host heartbeat and add an operator-visible host read model with last heartbeat, agent version, failure reason, and remediation. |
| State consistency | The Waiting view says every device is available and on a clean snapshot while the header and Fleet say 0/5 ready. | Conflicting capacity truth makes queue and incident decisions unsafe. | Derive every capacity message from one allocator state machine; distinguish ready, idle-but-quarantined, leased, resetting, and offline. |
| Test-level debugging | Runs show aggregate pass/fail counts, but sessions can show 0 recorded WebDriver steps and no individual test/scenario rows. | A failed CI run cannot be diagnosed from the console without returning to another report. | Ingest test name, status, duration, error, stack, retry, and command timeline; add searchable test rows under each run. |

### P1

| Area | What is missing | Why it matters | Recommended slice |
|---|---|---|---|
| Session evidence | Evidence is a flat file list; no integrated video player, command-linked screenshots, network log, UI hierarchy viewer, or artifact search. | Raw logcat and downloadable files are slower to use than a synchronized failure timeline. | Build a session timeline with video, commands, screenshots, logs, and failure markers sharing timestamps. |
| Runs discovery | Runs have no visible search, filters, pagination controls, tags, projects, owner, branch, commit, or share link. | The current table works for a small lab but will not scale to daily CI volume. | Add project/build hierarchy or filters for run ID, status, app, device, user, branch, commit, and date. |
| Manual testing | The launch composer supports Android device classes and APKs, but no iOS, mobile-browser URL flow, tunnel, geolocation, locale, or explicit advanced controls. | It covers a narrow Appium/manual Android path rather than LambdaTest Real Device parity. | Keep one composer and add payload modes: App, Browser URL, and No build; gate controls by device capabilities. |
| App library | APK upload is solid but lacks URL upload, IPA/AAB coverage, version grouping, labels, visibility controls, deletion, and install history. | Teams will accumulate builds quickly and need lifecycle management. | Group by package, expose versions/checksums, add search and retention, and preserve the checksum deduplication behavior. |
| API-key safety | New API key creates immediately, with no name, scope, expiry, environment, or confirmation. | A harmless exploratory click created a live org-wide credential. | Use a creation dialog requiring a label and scope; support expiry, last-used metadata, per-key audit, and CI-specific keys. |

### P2

| Area | What is missing | Why it matters | Recommended slice |
|---|---|---|---|
| Organisation controls | Only member/admin/owner roles; no teams, projects, quotas, budgets, SSO/MFA, or audit log. | Organisation-wide device and key access becomes risky as membership grows. | Add project/team boundaries, role permissions, usage budgets, and immutable security/audit events. |
| Usage and billing | The landing page promises per-device-minute billing, but the authenticated console has no usage or cost view. | Admins cannot reconcile metering, team consumption, or queue-versus-billed time. | Add session-level metering records and daily/team/device cost summaries with export. |
| Onboarding and integrations | Settings gives the hub URL and auth rule, but no capability builder, framework snippets, SDK examples, webhooks, or CI integrations. | Users must infer MFARM-specific capabilities such as run binding and result reporting. | Generate copy-ready Appium examples and document `mfarm:runId`, `mfarm:bindSessionId`, result reporting, leases, and artifact APIs. |

---

## Recommended implementation sequence

**1. Make the farm trustworthy — first**
- Restore at least one READY device
- Expose host heartbeat and agent diagnostics
- Unify capacity and queue state copy
- Add alerting for 0 allocatable devices

**2. Make failures diagnosable — next**
- Individual test/scenario rows
- Command timeline and exceptions
- Integrated video and screenshot viewer
- Search and filters across runs

**3. Broaden test workflows — then**
- iOS and AAB/IPA support
- Mobile-browser URL sessions
- Tunnel and advanced device controls
- App version and visibility management

**4. Prepare for organisations — later**
- Scoped and named API keys
- Teams, projects, quotas, and audit
- Usage and billing views
- Capability builder and CI examples

---

## Product direction

Do not clone LambdaTest screen-for-screen. Keep MFARM's differentiated strengths: self-hosting, device classes, explicit reset stories, leases, and honest worker-confirmed actions. Borrow LambdaTest's mature debugging workflow — searchable builds/tests, command-linked evidence, and capability-aware session tools.
