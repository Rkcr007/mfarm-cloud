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

# The docker bridge address, which is what the containerised control plane can reach on this host.
# Same value farm-up.sh computes; kept in one place here so the unit and the script cannot drift.
BRIDGE_IP="$(docker network inspect "$(docker network ls --filter name=mfarm --format '{{.Name}}' | head -1)" \
  --format '{{ (index .IPAM.Config 0).Gateway }}' 2>/dev/null || echo 172.18.0.1)"
CF_IMAGE_DIR="${CF_IMAGE_DIR:-$HOME/cf/image}"
# The same default farm-up.sh uses, and it must stay the same: `~/android-sdk` does not exist on the
# lab box, and an agent started with a bogus ANDROID_HOME advertises `webdriver` and then fails every
# Appium session with a driver that cannot find adb.
ANDROID_HOME_RESOLVED="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/lib/android-sdk}}"
CF_INSTANCES="${CF_INSTANCES:-2}"
REGION="${REGION:-lab}"
API_PORT="${API_PORT:-3000}"

say "Writing $ENV_FILE"
umask 077
cat > "$ENV_FILE" <<ENV
CONTROL_PLANE_URL=http://127.0.0.1:$API_PORT
WORKER_REGISTRATION_TOKEN=$(cat "$SECRETS_DIR/worker_registration_token")
REGION=$REGION
PUBLIC_ENDPOINT=ws://$BRIDGE_IP:8080
PUBLIC_HOST=$BRIDGE_IP
BIND_HOST=$BRIDGE_IP
APPIUM_ENABLED=1
APPIUM_ADVERTISE_HOST=$BRIDGE_IP
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
