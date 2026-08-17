#!/bin/sh
# One MFARM backup: cluster roles, then the database, then proof that both are readable.
#
# Runs inside a postgres:16-alpine container (see docker-compose.prod.yml) so pg_dump always matches
# the server version. Uses PG* environment variables rather than flags, so no password ever reaches
# the process list.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-28}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="${BACKUP_DIR}/mfarm-${STAMP}"

log() { echo "[backup] $*"; }

mkdir -p "${BACKUP_DIR}"

# ---------------------------------------------------------------- roles first
#
# THE MOST COMMON WAY A RESTORE FAILS. `pg_dump` captures the database, and nothing else: it does not
# capture roles, because roles are cluster-wide. MFARM's whole isolation model rests on `mfarm_app`
# being a separate non-superuser role that owns nothing, so a restore into a fresh cluster without
# roles fails on the first GRANT — or, worse, someone "fixes" it by restoring as the owner and
# quietly ends up with request handling that bypasses RLS.
#
# --globals-only also carries the role PASSWORDS, which is why these files are chmod 600 below.
log "dumping cluster roles"
pg_dumpall --globals-only --no-role-passwords > "${BASE}.globals.sql.partial"

# Role passwords are excluded above (--no-role-passwords) on purpose: a stolen backup should not be a
# stolen credential. The consequence is that a restore into a NEW cluster needs the passwords
# supplied again — deploy/README.md says so, and restore.sh checks.
mv "${BASE}.globals.sql.partial" "${BASE}.globals.sql"

# ---------------------------------------------------------------- the database
#
# Custom format (-Fc): compressed, and restorable selectively with pg_restore. Written to .partial
# first and renamed only on success, because rename is atomic on the same filesystem — without it a
# backup interrupted by a full disk or a container stop leaves a truncated file with a plausible name
# that the retention policy will happily keep and someone will one day try to restore.
log "dumping database ${PGDATABASE}"
pg_dump --format=custom --compress=9 --file="${BASE}.dump.partial"

# ---------------------------------------------------------------- verify
#
# A dump that failed halfway still exits 0 in some failure modes, and `ls -l` cannot tell you a
# custom-format archive is intact. Reading the table of contents back proves the archive header and
# the entry list survived. It is not a restore, and it is not claimed to be one — restore-drill.sh
# is what actually proves that, and deploy/README.md says to run it on a schedule.
if ! pg_restore --list "${BASE}.dump.partial" > /dev/null 2>&1; then
  log "FAILED: the archive just written is not readable by pg_restore — discarding it"
  rm -f "${BASE}.dump.partial"
  exit 1
fi

mv "${BASE}.dump.partial" "${BASE}.dump"
chmod 600 "${BASE}.dump" "${BASE}.globals.sql"

SIZE="$(wc -c < "${BASE}.dump")"
log "wrote ${BASE}.dump (${SIZE} bytes) and ${BASE}.globals.sql"

# An empty-ish archive is a real failure mode — an empty database, wrong PGDATABASE, or a dump that
# captured only the schema. Loud, but not fatal: the backup that exists is still better than none.
if [ "${SIZE}" -lt 4096 ]; then
  log "WARNING: that archive is suspiciously small. Check PGDATABASE=${PGDATABASE} is the right one."
fi

# ---------------------------------------------------------------- retention
#
# Prunes only files this script's own naming produces, and only AFTER a successful write — so a run
# of failures can never delete the last good backup to make room for nothing.
PRUNED=0
for f in $(ls -1t "${BACKUP_DIR}"/mfarm-*.dump 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))"); do
  rm -f "$f" "${f%.dump}.globals.sql"
  PRUNED=$((PRUNED + 1))
done
[ "${PRUNED}" -gt 0 ] && log "pruned ${PRUNED} backup(s) beyond the newest ${BACKUP_KEEP}"

log "ok"
