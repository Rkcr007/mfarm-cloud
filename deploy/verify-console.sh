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
        # `curl | head -c 4` makes curl write into a closed pipe and print "Failure writing output
        # to destination" on every font — noise that looks like a failure in a script whose whole
        # job is to distinguish those. Read the bytes to a file and take the magic from there.
        tmp="$(mktemp)"
        curl -sS --max-time 20 -o "$tmp" "$BASE$r"
        magic="$(head -c 4 "$tmp")"
        size="$(wc -c < "$tmp" | tr -d ' ')"
        rm -f "$tmp"
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

# ---------------------------------------------------------------- 3b. the fleet's redirect table
#
# Devices, Sessions and Queue merged into one Fleet route with four lenses, and the promise that
# made that safe to ship is that the OLD PATHS STILL LAND. Bookmarks, links in runbooks, and the
# `G D` / `G R` / `G Q` shortcuts all depend on it.
#
# Checked in the SHIPPED SOURCE rather than by driving a browser: the console is a hash router, so
# `#/devices` never reaches the server and curl cannot see the resolution at all. What can be
# verified from here is that the resolver deployed still names those routes — which is what a
# well-meant tidy-up would remove.
say "The fleet's merged routes"
FLEET_JS="$(fetch "$BASE/console.js")"
if grep -q "LENS_FOR_ROUTE" <<<"$FLEET_JS"; then
  for old_route in devices sessions queue; do
    grep -qE "$old_route: '(capacity|live|waiting)'" <<<"$FLEET_JS" \
      && ok "#/$old_route still resolves onto a lens" \
      || bad "#/$old_route is no longer in the redirect table — a bookmark to it now 404s in the router"
  done
  grep -q "f: 'fleet'" <<<"$FLEET_JS" && ok "G F reaches the fleet" || bad "the G F shortcut is gone"
else
  bad "no LENS_FOR_ROUTE in the deployed console — either this is an older build, or the merged routes were dropped"
fi

# ---------------------------------------------------------------- 3c. the device detail contract
#
# THE PAGE IS ITS SENTENCES, so the sentences are what gets checked — in the DEPLOYED source, which
# is the only place a stale build or a half-finished deploy is visible. Every line below is a claim
# a person acts on while a device is out of the pool, and every one of them has been wrong at some
# point in this console's history.
say "Device detail (document 05 §03)"
if grep -q "Authorising recovery does one thing" <<<"$FLEET_JS"; then
  ok "the consequence list is on the page, not only behind the dialog"
  # Three crosses, not two. Each is a thing a person reasonably expects a "release" button to do.
  for claim in \
    "return the device to the pool" \
    "clear the quarantine note" \
    "the device stays out and the failure is recorded" \
    "No session can be started on this device until a check passes"
  do
    grep -qF "$claim" <<<"$FLEET_JS" \
      && ok "  ... $claim" \
      || bad "  MISSING: \"$claim\" — ADR-0024's refusal is only as good as this list"
  done
else
  bad "the consequence list is not in the deployed console"
fi

# THE OTHER STORY. A host quarantine is not the operator's to fix — `clear_silence_quarantine`
# returns those devices on the host's next beat — and the page used to offer a recovery button
# above a list saying only a health check could return the device. Two true sentences, contradicting
# each other, one attached to a red button.
if grep -q "This one comes back on its own" <<<"$FLEET_JS"; then
  ok "a host quarantine tells its own story"
  grep -qF "this host is not answering" <<<"$FLEET_JS" \
    && ok "  ... and says what pressing the button would cost" \
    || bad "  the host-quarantine list no longer names why the attempt is futile"
  grep -qF "Ask for a recovery attempt anyway" <<<"$FLEET_JS" \
    && ok "  ... with the action demoted, not deleted" \
    || bad "  the demoted action is gone — an admin who knows the host is back has no button"
else
  bad "a host quarantine still gets the device-level consequence list"
fi

# The fetch that a cold load depends on. `hashchange` does not fire on load, so a device URL opened
# directly is fed by this and nothing else — and the failure is a card that says "Loading…" for as
# long as the page is open, which nobody reports as a bug.
grep -q "loadForRoute" <<<"$FLEET_JS" \
  && ok "one loader for both the cold load and the hashchange" \
  || bad "no loadForRoute — a device URL opened directly will never fetch its audit log"

# The caption stage 5 made true. It described the OLD rail, which removed a control the device could
# not honour; the rail now shows it struck through and says why.
grep -q "visible and disabled in the session rail, never removed" <<<"$FLEET_JS" \
  && ok "the capability caption matches the rail as it actually behaves" \
  || bad "the capabilities caption does not describe stage 5's rail"

DD_CSS="$(fetch "$BASE/console.css")"
for cls in "card.gate" "csq-list" "csq-note" "badge"; do
  grep -q "\.$cls" <<<"$DD_CSS" \
    && ok "css: .$cls" \
    || bad "css: .$cls is missing — the gate renders as a plain section"
done

# ---------------------------------------------------------------- 3d. the cockpit's four states
#
# Document 04, stage 5. Each of these is a CLAIM the panel makes, and the cockpit's failure mode is
# not a broken render — it is an indicator depicting something the control plane never reported.
say "The cockpit (document 04)"

# THE BAR THAT CONTRADICTED THE SENTENCE ABOVE IT. `.bar.indet` swept a 32% sliver across a queued
# action, two lines under a caption promising "You will see the outcome, not a progress bar". The
# control plane cannot dial a worker: an app verb has exactly two reportable states.
grep -q "bar indet" <<<"$FLEET_JS" \
  && bad "the indeterminate bar is back — nothing reported that progress" \
  || ok "no indeterminate bar on a queued action"
grep -qF "Queued for the worker's next heartbeat" <<<"$FLEET_JS" \
  && ok "a queued action says what it is waiting for" \
  || bad "the queued action lost its explanation"
grep -qF "after queueing" <<<"$FLEET_JS" \
  && ok "an outcome says how long after queueing it landed" \
  || bad "the outcome no longer reports the gap"

# S2's list grew: it used to omit keyboard and launch, so somebody deciding whether to keep a
# stream-less device read a shorter capability list than the device has.
grep -qF "Input, keyboard, install, launch, logcat and WebDriver" <<<"$FLEET_JS" \
  && ok "a stream-less device names everything that still works" \
  || bad "the no-stream panel is back to a partial list"

# WAITING IS NOT ENDING. `live` is false for a QUEUED session, and two places used that to mean
# "ended" — telling somebody whose session had not started that it had finished.
grep -qF "No device has been allocated yet" <<<"$FLEET_JS" \
  && ok "a queued session is not described as an ended one" \
  || bad "the Tools rail is back to calling a queued session ended"
grep -q "queuedNote" <<<"$FLEET_JS" \
  && ok "a queued session explains the wait beside the frame, not inside the blur" \
  || bad "the queued explanation is gone"

for cls in "endstats" "dot.breathe" "gate.waiting"; do
  grep -q "\.$cls" <<<"$DD_CSS" \
    && ok "css: .$cls" \
    || bad "css: .$cls is missing"
done

# ---------------------------------------------------------------- 3e. the bring-up choreography
#
# Document 04, stage 6. Six beats, each keyed to a CONFIRMED event — the failure mode of a
# choreography is animating ahead of the farm.
say "Bring-up (document 04, stage 6)"

# THE ONE CONTINUITY RULE: the stage element is never unmounted between bring-up and session. The
# bring-up screen used to draw its own `.phone.big` div and mount the cockpit's video inside it —
# a different element, a different shape, and a hard cut at the moment the sequence pays off.
grep -q "ensureStage" <<<"$FLEET_JS" \
  && ok "one frame element, shared between bring-up and the cockpit" \
  || bad "no ensureStage — the two screens are drawing different frames again"
grep -q "bringupBeat" <<<"$FLEET_JS" \
  && ok "the six beats resolve from confirmed state" \
  || bad "the beat resolver is gone"

# THREE INVENTED PERCENTAGES, ALL REMOVED. The stage ring measured `done / steps`, which is not a
# measurement of the wait; the handshake ring was a hardcoded 25/55/80 for stages with no extent.
grep -q "progressRing" <<<"$FLEET_JS" \
  && bad "the progress ring is back — it measured nothing" \
  || ok "no progress ring anywhere"
grep -q "class: 'phone" <<<"$FLEET_JS" \
  && bad "the old phone illustration is back beside the real frame" \
  || ok "no second device drawing"

for cls in "dev-tile" "devpanel\[data-beat" "devpanel\[data-mode"; do
  grep -q "$cls" <<<"$DD_CSS" \
    && ok "css: $cls" \
    || bad "css: $cls is missing — a beat has no styling behind it"
done

# ---------------------------------------------------------------- 3f. the light theme
#
# Document 01, stage 8. Light is a TRUE PEER, not a filter — and the boundary that keeps breaking is
# not the palette, it is which things are allowed to follow it.
say "Light theme (document 01, stage 8)"
TOK="$(fetch "$BASE/design-tokens.css")"

grep -q "data-theme='light'" <<<"$TOK" \
  && ok "the light block is served" \
  || bad "no light theme in the deployed tokens"

# A token defined in one theme and not the other silently keeps its dark value — usually near-black
# text on a near-white card, on whichever screen nobody opened.
for t in "--s-app" "--t-primary" "--b-card" "--hover-soft" "--accent-text" "--log-e" "--s-stage"; do
  if [ "$(grep -c -- "$t:" <<<"$TOK")" -ge 2 ]; then
    ok "  $t is re-derived"
  else
    bad "  $t is defined once — the light theme inherits the dark value"
  fi
done

# THE DESK / DEVICE BOUNDARY. `.dev-overlay` sits INSIDE the device's glass: it is the phone's
# screen showing a message, not a panel on the page. Reading a chrome token there turned the
# device white in light theme, which is the one thing a device-mirroring panel must never do.
if grep -q "dev-overlay" <<<"$DD_CSS"; then
  if awk '/\.dev-overlay \{/,/\}/' <<<"$DD_CSS" | grep -qE 'var\(--(s|b|t)-'; then
    bad "the device panel overlay reads a chrome token — the phone follows the room again"
  else
    ok "the device does not follow the room"
  fi
else
  bad "no .dev-overlay in the deployed stylesheet"
fi

# The three controls that had nothing behind them until stage 8.
grep -q "mf-theme" <<<"$FLEET_JS" \
  && ok "the theme is a setting, not a hardcoded attribute" \
  || bad "no theme control — data-theme is stuck at whatever index.html ships"

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
