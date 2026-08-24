#!/bin/sh
# Copy completed MFARM backups off the box, and leave evidence that it happened.
#
# THE GAP THIS CLOSES. `backup.sh` writes to /backups, which is a bind mount on the control-plane
# VM. Six-hourly dumps, verified with `pg_restore --list`, twenty-eight retained — and every one of
# them on the same disk as the database they are backups of. That is a backup of `DROP TABLE`. It is
# not a backup of the VM being deleted, the disk failing, or someone running the wrong `gcloud`
# command, and those are the cases anyone means when they say "just in case".
#
# WHAT IT DOES NOT DO, deliberately:
#
#   It never deletes remotely. Local retention prunes at BACKUP_KEEP (28 files, ~7 days at 6h), and
#   mirroring that upward would give the bucket the same seven-day horizon and defeat the point.
#   Remote retention belongs to a bucket lifecycle rule, which is set once and cannot be undone by
#   a bug in this loop. See deploy/README.md.
#
#   It never uploads a `.partial`. `backup.sh` renames only after `pg_restore --list` succeeds, so
#   a `.dump` on disk is an archive that was proven readable. Uploading anything else would fill a
#   bucket with files that look like backups.
#
# THE RECEIPT IS THE POINT. On success this writes ${BACKUP_DIR}/.offsite-receipt, whose mtime the
# API turns into `mfarm_backup_offsite_age_seconds` and Prometheus turns into an alert. Without it
# this sidecar would fail exactly the way the local backup used to: logging into a stream nobody
# reads, while the dashboard stays green. The receipt is written ONLY when the NEWEST local backup
# is confirmed present in the bucket at the right size — so "the newest dump never made it" goes
# stale and pages, rather than being averaged away by older uploads that did.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_BUCKET="${BACKUP_BUCKET:-}"
RECEIPT="${BACKUP_DIR}/.offsite-receipt"

log() { echo "[offsite] $*"; }
die() { log "FAILED: $*"; exit 1; }

# An unset bucket is a configuration error, not a mode. A sidecar that quietly does nothing is how
# you discover on the worst day of the quarter that nothing was ever copied — set BACKUP_BUCKET, or
# set it to the literal `none` to say out loud that you accept single-disk backups.
[ -n "${BACKUP_BUCKET}" ] || die "BACKUP_BUCKET is unset. Set it to gs://<bucket>, or to 'none' to opt out explicitly."
if [ "${BACKUP_BUCKET}" = "none" ]; then
  log "BACKUP_BUCKET=none — backups stay on this disk only. This is an explicit choice, not a default."
  exit 0
fi

case "${BACKUP_BUCKET}" in
  gs://*) ;;
  *) die "BACKUP_BUCKET must start with gs:// (got: ${BACKUP_BUCKET})" ;;
esac

[ -d "${BACKUP_DIR}" ] || die "${BACKUP_DIR} is not readable — check the bind mount"

# The newest COMPLETE backup: a .dump with its companion .globals.sql. A dump without roles restores
# into a cluster that dies on the first GRANT, so a pair is the unit that matters, not a file.
NEWEST=""
for f in $(ls -1t "${BACKUP_DIR}"/mfarm-*.dump 2>/dev/null || true); do
  [ -f "${f%.dump}.globals.sql" ] || continue
  NEWEST="$f"
  break
done
[ -n "${NEWEST}" ] || die "no complete backup pair in ${BACKUP_DIR} yet — is the backup sidecar running?"

# ---------------------------------------------------------------- upload what is missing
#
# `cp -n` is no-clobber: already-uploaded files cost one existence check and no bytes. That is what
# makes running this every few minutes cheap, which is in turn what keeps the receipt fresh enough
# for the alert threshold to mean something.
#
# Errors are NOT swallowed. A permission fault, a bucket that does not exist and a network failure
# must each stop the run before the receipt is touched, because the receipt is the only thing
# anyone will look at.
UPLOADED=0
FAILED=0
for f in $(ls -1t "${BACKUP_DIR}"/mfarm-*.dump 2>/dev/null || true); do
  g="${f%.dump}.globals.sql"
  [ -f "$g" ] || continue
  # THE EXIT CODE IS THE SIGNAL, not the output. This used to grep stdout for "Copying", which is
  # what gcloud prints when it STARTS a transfer — so a failed upload counted as a success and the
  # log cheerfully reported "uploaded 3" against an empty bucket. Observed on the first real run.
  if gcloud storage cp -n "$f" "$g" "${BACKUP_BUCKET}/" >/dev/null 2>&1; then
    UPLOADED=$((UPLOADED + 1))
  else
    FAILED=$((FAILED + 1))
    log "upload FAILED for $(basename "$f")"
  fi
done
[ "${UPLOADED}" -gt 0 ] && log "uploaded ${UPLOADED} backup pair(s)"
[ "${FAILED}" -gt 0 ] && die "${FAILED} upload(s) failed — not recording a receipt"

# ---------------------------------------------------------------- prove the newest one landed
#
# `cp` exiting 0 is not proof. This asks the BUCKET how big the object is and compares it to the
# file on disk — the same reasoning as `pg_restore --list` in backup.sh, applied one layer out: a
# transfer that failed halfway can still leave a plausible name behind.
NAME="$(basename "${NEWEST}")"
LOCAL_SIZE="$(wc -c < "${NEWEST}" | tr -d ' ')"

# RETRIED, because object listing is not immediately consistent after a write. The first real run
# uploaded correctly and then declared the object missing, because the confirmation ran in the same
# second as the upload — a false alarm that, had the receipt been written on a weaker check, would
# have been a silent one in the other direction.
#
# Six attempts over ~30s. A genuinely absent object still fails, just half a minute later, and this
# runs every 15 minutes.
REMOTE_SIZE=""
i=0
while [ "$i" -lt 6 ]; do
  REMOTE_SIZE="$(gcloud storage ls -l "${BACKUP_BUCKET}/${NAME}" 2>/dev/null | awk 'NR==1{print $1}')"
  [ -n "${REMOTE_SIZE}" ] && break
  i=$((i + 1))
  [ "$i" -lt 6 ] && sleep 5
done

[ -n "${REMOTE_SIZE}" ] || die "${NAME} is not listable in ${BACKUP_BUCKET} after 30s — check the service account has storage.objects.create and storage.objects.list on that bucket"
[ "${REMOTE_SIZE}" = "${LOCAL_SIZE}" ] || die "${NAME} is ${LOCAL_SIZE} bytes here and ${REMOTE_SIZE} there — the copy is truncated, refusing to record it as done"

# ---------------------------------------------------------------- the receipt
#
# Written last, and only here. Its CONTENT is for a human reading the directory; its MTIME is what
# the metric reads, which is why it is rewritten every successful run rather than appended to.
cat > "${RECEIPT}.partial" <<RECEIPT_EOF
{
  "newest": "${NAME}",
  "bytes": ${LOCAL_SIZE},
  "bucket": "${BACKUP_BUCKET}",
  "confirmedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
RECEIPT_EOF
mv "${RECEIPT}.partial" "${RECEIPT}"

log "ok — ${NAME} (${LOCAL_SIZE} bytes) confirmed in ${BACKUP_BUCKET}"
