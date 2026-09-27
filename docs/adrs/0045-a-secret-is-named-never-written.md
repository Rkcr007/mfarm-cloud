# ADR-0045 — a secret is named in a task, never written into it

**Status:** Accepted · 2026-09-27 · migration 064 · amends ADR-0043 (AI runs)

## Context

An AI run is described in English, so people write what the app needs into the task: "log in with
pin : 4812 and passcode 539176". On 2026-09-26 a real task carried its account's e-mail, PIN and
passcode, and the public share page printed them (D52). #221 masked them — the task, the reasoning,
the typed step, the summary and every name show `••••` — and #224 refused a task sent back still
holding the mask. Both treat the symptom where it is shown. The value itself is still:

- **stored** in `ai_runs.prompt` and `ai_tests.prompt`, in every backup, in the clear;
- **sent to the model provider** on every step, because the task is the model's instructions — and
  from there into whatever the provider logs;
- **found by pattern**: masking recognises a value by the label before it ("pin :", "password"). A
  secret written without one — "the code is 4812" — is shown in full.

The owner's review of the AI screens (2026-09-27, proposal 17) asked for the fix at the source: a
secret the task NAMES, kept out of the task and never shown to the model.

## Decision

**1. A secret has a name and lives in the organisation's store.** `ai_secrets` (migration 064) holds
one row per org and name: `PIN`, `LOGIN_EMAIL` — capitals, digits and `_`, starting with a letter, at
most 40. A task refers to it as `{{PIN}}`. Any saved test and any run of the org can use any of its
secrets, the way CI secrets work; one PIN is written once, not into each test.

**2. Values go in and never come out.** `PUT /v1/ai/secrets/:name` sets one, `DELETE` removes it,
`GET /v1/ai/secrets` lists NAMES with when and by whom they were last set. No endpoint returns a
value, to anyone, including the org that owns it: to change one, set it again. Setting and removing
needs a person or a full key (`requireSpender`); an automation key — what a run drives the hub
with — cannot. The table is under the same row-level security as every tenant table.

**3. Sealed at rest with a derived key.** AES-256-GCM, a fresh IV per value, and the org id and name
as additional data so a row copied to another org or renamed does not open (`ai/vault.ts`). The key is
HKDF-SHA256 over the farm's session signing key. Rejected: a new docker secret of its own — compose
refuses to start when a declared secret has no file, so it would have broken the next auto-deploy of
every farm that lacked one; and `pgcrypto` with the key in SQL, which puts the key in query text and
logs. **The cost:** rotating the signing key makes every sealed value unreadable. That is said, not
hidden: the runner stops a run whose secret does not open with "set {{PIN}} again", and the console
marks it.

**4. The model is never shown a value.** The task keeps its placeholders. The system prompt tells the
model that `{{NAME}}` is a secret it will never see, and that to enter one it types the placeholder
exactly. The runner fills it in at the one moment it sends keys to the device, and nowhere else: the
step records what the model sent (`{{PIN}}`). Anything the model would read that contains a value —
the on-screen element list, where a plain text field shows what was typed — has the value replaced by
its placeholder before it is sent, and before it is recorded. **And the screenshot**: wherever an
element's text held a value, its box is painted over in the image before the model is sent it or the
run keeps it (`ai/png-cover.ts`); an image that cannot be edited is withheld for that turn, never sent
as it was. Added after the farm showed the model reading a typed value off the image once the element
list no longer had it (D55).

**5. Refused at the door.** A run or saved test that names a secret the org does not have is refused
(400) with the names that are missing. A secret deleted after a test was saved fails the step that
types it, in words, rather than typing `{{PIN}}` into the app.

**6. Inline values keep working, and keep being masked.** A task that writes a value in (D52) still
runs and is still masked everywhere it is shown. The console suggests the named form when it sees one.

## What this does not do

- **Text the element tree does not describe.** A value is painted over where an ELEMENT shows it. One
  drawn onto a canvas, into a game, or inside a web view the tree does not describe cannot be found,
  so cannot be covered. A PIN or password field shows dots and needs nothing.
- **People in the same org.** Anyone in the org can USE a secret in a task. The store
  keeps values from being READ, not from being used — the same line CI secrets draw.
- **Scripts (C9).** "Export as script" writes `process.env.PIN` where a step typed `{{PIN}}`: the
  script's runner supplies it, and the exported file never holds the value.

## Consequences

- A task can be shared, exported, copied into a bug report and shown on a public link with nothing
  to hide, because it holds nothing.
- The masking of D52 stays as the net for inline values; `refuseMaskedPrompt` (#224) stays.
- A new place a value could leak is the runner's memory for the length of a run. It is held only for
  the run that needs it, and never logged.
