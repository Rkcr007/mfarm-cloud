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

**Ship `src/` alongside `dist/` so sourcemaps resolve.** Rejected once the licence was settled as
MIT: `inlineSources` puts the sources inside the maps instead, which is the same information without
a second copy of the tree in the tarball. A map whose `sources` point at files that are not shipped
degrades to bare line numbers, which is the same as having no map at all. Under a proprietary licence
the answer would have been the opposite — drop the maps, because publishing source by accident is a
one-way door.

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

**Resolved 2026-09-03 — MIT.** The repo had no LICENSE file and no `license` field, which would have
published the package as unlicensed: legally, nobody may use it. The owner chose MIT, on the
reasoning that the CLI is a wrapper whose entire purpose is to talk to the MFARM service — the value
being protected is the farm, not the 1,400 lines, and a permissive licence removes a question every
prospective user's legal team would otherwise have to answer.

`apps/cli/LICENSE` is a copy of the repo-root file, because npm only includes files from the package
directory. `build.mjs` compares the two and refuses to build if they have drifted, since a licence
that disagrees with itself is worse than one that is merely duplicated.

## Verification

- `apps/cli/test/engine.test.ts` — 19 cases, all of them Nodes the test is not running on, asserting
  the boundary from both sides. Mutation-checked: lowering the floor to 20.2.0 fails
  `20.2.9 is refused` by name, on the message content rather than merely on the return value.
- **CI job `package`** — packs the tarball, installs it in a directory with no workspace and no
  lockfile, and runs it, on Node **20.3.0** (the exact declared floor, so a wrong floor fails here),
  22 and 24. It also asserts the emitted shebang is plain `#!/usr/bin/env node` and that no `.ts`
  specifier survived into `dist/`. This closes the gap that let PR #72 pass CI and fail Release:
  **the thing shipped was not the thing tested.**
### Confirmed on the live registry, 2026-09-03

`@mfarm/cli@0.1.0` is published. Verified against npm rather than a local tarball, because the two
can differ — npm normalised `bin` from `./dist/bin.js` to `dist/bin.js` on the way out and said so:

- `npm install @mfarm/cli` into an empty project, then `mfarm --version` → `0.1.0`.
- `npx --yes --package "@mfarm/cli@0.1.0" mfarm --version` → `0.1.0`. **This is the exact command
  `action.yml` runs**, so the adoption path now works for someone who is not us.
- The published build on Node 16.17.0 → `mfarm needs Node 20.3.0 or newer; this is 16.17.0.`, exit 1.
  The guard survived compilation and packaging.
- `license: MIT`, `engines: {"node":">=20.3.0"}` as served by the registry.

The `published-cli` CI job now reads the pin out of `action.yml` and resolves it from npm on every
run. Pinning is deliberate (`action.yml` explains why a floating dist-tag would be worse), and its
cost is that the pin can name a version nobody published — which nothing else here would catch,
since every other CLI test points `MFARM_CLI_BIN` at the checkout and never touches the registry.

- Measured locally on the real tarball before any of the above was written: a clean `npm install` of
  `mfarm-cli-0.1.0.tgz` into an empty project, then `mfarm --version` → `0.1.0` on Node 23.11.0, and
  on Node 16.17.0 → `mfarm: mfarm needs Node 20.3.0 or newer; this is 16.17.0.` with exit 1.

## The unscoped name

`mfarm` on npm was unregistered, and `packages/mfarm-name` now claims it with an inert package: it
prints where the real CLI is and exits 1.

This is not tidiness. `mfarm run` executes in a process holding `MFARM_API_KEY` and derives
`MFARM_WEBDRIVER_URL`, which embeds it — so `npx mfarm …`, the command this project's own README
suggested until today, would have handed a customer's credential to whoever registered the name
first. Publishing twenty lines that do nothing is the cheapest permanent close.

It is deliberately plain JavaScript with no build, no dependencies and no engine floor, so that it
runs on any Node a stranger might have and fails with its own message rather than a parser error.
It exits **1**, not 0: someone who reaches it in CI has a broken pipeline and should find out
immediately, rather than watch a green step that allocated no device and ran no tests.

The repo's private root package was renamed `mfarm` → `mfarm-cloud` at the same time, because a
workspace and its root sharing a name makes `npm -w mfarm` ambiguous.

## Related

- `ADR-0002` — the CLI is a wrapper; its packaging note is what this supersedes
- `action.yml` — the pinned, scoped `npx` invocation and its reasoning about dist-tags
- `docs/ci.md` — the customer-facing snippet, which already used the scoped name
