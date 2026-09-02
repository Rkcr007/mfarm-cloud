---
id: ADR-0023
title: The published CLI is compiled JavaScript under a scope we own
status: Accepted
date: 2026-09-03
authors:
  - Claude Code
tags: [cli, packaging, npm, supply-chain, ci]
extends: [ADR-0002]
---

## Context

`@mfarm/cli` is the only thing in this repo a customer installs. Everything else — the API, the
worker, the console — they reach over the network. It has been `"private": true` since it was
written, which ADR-0002 recorded as a packaging note and left there.

That is not a cosmetic gap. `action.yml:255` runs

```
npx --yes --package "@mfarm/cli@${MFARM_CLI_VERSION:-0.1.0}" mfarm
```

so the GitHub Action — the one-line adoption path — fails on its first command for everyone who is
not us. The documented product does not exist at the address the documentation gives.

Two things about the package as it stood made "just publish it" the wrong move.

**It shipped TypeScript.** `bin` pointed at `src/bin.ts`, whose shebang is
`#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning`. Correct
for this repo, which has no build step by design and runs `.ts` directly on Node's type stripping.
Wrong for a tarball, because the Node it lands on is chosen by the customer's CI image. An
unrecognised flag is a startup failure, not a warning, and `env -S` is not universal either.

**Its own README pointed at a name we do not own.** It said `npx mfarm run …`. The unscoped `mfarm`
on npm is unregistered, so that command resolves to whatever anyone chooses to publish there — and
runs it in a process holding `MFARM_API_KEY` and deriving `MFARM_WEBDRIVER_URL`, which embeds the
key. `action.yml` and `docs/ci.md` both already warned about exactly this in comments. The README
was the one place that had not been updated, and it is the file a new user reads first.

## Decision

**The repo keeps TypeScript. The tarball carries compiled JavaScript, under `@mfarm/cli`, and
refuses to start on a Node it does not support.**

**1. A build, scoped to publishing and nothing else.** `tsconfig.build.json` emits `src/` to `dist/`
with `rewriteRelativeImportExtensions`, which turns `./client.ts` into `./client.js` in the output —
without it the tarball is JavaScript importing TypeScript that was never shipped.
`build.mjs` then rewrites the shebang to a plain `#!/usr/bin/env node`, because tsc copies a shebang
through verbatim and the source's is for a runtime with type stripping. `prepack` runs it, so
`npm publish` cannot ship a stale `dist/`, and `dist/` is gitignored so a committed copy cannot
disagree with its source.

The root `tsconfig.json` still says no build step should be added, and that rule still holds: it is
about OUR machines, where a build step between an edit and a run is exactly the friction this repo
refuses. A stranger's Node is not our machine.

**2. The runtime floor is checked, not merely declared.** `engines` is advisory — npm prints
EBADENGINE and installs the package anyway. Measured on a real Node 16 install of the real tarball,
the failure without a check is `mfarm: GET /v1/devices failed after 4 attempt(s): fetch is not
defined` — true, four retries deep, and silent about the actual cause. On Node 18 or 20.0 it is
`AbortSignal.any is not a function` from inside a request, by which point `mfarm run` may already
hold a device it is about to fail to release.

So `src/engine.ts` compares `process.versions.node` against `20.3.0` before `main` runs. 20.3.0 is
not a round number: it is where `AbortSignal.any` landed, which `client.ts` uses to combine the
caller's abort signal with the request timeout, and it is the newest API this package touches.

**3. Scoped, and the README says so.** `@mfarm/cli` with `publishConfig.access: public`. The README
now leads with `npm install --save-dev @mfarm/cli` and states that the command is `mfarm` while the
package is not — with the `npx --package @mfarm/cli@0.1.0 mfarm` form for people who will not
install, pinned, for the reason `action.yml` already gives about floating dist-tags.

## Alternatives rejected

**Publish the TypeScript and require Node 22.6+.** Tempting because it changes nothing about the
repo. It makes the customer's Node version our problem forever, on the runtime with the largest
installed base of old versions in CI, to save a 40-line build. It also means every stack trace a
customer reports comes from a file whose line numbers depend on their Node's stripping behaviour.

**A bundler.** The package has zero dependencies — nothing to bundle. `tsc` is already a
devDependency and already the thing that typechecks the repo.

**Ship `src/` alongside `dist/` so sourcemaps resolve.** Deferred to the licence decision. Sourcemaps
are currently emitted with external sources that are not in the tarball, so they degrade to
line numbers. If the licence is permissive, `inlineSources` is the better answer; if it is
proprietary, the maps should be dropped entirely. Publishing sources by accident is a one-way door.

## Consequences

**Positive.** The tarball runs on Node 20.3 through 24 with no flags. An unsupported runtime gets one
sentence naming what it needs and what it has, and exits 1 before allocating anything.

**Positive.** `npm test` and the action's `real-cli` scenario are untouched: the unit harness spawns
`node --experimental-strip-types <src/bin.ts>` explicitly rather than relying on the shebang, and
`action-test.yml` points `MFARM_CLI_BIN` at the source. Only the published artifact changed.

**Negative.** There is now one build in a repo whose defining property was having none, and a second
tsconfig to keep in step with the first. Contained by `extends: ../../tsconfig.json` — the build
config overrides emit settings and nothing else.

**Negative.** `dist/` is a second layout for the same code, and `version()` reads
`../package.json` — which resolves correctly from both `src/bin.ts` and `dist/bin.js` only because
both sit exactly one level below the package root. Nesting the output deeper would silently read the
CONSUMER's package.json and report their version. Commented at the call site.

**Open.** The package has no `license` field, because the repo has no LICENSE file. npm publishes it
as unlicensed, which legally means nobody may use it. That is a decision for the owner, not a
default to pick, and it is the last thing standing between this and a publish.

## Verification

- `apps/cli/test/engine.test.ts` — 19 cases, all of them Nodes the test is not running on, asserting
  the boundary from both sides. Mutation-checked: lowering the floor to 20.2.0 fails
  `20.2.9 is refused` by name, on the message content rather than merely on the return value.
- **CI job `package`** — packs the tarball, installs it in a directory with no workspace and no
  lockfile, and runs it, on Node **20.3.0** (the exact declared floor, so a wrong floor fails here),
  22 and 24. It also asserts the emitted shebang is plain `#!/usr/bin/env node` and that no `.ts`
  specifier survived into `dist/`. This closes the gap that let PR #72 pass CI and fail Release:
  **the thing shipped was not the thing tested.**
- Measured locally on the real tarball before any of the above was written: a clean `npm install` of
  `mfarm-cli-0.1.0.tgz` into an empty project, then `mfarm --version` → `0.1.0` on Node 23.11.0, and
  on Node 16.17.0 → `mfarm: mfarm needs Node 20.3.0 or newer; this is 16.17.0.` with exit 1.

## Related

- `ADR-0002` — the CLI is a wrapper; its packaging note is what this supersedes
- `action.yml` — the pinned, scoped `npx` invocation and its reasoning about dist-tags
- `docs/ci.md` — the customer-facing snippet, which already used the scoped name
