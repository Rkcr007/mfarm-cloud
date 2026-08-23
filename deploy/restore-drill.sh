#!/usr/bin/env bash
# Prove the backup path actually restores. Run it on a schedule, not once.
#
#   deploy/restore-drill.sh                       # against the dev stack in apps/api
#   PG_CONTAINER=mfarm-postgres-1 deploy/restore-drill.sh
#   DRILL_BUCKET=gs://mfarm-backups deploy/restore-drill.sh    # ...through the bucket and back
#
# "Untested backups are not backups" is easy to write in a plan and easy to leave there. This is the
# test: it seeds a scratch database with known rows, backs it up with the REAL backup.sh, drops it,
# restores it with the REAL restore.sh, and compares. Nothing is stubbed — a change that breaks
# recovery breaks this.
#
# It never touches the farm's own database. Everything happens in a scratch database that is dropped
# on the way out, including on failure.
#
# DRILL_BUCKET EXTENDS IT ONE HOP FURTHER, and this is the version worth running on the control
# plane. With it set, the archive is uploaded, deleted locally, downloaded again, and the restore
# below runs against WHAT CAME BACK. Every assertion in step 6 then applies to the off-box copy
# rather than to the file that never moved — which is the difference between "a backup exists in a
# bucket" and "the thing in the bucket is a farm". Off by default because it needs gcloud and real
# credentials, and the rest of this drill is deliberately hermetic enough to run in CI.
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-}"
COMPOSE_FILE="${COMPOSE_FILE:-apps/api/docker-compose.yml}"
SCRATCH_DB="mfarm_drill_$$"
SCRATCH_ROLE="mfarm_drill_role_$$"
WORKDIR="/tmp/mfarm-drill-$$"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31mDRILL FAILED: %s\033[0m\n' "$*" >&2; exit 1; }

# Resolve the container once, so every later call is a plain `docker exec`.
#
# Two ways it can be running, and the drill has to work in both: a compose stack locally, and a
# GitHub Actions service container in CI — which compose knows nothing about, so the image lookup is
# the fallback rather than a nicety.
if [ -z "${PG_CONTAINER}" ]; then
  PG_CONTAINER="$(docker compose -f "${COMPOSE_FILE}" ps -q postgres 2>/dev/null | head -1 || true)"
fi
if [ -z "${PG_CONTAINER}" ]; then
  PG_CONTAINER="$(docker ps --filter 'ancestor=postgres:16-alpine' --format '{{.ID}}' | head -1)"
fi
[ -n "${PG_CONTAINER}" ] || fail "no postgres container. Start one: npm --prefix apps/api run db:up"

PGUSER="${PGUSER:-mfarm}"
# -i so heredocs on stdin reach psql inside the container. Without it the SQL is silently discarded
# and the first symptom is "relation does not exist" three steps later.
dex() { docker exec -i -e PGUSER="${PGUSER}" -e PGPASSWORD="${PGPASSWORD:-mfarm}" "${PG_CONTAINER}" "$@"; }
psql_() { dex psql -v ON_ERROR_STOP=1 "$@"; }

cleanup() {
  dex sh -c "rm -rf ${WORKDIR}" >/dev/null 2>&1 || true
  psql_ --dbname=postgres -c "DROP DATABASE IF EXISTS ${SCRATCH_DB}" >/dev/null 2>&1 || true
  psql_ --dbname=postgres -c "DROP DATABASE IF EXISTS ${SCRATCH_DB}_restored" >/dev/null 2>&1 || true
  psql_ --dbname=postgres -c "DROP ROLE IF EXISTS ${SCRATCH_ROLE}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say "1/6  seeding scratch database ${SCRATCH_DB}"
psql_ --dbname=postgres -c "CREATE DATABASE ${SCRATCH_DB}"
# A non-superuser role that OWNS nothing but is GRANTed access, mirroring mfarm_app. It exists so the
# drill proves the two things a naive dump/restore silently loses: cluster roles, and privileges.
psql_ --dbname=postgres -c "CREATE ROLE ${SCRATCH_ROLE} NOLOGIN"
psql_ --dbname="${SCRATCH_DB}" <<SQL
CREATE TABLE widgets (id serial PRIMARY KEY, org_id text NOT NULL, name text NOT NULL);
INSERT INTO widgets (org_id, name)
  SELECT 'org-' || (i % 3), 'widget-' || i FROM generate_series(1, 500) AS i;
ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE widgets FORCE ROW LEVEL SECURITY;
CREATE POLICY widgets_tenant ON widgets USING (org_id = current_setting('app.org_id', true));
GRANT SELECT, INSERT ON widgets TO ${SCRATCH_ROLE};
SQL

EXPECT_ROWS="$(psql_ --dbname="${SCRATCH_DB}" -tAc 'SELECT count(*) FROM widgets')"
EXPECT_SUM="$(psql_ --dbname="${SCRATCH_DB}" -tAc "SELECT md5(string_agg(name, ',' ORDER BY id)) FROM widgets")"
echo "seeded ${EXPECT_ROWS} rows, checksum ${EXPECT_SUM}"

say "2/6  backing up with the real deploy/backup.sh"
dex mkdir -p "${WORKDIR}"
docker cp deploy/backup.sh "${PG_CONTAINER}:${WORKDIR}/backup.sh"
dex chmod +x "${WORKDIR}/backup.sh"
dex env BACKUP_DIR="${WORKDIR}" PGDATABASE="${SCRATCH_DB}" PGUSER="${PGUSER}" \
        PGPASSWORD="${PGPASSWORD:-mfarm}" BACKUP_KEEP=5 \
        sh "${WORKDIR}/backup.sh"

DUMP="$(dex sh -c "ls -1t ${WORKDIR}/mfarm-*.dump | head -1")"
[ -n "${DUMP}" ] || fail "backup.sh produced no .dump"
echo "archive: ${DUMP}"

say "3/6  confirming the roles dump exists and carries the granted role"
GLOBALS="${DUMP%.dump}.globals.sql"
dex test -f "${GLOBALS}" || fail "no globals file — a restore into a fresh cluster would fail on GRANT"
dex grep -q "${SCRATCH_ROLE}" "${GLOBALS}" \
  || fail "the granted role is missing from the globals dump; restore would fail on its GRANT"

if [ -n "${DRILL_BUCKET:-}" ]; then
  say "3b/6  round-tripping the archive through ${DRILL_BUCKET}"
  command -v gcloud >/dev/null 2>&1 || fail "DRILL_BUCKET is set but gcloud is not on PATH"

  # gcloud runs on the HOST; the archive lives inside the postgres container. Copying it out and
  # back is the honest way to do this — the alternative is installing a cloud SDK into the database
  # image, which is exactly the coupling backup-offsite.sh exists to avoid.
  HOSTTMP="$(mktemp -d)"
  DUMP_NAME="$(basename "${DUMP}")"
  GLOBALS_NAME="$(basename "${GLOBALS}")"
  REMOTE="${DRILL_BUCKET}/drill-$$"

  docker cp "${PG_CONTAINER}:${DUMP}" "${HOSTTMP}/${DUMP_NAME}" >/dev/null
  docker cp "${PG_CONTAINER}:${GLOBALS}" "${HOSTTMP}/${GLOBALS_NAME}" >/dev/null
  gcloud storage cp "${HOSTTMP}/${DUMP_NAME}" "${HOSTTMP}/${GLOBALS_NAME}" "${REMOTE}/" \
    || fail "upload to ${REMOTE} failed — does the account have storage.objects.create?"

  # Deleted locally BEFORE the download, so a download that silently no-ops cannot leave the
  # original behind and pass the drill on a file that never left this machine.
  rm -f "${HOSTTMP}/${DUMP_NAME}" "${HOSTTMP}/${GLOBALS_NAME}"
  gcloud storage cp "${REMOTE}/${DUMP_NAME}" "${REMOTE}/${GLOBALS_NAME}" "${HOSTTMP}/" \
    || fail "download from ${REMOTE} failed"
  [ -s "${HOSTTMP}/${DUMP_NAME}" ] || fail "the archive that came back from ${REMOTE} is empty"

  dex rm -f "${DUMP}" "${GLOBALS}"
  docker cp "${HOSTTMP}/${DUMP_NAME}" "${PG_CONTAINER}:${DUMP}" >/dev/null
  docker cp "${HOSTTMP}/${GLOBALS_NAME}" "${PG_CONTAINER}:${GLOBALS}" >/dev/null
  rm -rf "${HOSTTMP}"
  gcloud storage rm "${REMOTE}/${DUMP_NAME}" "${REMOTE}/${GLOBALS_NAME}" >/dev/null 2>&1 || true

  echo "everything below now runs against the copy that came back from the bucket"
fi

say "4/6  destroying the original"
psql_ --dbname=postgres -c "DROP DATABASE ${SCRATCH_DB}"
psql_ --dbname=postgres -c "DROP ROLE ${SCRATCH_ROLE}"
echo "database and role are gone — this is the state a real recovery starts from"

say "5/6  restoring with the real deploy/restore.sh"
docker cp deploy/restore.sh "${PG_CONTAINER}:${WORKDIR}/restore.sh"
dex chmod +x "${WORKDIR}/restore.sh"
dex env TARGET_DB="${SCRATCH_DB}_restored" PGUSER="${PGUSER}" PGPASSWORD="${PGPASSWORD:-mfarm}" \
        sh "${WORKDIR}/restore.sh" "${DUMP}"

say "6/6  comparing"
GOT_ROWS="$(psql_ --dbname="${SCRATCH_DB}_restored" -tAc 'SELECT count(*) FROM widgets')"
GOT_SUM="$(psql_ --dbname="${SCRATCH_DB}_restored" -tAc "SELECT md5(string_agg(name, ',' ORDER BY id)) FROM widgets")"
[ "${GOT_ROWS}" = "${EXPECT_ROWS}" ] || fail "row count ${GOT_ROWS} != ${EXPECT_ROWS}"
[ "${GOT_SUM}"  = "${EXPECT_SUM}"  ] || fail "content checksum differs"

# The two properties a dump/restore quietly drops, and the reason this drill exists at all.
RLS="$(psql_ --dbname="${SCRATCH_DB}_restored" -tAc \
  "SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'widgets'::regclass")"
[ "${RLS}" = "t" ] || fail "row-level security did not survive the restore (relrowsecurity/force = ${RLS})"

POL="$(psql_ --dbname="${SCRATCH_DB}_restored" -tAc \
  "SELECT count(*) FROM pg_policies WHERE tablename = 'widgets'")"
[ "${POL}" = "1" ] || fail "the tenant policy did not survive the restore (${POL} policies)"

GRANTED="$(psql_ --dbname="${SCRATCH_DB}_restored" -tAc \
  "SELECT count(*) FROM information_schema.role_table_grants
    WHERE table_name = 'widgets' AND grantee = '${SCRATCH_ROLE}'")"
[ "${GRANTED}" != "0" ] || fail "the app role's privileges did not survive — pg_restore ran with --no-privileges?"

printf '\n\033[32mDRILL PASSED\033[0m  %s rows, checksum matches, RLS + policy + grants intact\n' "${GOT_ROWS}"
