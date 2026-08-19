# Putting the farm on a domain — options, costs, and what I would actually do

A decision document, not a runbook. Nothing here is built. Written 2026-08-20, after the two pieces
that needed no decision were already done.

---

## 0. What already landed, so the baseline is clear

Two things went in before this document, because neither depended on a domain:

- **Both public addresses are now reserved.** `mfarm-ip` (34.100.159.34) had been sitting reserved
  and *unused* since the single-box era — billed the whole time at the higher rate GCP charges an
  address attached to nothing. It is the device host's now. **This was not new spend**; it was a bill
  already being paid for nothing, and it removed the failure below.
- **`deploy/farm.env` holds the two public names**, read by every script. The console hostname was
  hardcoded in seven files and the relay address in two; a rename would have been nine edits with one
  missed.

The failure the reserved address removed is worth remembering, because it is the shape everything in
this document is trying to avoid. The device host's IP used to change on every stop/start, while
coturn advertised it to browsers and the control plane handed out `turn:<that address>` in every
session. After a restart both pointed at an address belonging to someone else: console fine, device
list right, sessions starting, **video simply never arriving**, and an empty relay log — because
nobody ever called it.

**Current state works.** `https://34-100-138-213.sslip.io` is stable, has a real Let's Encrypt
certificate, and both addresses are pinned. Nothing below is required. It is all improvement.

---

## 1. What a domain is actually worth here

Three distinct benefits, and they are worth very different amounts:

| Benefit | Real value |
|---|---|
| A URL a teammate reads without flinching | **High.** `farm.example.com` versus `34-100-138-213.sslip.io`. This is most of the point. |
| Independence from sslip.io | **Moderate.** It is a free third-party service that resolves a name pattern to an IP. If it went away the console URL would die; the farm would not. |
| Makes `turns:` (TLS TURN) possible | **Unknown — see §4.** A certificate needs a hostname. Whether anyone needs `turns:` is not yet established. |

The first one alone justifies it. The third is the one being oversold.

---

## 2. Where DNS lives

| Option | Cost | Automation | Risk |
|---|---|---|---|
| **A. Delegate `lab.<domain>` to Cloud DNS** | ~$0.20/zone/mo | full `gcloud` | **None to the parent domain** — it is one NS record and nothing above it is touched |
| B. Move the whole domain to Cloud DNS | ~$0.20/zone/mo | full `gcloud` | **Real.** Repointing nameservers moves *everything* — MX, website, verification records. All must be recreated in Cloud DNS first or they go dark. Email is the usual casualty. |
| C. Two A records at the registrar | free | none | None. Also perfectly sufficient — nothing here needs DNS automation now that both IPs are reserved. |
| D. Cloudflare in front | free | API | Records must be **DNS-only** (grey cloud): proxying breaks TURN outright, and changes how the API sees client IPs, which the login rate limiter keys on. |

**Recommendation: A.** It is the only option that gets `gcloud` automation with a provably zero blast
radius on the parent domain. C is genuinely fine too and cheaper — pick it if you would rather not
have another GCP service in the picture.

**Not recommended: B**, unless the domain is parked and has no records worth losing. **Not
recommended: D** for now — it adds a moving part in front of a system whose client-IP handling was
already the subject of one production bug.

---

## 3. The names

```
farm.<domain>   ->  34.100.138.213   console, /v1, the WebDriver hub, /dp (the live-view socket)
turn.<domain>   ->  34.100.159.34    coturn, and nothing else
```

Both point at reserved addresses, so these records are written once and never change.

The domain itself need have **no relationship to this project's name**. Nothing in the system reads
it; it is two labels under whatever parent you already own.

---

## 4. `turns:` on 443 — the part I would push back on

The case for it: a relayed media path over TLS on port 443 is what gets through corporate networks
that block UDP and every TCP port but 443.

The case against doing it *now*:

- **Nobody has hit the problem.** In the one real test so far, the browser reached the device over a
  `direct (host)` path and the relay was not used at all. `turns:` is the fallback of a fallback.
- **It costs the device host its posture.** That machine currently publishes exactly one thing —
  TURN. ACME over HTTP-01 opens port 80 on it, its first HTTP ingress, and adb (6520/6521) and cvd's
  unauthenticated operator (1080/1443) are on that same box behind nothing but the firewall.
- **A certificate on a machine that is off most of the time will expire.** certbot renews on a timer;
  a stopped VM runs no timers. It dies silently ~90 days later and is noticed mid-session.

### A better option that only exists because DNS is moving

If DNS is in Cloud DNS, the certificate can be obtained by **DNS-01 on the control plane**, which is
always on, and copied to the device host. That removes every objection above at once:

- device host keeps **zero HTTP ingress** — no port 80, no ACME listener
- renewal happens on the **always-on** machine, so the expire-while-stopped problem does not exist
- the device host needs no DNS credentials; it receives a file

Cost: a service account with DNS-admin scope on the control plane, and a copy step (a deploy hook, or
`farm-online.sh` pushing the current cert on startup).

**Recommendation: decide `turns:` empirically, and if the answer is yes, do it this way rather than
with HTTP-01 on the device host.** The test is thirty seconds of work and settles it:

> From each network people will actually use — office, home, phone hotspot — open a session and read
> the cockpit's **Stream → Path** row. `direct` means TURN was not needed. `relayed (TURN)` means
> plain TURN on 3478 worked. Only if a network produces *neither* — the live view fails to connect —
> is `turns:` buying anything.

---

## 5. Cost

| Item | Monthly |
|---|---|
| Cloud DNS zone | ~$0.20 (~₹18) |
| The two reserved IPs | **no change** — both were already being paid for |
| Domain registration | whatever you already pay |
| `turns:` | no direct cost |

The dominant cost of this farm remains the device host at ~₹65/hour while running. Nothing in this
document moves that number.

---

## 6. Sequencing, if it goes ahead

1. **Delegate.** `MFARM_DOMAIN=lab.<domain>` → create the Cloud DNS zone and the two A records →
   you add one NS record at the registrar. *(A script for this was written and then withdrawn
   pending this decision; it is ~80 lines.)*
2. **Wait for propagation.** `dig +short farm.<domain>` answering is the gate.
3. **Cut over.** Edit `deploy/farm.env`, re-run `setup-ingress.sh` on the control plane and
   `setup-turn.sh` on the device host. Caddy serves the new name *and* sslip.io during the
   transition, so nothing breaks while DNS settles.
4. **Verify** with `./deploy/farm-check.sh`, then open a session and confirm the live view.
5. **Retire sslip.io** from the Caddyfile once teammates are on the new name.
6. **`turns:` — only after the §4 test says it is needed.**

Steps 1–5 are perhaps ninety minutes including propagation, and are reversible at every point: the
sslip.io name keeps working until step 5 deliberately removes it.

---

## 7. What I would do

Delegate `lab.<domain>` to Cloud DNS, take `farm.` and `turn.`, keep sslip.io alive as a fallback for
a week, and **not build `turns:` until a real network defeats plain TURN**. The empirical test in §4
costs nothing and will probably tell you it is unnecessary — and if it does not, DNS-01 from the
control plane is a better shape than the HTTP-01 path we had settled on.

The only thing still needed to start is the domain name.
