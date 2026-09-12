# ADR-0036 — a failure can be shown to somebody with no account here

**Status:** Accepted · 2026-09-12 · migration 051

## Context

Every way of looking at a failure in this product requires a session cookie for the org that owns
it. The console renders one, `/v1/sessions/:id/results` returns one, `/v1/artifacts/:id/blob` serves
its screenshot — and all three are behind `requireTenant`, which is correct and is also why the most
ordinary thing a QA engineer does was not possible.

**The thing they do thirty times a week is paste a failure into a channel and ask "is this you?"**
The developer who broke it, the contractor on the integration, the person in the incident channel:
each would need an account on the farm first. What happens instead is a screenshot of a screenshot,
with the stack retyped by hand and the step trace lost entirely — which is most of what the farm
knows about the failure, thrown away at the moment it was going to be useful.

LambdaTest calls this `public_url`. It is the smallest item on the competitive gap list and the one
a team reaches for daily, which is a better reason to build it than its size suggests.

## Decision

**A revocable, expiring link scoped to ONE test result**, at `/s/<token>`.

### Scoped to one result, not a session and not a run

Every widening is a disclosure nobody reviewed. A session share would carry every other test that
ran on that device; a run share would carry the entire suite. One result is the narrowest thing that
answers the question somebody is actually asking.

That scoping is not free, and the place it costs something is the **step trace**. `session_commands`
is the whole session's, so on a suite running eight scenarios per session a naive implementation
hands the link holder all eight. The share therefore carries only the commands **between the
previous result's `reported_at` and this one's** — a window derived from rows this API wrote, not
guessed. Its honest error is stated in `windowedSteps` and on the page: `reported_at` is when the
suite POSTED, which is after the assertion fired, so a command issued by the next test before this
one's `afterEach` finished reporting can land inside the window. That error is bounded by the
reporting gap and errs towards showing one step too many of the caller's own session rather than
towards hiding the step that explains the failure.

### It deliberately does not carry the logcat

A share is readable by anyone holding the link, and a device log is **the artifact most likely to
contain something the person sharing it has not read**: an app logs auth headers, deep links with
tokens in them, and whatever a third-party SDK feels like printing. Everything else on the page was
curated by somebody — the screenshot was framed by the app, the stack was written by the suite, and
the step trace is MFARM's own record of which commands it forwarded, which under ADR-0029 stores no
request bodies at all.

This is a default, not a law. Somebody who wants to hand over a log can still download it and send
it; the difference is that they will have looked at it first.

**The recording is excluded for a different reason**: a video covers the whole session, which is the
same widening the scoping rule exists to prevent. There is no per-test recording to offer instead,
so the honest answer is none.

### A table, not a signed token

A signed URL cannot be withdrawn. The realistic mistake with this feature is not that the crypto
fails — it is that somebody shares a failure and then notices the screenshot has a customer's name
in it, and `revoked_at` is what makes that recoverable. `views` and `last_viewed_at` are what make
revoking a decision rather than a guess, counted at most once every five minutes for the reason
`api_keys.last_used_at` is: a link pasted in a busy channel is fetched by every unfurler that sees
it, so a per-request count would report a number about Slack rather than about people.

The credential is shaped exactly like `api_keys` — `mfs_` plus 32 random bytes, a 12-character
prefix that is safe to log and render, and a sha256 of the whole token — so a database dump does not
hand somebody every live link.

**Unknown, malformed, revoked and expired are one answer.** A page that distinguished them would
confirm to the holder of a withdrawn link that they once held a real one, which is exactly the fact
revocation is trying to take back. `shares.test.ts` asserts the two responses are identical but for
the per-request id.

### Its own page, not the console

The console's shell boots a signed-in application: it fetches the fleet, opens a socket, and renders
a sign-in screen to anyone without a cookie. A person opening a share has no cookie and never will,
so sending them the console would show them a login form with the thing they came to read behind it.
`share.html` is 40 lines, `share.js` fetches exactly one endpoint, and both share `design-tokens.css`
and `/profiles.js` with the console — the second so a device is named here exactly as it is named
there, rather than the product growing a second opinion about what an X1 Pro is called.

The shell is **byte-identical for every token**, valid or not: it discovers whether the link is live
by asking, so the HTML a stranger receives discloses nothing.

## Consequences

`/s/` and `/v1/shares/` join `/dp/` as prefixes exempt from the authenticate-by-default rule, on the
same grounds: each carries its own credential, just not one the auth hook can read. The exemption is
`GET`-only, so `DELETE /v1/shares/:prefix` still needs a principal — a distinction with a test.

A link can outlive the evidence it points at, because artifacts are deleted on their org's retention
schedule (migration 046). The 30-day ceiling is set against the retention default rather than
against anything technical, and a share whose screenshot has expired renders without one rather than
with a broken image.

**Anything added to the public payload is a disclosure decision.** `publicPayload` is written as one
explicit object and never by spreading a row, so the next column added to `test_results` is not
published to the internet by whoever added it.

## What was found while building it

Four things, none caught by the test suite as it stood, and all four are the same shape this repo
keeps meeting — *a thing that looks right and does nothing*:

1. **The migration's RLS policy named a setting nothing sets.** `current_setting('mfarm.org_id')`
   where `withTenant` sets `app.org_id`, so every read and write on `result_shares` was refused and
   the feature was dead on arrival. Found by a six-line probe against the running schema before any
   route existed — architecture rule 8, look at what the database DOES.
2. **`shareJson` returned a link built from the PREFIX.** `/s/mfs_g4M9wlev` is a URL of exactly the
   right shape that resolves to nothing, because a prefix is 12 characters of a 47-character
   credential. The console would have put a copy button beside a dead link. Found by reading one
   real HTTP response; every test was green.
3. **`replaceChildren` stringified a `null` into the dialog.** Every render function in `console.js`
   is written `cond ? node : null` because `h()` drops those; the DOM does not. `confirmDialog` and
   `formDialog` had the same shape and were saved only by every caller happening to pass the
   optional argument. `fill()` now fixes all three.
4. **`min-width: 0` did not stop a row wrapping**, because flex decides wrapping BEFORE shrinking —
   the row has to be told `nowrap` first. The symptom was a list that looked broken because one
   person's email was longer than another's.

Three of the four were found by opening the page in a browser. That ratio is the argument
`docs/STATUS.md` §5 already makes, holding again.
