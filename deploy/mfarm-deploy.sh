#!/usr/bin/env bash
#
# Put a specific commit into service, and prove it landed.
#
#   deploy/mfarm-deploy.sh <sha>        # deploy that commit's image
#   deploy/mfarm-deploy.sh latest       # whatever Release published last
#   deploy/mfarm-deploy.sh <sha> --worker   # ...and restart the worker agent onto it too
#
# Runs ON THE BOX. One argument, because a deploy that takes a page of flags is a deploy nobody
# repeats the same way twice.
#
# WHAT THIS REPLACES. Deploying used to mean: get source onto the box somehow, `docker compose
# build`, hope. Nothing recorded which commit was serving, so the only way to answer "is the fix
# live?" was to read a git log over ssh — which is why, in practice, nobody asked. This script names
# a commit, moves only what that commit changes, and then ASKS THE RUNNING API what it is. The last
# step is the one that matters: every deployment mechanism that has ever bitten this project bit it
# by succeeding quietly while changing nothing.
#
# It is deliberately not a rollback-aware, multi-environment tool. There is one box, one
# environment, and rollback is this same command with an older sha — which works because images are
# tagged by commit and never mutated. Migrations do NOT roll back; a schema change that has to be
# undone needs a new migration that undoes it, and rolling code back past a migration it depends on
# is a decision, not a command.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$REPO_ROOT/deploy/docker-compose.prod.yml"
IMAGE_REPO="${MFARM_IMAGE_REPO:-ghcr.io/rkcr007/mfarm-api}"
API_PORT="${API_PORT:-3000}"
STATE_DIR="$REPO_ROOT/deploy/.state"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die()  { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ $# -ge 1 ] || die "usage: $0 <sha|latest> [--worker]"
VERSION="$1"; shift
WORKER=0
for arg in "$@"; do
  case "$arg" in
    --worker) WORKER=1 ;;
    *) die "unknown argument: $arg" ;;
  esac
done

# ---------------------------------------------------------------- 1. the artifact
#
# Pull first, build second. The pull is the intended path — one image, built once by CI from the
# commit its tests ran against — and the local build is the fallback for a box that has no registry
# credential yet. The fallback is NOT silent: an image built here is not the artifact CI tested, and
# saying so is the difference between a fallback and a lie.
# WHATEVER YOU TYPED, RESOLVED TO A FULL SHA FIRST.
#
# CI tags images with `workflow_run.head_sha`, which is 40 characters. A human reads a short sha —
# it is what `git log --oneline` prints and what the console badge shows — so `mfarm-deploy.sh
# c7ab2e1` asked the registry for a tag that does not exist and silently fell through to a local
# build. Correct output, wrong path, and the failure mode is invisible: you get the code you asked
# for, built here, and never learn the registry was never consulted.
#
# Resolving through git also means a branch name or `HEAD` works, and that the commit is one this
# box actually has.
if [ "$VERSION" != latest ]; then
  git -C "$REPO_ROOT" fetch --quiet origin || true
  FULL_SHA="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "${VERSION}^{commit}" || true)"
  [ -n "$FULL_SHA" ] || die "no such commit here: $VERSION (try: git -C $REPO_ROOT fetch origin)"
  [ "$FULL_SHA" = "$VERSION" ] || note "resolved $VERSION -> $FULL_SHA"
  VERSION="$FULL_SHA"
fi

say "Resolving $IMAGE_REPO:$VERSION"
if docker pull "$IMAGE_REPO:$VERSION" >/dev/null 2>&1; then
  IMAGE="$IMAGE_REPO:$VERSION"
  note "pulled from the registry"
else
  [ "$VERSION" = latest ] && die "cannot build 'latest' — it names no commit. Pass a sha, or run: docker login ghcr.io"
  note "registry pull failed — building $VERSION here instead (NOT the image CI tested)"
  note "if you expected a pull: docker login ghcr.io -u rkcr007   (a read:packages token)"
  # A detached checkout, deliberately: the working tree becomes exactly the commit being deployed,
  # so what is built cannot include a stray local edit.
  git -C "$REPO_ROOT" checkout --quiet --detach "$VERSION"
  IMAGE="$IMAGE_REPO:$VERSION"
  docker build -f "$REPO_ROOT/apps/api/Dockerfile" -t "$IMAGE" \
    --build-arg "GIT_SHA=$VERSION" \
    --build-arg "BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$REPO_ROOT"
fi

# The compose file reads MFARM_IMAGE; recording it here is what makes an unrelated `docker compose
# up` later keep serving the version that was deployed rather than quietly resurrecting an older one.
mkdir -p "$STATE_DIR"
printf '%s\n' "$IMAGE" > "$STATE_DIR/deployed_image"

# ---------------------------------------------------------------- 2. schema, then code
#
# In that order, and as separate steps, because they fail differently. `migrate` is `restart: "no"`
# in the compose file: a half-applied migration must stay failed and visible rather than being
# retried by a supervisor into something worse. If it fails here, the API is never restarted and the
# old code keeps serving the old schema — which is the correct outcome and the reason for `set -e`.
say "Applying migrations"
MFARM_IMAGE="$IMAGE" docker compose -f "$COMPOSE" run --rm migrate

# Only the api service. Postgres keeps its connections, the backup sidecar keeps its schedule, and
# the worker — which is not in this compose file at all — keeps its devices booted. That is the
# whole point of deploying one service rather than "the stack".
say "Restarting the API onto $IMAGE"
MFARM_IMAGE="$IMAGE" docker compose -f "$COMPOSE" up -d --no-deps api

# ---------------------------------------------------------------- 3. proof
#
# Ask the process what it is. A deploy that reports success because a command exited zero has
# checked that docker accepted an instruction, not that anything changed.
say "Verifying"
KEY_FILE="$STATE_DIR/api_key"
[ -r "$KEY_FILE" ] || die "no $KEY_FILE — cannot verify what is running. Deploy is UNCONFIRMED."

for i in $(seq 1 30); do
  RUNNING="$(curl -fsS -H "Authorization: Bearer $(cat "$KEY_FILE")" \
    "http://127.0.0.1:$API_PORT/v1/version" 2>/dev/null || true)"
  [ -n "$RUNNING" ] && break
  sleep 2
done
[ -n "$RUNNING" ] || die "the API did not answer /v1/version within 60s. Check: docker compose -f $COMPOSE logs api"

RUNNING_SHA="$(printf '%s' "$RUNNING" | sed -n 's/.*"sha":"\([^"]*\)".*/\1/p')"
note "running: $RUNNING"
if [ "$VERSION" != latest ] && [ "$RUNNING_SHA" != "$VERSION" ]; then
  die "asked for $VERSION, serving $RUNNING_SHA — the restart did not take."
fi

# ---------------------------------------------------------------- 4. the worker, if asked
#
# Separate on purpose. The worker is not a container: it needs /dev/kvm, cvd, adb and the host's own
# network, so it runs on the host under systemd. Restarting it is cheap in a way that is easy to
# disbelieve — `bringUp()` ADOPTS already-running cvd groups in about 0.1s, so a worker deploy does
# not reboot a single device.
if [ "$WORKER" = 1 ]; then
  say "Restarting the worker agent"
  if systemctl is-enabled --quiet mfarm-worker 2>/dev/null; then
    sudo systemctl restart mfarm-worker
    sleep 5
    systemctl is-active --quiet mfarm-worker \
      || die "mfarm-worker did not come back: journalctl -u mfarm-worker -n 50"
    note "systemd unit restarted; follow it with: journalctl -u mfarm-worker -f"
  else
    die "mfarm-worker is not installed as a service. Run deploy/install-worker-service.sh first."
  fi
fi

say "Deployed $VERSION"
note "console: whatever hostname Caddy serves; the build badge in the header should read ${VERSION:0:7}"
