---
id: ADR-0022
title: The React console shares live.js rather than reimplementing it
status: Accepted
date: 2026-09-02
authors:
  - Claude Code
tags: [console, live-view, webrtc, react, duplication]
extends: [ADR-0007]
---

## Context

`HANDOFF.md` has carried "port the live view into the new console" as the top item since the React
console appeared at `/app`. The old console at `/` holds a working implementation —
`apps/api/public/live.js`, 779 lines — that negotiates WebRTC against Cuttlefish, pushes multi-touch
and keyboard input, streams logcat, and has been verified on hardware at 50 fps with accurate taps.

"Port" reads as "rewrite it in TypeScript inside `apps/console/src`". That is the obvious move and
it is the wrong one, for a reason the file states about itself:

> The message vocabulary on the WebSocket is the worker's (`t: 'hello' | 'signal' | 'logcat' | …`).
> The vocabulary INSIDE `signal` payloads is Cuttlefish's, and **this file is the only place in the
> repo that knows it.**

A second implementation of that vocabulary is a second thing to keep correct against a device
platform nobody here controls, for as long as both consoles exist — and the cutover plan
(`ui.ts`: "a cutover is repointing `/` at `app/index.html`") makes that overlap open-ended.

The two consoles are also built differently, which is what makes this look impossible at first
glance. The old console has **no build step, deliberately** — the API serves those files exactly as
they are on disk, which is why "is my fix live?" is a browser refresh. The React console is bundled
by Vite. `live.d.ts` says the same thing about itself: it "declares types and generates nothing".

## Decision

**`live.js` stays the single implementation, and the React console imports it.**

`apps/console/src/app/session/liveController.ts` imports `../../../../api/public/live.js` across the
package boundary. Vite bundles it; the old console keeps loading the same source unbuilt. One
implementation, two delivery mechanisms.

Three things follow.

**1. `live.d.ts` had to become a real declaration.** It described the class as
`{ constructor(o: Record<string, unknown>); [key: string]: unknown }`, which types every method as
`unknown` and therefore as not callable. That was survivable while its only TypeScript readers were
tests that cast to `any`. It now declares the surface used outside the file — and the private fields
stay undeclared on purpose, so a test reaching for `live.ws` still has to cast to say it is
injecting a fake.

**2. React does not get to own the connection.** `LiveSession` knows how to negotiate; it does not
know when it should exist, and in the old console that was answered by a module variable and a
`closeLive()` call from a router. Effects are a worse answer to the same question: they run twice in
development, re-run on any dependency change, and do not run at all when a tab is closed. So
`LiveController` — a plain class with no React in it — owns the lifecycle, and `useLiveSession` is a
thin binding. That split is what makes the leak rules testable without a renderer.

**3. The stage draws the panel the WORKER reports, never the registered one.** This is a tap-accuracy
rule wearing a layout costume. `live.js` scales a touch by `videoWidth / offsetWidth` and never
consults the height, which is correct only while the element is not letterboxing. Hand the stage the
registered panel while the device encodes a different one and `object-fit: contain` letterboxes the
video inside its own box — `offsetWidth` then measures the box rather than the picture, and every
coordinate is wrong by the crop, silently, on a screen that still looks fine. The old console makes
the same call in `paintFrame` for the same stated reason.

## Alternatives rejected

**Rewrite it in TypeScript under `apps/console`.** The honest cost is not the 779 lines, it is that
every future fix to Cuttlefish's signalling has to be made twice and verified twice, on a device
platform that changes underneath us. This repo already has the evidence for what that costs:
`mfarm-comments-as-rumour` records three shipped defects that came from a claim about another
component that was true when written. A duplicated protocol is that failure mode with a longer fuse.

**Move `live.js` into a shared `packages/` workspace.** Correct in the abstract and rejected as
premature. It would move a file the old console loads by URL at `/live.js`, so the API's static
allowlist, the old console's imports and the deploy artifact all change together to buy tidiness for
exactly two consumers, one of which is being retired. Revisit at the cutover, when the old console
stops being a consumer at all — that is the moment the move is nearly free.

**Copy it now and "reconcile later".** Reconciling never happens, and there would be no test that
notices the drift.

## Consequences

**Positive.** There is exactly one implementation of Cuttlefish's signalling vocabulary, so the two
consoles cannot disagree about the protocol. The React console inherited every hardware-verified
behaviour at once — 50 fps, `nostream` and `nodisplay` as distinct non-failures, the local tap echo,
modifier-key release on blur — rather than reacquiring them one defect at a time.

**Negative.** A cross-package relative import (`../../../../api/public/live.js`) is ugly and would
break if either directory moved. Accepted, and it is the thing the `packages/` move would fix.

**Negative.** The two consoles now update on different clocks. Editing `live.js` reaches `/` on a
browser refresh and `/app` only after a Vite build. That difference already existed for everything
else in the React console; it is new only for this file.

**Neutral.** The root `tsconfig.json` now excludes `apps/console`. It always meant to — the console
is the only browser target and needs `lib: ["DOM"]`, and CI's build step comment already said it is
the only thing that typechecks the console. Until this change the console was `.tsx` plus a
`vite.config.ts` that happens to touch no DOM API, so the root glob matched nothing that could fail.

## Verification

- `apps/console/test/dataplane-lifecycle.test.ts` runs the real `live.js` against a real `ws`
  server, and every assertion is made by the SERVER about what it observed — because "we called
  close" and "the worker's channel went away" are the same sentence right up until a socket is
  half-open. This found a real defect: `#scheduleRetry` closed the dying session while its
  generation was still current, and `live.js`'s synchronous `close()` fired `onState('closed')`
  straight back, overwriting the `failed` state — so a refused grant showed "Disconnected." instead
  of "the account is not authorised for this device". Mutation-checked: reverting the fix fails that
  test by name in 4s.
- `apps/console/test/tap-mapping.test.ts` drives the real `attachInput` with a fake element whose
  geometry the test controls, closing the "touch accuracy has no test coverage" item HANDOFF has
  carried since the old console shipped. Mutation-checked: making `scale()` consult `offsetHeight`
  — the plausible wrong implementation `live.js` warns against — fails 8 of them.
- `apps/console/test/liveController.test.ts` covers the leak rules: one socket per controller,
  superseded sessions cannot speak, stopping is final, bounded reconnect.
- `apps/console/test/geometry.test.ts` pins the panel-priority rule above, including that its two
  fixtures genuinely differ in aspect ratio — otherwise the test proves nothing.

### What the hardware pass found that none of those could

Verified 2026-09-02 on the real farm at `farm.mfarm.dev/app`: **49–50 fps, 2520 kbit/s, 35 ms round
trip, direct `host` path, zero console messages** across load, negotiation, streaming, taps and
release. A tap on the Gallery icon opened Gallery; a tap on the navigation bar went back. The stage
switched from the registered 1080×2340 to the worker's 720×1280 and the detail pane read
`Panel from: live session`, which is the rule in decision 3 working where it matters.

**And it found a real distortion that every test above passed straight through.** Measured in the
browser: a 720×1280 stream (ratio 0.5625) rendered into a 340×620 box (ratio 0.5484). The video was
letterboxing inside its own element, so `offsetWidth` was the box rather than the picture.

The cause was in `stage.css`, and it had a comment asserting the opposite:

> The bezel is a padding so the screen box inside it stays exactly the panel's aspect ratio — a
> border would eat into it and quietly distort every coordinate we map.

Padding does exactly what that sentence says a border would. The ratio was on the device BODY, and
a uniform inset changes the ratio of what is inside it: 360×640 minus a 10px bezel is 340×620. The
fix moves the ratio onto the SCREEN (`box-sizing: content-box` + `aspect-ratio` on `.dev-body`, so
the ratio applies to the content box) and grows the body outward. Re-measured on the same live
stream: **349×620, ratio 0.562903 against 0.5625 — sub-pixel, `letterboxing: false`.**

Three things worth keeping from this:

* **A comment is not evidence.** This is the third defect in this repo traced to a persuasive comment
  that was simply wrong, and the only reason it was caught is that a number was measured rather than
  a sentence read.
* **The unit tests were not wrong, they were aimed elsewhere.** `aspectRatio()` was correct and is
  still correct; the distortion happened in the CSS box model between that number and the pixels.
  Nothing in a Node test runner can see it.
* **So this check belongs in the hardware pass, not in CI.** Compare `videoWidth/videoHeight` against
  `offsetWidth/offsetHeight` on a live stream; a delta above ~0.001 means taps are off by the crop.

## Related

- `ADR-0007` — the live-view signalling relay, and its 2026-09-02 amendment putting `/dp` on the
  console's own origin, which is what lets the React console use a relative WebSocket url
- `ADR-0021` — the tunnel pings; it deliberately left BROWSER channels unpinged, which is why
  `armUnloadGuard` closes on `pagehide` rather than trusting TCP
- `ADR-0016` — devices present as named handsets; the chassis is ours, the screen is the device
