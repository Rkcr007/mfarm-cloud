#!/usr/bin/env bash
# Make one Cuttlefish device REPORT the handset its profile names — ADR-0016.
#
#   ./apply-device-profile.sh 0.0.0.0:6522 galaxy-s25-ultra
#
# Rewrites the guest's build properties, reboots, and verifies. Run it AFTER the device has cold
# booted with its profile's geometry and BEFORE its first snapshot is taken, so the identity is part
# of the state every reset restores.
#
# ------------------------------------------------------------------ read this before you rely on it
#
# THIS IS THE ONE PART OF A PROFILE THAT IS A LIE. Geometry is honest by construction — the panel
# really is 1440x3120. `ro.product.model` is not: the guest is AOSP on x86_64 and it is about to
# claim to be a Samsung. Two consequences, both real, both accepted deliberately:
#
#   1. The ABI does not change and cannot. `Build.SUPPORTED_ABIS` still says x86_64, which no real
#      Galaxy has ever reported. An arm64-only APK still cannot install here — the control plane's
#      preflight refuses it by name, which is the counterweight that makes this defensible at all.
#   2. An app that branches on `Build.MANUFACTURER == "samsung"` will take a Samsung code path —
#      Knox, the Samsung IME, One UI APIs — that AOSP does not implement. Failures down that branch
#      are THIS SCRIPT'S FAULT, not the app's. It is the first thing to check when a test passes on
#      a real Samsung and fails on the farm.
#
# THE OS VERSION IS DELIBERATELY NOT TOUCHED. `ro.build.version.*` stays whatever the AOSP image
# actually is. Telling an app it is on Android 15 while it runs on 17 changes which
# API-level-conditional branch it takes, so the app under test would exercise code that never runs
# on the device it claims to be — wrong in both directions, and invisible.
#
# DOES THIS SURVIVE A RESET? UNVERIFIED AS OF THIS WRITING, AND IT IS THE FIRST THING TO CHECK.
# `adb remount` gives an overlayfs whose backing store may live on /data, and this farm runs
# CF_RESET_MODE=powerwash, which wipes /data. If the properties do not survive, every device
# silently reverts to `Cuttlefish x86_64` at the first reset — mid-demo, with nothing in any log
# saying so. Verify with:
#
#     ./apply-device-profile.sh <serial> <profile>
#     # ... trigger a reset through the console, then:
#     adb -s <serial> shell getprop ro.product.model
#
# If it reverts, this stops being a one-shot script and becomes a step inside `powerwash()` in
# workers/agent/src/devices/cuttlefish.ts.

set -euo pipefail

SERIAL="${1:-}"
PROFILE="${2:-}"
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

c_ok()   { printf '\033[32m  ok\033[0m  %s\n' "$*"; }
c_info() { printf '\033[36m  ..\033[0m  %s\n' "$*"; }
c_warn() { printf '\033[33m  !!\033[0m  %s\n' "$*"; }
die()    { printf '\033[31mBLOCKED\033[0m %s\n' "$*" >&2; exit 1; }

# BOTH ARGUMENTS ARE REQUIRED, WITH NO DEFAULT SERIAL. A default would eventually be run against
# whichever device adb happened to list first, and on this host that is cf-1 — a working, unprofiled
# device that this whole feature exists to leave alone.
[ -n "$SERIAL" ]  || die "usage: $0 <adb-serial> <profile-id>   (e.g. $0 0.0.0.0:6522 galaxy-s25-ultra)"
[ -n "$PROFILE" ] || die "usage: $0 <adb-serial> <profile-id>   (e.g. $0 0.0.0.0:6522 galaxy-s25-ultra)"

command -v adb >/dev/null || die "adb is not on PATH"

# One definition of the property list, in workers/agent/src/devices/profiles.ts. See that file.
PROPS=$(node --experimental-strip-types "$REPO_ROOT/workers/agent/src/bin/profile-props.ts" "$PROFILE") \
  || die "could not read profile \"$PROFILE\""
[ -n "$PROPS" ] || die "profile \"$PROFILE\" defines no properties"

adb -s "$SERIAL" wait-for-device
c_info "applying $PROFILE to $SERIAL ($(echo "$PROPS" | wc -l | tr -d ' ') properties)"
c_info "currently: $(adb -s "$SERIAL" shell getprop ro.product.model | tr -d '\r')"

adb -s "$SERIAL" root >/dev/null
adb -s "$SERIAL" wait-for-device

# Cuttlefish ships with verity off, so this is usually a no-op — but a build that has it on fails
# `remount` with a message about verity that reads like a permissions problem. Asking for it
# unconditionally costs a reboot at most, and only the first time.
if ! adb -s "$SERIAL" remount >/dev/null 2>&1; then
  c_warn "remount refused; disabling verity and rebooting once"
  adb -s "$SERIAL" disable-verity >/dev/null || true
  adb -s "$SERIAL" reboot
  adb -s "$SERIAL" wait-for-device
  adb -s "$SERIAL" root >/dev/null
  adb -s "$SERIAL" wait-for-device
  adb -s "$SERIAL" remount >/dev/null || die "remount still refused; the image is not writable"
fi

# WRITTEN TO EVERY PARTITION'S build.prop, not just one.
#
# Android composes `ro.product.model` from the partition-scoped properties in the order
# `ro.product.property_source_order` lists, and has done since 10. Setting only the bare key — the
# obvious thing to try — leaves getprop reporting Cuttlefish and looks like the edit silently
# failed. profile-props.ts emits every variant; each is appended to the partition it names, and to
# /system/build.prop for the legacy bare keys.
#
# Appended rather than edited in place: later assignments win in build.prop, so appending overrides
# without a sed that has to match whatever the image already contains.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
: > "$TMP/system.prop"
: > "$TMP/vendor.prop"

while IFS='=' read -r key value; do
  [ -n "$key" ] || continue
  case "$key" in
    ro.product.vendor.*|ro.vendor.build.*) echo "$key=$value" >> "$TMP/vendor.prop" ;;
    *)                                     echo "$key=$value" >> "$TMP/system.prop" ;;
  esac
done <<< "$PROPS"

append_props() {
  local file=$1 target=$2
  [ -s "$file" ] || return 0
  adb -s "$SERIAL" push "$file" /data/local/tmp/profile.prop >/dev/null
  # `cat >>` through the shell rather than a push straight onto the partition: push replaces a file,
  # and build.prop already holds everything else the guest needs to boot.
  adb -s "$SERIAL" shell "cat /data/local/tmp/profile.prop >> $target && rm /data/local/tmp/profile.prop"
  c_ok "appended $(wc -l < "$file" | tr -d ' ') properties to $target"
}

append_props "$TMP/system.prop" /system/build.prop
append_props "$TMP/vendor.prop" /vendor/build.prop

c_info "rebooting to pick up the new properties"
adb -s "$SERIAL" reboot
adb -s "$SERIAL" wait-for-device
# `wait-for-device` returns as soon as adb answers, which is well before the property service has
# read the new build.prop. Waiting for boot_completed is what makes the check below meaningful.
until [ "$(adb -s "$SERIAL" shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 2; done

# VERIFY, rather than assume. Everything above can succeed and still leave the model unchanged if
# the property source order on this image differs from the expected one — which is exactly the sort
# of thing that varies between AOSP builds.
EXPECTED=$(echo "$PROPS" | grep '^ro.product.model=' | cut -d= -f2-)
ACTUAL=$(adb -s "$SERIAL" shell getprop ro.product.model | tr -d '\r')
if [ "$ACTUAL" != "$EXPECTED" ]; then
  die "getprop ro.product.model is \"$ACTUAL\", expected \"$EXPECTED\" — the properties did not take"
fi

c_ok "ro.product.model     = $ACTUAL"
c_ok "ro.product.manufacturer = $(adb -s "$SERIAL" shell getprop ro.product.manufacturer | tr -d '\r')"
c_ok "$SERIAL now reports itself as $PROFILE"
printf '\n'
c_warn "TAKE A FRESH SNAPSHOT NOW — a restore from a snapshot taken before this reverts the identity."
c_warn "Then reset the device once and re-run getprop. If it reverts, read the header of this script."
