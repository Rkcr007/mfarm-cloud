#!/usr/bin/env bash
#
# Bring THIS device host's worker to `origin/main`. Run it ON the device host.
#
#   ./deploy/worker-deploy.sh            # fast-forward, install, restart, confirm it stayed up
#   ./deploy/worker-deploy.sh --check    # say what is behind and what is missing; change nothing
#
# WHY THIS IS A SCRIPT. The by-hand path was written down in five places as "git pull, restart the
# worker". That was the whole job while the agent needed nothing the box did not already hold. #254
# gave it a dependency (`werift`) that `index.ts` reaches at start-up, so the same two commands
# would have stopped the worker on an import: the unit retries five times in five minutes and gives
# up, and every device on the host is gone. Nobody had run them since — the device host was thirteen
# days behind `main` when this was found, which is the only reason it had not happened (D82).
#
# THE ORDER IS THE POINT. Install BEFORE the restart, and refuse the restart while anything the
# agent declares cannot be resolved. A worker left running the code it was started with is a farm
# that works; a worker restarted onto code it cannot load is not.
#
# `npm install`, NOT `npm ci`. `ci` deletes `node_modules` first, under a worker that is still
# running out of it, and a download that then fails leaves nothing to restart onto. `install` only
# adds, so a failure here costs nothing.
#
# THE DEPENDENCY CHECK ASKS NODE, not npm. `npm ls` exits 0 on a tree with nothing installed at all
# (it prints "(empty)"), so it cannot be the gate. `import.meta.resolve` from the agent's own
# directory is the same lookup the agent's first line performs.
#
# A restart ends any live session on this host. Look at the console first.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="${MFARM_WORKER_UNIT:-mfarm-worker}"
# How long the worker must stay up before this calls it started. A process that cannot load its
# code exits within a second and systemd waits `RestartSec=10s` before the next attempt, so
# `is-active` asked straight after a restart says "active" about a worker that is already dead.
SETTLE="${MFARM_WORKER_SETTLE_SECONDS:-20}"

CHECK=0
case "${1:-}" in
  --check) CHECK=1 ;;
  "") ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

systemctl cat "$UNIT" >/dev/null 2>&1 \
  || die "No $UNIT unit on this machine. This is for a device host; the control plane deploys with ./deploy/mfarm-deploy.sh."

# Every dependency the agent declares that Node cannot resolve from the agent's directory, one line.
# Empty and exit 0 when there is none.
unresolved() {
  ( cd "$REPO_ROOT/workers/agent" && node --input-type=module -e '
      import { readFileSync } from "node:fs";
      const deps = Object.keys(JSON.parse(readFileSync("package.json", "utf8")).dependencies ?? {});
      const missing = deps.filter((d) => { try { import.meta.resolve(d); return false; } catch { return true; } });
      if (missing.length) { console.log(missing.join(" ")); process.exit(1); }
    ' )
}

# FETCH, THEN READ. A fast-forward against a stale remote-tracking ref reports success having moved
# nothing — the trap `auto-deploy.sh` documents, and the same one here.
git -C "$REPO_ROOT" fetch --quiet origin main \
  || die "git fetch failed. Refusing to deploy against an origin/main that may be stale."
HAVE="$(git -C "$REPO_ROOT" rev-parse HEAD)"
WANT="$(git -C "$REPO_ROOT" rev-parse origin/main)"

if [ "$CHECK" = 1 ]; then
  say "Checkout"
  if [ "$HAVE" = "$WANT" ]; then note "at origin/main (${WANT:0:7})"
  else note "at ${HAVE:0:7}; origin/main is ${WANT:0:7}"; fi
  say "What the agent declares, as Node resolves it today"
  if MISSING="$(unresolved)"; then note "everything resolves"
  else note "NOT installed: $MISSING"; fi
  note "(a checkout that is behind may declare more once it is brought forward)"
  [ "$HAVE" = "$WANT" ] && [ -z "${MISSING:-}" ]
  exit $?
fi

say "Bringing the checkout to origin/main (${WANT:0:7})"
if [ "$HAVE" != "$WANT" ]; then
  git -C "$REPO_ROOT" merge --ff-only --quiet origin/main \
    || die "Cannot fast-forward ${HAVE:0:7} to ${WANT:0:7}. Local changes or a diverged branch — look before forcing anything."
  note "${HAVE:0:7} -> ${WANT:0:7}"
else
  note "already there"
fi

say "Installing what the lockfile names"
( cd "$REPO_ROOT" && npm install --no-audit --no-fund ) \
  || die "npm install failed. The worker has NOT been restarted and is still running the code it was started with."
# An npm of another major version can rewrite the lockfile, and a modified lockfile fails the next
# fast-forward with a message about local changes that says nothing about npm.
if ! git -C "$REPO_ROOT" diff --quiet -- package-lock.json; then
  git -C "$REPO_ROOT" checkout --quiet -- package-lock.json
  note "npm rewrote package-lock.json; put back as committed"
fi

if ! MISSING="$(unresolved)"; then
  die "Still not installed after npm install: $MISSING. NOT restarting — the worker would stop on its first import."
fi
note "everything the agent declares resolves"

say "Restarting $UNIT"
sudo systemctl restart "$UNIT" || die "systemctl restart failed."
PID_BEFORE="$(systemctl show "$UNIT" -p MainPID --value)"
sleep "$SETTLE"
STATE="$(systemctl is-active "$UNIT")"
PID_AFTER="$(systemctl show "$UNIT" -p MainPID --value)"

# THE SAME PROCESS, STILL ALIVE. "active" alone is not enough (see SETTLE above), and neither is a
# pid: a crash loop has a pid each time it is asked. One that has not changed has not crashed.
if [ "$STATE" != active ] || [ -z "$PID_AFTER" ] || [ "$PID_AFTER" = 0 ] || [ "$PID_AFTER" != "$PID_BEFORE" ]; then
  journalctl -u "$UNIT" -n 30 --no-pager 2>/dev/null
  die "The worker did not stay up for ${SETTLE}s (state: $STATE, pid $PID_BEFORE -> $PID_AFTER). Its last lines are above."
fi

say "The worker is running ${WANT:0:7} (pid $PID_AFTER)"
note "From a laptop: ./deploy/check-deployed.sh, then ./deploy/farm-check.sh"
