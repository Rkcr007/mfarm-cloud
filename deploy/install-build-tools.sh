#!/usr/bin/env bash
# Give the device host what `appium:app` needs: a JDK and Android Build Tools.
#
# WHY THIS EXISTS. The lab box ran real WebDriver sessions for days without either of these, because
# a session that names an ALREADY-INSTALLED package needs neither. The moment a suite ships its own
# APK — which is what almost every real Appium suite does — session creation fails inside the driver
# and the hub surfaces it as `upstream_rejected`, several hops from the cause:
#
#   Could not find 'aapt2' in [...]. Do you have Android Build Tools installed at '/usr/lib/android-sdk'?
#   Cannot verify the signature of '<app>.apk'. Could not find 'apksigner.jar' in [...]
#
# UiAutomator2 reads the APK's manifest with aapt2 and checks its signature with apksigner, and both
# live in build-tools. `cuttlefish-common` installs only platform-tools, so a farm built from
# spikes/bootstrap_cuttlefish.sh has adb and nothing else. Found on 2026-08-23 while measuring
# rendering; see deploy/verify-render.mjs.
#
# NOT available from apt: Ubuntu ships google-android-build-tools up to r24, and aapt2 arrived in
# r26. The SDK's own sdkmanager is the only supported source.
#
# Idempotent, and safe to re-run. Requires sudo.
#
#   ./deploy/install-build-tools.sh
#   BUILD_TOOLS_VERSION=35.0.0 ./deploy/install-build-tools.sh

set -euo pipefail

ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/lib/android-sdk}}"
BUILD_TOOLS_VERSION="${BUILD_TOOLS_VERSION:-35.0.0}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$ANDROID_HOME" ] || die "no SDK at $ANDROID_HOME — run spikes/bootstrap_cuttlefish.sh first"

if [ -x "$ANDROID_HOME/build-tools/$BUILD_TOOLS_VERSION/aapt2" ] \
   && [ -f "$ANDROID_HOME/build-tools/$BUILD_TOOLS_VERSION/lib/apksigner.jar" ]; then
  note "build-tools $BUILD_TOOLS_VERSION already present at $ANDROID_HOME"
  exit 0
fi

# ---- 1. a JVM. sdkmanager IS a Java program, and apksigner is run as `java -jar`. The lab box had
#         no JVM at all: Appium is Node and the UiAutomator2 server ships prebuilt, so nothing had
#         needed one until an APK had to be verified.
say "Java"
if ! command -v java >/dev/null; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openjdk-21-jre-headless >/dev/null
fi
JAVA_HOME="${JAVA_HOME:-$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")}"
note "$(java -version 2>&1 | head -1)  (JAVA_HOME=$JAVA_HOME)"

# ---- 2. cmdline-tools, which is what carries sdkmanager.
say "Command-line tools"
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "$SDKMANAGER" ]; then
  # Scraped rather than pinned: the filename carries a build number that changes with every release,
  # and a pinned URL becomes a 404 rather than an old-but-working download.
  url="$(curl -fsSL https://developer.android.com/studio \
        | grep -oE 'https://dl\.google\.com/android/repository/commandlinetools-linux-[0-9]+_latest\.zip' \
        | head -1)"
  [ -n "$url" ] || die "could not find the cmdline-tools download URL on developer.android.com"
  note "$url"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/c.zip" "$url"
  ( cd "$tmp" && unzip -q c.zip )
  sudo mkdir -p "$ANDROID_HOME/cmdline-tools"
  sudo rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  sudo mv "$tmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
fi
note "sdkmanager at $SDKMANAGER"

# ---- 3. the build tools themselves.
say "Build tools $BUILD_TOOLS_VERSION"
yes | sudo env JAVA_HOME="$JAVA_HOME" "$SDKMANAGER" --sdk_root="$ANDROID_HOME" --licenses >/dev/null 2>&1 || true
sudo env JAVA_HOME="$JAVA_HOME" "$SDKMANAGER" --sdk_root="$ANDROID_HOME" "build-tools;$BUILD_TOOLS_VERSION" >/dev/null

aapt2="$ANDROID_HOME/build-tools/$BUILD_TOOLS_VERSION/aapt2"
signer="$ANDROID_HOME/build-tools/$BUILD_TOOLS_VERSION/lib/apksigner.jar"
[ -x "$aapt2" ] || die "aapt2 missing after install"
[ -f "$signer" ] || die "apksigner.jar missing after install"
note "$("$aapt2" version)"
note "apksigner.jar present"

# APPIUM CACHES THE SDK LAYOUT AT STARTUP. Installing build-tools under a running server changes
# nothing until it restarts — verified here on 2026-08-23, where a session kept reporting
# apksigner.jar missing from a path list that no longer reflected the disk.
say "Restart the worker so Appium re-reads the SDK"
note "sudo systemctl restart mfarm-worker   # then wait ~15s for Appium to answer /status"
