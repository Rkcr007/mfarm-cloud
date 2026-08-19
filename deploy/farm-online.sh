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
LAB="${MFARM_LAB:-mfarm-lab}"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

g()   { gcloud compute "$@" --project "$PROJECT"; }
onbox() { gcloud compute ssh "$SSH_USER@$1" --project "$PROJECT" --zone "$ZONE" --command "$2" 2>/dev/null; }

say "Starting both machines"
# Started together on purpose: the worker registers with the control plane over its PUBLIC url, so a
# device host that comes up first spends its first minute failing to register. Neither ordering is
# harmful — the agent retries — but this is the one that produces a clean log.
g instances start "$CP" "$LAB" --zone "$ZONE" 2>&1 | tail -2

say "Waiting for SSH on both"
for host in "$CP" "$LAB"; do
  for _ in $(seq 1 40); do
    onbox "$host" true >/dev/null 2>&1 && break
    sleep 10
  done
  onbox "$host" true >/dev/null 2>&1 && note "$host up" || die "$host never answered SSH"
done

say "Checking the public addresses are still what the configuration says"
LAB_IP="$(g instances describe "$LAB" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
CP_IP="$(g instances describe "$CP" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"

DRIFT=0
if [ "$LAB_IP" = "$MFARM_TURN_HOST" ]; then
  note "device host is $LAB_IP, as configured"
else
  note "DRIFT: device host is $LAB_IP but deploy/farm.env says $MFARM_TURN_HOST"
  DRIFT=1
fi

# The console's address is load-bearing twice over: the sslip.io hostname encodes it, and the
# Let's Encrypt certificate was issued for that hostname. If this ever drifts, the URL and the cert
# die together and no amount of restarting fixes it.
if printf '%s' "$MFARM_PUBLIC_HOST" | grep -q "$(printf '%s' "$CP_IP" | tr '.' '-')" || [ "$CP_IP" = "$MFARM_PUBLIC_HOST" ]; then
  note "control plane is $CP_IP, matching $MFARM_PUBLIC_HOST"
else
  note "DRIFT: control plane is $CP_IP but the console name is $MFARM_PUBLIC_HOST"
  DRIFT=1
fi

if [ "$DRIFT" -eq 1 ]; then
  printf '\n\033[33m  An address moved. Both are supposed to be reserved:\n'
  printf '    gcloud compute addresses list --project %s\n' "$PROJECT"
  printf '  Re-attach it, or update deploy/farm.env and re-run deploy/setup-turn.sh on the\n'
  printf '  device host and deploy/setup-ingress.sh on the control plane.\033[0m\n'
fi

say "Online"
note "The devices cold boot from here, which takes a few minutes."
note "Check with: ./deploy/farm-check.sh"
