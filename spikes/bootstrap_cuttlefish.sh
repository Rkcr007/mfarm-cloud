#!/usr/bin/env bash
# Fresh Ubuntu bare-metal -> Cuttlefish running, ready for spike 1 and 2a.
#
#   ./bootstrap_cuttlefish.sh          # run, reboot when told, run again
#
# Two phases because the group membership added in phase 1 (kvm, cvdnetwork, render) does not apply
# to the current session. State is kept in ~/.mfarm_bootstrap so re-running resumes rather than
# redoing. Safe to run repeatedly.
set -euo pipefail

STATE="${HOME}/.mfarm_bootstrap"
WORKDIR="${WORKDIR:-${HOME}/cf}"
BRANCH="${BRANCH:-aosp-main}"
CF_REPO="https://github.com/google/android-cuttlefish"

c_ok()   { printf '\033[32m  ok\033[0m  %s\n' "$*"; }
c_info() { printf '\033[36m  ..\033[0m  %s\n' "$*"; }
c_warn() { printf '\033[33m  !!\033[0m  %s\n' "$*"; }
die()    { printf '\033[31mBLOCKED\033[0m %s\n' "$*" >&2; exit 1; }
phase_done() { grep -qx "$1" "$STATE" 2>/dev/null; }
mark()   { echo "$1" >> "$STATE"; }

# Every network fetch below pulls from GitHub, and this script is expected to run on a cloud VM.
# Cloud providers hand out IP ranges shared by thousands of other machines, and GitHub rate-limits
# anonymous archive downloads per IP — so a 429 here is routine traffic policing that says nothing
# about this host, and credentials do not lift it on codeload.github.com. Bazel, git and cvd all
# keep a download cache, so a retry resumes instead of restarting; another attempt costs only the
# part that actually failed.
#
#     retry <attempts> <base_delay_seconds> <label> <command...>
#
# The backoff is exponential with jitter added. Jitter is not decoration: a rate limit is shared
# with every other client behind the same IP, and they are all backing off on the same schedule.
# Without jitter they wake in lockstep and collide again on the first retry.
RETRY_MAX_DELAY=${RETRY_MAX_DELAY:-300}
retry() {
  local attempts=$1 base=$2 label=$3; shift 3
  local n=1 delay
  while :; do
    if "$@"; then
      [ "$n" -gt 1 ] && c_ok "${label}: succeeded on attempt ${n}"
      return 0
    fi
    if [ "$n" -ge "$attempts" ]; then
      c_warn "${label}: failed after ${n} attempts"
      return 1
    fi
    delay=$(( base * (2 ** (n - 1)) + RANDOM % 20 ))
    [ "$delay" -gt "$RETRY_MAX_DELAY" ] && delay=$RETRY_MAX_DELAY
    c_warn "${label}: attempt ${n}/${attempts} failed, retrying in ${delay}s"
    sleep "$delay"
    n=$(( n + 1 ))
  done
}

# True when a log contains the signature of a rate limit rather than a real build error. Worth
# distinguishing because the two failures need opposite responses: wait and retry, versus stop and
# read the log.
rate_limited() { grep -qE '429 Too Many Requests|rate limit|too many requests' "$1" 2>/dev/null; }

touch "$STATE"

# ---------------------------------------------------------------- preflight
echo "== preflight =="
[ "$(uname -s)" = Linux ] || die "Linux required. This is $(uname -s). Cuttlefish cannot run on macOS."
. /etc/os-release 2>/dev/null || die "cannot read /etc/os-release"
[ "${ID:-}" = ubuntu ] || c_warn "tested on Ubuntu; ${ID:-unknown} may need adjustment"
c_ok "${PRETTY_NAME:-unknown}"

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  CF_TARGET="aosp_cf_x86_64_phone-userdebug" ;;
  aarch64) CF_TARGET="aosp_cf_arm64_only_phone-userdebug" ;;
  *) die "unsupported arch: $ARCH" ;;
esac
c_ok "arch $ARCH -> $CF_TARGET"

[ -e /dev/kvm ] || die "/dev/kvm missing.
  This is almost always one of:
    - a cloud VM created WITHOUT nested virtualisation enabled. It is a per-instance setting and
      it cannot be turned on after the fact — delete the instance and recreate it with the flag:
        GCP  gcloud compute instances create ... --enable-nested-virtualization  (not E2, not Arm)
        AWS  C8i/M8i/R8i with NestedVirtualization enabled, or a .metal instance
    - a shared VPS that does not offer it at all (most 'KVM VPS' listings mean the HOST uses KVM)
    - virtualisation disabled in BIOS, on a physical box
  See docs/HARDWARE_DAY.md for the full walkthrough."
c_ok "/dev/kvm present"

CORES=$(nproc); RAM_GB=$(free -g | awk '/^Mem:/{print $2}'); DISK_GB=$(df -BG --output=avail "$HOME" | tail -1 | tr -dc 0-9)
echo "  host: ${CORES} cores, ${RAM_GB} GB RAM, ${DISK_GB} GB free"
[ "$RAM_GB" -lt 16 ] && c_warn "${RAM_GB} GB RAM is thin for a density ramp; expect an early cliff"
[ "$DISK_GB" -lt 60 ] && c_warn "${DISK_GB} GB free; images + snapshots need ~40 GB"
sudo -n true 2>/dev/null || c_info "sudo password will be requested"

# ---------------------------------------------------------------- phase 1: packages
if ! phase_done pkgs; then
  echo; echo "== phase 1: install Cuttlefish =="
  sudo apt-get update -qq
  # Runtime deps only. The heavy build toolchain is installed further down, and only if we actually
  # have to build — which on the prebuilt path we do not.
  sudo apt-get install -y -qq curl ca-certificates unzip python3 f2fs-tools \
       android-sdk-platform-tools bc >/dev/null
  c_ok "runtime deps installed"

  # ---- path A: prebuilt debs from Google's Artifact Registry.
  #
  # Strongly preferred, and the upstream README's first recommendation. Building from source drives
  # Bazel to pull external archives from GitHub, which rate-limits per source IP — and cloud VM IP
  # ranges are shared with thousands of other machines, so a 429 there is routine and unfixable from
  # this end. Artifact Registry is a different host with no such limit, and skips the build outright:
  # minutes instead of an hour, and no toolchain to go stale.
  #
  # CF_INSTALL=source forces the build path; CF_INSTALL=prebuilt makes a failure here fatal instead
  # of falling through.
  CF_INSTALL="${CF_INSTALL:-auto}"
  PREBUILT_OK=no
  if [ "$CF_INSTALL" != source ]; then
    c_info "trying prebuilt packages from Artifact Registry"
    prebuilt_once() {
      sudo curl -fsSL https://us-apt.pkg.dev/doc/repo-signing-key.gpg \
           -o /etc/apt/trusted.gpg.d/artifact-registry.asc \
        && sudo chmod a+r /etc/apt/trusted.gpg.d/artifact-registry.asc \
        && echo "deb https://us-apt.pkg.dev/projects/android-cuttlefish-artifacts android-cuttlefish main" \
           | sudo tee /etc/apt/sources.list.d/artifact-registry.list >/dev/null \
        && sudo apt-get update -qq \
        && sudo apt-get install -y -qq cuttlefish-base cuttlefish-user >/dev/null
    }
    # tee (not tee -a) above: re-running must not stack duplicate source lines, which makes apt warn
    # on every subsequent update.
    if retry 3 20 "artifact registry install" prebuilt_once; then
      PREBUILT_OK=yes
      c_ok "cuttlefish-base + cuttlefish-user installed from Artifact Registry (no build needed)"
    else
      [ "$CF_INSTALL" = prebuilt ] && die "prebuilt install failed and CF_INSTALL=prebuilt forbids the source fallback."
      c_warn "Artifact Registry unavailable; falling back to building from source"
    fi
  fi
fi

# ---- path B: build from source. Only reached when the prebuilt path was skipped or failed.
if ! phase_done pkgs && [ "${PREBUILT_OK:-no}" != yes ]; then
  sudo apt-get install -y -qq git devscripts equivs config-package-dev debhelper-compat \
       golang >/dev/null
  c_ok "build deps installed"

  mkdir -p "$WORKDIR"; cd "$WORKDIR"
  if [ -d android-cuttlefish/.git ]; then
    git -C android-cuttlefish pull --ff-only >/dev/null 2>&1 || c_warn "pull failed, using existing checkout"
  else
    clone_once() { git clone --depth 1 "$CF_REPO" >/dev/null 2>&1; }
    retry 4 20 "clone android-cuttlefish" clone_once || die "clone failed: $CF_REPO"
  fi
  cd android-cuttlefish
  c_ok "source at $PWD"

  c_info "building debs (several minutes; retries on rate limits)"
  if [ -x tools/buildutils/build_packages.sh ]; then
    # Bazel resolves external deps by downloading archives from GitHub, which is where the 429s
    # land. It keeps what it already fetched, so each retry re-attempts only the missing archive
    # rather than rebuilding. Six attempts at 60s doubling reaches roughly half an hour of patience,
    # which is the observed order of magnitude for a shared-IP limit to clear.
    build_once() { ./tools/buildutils/build_packages.sh >/tmp/cf_build.log 2>&1; }
    if ! retry 6 60 "cuttlefish build" build_once; then
      if rate_limited /tmp/cf_build.log; then
        die "build blocked by GitHub rate limiting, not by a build error.

  Bazel could not download an external dependency because GitHub returned 429. This is applied
  per source IP, and cloud VM IP ranges are shared, so it is not about your account — adding
  credentials does not lift it on codeload.github.com.

  Options, cheapest first:
    - wait 30-60 minutes and re-run this script; it resumes from here
    - re-run with more patience:  RETRY_MAX_DELAY=900 $0
    - if it persists for hours, the VM's whole IP range is saturated. Recreate the instance to
      land on a different address (step B11 then B3), or build from a different region.

  Last lines of /tmp/cf_build.log:
$(tail -15 /tmp/cf_build.log)"
      fi
      die "build failed. Last lines:
$(tail -25 /tmp/cf_build.log)
  The upstream build steps change; check $CF_REPO README."
    fi
  else
    # older layout: build each package directory in turn
    for d in base frontend; do
      [ -d "$d" ] || continue
      ( cd "$d" && sudo mk-build-deps -i -t 'apt-get -y -o Debug::pkgProblemResolver=yes --no-install-recommends' >/dev/null 2>&1
        dpkg-buildpackage -uc -us >>/tmp/cf_build.log 2>&1 )
    done
  fi
  c_ok "packages built"

  sudo dpkg -i ./cuttlefish-base_*.deb ./cuttlefish-user_*.deb >/dev/null 2>&1 \
    || sudo apt-get install -f -y -qq >/dev/null
  c_ok "cuttlefish-base + cuttlefish-user installed from source build"
fi

# ---- common tail. Runs once whichever install path got us here, so the groups and the phase
# marker are not duplicated in both branches.
if ! phase_done pkgs; then
  sudo usermod -aG kvm,cvdnetwork,render "$USER"
  mark pkgs

  echo
  c_warn "REBOOT REQUIRED — group membership (kvm, cvdnetwork, render) is not active in this session."
  echo
  echo "    sudo reboot"
  echo "    # then re-run this script; it resumes from here"
  exit 0
fi
c_ok "packages already installed"

# ---------------------------------------------------------------- verify groups took effect
echo; echo "== verifying group membership =="
for g in kvm cvdnetwork render; do
  id -nG | tr ' ' '\n' | grep -qx "$g" \
    || die "not in group '$g' yet. Reboot (sudo reboot) and re-run this script."
done
c_ok "kvm, cvdnetwork, render active"
command -v cvd >/dev/null || die "cvd not on PATH despite install. Try: sudo apt-get install -f"
c_ok "cvd $(cvd version 2>/dev/null | head -1 || echo present)"

# ---------------------------------------------------------------- phase 2: device image
if ! phase_done image; then
  echo; echo "== phase 2: fetch device image (${BRANCH} / ${CF_TARGET}) =="
  mkdir -p "$WORKDIR/image"; cd "$WORKDIR/image"
  # `cvd fetch` with a bare branch/target resolves the NEWEST build id and downloads it blindly.
  # The newest build is frequently not one whose artifacts finished uploading, and the build API
  # cheerfully mints a signed download URL for an object that was never written — so the download
  # dies with a bare "File Not Found" that reads like a missing target rather than an unfinished
  # build. Resolve a build that demonstrably HAS the image, and pin the fetch to it.
  BUILD_API="https://androidbuildinternal.googleapis.com/android/internal/build/v3"
  # Artifact is named after the target with the build variant stripped:
  #   aosp_cf_x86_64_phone-userdebug  ->  aosp_cf_x86_64_phone-img-<id>.zip
  CF_PRODUCT="${CF_TARGET%-*}"

  # True when the image zip for this build id is actually present in storage. A range request keeps
  # this to a kilobyte rather than pulling the whole multi-GB object just to test existence; a real
  # object answers 206, a missing one answers 404 with a NoSuchKey body.
  build_has_image() {
    local id=$1 code
    code=$(curl -sSL --max-time 45 -o /dev/null -r 0-1023 -w '%{http_code}' \
      "${BUILD_API}/builds/${id}/${CF_TARGET}/attempts/latest/artifacts/${CF_PRODUCT}-img-${id}.zip/url?redirect=true" 2>/dev/null)
    [ "$code" = 206 ] || [ "$code" = 200 ]
  }

  # NOTE: this runs inside $( ), so stdout IS the return value. Every diagnostic here must go to
  # stderr or it is silently swallowed into the captured build id — which is exactly how an earlier
  # version managed to fail with no explanation at all.
  BUILD_LIST_RAW=/tmp/cf_buildlist.json
  resolve_build_id() {
    local list ids id n
    # No server-side `successful` filter: it is not reliably honoured, and the artifact probe below
    # is a stricter test anyway — a build with a published image is good by definition.
    list=$(curl -sS --max-time 30 \
      "${BUILD_API}/builds?branch=${BRANCH}&buildType=submitted&target=${CF_TARGET}&maxResults=40" 2>/dev/null)
    printf '%s' "$list" > "$BUILD_LIST_RAW"

    if [ -z "$list" ]; then
      c_warn "build API returned nothing (network or DNS)" >&2
      return 1
    fi
    # The legacy v3 API is being retired and throttles anonymous callers hard. Its 403 is not a
    # missing build, so say so rather than letting it look like one.
    if printf '%s' "$list" | grep -q rateLimitExceeded; then
      c_warn "build API is rate-limiting this IP (legacy v3 API); cannot list builds" >&2
      return 1
    fi
    ids=$(printf '%s' "$list" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception as e:
    sys.stderr.write("could not parse build list as JSON: %s\n" % e); sys.exit(1)
if "error" in d:
    sys.stderr.write("build API error: %s\n" % d["error"].get("message","?")); sys.exit(1)
for b in d.get("builds", []):
    if b.get("buildId"): print(b["buildId"])
')
    if [ -z "$ids" ]; then
      c_warn "build API listed no builds for ${BRANCH}/${CF_TARGET}; raw response in ${BUILD_LIST_RAW}" >&2
      return 1
    fi
    n=$(printf '%s\n' "$ids" | wc -l | tr -d ' ')
    c_info "build API listed ${n} builds; probing newest first for a published image" >&2
    for id in $ids; do
      if build_has_image "$id"; then printf '%s' "$id"; return 0; fi
      c_info "  build ${id}: no image zip" >&2
    done
    c_warn "none of the ${n} listed builds has a published image zip" >&2
    return 1
  }

  if [ -n "${CF_BUILD_ID:-}" ]; then
    c_ok "using pinned CF_BUILD_ID=${CF_BUILD_ID}"
  else
    c_info "resolving newest build that has a published image"
    CF_BUILD_ID=$(resolve_build_id) \
      || die "could not find a build with a published image for ${BRANCH}/${CF_TARGET}.
  The reason is on the lines just above; raw API response is in ${BUILD_LIST_RAW}.

  Pick a build by hand from https://ci.android.com/builds/branches/${BRANCH}/grid — choose a green
  one that lists ${CF_PRODUCT}-img-<id>.zip among its artifacts — then re-run pinned to it:

      CF_BUILD_ID=<id> $0"
    c_ok "build ${CF_BUILD_ID} has a published image"
  fi

  c_info "downloading, this is several GB"
  fetch_once() { cvd fetch --default_build="${CF_BUILD_ID}/${CF_TARGET}" >/tmp/cf_fetch.log 2>&1; }
  if retry 4 45 "cvd fetch" fetch_once; then
    c_ok "image fetched via cvd fetch (build ${CF_BUILD_ID})"
  else
    c_warn "cvd fetch failed; see /tmp/cf_fetch.log"
    rate_limited /tmp/cf_fetch.log \
      && c_warn "the log shows rate limiting — waiting an hour and re-running is likely enough"
    cat <<EOF

  Manual fallback. Note that ci.android.com is a JavaScript app: fetching an artifact path with
  curl returns its HTML shell, not the file. Go through the build API instead, which redirects to
  real storage:

      cd $PWD
      B=${CF_BUILD_ID}
      for A in ${CF_PRODUCT}-img-\$B.zip cvd-host_package.tar.gz; do
        curl -L -o "\$A" \\
          "${BUILD_API}/builds/\$B/${CF_TARGET}/attempts/latest/artifacts/\$A/url?redirect=true"
      done
      unzip -o ${CF_PRODUCT}-img-\$B.zip && tar xzf cvd-host_package.tar.gz

  Then re-run this script.
EOF
    exit 1
  fi
  mark image
fi
c_ok "device image present at $WORKDIR/image"

# ---------------------------------------------------------------- smoke test
echo; echo "== smoke test: boot one instance, then tear down =="
cd "$WORKDIR/image"
cvd stop >/dev/null 2>&1 || true

START=$(date +%s)
cvd start --start_webrtc=true --report_anonymous_usage_stats=n --daemon >/tmp/cf_start.log 2>&1 \
  || die "cvd start failed. Last lines:
$(tail -25 /tmp/cf_start.log)"

BOOTED=no
for _ in $(seq 1 300); do
  if adb -s 0.0.0.0:6520 shell getprop sys.boot_completed 2>/dev/null | grep -q 1; then
    BOOTED=yes; break
  fi
  sleep 1
done
ELAPSED=$(( $(date +%s) - START ))

if [ "$BOOTED" != yes ]; then
  cvd stop >/dev/null 2>&1 || true
  die "instance did not reach boot_completed in 300s. See /tmp/cf_start.log"
fi
c_ok "booted in ${ELAPSED}s"
cvd stop >/dev/null 2>&1 || true
c_ok "torn down cleanly"
mark verified

# The repo may be checked out anywhere, so resolve the spikes directory from THIS script's own
# location rather than guessing a path relative to the image directory. The previous form assumed
# the checkout sat next to $WORKDIR and printed a path that did not exist.
SPIKES_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

cat <<EOF

================== READY ==================
  cold boot on this host: ${ELAPSED}s
  image dir:              ${WORKDIR}/image

  Run the spikes from the image directory:

      cd ${WORKDIR}/image
      ${SPIKES_DIR}/spike1_latency.sh       # then measure with a 240fps camera
      ${SPIKES_DIR}/spike2_android_density.sh

  Spike 1 needs the camera protocol in spikes/README.md — a software timer cannot pass it.
  Spike 2a runs two passes (~1-2h) and prints the interactive/automated density ratio.

  NOTE: this smoke test booted with default graphics. Snapshot/restore additionally needs
        --gpu_mode=guest_swiftshader --enable_virtiofs=false — see docs/HARDWARE_DAY.md step 8.
===========================================
EOF
