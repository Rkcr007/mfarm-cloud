#!/usr/bin/env bash
#
# Is the farm running `main`? — D18 and D19, answered before anybody verifies anything on it.
#
#   ./deploy/check-deployed.sh            # from a laptop, over gcloud ssh
#
# Reads `origin/main` from THIS checkout, then asks the boxes what they are actually running. Exits
# non-zero when anything is behind, so it can gate a verification run rather than only inform one.
#
# THE DEVICE HOST IS OPTIONAL, not silently skipped: a stopped lab is the normal state and is
# reported as such, because "could not be read" and "up to date" must never look the same.
set -uo pipefail

ZONE="${MFARM_ZONE:-asia-south1-c}"
CP="${MFARM_CP:-mfarm-cp}"
LAB="${MFARM_LAB:-mfarm-lab}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/deploy/lib/deployed-state.sh"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

git -C "$REPO_ROOT" fetch origin main --quiet 2>/dev/null
WANT="$(git -C "$REPO_ROOT" rev-parse origin/main 2>/dev/null || echo unknown)"
say "origin/main is ${WANT:0:7}"

ssh_on() {
  gcloud compute ssh "$1" --zone "$ZONE" --tunnel-through-iap --command "$2" 2>/dev/null | tr -d '\r' | tail -1
}
running() { gcloud compute instances describe "$1" --zone "$ZONE" --format='value(status)' 2>/dev/null; }

bad=0
# Printing lives here, not in the lib: a function that both prints and returns on stdout gets its
# display eaten by the command substitution reading its verdict. That is exactly what the first
# version of this did, and it took running it against the farm to see.
report() {
  local label="$1" got="$2" v
  v="$(mfarm_sha_verdict "$WANT" "$got")"
  case "$v" in
    ok)     printf '  \033[32m✓\033[0m %-28s %s\n' "$label" "${got:0:7}" ;;
    behind) printf '  \033[31m✗\033[0m %-28s %s — origin/main is %s\n' "$label" "${got:0:7}" "${WANT:0:7}"; bad=1 ;;
    *)      printf '  \033[33m!\033[0m %-28s could not be read\n' "$label"; bad=1 ;;
  esac
}

say "Control plane ($CP)"
report 'serving image' "$(ssh_on "$CP" "sudo docker ps --filter name=mfarm-api --format '{{.Image}}' | sed 's/.*://'")"
report 'checkout' "$(ssh_on "$CP" "sudo -u rkcr070707 git -C /home/rkcr070707/mfarm rev-parse HEAD")"

say "Device host ($LAB)"
if [ "$(running "$LAB")" = "RUNNING" ]; then
  # The one whose drift changes what the DEVICES do: the worker unit and the boot unit both
  # ExecStart out of this tree.
  report 'checkout (worker runs this)' "$(ssh_on "$LAB" "sudo -u rkcr070707 git -C /home/rkcr070707/mfarm rev-parse HEAD")"
else
  printf '  \033[33m!\033[0m %-28s stopped — nothing to check, and nothing running\n' 'device host'
fi

if [ "$bad" = 0 ]; then
  printf '\n\033[1mThe farm is running main.\033[0m\n'
else
  printf '\n\033[1;31mThe farm is NOT running main.\033[0m Deploy with:\n'
  printf '  ./deploy/mfarm-deploy.sh %s\n' "$WANT"
  printf '  …and bring each checkout forward with git -C ~/mfarm merge --ff-only origin/main\n'
fi
exit "$bad"
