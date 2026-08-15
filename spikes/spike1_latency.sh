#!/usr/bin/env bash
# Spike 1 — glass-to-glass latency.
# PASS: < 120 ms p50, camera-measured, before any tuning.
# Requires: Linux, /dev/kvm, Cuttlefish (cuttlefish-base + cuttlefish-user), a CF device image.
set -euo pipefail

fail() { echo "BLOCKED: $*" >&2; exit 1; }

echo "=== preflight ==="
[ "$(uname -s)" = "Linux" ] || fail "Cuttlefish requires Linux. This is $(uname -s)."
[ -e /dev/kvm ]             || fail "/dev/kvm missing. Bare metal with virtualisation enabled is required."
[ -r /dev/kvm ] && [ -w /dev/kvm ] || fail "no rw on /dev/kvm — add yourself to the 'kvm' group and re-login."
command -v cvd >/dev/null   || fail "cvd not found. Install cuttlefish-base and cuttlefish-user."
echo "host: $(nproc) cores, $(free -g | awk '/^Mem:/{print $2}') GB RAM, kvm OK"

WEBRTC_PORT="${WEBRTC_PORT:-8443}"

echo
echo "=== launching one Cuttlefish instance with WebRTC ==="
# --gpu_mode: 'guest_swiftshader' is the cheap/portable default. If the density spike shows the
# idle-CPU burn measured on the laptop reproduces here, retest with --gpu_mode=none.
cvd start \
  --start_webrtc=true \
  --webrtc_device_id=spike1 \
  --gpu_mode="${GPU_MODE:-guest_swiftshader}" \
  --report_anonymous_usage_stats=n \
  --daemon

echo
echo "waiting for boot..."
START=$(date +%s.%N)
for _ in $(seq 1 300); do
  if adb -s 0.0.0.0:6520 shell getprop sys.boot_completed 2>/dev/null | grep -q 1; then
    echo "BOOT_SECONDS=$(echo "$(date +%s.%N) - $START" | bc)"
    break
  fi
  sleep 1
done

cat <<EOF

=== spike 1 is now a MANUAL measurement ===

  1. Open  https://localhost:${WEBRTC_PORT}/  and connect to device 'spike1'.
  2. Start a millisecond stopwatch app on the device.
  3. Film the browser window at 240 fps alongside the device's own reported time.
  4. Step frame by frame. glass-to-glass = real time - streamed time, same frame.
  5. Take 20 samples. Report p50 and p95.

  PASS  = p50 < 120 ms untuned.
  FAIL  = the 100 ms product target is not reachable; change the positioning, not the codec.

  For tuning only (NOT the pass/fail number), paste latency_probe.js into DevTools on that page.
  It reports a pipeline lower bound and cannot see capture or display delay.

  Tear down with:  cvd stop
EOF
