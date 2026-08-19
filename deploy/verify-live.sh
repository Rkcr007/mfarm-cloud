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
HOST_PUBLIC="${HOST_PUBLIC:-https://34-100-138-213.sslip.io}"
API="${API:-http://127.0.0.1:3000}"
TURN_HOST="${TURN_HOST:-8.231.85.232}"
DEVICE_WAIT_SECONDS="${DEVICE_WAIT_SECONDS:-600}"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

FAIL=0

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
if [ "$DP" = "426" ]; then
  ok "/dp reaches the device host's data plane (426 = websocket only)"
else
  bad "/dp answered $DP, not 426 — the live view has no route to the worker"
  FAIL=1
fi

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
  if [ "$AVAIL" -ge 2 ]; then
    ok "$AVAIL devices READY"
  elif [ "$AVAIL" -ge 1 ]; then
    warn "only $AVAIL device READY — the other may still be booting (journalctl -u mfarm-worker -f on mfarm-lab)"
  else
    bad "no devices READY after ${DEVICE_WAIT_SECONDS}s"
    FAIL=1
  fi

  # The live view needs `screen-stream`; the install path needs `app-install`. Reporting the
  # capability list is what turns "the device is up" into "the device can do the thing you want".
  printf '%s' "$BODY" | grep -q 'screen-stream' && ok "devices declare screen-stream (live view available)" \
    || warn "no device declares screen-stream — no live view"
fi

# ---------------------------------------------------------------- 3. the media relay
say "Media relay"
if command -v nc >/dev/null 2>&1 && nc -z -w 5 "$TURN_HOST" 3478 2>/dev/null; then
  ok "coturn answering on $TURN_HOST:3478/tcp"
else
  warn "could not reach $TURN_HOST:3478 from here — note the device host's PUBLIC IP is ephemeral"
  warn "if it changed, update TURN_URLS in deploy/.env and re-run deploy/setup-turn.sh on mfarm-lab"
fi

say "$([ "$FAIL" -eq 0 ] && echo 'Farm is live.' || echo 'Farm is NOT fully live — see the ✗ lines above.')"
printf '  console  %s\n' "$HOST_PUBLIC"
exit "$FAIL"
