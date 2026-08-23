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
# `/dp/<hostId>` CARRIES THE LIVE VIEW, and where it points is now a choice.
#
# By DEFAULT it goes to the API like everything else, because the API terminates the browser's
# WebSocket and relays it down a tunnel the AGENT dialled out. That is what makes a device host
# reachable when it has no address anyone can write down — a phone on a laptop behind NAT — and it
# is also what makes a SECOND device host possible at all, since the line below can only ever name
# one upstream.
#
# Setting WORKER_DATA_PLANE restores the old direct proxy for a host that genuinely is dialable.
# Kept so this ships without a flag day: an existing farm can move to the tunnel when it is ready
# rather than at the moment this script is next run.
#
# Either way the worker publishes no port of its own — it binds loopback or the VPC address — and
# either way the console's socket stays same-origin, so its strict CSP is unwidened.
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
# A SECOND name Caddy also answers on, so a rename is not a cutover.
#
# Both names get their own Let's Encrypt certificate and both serve the same site, which means a
# link somebody bookmarked or pasted into a CI config keeps working while everyone moves. Set it
# empty once nobody is on the old name — leaving a name served forever is how you end up unable to
# ever release the address behind it.
HOSTNAME_LEGACY="${HOSTNAME_LEGACY:-34-100-138-213.sslip.io}"
[ "$HOSTNAME_LEGACY" = "$HOSTNAME_PUBLIC" ] && HOSTNAME_LEGACY=""
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
  DP_TARGET="$WORKER_DATA_PLANE"
  echo "    /dp/* -> $WORKER_DATA_PLANE (live view, direct to the worker)"
  DP_WHY="the WORKER's own listener. Only one host can be named here, and it has to be dialable
	# from this box — which is exactly what the tunnel below exists to stop being a requirement."
else
  DP_TARGET="$UPSTREAM"
  echo "    /dp/* -> $UPSTREAM (live view, relayed over the agent tunnel)"
  DP_WHY="the API, which relays each viewer down the tunnel its agent dialled OUT. This is the
	# path that works for a host behind NAT, and the only one that works for more than one host."
fi
DP_BLOCK=$(cat <<DPEOF

	# The live-view data plane (ADR-0007). The path segment is the HOST id, and it is routed to
	# $DP_WHY
	#
	# NOT AUTHORISATION, on either path. Every connection through here still presents an Ed25519
	# grant naming session, device, org, fence and host, which the AGENT verifies offline — the
	# relay copies bytes and decides nothing. This is a route (ADR-0005).
	@dataplane path /dp/*
	handle @dataplane {
		reverse_proxy $DP_TARGET {
			# A live view is a long-lived socket with long silences between a person's taps. The
			# default buffering would hold frames and the default timeouts would close it mid
			# session, which presents as the device freezing.
			flush_interval -1
		}
	}
DPEOF
)
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
# MFARM console + WebDriver hub. Managed by setup-ingress.sh — edit there, not here.
#
# Two upstreams. Everything a human or a CI client touches is served by the API process on
# $UPSTREAM: the console at /, the tenant API at /v1/*, the WebDriver hub at /wd/hub/*. The one
# exception is /dp/*, which carries the live-view socket over this same TLS name (ADR-0007) — to
# the API by default, which relays it to the agent, or straight to a worker when WORKER_DATA_PLANE
# names one. The metrics listener is a SEPARATE port and is not
# proxied, because its gauges are fleet-wide and collected on the owner pool — RLS does not hide
# them. The automation gateway is not proxied either: the hub reaches it host-locally.
${HOSTNAME_PUBLIC}${HOSTNAME_LEGACY:+, }${HOSTNAME_LEGACY} {
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

if [ -n "$HOSTNAME_LEGACY" ]; then
  note() { printf '    %s\n' "$*"; }
  note "also serving the legacy name $HOSTNAME_LEGACY — set HOSTNAME_LEGACY= to retire it"
fi

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
