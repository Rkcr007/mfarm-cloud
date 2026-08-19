#!/usr/bin/env bash
#
# Move the worker agent from a tmux window into systemd.
#
# Run once per box. Captures the environment `farm-up.sh` would have exported into tmux, writes it
# where the unit can read it, and hands supervision to the machine — so the agent survives a reboot,
# a dropped ssh session, and whoever started it going home.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# TWO DIRECTORIES, AND THEY ARE NOT INTERCHANGEABLE — farm-up.sh splits them deliberately:
# `secrets/` holds material compose bind-mounts into containers (the signing keypair, the worker
# registration token), `.state/` holds what the operator needs afterwards (the minted API key, the
# console password). Reading the token from the wrong one fails at install time with a message that
# sends you to farm-up.sh for a file that is already there.
SECRETS_DIR="$REPO_ROOT/deploy/secrets"
STATE_DIR="$REPO_ROOT/deploy/.state"
ENV_FILE="$STATE_DIR/worker.env"
UNIT_SRC="$REPO_ROOT/deploy/mfarm-worker.service"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ -r "$SECRETS_DIR/worker_registration_token" ] || die "no $SECRETS_DIR/worker_registration_token — run deploy/farm-up.sh first"

# WHERE THIS WORKER BINDS, AND IT IS NO LONGER THE DOCKER BRIDGE.
#
# It used to bind 172.18.0.1 so a control plane in a container on THIS machine could reach it. That
# address is host-local by construction, so it only ever worked while both halves shared a box — and
# it is why ADR-0005 lists "the data plane moves off the docker bridge" as unfinished business.
#
# With the control plane on its own host, the worker binds this machine's INTERNAL VPC ADDRESS: the
# hub reaches it over the private network, and nothing it serves is exposed to the internet (this
# host has no ingress rule at all — `mfarm-web` lives on the control plane). Authorization is
# unchanged and still does the real work: every request the hub sends carries the Ed25519 grant the
# worker verifies offline (ADR-0004). The network is a route, never a permission.
BIND_HOST="${BIND_HOST:-$(hostname -I | awk '{print $1}')}"
[ -n "$BIND_HOST" ] || die "could not determine this host's address; set BIND_HOST"

# The control plane is somewhere else now, so this is not optional and has no sensible default. Its
# public URL is the right answer even from inside the same VPC: it is the one endpoint that is
# TLS-terminated, and a worker that can only reach the control plane privately is a worker that
# cannot move.
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:?set CONTROL_PLANE_URL, e.g. https://34-100-138-213.sslip.io}"

CF_IMAGE_DIR="${CF_IMAGE_DIR:-$HOME/cf/image}"
# The same default farm-up.sh uses, and it must stay the same: `~/android-sdk` does not exist on the
# lab box, and an agent started with a bogus ANDROID_HOME advertises `webdriver` and then fails every
# Appium session with a driver that cannot find adb.
ANDROID_HOME_RESOLVED="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/lib/android-sdk}}"
CF_INSTANCES="${CF_INSTANCES:-2}"
REGION="${REGION:-lab}"

say "Writing $ENV_FILE"
umask 077
cat > "$ENV_FILE" <<ENV
CONTROL_PLANE_URL=$CONTROL_PLANE_URL
WORKER_REGISTRATION_TOKEN=$(cat "$SECRETS_DIR/worker_registration_token")
REGION=$REGION
PUBLIC_ENDPOINT=ws://$BIND_HOST:8080
PUBLIC_HOST=$BIND_HOST
BIND_HOST=$BIND_HOST
APPIUM_ENABLED=1
APPIUM_ADVERTISE_HOST=$BIND_HOST
ANDROID_HOME=$ANDROID_HOME_RESOLVED
ANDROID_SDK_ROOT=$ANDROID_HOME_RESOLVED
CF_IMAGE_DIR=$CF_IMAGE_DIR
CF_INSTANCES=$CF_INSTANCES
ENV
chmod 600 "$ENV_FILE"

say "Installing the unit"
sudo cp "$UNIT_SRC" /etc/systemd/system/mfarm-worker.service
sudo systemctl daemon-reload
sudo systemctl enable mfarm-worker

# A tmux worker left running would fight this one for the same devices and the same ports.
if tmux has-session -t mfarm-worker 2>/dev/null; then
  say "Stopping the tmux worker it replaces"
  tmux kill-session -t mfarm-worker
fi

say "Starting"
sudo systemctl restart mfarm-worker
sleep 5
systemctl is-active --quiet mfarm-worker || die "did not start: journalctl -u mfarm-worker -n 50"

printf '\n  installed. Follow it with: journalctl -u mfarm-worker -f\n'
