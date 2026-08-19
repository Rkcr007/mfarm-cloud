# MFARM — from "the console renders" to "a teammate uses it"

Execution plan, 2026-08-19. Reads after `HANDOFF.md` and `docs/MVP_PLAN.md`; it does not replace
either. Where they describe *what is built*, this describes **the ordered set of things left before a
person who is not us can open a URL and verify an Android build**.

---

## 0. Correcting the premise, because it changes the whole plan

The question that started this was "the UI is implemented, now integrate it into the backend and
remove the dummy data." **There is no dummy data, and there is no integration left to do at that
layer.**

`apps/api/public/console.js` is 77 KB of code with zero mock fixtures — grep it for
`mock|dummy|fixture|placeholder|lorem` and nothing matches. Every screen is driven by a real request
against the same process that serves the page:

| Screen | Endpoint(s) it actually calls |
|---|---|
| Sign in | `POST /v1/auth/login`, `GET /health` (public reachability pill) |
| Devices | `GET /v1/devices` |
| Apps | `GET /v1/apps`, `POST /v1/apps` (XHR, real upload progress), `GET /v1/app-actions` |
| Sessions | `GET /v1/sessions?limit=50` |
| Cockpit | `GET /v1/sessions/:id`, `POST /v1/sessions/:id/app-actions`, `GET /v1/app-actions/:id`, plus the data-plane WebSocket for video, input, logcat and screenshots |
| Launch | `GET /v1/devices`, `GET /v1/apps`, `POST /v1/sessions`, then the same app-action pipeline |
| Queue | derived from `/v1/sessions` + `/v1/devices` |
| Health | derived from `/v1/devices`, `/v1/sessions`, `/v1/app-actions` |
| Session card | `GET /v1/sessions/:id` for the held session |

It refreshes every 5s, pauses when the tab is hidden, and catches up on `visibilitychange`. At two
devices that **is** real-time; replacing it with a socket would add a half-connected failure mode to
buy nothing. Do not rewrite it.

The console is also already *hosted* in the only sense the code cares about:
`apps/api/src/http/routes/ui.ts` serves `/`, `/console.css`, `/console.js` and `/live.js` from the API
process behind a strict CSP and an explicit allowlist. There is no separate frontend to deploy, no
build step, no bundler.

### So what is actually fake?

**The devices.** Everything above has only ever been exercised against
`workers/agent/scripts/fake-farm.ts` — a worker that registers two devices called `FAKE (no Android)`
which log what they were asked to do and run nothing. It declares no `screen-stream` and no
`webdriver` precisely so nobody can demo a capability that does not work.

It does, since ADR-0007, run the **real** `DataPlane` — the socket, the offline grant verification,
the fence check, the input queue and the logcat stream are production code paths with a fake device
behind them. That is what makes the console's viewer developable without hardware, and the one place
the fake cannot follow is exactly where it says so: `signal-open` is answered with a refusal and a
reason, because there is no media source to negotiate with.

### "Real device" means real Android, not a handset

This document says "real device" a lot, and it means **tier 2 below**. Three tiers exist and only the
middle one matters here:

| Tier | What it is | Installs and verifies an APK? |
|---|---|---|
| `fake-farm.ts` | Not Android at all — a Node class that logs what it was asked to do. Model string reads `FAKE (no Android)`. | **No.** `installApp` is one `log()` line (`fake-farm.ts:68`), so a build that would fail on a device "succeeds" here. |
| **`tier: 'cuttlefish'`** | **Real AOSP Android 17 as a VM on Linux + KVM.** Real kernel, real framework, real adb serial. | **Yes. This is the MVP.** `cuttlefish.ts:627` runs `adb install -r` and parses adb's own `Failure [INSTALL_FAILED_…]`, because adb has historically exited 0 while failing. |
| `tier: 'physical'` | A handset on a USB hub. | Declared in the union at `device.ts:26` with **no backend implemented**. Not needed, not planned, not blocking. |

Cuttlefish is **virtual but not fake**: it boots the same AOSP build a phone runs, so adb genuinely
installs, UiAutomator2 genuinely drives the UI, and a failing test genuinely means the app is broken.
Two limits are real and neither argues for handsets — no Google Play Services (pure AOSP, hence ask
#4 in §5) and software rendering (hence the Flutter/RN caveat in §7).

So **"the box" is never a phone.** It is an x86_64 Linux machine with `/dev/kvm` that *hosts* the
virtual devices, and it is the only hardware anywhere in this plan.

That is the real gap, and it is not a UI gap. The honest statement of the remaining work is:

> The control plane, the console, the app pipeline and the WebDriver hub are built and tested. The
> farm they manage does not currently exist (the lab VM is terminated), and three product surfaces —
> **live view, artifacts, and team/account management** — have no backend at all.

**Updated 2026-08-19 (ADR-0007).** The live view is now built — including logcat and screenshots, the
first slice of what M3 calls artifacts — and has been exercised in a browser against `fake-farm.ts`,
which now runs the real data plane. Two of the three surfaces remain: **artifacts that outlive a
session** (a table, a blob route, retention — nothing is persisted today) and **team/account
management**. The live view's own remaining work is deployment, not code: §M4.

---

## 1. Answering the question you asked first: what is pending before this work

Six things. Two are blocking, four are not.

### BLOCKING — 1. There is no *permanent* host. ~~The lab VM is terminated.~~

**Unblocked for now, 2026-08-19: `mfarm-lab` is restored from `mfarm-farm-ready` and running, fleet
`available: 2`.** It bills by the hour, so it answers M1 and M2 and settles nothing about where this
lives permanently — that is still the spend decision below.

Nothing can be "working end to end with no mock data" without a machine running Cuttlefish. Two GCP
disk snapshots survive and are the whole difference between an afternoon and a week:

- `mfarm-cf-ready` — Cuttlefish + Android 17 system image
- `mfarm-farm-ready` — the above plus node 22, docker, Appium, and **both device snapshots**; restore
  this one and `deploy/farm-up.sh` brings the farm to `available: 2` without reinstalling anything.
  **Not quickly**: restoring an image is a host boot, and a host boot discards the device snapshots
  baked into it (HANDOFF.md issue 24), so both devices cold boot and re-snapshot before they are
  schedulable. The image saves the fetch, the build and the install — a day — not the boot.

Requirement is x86_64 with a real `/dev/kvm`. Arm is out permanently — snapshot/restore is x86_64
only. **This is a spend decision and it is yours** (§5, §6).

### ~~BLOCKING — 2. The console is designed for a tailnet, and you want it on the internet~~

**Largely closed 2026-08-19 (`83cf311`).** `deploy/setup-ingress.sh` puts Caddy in front with
Let's Encrypt over sslip.io, HSTS included; the API keeps its loopback bind; `TRUST_PROXY` gives the
rate limiter the real client address, and login is limited harder than everything else. All of it
was driven by a finding from the live box rather than from reasoning: behind the proxy every
anonymous caller on the internet arrived as `172.18.0.1`, so the whole world shared one 120/minute
bucket and any one caller could 429 everybody's login.

What remains of §M2 is the part that is not code: a real hostname instead of sslip.io, and the
external port scan that verifies the claim from outside rather than from `ss -tlnp` on the box.

Every `ports:` entry in `deploy/docker-compose.prod.yml` is still `127.0.0.1:`-prefixed on purpose,
which is what makes the proxy the only way in — a security posture to preserve deliberately, not to
undo by deleting a bind address.

### NOT BLOCKING, but must be known

**~~3. Two capabilities are advertised with no implementation.~~ CLOSED 2026-08-19 (ADR-0007).**
`logcat` is now implemented (`captureLogcat`, streamed over the data plane) and so is `screenshot`.
`recording` was DELETED from the declaration rather than implemented — the honest half of the fix,
and the one that restores ADR-0003's rule that a capability is observed state. It comes back when
`startRecording` does.

**4. `adb install` has never run from this code.** Migrations 014/015, `POST /v1/apps`, the job
pipeline over heartbeat, and `mfarm app install|launch|uninstall` are all tested — against a fake
device whose `installApp` is a log line. **The first real APK is a test, not a demo.** Expect it to
find something.

**~~5. The data plane binds the docker bridge (`172.18.0.1`).~~ CLOSED 2026-08-19 (ADR-0007).** The
two listeners bind separately now — `AUTOMATION_BIND_HOST` keeps the gateway host-local for the
containerised hub, `DATA_PLANE_BIND_HOST` puts the data plane where the console's ingress can reach
it. `farm-up.sh` and `install-worker-service.sh` both write the pair.

**6. Alertmanager has no receiver, backups have no off-box copy, and no host metrics exist.** 15
alert rules fire into a UI nobody watches. A full disk takes the database and the backups down and
nothing says so first. Both are roughly one config file each (§M5).

Not blocking and not in scope: blocker 5 (multi-instance — correct at N=1), known issue 2
(wedged-but-alive Appium), package publishing (`npx mfarm` does not resolve; every package is
`private: true`).

---

## 2. The whole idea, in one page

One box, two always-on Cuttlefish devices running Android 17, replacing a BrowserStack subscription
for a team that does not need Google Play Services. Three ways in, one control plane, one truth:

```
                         ┌──────────────────── the box (x86_64, /dev/kvm) ──────────────────┐
  teammate's browser     │                                                                  │
      │  HTTPS           │   ┌─────────────┐        ┌─────────────────────────────────┐      │
      ├──────────────────┼──▶│   console   │  same  │       control plane (API)       │      │
      │  cookie + CSRF   │   │  (static)   │ process│  Postgres + RLS, allocator,     │      │
      │                  │   └─────────────┘        │  metering, reaper, WebDriver hub │      │
      │                  │                          └──────────┬──────────────────────┘      │
      │                  │                      heartbeat/jobs │  (control plane never       │
      │                  │                                     │   dials a worker)           │
      │  WebSocket       │                          ┌──────────▼───────────┐                 │
      ├─── input ────────┼─────────────────────────▶│    worker agent      │                 │
      │  (Ed25519 grant, │                          │  data plane :7100    │                 │
      │   verified       │                          │  automation gw :7200 │                 │
      │   offline)       │                          └───┬──────────────┬───┘                 │
      │                  │                              │ adb          │ 127.0.0.1           │
      │  WebRTC media    │   ┌──────────┐  ICE/TURN     │              ▼                     │
      └── via coturn ────┼──▶│  coturn  │◀─────────┐    │        Appium + UiAutomator2       │
                         │   └──────────┘          │    │              │                     │
                         │                   ┌─────▼────▼──────────────▼─────┐               │
  Appium / CI            │                   │  cvd-1        cvd-2           │               │
      │                  │                   │  Android 17, snapshot-reset   │               │
      └── https://<key>:<session>@hub/wd/hub ┴───────────────────────────────┘               │
                         └──────────────────────────────────────────────────────────────────┘
```

Two invariants worth restating because every milestone below respects them:

- **The control plane cannot dial a worker.** Everything the API wants a device to do becomes a *job
  row* the worker collects on its next heartbeat and confirms host-scoped with a fence check. Resets
  work this way, app actions work this way, and artifacts and logcat must too.
- **A credential names a session.** The Ed25519 grant carries session, device, org, fence and host,
  and is verified offline by the worker. Network reachability is never authorisation. TURN is a
  *route*, not a permission (ADR-0005).

---

## 3. Plan of execution

Six milestones. Each ends in something a person can be shown. M3 and M4 are mostly pure code and can
be built for ₹0 while no box exists; M1, M2, M5 need the box.

### M1 — A real farm, and the first real APK  *(needs the box; ~1 day)*

The point of M1 is not "install software", it is **to make every screen in the console show a real
Android device instead of `FAKE (no Android)`.**

1. Restore `mfarm-farm-ready`, run `deploy/farm-up.sh`, confirm `GET /v1/devices` reports
   `available: 2` with real adb serials.
2. Operator hygiene that only ever happens on a box: `ALTER ROLE mfarm_app` off the committed
   password (`config.ts` refuses to boot in production if it sees it), real
   `WORKER_REGISTRATION_TOKEN`, real session secret, secrets as files.
3. Create real accounts: `node apps/api/src/bin/create-user.ts` per teammate. This is the only user
   provisioning that exists (§M5 gives it a UI).
4. **Push your real APK through `POST /v1/apps` and install / launch / uninstall it on a real device
   from the console.** This is the code path that has never met adb. Budget time for it to fail and
   fix forward — the pipeline shape is right, the shell-outs are unverified.
5. `deploy/verify-webdriver.mjs`, then a real Appium suite from a laptop, sharded across both devices.
   That is Phase 1's exit condition and has never been met.

**Done when:** the Devices, Apps, Sessions, Queue and Health screens are all showing real Cuttlefish
devices, and an APK you actually ship installs and launches from a browser click.

### M2 — Reachable by URL, safely  *(needs the box; ~half a day)*

The API keeps its loopback bind. A reverse proxy in front terminates TLS and is the only thing
public. Which proxy depends on §5's answer:

- **Box has a public IP** (cloud or dedicated) → **Caddy**, automatic Let's Encrypt, a 12-line
  Caddyfile, ports 80/443 only.
- **Box is an office mini PC behind NAT** → **Cloudflare Tunnel**, no inbound ports at all, TLS and
  DNS handled. Recommended for that case; NAT traversal for a self-hosted box is otherwise a
  recurring tax.
- **Operator-only, no public access** → `tailscale serve`, already documented in `deploy/README.md`.
  Cheapest, and it rules out everyone outside the tailnet including your own users.

Code changes this needs — small, but real:

- Cookies must set `Secure` behind a proxy. `users.ts:sessionCookie()` already takes a `secure` flag;
  it must be driven by config rather than by the request scheme, because behind a proxy the app sees
  plain HTTP. Same for `trustProxy`, so the rate limiter keys on the real client IP and not on the
  proxy's.
- HSTS, and login brute-force limiting stricter than the general rate limit. In-memory is correct
  at N=1.
- The WebDriver hub becomes internet-facing. It is designed for that — Basic auth carries an API key
  and every proxied hop needs a signed grant — but it deserves one review with that hat on.
- `deploy/README.md`'s `ss -tlnp` check must be updated so the new listener is expected rather than
  read as a mistake by whoever runs it next.

**Done when:** a teammate on a phone hotspot opens `https://farm.<yourdomain>`, signs in, and sees the
real fleet. Nothing else is publicly reachable — verified with `ss -tlnp` and an external port scan,
not by assumption.

### M3 — Artifacts: logcat, video, screenshots  *(no box needed to build; ~2 days)*

Closes pending item 3 and Phase 3. This is what makes a failed CI run explicable.

Worker side — `DeviceControl` gains four optional methods, in the same style `installApp` was added
(optional, and the capability is only declared by a backend that implements it):

```ts
captureLogcat?(sessionId: string): Promise<AsyncIterable<string>>;  // adb logcat, streamed
startRecording?(sessionId: string): Promise<void>;                  // adb shell screenrecord
stopRecording?(sessionId: string): Promise<string>;                 // → local mp4 path
screenshot?(): Promise<Buffer>;                                     // adb exec-out screencap -p
```

Control plane:

- **migration 016** — `artifacts(id, org_id, session_id, device_id, kind, sha256, bytes,
  content_type, created_at, expires_at)`, RLS on `org_id`, content-addressed on disk under
  `ARTIFACT_DIR` exactly as `APP_STORE_DIR` works today. **MinIO is deferred:** the S3 API buys
  nothing on a single box and is one more service to keep alive. Keep the interface narrow enough
  to swap later.
- Upload is **worker → API**, never API → worker: `POST /v1/sessions/:id/artifacts`, worker-token
  authenticated, host-scoped and fence-checked the way `device_reset_complete` is. The paying
  `org_id` is derived from the session, never read from the worker's body — architecture rule 4.
- `GET /v1/sessions/:id/artifacts`, `GET /v1/artifacts/:id/blob` (org-scoped, streamed).
- Screenshot on demand is a **new `app_actions` kind** — `kind = 'screenshot'` — so it inherits
  heartbeat delivery, host-scoped confirmation, the fence check and the reaper sweep for free.
  Migration 015 generalised the pipeline for exactly this.
- Logcat and video start on allocate and stop on release, so an artifact belongs to a session by
  construction. **A release must not be blocked on an artifact upload** — a device that cannot ship
  its video is still a device that must reset.
- Retention: `expires_at` plus a reaper sweep. A 500 GB disk and unbounded video is an outage.

Console:

- The cockpit's `stagePanel` placeholder gains a screenshot thumbnail strip, and a **Screenshot**
  button in Tools — shown only where the device declares the capability, the same honesty rule
  Install already follows.
- Session detail: video inline (`<video>`; `media-src 'self' blob:` is already in the CSP), a logcat
  pane with tail-follow and a filter, and a download per artifact.
- The Sessions list gets an artifact-count column, so a failed run is visibly worth opening.

**Done when:** a session that failed links to the video, the logcat and the screenshots of *that
session*, and an ended session still has them.

### M4 — Live interactive view  *(BUILT 2026-08-19 — ADR-0007, HANDOFF issue 28)*

> **Status.** The code half is done and exercised end to end in a browser against `fake-farm.ts`,
> which now runs the real `DataPlane`. What is left is the box: the operator's port confirmed, coturn
> deployed, the ingress `/dp` route live, and **both ICE modes exercised** — point 6 below is the one
> that has not been met and cannot be met on a laptop.
>
> The shape landed differently from the sketch below in two ways worth knowing. Signalling is
> relayed through the data-plane socket rather than the browser reaching the operator itself (the
> operator is unauthenticated device control and must not be public), and the CSP mostly did NOT
> have to be widened — routing `/dp` through the console's own ingress keeps the socket same-origin.
> Steps 1, 2, 3 and 4 landed as written.



The largest remaining gap between this and a product, and **cheaper than it looks**, because
`workers/agent/src/dataplane.ts` already does most of it: it verifies the grant offline, checks the
fence, resolves the device, returns `backend.media.endpoint()` in its `ready` message, and dispatches
`tap` / `swipe` / `key` / `text` with positional-coalescing and discrete-queueing already correct
(architecture rule 3). Cuttlefish's own WebRTC server produces exactly what a browser consumes.

What is missing is a route and a client:

1. **Separate the two binds** (pending item 5). The automation gateway keeps a host-local bind so the
   containerised hub can reach it; the data plane binds where a client can. One env var apiece rather
   than today's shared `BIND_HOST`.
2. **coturn on the host**, with credentials minted per session by the control plane — TURN REST-style
   HMAC over a static auth secret, expiring with the session. Same shape as the automation grant, so
   there is one story for "a credential names a session" and not two.
3. **`GET /v1/sessions/:id` returns an `ice` block** beside the existing `dataPlane` block, minted
   only for `ALLOCATING`/`ACTIVE` — a token for an ended session is a credential for whoever holds
   that device now.
4. **The viewer**, in `stagePanel`: WebSocket `hello` with the session token, an `RTCPeerConnection`
   against the returned media endpoint with the returned ICE servers, and pointer/keyboard events
   mapped onto the message types the data plane already speaks. Scale coordinates from the reported
   `device.screen`, never from the rendered element size.
5. **CSP must be widened** in `ui.ts`: `connect-src` is `'self'` only today, which forbids both the
   data-plane WebSocket and the TURN connection. This is the one place the strict CSP has to give,
   and it gives to exact origins, never to `*`.
6. **Exercise both ICE modes.** ADR-0005 is explicit: TURN is the fallback tier, direct candidates
   will still be used where they work, and a viewer tested only on a LAN has not been tested.

Set expectations honestly on frame rate: snapshot/restore forces `guest_swiftshader`, so rendering is
CPU-bound software rendering. This is triage-grade video, not smooth video, and Flutter/RN will be
worse than native.

**Done when:** a teammate with a URL and a password taps a real device in a browser, from outside your
network, with no client software installed.

### M5 — The surfaces the design has and the API does not  *(~2 days)*

`index.html` carries a deliberate comment where the ORGANISATION nav group would be: Team, Activity
and Settings are in the design and have no endpoint, and a nav item that opens an invented page is the
same lie as a button for a capability the device lacks. M5 gives them backends.

- **Team** — list users, invite/create, deactivate, change password. Today this is a script on the
  box; it should be a screen. `upsertUser` and `user_sessions` already exist.
- **Settings → API keys** — `createApiKey`/`revokeApiKey` exist in `auth.ts` with no route and no UI,
  so a teammate cannot get a CI credential without someone SSH-ing to the box. Show the plaintext
  once, then only the prefix.
- **Lease extend** — the cockpit says plainly that there is no Extend button because no endpoint moves
  `expires_at`. At two devices, contention is the dominant UX problem; add the endpoint (with a cap)
  and the button.
- **Queue position** — `promote_queued()` exists and re-applies constraints; the Queue screen should
  say *where you are*, not just that you are waiting.
- **Activity** — the app-actions timeline is per-session today; a fleet-wide feed answers "who did
  what to device 2".
- **Alerting that reaches a human** — one Alertmanager receiver (Slack webhook or SMTP), tested by
  actually breaking something. Plus the two missing rules: backup freshness and host disk.

### M6 — Publishing and the CI gate  *(~half a day)*

`action.yml` runs `npx --yes mfarm@latest` and every package is `"private": true`, so the GitHub
Action cannot work for anyone. Either publish the CLI or vendor it in the action and say so. Then put
one real suite behind a PR check on your app's repo — that is flow #1 in the plan of record and the
reason the farm pays for itself.

---

## 4. Sequencing, and what it costs to be wrong

```
        ₹0, no box needed                        needs the box
   ┌───────────────────────────┐        ┌──────────────────────────────┐
   │  M3 artifacts             │        │  M1 real farm + real APK     │  ← the gate for "no mocks"
   │  M4 viewer (code half)    │───────▶│  M2 public ingress           │
   │  M5 team/keys/lease/queue │        │  M4 coturn + verify          │
   └───────────────────────────┘        │  M1 real Appium suite        │
                                        └──────────────────────────────┘
```

Recommended order: **M1 → M2 first**, even though M3/M4 are free, because until real Android
(Cuttlefish, not the stub) is behind the console every subsequent verification is against a fake, and
M1 is the step most likely to surface something that changes the others. Build M3 and M4's code during the same window the box is
up, so one metered period covers both. Then M5, then M6.

The one ordering rule that is not negotiable: **no viewer work against the docker-bridge bind.**
ADR-0005 says it outright — every hour spent there is work done against a route no user has.

---

## 5. What I need from you

Everything else I can do. These I cannot.

| # | Decision or credential | Why it blocks | Default if you say nothing |
|---|---|---|---|
| 1 | **The host.** Restore the GCP snapshots (project + zone), rent an Indian dedicated EPYC (₹8–12k/mo), or buy an office mini PC (~₹50k once). | M1, and therefore everything real. | I restore `mfarm-farm-ready` on GCP hourly for a verification window and destroy it — proves it, commits to nothing. |
| 2 | **A hostname**, and whether the console should be public at all. | M2's shape: Caddy vs Cloudflare Tunnel vs `tailscale serve`. | Caddy + Let's Encrypt, if the box has a public IP. |
| 3 | **A real APK** of the app you want verified. | M1 step 4 is the first real `adb install`. | I use an AOSP sample, which proves the pipeline and not your app. |
| 4 | **Confirm no Google Play Services dependency** — no FCM, Google Sign-In, Maps SDK, Play Integrity. | Cuttlefish is pure AOSP. A GMS dependency kills the substrate and no platform work fixes it. | I assume it still holds, per the standing constraint. |
| 5 | **Alert destination** — Slack webhook URL, or SMTP details. | M5. 15 rules currently fire into a UI nobody watches. | Left unconfigured, and written down as unconfigured. |
| 6 | **Teammate emails** for accounts. | M1 step 3. | One account for you. |
| 7 | Whether **egress cost** for relayed video is acceptable. | M4. TURN bandwidth scales with viewers, not devices — the one part of this system whose marginal cost is not "a device for a while". | I deploy coturn and cap concurrent viewers. |

Secrets I generate on the box and never commit: `WORKER_REGISTRATION_TOKEN`, the session signing key,
the `mfarm_app` password, and coturn's static auth secret.

---

## 6. Cost, so the decision is on numbers

| Option | Money | Read |
|---|---|---|
| GCP hourly for verification windows | ~$30–60 total | What I would do first. Snapshots already exist, and nested-virt numbers are pessimistic vs bare metal — the safe direction for a go/no-go. |
| Indian dedicated EPYC, always on | ₹8–12k/mo | Cheapest per core for a real farm. Diligence IPMI, network, support. Confirm `/dev/kvm` **inside** the machine before paying — "KVM VPS" usually means the *host* uses KVM. |
| Office mini PC | ~₹50k once | Zero recurring, no nested-virt tax on the CPU-bound rendering path, India-local. You own the uptime. Pair with Cloudflare Tunnel for NAT. |
| GCP/AWS always-on 16 vCPU | ~$550–750/mo | Convenient, and the worst value at this duty cycle. |

Against one BrowserStack parallel at ~$150–200/mo — and you would want two — the farm pays back in
months, and the number does not grow with usage. That is the whole thesis.

---

## 7. Risks I am not hiding

1. **The first real APK will find bugs.** Migrations 014/015 and the job pipeline have only ever
   spoken to a fake whose `installApp` is a log line. This is M1's real content, not a formality.
2. **SwiftShader frame rate is the one place great UI meets physics.** Software rendering is forced by
   snapshot/restore. Triage-grade, not smooth. Flutter/RN worse than native. If it is unacceptable,
   the escape hatch is a consumer GPU with `gpu_mode=gfxstream`, giving up snapshot restore and
   resetting via `powerwash_cvd` at roughly cold-boot cost — affordable at two devices.
3. **Public ingress changes the threat model** from "everyone who can reach it is already trusted" to
   "anyone can reach the login page". The architecture is built for it — signed per-request grants,
   RLS, offline token verification — but M2 is the milestone where a mistake is most expensive.
4. **Two devices is the product's real constraint.** Contention is the dominant UX problem, which is
   why lease extend and queue position are in M5 rather than in "nice to have".
5. **Reset failure must never silently return a device to READY.** Enforced control-plane side today.
   Everything M3 and M4 add runs near that path; it must not regress.
