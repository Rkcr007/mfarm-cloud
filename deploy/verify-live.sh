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

# 426 is the data plane's own "websocket only" answer, which is the proof that Caddy reaches the
# WORKER over the VPC. Anything else means the live view has no route, however healthy it looks.
DP="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$HOST_PUBLIC/dp/probe" 2>/dev/null)"

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
  # A STOPPED DEVICE HOST IS A NORMAL STATE, NOT A FAILURE. It is off between sessions by design and
  # it is 95% of the bill. Reported as a note so that `farm-check.sh` after starting only the control
  # plane does not print a wall of red for a farm that is behaving exactly as intended.
  #
  # The two symptoms together are what identify it: no devices AND /dp with no upstream. Either one
  # alone means something else — devices without /dp is a routing problem, /dp without devices is a
  # worker that is up but has no hardware.
  if [ "$AVAIL" -eq 0 ] && [ "$DP" = "502" ]; then
    warn "the device host looks STOPPED — no devices, and /dp has no upstream"
    warn "that is the normal idle state; start it with ./deploy/farm-online.sh"
  else
    if [ "$DP" = "426" ]; then
      ok "/dp reaches the device host's data plane (426 = websocket only)"
    else
      bad "/dp answered $DP, not 426 — the live view has no route to the worker"
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
elif [ "$AVAIL" = "0" ] && [ "$DP" = "502" ]; then
  warn "$TURN_HOST not answering — expected, coturn is on the stopped device host"
else
  warn "could not reach $TURN_HOST:3478 while the device host is up — check coturn there"
fi

say "$([ "$FAIL" -eq 0 ] && echo 'Farm is live.' || echo 'Farm is NOT fully live — see the ✗ lines above.')"
printf '  console  %s\n' "$HOST_PUBLIC"
exit "$FAIL"
