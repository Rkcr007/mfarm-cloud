# The execution engine, from here to production

**What this is.** A sequenced plan for the seven things standing between MFARM's execution path and
one a stranger's CI can lean on. Each step names the schema change, the code change, the test that
proves it, and how it is verified on the farm. They are ordered so that each one is useful alone and
each one makes the next cheaper.

Derived 2026-09-07 at `011a620` / migration 038 by reading the code, not the specs — both
`AutomationExecutionPlan.md` and `docs/EXECUTION_MODEL.md` describe some of this as absent when it is
built, and one of them describes as built a thing that is only half true. Where they disagree with
this page, check the file.

---

## Where the execution path actually stands

**The record is solid.** `sessions` moves `QUEUED → ALLOCATING → ACTIVE → ENDED` under fence tokens,
`session_attempts` (033) counts tries, and `sweep()` in `apps/api/src/allocator.ts` is a real
reconciliation loop — idle-WebDriver expiry, queue promotion, stuck-install escalation, bounded reset
recovery (032), gated quarantine release (035), host-silence quarantine (038).

**The timeline exists in the database and over the wire, and nowhere else.** `execution_events` (030)
is append-only with nine kinds and no UPDATE or DELETE granted to `mfarm_app`. `GET /runs/:id/timeline`
polls it and `GET /runs/:id/events` streams it. No screen renders either.

**Failure reporting works for what the suite reports.** `test_results` (021) carries the message and
stack, `failure_class`/`failure_reason` (024) carries the taxonomy, and the run screen puts failures
above the session list with the farm's own incidents in a *separate* card — so a cable glitch is never
counted as a test failure. That separation is the thing most farms get wrong and it is right here.

**CI works.** `action.yml` plus `@mfarm/cli`, exit codes classified into `pass` / `test-failure` /
`setup-failure` / `capacity` / `interrupted`, device released on every exit path including a
double-^C. Any runner with Node 22 works through the CLI; only GitHub has a wrapper.

What follows is what is missing, in the order to build it.

---

## S1 — Queue fairness: one org can starve every other — **BUILT (2026-09-07)**

**The defect.** `promote_queued` reads the twenty oldest `QUEUED` sessions *globally*, ordered by
`created_at`, then skips each one whose org is at `max_concurrent`
(`037_allocate_by_class.sql:181-189`). An org holding twenty or more queued sessions at its cap fills
that entire window with rows that all `CONTINUE`. **A second org's session is never considered, with
devices sitting `READY`.** The sweep repeats the same window every ten seconds and produces the same
nothing, until the first org's backlog drains — which happens only at its cap rate, one session at a
time, as sessions end.

Invisible today because the farm has one org. It surfaces on the first day of the second team, which
is the pending decision in `STATUS.md` §4. `AutomationExecutionPlan.md` §20 asks by name for this not
to happen: *"If ten users submit tests, don't let one user monopolize the device forever."*

**Schema — migration 039.** Replace `promote_queued(integer)` so the candidate window is fair rather
than chronological:

```sql
SELECT s.id, s.org_id, s.region, s.constraints, o.max_concurrent
  FROM (SELECT s.*, row_number() OVER (PARTITION BY org_id ORDER BY created_at) AS rank
          FROM sessions WHERE state = 'QUEUED') s
  JOIN orgs o ON o.id = s.org_id
 ORDER BY s.rank, s.created_at
 LIMIT p_limit
```

Round-robin *across* orgs, strict FIFO *within* one. Every org's oldest session is considered before
any org's second, so the window can no longer be monopolised. `ORDER BY` still tie-breaks on
`created_at`, so with a single org the behaviour is byte-for-byte what it is today — which is what
makes this safe to ship to a live farm.

The cap check stays where it is. It bounds what an org *runs*; the rank bounds what an org *occupies
in the queue*, and the two were being asked of one mechanism.

**Code.** None. `allocator.ts` calls `promote_queued($1)` and does not care how it chooses.

**Test.** `apps/api/test/allocator.test.ts` — org A queues 25 sessions at cap 1, org B queues one
afterwards, one device is free. Today B waits forever; after this B is promoted. Assert on the
promoted org, not on a count, so the test states the fairness property rather than an arithmetic
coincidence.

**Verified.** The test was run against a live Postgres with the **037 function restored**, watched go
red, then green against 039 — the fix was not taken on trust. The FIFO-within-an-org test is green
under both, so it states a property rather than agreeing with the change. Migration 039, ADR-0028.

The first draft of the test had the wrong shape: org A released the device that freed, which drops A
under its cap and makes A legitimately first in line. The shipped version pins A *at* cap with a
second device — the production situation, where one team's CI queues a hundred jobs and every other
team stops.

**Still to verify on the farm.** Two orgs, four devices, a suite from each. The second org's first
session should start while the first org's backlog is still draining.

---

## S2 — The failure evidence is captured at the wrong moment — **BUILT (2026-09-07)**

**The defect.** `captureArtifacts()` (`workers/agent/src/agent.ts`) runs when the device enters
`CLEANING` — at teardown, after Appium has force-stopped the app under test. So the screenshot
reliably shows the launcher, and the logcat is a whole-session dump (2.55 MB average) with no marker
for when the failure happened.

**What it turned out to be, which is smaller than this section first said.** The plan proposed a new
`capture` action on the beat. It was not needed: migration 022 had already added a `screenshot` verb
to the `app_actions` pipeline **for this exact reason**, and its own header says so. The work was to
add the second verb, and to make the control plane request both **on its own** off a signal it had
been receiving and ignoring since migration 021 — the result POST.

**Schema — migration 040.**

- `app_actions.kind` gains `'logcat'`, and `app_actions_app_required` learns that two verbs name no
  app rather than one. Both are one line each because 022 converted that column from an enum to
  `text + CHECK` in anticipation.
- `app_actions.context jsonb` and `artifacts.context jsonb` — *why* something was captured, carried
  from the request to the artifact. A failure capture holds
  `{"source": "test-failure", "testResultId": …, "test": …}`. Without it, a session that fails six
  tests leaves six unlabelled files with adjacent timestamps.
- `request_capture(org, session, kind, context)`, `SECURITY DEFINER`, holding the three rules that
  keep this from making things worse: **coalesce** to one `PENDING` capture per kind per session,
  **require the capability** so a device that cannot capture never collects an action that fails,
  and **check the fence** so a late result cannot photograph the next tenant.
- `artifact_record` gains a tenth argument, with the nine-argument form kept as a forwarder — 037's
  deploy-window and rollback reasoning, unchanged.

**Code.** `results.ts` requests both captures on a `failed` result, wrapped so it can never fail the
report — a result must be recorded whether or not evidence can be taken. `workers.ts` carries
`context` on the beat, omitted when empty so an older agent's payload is unchanged. The agent gained
a `logcat` handler and passes `context` through to the upload, reading it and never interpreting it,
so a new capture source needs no agent release.

**What was deliberately NOT built.** `test_results.occurred_at` was in the plan and is not here:
nothing populates or reads it yet. It belongs with S4, where the timeline consumes it.

**Verified.** Seven API tests for the bounds (coalescing, the capability rule, a passing test asking
for nothing, an ended session, malformed context), and two end-to-end tests in
`workers/agent/test/install.test.ts` running a **real agent against a real control plane** — a
failure is reported, and both artifacts come back with bytes and the right `testResultId` without
the test ever asking the worker for anything. The first draft of that test read the artifact list
straight after `heartbeat()` and saw one of the two; the beat hands work over and returns, so it now
waits for both actions to settle. That was a race in the test, and it would have read as a flaky
product.

**The honest limit, unchanged from the plan.** The beat is ten seconds, so a failure-triggered
capture lands up to ten seconds after the assertion. Ten seconds late beats after-force-stop, and
S3 is what makes a late screenshot readable — the command trace says what happened in between.

## S3 — There is no step trace, so nothing can be highlighted — **BUILT (2026-09-07)**

**The gap.** The hub deliberately does not model WebDriver commands: *"the automation server is the
authority on what exists, and a hub that enumerates commands is a hub that breaks every time Appium
adds one."* That rule is correct, and ADR-0029 keeps it: what a step list needs is not a semantic
model but method, path, status, duration and time — what the proxy had in its hands one line before,
because it had just forwarded it.

**Schema — migration 041.** `session_commands`, append-only, RLS'd, `bigserial` (the only table in
the schema written once per command rather than once per session). `record_session_commands()` for
the batched write and `expire_session_commands()` for the sweep.

**What is deliberately not stored: bodies and headers.** A WebDriver body carries the customer's
selectors, their test data, and on `POST /element/:id/value` their passwords. The stored `error` is
the W3C code only — the message beside it quotes the selector. This is the single most important
line in the migration.

**Code.** `apps/api/src/commandLog.ts` — a synchronous, bounded, batched recorder that swallows and
counts every database error, so a control plane whose command log is broken still runs suites. The
proxy calls it without awaiting; the only awaited flush is on `driver.quit()`, because a CI job
reads its own trace the instant the suite finishes. `GET /v1/sessions/:id/commands` pages the
result and derives `failed` rather than storing it.

**The latency question this step was gated on is answered and pinned.** `record()` costs well under
0.05 ms per command, asserted as a test so it cannot quietly regress into an awaited write.

**Two real bugs found while verifying, neither of which a green test would have shown:**

1. `SELECT COALESCE(MAX(seq),0) … FOR UPDATE` — Postgres refuses `FOR UPDATE` beside an aggregate.
   The recorder's swallow-and-count then hid it as a *silently empty trace*: the module's designed
   failure mode working exactly as intended, and a reminder that "it did not crash" is not "it
   worked". Replaced with a transaction-scoped advisory lock, which is also the only thing that can
   serialise the first batch of a session, since there is no row yet to lock.
2. **A cross-tenant write.** The function derived the org by selecting the session, on the reasoning
   that `sessions` is FORCE ROW LEVEL SECURITY. `mfarm_definer` has **BYPASSRLS** — migration 012
   gave it that so `promote_queued` can read every org's queue — so RLS is not present inside any
   definer function. A test written to *confirm* the reasoning found org B writing a forged step
   into org A's session, filed under A. Now `p_org` is passed and named in the `WHERE`, which is the
   shape `request_capture` already had. **The general rule: RLS will not scope a definer function;
   the function must scope itself.**

**Verified.** Eleven tests in `apps/api/test/webdriver.test.ts` — ordering and numbering, the error
code without the message, no request body, no upstream session id, quit as the last step, the
awaited drain, cross-org read and write isolation, paging, the latency bound, and a database that
refuses the write not breaking the suite.

## S4 — The timeline learns about tests, and gets a screen — **BUILT (2026-09-07)**

**Schema — migration 042.** `test-failed` and `artifact-created` on the `execution_events` CHECK,
plus `test_results.occurred_at` — when the *suite* says the test finished, as against when we heard.
A reporter that flushes in an `after()` hook posts ten results in one burst, and a timeline built on
arrival time then claims the suite failed everything simultaneously, minutes after the session
ended. Optional, defaulted, and **clamped to the session's own lifetime**: a timestamp from a caller
is a claim, not a fact.

**`command-failed` is deliberately not a kind.** An implicit wait polls `findElement` until it
succeeds, so one successful step produces a dozen `no such element` responses. Those belong in the
session's step list, not on the run timeline — the run timeline stays a summary and the two link
rather than merge.

**Code.** `results.ts` emits `test-failed` before requesting evidence, so a live run shows the
failure and then its evidence arriving, in that order. `artifacts.ts` emits `artifact-created`
carrying the artifact id, so the entry is a *link to the picture* rather than a note that a picture
exists. The console gained a **What happened** card on the run screen and a **Steps** card on the
session screen.

**Red is reserved.** `test-failed` is `bad`; an `incident` is `warn`. The run screen already refuses
to conflate a test failing with the farm having a problem — its two cards are side by side for that
reason — and a timeline painting both red would undo it in the place a reader scans fastest.

**A shipped defect found on the way, and the reason no test could see it (D26).** `loadRunDetail`
spread `run` and `sessions` and **dropped `failures` and `incidents`**, so the Failures card — whose
own comment calls it "the whole payoff of runs plus outcomes" — has never rendered for anybody. The
optional chaining made it silent: the card did not throw, it was simply absent, and the screen
looked finished.

229 console-screen tests were green throughout because the fixture seeds `failures` **straight into
state**. *A test that seeds state tests the renderer, never the loader.* The fix ships with a test
that drives `loadRunDetail` against a stubbed `fetch`, verified by reverting the loader and watching
it go red.

**Verified.** Eight console tests (the loader, a timeline whose secondary fetch fails, the red/amber
reservation, an unknown kind rendering as itself rather than vanishing, the step table's failed-row
class, "no answer", the privacy note, and the empty state) and four API tests (the event and its
one-line headline, a passing test leaving no mark, the timestamp clamp against a 2020 and a 2099
claim, and evidence landing as a link).

## S5 — Video, recorded only for failures — **GATE MEASURED, design decided, not built**

**Why this is fifth and not first.** `EXECUTION_MODEL.md` §4.4 measured it: 37.5 MB for a five-minute
recording against 3.1 MB for everything else combined, and two saturated devices fill the control
plane's disk in **1.3 days**. Recording everything is not a feature, it is a scheduled outage. What
makes it affordable is knowing which sessions failed — which S2 and S4 have just made a fact the
control plane holds *during* the session rather than after it.

**The encoder already exists.** `workers/agent/src/devices/capture.ts` produces a bare H.264 Annex-B
elementary stream at 49–53 fps for the live view, from scrcpy where the jar is present and
`screenrecord` otherwise. This step does not add an encoder — §4.4's first bullet — it adds a
subscriber to one that is already running.

**Schema — migration 043.** One line, as 019 promised:

```sql
ALTER TABLE artifacts DROP CONSTRAINT artifacts_kind_check;
ALTER TABLE artifacts ADD  CONSTRAINT artifacts_kind_check
  CHECK (kind IN ('logcat', 'screenshot', 'video'));
```

Plus `artifacts.duration_ms` and `artifacts.started_at`, so a video can be seeked to a command's
timestamp. Video gets its own retention — days, not the fortnight logcat gets — via a second
`expires_at` policy rather than a second column.

**Code.**

- `workers/agent/src/devices/capture.ts` — a `RingRecorder` that subscribes to the existing stream
  and holds the last N seconds on disk (not memory: 500 kbps × 300 s is 18 MB per device and the
  agent runs on customer hardware), keyed by keyframe boundaries so a discarded prefix still decodes.
  Default 300 s at 10–15 fps, §4.4 bullet 3.
- The beat's `resets` entry gains `keepRecording: boolean`. The control plane sets it when the
  ending session has a `failed` test result. The agent muxes the ring to MP4 and uploads on that
  flag, discards otherwise. `packages/protocol/src/protocol.ts:235` is the type to change.
- Everything else — content addressing, retention, the RLS'd blob endpoint — already exists and is
  reused unchanged.

**The measurement that gated this step — TAKEN 2026-09-07, and it decides the design.**

`deploy/measure-encode-cost.mjs`, on the farm, interleaved, reproduced three times with a
run-to-run spread of 0.2fps:

| Workload | nothing recording | `screenrecord` running | |
|---|---|---|---|
| Flutter canvas | **29.9 fps**, 87 dropped | **19.9 fps**, 145 dropped | **−33% fps** |
| Native list | 30.2 fps, 55.6% jank, 36 dropped | 29.5 fps, **96.8% jank**, 87 dropped | fps holds, **dropped ×2.4** |

**Guest-side encode is not available on Cuttlefish on this host**, and both `screenrecord` and
scrcpy encode on the device — so the encoder `capture.ts` already runs is fine for a live view
somebody is watching and not fine under a suite whose timing is being asserted. Ordinary UI is the
more dangerous of the two results, because its fps *holds* while its dropped frames double:
`RENDER_BASELINE.md`'s warning is that the risk was never red suites, it is timing-sensitive
assertions silently reading a device three frames behind.

**So bullet 1 is no longer a preference, it is the requirement.** S5 records on the host, reusing
`cvd`'s WebRTC encode, and that path does not exist yet — it is the real remaining work. The
alternative, available immediately and honest, is shipping video for **physical devices only**,
where the encoder is dedicated silicon on the phone and this host's CPU is not in the loop.

That is a product decision rather than an engineering one, and it is the open question this step now
rests on. Full numbers and both caveats: `docs/RENDER_BASELINE.md`.

---

## S6 — A queued caller is told nothing — **BUILT (2026-09-07)**

`POST /v1/sessions` answered a queued caller with *"No device is free right now"* and nothing else;
`mfarm run` then printed *"waiting up to 300s"*. Over fifteen minutes of a CI log that is
indistinguishable from a hung process, and a person who cannot tell the difference kills the job.

**Schema — migration 043.** `queue_standing(org, session)`, `SECURITY DEFINER` because a caller has
to be told how many sessions are ahead of them *including other orgs'* — that is what makes the
number true — and RLS correctly hides those rows. The disclosure is bounded by what comes back:
**a count and a timestamp, never a row.**

**The position counts the way the queue drains.** ADR-0028 made promotion round-robin across orgs,
so position is the number of sessions whose `(queue_rank, created_at)` sorts before this one — the
same ordering `promote_queued` walks. A global `created_at` rank is the obvious implementation and
would now disagree with the scheduler: it would tell the second org's first session it was 26th when
it is next. **A queue position that does not match how the queue drains is worse than none, because
a person plans around it.**

**The estimate is pessimistic, and often absent.** It reads the *lease* — the latest a session may
run, not when it will end — so the real wait is usually shorter, and the wording says "at the
latest". Where nothing can be proved it is **null and the field is omitted**, never guessed: a
confident wrong number is what makes people stop trusting a queue. It is also matched on the device
class asked for, so a lease on a device that could not serve this session is not counted.

**Code.** Both `POST /v1/sessions` and `GET /v1/sessions/:id` return `session.queue` — the polling
endpoint matters more, since the POST's answer is stale by the second poll and watching the position
move is most of what makes a wait tolerable. Both calls are best-effort: a standing that cannot be
computed must never turn a successful queue into a 500. `mfarm run` prints
`queued: 3rd in line, 2 ahead — a device frees up in ~4m at the latest`, **only when the position
changes**, so a loop backing off from 1s to 10s does not bury the signal in identical lines.

**Verified.** Five tests: the position against the round-robin ordering (org B arrives *fourth* and
is *second*), cross-tenant refusal, a promoted session having no standing without that being an
error, null rather than a guess when no lease is readable, and the estimate ignoring a device of the
wrong class. The last one failed first on `devices_tier_check` — `emulator` is not a tier this
schema has, `avd` is.

## S7 — The reliability ceilings

Not execution-engine work, and named because "as reliable as the big farms" is false while any of
them stands. Taken in the order S7 itself argued for: deploy, then a second host, then the limiter.

### S7.1 — Deploy is manual — **BUILT (2026-09-07)**

**The defect.** A released commit reached the farm when a human ran `deploy/mfarm-deploy.sh`. On
2026-09-05 that was ninety minutes, and `docs/DEFECTS.md` spent all ninety claiming fixes were live
that were not (D18). Every "verified on the farm" claim made in such a window is worth exactly as
much as the answer to "which commit was the farm running".

**Schema.** None.

**Code.** `deploy/auto-deploy.sh` on a five-minute systemd timer, pulling rather than being pushed
to — ADR-0006's shape, and no standing SSH credential into production. The decision is a separate
tested function (`deploy/lib/autodeploy-decision.sh`) returning `paused | unknown | current |
blocked | waiting | deploy`; the doing is a fast-forward, a deploy, and a health gate of five
*consecutive* `/ready` responses. A commit that fails the gate is rolled back to the last build that
passed one and **never retried** — without that memory a timer turns one bad merge into a restart
every five minutes forever, which is worse than the manual deploy it replaces.

`apps/api/src/metrics.ts` reads the deployer's state from a read-only bind mount and exports
`mfarm_autodeploy_{check_age_seconds,pending_seconds,blocked,paused}`; three rules in `alerts.yml`
fire on a dead timer, a blocked commit, and a farm half an hour behind `main`. That last one is D18
as a number somebody can be paged about.

**Test.** `deploy/auto-deploy.test.mjs` executes the decision; `deploy/auto-deploy-run.test.mjs`
runs the whole script against a **real git repository** with the registry, the API and
`mfarm-deploy.sh` stubbed — the fast-forward, the fetch and `rev-parse origin/main` are the parts
most likely to be subtly wrong and a stub would agree with whatever was written. Seven cases in
`apps/api/test/metrics.test.ts`, and six in `alerts.test.yml` asserting both directions.

**Verified.** Six bugs were put back one at a time and watched. Three were caught immediately.
**Three were not**, and all three were defects in the tests rather than in the code:

* the "it fast-forwards" injection never applied — a `grep -v` pattern that silently matched
  nothing, so the run that "proved" the test discriminated had proved nothing;
* the pinned-copy assertion compared `./deploy` against an absolute path, two strings that can never
  be equal, so **deleting the self-pinning guard entirely left every test green**;
* the health-gate test built farms that were unhealthy on *every* probe, so it could not tell
  "ready three times" from "ready three times in a row" — the rule it exists for. It now drives a
  **flapping** `/ready`.

One further claim in a test comment — that an assertion caught `> 0` — turned out to be false and
is now recorded as false in the file: given a gauge whose domain is -1/0/1 no test can separate
`> 0` from `== 1`. `!= 0` *is* caught, and that is what the case is for.

**Verified on the farm, 2026-09-07 — including the case that matters most.** The timer was enabled
on `mfarm-cp` at 10:10 and then **deployed a commit by itself**, with nobody typing a deploy command:

```
10:32:44  want=820c987 running=90eda52 released=no  verdict=waiting
10:32:44  no image for 820c987 yet — Release runs after CI; will retry
10:38:34  Deployed 820c9871e24fbed99539691f729f58bcb5c7ea32
10:38:35  health gate: 5 consecutive /ready, 6s apart
10:39:00  deployed and healthy: 820c987
```

**That `waiting` tick is the whole point.** The merge had landed and Release had not published, which
is exactly the window this session walked into by hand four minutes after merging #128 — and the
deployer waited rather than falling back to building on the box.

Also verified on the box: `pinned-from` reads `/tmp/tmp.sq0yYzZDI9`, so a tick really does execute
from outside the tree it fast-forwards; the kill switch pauses and resumes, with
`mfarm_autodeploy_paused` following it; and `check-deployed.sh` reports image, control-plane
checkout and device-host checkout all on `main`.

**Not done here:** the device host. D19's worse half was `mfarm-lab`'s checkout sixty-six commits
behind, and bringing a worker's tree forward restarts the agent under running sessions — a different
decision with a different blast radius. The installer refuses that box and says which case it is in.

### S7.2 — One device host — **AUDITED (2026-09-07): nothing in the code blocks a second one**

A host outage is a farm outage. ADR-0027 and migration 038 reduce the blast radius; they do not
remove it. This is a **provisioning** decision before it is an engineering one — a second lab VM
costs money whether or not it is serving — so the work that belongs here is finding out what in the
control plane still assumes one host. That audit is done, and the answer is: **nothing does.**

| checked | finding |
|---|---|
| `allocate_device` (037) and `promote_queued` (039) | no `host_id` anywhere in either. Devices are chosen by region, platform, tier, capabilities and org; the host they sit on is not a term in the query |
| `hosts` / `devices` schema | `devices.host_id` is per row with its own index; `hosts.hostname` is UNIQUE; endpoint, capabilities, cores, worker token and quarantine state are all per host |
| the reaper | `sweep()` selects hosts as a set; the 038 silence quarantine is per host |
| the WebDriver hub | resolves `COALESCE(d.automation_endpoint, h.automation_endpoint)` per device and routes on `target.host_id`. Both ADR-0011 transports are per host |
| metrics | every host gauge is labelled `hostname` / `region`, including the S7.4 machine gauges |
| the console | no query or view picks "the host" |

**The one that could have blocked it, and does not.** `/dp/*` carries the live view and the path
segment is a host id. `setup-ingress.sh` builds that route two ways and says so: pointed straight at
a worker, *"only one host can be named here"*; pointed at the API, which relays down the tunnel each
agent dialled out, *"the only one that works for more than one host"*. **The deployed farm is on the
second path** — the live Caddyfile routes `/dp/*` to `127.0.0.1:3000` and `WORKER_DATA_PLANE` is
unset — so live view for a second host needs no ingress change at all.

What a second host actually costs is a VM, a `farm-up.sh` run, the boot unit, and a registration
token. All operational, none of it in this repo.

**The dev tooling does assume one**, harmlessly: `check-deployed.sh`, `farm-online.sh`,
`verify-failure.mjs` and friends default `MFARM_LAB=mfarm-lab`, all through env vars that already
override. They would each need a second name, or a loop, before they described a two-host farm
honestly — which is a real but small piece of work, and it is worth doing *when* there is a second
host rather than in anticipation of one.

### S7.3 — Rate limiting is in-memory — **AUDITED: it is not the first blocker, and the real one is bigger**

The row is true as far as it goes. `apps/api/src/http/server.ts` registers `@fastify/rate-limit`
with the default in-process store and says so in a comment: limits are per API instance, so a second
process silently multiplies every one of them.

**But swapping that store for Redis would not get a second instance working.** `TunnelRegistry` is
decorated per Fastify instance and holds its hosts in a process-local `Map`
(`apps/api/src/http/tunnel.ts`). `openControlChannel` returns `undefined` when the host is not in
*this* process's map. `metrics.ts` already says the quiet part — *"a viewer can only be relayed by
the replica holding that host's tunnel"* — and it understates the blast radius, because since
ADR-0011 the same registry carries **automation**, not only the live view:
`callOverTunnel(app.tunnels, route.hostId, …)` is how a WebDriver command reaches a host that is not
directly dialable.

So behind a naive round-robin load balancer, a second instance does not merely double the rate
limits — **roughly half of all tunnel-transport WebDriver sessions fail**, in a farm whose whole
point is that they do not. Fixing that is sticky routing by host id, or a relay bus between
replicas, and either is a genuine piece of architecture rather than a store swap.

**The honest recommendation is therefore not to build any of this yet.** Nothing needs a second API
instance: one process serves a four-device farm with room to spare, and S7.1's health gate has taken
the worst of the no-rolling-deploy sting out. When a second instance does become necessary, the
order is tunnel affinity first, rate-limit store second — the reverse of what this row implied.

### S7.4 — Worker-side metrics — **BUILT (2026-09-07), and the row describing it was wrong**

This step previously read *"the agent reports incidents, not gauges, so queue depth and capacity are
unobservable from Grafana"*. Checked against the code, the second half is false:
`collectFleet()` already exports `mfarm_sessions{state="QUEUED"}`, `mfarm_session_queue_oldest_seconds`,
`mfarm_devices` by state and placement, and `mfarm_host_last_heartbeat_timestamp_seconds`; the
dashboard has panels for them and `alerts.yml` has `MfarmQueueWaitLong`, `MfarmHostSilent` and
`MfarmNoUsableDevice`. `metrics.test.ts` has a case called *"queue depth and queue age are
reported"*. Queue depth and capacity have been observable for weeks.

What is genuinely missing is narrower and worth stating precisely: **everything is sampled from
Postgres by the control plane, so nothing observes the host itself.** Disk free, CPU, `cvd` and
`adb` health, agent version — all known to the agent, none of them numbers. That gap matters more
than it did last week, because the encode measurement in S5 showed the host's CPU is the binding
constraint on this farm, and a full disk on the lab is the classic way a device farm dies.

This is the third time a section of a spec in this repo has described as absent something already
built (`docs/DEFECTS.md`, and both MASTER PROMPT documents). Grep the verb before scheduling the
work.

**Schema — migration 044.** Five nullable columns on `hosts` plus `stats_at`, which is deliberately
not `last_heartbeat_at`: an agent too old to send stats still beats, so reading freshness from the
heartbeat column would present a week-old disk reading as current.

**Code.** `workers/agent/src/hoststats.ts` reads `statfs` (`bavail`, not `bfree` — the root reserve
is not usable by an agent that does not run as root), `loadavg`, and Linux `MemAvailable` out of
`/proc/meminfo`. Not `os.freemem()`, which is `MemFree` and sits near zero on any healthy
long-running box. The numbers ride the beat — ADR-0003's argument for capabilities, unchanged — and
are measured *outside* the heartbeat's `try`, because a stats read caught by that `try` would return
a failed beat and migration 038 quarantines a host that stops beating. Liveness outranks
observability, and the ordering is what enforces it.

`collectFleet()` exports six gauges plus `mfarm_host_stats_age_seconds`, and `alerts.yml` gains
disk-low, disk-critical, stats-stale and per-core saturation.

**The one design decision worth arguing about (ADR-0031).** A `NULL` emits **no series**, which
inverts the rule the rest of `metrics.ts` follows. `DEVICE_STATES` is zero-filled precisely so an
alert on an empty fleet still fires. Here a zero disk gauge does not read as "unmeasured" — **it
reads as a full disk** — so zero-filling would have paged for every host running an agent older than
044 on the first scrape after deploy.

**Test.** `workers/agent/test/hoststats.test.ts` (5), `apps/api/test/host-stats.test.ts` (7, through
the real registration and the real beat rather than seeded rows), six alert cases asserting both
directions. Four bugs were put back and all four were caught: zero-filling the gauges, setting
`stats_at` from every beat, trusting the worker's numbers uncoerced, and dropping the reset so a
deleted host keeps reporting a disk.

**Still not measured:** `cvd` and `adb` health. Both are known to the agent and both are a different
kind of measurement — a probe with a timeout, not a read of a counter. Disk, CPU and memory are the
three that end a farm without anybody noticing.

## The order, and why

1. ~~**S1 fairness**~~ — **done**, migration 039 / ADR-0028.
2. ~~**S2 evidence at failure time**~~ — **done**, migration 040.
3. ~~**S3 command trace**~~ — **done**, migration 041 / ADR-0029.
4. ~~**S4 timeline + screen**~~ — **done**, migration 042.
5. **S5 video** — affordable only after S2/S4 make "record only failures" expressible, and gated on
   one measurement. **Taken out of order:** S6 was built before it, because S5 cannot start until
   host-side encode is measured against the `RENDER_BASELINE.md` workload and `mfarm-lab` is
   stopped. S5 is now the only remaining execution-engine step.
6. ~~**S6 queue visibility**~~ — **done**, migration 043.
7. **S7 ceilings** — **S7.1 done** (ADR-0030): the box pulls `main` on a five-minute timer,
   health-gates what it deploys, rolls back what fails and refuses to retry it. **S7.4 done**
   (ADR-0031, migration 044): the host now reports its own disk, load and memory, and the row that
   said queue depth was the missing thing was wrong. **S7.2 audited** — nothing in the control plane
   assumes one device host, including the ingress, so a second one is a VM and a `farm-up.sh` run.
   **S7.3 audited and deliberately not built** — the rate limiter is not the first blocker to a
   second API instance; the process-local `TunnelRegistry` is, and it now carries automation as well
   as the live view.

Each step ships as its own PR with its own migration, and each is verified on a running farm before
the next starts — not when CI is green. `DEFECTS.md` states the reason: twice this month a fix was
reasoned, unit-tested, merged and completely inert.
