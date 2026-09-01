---
id: ADR-0007
title: WebRTC signaling is relayed through the data plane; media still is not
status: Accepted
date: 2026-08-19
authors:
  - Claude Code
tags: [media, webrtc, signaling, console, live-view]
supersedes: []
extends: [ADR-0004, ADR-0005]
---

## Context

ADR-0005 decided that **media** reaches the browser over a TURN relay and is never proxied by the
worker. It did not say how the browser and the device agree on that connection in the first place.
That gap is the whole of the live view, because Cuttlefish's WebRTC stack does not accept an
unsolicited offer — it is driven by a small signaling conversation with the **operator**, a local
HTTP/WebSocket server that `cvd` runs beside the devices.

The signaling contract is stable and public. `server_connector.js` in `android-cuttlefish` carries an
explicit compatibility promise ("No changes that break backward compatibility are allowed here"), and
it is short:

| Step | Wire |
|---|---|
| Infrastructure config | `GET /infra_config` → `{ "ice_servers": [...] }` |
| Open the channel | `WS /devices/{deviceId}/connect` |
| First server frame | `{ "device_info": {...} }` |
| Device → client | `{ "payload": {...} }`, or `{ "error": "..." }` |
| Client → device | the payload object itself, sent raw |

The payloads are ordinary WebRTC: `{type:'request-offer', ice_servers}`, `{type:'offer', sdp}`,
`{type:'answer', sdp}`, `{type:'ice-candidate', candidate}` outbound; `offer`, `answer`,
`ice-candidate` (`{mid, mLineIndex, candidate}`) and `error` inbound.

Three routes to that operator were possible, and the choice is not obvious.

## Decision

**The browser's signaling travels over the existing data-plane WebSocket, which the worker already
authenticates. The worker opens the operator connection on loopback and forwards payloads verbatim.
Media continues to bypass the worker entirely, exactly as ADR-0005 requires.**

Concretely:

1. `dataplane.ts` gains four client message types — `signal-open`, `signal`, `logcat`, `screenshot` —
   and the matching server frames. `signal-open` is only accepted after `hello`, so a viewer inherits
   the Ed25519 grant check, the fence check and the audience check unchanged. Nothing new
   authenticates anything.
2. The worker dials `http://127.0.0.1:1080` (the operator, configurable via `CF_OPERATOR_URL`) and
   holds one operator socket per viewer connection. Payloads pass through **opaque** — the relay
   parses nothing but the envelope, so a Cuttlefish upgrade that adds a payload field needs no worker
   change.
3. The **operator's device id is discovered, never assumed.** `--webrtc_device_id=cf-1` is set at
   create time and is *lost across a snapshot restore* — the same defect `findFleetInstance` already
   works around for `cvd fleet`. The relay lists `GET /devices`, prefers an exact `localId` match,
   accepts the sole device on a single-device host, and otherwise refuses by name rather than
   guessing at another tenant's device.
4. **ICE servers come from the control plane**, minted per session (`GET /v1/sessions/:id` → `ice`),
   and are what the browser puts in `request-offer` — so the device relays through the operator's
   coturn under a credential that expires with the session. The operator's own `infra_config` is
   forwarded as a fallback and used only when the control plane has no TURN configured.
5. **The data plane becomes browser-reachable through the same TLS ingress as the console**:
   Caddy proxies `wss://<console-host>/dp/<hostId>` to the worker. The worker keeps no public bind,
   and the automation gateway keeps its host-local one — the split ADR-0005 asked for, now
   `AUTOMATION_BIND_HOST` and `DATA_PLANE_BIND_HOST` rather than one shared `BIND_HOST`.
6. **`session_attach` (migration 017).** The worker reports, on its existing events channel, that a
   client attached — which is what finally moves a browser-started session from `ALLOCATING` to
   `ACTIVE`. See the consequence below; this was not planned and was found by building.

## Consequences

**The strict CSP survives — conditionally, and the condition is the deployment.** When the ingress
proxies `/dp`, the socket is same-origin and `connect-src 'self'` covers it with nothing added. When
it does not — a worker reached directly on its own host and port, which is what a developer running
the API and a fake farm on one laptop has — `connect-src` names **exactly one** extra origin,
computed from `DATA_PLANE_PUBLIC_BASE` rather than from a request. That is the concession ADR-0005
predicted ("exact origins, never to `*`"), and it turns out to be the fallback rather than the norm.

This was found by running it, not by review: a blocked WebSocket surfaces in the browser as a bare
`error` event with no reason attached, so the console could only report "the connection closed" for
what was actually a response header. `webrtc 'allow'` is also now stated explicitly — it changes
nothing (CSP3's webrtc directive is opt-in, so peer connections were never governed by
`default-src 'none'`) but it means the next reader does not have to derive that.

**A browser-opened session can now say it is ACTIVE.** `session_activate` had exactly one caller, the
WebDriver hub, so a session started from the console stayed `ALLOCATING` for its whole life:
`started_at` was never set, every duration and lease bar was measured from the allocation instead of
the attach, and the device never showed as in use. Migration 017 adds a host-scoped `session_attach`
that the worker reports on the beat. It is deliberately not a console-side endpoint — the fact being
recorded is "a client attached to the data plane", which only the data plane observes, and a
console-side route would leave the CLI and every other data-plane client still unable to express it.

**One certificate, one hostname, one thing to explain.** The operator's self-signed cert on 1443 is
never presented to a browser, and its ports stay closed — which matters, because the operator is
unauthenticated device control and the cloud firewall was the only thing hiding it (HANDOFF).

**A proxy hop for signaling, not for frames.** Signaling is a handful of small JSON frames at
connection setup and on renegotiation. It is not the hot path — input goes over the WebRTC
`input-channel` data channel straight to the device, and video never touches the worker or the
control plane. The invariant ADR-0005 protects is intact: no frame transits an MFARM process.

**The control plane still never dials a worker.** Caddy is a route, not the API. The API process
holds no socket to the farm and gains none here.

**Input has two paths now, deliberately.** The data channel is the live one and is what a human's
taps use. `dataplane.ts`'s `tap`/`swipe`/`key`/`text` remain for programmatic and control-plane use
and keep their coalescing rules; they shell out per event and are documented as slow. Where the data
channel is open, the viewer prefers it.

**A SNAPSHOT-RESTORED DEVICE HAS NO SCREEN, and that decides how this farm recycles.** Measured on
the lab box 2026-08-19, and it is the single most important thing this work found:

| Device brought up by | Result |
|---|---|
| cold boot (~78s) | streams at **~49 fps**, direct path, 2.5 Mbit/s |
| snapshot restore (~10s) | negotiation completes, an **audio** track arrives, **no display is ever published**, no video |

Re-taking the snapshot from a device whose display was working at the time did not help; the restore
itself loses it. `cvd display add` on a restored device fails. So the two headline properties of this
tier — a 10-second recycle and a live screen — **cannot both be had from a restore** on cvd 1.55.1.

`CF_RESET_MODE=powerwash` is the answer, and the E2E plan had already guessed at its shape ("giving
up snapshot restore and resetting via `powerwash_cvd` at roughly cold-boot cost — affordable at two
devices"). It resets to first-boot state, keeps the group intact, and still satisfies what
`REQUIRED_FOR_TENANT_USE` actually means. An automation-only farm keeps `snapshot` and its 10s
recycle; an interactive one pays ~80s per reset to have a screen.

**And the mode has to govern the BOOT path, not only the reset path** — a distinction that cost a
second debugging session. The first implementation changed `resetToSnapshot()` and left
`restartExisting()` free to consult `snapshotOnDisk()`, so a snapshot left over from before the mode
was set was still restored on startup: the farm came up restored, published no display, and lost the
live view for exactly the reason the mode exists. `snapshotOnDisk()` now returns nothing in powerwash
mode, which is what makes "this mode ignores snapshots entirely" true rather than aspirational.

The console does not paper over the other case. A device that connects and publishes no display is
its own state — `nodisplay` — which says exactly that and offers a screenshot, because `adb
exec-out screencap` returns a real 720×1280 frame on precisely the device whose video is missing.

**One thing here is unverified, and it is the WebRTC half.** Everything on the worker's side of the
socket has been exercised end to end against `fake-farm.ts`, which now runs the real `DataPlane`:
grant verification, fence check, `signal-open`, batched logcat, screenshots, and the honest refusal a
tier without a media source produces. What has NOT run is a negotiation against a real cvd operator,
because that needs the device host. Two specifics to check first when it does:

~~unverified~~ **VERIFIED 2026-08-19 on the lab box**, end to end from a browser: signalling relay,
offer/answer, ICE, a connected peer connection, live video at 49 fps, and a real APK
(`io.appium.android.apis`) installed and launched on real Android 17 from the console.

Both of the things flagged as guesses turned out right, and both are worth keeping written down:

- **The operator is on 1080**, not the 8443 `CuttlefishMedia` had hard-coded from the `launch_cvd`
  era. `CF_OPERATOR_URL` made that a config value rather than a release.
- **`GET /devices` answers `[{"device_id":"cf-1",…},{"device_id":"cf-2",…}]`** — the exact shape
  `extractDeviceIds` handles, with ids matching `localId`, so resolution takes the exact-match path
  and never the fallbacks.

Two things the deployment found that no amount of local testing would have:

- **coturn with `relay-ip=0.0.0.0` refuses every allocation with 486 "Allocation Quota Reached"** —
  a code that reads like a limit and is nothing of the kind. STUN still works, so the browser
  gathers `host` and `srflx` candidates and looks healthy; only `relay` is missing. A NAT'd cloud VM
  needs `external-ip=PUBLIC/PRIVATE` and a real `relay-ip`.
- **`GET /v1/sessions/:id` returns `ice` beside `session`, not inside it**, and the console spread
  only `out.session` — so the viewer silently had no TURN. On the farm's own network that is
  invisible, because a direct candidate works. From anywhere else it is a connection that never
  completes, with an empty relay log that reads as "the relay is broken" when it means "nobody ever
  called".

**A latent bug fell out of this.** `index.ts` declared a uuid -> backend map for the data plane and
never populated it, with a comment describing a mapping "taught on first use" that nothing taught. At
one device the single-device fallback hid it completely; at two, every data-plane connection would
have been refused as `unknown_device`. Nothing caught it because the data plane had never had a
browser client to fail against.

## Alternatives

**Embed the operator's own UI in an iframe, proxied.** By far the least code — Cuttlefish's client
does all of this already. Rejected twice over: the console would inherit a foreign UI in place of the
designed cockpit, and proxying the operator publicly means proxying an unauthenticated device-control
surface, which no path-based rule in Caddy can make safe.

**Expose the operator directly and let the browser reach it.** Rejected for the same authentication
reason, plus a second certificate and a second public port for every device host.

**A screenshot loop over the data plane.** Rejected before this ADR existed and still rejected: it
sets a false performance baseline, burns the CPU that device density depends on, and `dataplane.ts`
already says so where it reports `media: null`.

---

## Amendment, 2026-09-02 (ADR-0019/0020 batch): same origin is the DEFAULT

`browserEndpoint()` returned null unless `DATA_PLANE_PUBLIC_BASE` named an absolute `wss://` origin,
which made the live view off-by-default in exactly the deployment this ADR recommends:
`setup-ingress.sh` proxies `/dp/*` on the console's own TLS name, while `docker-compose.prod.yml`
leaves the variable empty. The ingress routed the socket and the API told the browser there was no
route. On a tunnelled host (ADR-0011) it refused the session outright and released the device.

The API now composes the **same-origin relative path** `/dp/<hostId>` when nothing is configured.
`new WebSocket('/dp/<id>')` on an HTTPS page resolves against the document base and upgrades the
scheme, so the browser opens `wss://<this console>/dp/<id>` — the url the ingress already listens
for. `connect-src` stays `'self'`, because the socket is genuinely same-origin, and no second
external port exists to be forgotten in a firewall rule.

`DATA_PLANE_PUBLIC_BASE` still wins where set, and keeps the one use this ADR gave it: a worker
reached **directly** on its own host and port, which is what a developer running the API and a fake
farm on one laptop has. That case genuinely needs a second origin named and the CSP widened by
exactly it — and naming one is now an explicit act rather than the only way to make the feature work.

Pinned by `apps/api/test/single-origin.test.ts`.
