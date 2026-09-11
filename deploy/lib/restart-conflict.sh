# Did `docker compose up -d` fail because a container NAME was taken? — as a function, so it can be
# executed in a test rather than read.
#
# WHY THIS EXISTS. `mfarm-deploy.sh` once reported failure on a deploy that had worked. An
# out-of-band `docker compose up -d api` had left a container under a different project name, so
# compose answered
#
#   Error response from daemon: Conflict. The container name "/mfarm_mfarm-api-1" is already in
#   use by container "8f3c…". You have to remove (or rename) that container to be able to reuse
#   that name.
#
# and `set -euo pipefail` ended the script on that line. The image was running and the migration had
# applied; what was lost was the VERIFICATION step — the only part that decides whether a deploy
# happened. A script that reports failure on a working deploy teaches people to ignore it, which is
# worse than not checking at all.
#
# PARSED RATHER THAN MATCHED LOOSELY, and this is the fragile half worth a test: the container name
# is inside quotes and behind a leading slash, docker's sentence has changed wording between
# versions, and a regex that silently stops matching would put the retry back to square one without
# anybody noticing.

# Echo the conflicting container name, or nothing at all.
#
# NOTHING IS THE SAFE ANSWER. A caller that gets an empty string does not remove anything and falls
# through to verification, which still reports the truth. A caller that gets the WRONG name would
# `docker rm -f` something it was never asked to touch — so every branch here prefers silence to a
# guess.
mfarm_conflict_container() {
  local out="$1"

  # Both halves must be present. "Conflict" alone appears in unrelated daemon errors, and a bare
  # "is already in use" is said about ports and volumes too — removing a CONTAINER because a PORT
  # was busy is exactly the wrong action.
  case "$out" in
    *Conflict*"is already in use"*) ;;
    *) return 0 ;;
  esac

  # The name is the first quoted string after "container name", with its leading slash dropped.
  # Anchored on that phrase rather than on the first quoted thing in the message, because the
  # sentence also quotes the id of the container holding the name.
  printf '%s' "$out" \
    | sed -n 's/.*container name "\/\{0,1\}\([^"]*\)".*/\1/p' \
    | head -1
}
