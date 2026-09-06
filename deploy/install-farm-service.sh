#!/usr/bin/env bash
#
# Install the boot unit from the copy in this repo — D20.
#
#   sudo -v && ./deploy/install-farm-service.sh
#
# The unit used to exist only on the VM, which is how it came to declare `CF_INSTANCES=2` on a host
# running four devices. Installing it from here means the file on the box is the file in the repo,
# and a change to it is a change somebody reviewed.
#
# IDEMPOTENT and safe to re-run: it rewrites the unit, reloads systemd and leaves the enable state
# alone unless asked. It does NOT start the unit — on a device host `farm-up.sh` exits immediately
# anyway, and on a control plane starting it is a decision with a database behind it.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$REPO_ROOT/deploy/mfarm-farm.service"
UNIT_DST=/etc/systemd/system/mfarm-farm.service
# THE OWNER OF THE CHECKOUT, not whoever invoked sudo.
#
# `${SUDO_USER:-$USER}` was the first version and it is wrong in the way that matters: run through a
# nested sudo — `gcloud compute ssh` as one account, then `sudo -u rkcr070707` — `SUDO_USER` is the
# OUTER login, so the unit was installed with `User=rakeshkumarbarik` on a farm whose devices belong
# to `rkcr070707`. cvd's instance database is per-uid: that unit would have found no devices and
# cheerfully built a second set. Caught by installing it for real and reading the file back.
#
# The repo's owner is the account that must run these units, because it is the account that owns the
# cvd database, the snapshots and `deploy/.state`. It is also a fact about the machine rather than
# about how somebody happened to invoke this.
RUN_USER="$(stat -c '%U' "$REPO_ROOT")"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"

[ -f "$UNIT_SRC" ] || { echo "missing $UNIT_SRC" >&2; exit 1; }
[ -n "$RUN_HOME" ] || { echo "cannot resolve a home directory for $RUN_USER" >&2; exit 1; }

sed -e "s|__USER__|$RUN_USER|g" -e "s|__REPO__|$REPO_ROOT|g" -e "s|__HOME__|$RUN_HOME|g" \
  "$UNIT_SRC" | sudo tee "$UNIT_DST" >/dev/null
sudo systemctl daemon-reload

printf 'installed %s for %s, running from %s\n' "$UNIT_DST" "$RUN_USER" "$REPO_ROOT"
printf 'enable it with: sudo systemctl enable mfarm-farm.service\n'
