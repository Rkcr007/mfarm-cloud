---
id: ADR-0030
title: The box pulls main on a timer, and refuses a commit that failed its health gate
status: Accepted
date: 2026-09-07
authors:
  - Claude Code
tags: [deploy, reliability, operations, observability]
extends: [ADR-0006]
---

## Context

`deploy/mfarm-deploy.sh` is a good deploy. It resolves a commit to a full sha, pulls the image CI
built from it, applies migrations, restarts only the API, and then asks the running process what it
is rather than trusting that docker exited zero. Nothing about it is wrong.

It runs when a human types it.

On 2026-09-05 that gap was ninety minutes: PR #102 merged at 11:28, `Release` published at 11:34,
and the commit reached the box at 13:08. For the whole of that window `docs/DEFECTS.md` said the
fixes were in the deployed build and they were not (D18). The same hour, both boxes' *checkouts*
were found adrift — `mfarm-cp` on a detached HEAD, `mfarm-lab` sixty-six commits behind on the tree
the worker and the boot unit both `ExecStart` out of (D19).

`docs/EXECUTION_ROADMAP.md` S7 lists "deploy is manual" as a reliability ceiling and puts it first,
ahead of a second device host and ahead of the rate limiter, because it is the one that has already
cost real time and the one that silently invalidates every "verified on the farm" claim made while
it is true.

The fix for "a human forgets" is not a better reminder.

## Decision

**A systemd timer on the control plane asks every five minutes whether the farm is running `main`,
and deploys it when it is not.** `deploy/auto-deploy.sh`, `mfarm-autodeploy.{service,timer}`,
installed from the repo by `deploy/install-autodeploy-service.sh`.

**The box pulls; CI does not push.** A GitHub Actions job that deployed would need a standing SSH
credential into production sitting in a repo secret. Pulling is the same shape as ADR-0006 — the
control plane never dials a worker, work is offered and collected on a beat — and it adds no inbound
access to anything. The registry is the only thing both sides touch.

**A tick is a decision, and the decision is a separate, tested function.**
`deploy/lib/autodeploy-decision.sh` returns one of `paused | unknown | current | blocked | waiting |
deploy`, and each verdict exists because of a specific way an unattended deploy goes wrong:

- **`waiting`** — `Release` runs on `workflow_run` *after* CI, so for several minutes after every
  merge `origin/main` names a commit GHCR has never heard of. `mfarm-deploy.sh` answers a failed
  pull by **building the image on the box** — which fails on `mfarm-cp` and, on a box where it
  succeeded, would serve an artifact CI never tested. This session walked into that trap by hand
  four minutes after merging #128.
- **`blocked`** — the verdict that makes this a deployer rather than a loop. See below.
- **`unknown`** — a failed `git fetch` must not read as "main has not moved".
- **`paused`** — a kill switch that the rest of the logic can outvote is not a kill switch, so it is
  checked before everything else.

**A deployed commit must stay healthy for a minute, not merely start.** `mfarm-deploy.sh` proves the
right sha is answering. The tick then requires five *consecutive* `/ready` responses six seconds
apart. Consecutive rather than cumulative: an API mid-restart answers healthily in the gap between
the old container leaving and the new one falling over, so a gate satisfied by one success is
satisfied by precisely the failure it exists to catch.

**A commit that fails that gate is rolled back and never retried.** Without the memory, the next
tick recomputes the same `origin/main`, finds the farm serving something older, and redeploys the
bad commit — every five minutes, forever. One bad merge would become a restart loop, which is
strictly worse than the manual deploy this replaces. The failure is recorded, and the farm stops
moving until a human looks.

**The deployer is measured, because an automatic mechanism nobody watches is how this defect was
born.** The state directory is bind-mounted read-only into the API, which exports
`mfarm_autodeploy_check_age_seconds`, `mfarm_autodeploy_pending_seconds`,
`mfarm_autodeploy_blocked` and `mfarm_autodeploy_paused`, and three rules in `alerts.yml` fire on a
dead timer, a blocked commit, and a farm that has been behind `main` for half an hour. That last one
is D18 itself, expressed as a number somebody can be paged about.

## Consequences

**The rollback moves the image, not the schema.** Images are immutable and tagged by commit, so
rolling one back is exact. Migrations are forward-only and this does not change that. The safety
property is therefore *"the farm returns to serving a known-good build"*, **not** *"the farm returns
to a known-good state"* — and on a commit whose migration is the problem, the rollback is the wrong
tool and the pause file is the right one. Stating this plainly is the difference between a rollback
and a reassurance.

**With no recorded good build, nothing is rolled back.** On the first ever auto-deploy there is
nothing that has passed a health gate, and a derived target — `origin/main~1`, the previous tag —
would move the farm onto a commit nobody chose, backwards past migrations that do not roll back. The
tick leaves the suspect build serving, records the failure so the next tick is `blocked`, and says
so. A farm serving a suspect build that somebody is being told about beats a farm serving a build a
script picked in the dark.

**The tick executes from a copy of itself.** It fast-forwards the checkout it lives in, and bash
seeks its script file as it executes — so rewriting those bytes mid-run resumes the shell at an
offset in a different file. It does not reliably error; it does something arbitrary, once, on a
production box. Step 0 of every tick copies the script and its library to a temp directory and
re-execs. `mfarm-deploy.sh` deliberately gets no such guard: it is a fresh process started *after*
the merge, so it is the new deploy script, which is what a commit that changes how deploying works
should get.

**Control plane only, for now.** D19's worse half was the *device host's* checkout, and this does
not fix it. Bringing a worker's tree forward means restarting the agent under whatever sessions are
running, which is a different decision with a different blast radius; `install-autodeploy-service.sh`
refuses to install on a box with no `deploy/.state/api_key` and explains which of the two cases it
is in. `check-deployed.sh` continues to report the lab's checkout as its own fact.

**A `waiting` verdict is normal and a sustained one is not.** Between a merge and its image the farm
is legitimately behind, which is why `MfarmFarmBehindMain` waits half an hour rather than firing on
`pending > 0`. A Release that never publishes therefore surfaces as a farm quietly stuck behind
`main`, on the one alert built to notice it.

**The unit is not marked failed for ordinary refusals.** `waiting` and `blocked` exit non-zero
because they are useful shell exit codes, and `SuccessExitStatus=0 1` keeps systemd from painting a
healthy farm red. The states that matter are surfaced as metrics instead — a failed unit on a box
nobody is looking at is not a notification.
