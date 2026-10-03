# ADR-0047 — the media relay lives on the control plane

**Status:** Accepted · 2026-10-03 · amends ADR-0005 (where coturn runs) · the owner asked for the move
the same day D67's open half was reported

## Context

ADR-0005 put coturn **on the device host**, near the media source, on a machine that already had
the ports open. That was right while the device host was the farm. Two things changed:

1. **The device host is stopped most of the time.** `mfarm-lab` costs ₹65/hour running, and it is
   stopped whenever nobody is using Cuttlefish.
2. **Phones stream without it.** Since M6 the agent on somebody's laptop is a phone's WebRTC peer.
   Those phones are live whenever that laptop is, and they need the relay for every viewer who is
   not on the laptop's own network. They do not need a Cuttlefish host at all.

So the relay was down exactly when a phone needed it. D67 recorded the result: the console handed
out `turn:turn.mfarm.dev`, nothing answered, and the agent had to learn to probe the relay (1.5 s on
every connection) and offer without it. A viewer on another network simply got no picture.

## Decision

**coturn runs on `mfarm-cp`, the one machine that is always up.** `turn.mfarm.dev` points at its
reserved address (34.100.138.213, the same one as `farm.mfarm.dev`). Concretely:

- **Firewall:** `mfarm-cp` carries the `mfarm-turn` tag, so the existing `mfarm-allow-turn` rule opens
  3478/udp+tcp and 49152–65535/udp on it. No rule changed. coturn is the only thing listening there.
- **One secret:** coturn uses the API's own `deploy/secrets/turn_secret` (`SECRET_FILE`), so the
  control plane and the relay cannot disagree about it. The API needed no change: `TURN_URLS`
  already named `turn.mfarm.dev`.
- **What it may forward to.** On the device host the config allowed the whole VPC range back in, and
  it never denied the rest of 10/8 at all. On the control plane that range includes the control
  plane. Every private range is now denied, along with Tailscale's 100.64/10, and only the device
  hosts' private addresses (`MFARM_RELAY_PEERS`, in `farm.env`) are let back in. A phone's agent
  needs no entry: a relayed browser reaches it at its public address.
- **The agent never relays itself (D70).** Found while verifying this move. werift locks onto the
  first pair it nominates and sends everything down it. With a relay of its own, that pair could be
  a relay pair while Chrome settled on another, and the picture froze on the direct path and on the
  relayed one. The browser holds the relay; the agent keeps STUN only. This also retires D67's probe.
- `setup-turn.sh` renders the config (`TURN_CONF_OUT`) for a test that holds the peer rules. It no
  longer prints the secret (ADR-0045). `farm-online.sh` checks the control plane's address against
  `turn.mfarm.dev`.

## Verified on the farm

| | |
|---|---|
| STUN from the internet | answers in 50 ms (UDP) and 76 ms (TCP); the old address is silent |
| TURN allocation with farm-minted credentials | relay candidate at 34.100.138.213 in 127 ms (UDP), 137 ms (TCP), through the name |
| A headless viewer forced onto the relay | `relay 34.100.138.213 → srflx (the agent)`; input to first frame 162–199 ms |
| Chrome forced onto the relay, in the console | the drawer opens and closes through the relay; the agent offers in ~0.3 s instead of ~1.7 s |
| Chrome on the direct path, same agent | unaffected — 144 frames over a swipe and Back, 0 lost |

## Consequences

- **The control plane now has a UDP surface.** Only coturn listens on it. It forwards only for
  holders of a farm-minted credential, and only to public addresses and the named device hosts.
- **Relay egress is billed on the control plane**, and it scales with relayed viewers (ADR-0005 said
  so of the relay wherever it ran). A relayed phone is up to 4 Mbit/s. `max-bps` caps one session at
  16 Mbit/s and `total-quota` caps the relay.
- **One more thing on `mfarm-cp`.** It was already the single point of failure. An e2-medium with
  ~2.3 GB free carries coturn comfortably at this scale.
- **A Cuttlefish viewer's relayed media now crosses the VPC** from `mfarm-lab` (10.160.0.2) to the
  control plane. That is internal traffic, and it is why that address is in `MFARM_RELAY_PEERS`.
- **A second device host** adds its private address to `MFARM_RELAY_PEERS` and re-runs
  `setup-turn.sh` on the control plane (docs/SECOND_HOST.md).
- **The lab's old coturn** still has the same secret and no DNS name. Stop it the next time the lab
  is up (`sudo systemctl disable --now coturn`). Its `mfarm-turn` tag stays for now: that UDP range
  may also carry Cuttlefish's direct media, and that is a separate question.
- **An agent whose network blocks outbound UDP is beyond reach.** Its own relay was the path that
  broke (D70). Revisit if a customer's agent sits behind such a firewall.
- **TLS TURN (`turns:`) is still not offered.** It needs a certificate for `turn.mfarm.dev`, and no
  viewer has needed it yet (docs/DOMAIN_PLAN.md §4).

## Alternatives

- **Keep it on the device host and keep that host running:** ₹65/hour, to relay for phones that do
  not use it.
- **A small VM of its own:** about ₹500/month, another reserved address, and another machine to keep
  patched. It buys isolation from the control plane at a scale where a misbehaving relay is not yet
  a real risk.
- **A managed TURN service:** an external dependency, and per-GB pricing on the one number that
  scales with viewers.
