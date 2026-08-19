#!/usr/bin/env bash
#
# Put the console behind real TLS on a public hostname, without buying a domain.
#
# WHY sslip.io. `34-100-138-213.sslip.io` resolves to 34.100.138.213 by construction, so Let's
# Encrypt can satisfy an HTTP-01 challenge against it and issue a genuine certificate. No DNS to
# configure and nothing to renew by hand. When a real domain arrives, one A record and one line in
# the Caddyfile replaces it — the cert story does not change.
#
# THE ADDRESS IS RESERVED, and it has to be. This hostname IS the IP, so an ephemeral address makes
# the URL and its certificate expire together every time the box stops — a link sent to a teammate
# on Tuesday is dead on Wednesday. `mfarm-lab-ip` (34.100.138.213) is a reserved static address in
# asia-south1; it costs about ₹250/month while attached and is the entire reason the console has a
# permanent home.
#
# WHAT STAYS PRIVATE. The API keeps its 127.0.0.1 bind; Caddy is the only public listener. The
# metrics listener on :9464 carries fleet-wide cross-tenant gauges and is deliberately NOT proxied.
#
# TWO upstreams since ADR-0007, not one. `/dp/<hostId>` is proxied to the WORKER's data plane so a
# browser can open the live-view WebSocket over this same TLS name — which is what keeps the socket
# same-origin and the console's strict CSP unwidened. The worker itself still publishes no port: it
# binds loopback or the VPC address, and this is the only route in.
#
# THIS PROXY IS NOT AUTHORISATION and must not be mistaken for it. Every connection through it still
# has to present an Ed25519 grant naming session, device, org, fence and host, which the worker
# verifies offline. Caddy is a route (ADR-0005), and the automation gateway is deliberately NOT
# proxied here — the hub reaches it host-locally and it has no business being public.
set -euo pipefail

# The farm's two public names, from one place. Environment wins, so a one-off override still works.
FARM_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/farm.env"
# shellcheck disable=SC1090
[ -f "$FARM_ENV" ] && . "$FARM_ENV"
HOSTNAME_PUBLIC="${HOSTNAME_PUBLIC:-${MFARM_PUBLIC_HOST:-34-100-138-213.sslip.io}}"
UPSTREAM="127.0.0.1:3000"
# The device host's data plane, reached over the VPC (ADR-0006 put it on its own machine). Empty
# disables the /dp route entirely, which is the right setting for a control plane with no worker
# behind it — a route to nothing answers 502 and looks like a broken live view.
WORKER_DATA_PLANE="${WORKER_DATA_PLANE:-10.160.0.2:8080}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Installing Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq caddy
else
  echo "    already installed: $(caddy version)"
fi

say "Writing the Caddyfile for $HOSTNAME_PUBLIC"
# The whole /dp stanza is built here rather than templated inline, so that "no worker" produces a
# Caddyfile with no such route at all instead of one pointing at nothing. A route to an absent
# upstream answers 502, which in a browser is indistinguishable from a broken live view.
if [ -n "$WORKER_DATA_PLANE" ]; then
  echo "    /dp/* -> $WORKER_DATA_PLANE (live view)"
  DP_BLOCK=$(cat <<DPEOF

	# The live-view data plane (ADR-0007). The path segment is the HOST id, which is how this
	# generalises past one device host: add a matcher per host id and point each at its worker. At
	# one host the id is not consulted, and the worker rejects anything whose grant names a
	# different host anyway — the audience check is in the token, not in this file.
	#
	# NOT AUTHORISATION. Every connection through here still presents an Ed25519 grant that the
	# worker verifies offline. This is a route (ADR-0005).
	@dataplane path /dp/*
	handle @dataplane {
		reverse_proxy $WORKER_DATA_PLANE {
			# A live view is a long-lived socket with long silences between a person's taps. The
			# default buffering would hold frames and the default timeouts would close it mid
			# session, which presents as the device freezing.
			flush_interval -1
		}
	}
DPEOF
)
else
  echo "    /dp/* omitted (WORKER_DATA_PLANE is empty) — no live view from this ingress"
  DP_BLOCK=""
fi
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
# MFARM console + WebDriver hub. Managed by setup-ingress.sh — edit there, not here.
#
# Two upstreams. Everything a human or a CI client touches is served by the API process on
# $UPSTREAM: the console at /, the tenant API at /v1/*, the WebDriver hub at /wd/hub/*. The one
# exception is /dp/*, which reaches the device host's data plane so a browser can hold the live-view
# socket over this same TLS name (ADR-0007). The metrics listener is a SEPARATE port and is not
# proxied, because its gauges are fleet-wide and collected on the owner pool — RLS does not hide
# them. The automation gateway is not proxied either: the hub reaches it host-locally.
$HOSTNAME_PUBLIC {
	encode zstd gzip

	# HSTS. Safe here because this host is only ever reached over TLS.
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		-Server
	}

$DP_BLOCK

	handle {
		reverse_proxy $UPSTREAM {
			# The API decides cookie Secure from config, not from the request scheme, so these
			# headers are for logging and for anything downstream that wants the real client — not
			# load-bearing for auth.
			header_up X-Forwarded-Proto {scheme}
			header_up X-Real-IP {remote_host}
		}
	}
}
EOF

sudo caddy validate --config /etc/caddy/Caddyfile 2>&1 | tail -3

say "Restarting Caddy"
sudo systemctl enable caddy >/dev/null 2>&1 || true
sudo systemctl restart caddy
sleep 8
sudo systemctl is-active caddy

say "Certificate + reachability"
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://$HOSTNAME_PUBLIC/health" --max-time 10 || echo 000)
  echo "    [$i] GET /health over TLS -> $code"
  [ "$code" = "200" ] && break
  sleep 6
done

say "What is listening publicly"
sudo ss -tlnp | grep -E '0\.0\.0\.0|\[::\]' | awk '{print "    " $4 "  " $7}'

say "Done"
echo "    https://$HOSTNAME_PUBLIC"
