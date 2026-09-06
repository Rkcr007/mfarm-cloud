#!/usr/bin/env bash
#
# Is the farm actually back, end to end?
#
#   bash deploy/verify-live.sh            # run on the control plane (mfarm-cp)
#
# Written to be run after `gcloud compute instances start`, and it WAITS rather than reporting a
# false negative: two Cuttlefish devices cold boot after a host start, which takes minutes, and a
# check that answers "0 devices" thirty seconds in is worse than no check at all — it says the farm
# is broken when it is merely still starting.
#
# What it deliberately does NOT do is trust anything it cannot see. Every line below is an answer
# from the running system: the API's own report of which commit it is, the fleet as the control
# plane sees it (not as the worker claims), and the relay answering on its public port. A green
# systemctl proves a process exists, which is not the same question.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The farm's two public names, from one place. Environment wins, so a one-off override still works.
FARM_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/farm.env"
# shellcheck disable=SC1090
[ -f "$FARM_ENV" ] && . "$FARM_ENV"
HOST_PUBLIC="${HOST_PUBLIC:-https://${MFARM_PUBLIC_HOST:-34-100-138-213.sslip.io}}"
API="${API:-http://127.0.0.1:3000}"
TURN_HOST="${TURN_HOST:-${MFARM_TURN_HOST:-34.100.159.34}}"
DEVICE_WAIT_SECONDS="${DEVICE_WAIT_SECONDS:-600}"
# How long to keep re-reading the tunnel gauge once devices are up. Configurable so the
# test can exercise the "never connects" branch without waiting a real minute for it.
TUNNEL_WAIT_SECONDS="${TUNNEL_WAIT_SECONDS:-60}"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

FAIL=0
AVAIL=0
DP=""

# ---------------------------------------------------------------- 1. the control plane
say "Control plane"
for i in $(seq 1 60); do
  curl -sf --max-time 5 "$API/health" >/dev/null 2>&1 && break
  sleep 5
done
if curl -sf --max-time 5 "$API/health" >/dev/null 2>&1; then
  ok "API answering on $API"
else
  bad "API never answered on $API — docker compose -f deploy/docker-compose.prod.yml logs api"
  FAIL=1
fi

# `/v1/*` is authenticated, including version — the running commit is fleet information, not a
# public banner. Read the key first so this reports the sha instead of shrugging at a 401.
KEY_FILE="$REPO_ROOT/deploy/.state/api_key"
KEY="$([ -f "$KEY_FILE" ] && cat "$KEY_FILE" || true)"
VERSION="$(curl -s --max-time 5 -H "Authorization: Bearer $KEY" "$API/v1/version" 2>/dev/null)"
SHA="$(printf '%s' "$VERSION" | sed -n 's/.*"short":"\([^"]*\)".*/\1/p')"
[ -n "$SHA" ] && ok "running commit $SHA" || warn "could not read /v1/version (is deploy/.state/api_key present?)"

# ---------------------------------------------------------------- is that commit `main`? (D18/D19)
#
# THE BUILD BADGE SAYS WHAT IS SERVING AND NOTHING SAID WHAT SHOULD BE. On 2026-09-05 the farm ran
# `886cb47` while main was two merges further on — released at 11:34, served at 13:08 — and
# `docs/DEFECTS.md` claimed those fixes were live for ninety minutes. It was found by reading
# `docker ps` for an unrelated reason.
#
# Asked HERE because this is the script somebody already runs after `instances start`, and the
# question "which commit was the farm running" is what every later claim depends on. The checkout is
# reported alongside, because `deploy/*.sh` and the migrations run from it and it drifts separately
# — mfarm-cp was found on a detached HEAD the same hour.
. "$REPO_ROOT/deploy/lib/deployed-state.sh"
git -C "$REPO_ROOT" fetch origin main --quiet 2>/dev/null || true
WANT="$(git -C "$REPO_ROOT" rev-parse origin/main 2>/dev/null || echo unknown)"
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ "$WANT" = unknown ]; then
  warn "could not read origin/main — cannot say whether this farm is up to date"
else
  [ "$(mfarm_deploy_verdict_quiet "$WANT" "$SHA")" = ok ] \
    || { warn "the API is not running origin/main (${WANT:0:7}) — deploy/mfarm-deploy.sh $WANT"; }
  [ "$(mfarm_deploy_verdict_quiet "$WANT" "$HEAD_SHA")" = ok ] \
    || warn "this checkout is not on origin/main (${HEAD_SHA:0:7} vs ${WANT:0:7}) — git merge --ff-only origin/main"
fi

# The image tag, separately from the commit, because `:latest` is how this deployment lies. A bare
# `docker compose up -d api` used to fall back to it and serve older code while reporting success.
RUNNING_IMAGE="$(docker inspect mfarm-api-1 --format '{{.Config.Image}}' 2>/dev/null || true)"
case "$RUNNING_IMAGE" in
  *:latest) bad "the API is running $RUNNING_IMAGE — a floating tag, not a deployed commit. Run deploy/mfarm-deploy.sh <sha>."; FAIL=1 ;;
  "") : ;;
  *) ok "image pinned to a commit (${RUNNING_IMAGE##*:})" ;;
esac

# The public route is a separate question from the API being up: Caddy terminates TLS and proxies
# both the console and /dp, and a certificate that failed to renew looks exactly like a dead API.
if curl -sf --max-time 15 "$HOST_PUBLIC/health" >/dev/null 2>&1; then
  ok "public HTTPS reachable at $HOST_PUBLIC"
else
  bad "$HOST_PUBLIC did not answer — check caddy, and that the reserved IP is still attached"
  FAIL=1
fi

# 426 is the data plane's "websocket only" answer. It proves the ROUTE exists — nothing more, and
# less than it used to. When /dp went straight to the worker, only a reachable worker could produce
# it, so one number answered both questions. On the tunnel path the control plane answers it
# whether or not any agent is connected (deliberately: a probe that could tell the two transports
# apart would be reporting on the transport instead of on the farm), so reachability has to be
# asked separately.
DP="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$HOST_PUBLIC/dp/probe" 2>/dev/null)"

# THAT SEPARATE QUESTION. `mfarm_tunnel_hosts_connected` counts agents holding a live tunnel, and it
# is the only thing here that observes the connection a live view actually rides — a host beats over
# plain HTTPS, so it can report every device READY with its tunnel dead and look perfect.
#
# Works on BOTH ingress paths, which is why the check below can stop caring which one is configured:
# the agent dials out regardless of where /dp points (workers/agent/src/index.ts), so a healthy
# agent means a tunnel whether or not anything is routed down it.
#
# Loopback and best-effort. The listener is deliberately unproxied and this script may be run
# somewhere without the secret; an unreadable gauge downgrades the verdict rather than failing it.
METRICS_PORT="${METRICS_PORT:-9464}"
METRICS_TOKEN_FILE="${METRICS_TOKEN_FILE:-$REPO_ROOT/deploy/secrets/metrics_token}"
read_tunnels() {
  [ -f "$METRICS_TOKEN_FILE" ] || { printf ''; return; }
  curl -s --max-time 5 -H "Authorization: Bearer $(cat "$METRICS_TOKEN_FILE")" \
    "http://127.0.0.1:${METRICS_PORT}/metrics" 2>/dev/null \
    | sed -n 's/^mfarm_tunnel_hosts_connected \([0-9][0-9]*\).*/\1/p' | head -1
}
TUNNELS="$(read_tunnels)"

# ---------------------------------------------------------------- 2. the fleet
say "Fleet (waiting up to ${DEVICE_WAIT_SECONDS}s — devices cold boot after a host start)"
if [ -z "$KEY" ]; then
  warn "no deploy/.state/api_key; skipping the fleet check"
else
  DEADLINE=$(( $(date +%s) + DEVICE_WAIT_SECONDS ))
  AVAIL=0
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    BODY="$(curl -s --max-time 10 -H "Authorization: Bearer $KEY" "$API/v1/devices" 2>/dev/null)"
    AVAIL="$(printf '%s' "$BODY" | sed -n 's/.*"available":\([0-9]*\).*/\1/p')"
    [ -n "$AVAIL" ] || AVAIL=0
    [ "$AVAIL" -ge 2 ] && break
    printf '\r  … %s device(s) ready' "$AVAIL"
    sleep 15
  done
  printf '\r'

  # RE-READ THE TUNNEL COUNT, because the value sampled in section 1 is from BEFORE this wait.
  #
  # This is the bug that made `farm-check.sh` lie on every cold start: `$TUNNELS` was read once,
  # up with the control-plane checks, and then asserted on down here after a wait that can run for
  # minutes. On a farm that had just been started it was always a snapshot from before the agent
  # existed, so the script reported "no agent tunnel connected — every live view is dead" while the
  # worker log showed `data-plane tunnel connected` seconds later. Re-running always said the farm
  # was live, which is the tell: a check whose answer depends on when you happened to sample it is
  # not measuring the farm.
  #
  # It also gets its own short wait rather than a single re-read. The agent connects its tunnel
  # around the time its devices finish booting, not strictly before, so a device-ready farm can
  # legitimately be a few seconds short of a tunnel — and asserting on that instant would swap a
  # guaranteed false negative for an occasional one.
  #
  # ONLY WHEN THERE ARE DEVICES. A farm with none is almost always the deliberate idle state — the
  # device host is off between sessions and is 95% of the bill — and that case is detected by
  # `AVAIL = 0` together with no agent. Waiting a minute for a tunnel that nobody is bringing up
  # would add a minute to the most common invocation of this script to learn nothing.
  if [ "$AVAIL" -ge 1 ] && [ -f "$METRICS_TOKEN_FILE" ]; then
    TUNNEL_DEADLINE=$(( $(date +%s) + TUNNEL_WAIT_SECONDS ))
    while [ "$(date +%s)" -lt "$TUNNEL_DEADLINE" ]; do
      TUNNELS="$(read_tunnels)"
      [ -n "$TUNNELS" ] && [ "$TUNNELS" -ge 1 ] && break
      sleep 5
    done
  fi

  # A STOPPED DEVICE HOST IS A NORMAL STATE, NOT A FAILURE. It is off between sessions by design and
  # it is 95% of the bill. Reported as a note so that `farm-check.sh` after starting only the control
  # plane does not print a wall of red for a farm that is behaving exactly as intended.
  #
  # TWO SYMPTOMS TOGETHER identify it, and the second one now has two spellings. No devices, AND
  # either /dp with no upstream (the direct path, where a stopped worker takes the route with it) or
  # no agent tunnel (the tunnel path, where the control plane keeps answering 426 on its own).
  # Either symptom alone still means something else: devices with no route is a routing problem, a
  # route with no devices is a worker that is up but has no hardware.
  if [ "$AVAIL" -eq 0 ] && { [ "$DP" = "502" ] || [ "$TUNNELS" = "0" ]; }; then
    warn "the device host looks STOPPED — no devices, and no agent reachable"
    warn "that is the normal idle state; start it with ./deploy/farm-online.sh"
  else
    if [ "$DP" = "426" ]; then
      ok "/dp serves the data plane (426 = websocket only)"
    elif [ "$DP" = "502" ]; then
      bad "/dp has no upstream — the ingress names a worker address that is not answering"
      FAIL=1
    else
      bad "/dp answered $DP, not 426 — the live view has no route at all"
      FAIL=1
    fi

    # The route existing and an agent being on the end of it are two facts, and only this one is
    # about whether a person can see a screen.
    if [ -z "$TUNNELS" ]; then
      warn "could not read mfarm_tunnel_hosts_connected — agent reachability unverified"
      warn "(needs deploy/secrets/metrics_token; the metrics listener is loopback-only by design)"
    elif [ "$TUNNELS" -ge 1 ]; then
      ok "$TUNNELS agent tunnel(s) connected — the live view has somewhere to go"
    else
      bad "no agent tunnel connected — every live view is dead, however healthy the fleet looks"
      bad "check: journalctl -u mfarm-worker -n50 | grep tunnel   (on the device host)"
      FAIL=1
    fi

    if [ "$AVAIL" -ge 2 ]; then
      ok "$AVAIL devices READY"
    elif [ "$AVAIL" -ge 1 ]; then
      warn "only $AVAIL device READY — the other may still be booting (journalctl -u mfarm-worker -f on mfarm-lab)"
    else
      bad "no devices READY after ${DEVICE_WAIT_SECONDS}s"
      FAIL=1
    fi

    # Only asked once there ARE devices. Grepping an empty response answered "yes" and printed a
    # green line about a live view on a farm with no hardware at all — a check that reports success
    # on no data is worse than no check.
    if [ "$AVAIL" -ge 1 ]; then
      printf '%s' "$BODY" | grep -q 'screen-stream' && ok "devices declare screen-stream (live view available)" \
        || warn "no device declares screen-stream — no live view"
    fi
  fi
fi

# ---------------------------------------------------------------- 3. the media relay
say "Media relay"
if command -v nc >/dev/null 2>&1 && nc -z -w 5 "$TURN_HOST" 3478 2>/dev/null; then
  ok "coturn answering on $TURN_HOST:3478/tcp"
elif [ "$AVAIL" = "0" ] && { [ "$DP" = "502" ] || [ "$TUNNELS" = "0" ]; }; then
  # Same stopped-host reading as above, and it has to agree with it — coturn lives on that box, so
  # a farm correctly reported idle up there must not be reported broken down here.
  warn "$TURN_HOST not answering — expected, coturn is on the stopped device host"
else
  warn "could not reach $TURN_HOST:3478 while the device host is up — check coturn there"
fi

say "$([ "$FAIL" -eq 0 ] && echo 'Farm is live.' || echo 'Farm is NOT fully live — see the ✗ lines above.')"
printf '  console  %s\n' "$HOST_PUBLIC"
exit "$FAIL"
