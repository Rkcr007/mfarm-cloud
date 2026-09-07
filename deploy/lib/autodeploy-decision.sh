# Should the box deploy this commit right now? — the decision, as a function so it can be executed
# in a test.
#
# WHY THIS EXISTS. `docs/EXECUTION_ROADMAP.md` S7 names manual deploy as a reliability ceiling, and
# `deploy/lib/deployed-state.sh` records what it costs: PR #102 merged at 11:28, released at 11:34,
# and reached the box at 13:08 when somebody finally ran `mfarm-deploy.sh`. For ninety minutes
# `docs/DEFECTS.md` said those fixes were "in the deployed build" and they were not.
#
# A timer closes that gap and introduces three failure modes a human never had:
#
#   1. DEPLOYING A COMMIT THAT HAS NO IMAGE. `Release` runs on `workflow_run` AFTER CI, so for a few
#      minutes after every merge `origin/main` names a commit GHCR has never heard of.
#      `mfarm-deploy.sh` falls back to building on the box when the pull fails — which on `mfarm-cp`
#      fails on a secrets permission, and on a box where it succeeded would serve an artifact CI
#      never tested. Both are worse than waiting. That is `waiting`, and it is the trap this session
#      walked into by hand on 2026-09-07.
#
#   2. RETRYING A BAD COMMIT FOREVER. A commit that deploys and then fails its health gate is rolled
#      back; without memory the next tick computes the same `origin/main` and does the same thing,
#      turning one bad merge into a restart every few minutes until somebody notices. That is
#      `blocked`, and it is the single most important verdict here — a timer with no memory of
#      failure is not automation, it is a loop.
#
#   3. ACTING ON A PICTURE IT DOES NOT HAVE. `git fetch` fails on a box with no network more often
#      than for any other reason. The wrong response to "I cannot tell what main is" is to deploy
#      something. That is `unknown`, and `deployed-state.sh` already carries the rule it follows:
#      an answer that could not be read is never treated as a good one.
#
# THE DECISION IS SEPARATED FROM THE DOING for the reason `check-deployed.test.mjs` states: the
# gathering is ssh, docker and curl and cannot be unit-tested; the decision is the part that would
# silently start answering "deploy" to everything.

# `mfarm_sha_eq a b` — do these name the same commit, at whatever lengths they were printed at?
#
# Shared by every comparison below so that "same commit" means one thing in this file. A verdict
# that used equality in one branch and prefix matching in another would be correct on the farm,
# where both shas are full, and wrong in exactly the tests written to prove it.
mfarm_sha_eq() {
  local a="$1" b="$2"
  [ -n "$a" ] && [ -n "$b" ] || return 1
  [ "$a" != unknown ] && [ "$b" != unknown ] || return 1
  [ "${#a}" -ge 7 ] && [ "${#b}" -ge 7 ] || return 1
  [ "${a:0:${#b}}" = "$b" ] || [ "${b:0:${#a}}" = "$a" ]
}

# One of: paused | unknown | current | blocked | waiting | deploy
#
#   want      the sha the farm should be running — `origin/main`, resolved on the box
#   running   the sha the API reports serving now, or empty when it could not be read
#   released  non-empty when the registry has an image for `want`
#   failed    the sha whose last deploy failed its health gate, or empty
#   paused    non-empty when the kill switch is present
#
# ARGUMENT ORDER IS CHECKED, NOT ASSUMED: four of these five are sha-shaped, and transposing two
# would produce a function that still returns plausible verdicts on a real farm. The test passes
# deliberately distinguishable values for exactly that reason.
mfarm_autodeploy_decision() {
  local want="$1" running="$2" released="$3" failed="$4" paused="$5"

  # FIRST, BEFORE EVERY OTHER CONSIDERATION. The kill switch exists to be reached for during an
  # incident, and a switch that only works when the rest of the logic agrees with it is not a
  # switch. It also means a pause holds through a merge, a rollback and an unreadable API.
  if [ -n "$paused" ]; then printf 'paused'; return; fi

  if [ -z "$want" ] || [ "$want" = unknown ]; then printf 'unknown'; return; fi

  if mfarm_sha_eq "$want" "$running"; then printf 'current'; return; fi

  # BEFORE `released`, deliberately. A commit that failed its health gate stays blocked whether or
  # not its image is still in the registry, and reporting it as `waiting` would describe a farm that
  # is one Release away from being fine when it is actually one human away.
  if mfarm_sha_eq "$want" "$failed"; then printf 'blocked'; return; fi

  if [ -z "$released" ]; then printf 'waiting'; return; fi

  printf 'deploy'
}

# The sha to roll back to when a deploy fails its health gate, or empty when there is none.
#
# EMPTY IS A REAL ANSWER AND MUST NOT BE PAPERED OVER. On the first ever auto-deploy there is no
# recorded good build, and inventing one — `origin/main~1`, the previous tag, anything derived —
# would roll the farm onto a commit nobody chose, past migrations that do not roll back. The caller
# leaves the new build running, records the failure so the next tick is `blocked`, and says so
# loudly. A farm serving a suspect build that somebody is being told about beats a farm serving a
# build a script picked in the dark.
mfarm_autodeploy_rollback_target() {
  local last_good="$1" want="$2"
  [ -n "$last_good" ] && [ "$last_good" != unknown ] || { printf ''; return; }
  # Never "roll back" onto the thing that just failed.
  mfarm_sha_eq "$last_good" "$want" && { printf ''; return; }
  printf '%s' "$last_good"
}
