#!/usr/bin/env bash
#
# Install the auto-deploy timer from the copy in this repo — S7, and D20's rule about units.
#
#   sudo -v && ./deploy/install-autodeploy-service.sh          # install, do not start
#   sudo -v && ./deploy/install-autodeploy-service.sh --enable # ...and start ticking
#
# CONTROL PLANE ONLY. The thing this deploys is the API image and the migrations, both of which live
# on `mfarm-cp`. A device host's checkout also needs to come forward — that is D19 and it is real —
# but bringing a worker's tree forward means restarting the agent under running sessions, which is a
# different decision with a different blast radius. `--force` exists for the day that changes; it is
# not the default, and the guard says why rather than just refusing.
#
# IDEMPOTENT and safe to re-run: it rewrites both units, reloads systemd, and leaves the enable
# state alone unless asked.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/deploy/lib/host-role.sh" 2>/dev/null || true

ENABLE=0; FORCE=0
for arg in "$@"; do
  case "$arg" in
    --enable) ENABLE=1 ;;
    --force)  FORCE=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# THE OWNER OF THE CHECKOUT, not whoever invoked sudo — `install-farm-service.sh` records at length
# why: through a nested sudo, `SUDO_USER` is the OUTER login, and a unit installed for the wrong
# account runs against a different cvd database and a different `deploy/.state`.
RUN_USER="$(stat -c '%U' "$REPO_ROOT")"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
[ -n "$RUN_HOME" ] || { echo "cannot resolve a home directory for $RUN_USER" >&2; exit 1; }

# A control plane is the box with the compose stack and the deploy state; a device host has neither.
# Checked rather than assumed, because installing this on the lab would fast-forward the tree the
# worker and the boot unit both ExecStart out of, under whatever sessions are running.
if [ ! -f "$REPO_ROOT/deploy/.state/api_key" ] && [ "$FORCE" = 0 ]; then
  cat >&2 <<MSG
This does not look like the control plane: no deploy/.state/api_key, so a tick could not read
/v1/version and would never be able to tell what is serving.

  * On mfarm-cp, run deploy/farm-up.sh first — it mints that key.
  * On a device host, this is the wrong tool: bringing the worker's tree forward restarts the agent
    under running sessions. Pass --force only if that is what you mean.
MSG
  exit 1
fi

# CREATED AND CHOWNED HERE, BEFORE THE TIMER EVER RUNS.
#
# `docker-compose.prod.yml` bind-mounts this directory into the API read-only so the deploy state
# can be scraped, and DOCKER CREATES A MISSING BIND-MOUNT SOURCE AS ROOT. On this farm that is not
# a hypothetical ordering: the compose change ships in the same commit as the deployer, so the
# first deploy after it lands creates `deploy/.state/autodeploy` owned by root — BEFORE anybody
# runs this installer.
#
# `mkdir -p` alone is not enough for exactly that reason: it succeeds silently on a directory that
# already exists and leaves the ownership wrong, which is the failure `auto-deploy.sh` then has to
# report as fatal on every tick. The chown is the line that actually fixes it, and it is
# unconditional rather than guarded on a stat, because getting it wrong is a timer that runs
# forever and records nothing.
AD_STATE="$REPO_ROOT/deploy/.state/autodeploy"
sudo mkdir -p "$AD_STATE"
sudo chown -R "$RUN_USER" "$AD_STATE"

for unit in mfarm-autodeploy.service mfarm-autodeploy.timer; do
  src="$REPO_ROOT/deploy/$unit"
  [ -f "$src" ] || { echo "missing $src" >&2; exit 1; }
  sed -e "s|__USER__|$RUN_USER|g" -e "s|__REPO__|$REPO_ROOT|g" -e "s|__HOME__|$RUN_HOME|g" \
    "$src" | sudo tee "/etc/systemd/system/$unit" >/dev/null
done
sudo systemctl daemon-reload

printf 'installed mfarm-autodeploy.{service,timer} for %s, running from %s\n' "$RUN_USER" "$REPO_ROOT"
if [ "$ENABLE" = 1 ]; then
  sudo systemctl enable --now mfarm-autodeploy.timer
  systemctl list-timers mfarm-autodeploy.timer --no-pager || true
else
  printf 'enable it with: sudo systemctl enable --now mfarm-autodeploy.timer\n'
fi
printf 'dry run:        %s/deploy/auto-deploy.sh --dry-run\n' "$REPO_ROOT"
printf 'pause it:       touch %s/deploy/.state/autodeploy/paused\n' "$REPO_ROOT"
