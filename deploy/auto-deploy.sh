#!/usr/bin/env bash
#
# Put `main` into service without waiting for a human to remember — S7's first ceiling.
#
#   deploy/auto-deploy.sh              # one tick; the systemd timer runs this
#   deploy/auto-deploy.sh --dry-run    # decide and report, change nothing
#
# Runs ON THE BOX, as the account that owns the checkout, every few minutes.
#
# WHAT THIS REPLACES. `deploy/mfarm-deploy.sh` is a good deploy and it only ever runs when somebody
# types it. On 2026-09-05 that gap was ninety minutes long and `docs/DEFECTS.md` spent all ninety of
# them claiming fixes were live that were not (D18). The fix for "a human forgets" is not a better
# reminder.
#
# WHAT IT DELIBERATELY IS NOT
#
#   * NOT a push from CI. GitHub Actions would need an SSH credential into production, standing, in
#     a repo secret. The box pulling is the same shape as ADR-0006 — the control plane never dials a
#     worker, work is offered and collected on a beat — and it adds no inbound access to anything.
#
#   * NOT able to undo a migration. A failed health gate rolls the IMAGE back, because images are
#     immutable and tagged by commit. The SCHEMA stays forward. So the safety property is "the farm
#     returns to serving a known-good build", NOT "the farm returns to a known-good state", and on a
#     commit whose migration is the problem the rollback is the wrong tool and the pause file is the
#     right one. Saying this plainly is the difference between a rollback and a reassurance.
#
#   * NOT unattended in the sense of unwatched. Every tick leaves evidence in
#     `deploy/.state/autodeploy/`, the API turns that evidence into three gauges, and the alerts in
#     `deploy/observability/alerts.yml` fire on a timer that has stopped, a commit that is blocked,
#     and a farm that has been behind `main` for too long. An automatic mechanism nobody is
#     measuring is how "released" and "deployed" came apart in the first place.
set -uo pipefail

# ---------------------------------------------------------------- 0. do not saw the branch you sit on
#
# THIS SCRIPT FAST-FORWARDS THE CHECKOUT IT IS RUNNING FROM. bash reads a script INCREMENTALLY — it
# seeks the file as it executes — so a `git merge` that rewrites these bytes mid-run makes the shell
# resume at a byte offset in a different file and execute whatever happens to be there. It does not
# reliably error; it does something arbitrary, once, on a production box.
#
# So the first thing a tick does is copy itself somewhere immutable and re-exec from the copy. The
# copy still operates on $REPO_ROOT — only the executing bytes are pinned.
#
# `mfarm-deploy.sh` needs no such guard and must NOT get one: it is a fresh process started after
# the merge, so it is the NEW deploy script, which is exactly right. A commit that changes how
# deploying works should be deployed the new way.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "${MFARM_AUTODEPLOY_PINNED:-}" ]; then
  SNAP="$(mktemp -d)"
  cp "$REPO_ROOT/deploy/auto-deploy.sh" "$SNAP/auto-deploy.sh" || exit 1
  mkdir -p "$SNAP/lib"
  cp "$REPO_ROOT/deploy/lib/autodeploy-decision.sh" "$SNAP/lib/" || exit 1
  chmod +x "$SNAP/auto-deploy.sh"
  trap 'rm -rf "$SNAP"' EXIT
  MFARM_AUTODEPLOY_PINNED="$REPO_ROOT" "$SNAP/auto-deploy.sh" "$@"
  exit $?
fi
REPO_ROOT="$MFARM_AUTODEPLOY_PINNED"

. "$(dirname "${BASH_SOURCE[0]}")/lib/autodeploy-decision.sh"

IMAGE_REPO="${MFARM_IMAGE_REPO:-ghcr.io/rkcr007/mfarm-api}"
API_PORT="${API_PORT:-3000}"
STATE_DIR="$REPO_ROOT/deploy/.state"
AD_DIR="$STATE_DIR/autodeploy"
# The health gate: `/ready` must answer this many times in a row, this far apart. Consecutive rather
# than "once", because an API that is restarting answers healthily for a moment between the old
# process leaving and the new one failing.
READY_PROBES="${MFARM_AUTODEPLOY_READY_PROBES:-5}"
READY_INTERVAL="${MFARM_AUTODEPLOY_READY_INTERVAL:-6}"

DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

log() { printf '%s auto-deploy: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# A NAMED TRAP RATHER THAN A SILENT ONE. `docker-compose.prod.yml` bind-mounts this directory into
# the API read-only so the deploy state can be scraped — and docker CREATES a missing bind-mount
# source as root. On a box where compose came up before the deployer first ran, `mkdir -p` then
# succeeds (the directory exists) and every write into it fails, so the timer runs forever, records
# nothing, and `mfarm_autodeploy_check_age_seconds` reports a deployer that has never ticked. The
# ownership is fixed by `install-autodeploy-service.sh`; this is what makes the failure legible if
# it happens anyway.
mkdir -p "$AD_DIR" 2>/dev/null
if ! : > "$AD_DIR/.probe" 2>/dev/null; then
  log "FATAL: $AD_DIR is not writable by $(id -un). Docker creates a missing bind-mount source as"
  log "       root; fix it with: sudo chown -R $(id -un) $AD_DIR"
  exit 1
fi
rm -f "$AD_DIR/.probe"

# ---------------------------------------------------------------- 1. what should be running
#
# FETCH, THEN READ. `git merge --ff-only origin/main` against a stale remote-tracking ref reports
# success and moves nothing — it did, on the lab, on 2026-09-07, and "success" is what made it cost
# a round trip to notice.
git -C "$REPO_ROOT" fetch origin main --quiet 2>/dev/null
WANT="$(git -C "$REPO_ROOT" rev-parse --verify --quiet origin/main 2>/dev/null || true)"

# ---------------------------------------------------------------- 2. what IS running
#
# Asked of the PROCESS, not of the checkout and not of `docker ps`. `mfarm-deploy.sh` ends by asking
# `/v1/version` for the same reason: every deployment mechanism that has bitten this project bit it
# by succeeding quietly while changing nothing, and a container labelled with a sha is a claim,
# whereas the running process answering with one is evidence.
RUNNING=''
KEY_FILE="$STATE_DIR/api_key"
if [ -r "$KEY_FILE" ]; then
  RUNNING="$(curl -fsS --max-time 10 -H "Authorization: Bearer $(cat "$KEY_FILE")" \
    "http://127.0.0.1:$API_PORT/v1/version" 2>/dev/null \
    | sed -n 's/.*"sha":"\([^"]*\)".*/\1/p')"
fi

# ---------------------------------------------------------------- 3. is there an artifact for it
#
# `Release` runs on `workflow_run` AFTER CI, so for a few minutes after every merge this is empty
# and the honest verdict is `waiting`. Asking the registry rather than GitHub keeps the question to
# the one that matters — not "did the workflow pass" but "is there an image to pull" — and needs no
# API token beyond the docker login the box already has.
RELEASED=''
if [ -n "$WANT" ] && docker manifest inspect "$IMAGE_REPO:$WANT" >/dev/null 2>&1; then
  RELEASED=yes
fi

FAILED="$(cat "$AD_DIR/failed-sha" 2>/dev/null || true)"
LAST_GOOD="$(cat "$AD_DIR/last-good-sha" 2>/dev/null || true)"
PAUSED=''
[ -e "$AD_DIR/paused" ] && PAUSED=yes

VERDICT="$(mfarm_autodeploy_decision "$WANT" "$RUNNING" "$RELEASED" "$FAILED" "$PAUSED")"

# ---------------------------------------------------------------- 4. leave evidence, always
#
# BEFORE acting, and on every path including the ones that do nothing. `last-check` is touched here
# so that a tick which dies halfway through step 5 still proves the timer is alive — a heartbeat
# written only on success measures the wrong thing, and `mfarm_autodeploy_check_age_seconds` would
# then report "the timer is dead" for what is actually a deploy failing.
#
# mtime IS the record, as it is for backups: a file that was written is evidence something ran, in a
# way that a script reporting its own success is not.
printf '%s\n' "$VERDICT" > "$AD_DIR/status"
printf '%s\n' "${WANT:-unknown}" > "$AD_DIR/want-sha"
: > "$AD_DIR/last-check"
# Where these bytes were executed from — the pinned snapshot of step 0, never $REPO_ROOT/deploy.
# Recorded because the guard it proves is invisible when it works and non-deterministic when it does
# not, so the only way to know it is still in place is to look at what a real tick wrote.
# RESOLVED AND ABSOLUTE, via `pwd -P`. `dirname "${BASH_SOURCE[0]}"` alone yields `./deploy` when
# the tick was started as `./deploy/auto-deploy.sh`, which is a string that can never equal the
# repo's own path — so a check written against it passes whether or not the guard is there. That is
# not a hypothetical: it is what the first version of this line did, and removing the guard entirely
# left every test green.
printf '%s\n' "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" > "$AD_DIR/pinned-from"

# How long the farm has been behind `main` — D18, as a number somebody can alert on.
#
# The FIRST tick that finds the farm behind creates this; every later one leaves its mtime alone, so
# the age of this file is the age of the gap rather than the age of the last check. `current` and
# `unknown` both remove it: the farm is up to date in the first case, and in the second there is no
# measured gap to report, only an unanswered question.
case "$VERDICT" in
  current|unknown) rm -f "$AD_DIR/pending-since" ;;
  *) [ -e "$AD_DIR/pending-since" ] || : > "$AD_DIR/pending-since" ;;
esac

log "want=${WANT:0:7} running=${RUNNING:0:7} released=${RELEASED:-no} verdict=$VERDICT"

case "$VERDICT" in
  current) log "the farm is running main"; exit 0 ;;
  paused)  log "PAUSED by $AD_DIR/paused — remove that file to resume"; exit 0 ;;
  unknown) log "could not read origin/main; doing nothing"; exit 1 ;;
  waiting) log "no image for ${WANT:0:7} yet — Release runs after CI; will retry"; exit 0 ;;
  blocked) log "REFUSING ${WANT:0:7}: its last deploy failed the health gate. A human must look."; exit 1 ;;
esac

[ "$DRY" = 1 ] && { log "--dry-run: would deploy ${WANT:0:7}"; exit 0; }

# ---------------------------------------------------------------- 5. deploy
#
# The checkout comes forward FIRST, and this is not cosmetic. `deploy/*.sh`, the migrations and — on
# a device host — the worker and the boot unit all run from this tree; `check-deployed.sh` reports
# the image and the checkout as separate facts because a farm can be wrong in either one alone (D19,
# where the lab's tree was sixty-six commits behind while the control plane ran the day's build).
log "fast-forwarding the checkout to ${WANT:0:7}"
if ! git -C "$REPO_ROOT" merge --ff-only origin/main --quiet 2>&1; then
  # NOT fatal to the farm and NOT silently continued either. A tree that will not fast-forward has
  # local commits, a detached HEAD or an untracked file in the way — all things a human did, and
  # none of them safe for a script to resolve by force.
  log "FAILED: the checkout will not fast-forward. Left alone; nothing deployed."
  printf '%s\n' "$WANT" > "$AD_DIR/failed-sha"
  exit 1
fi

log "deploying ${WANT:0:7}"
if ! "$REPO_ROOT/deploy/mfarm-deploy.sh" "$WANT"; then
  log "FAILED: mfarm-deploy.sh did not complete for ${WANT:0:7}"
  printf '%s\n' "$WANT" > "$AD_DIR/failed-sha"
  ROLLBACK="$(mfarm_autodeploy_rollback_target "$LAST_GOOD" "$WANT")"
  if [ -n "$ROLLBACK" ]; then
    log "rolling the image back to ${ROLLBACK:0:7}"
    "$REPO_ROOT/deploy/mfarm-deploy.sh" "$ROLLBACK" || log "ROLLBACK FAILED TOO — the farm needs a human now"
  else
    log "no recorded good build to roll back to; leaving the farm as it is"
  fi
  exit 1
fi

# ---------------------------------------------------------------- 6. the health gate
#
# `mfarm-deploy.sh` already proves the right SHA is answering. This proves the process is still
# answering a minute later, which is a different claim: a build that starts, serves its version and
# then dies on its first real query passes the first check and fails this one.
#
# CONSECUTIVE probes, not a total. An API mid-restart answers healthily in the gap between the old
# container leaving and the new one falling over, so "it was ready at least once" is satisfied by
# precisely the failure this is meant to catch.
log "health gate: $READY_PROBES consecutive /ready, ${READY_INTERVAL}s apart"
ok=0
for i in $(seq 1 "$((READY_PROBES * 3))"); do
  if curl -fsS --max-time 5 "http://127.0.0.1:$API_PORT/ready" >/dev/null 2>&1; then
    ok=$((ok + 1))
    [ "$ok" -ge "$READY_PROBES" ] && break
  else
    ok=0
  fi
  sleep "$READY_INTERVAL"
done

if [ "$ok" -lt "$READY_PROBES" ]; then
  log "HEALTH GATE FAILED for ${WANT:0:7} — /ready never answered $READY_PROBES times running"
  printf '%s\n' "$WANT" > "$AD_DIR/failed-sha"
  ROLLBACK="$(mfarm_autodeploy_rollback_target "$LAST_GOOD" "$WANT")"
  if [ -n "$ROLLBACK" ]; then
    log "rolling the image back to ${ROLLBACK:0:7} — NOTE: migrations are not rolled back"
    "$REPO_ROOT/deploy/mfarm-deploy.sh" "$ROLLBACK" || log "ROLLBACK FAILED TOO — the farm needs a human now"
  else
    log "no recorded good build to roll back to; leaving ${WANT:0:7} serving and saying so"
  fi
  exit 1
fi

# ---------------------------------------------------------------- 7. record the good build
#
# `failed-sha` is cleared HERE and only here. It is the memory that makes `blocked` work, and a
# stale one would refuse the next good commit that happened to share it — which cannot happen, since
# shas differ, but a `failed-sha` left behind after a successful deploy of the SAME commit (a human
# fixing the box by hand, then the timer catching up) would make the next tick refuse a farm that is
# already healthy.
printf '%s\n' "$WANT" > "$AD_DIR/last-good-sha"
rm -f "$AD_DIR/failed-sha" "$AD_DIR/pending-since"
: > "$AD_DIR/last-deploy"
printf 'current\n' > "$AD_DIR/status"
log "deployed and healthy: ${WANT:0:7}"
