# Is the farm actually running `main`? — the verdict, as a function so it can be executed in a test.
#
# WHY THIS EXISTS. On 2026-09-05 the farm served `886cb47` while `main` was two merges further on:
# PR #102 merged at 11:28, released at 11:34, and reached the box at 13:08 when somebody finally ran
# `mfarm-deploy.sh`. For ninety minutes `docs/DEFECTS.md` said those fixes were "in the deployed
# build" and they were not. Nothing anywhere reported the gap — the console's build badge says what
# IS serving and there is no second number to compare it to (D18).
#
# The same hour, both boxes' CHECKOUTS were found adrift: `mfarm-cp` on a detached HEAD at `886cb47`
# and `mfarm-lab` sixty-six commits behind, on a tree the worker and the boot unit both ExecStart out
# of — so the farm was running agent code from PR #81 while the control plane ran the day's build
# (D19).
#
# Every "verified on the farm" claim is worth exactly as much as the answer to "which commit was the
# farm running". This is that answer, in one place, before anybody starts verifying.
#
# THE THREE ARE GENUINELY DIFFERENT FACTS and a farm can be wrong in any one of them alone:
#   * the IMAGE is what the control plane executes — `mfarm-deploy.sh` pulls it by sha;
#   * the CONTROL PLANE'S CHECKOUT is what `deploy/*.sh` and the migrations run from;
#   * the DEVICE HOST'S CHECKOUT is what the worker and the boot unit run from — the one that was
#     66 commits behind, and the only one whose drift changes what the DEVICES do.

# `ok` when the sha matches origin/main, `behind` when it does not, `unknown` when it could not be
# read. A short sha is compared on its own length, because `docker ps` reports the full one and a
# checkout may be printed either way.
mfarm_sha_verdict() {
  local want="$1" got="$2"
  if [ -z "$got" ] || [ "$got" = "unknown" ]; then printf 'unknown'; return; fi
  local n=${#got}
  if [ "$n" -lt 7 ]; then printf 'unknown'; return; fi
  if [ "${want:0:$n}" = "$got" ] || [ "${got:0:${#want}}" = "$want" ]; then printf 'ok'; else printf 'behind'; fi
}

# One line per fact, so the caller can print them without re-deriving anything.
mfarm_deploy_line() {
  local label="$1" want="$2" got="$3"
  local v; v="$(mfarm_sha_verdict "$want" "$got")"
  case "$v" in
    ok)      printf '  \033[32m✓\033[0m %-26s %s\n' "$label" "${got:0:7}" ;;
    behind)  printf '  \033[31m✗\033[0m %-26s %s — origin/main is %s\n' "$label" "${got:0:7}" "${want:0:7}" ;;
    *)       printf '  \033[33m!\033[0m %-26s could not be read\n' "$label" ;;
  esac
  printf '%s' "$v"
}

# The verdict alone, for callers that print in their own voice (verify-live.sh).
mfarm_deploy_verdict_quiet() { mfarm_sha_verdict "$1" "$2"; }
