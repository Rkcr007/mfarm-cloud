#!/usr/bin/env bash
# Spike 2a — Android density, with a two-pass GPU comparison.
#
# PASS: >= 12 concurrent instances on a 128 GB box, each still meeting spike 1's latency.
#
# Runs the ramp TWICE and compares:
#   pass 1  "interactive"  rendering on  (guest_swiftshader) + WebRTC  -- what a human session costs
#   pass 2  "automated"    rendering off (none)              , no WebRTC -- what a CI run costs
#
# The delta answers the open question from the laptop measurements: does an idle instance really
# burn a core, and if so is it SwiftShader compositing frames nobody is watching? If pass 2 is
# materially denser, the v2 rule "no encoder unless a viewer is attached" must extend to RENDERING,
# and the automated tier can be priced well below the interactive one.
#
# Runtime: roughly (MAX * 50s * 2). Budget an hour or two.
set -euo pipefail

BACKEND="${BACKEND:-cvd}"     # cvd | avd
MAX="${MAX:-32}"
OUT="${OUT:-density.csv}"
SETTLE="${SETTLE:-45}"        # seconds to let an instance finish booting before sampling
CPU_WINDOW="${CPU_WINDOW:-5}" # seconds over which instantaneous CPU is sampled

CORES=$(nproc)
TOTAL_MB=$(free -m | awk '/^Mem:/{print $2}')

[ "$(uname -s)" = "Linux" ] || { echo "BLOCKED: needs Linux + KVM. This is $(uname -s)." >&2; exit 1; }
[ -e /dev/kvm ] || { echo "BLOCKED: /dev/kvm missing." >&2; exit 1; }
[ "$BACKEND" = "avd" ] && [ -z "${AVD_NAME:-}" ] && { echo "BLOCKED: set AVD_NAME for the avd backend." >&2; exit 1; }

echo "host: ${CORES} cores, ${TOTAL_MB} MB RAM, backend=${BACKEND}"
echo "mode,n,rss_total_mb,mem_avail_mb,cpu_pct_of_one_core,cpu_per_instance,load1,probe_ms,verdict" > "$OUT"

PROC_RE='crosvm|qemu-system'

# --- instantaneous CPU -------------------------------------------------------------------------
# NOT `ps -o pcpu`: that reports an average over the whole process lifetime, so a freshly booted
# emulator looks permanently busy because its 35s boot is baked into the average. This was the flaw
# in the original laptop measurement. Read /proc jiffies and take a delta over a real window.
jiffies_of() {
  local total=0 p s
  for p in $(pgrep -f "$PROC_RE" 2>/dev/null || true); do
    [ -r "/proc/$p/stat" ] || continue
    read -r -a s < "/proc/$p/stat" || continue
    total=$(( total + ${s[13]:-0} + ${s[14]:-0} ))   # utime + stime
  done
  echo "$total"
}

cpu_instant() {
  local a b hz
  hz=$(getconf CLK_TCK)
  a=$(jiffies_of); sleep "$CPU_WINDOW"; b=$(jiffies_of)
  awk -v d=$(( b - a )) -v hz="$hz" -v w="$CPU_WINDOW" 'BEGIN{ printf "%.1f", (d/hz)/w*100 }'
}

probe() {
  local serial="$1" s e
  s=$(date +%s%3N)
  adb -s "$serial" shell getprop sys.boot_completed >/dev/null 2>&1 || return 1
  e=$(date +%s%3N)
  echo $(( e - s ))
}

teardown() {
  case "$BACKEND" in
    cvd) cvd stop >/dev/null 2>&1 || true ;;
    avd) adb devices | awk 'NR>1 && $1 ~ /emulator/ {print $1}' \
           | xargs -r -I{} adb -s {} emu kill >/dev/null 2>&1 || true ;;
  esac
  sleep 10
  pkill -f "$PROC_RE" >/dev/null 2>&1 || true
  sleep 5
}
trap teardown EXIT

boot_to() {
  local n="$1" gpu="$2" webrtc="$3"
  case "$BACKEND" in
    cvd)
      cvd start --num_instances="$n" \
        --start_webrtc="$webrtc" \
        --gpu_mode="$gpu" \
        --report_anonymous_usage_stats=n --daemon >/dev/null 2>&1
      ;;
    avd)
      local port=$(( 5554 + 2 * (n - 1) ))
      nohup "$ANDROID_HOME/emulator/emulator" -avd "$AVD_NAME" -port "$port" \
        -no-window -no-audio -no-boot-anim -gpu "$gpu" -read-only >/dev/null 2>&1 &
      ;;
  esac
}

# --- one ramp ----------------------------------------------------------------------------------
# echoes "<usable_density> <cause> <cpu_per_instance_at_cliff>" on stdout; logs go to stderr
run_ramp() {
  local mode="$1" gpu="$2" webrtc="$3"
  local cliff=0 cause=maxed cpi=0

  echo >&2; echo "################ PASS: ${mode}  (gpu=${gpu}, webrtc=${webrtc}) ################" >&2
  teardown

  for n in $(seq 1 "$MAX"); do
    echo "--- ${mode}: ramping to ${n} ---" >&2
    boot_to "$n" "$gpu" "$webrtc"
    sleep "$SETTLE"

    local rss avail cpu load first ms cpi_now verdict
    rss=$(ps -eo rss,comm | grep -Ei "$PROC_RE" | awk '{s+=$1} END {printf "%.0f", s/1024}')
    avail=$(free -m | awk '/^Mem:/{print $7}')
    cpu=$(cpu_instant)
    load=$(awk '{print $1}' /proc/loadavg)
    cpi_now=$(awk -v c="$cpu" -v n="$n" 'BEGIN{printf "%.1f", c/n}')
    first=$(adb devices | awk 'NR==2{print $1}')
    ms=$(probe "$first" 2>/dev/null || echo -1)

    verdict=ok
    awk -v c="$cpu"   -v n="$CORES"    'BEGIN{exit !(c > n*100*0.9)}'  && verdict=cpu_bound
    awk -v l="$load"  -v n="$CORES"    'BEGIN{exit !(l > n*1.5)}'      && verdict=cpu_bound
    awk -v a="$avail" -v t="$TOTAL_MB" 'BEGIN{exit !(a < t*0.10)}'     && verdict=ram_bound
    [ "$ms" -gt 500 ] 2>/dev/null && verdict=unresponsive
    [ "$ms" -lt 0 ]  2>/dev/null && verdict=unresponsive

    echo "${mode},${n},${rss},${avail},${cpu},${cpi_now},${load},${ms},${verdict}" | tee -a "$OUT" >&2

    cpi="$cpi_now"
    if [ "$verdict" != "ok" ]; then
      cliff=$(( n - 1 )); cause="$verdict"; break
    fi
    cliff="$n"
  done

  teardown
  echo "${cliff} ${cause} ${cpi}"
}

read -r D_INT C_INT CPI_INT <<< "$(run_ramp interactive "${GPU_INTERACTIVE:-guest_swiftshader}" true)"
read -r D_AUT C_AUT CPI_AUT <<< "$(run_ramp automated   "${GPU_AUTOMATED:-none}"                false)"

# --- comparison --------------------------------------------------------------------------------
echo
echo "================== SPIKE 2a RESULT =================="
printf 'host                     %s cores, %s MB RAM\n' "$CORES" "$TOTAL_MB"
printf '%-14s %-10s %-12s %-22s\n' "pass" "density" "stopped by" "CPU per idle instance"
printf '%-14s %-10s %-12s %-22s\n' "interactive" "$D_INT" "$C_INT" "${CPI_INT}% of one core"
printf '%-14s %-10s %-12s %-22s\n' "automated"   "$D_AUT" "$C_AUT" "${CPI_AUT}% of one core"

echo
if [ "${D_INT:-0}" -ge 12 ]; then
  echo "PASS: interactive density ${D_INT} >= 12 threshold."
else
  echo "FAIL: interactive density ${D_INT} < 12 threshold. Cost model in v2 §3 needs revising."
fi

if [ "${D_INT:-0}" -gt 0 ] && [ "${D_AUT:-0}" -gt 0 ]; then
  awk -v i="$D_INT" -v a="$D_AUT" -v ci="$CPI_INT" -v ca="$CPI_AUT" 'BEGIN{
    r = a/i;
    printf "\nautomated tier is %.2fx the density of interactive\n", r;
    printf "  -> automated device-hour costs %.0f%% of an interactive one\n", 100/r;
    if (r >= 1.5)
      print "  -> CONFIRMED: idle rendering is a real cost. Extend the \"no encoder without a viewer\"\n     rule to RENDERING, and price the automated tier separately. This is a live pricing lever.";
    else if (r <= 1.15)
      print "  -> NOT confirmed: rendering is not the binding cost here. The laptop CPU finding was an\n     artifact of ps lifetime-average CPU. Drop the two-tier idea and keep one price.";
    else
      print "  -> Marginal. Worth a second run at higher MAX before deciding.";
    if (ci > 60)
      printf "  -> idle instances burn %.0f%% of a core even interactively: CPU binds before RAM,\n     and v2 §3 density figures are optimistic.\n", ci;
  }'
fi

echo
echo "raw rows: $OUT"
echo "Next: re-run spike1_latency.sh at the interactive density to confirm latency holds under load."
