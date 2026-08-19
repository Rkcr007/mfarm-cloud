#!/usr/bin/env bash
#
# Bring the whole farm back online, from your laptop.
#
#   ./deploy/farm-online.sh
#
# Then check it with ./deploy/farm-check.sh.
#
# WHY THIS IS A SCRIPT AND NOT `gcloud compute instances start`. Everything on both boxes already
# restarts itself — docker's `unless-stopped`, and systemd units for the worker, Caddy and coturn —
# so starting the VMs really is enough for the console and the devices.
#
# The one thing that is NOT self-healing is the media relay's address. The device host's public IP is
# EPHEMERAL: it changes on every stop/start, and coturn advertises it to browsers while the control
# plane hands out `turn:<that address>` in every session's ICE block. After a restart both are
# pointing at an address that now belongs to somebody else, and the failure is silent in the worst
# way — the console works, the device list is right, sessions start, and video simply never arrives,
# with an empty relay log because nobody ever called. This reconciles it.
#
# (The CONSOLE's address is reserved — `mfarm-lab-ip`, 34.100.138.213 — so its URL and certificate
# survive a stop. Reserving one for the device host too would make this script unnecessary; it costs
# about ₹250/month and is the better answer if this stop/start becomes routine.)
set -uo pipefail

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

say "Reconciling the media relay's address"
LAB_IP="$(g instances describe "$LAB" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
[ -n "$LAB_IP" ] || die "could not read $LAB's external IP"
note "device host is now $LAB_IP"

CURRENT="$(onbox "$CP" "grep -m1 '^TURN_URLS=' ~/mfarm/deploy/.env 2>/dev/null | sed 's/^TURN_URLS=//'")"
if printf '%s' "$CURRENT" | grep -q "$LAB_IP"; then
  note "control plane already points at $LAB_IP — nothing to do"
else
  note "control plane still points at: ${CURRENT:-<unset>}"
  note "re-pointing coturn and the control plane at $LAB_IP"

  # coturn advertises the address, so it is rewritten first. The secret on disk is reused, which is
  # what keeps the credential the control plane mints verifiable.
  onbox "$LAB" "cd ~/mfarm && PUBLIC_IP=$LAB_IP bash deploy/setup-turn.sh >/dev/null 2>&1 && echo ok" \
    | grep -q ok && note "coturn rewritten on $LAB" || note "WARNING: setup-turn.sh did not report success"

  onbox "$CP" "cd ~/mfarm && sed -i 's|^TURN_URLS=.*|TURN_URLS=turn:$LAB_IP:3478,turn:$LAB_IP:3478?transport=tcp|' deploy/.env && docker compose -f deploy/docker-compose.prod.yml up -d api >/dev/null 2>&1 && echo ok" \
    | grep -q ok && note "control plane restarted with the new relay address" || note "WARNING: could not update the control plane"
fi

say "Online"
note "The devices cold boot from here, which takes a few minutes."
note "Check with: ./deploy/farm-check.sh"
