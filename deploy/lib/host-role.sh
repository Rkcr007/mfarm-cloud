# Which kind of machine is this?
#
# WHY THIS IS A FILE RATHER THAN TWO LINES IN farm-up.sh. The device host's boot unit failed on
# every boot from 3 September, exiting in one second on "BACKUP_BUCKET is empty" — a control-plane
# backup policy that a machine with no database has no business having an opinion about. The first
# fix (PR #103) added a guard to farm-up.sh:
#
#     if [ -e /dev/kvm ] && [ -n "${CONTROL_PLANE_URL:-}" ]; then ... exit 0; fi
#
# and it never fired. `farm-up.sh` sources `deploy/.env`; `CONTROL_PLANE_URL` is not in that file
# and never has been. `install-worker-service.sh` writes it to `deploy/.state/worker.env`, which is
# the WORKER unit's EnvironmentFile — a different file, read by a different process. The guard read
# the right variable out of the wrong file, so the boot unit went on failing exactly as before.
#
# Its unit test passed the whole time, because it asserted the guard's LINE NUMBER was below the
# `. "$ENV_FILE"` line. That is a true statement about the text of the script and says nothing
# about whether the variable is in the file. Hence this file: the decision is a FUNCTION, with the
# two things it depends on — the deploy directory and the kvm node — injectable, so a test can put
# real fixtures behind it and watch it decide. A guard that cannot be executed in a test has only
# ever been reviewed, not tested.
#
# THE TWO MACHINES (ADR-0006):
#   * control plane — no /dev/kvm. Owns Postgres, the API, Caddy, and therefore the backup policy.
#   * device host   — has /dev/kvm, and a worker pointed at a control plane somewhere ELSE.
#
# and the case that keeps the "somewhere else" in the test: a SINGLE-HOST farm has /dev/kvm and a
# worker too, but its control plane is on loopback. That machine owns a database and must not take
# the device host's early exit. `farm-up.sh` starts that worker inline with
# `env CONTROL_PLANE_URL=http://127.0.0.1:$API_PORT` and writes no worker.env at all, so in
# practice the file is absent there — but loopback is rejected by value as well, because relying on
# a file's absence is how the first fix got it wrong.

# The control plane this machine's worker talks to, or empty if it has no worker.
#
# An already-exported CONTROL_PLANE_URL wins: it is how a human overrides this from the shell, and
# how install-worker-service.sh's own environment reads during a run.
mfarm_control_plane_url() {
  local deploy_dir="$1" worker_env
  if [ -n "${CONTROL_PLANE_URL:-}" ]; then
    printf '%s' "$CONTROL_PLANE_URL"
    return 0
  fi
  worker_env="$deploy_dir/.state/worker.env"
  [ -f "$worker_env" ] || return 0
  # Last assignment wins, matching what systemd's EnvironmentFile does with a repeated key.
  sed -n 's/^CONTROL_PLANE_URL=//p' "$worker_env" | tail -1 | tr -d "\"'"
}

# True when this machine runs devices for a control plane that lives on another machine.
mfarm_is_device_host() {
  local deploy_dir="$1" kvm="${2:-/dev/kvm}" url
  [ -e "$kvm" ] || return 1
  url="$(mfarm_control_plane_url "$deploy_dir")"
  case "$url" in
    '') return 1 ;;
    *//127.0.0.1*|*//localhost*|*//0.0.0.0*|*//"[::1]"*) return 1 ;;
    *) return 0 ;;
  esac
}
