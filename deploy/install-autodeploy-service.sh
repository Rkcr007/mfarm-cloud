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
# SOURCED AND ACTUALLY USED. The first version of this file sourced it and then invented its
# own test instead of calling it — see the guard below for what that cost. The `|| true` is
# gone too: a missing host-role.sh must fail loudly, not silently disable the guard.
. "$REPO_ROOT/deploy/lib/host-role.sh"

ENABLE=0; FORCE=0
for arg in "$@"; do
  case "$arg" in
    --enable) ENABLE=1 ;;
    --force)  FORCE=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# IS THIS A DEVICE HOST? Asked of `mfarm_is_device_host`, which is the repo's one answer to that
# question — /dev/kvm present AND a CONTROL_PLANE_URL pointing somewhere other than this machine.
#
# THE FIRST VERSION OF THIS GUARD ASKED SOMETHING ELSE AND WAS WRONG. It tested for
# `deploy/.state/api_key`, on the premise that only a control plane has deploy state. `mfarm-lab`
# has had that file since 2026-08-18. Run on the lab, the guard passed and the installer cheerfully
# wrote both units onto the device host — the exact machine whose tree must not be fast-forwarded
# under running sessions, and the exact failure family `docs/DEFECTS.md` records six of: a control
# whose premise is false in the state it is offered in.
#
# It was caught by RUNNING IT ON THE LAB, not by reading it. No unit test knows what files that box
# happens to have.
# The kvm path is overridable ONLY so a test can drive this branch. `mfarm_is_device_host` needs
# /dev/kvm to exist, which it does not on a developer's machine or a CI runner — so without a seam
# the one branch that matters here is unreachable by any test, which is how it shipped wrong in the
# first place. Production never sets this and gets /dev/kvm.
if mfarm_is_device_host "$REPO_ROOT/deploy" "${MFARM_KVM_PATH:-/dev/kvm}" && [ "$FORCE" = 0 ]; then
  cat >&2 <<MSG
This is a DEVICE HOST: /dev/kvm is present and CONTROL_PLANE_URL points at another machine.

The auto-deployer fast-forwards the checkout it runs from, and on this box the worker and the boot
unit both ExecStart out of that tree — so a tick would move the agent's code under whatever sessions
are running. That is a different decision with a different blast radius, and it is not this tool's.

Bring a device host forward by hand instead:
  git -C "$REPO_ROOT" fetch origin main && git -C "$REPO_ROOT" merge --ff-only origin/main
  sudo systemctl restart mfarm-worker

Pass --force only if you have decided you want a timer doing that unattended.
MSG
  exit 1
fi

# A tick reads `/v1/version` to learn what is serving, and cannot without this key. Kept as a
# SEPARATE check because it answers a different question: the one above is "is this the wrong kind
# of box", this one is "is this box set up yet". Collapsing them is what produced the bug.
if [ ! -f "$REPO_ROOT/deploy/.state/api_key" ] && [ "$FORCE" = 0 ]; then
  echo "No deploy/.state/api_key — a tick could not read /v1/version. Run deploy/farm-up.sh first." >&2
  exit 1
fi

# THE OWNER OF THE CHECKOUT, not whoever invoked sudo — `install-farm-service.sh` records at length
# why: through a nested sudo, `SUDO_USER` is the OUTER login, and a unit installed for the wrong
# account runs against a different cvd database and a different `deploy/.state`.
#
# RESOLVED AFTER THE GUARDS, not before. `stat -c` is GNU-only, so on any other platform this line
# fails — and when it came first, the device-host refusal could never be reached there. A guard
# that only works on the machines it was going to work on anyway is not a guard, and the test for
# it could not run at all.
RUN_USER="$(stat -c '%U' "$REPO_ROOT")"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
[ -n "$RUN_HOME" ] || { echo "cannot resolve a home directory for $RUN_USER" >&2; exit 1; }

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
