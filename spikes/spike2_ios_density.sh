#!/usr/bin/env bash
# Spike 2b — iOS simulator density.
# PASS: >= 6 concurrent booted simulators on a 24 GB Mac, each still responsive.
# Requires FULL Xcode (not Command Line Tools) — simctl ships with Xcode only.
set -euo pipefail

MAX="${MAX:-16}"
OUT="${OUT:-ios_density.csv}"

[ "$(uname -s)" = "Darwin" ] || { echo "BLOCKED: macOS required." >&2; exit 1; }
xcrun simctl help >/dev/null 2>&1 || cat <<'EOF' >&2
BLOCKED: simctl not available.

You have Command Line Tools, not full Xcode. Install Xcode from the App Store, then:
    sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
    xcodebuild -runFirstLaunch
EOF
xcrun simctl help >/dev/null 2>&1 || exit 1

CORES=$(sysctl -n hw.ncpu)
TOTAL_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
echo "host: ${CORES} cores, ${TOTAL_GB} GB RAM"
[ "$TOTAL_GB" -lt 16 ] && echo "WARNING: ${TOTAL_GB} GB is well under the 24 GB reference. Density here will not generalise."

RUNTIME=$(xcrun simctl list runtimes -j | python3 -c 'import json,sys; r=[x for x in json.load(sys.stdin)["runtimes"] if x["isAvailable"] and "iOS" in x["name"]]; print(r[-1]["identifier"] if r else "")')
[ -n "$RUNTIME" ] || { echo "BLOCKED: no available iOS runtime. Install one via Xcode > Settings > Components." >&2; exit 1; }
DEVTYPE=$(xcrun simctl list devicetypes -j | python3 -c 'import json,sys; d=[x for x in json.load(sys.stdin)["devicetypes"] if "iPhone" in x["name"]]; print(d[-1]["identifier"])')
echo "runtime: $RUNTIME"
echo "device:  $DEVTYPE"

echo "n,booted,rss_total_mb,mem_free_pct,load1,boot_ms,verdict" > "$OUT"
UDIDS=()

cleanup() {
  echo; echo "=== teardown ==="
  for u in "${UDIDS[@]:-}"; do xcrun simctl shutdown "$u" 2>/dev/null || true; xcrun simctl delete "$u" 2>/dev/null || true; done
  echo "removed ${#UDIDS[@]} simulator(s)"
}
trap cleanup EXIT

for n in $(seq 1 "$MAX"); do
  echo "--- ramping to ${n} simulator(s) ---"
  UDID=$(xcrun simctl create "spike-$n" "$DEVTYPE" "$RUNTIME")
  UDIDS+=("$UDID")

  S=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
  xcrun simctl boot "$UDID" 2>/dev/null || true
  # bootstatus blocks until the device finishes booting
  timeout 240 xcrun simctl bootstatus "$UDID" >/dev/null 2>&1 || true
  E=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
  BOOT_MS=$(echo "($E - $S) * 1000" | bc | cut -d. -f1)

  sleep 10
  BOOTED=$(xcrun simctl list devices booted | grep -c Booted || true)
  RSS=$(ps -Ao rss,comm | grep -Ei 'SimulatorTrampoline|launchd_sim|CoreSimulator' | awk '{s+=$1} END {printf "%.0f", s/1024}')
  FREEPCT=$(memory_pressure | tail -1 | grep -o '[0-9]*' | head -1)
  LOAD=$(sysctl -n vm.loadavg | awk '{print $2}')

  VERDICT=ok
  [ "${FREEPCT:-100}" -lt 10 ] 2>/dev/null && VERDICT=ram_bound
  awk -v l="$LOAD" -v c="$CORES" 'BEGIN{exit !(l > c*1.5)}' && VERDICT=cpu_bound
  [ "$BOOT_MS" -gt 90000 ] 2>/dev/null && VERDICT=boot_degraded
  [ "$BOOTED" -lt "$n" ] && VERDICT=boot_failed

  echo "${n},${BOOTED},${RSS},${FREEPCT},${LOAD},${BOOT_MS},${VERDICT}" | tee -a "$OUT"

  if [ "$VERDICT" != "ok" ]; then
    echo; echo "=== CLIFF at n=${n}, cause=${VERDICT} ==="
    echo "usable density = $((n - 1)) simulators on ${CORES} cores / ${TOTAL_GB} GB"
    echo "PASS requires >= 6. $([ $((n-1)) -ge 6 ] && echo PASS || echo FAIL)"
    break
  fi
done

echo; echo "results: $OUT"
echo "Reminder: reset in production is a data-container swap (1-2 s), not a reboot (the boot_ms above)."
