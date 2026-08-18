#!/usr/bin/env bash
#
# Bring the whole farm up on one host: control plane, database, devices, worker, Appium.
#
# WHY THIS EXISTS. The sequence lived only in docs/HARDWARE_DAY.html as about seven blocks of
# copy-paste, and every one of those minutes is billed — the lab VM costs roughly ₹65/hour while it
# runs. Worse, three of the steps are the kind that fail silently hours later: a database with no
# region row rejects worker registration on a foreign key that names nothing useful, an unrotated
# mfarm_app password stops the API booting with exit 78, and a device with no snapshot registers
# fine and is then never scheduled. This script does all of them in order and says which one broke.
#
# IDEMPOTENT. Re-running is the normal way to use it: it reuses the secrets, the region, the org and
# the API key it created the first time, and reconciles anything that has drifted. Nothing here
# destroys data — see deploy/README.md for teardown.
#
# WHAT IT DELIBERATELY DOES NOT DO
#   * Tailscale, TLS, and the observability stack. `tailscale serve` and
#     docker-compose.obs.yml are separate steps in deploy/README.md, because both need a decision
#     from a human (which tailnet, which receiver) rather than a default.
#   * Anything about interactive video. The browser reaches Cuttlefish's WebRTC directly, and on a
#     host the client cannot route to, that fails with a populated device list and a black screen
#     (HANDOFF.md issue 13). Automation is unaffected: it is HTTP and TCP end to end.
#
# Usage:
#   deploy/farm-up.sh                 # bring everything up
#   CF_INSTANCES=2 deploy/farm-up.sh  # …with two devices
#   deploy/farm-up.sh --no-worker     # control plane only
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/deploy"
SECRETS_DIR="$DEPLOY_DIR/secrets"
ENV_FILE="$DEPLOY_DIR/.env"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"
STATE_DIR="$DEPLOY_DIR/.state"          # gitignored alongside secrets/; holds the minted API key

CF_IMAGE_DIR="${CF_IMAGE_DIR:-$HOME/cf/image}"
CF_INSTANCES="${CF_INSTANCES:-1}"
REGION="${REGION:-lab}"
API_PORT="${API_PORT:-3000}"
WITH_WORKER=1
[ "${1:-}" = "--no-worker" ] && WITH_WORKER=0

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. preflight
#
# Every check here is a failure that costs an hour if it surfaces later instead. The apparmor one in
# particular: it kills crosvm mid-boot and NO Cuttlefish log mentions it, only dmesg does
# (HANDOFF.md issue 12).
say "Preflight"

[ "$(uname -s)" = "Linux" ] || die "Cuttlefish needs Linux; this is $(uname -s). The farm runs on the box, not on a laptop."
command -v docker >/dev/null || die "docker not found — apt-get install -y docker.io docker-compose-v2"
docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon (are you in the docker group? try: newgrp docker)"
node --version >/dev/null 2>&1 || die "node not found; the worker needs >= 22.6 for native TypeScript stripping"

if [ "$WITH_WORKER" = 1 ]; then
  [ -e /dev/kvm ] || die "/dev/kvm missing — this host cannot run Cuttlefish at all. Nested virtualisation must be enabled."
  command -v cvd >/dev/null || die "cvd not on PATH — run spikes/bootstrap_cuttlefish.sh first (that is the 1–2 hour download; this script assumes it is done)"
  [ -d "$CF_IMAGE_DIR" ] || die "CF_IMAGE_DIR=$CF_IMAGE_DIR does not exist; point it at the unpacked device image"
  userns="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)"
  [ "$userns" = "0" ] || die "kernel.apparmor_restrict_unprivileged_userns=$userns will kill crosvm with no log naming the cause. Fix: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"
  command -v appium >/dev/null || note "appium not on PATH — the worker will start without WebDriver. Install: sudo npm install -g appium && appium driver install uiautomator2"
fi
note "ok"

# ---------------------------------------------------------------- 2. secrets
#
# Generated rather than prompted for, because a farm that waits for a human to invent five passwords
# gets five bad ones. The signing key's private half never leaves this host: workers are handed only
# the public key at registration, so a compromised worker can verify session tokens and never mint
# one.
say "Secrets"
mkdir -p "$SECRETS_DIR" "$STATE_DIR" && chmod 700 "$SECRETS_DIR" "$STATE_DIR"

if [ ! -f "$SECRETS_DIR/session_signing_key.pem" ]; then
  openssl genpkey -algorithm ed25519 -out "$SECRETS_DIR/session_signing_key.pem"
  openssl pkey -in "$SECRETS_DIR/session_signing_key.pem" -pubout -out "$SECRETS_DIR/session_public_key.pem"
  note "minted a new Ed25519 signing keypair"
fi
rand() { openssl rand -base64 32 | tr -d '/+=' | head -c 40; }
for f in worker_registration_token metrics_token grafana_admin_password; do
  [ -f "$SECRETS_DIR/$f" ] || { printf '%s' "$(rand)" > "$SECRETS_DIR/$f"; note "generated $f"; }
done
chmod 600 "$SECRETS_DIR"/*

if [ ! -f "$ENV_FILE" ]; then
  cp "$DEPLOY_DIR/.env.example" "$ENV_FILE"
  # sed rather than an append: the example ships these keys empty, and a duplicate key in a compose
  # env file is resolved last-one-wins, which is a confusing way to be right.
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand)|" "$ENV_FILE"
  sed -i "s|^APP_DB_PASSWORD=.*|APP_DB_PASSWORD=$(rand)|" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  note "wrote $ENV_FILE with generated passwords"
fi
set -a; . "$ENV_FILE"; set +a
[ -n "${POSTGRES_PASSWORD:-}" ] || die "POSTGRES_PASSWORD is empty in $ENV_FILE"
[ -n "${APP_DB_PASSWORD:-}" ]   || die "APP_DB_PASSWORD is empty in $ENV_FILE"
note "ok"

# ---------------------------------------------------------------- 3. control plane
say "Control plane"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build

# The app role's password lives in two places that must agree: this .env and the database. 001_init
# creates it with a committed development password, and config.ts refuses to boot in production if
# it sees that one — so without this ALTER the API exits 78 and the compose log is the only clue.
# Run every time: it is cheap and it reconciles a .env that changed since the last run.
say "Reconciling the app role's password"
for _ in $(seq 1 30); do
  docker exec -i mfarm-postgres-1 pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1 && break
  sleep 2
done
docker exec -i mfarm-postgres-1 psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "ALTER ROLE mfarm_app WITH PASSWORD '$APP_DB_PASSWORD'" >/dev/null \
  || die "could not set the mfarm_app password"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" restart api >/dev/null
note "ok"

say "Waiting for the API"
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then note "healthy after ${i}s"; break; fi
  [ "$i" = 60 ] && die "API never became healthy. docker compose -f $COMPOSE_FILE logs api"
  sleep 1
done
curl -fsS "http://127.0.0.1:$API_PORT/ready" >/dev/null || die "/ready is failing — the API is alive but cannot reach both database pools"

# ---------------------------------------------------------------- 4. seed
#
# A migrated database has the schema and nothing usable in it: `regions` is empty and `hosts.region`
# is a foreign key into it, so worker registration fails on a constraint that names nothing; and no
# tenant key exists, so every route but the probes refuses you. Both were found by checking the
# runbook against the code rather than on a metered box.
say "Seeding"
if [ -s "$STATE_DIR/api_key" ]; then
  MFARM_API_KEY="$(cat "$STATE_DIR/api_key")"
  note "reusing the key in $STATE_DIR/api_key (a key is only ever shown once; only its hash is stored)"
else
  eval "$(DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:${POSTGRES_PORT:-5432}/$POSTGRES_DB" \
    REGION="$REGION" node "$REPO_ROOT/apps/api/scripts/seed-lab.mjs")"
  [ -n "${MFARM_API_KEY:-}" ] || die "seed-lab.mjs produced no API key"
  printf '%s' "$MFARM_API_KEY" > "$STATE_DIR/api_key"; chmod 600 "$STATE_DIR/api_key"
  note "minted a tenant API key into $STATE_DIR/api_key"
fi

if [ "$WITH_WORKER" = 0 ]; then
  say "Control plane is up (--no-worker)"
  note "export MFARM_API_KEY=\$(cat $STATE_DIR/api_key)"
  exit 0
fi

# ---------------------------------------------------------------- 5. worker + devices
#
# In tmux, not in this shell. A dropped SSH tab kills a foreground process and takes the devices
# with it, and on a browser-based cloud console that happens more or less whenever it feels like it.
#
# The worker boots the devices itself, and start() picks the cheapest correct route: adopt a running
# device (0s), restore a stopped one from its snapshot (8s), or cold boot (38s, first time only,
# after which it takes the golden snapshot the other two rungs depend on).
say "Worker"
command -v tmux >/dev/null || die "tmux not found — apt-get install -y tmux. Running the worker in a foreground SSH shell loses the devices when the tab drops."

if tmux has-session -t mfarm-worker 2>/dev/null; then
  note "session 'mfarm-worker' already running — leaving it alone (tmux kill-session -t mfarm-worker to replace it)"
else
  tmux new-session -d -s mfarm-worker -c "$REPO_ROOT" \
    "env CONTROL_PLANE_URL=http://127.0.0.1:$API_PORT \
        WORKER_REGISTRATION_TOKEN='$(cat "$SECRETS_DIR/worker_registration_token")' \
        REGION='$REGION' \
        PUBLIC_ENDPOINT=ws://127.0.0.1:8080 \
        PUBLIC_HOST=127.0.0.1 \
        BIND_HOST=127.0.0.1 \
        APPIUM_ENABLED=1 \
        APPIUM_ADVERTISE_HOST=127.0.0.1 \
        CF_IMAGE_DIR='$CF_IMAGE_DIR' \
        CF_INSTANCES='$CF_INSTANCES' \
        node --experimental-strip-types workers/agent/src/index.ts 2>&1 | tee -a /tmp/mfarm-worker.log"
  note "started in tmux session 'mfarm-worker' (tmux attach -t mfarm-worker), logging to /tmp/mfarm-worker.log"
fi

# ---------------------------------------------------------------- 6. verify
#
# First boot cold boots and then snapshots ~4 GB, so allow real time before concluding anything.
say "Waiting for devices to register"
for i in $(seq 1 600); do
  devices="$(curl -fsS -H "Authorization: Bearer $MFARM_API_KEY" "http://127.0.0.1:$API_PORT/v1/devices" 2>/dev/null || echo '')"
  count="$(printf '%s' "$devices" | grep -o '"localId"' | wc -l | tr -d ' ')"
  if [ "$count" -ge "$CF_INSTANCES" ]; then note "$count device(s) registered after ${i}s"; break; fi
  if [ "$i" = 600 ]; then
    printf '\n\033[31mNo devices after 10 minutes.\033[0m Diagnose in this order:\n' >&2
    printf '  1. tail /tmp/mfarm-worker.log        — did the agent even choose the Cuttlefish tier?\n' >&2
    printf '  2. pgrep crosvm                      — ABSENT means the VM never existed; go to dmesg, NOT to the cuttlefish logs\n' >&2
    printf '  3. sudo dmesg | grep -i apparmor     — the one place the userns denial appears\n' >&2
    printf '  4. cvd fleet                         — "Starting" forever is the same symptom\n' >&2
    exit 1
  fi
  sleep 1
done

say "Farm is up"
printf '  devices     curl -s -H "Authorization: Bearer $MFARM_API_KEY" http://127.0.0.1:%s/v1/devices\n' "$API_PORT"
printf '  metrics     curl -s -H "Authorization: Bearer $(cat %s/metrics_token)" http://127.0.0.1:%s/metrics | grep ^mfarm_devices\n' "$SECRETS_DIR" "${METRICS_PORT:-9464}"
printf '  worker      tmux attach -t mfarm-worker\n'
printf '  api key     export MFARM_API_KEY=$(cat %s/api_key)\n' "$STATE_DIR"
printf '\n'
printf '  A device that registered but never becomes allocatable has no snapshot — check the worker\n'
printf '  log for "device will not be schedulable". snapshot-reset is required for tenant use, and it\n'
printf '  is advertised only once a snapshot actually exists.\n'
