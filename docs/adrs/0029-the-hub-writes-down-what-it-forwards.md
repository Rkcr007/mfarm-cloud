---
id: ADR-0029
title: The hub writes down what it forwards, and still does not model it
status: Accepted
date: 2026-09-07
authors:
  - Claude Code
tags: [webdriver, hub, observability, privacy, tenancy, execution]
extends: [ADR-0011, ADR-0018]
---

## Context

A failed run on MFARM can show four things: the test's name, the message the suite reported, the
failure taxonomy of migration 024, and — since migration 040 — a screenshot and a logcat captured
when the failure was reported.

It cannot show the thing every commercial farm puts at the centre of that screen: **the list of
steps, with the failing one in red.** Not for want of a screen. There is no source. `test_results`
has no notion of a step, and the hub records nothing about what it forwards.

That last part is deliberate, and the comment saying so is right:

> The hub does not model WebDriver commands and must not start: the automation server is the
> authority on what exists, and a hub that enumerates commands is a hub that breaks every time
> Appium adds one.

Any step list has to come from somewhere. The alternatives to the proxy are worse:

- **Ask the suite to report steps.** Every customer instruments their own tests, forever, in every
  framework. This is the thing the product exists to avoid — the whole pitch is one URL and two
  capabilities.
- **Parse the Appium log.** A format nobody promises, that changes between versions, and which is
  currently a ring buffer in worker memory that is never uploaded.

## Decision

**The proxy records the SHAPE of every command it forwards, and nothing about its meaning.**

Migration 041 stores, per command: method, path, HTTP status, duration, start time, and the W3C
error code. That is not a model of WebDriver. It is a record of what the hub had in its hands one
line earlier, because it had just forwarded it. When Appium adds a command tomorrow, this logs it
correctly **without knowing what it is** — which is precisely the property the comment above is
protecting, so the rule survives intact.

Three constraints make this shippable rather than merely possible.

**No bodies, no headers.** A WebDriver body carries the customer's selectors, their test data, and
on `POST /element/:id/value` their passwords; headers carry the automation grant. The shape of a
session is worth keeping and the contents are not ours to hold. A farm that quietly retains its
tenants' credentials for days is not a debugging feature, it is an incident with a date on it. The
stored `error` is the W3C code only — `no such element`, a fixed vocabulary from the specification —
because the message beside it routinely quotes the selector that failed.

**A command is never slower or less reliable because it was recorded.** `record()` is synchronous,
does no I/O, and appends to a bounded in-process buffer; writes are batched into one statement per
session on a 250 ms timer, off the request path entirely; every database error is swallowed and
counted, so a control plane whose command log is broken still runs suites. The only place the flush
is awaited is `driver.quit()`, because a CI job reads its own trace the instant the suite finishes.

**Retention is not optional.** This is the highest-write table in the schema — one row per command
rather than one per session — and it defaults to three days against artifacts' fourteen. The trace
answers "why did this run fail", which is a question asked within hours.

## Consequences

**A step list becomes possible, and so does a navigable video.** `GET /v1/sessions/:id/commands`
returns numbered steps with a derived `failed` flag; the red step is the one to render red. Each row
carries `started_at`, which is the seek offset a recording needs — so S5 of
`docs/EXECUTION_ROADMAP.md` gets "click the failing step, jump to that second" for free rather than
as a second timestamping scheme.

**The trace is not the whole session.** Only proxied commands and the quit are recorded. Session
creation is not a row here — it is an `execution_events` entry, where it belongs — and a suite on
the bound `mfarm run` path that talks to a device outside WebDriver leaves no trace of it. The step
list is honest about being a list of WebDriver commands.

**A definer function that takes a tenant's id must name the tenant.** `record_session_commands` was
first written to derive the org by selecting the session, on the reasoning that `sessions` is FORCE
ROW LEVEL SECURITY. That reasoning is wrong in its last step: `mfarm_definer` has **BYPASSRLS**,
given to it deliberately by migration 012 so that `promote_queued` can read every org's queue. RLS
is therefore *not present* inside any `SECURITY DEFINER` function, and a "derived" org is whatever
org owns whatever id the caller passed. A test written to confirm the reasoning instead found org B
writing a forged step into org A's session, filed under A. The function now takes `p_org` and puts
it in the `WHERE` clause, which is the shape `request_capture` already had.

This is the general rule and it is the most reusable thing in this decision: **RLS will not scope a
definer function. The function must scope itself.**

**Numbering is assigned in SQL, not in the process.** An in-process counter would restart at 1 when
the API restarts and collide with rows already stored, and the `UNIQUE (session_id, seq)` would then
reject the whole batch — losing a suite's trace at exactly the moment something interesting was
happening. The batch is serialised per session with a transaction-scoped advisory lock; `SELECT …
FOR UPDATE` cannot be used because Postgres refuses it beside an aggregate, and because the first
batch of a session has no row to lock.
