# ADR-0040 — a share can carry the device log and the recording

**Status:** Accepted · 2026-09-14 · migration 057 · **supersedes the logcat and recording sections of
[ADR-0036](0036-a-failure-can-be-shown-to-somebody-with-no-account.md)**

## Context

ADR-0036 made a failure shareable with somebody who has no account, and kept two things off every
link: **the logcat**, because it is the one artifact nobody curated, and **the recording**, because it
covers the whole session rather than the one result the link is scoped to.

Both exclusions were defaults argued from disclosure, and both cost the recipient the evidence that
most often explains a failure. A developer sent a stack and a screenshot asks for the log in the
next message; the person who shared it then downloads it, and pastes it into the same channel — in
full, without any of the expiry, revocation or view count the link has. The exclusion did not stop
the log travelling. It made it travel worse.

## Decision

**The product owner decided on 2026-09-14 that a share can carry both, and that the console's share
dialog offers them checked by default.**

### Two flags per link, defaulting to false everywhere but the dialog

`result_shares.include_logcat` and `include_recording`, both `NOT NULL DEFAULT false`, set at creation
by `POST /v1/results/:id/shares` (`includeLogcat`, `includeRecording`) and returned by the listing.

- **The API default stays false.** A CI job minting a link the moment a test goes red sees no
  checkbox, so it gets the disclosure it got before. The console sends `true` explicitly.
- **Existing links are unchanged.** A link pasted last week does not start serving a device log
  because a migration ran.
- **Chosen once, at creation.** There is no endpoint that widens a live link. Somebody who wants the
  log on a link that lacks it makes a new link — which is the same rule as a lost token.

### What the flags open, and nothing else

The public payload gains two keys, each `null` unless the link includes it **and** the evidence
exists with its bytes on disk:

```
log:       { sizeBytes }                                   | null
recording: { sizeBytes, startedAt, failureAtSeconds, partial } | null
```

and two routes, each reached through the token exactly as the screenshot is:

- `GET /v1/shares/:token/logcat` — the session's log, as a download. The capture bound to this result
  (`context.testResultId`) when there is one, otherwise the session's release-time log.
- `GET /v1/shares/:token/recording` — the session's recording, with range support, because a
  `<video>` that cannot seek cannot jump to the failure.

**A link without the flag answers those routes exactly as it answers a missing artifact** — a 404,
checked in the route and not only in the payload, so a holder who guesses the URL gets nothing.
Unknown, malformed, revoked and expired tokens stay one answer, as ADR-0036 requires.

**`failureAtSeconds` is the console's arithmetic** (`failureOffsetSeconds` in `console.js`):
`reportedAt − context.startedAt`, pulled back by the same five-second lead-in, floored at zero, and
`null` when the recording carries no start time. It is computed by the API rather than in `share.js`
because the share page cannot import the console, and a second copy of the subtraction in a second
file is how the two would come to disagree about when a test failed. Its honest error is ADR-0036's
and `VIDEO_EVIDENCE.md`'s: both ends are approximate, in the same direction.

### What the owner's default-on accepts

Said plainly, because a checked box is a decision most people will not revisit:

- **An unreviewed device log can carry credentials.** Apps log auth headers, deep links with tokens
  in them, and whatever a third-party SDK prints. With the box checked by default, most links will
  carry a log nobody read, readable by anyone the link reaches — every unfurler in the channel, and
  anyone it is forwarded to — until it expires or is revoked.
- **A recording shows the whole session.** On a suite running several tests per session, the link
  shows every other test on that device, which is exactly the widening ADR-0036's scoping rule
  existed to prevent. The steps stay windowed to this result; the video cannot be.

What limits the damage is what ADR-0036 built: links expire (≤ 30 days, 7 by default), can be
revoked, count their views, and are served `no-store`. The dialog says what the checkboxes disclose.

## Consequences

- The share page's CSP gains `media-src 'self'`, and nothing wider.
- `share.js` renders a download for the log and a player with **Watch from the failure** for the
  recording, and says in its footer which of the two the link does and does not carry.
- ADR-0036 is marked partially superseded; its scoping, credential and one-answer rules stand.
- A link can outlive a recording sooner than a screenshot, because video retention is shorter than
  artifact retention (`VIDEO_RETENTION_HOURS`). The payload reports what is on disk now, so a link
  whose recording has expired renders without one.

## Alternatives considered

**Keep both excluded.** The status quo, and what pushed the log into chat as a paste with no expiry.

**Default-on in the API as well.** One default everywhere is simpler, and it would silently widen what
every existing API caller discloses.

**Redact the log server-side.** A redactor that catches bearer tokens and misses a custom header is a
promise of safety the product cannot keep. Not built, and not claimed.
