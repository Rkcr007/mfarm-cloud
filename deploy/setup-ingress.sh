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
# WHAT STAYS PRIVATE. The API keeps its 127.0.0.1 bind; Caddy is the only public listener and it
# proxies exactly one upstream. The metrics listener on :9464 carries fleet-wide cross-tenant gauges
# and is deliberately NOT proxied. The worker's data plane and automation gateway stay on the docker
# bridge, unreachable from outside, which is why there is still no live video (ADR-0005).
set -euo pipefail

HOSTNAME_PUBLIC="${HOSTNAME_PUBLIC:-34-100-138-213.sslip.io}"
UPSTREAM="127.0.0.1:3000"

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
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
# MFARM console + WebDriver hub. Managed by setup-ingress.sh — edit there, not here.
#
# One upstream on purpose. Everything the product exposes to a human or to a CI client is served by
# the API process on $UPSTREAM: the console at /, the tenant API at /v1/*, the WebDriver hub at
# /wd/hub/*. The metrics listener is a SEPARATE port and is not proxied, because its gauges are
# fleet-wide and collected on the owner pool — RLS does not hide them.
$HOSTNAME_PUBLIC {
	encode zstd gzip

	# HSTS. Safe here because this host is only ever reached over TLS.
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		-Server
	}

	reverse_proxy $UPSTREAM {
		# The API decides cookie Secure from config, not from the request scheme, so these headers
		# are for logging and for anything downstream that wants the real client — not load-bearing
		# for auth.
		header_up X-Forwarded-Proto {scheme}
		header_up X-Real-IP {remote_host}
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
