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
    - a VPS without nested virtualisation (Hetzner Cloud, most shared VMs) -> use BARE METAL
    - virtualisation disabled in BIOS
  Vultr Bare Metal, Latitude.sh and Equinix Metal all expose /dev/kvm."
c_ok "/dev/kvm present"

CORES=$(nproc); RAM_GB=$(free -g | awk '/^Mem:/{print $2}'); DISK_GB=$(df -BG --output=avail "$HOME" | tail -1 | tr -dc 0-9)
echo "  host: ${CORES} cores, ${RAM_GB} GB RAM, ${DISK_GB} GB free"
[ "$RAM_GB" -lt 16 ] && c_warn "${RAM_GB} GB RAM is thin for a density ramp; expect an early cliff"
[ "$DISK_GB" -lt 60 ] && c_warn "${DISK_GB} GB free; images + snapshots need ~40 GB"
sudo -n true 2>/dev/null || c_info "sudo password will be requested"

# ---------------------------------------------------------------- phase 1: packages
if ! phase_done pkgs; then
  echo; echo "== phase 1: build and install Cuttlefish =="
  sudo apt-get update -qq
  sudo apt-get install -y -qq git devscripts equivs config-package-dev debhelper-compat \
       golang curl unzip python3 f2fs-tools android-sdk-platform-tools bc >/dev/null
  c_ok "build deps installed"

  mkdir -p "$WORKDIR"; cd "$WORKDIR"
  if [ -d android-cuttlefish/.git ]; then
    git -C android-cuttlefish pull --ff-only >/dev/null 2>&1 || c_warn "pull failed, using existing checkout"
  else
    git clone --depth 1 "$CF_REPO" >/dev/null 2>&1 || die "clone failed: $CF_REPO"
  fi
  cd android-cuttlefish
  c_ok "source at $PWD"

  c_info "building debs (several minutes)"
  if [ -x tools/buildutils/build_packages.sh ]; then
    ./tools/buildutils/build_packages.sh >/tmp/cf_build.log 2>&1 \
      || die "build failed. Last lines:
$(tail -25 /tmp/cf_build.log)
  The upstream build steps change; check $CF_REPO README."
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
  c_ok "cuttlefish-base + cuttlefish-user installed"

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
  c_info "downloading, this is several GB"
  if cvd fetch --default_build="${BRANCH}/${CF_TARGET}" >/tmp/cf_fetch.log 2>&1; then
    c_ok "image fetched via cvd fetch"
  else
    c_warn "cvd fetch failed; see /tmp/cf_fetch.log"
    cat <<EOF

  Manual fallback — from https://ci.android.com/ pick branch ${BRANCH},
  target ${CF_TARGET}, latest green build, then download into $PWD:

      aosp_cf_*-img-*.zip      (the device image)
      cvd-host_package.tar.gz  (the host tools)

  and unpack:

      unzip aosp_cf_*-img-*.zip && tar xzf cvd-host_package.tar.gz

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

cat <<EOF

================== READY ==================
  cold boot on this host: ${ELAPSED}s
  image dir:              ${WORKDIR}/image

  Run the spikes from that directory:

      cd ${WORKDIR}/image
      ${PWD%/image}/../spikes/spike1_latency.sh       # then measure with a 240fps camera
      ${PWD%/image}/../spikes/spike2_android_density.sh

  Spike 1 needs the camera protocol in spikes/README.md — a software timer cannot pass it.
  Spike 2a runs two passes (~1-2h) and prints the interactive/automated density ratio.
===========================================
EOF
