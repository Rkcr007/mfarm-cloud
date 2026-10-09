#!/usr/bin/env bash
#
# Bring the whole farm back online, from your laptop.
#
#   ./deploy/farm-online.sh
#
# Then check it with ./deploy/farm-check.sh.
#
# WHY THIS IS A SCRIPT AND NOT `gcloud compute instances start`. Mostly it now IS just that:
# everything on both boxes restarts itself — docker's `unless-stopped`, and systemd units for the
# worker, Caddy and coturn — and BOTH public addresses are reserved, so nothing moves any more.
#
# It stayed a script for two reasons. It waits for SSH before claiming success, and it VERIFIES that
# the addresses are still what the configuration says.
#
# That check earns its place because of what used to happen here. The device host's IP was ephemeral;
# coturn advertised it to browsers while the control plane handed out `turn:<that address>` in every
# session's ICE block, so after a restart both pointed at an address that belonged to somebody else.
# The failure was silent in the worst way — console fine, device list right, sessions starting, and
# video simply never arriving, with an empty relay log because nobody ever called it. Reserving
# `mfarm-ip` for the device host removed the cause; this check is what would catch it coming back
# (an address released by hand, a VM recreated, a quota event) instead of leaving someone to
# rediscover it from a black rectangle.
set -uo pipefail

# The farm's two public names, from one place.
FARM_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/farm.env"
# shellcheck disable=SC1090
[ -f "$FARM_ENV" ] && . "$FARM_ENV"

PROJECT="${MFARM_PROJECT:-mfarm-lab}"
ZONE="${MFARM_ZONE:-asia-south1-c}"
SSH_USER="${MFARM_SSH_USER:-rkcr070707}"
CP="${MFARM_CP:-mfarm-cp}"
# THE DEVICE HOSTS, PLURAL (S7.2). Space-separated; `MFARM_LAB` still names one, so nothing that
# already calls this script changes. See `docs/SECOND_HOST.md`.
LABS="${MFARM_LABS:-${MFARM_LAB:-mfarm-lab}}"

# WHICH machine publishes `MFARM_TURN_HOST`: the CONTROL PLANE, since 2026-10-03 (ADR-0047).
#
# coturn is a RELAY, not a device service: a browser watching a device on any host is perfectly happy
# relaying through a coturn somewhere else. It used to run on the first device host, and was down
# whenever that host was — while a phone, streaming from somebody's laptop, needed it with no device
# host running at all (D67). `MFARM_RELAY_HOST` names another machine; `MFARM_RELAY_LAB`, its old
# name from when the answer was always a device host, still works.
RELAY_HOST="${MFARM_RELAY_HOST:-${MFARM_RELAY_LAB:-$CP}}"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

g()   { gcloud compute "$@" --project "$PROJECT"; }
# THROUGH THE IAP TUNNEL, ALWAYS (ADR-0049). Without the flag gcloud dials the machine's public
# address on port 22, which works only while the project's firewall opens SSH to the whole internet.
# The tunnel is what lets that rule admit Google's IAP range (35.235.240.0/20) and nobody else. Once
# it does, a call that forgets the flag does not fail with a message: it hangs until SSH times out,
# and the loop below reports a healthy machine as one that "never answered SSH".
onbox() { gcloud compute ssh "$SSH_USER@$1" --project "$PROJECT" --zone "$ZONE" --tunnel-through-iap --command "$2" 2>/dev/null; }

say "Starting the control plane and $(set -- $LABS; echo $#) device host(s)"
# Started together on purpose: the worker registers with the control plane over its PUBLIC url, so a
# device host that comes up first spends its first minute failing to register. Neither ordering is
# harmful — the agent retries — but this is the one that produces a clean log.
#
# `$LABS` is deliberately unquoted: it is a list and must word-split into separate arguments.
# shellcheck disable=SC2086
g instances start "$CP" $LABS --zone "$ZONE" 2>&1 | tail -2

say "Waiting for SSH on all of them"
# shellcheck disable=SC2086
for host in "$CP" $LABS; do
  for _ in $(seq 1 40); do
    onbox "$host" true >/dev/null 2>&1 && break
    sleep 10
  done
  onbox "$host" true >/dev/null 2>&1 && note "$host up" || die "$host never answered SSH"
done

say "Checking the public addresses are still what the configuration says"
RELAY_IP="$(g instances describe "$RELAY_HOST" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
CP_IP="$(g instances describe "$CP" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"

# BOTH NAMES IN farm.env ARE NOW DOMAINS, so the comparison has to go through DNS.
#
# This check was broken from 2026-08-20 — the day `mfarm.dev` landed — until 2026-09-01. It compared
# the VM's address to `$MFARM_TURN_HOST` directly, which was an IP literal under sslip.io and became
# `turn.mfarm.dev` when the domain did. An IP is never string-equal to a hostname, so BOTH branches
# went to DRIFT on every single start, with both addresses perfectly correct.
#
# That is worse than having no check. A warning that fires every time is one people learn to scroll
# past, so the run where an address genuinely moved would have looked exactly like the twelve days
# before it. Same shape as the invariant in docs/INDEX.md §7: a check that cannot come out both ways
# cannot detect anything.
#
# Resolution failure is reported as its own outcome rather than folded into DRIFT. "DNS is not
# answering" and "the address moved" need different actions, and collapsing them would send someone
# to re-reserve an address when their resolver is the thing that is down.
resolve() {
  # An IP literal resolves to itself, so farm.env can go back to a bare address without this
  # breaking again.
  case "$1" in
    *[!0-9.]*) ;;
    *) printf '%s' "$1"; return 0 ;;
  esac
  dig +short "$1" 2>/dev/null | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -1
}

DRIFT=0
check_address() {
  local what="$1" name="$2" actual="$3" want
  want="$(resolve "$name")"
  if [ -z "$want" ]; then
    note "UNRESOLVED: $what is $actual; could not resolve $name to compare (DNS problem, not drift)"
    return
  fi
  if [ "$actual" = "$want" ]; then
    note "$what is $actual, matching $name"
  else
    note "DRIFT: $what is $actual but $name resolves to $want"
    DRIFT=1
  fi
}

# ONLY THE RELAY HOST IS CHECKED AGAINST `MFARM_TURN_HOST`. A device host has no reserved address
# of its own any more and publishes nothing, so comparing its ephemeral IP to the relay's name would
# report DRIFT on every start — which is precisely the always-on warning this check was rewritten to
# stop being. See the twelve-day note above.
check_address "relay host ($RELAY_HOST)" "$MFARM_TURN_HOST" "$RELAY_IP"
# The console's address is load-bearing twice over: the name resolves to it, and the Let's Encrypt
# certificate was issued for that name. If this drifts, the URL and the cert die together and no
# amount of restarting fixes it.
check_address "control plane" "$MFARM_PUBLIC_HOST" "$CP_IP"

if [ "$DRIFT" -eq 1 ]; then
  printf '\n\033[33m  An address moved. Both are supposed to be reserved:\n'
  printf '    gcloud compute addresses list --project %s\n' "$PROJECT"
  printf '  Re-attach it, or update deploy/farm.env and re-run deploy/setup-turn.sh and\n'
  printf '  deploy/setup-ingress.sh on the control plane.\033[0m\n'
fi

say "Online"
note "The devices cold boot from here, which takes a few minutes."
note "Check with: ./deploy/farm-check.sh"
