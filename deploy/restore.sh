#!/bin/sh
# Restore one MFARM backup into a database.
#
#   docker compose -f deploy/docker-compose.prod.yml run --rm \
#     -e TARGET_DB=mfarm_restore_check backup /usr/local/bin/restore.sh /backups/mfarm-<stamp>.dump
#
# Refuses to overwrite a database that already has tables unless RESTORE_FORCE=1. The whole point of
# a restore is that it happens on the worst day of the quarter, by someone who has not read this
# file, and a silent overwrite of the live database is not a recovery.
set -eu

DUMP="${1:?usage: restore.sh <path-to-.dump>}"
TARGET_DB="${TARGET_DB:?set TARGET_DB — refusing to guess which database to write to}"

log() { echo "[restore] $*"; }

[ -f "${DUMP}" ] || { log "no such file: ${DUMP}"; exit 1; }

if ! pg_restore --list "${DUMP}" > /dev/null 2>&1; then
  log "FAILED: ${DUMP} is not a readable custom-format archive"
  exit 1
fi

# ---------------------------------------------------------------- roles
#
# Roles are cluster-wide, so they are restored before the database and only if missing. `mfarm_app`
# not existing is the failure this prevents: without it the restore dies partway through on a GRANT,
# leaving a half-populated database that looks like a successful restore until something reads from
# it. See the note in backup.sh.
GLOBALS="${DUMP%.dump}.globals.sql"
if [ -f "${GLOBALS}" ]; then
  log "applying cluster roles from $(basename "${GLOBALS}")"
  # Role creation is expected to fail when the role already exists; that is the normal case when
  # restoring into the same cluster. Errors are shown but not fatal here, and the real check is the
  # restore below, which fails loudly if a role it needs is genuinely absent.
  psql --dbname=postgres --file="${GLOBALS}" 2>&1 | grep -v "already exists" || true
  log "note: backups carry no role PASSWORDS. On a fresh cluster set them with ALTER ROLE before"
  log "      pointing the API at this database, or APP_DATABASE_URL will not authenticate."
else
  log "WARNING: no ${GLOBALS} alongside the dump — if this cluster lacks mfarm_app the restore will fail"
fi

# ---------------------------------------------------------------- guard
EXISTING="$(psql --dbname=postgres -tAc \
  "SELECT count(*) FROM pg_database WHERE datname = '${TARGET_DB}'")"

if [ "${EXISTING}" != "0" ]; then
  TABLES="$(psql --dbname="${TARGET_DB}" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null || echo 0)"
  if [ "${TABLES}" != "0" ] && [ "${RESTORE_FORCE:-0}" != "1" ]; then
    log "REFUSING: ${TARGET_DB} already has ${TABLES} table(s) in public."
    log "          Restore into a scratch database and swap, or set RESTORE_FORCE=1 if you are"
    log "          certain you mean to overwrite this one."
    exit 1
  fi
else
  log "creating ${TARGET_DB}"
  psql --dbname=postgres -c "CREATE DATABASE \"${TARGET_DB}\""
fi

# ---------------------------------------------------------------- restore
#
# --exit-on-error, deliberately. pg_restore's default is to report errors and carry on, which
# produces a database that is *mostly* there and an exit code of 0 — the single worst outcome, since
# it reads as success and is missing rows nobody will look for until much later.
#
# NOTE WHAT IS *NOT* HERE: `--no-owner --no-privileges`. Those two flags are the usual reflex for
# making a restore "just work", and in this database they would quietly dismantle the isolation
# model. Ownership decides whether RLS applies at all — a table owner skips its own policies unless
# FORCE is set, so restoring the tenant tables under the wrong role changes what row-level security
# means. And the privileges are what give `mfarm_app` its deliberately narrow access; drop them and
# the honest outcome is an app that cannot read anything, while the tempting fix is a broad GRANT
# that undoes migration 002. Preserving both is why roles are restored first.
log "restoring into ${TARGET_DB}"
pg_restore \
  --dbname="${TARGET_DB}" \
  --exit-on-error \
  "${DUMP}"

log "restored. Verify before cutting over:"
log "  psql -d ${TARGET_DB} -c 'SELECT count(*) FROM sessions'"
log "ok"
