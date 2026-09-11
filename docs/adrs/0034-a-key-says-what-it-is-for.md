# ADR-0034 — an API key says what it is for, and stops working on its own

**Status:** Accepted · 2026-09-11 · migration 049

## Context

`api_keys` was `(prefix, key_hash, created_at, revoked_at)` and nothing else, and the console's
**New API key** button POSTed an empty body. One click produced a live, org-wide credential with no
name that never expired. The 2026-09-09 review found it the way anybody would — by pressing the
button during an audit — and filed it as *"a harmless exploratory click created a live org-wide
credential"*.

**The instinct is to read this as a blast-radius problem. It is not, and getting that wrong would
have produced the wrong feature.** A key already cannot escalate: `requireOrgAdmin` calls
`requireUser`, so changing the team, changing retention, enrolling an agent, and minting or revoking
keys all require a signed-in person. **An API key cannot mint another API key.** That boundary
predates this decision and is untouched by it.

The real defect is that **rotation is impossible**. To rotate a credential you must know which
system holds it. With four unlabelled prefixes and no record of use, revoking one is a coin flip on
whether CI stops — so nobody rotates, and a key that leaked a year ago is still valid. The org
cannot reduce its own exposure. That is worse than any single key being over-powered.

## Decision

Five columns, one required argument, and one new guard.

### A label is required, and required where a person sees the error

`POST /v1/account/api-keys` refuses a request without one, `createApiKey()` takes it as a positional
argument, and the console asks in a dialog instead of minting on click. The compiler found all 19
places that minted an anonymous key the moment the signature changed, which is the argument for
putting it in the signature rather than validating a field.

### Scope names a boundary that already exists

Exactly three tenant-guarded routes destroy data — `DELETE /v1/artifacts/:id`,
`DELETE /v1/sessions/:id/artifacts`, `DELETE /v1/sessions/:id/record`. So:

| scope | may | default for |
|---|---|---|
| `automation` | run tests: allocate, drive, install, read runs, artifacts, usage | **new keys** |
| `full` | all of that, plus delete evidence | keys minted before 049 |

**A capability list was the alternative and is refused.** It would have been eleven capability
strings of which the code checks one — aspiration in a column, and the kind of thing that reads as a
security feature while enforcing nothing. When a second real boundary appears this becomes a third
scope, with something to put in it.

`requireTenantDestructive()` is a named function rather than a flag on `requireTenant`, so *"which
endpoints can a CI key not reach?"* is answered by finding its callers rather than by grepping for
`true`.

**A signed-in person always passes it.** Scope is a property of a key, not of a human: this is about
what a credential left in a CI runner can do unattended, and restricting the person too would mean
the console could not offer a button the product already has.

### Expiry is enforced in `authenticate`, and an expired key authenticates as *nothing*

Not as a refused principal. The presenter gets exactly the answer a presenter of nonsense gets,
because a 403 reading *"that key expired on the 3rd"* confirms the key was real — which is worth
having if you found it in a log and are deciding whether to try it elsewhere.

The row is still read before the comparison rather than filtered out in the `WHERE` clause, so a
future audit trail can report that an expired key was **presented**.

### `last_used_at` is deliberately approximate

It is what makes revocation safe — *"nothing has used this in 90 days"* is the sentence that lets
somebody delete a key without holding their breath. Writing it on every request would put an UPDATE
on every authenticated call, **including every WebDriver command the hub proxies**, which on a busy
run is hundreds per minute per session. It is written only when the stored value is older than five
minutes, and the column therefore means *"used at or after this"*.

Null means *"not since this column existed"*, **not** *"never used"*, and the console says so —
rendering "never used" over a live CI credential would be an invitation to revoke it.

## Consequences

**Existing keys keep the authority they have.** They are backfilled to `full`, not to the new
narrower default. A migration that silently narrowed a live CI credential would break somebody's
pipeline at 3am to enforce a policy they were never told about, and they would read it as the farm
being broken. Their label says `unnamed — created before keys had labels`, because nobody knows what
they were for and an invented "CI key" would be a fact the table cannot support.

**Rollback stays a command rather than a gamble — and only because `rollback.test.ts` insisted.**
The first version of this migration made `label` NOT NULL with no default. Rolling the API image
back to a release whose `createApiKey` inserts `(org_id, prefix, key_hash)` would then have failed
outright, taking key minting down completely. The guard caught it; the column now carries a DEFAULT
whose only purpose is that rollback, and nothing in the new code relies on it. Both new CHECKs are
recorded in that test's allowlist with the reasoning.

**The narrow scope is untested against a real CI suite.** `examples/python-pytest` and
`examples/medishop-suite` were run with `full` keys before this existed. The scope check refuses only
evidence deletion, which neither does, so they should be unaffected — but "should be" is the phrase
this repo's defect register exists to catch, and the next suite run on the farm should use an
`automation` key.

## Alternatives considered

**Per-key rate limits.** Attractive, and rejected for now: the limiter is in-memory and per-org, so a
per-key limit would be a second in-memory structure with the same multi-instance problem
`EXECUTION_ROADMAP.md` S7.3 already describes. It belongs with that work, not this.

**Scoping keys to a project or an app.** There is no project concept in MFARM, and inventing one to
hang a scope on would be the tail wagging the dog.

**Leaving creation as one click and only adding the columns.** This was tempting because the dialog
is the fiddliest part. It fails the actual test: an unlabelled key is exactly the thing that makes
rotation impossible, so a schema that permits one has not fixed the defect.
