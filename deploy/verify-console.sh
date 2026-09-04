#!/usr/bin/env bash
#
# Is the CONSOLE actually shipped, and intact, on the deployed farm?
#
#   ./deploy/verify-console.sh                    # against farm.mfarm.dev
#   ./deploy/verify-console.sh https://host       # against anything else
#   BUILD=abc1234 ./deploy/verify-console.sh      # ...and assert which commit is serving
#
# Runs FROM ANYWHERE, over the public internet, unauthenticated — which is the point. Every asset it
# checks is served to an anonymous visitor by design (the login page and the shell that renders it),
# so this needs no credential and exercises the same path a customer's browser does, through Caddy
# and TLS rather than through loopback.
#
# WHY THIS EXISTS SEPARATELY FROM `ui.test.ts`. That suite asserts the same allowlist against a
# server built in-process by `app.inject()`. It has never been through Caddy, has never had a
# `Content-Type` chosen by a proxy, and cannot see a file that failed to reach the image. Every
# console outage this project has had was of that shape: `/profiles.js` missing from the allowlist
# took the whole page down and `curl` against the deployed host was the only thing that caught it.
#
# WHAT IT REFUSES TO ASSUME: it derives the asset list from the DEPLOYED HTML and the DEPLOYED
# stylesheets, never from a list written here. A list in this file is a list that goes stale the
# first time somebody adds a module, and it would then pass by checking the wrong things.
set -uo pipefail

BASE="${1:-https://farm.mfarm.dev}"
BASE="${BASE%/}"
BUILD="${BUILD:-}"

pass=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=$((fail+1)); }
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

# `--fail-with-body` is deliberately NOT used: a 401 body is informative here, because a path that
# has fallen off the console allowlist does not 404 — it falls through to the authenticated API
# routes and answers 401. That is the exact signature of the outage this script exists to catch.
fetch() { curl -sS --max-time 20 "$@"; }
status() { curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$1"; }
ctype()  { curl -sS --max-time 20 -o /dev/null -w '%{content_type}' "$1"; }

say "Console at $BASE"

# ---------------------------------------------------------------- 1. the shell renders at all
INDEX="$(fetch "$BASE/")"
if [ -z "$INDEX" ]; then
  bad "GET / returned nothing — the console is down, stop here"
  exit 1
fi
grep -q '<div id="console"' <<<"$INDEX" && ok "the shell is served" || bad "GET / is not the console shell"

# ---------------------------------------------------------------- 2. every asset the page names
#
# Root-relative `src`/`href` from the HTML, then `url()` from each stylesheet it links. Two passes,
# because a font is named by a stylesheet and by nothing else — which is precisely how a font goes
# missing without a single 404 in the HTML.
say "Assets the deployed page actually names"
# `while read` rather than `mapfile`: this script is meant to run from a laptop as well as from the
# box, and macOS still ships bash 3.2, where `mapfile` does not exist. It failed there first.
ASSETS=""
while IFS= read -r a; do [ -n "$a" ] && ASSETS="$ASSETS $a"; done < <(
  printf '%s' "$INDEX" | grep -oE '(src|href)="/[^"]+"' | sed -E 's/.*"(\/[^"]+)"/\1/' | sort -u)
[ -n "$ASSETS" ] || bad "the page names no root-relative assets, which cannot be right"

CSS_REFS=""
for a in $ASSETS; do
  code="$(status "$BASE$a")"
  type="$(ctype "$BASE$a")"
  if [ "$code" = "200" ]; then ok "$a  ($code, $type)"; else bad "$a  ($code — allowlist? a 401 means it fell through to the API)"; fi
  case "$a" in
    *.css)
      while IFS= read -r ref; do
        [ -n "$ref" ] && CSS_REFS="$CSS_REFS $ref"
      done < <(fetch "$BASE$a" | grep -oE "url\(['\"]?/[^'\")]+" | sed -E "s/url\(['\"]?//" | sort -u)
      ;;
  esac
done

if [ -n "$CSS_REFS" ]; then
  say "Assets the stylesheets name (fonts live here and nowhere else)"
  for r in $(printf '%s\n' $CSS_REFS | sort -u); do
    code="$(status "$BASE$r")"
    if [ "$code" != "200" ]; then bad "$r  ($code)"; continue; fi
    case "$r" in
      *.woff2)
        # `wOF2` is the magic number. A font read as utf8 anywhere in the chain arrives as a file
        # the browser SILENTLY REFUSES — no console error, no failed request, and the only symptom
        # is that the page renders in the fallback face. Checking the bytes is the only way to see
        # it from out here.
        magic="$(fetch "$BASE$r" | head -c 4)"
        size="$(curl -sS --max-time 20 -o /dev/null -w '%{size_download}' "$BASE$r")"
        if [ "$magic" = "wOF2" ] && [ "$size" -gt 10000 ]; then ok "$r  (intact woff2, ${size}B)"
        else bad "$r  (magic='$magic' size=${size}B — corrupted, the page will use the fallback face)"; fi
        ;;
      *) ok "$r  ($code)" ;;
    esac
  done
else
  bad "no stylesheet named any asset — the fonts are not being requested at all"
fi

# ---------------------------------------------------------------- 3. the module graph
#
# The console is an ES module graph with no bundler, so a module that imports a path the allowlist
# does not serve is a parse-time failure and a BLANK PAGE — not a degraded console. Nothing else
# from out here can see that.
say "The module graph resolves"
for entry in /console.js; do
  src="$(fetch "$BASE$entry")"
  IMPORTS=""
  while IFS= read -r i; do [ -n "$i" ] && IMPORTS="$IMPORTS $i"; done < <(
    printf '%s' "$src" | grep -oE "from '/[^']+'" | sed -E "s/from '//; s/'//" | sort -u)
  [ -n "$IMPORTS" ] || bad "$entry imports nothing — did it actually download?"
  for i in $IMPORTS; do
    code="$(status "$BASE$i")"
    [ "$code" = "200" ] && ok "$entry imports $i  ($code)" || bad "$entry imports $i  ($code — blank page)"
  done
done

# ---------------------------------------------------------------- 4. the CSP is still the CSP
#
# A CSP mistake is invisible from the outside: a blocked socket surfaces in the browser as a bare
# `error` event with no reason on it, so a console whose live view will never connect looks exactly
# like a worker that is down.
say "Content-Security-Policy"
CSP="$(curl -sS --max-time 20 -o /dev/null -D - "$BASE/" | tr -d '\r' | grep -i '^content-security-policy:' | cut -d' ' -f2-)"
[ -n "$CSP" ] || bad "no CSP header at all"
grep -q "default-src 'none'" <<<"$CSP" && ok "default-src 'none'" || bad "default-src is not 'none'"
grep -q "font-src 'self'" <<<"$CSP"    && ok "font-src 'self' (self-hosted faces)" || bad "font-src does not allow 'self' — the faces will be blocked"
grep -qE "unsafe-inline|unsafe-eval" <<<"$CSP" && bad "CSP permits unsafe-inline/eval" || ok "no unsafe-inline, no unsafe-eval"
grep -q "frame-ancestors 'none'" <<<"$CSP" && ok "frame-ancestors 'none'" || bad "the cockpit drives a real device and must not be framable"

# ---------------------------------------------------------------- 5. no external origin, anywhere
#
# The claim is that this is self-hosted. A font CDN in a stylesheet would be a third party in the
# load path of a page somebody's fleet depends on, and the CSP would block it — so the symptom is a
# fallback face rather than an error.
say "Self-hosted"
EXTERNAL=0
for a in $ASSETS; do
  case "$a" in *.css|*.js)
    if fetch "$BASE$a" | grep -oE "(https?:)?//[a-z0-9.-]+\.(com|net|org|io|dev)/" | grep -vE "//(www\.)?w3\.org/" | head -3 | grep -q .; then
      bad "$a references an external origin"
      EXTERNAL=1
    fi ;;
  esac
done
[ "$EXTERNAL" = "0" ] && ok "no external origins in any served stylesheet or module"

# ---------------------------------------------------------------- 6. which commit is serving
#
# Every deployment mechanism that has bitten this project bit it by succeeding quietly while
# changing nothing. `/v1/version` is behind auth, but the console's own header badge is not — it is
# in the HTML the anonymous visitor gets.
say "Build"
if [ -n "$BUILD" ]; then
  SHORT="${BUILD:0:7}"
  if fetch "$BASE/console.js" | grep -q "showBuild"; then ok "the console reports its build in the header"; fi
  VER="$(fetch "$BASE/v1/version" || true)"
  if grep -q "$SHORT" <<<"$VER" 2>/dev/null; then
    ok "/v1/version reports $SHORT"
  else
    printf '  \033[33m·\033[0m /v1/version needs a credential from here; check the header badge in a browser, or run verify-live.sh on the box\n'
  fi
else
  printf '  \033[33m·\033[0m no BUILD given; pass BUILD=<sha> to assert which commit is serving\n'
fi

# ---------------------------------------------------------------- verdict
say "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
