#!/usr/bin/env bash
#
# The TURN relay ADR-0005 chose, so that a live device view works from somewhere other than the
# farm's own network.
#
# WHY THIS EXISTS AT ALL. WebRTC connects the browser straight to the device host, and it can only
# do that over an address both ends can route to. On a laptop in the same office that is a direct
# candidate and this relay is never used. From a phone hotspot, from a cafe, from behind almost any
# corporate NAT, there is no such address — and the failure shape is the worst kind: a populated
# device list, a session that says ACTIVE, and a black rectangle with nothing in any log.
#
# WHAT IT IS NOT. It is not authorisation. A credential minted here buys bandwidth through the relay
# for a few hours; it names no device and opens no session. Driving a device still requires the
# Ed25519 grant the worker verifies offline, and ADR-0005 is explicit that the relay is a route.
#
# WHERE IT RUNS. On the DEVICE host by preference — the relay wants to be near the media source, and
# that machine already has the ports. It is the only part of the farm that is deliberately reachable
# on UDP from the internet, so the cloud firewall has to be opened for it: 3478/udp, 3478/tcp, and
# 49152-65535/udp for the relayed streams themselves.
#
# WHAT IT COSTS. Bandwidth, and this is the one number in the whole system that scales with VIEWERS
# rather than with devices (ADR-0005 says so plainly). A relayed 720p-ish software-rendered stream is
# a few hundred kbit/s; ten simultaneous viewers is a few megabits of egress, continuously.
set -euo pipefail

# The farm's two public names, from one place. Environment wins, so a one-off override still works.
FARM_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/farm.env"
# shellcheck disable=SC1090
[ -f "$FARM_ENV" ] && . "$FARM_ENV"
# The address coturn ADVERTISES, and it must be an IP ADDRESS — coturn's `external-ip` will not take
# a hostname, and a name there produces a server that starts cleanly and hands clients an address
# they cannot use. `MFARM_TURN_HOST` became a hostname the day the farm moved to a domain, so it is
# resolved here rather than passed through.
_turn_host="${MFARM_TURN_HOST:-}"
case "$_turn_host" in
  # Already an IPv4 literal: use it as-is.
  [0-9]*.[0-9]*.[0-9]*.[0-9]*) _turn_ip="$_turn_host" ;;
  "") _turn_ip="" ;;
  *) _turn_ip="$(getent hosts "$_turn_host" 2>/dev/null | awk '{print $1; exit}')"
     [ -n "$_turn_ip" ] || _turn_ip="$(dig +short "$_turn_host" 2>/dev/null | grep -E '^[0-9.]+$' | head -1)" ;;
esac
PUBLIC_IP="${PUBLIC_IP:-${_turn_ip:-$(curl -s --max-time 5 ifconfig.me || true)}}"

# The realm is cosmetic-ish — it appears in the auth exchange — but it should read as this farm
# rather than as a placeholder, so it follows the domain when there is one.
REALM_DEFAULT="${_turn_host:-mfarm.local}"
# The address the NIC actually holds. On a cloud VM this is NOT the public one — the public address
# is NAT'd in front — and coturn needs BOTH: one to bind relay sockets to, one to advertise.
PRIVATE_IP="${PRIVATE_IP:-$(hostname -I | awk '{print $1}')}"
REALM="${TURN_REALM:-$REALM_DEFAULT}"
STATE_DIR="${STATE_DIR:-$(cd "$(dirname "$0")" && pwd)/.state}"
SECRET_FILE="$STATE_DIR/turn_secret"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

[ -n "$PUBLIC_IP" ] || { echo "Set PUBLIC_IP — coturn must advertise an address clients can reach."; exit 1; }
[ -n "$PRIVATE_IP" ] || { echo "Set PRIVATE_IP — coturn must bind its relay sockets to a real local address."; exit 1; }

say "Installing coturn"
if ! command -v turnserver >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq coturn
else
  echo "    already installed: $(turnserver -V 2>&1 | head -1)"
fi

say "Secret"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
if [ ! -f "$SECRET_FILE" ]; then
  # Generated here and never committed, like every other secret in deploy/. The API derives every
  # per-session credential from it with HMAC-SHA1 (`apps/api/src/turn.ts`), so this one value is the
  # whole trust relationship between the control plane and the relay.
  openssl rand -hex 32 > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
  echo "    generated $SECRET_FILE"
else
  echo "    reusing $SECRET_FILE"
fi
SECRET=$(cat "$SECRET_FILE")

say "Writing /etc/turnserver.conf"
# NOTE THE ESCAPED BACKTICKS BELOW. This heredoc is deliberately UNQUOTED, because it has to
# interpolate $PUBLIC_IP, $SECRET and $REALM — which also means the shell performs command
# substitution on anything in backticks. Two prose comments containing `use-auth-secret` and a
# filename were executed as commands on the first real run, printing "Permission denied" from a
# script whose output otherwise read as success. The config values were fine; the comments were
# silently blanked. Escape every backtick here, or use none.
sudo tee /etc/turnserver.conf >/dev/null <<EOF
# MFARM media relay. Managed by setup-turn.sh — edit there, not here.

listening-port=3478
listening-ip=$PRIVATE_IP

# BOTH ADDRESSES, IN THIS EXACT FORM. On a cloud VM the NIC holds a private address and the public
# one is NAT'd in front, so coturn has to be told the mapping: bind and relay on the private
# address, advertise the public one. \`external-ip=PUBLIC/PRIVATE\` is what expresses that.
#
# THIS IS WHAT 486 MEANS. relay-ip was 0.0.0.0 on the first real deployment, which is not an address
# coturn can allocate a relay socket on — so every Allocate was refused with 486 "Allocation Quota
# Reached", which reads like a limit being hit and is nothing of the kind. STUN still worked, so the
# browser gathered host and srflx candidates and looked healthy; only the relay candidate was
# missing, and the peer connection simply never completed.
external-ip=$PUBLIC_IP/$PRIVATE_IP
relay-ip=$PRIVATE_IP

# The relay port range, which must match the cloud firewall rule exactly. Left at coturn's default
# the firewall and the server disagree about which ports carry media, and the symptom is once again
# an allocation that succeeds and a stream that never arrives.
min-port=49152
max-port=65535

# Time-limited credentials (RFC 5766 / the TURN REST draft): the username is an expiry timestamp and
# the password is HMAC-SHA1 of it under this secret. Nothing is provisioned, nothing is revoked, and
# a credential a viewer keeps is worthless once it expires. apps/api/src/turn.ts mints them.
use-auth-secret
static-auth-secret=$SECRET
realm=$REALM

# NOT a general-purpose relay. Without these, anyone who finds this port gets free bandwidth to
# anywhere, and the loopback rules matter more than they look: a relay that will forward to
# 127.0.0.1 lets a stranger reach every service on this box that is bound to loopback precisely
# because it is not meant to be public — the API, the automation gateway, and the operator, which
# is unauthenticated device control.
no-loopback-peers
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
# The device host's own VPC range is allowed back in, because the media source IS on this network.
# Narrow it to the device host's address on a box that shares its subnet with anything else.
allowed-peer-ip=10.160.0.0-10.160.255.255

# A single stream is a few hundred kbit/s. This caps one viewer, so a bug in a client cannot take
# the farm's whole uplink.
#
# Read 486 as a configuration error before believing these numbers: coturn returns "Allocation Quota
# Reached" for several conditions that have nothing to do with a quota, including having no usable
# relay address at all.
user-quota=12
total-quota=120
max-bps=2000000

fingerprint
no-cli
no-tlsv1
no-tlsv1_1
simple-log
EOF

say "Restarting coturn"
# Ubuntu ships coturn disabled behind this flag, and forgetting it produces a service that reports
# active and exits immediately.
echo 'TURNSERVER_ENABLED=1' | sudo tee /etc/default/coturn >/dev/null
sudo systemctl enable coturn >/dev/null 2>&1 || true
sudo systemctl restart coturn
sleep 2
sudo systemctl is-active coturn

say "Point the control plane at it"
cat <<EOF
Add to the API's environment (deploy/.env on the control plane) and restart it:

    TURN_URLS=turn:${_turn_host:-$PUBLIC_IP}:3478,turn:${_turn_host:-$PUBLIC_IP}:3478?transport=tcp
    TURN_SECRET=$SECRET

Then open the cloud firewall for 3478/udp, 3478/tcp and 49152-65535/udp to this host — the same
range as min-port/max-port above.

VERIFY IT FROM OUTSIDE, not from here. A relay that answers on the box and not on the internet is
the exact failure this exists to prevent — use https://icetest.info or Chrome's WebRTC sample with
the credentials above, from a phone on mobile data, and confirm a candidate of type "relay".
EOF
