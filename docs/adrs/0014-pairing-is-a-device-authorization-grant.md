---
id: ADR-0014
title: Pairing is a device authorization grant — the agent shows a code, the console redeems it
status: Accepted
date: 2026-08-28
authors:
  - Claude Code
tags: [agent, onboarding, security, pairing, ux]
supersedes: []
extends: [ADR-0009]
---

## Context

ADR-0009 decided the agent is a product somebody downloads and runs. It did not decide how that
agent gets a credential, and the answer today is the worst step in the whole product:

```bash
CSRF=$(curl -sS -c "$JAR" -X POST "$FARM/v1/auth/login" ... | node -pe '...csrfToken')
curl -sS -b "$JAR" -X POST "$FARM/v1/account/agent-enrollments" -H "x-mfarm-csrf: $CSRF" ...
```

An org admin logs in with a cookie jar, echoes a CSRF token back in a header, mints a single-use
`mae_` token, and the person setting up the laptop pastes it into an environment variable. There is
no console screen for any of it. It is eight of the eleven steps a new user faces, it cannot be done
by the person actually holding the laptop unless they are an admin, and the credential travels
through a chat message or a text file on its way.

The enrollment token itself is good and is not what is being replaced: single-use, expiring,
revocable, org-scoped, and the host it enrolls inherits that org, which is what keeps a borrowed
phone out of the shared pool. What is being replaced is **how a human obtains one**.

## Decision

**The agent displays a short code. The user types it into the console they are already signed into.
The agent polls until it is redeemed and receives the `mae_` token it would otherwise have been
handed.**

This is the OAuth 2.0 Device Authorization Grant (RFC 8628) — the flow used to sign a television
into a streaming account — and it is adopted deliberately rather than invented, because its failure
modes are known and its shape is one users have met before.

```
  agent                          control plane                       console
    |  POST /v1/pair (unauth)          |                                |
    |--------------------------------->|  mints XXXX-XXXX, 10 min TTL   |
    |<---------------------------------|                                |
    |  displays XXXX-XXXX              |                                |
    |                                  |<---- POST /v1/pair/redeem -----|  user types the code
    |                                  |      (session cookie + CSRF)   |
    |  POST /v1/pair/poll (unauth)     |                                |
    |--------------------------------->|                                |
    |<--- mae_… once, then never ------|                                |
```

### 1. The code goes agent → console, not console → agent

Both directions pair a machine; only one puts the decision in the right hands.

**The console is the authenticated side.** The user is already signed in there, their org is already
established, and their admin rights are already known. Redeeming a code in that context needs no new
authentication and no new trust: it is an authenticated user saying *yes, that machine, mine*.

The reverse — console mints, user pastes into the agent — makes the agent handle a bearer credential
in a text field, which is the thing being removed, and it gives the unauthenticated side the job of
proving who it belongs to.

The code therefore carries exactly one claim: **possession of the agent in front of you.** Identity
comes from the console session. That split is the whole security argument.

### 2. The `POST /v1/pair` endpoint is unauthenticated, and that is safe

It has to be — the agent has no credential yet; obtaining one is the point. What makes it safe is
that **the code it returns is worth nothing until an authenticated admin redeems it.** An attacker
who floods this endpoint gets a pile of codes bound to no org, granting nothing.

The exposures that remain are ordinary and are handled as such:

- **Guessing a pending code.** 8 characters from a 32-character alphabet is 2^40. With a 10-minute
  TTL, per-IP rate limiting on the redeem path, and the code invalidated after five wrong attempts,
  guessing is not a strategy. The alphabet excludes `0/O` and `1/I/L` — a user reading a code off a
  screen must not be able to fail at it, and ambiguity would push us toward longer codes for the
  wrong reason.
- **Resource exhaustion.** Rate limited per IP, and pending pairings expire on a timer rather than
  accumulating.
- **Somebody redeeming a code they were sent.** This is phishing, and it is the flow's known weak
  point: a user who is talked into typing an attacker's code into their console enrolls the
  attacker's machine into their org. Mitigations: the redeem screen names the machine (hostname,
  platform, when it started) before asking for confirmation, the resulting host appears in the fleet
  with its pairing time, and enrollment is revocable. **The remaining risk is accepted**, as it is by
  every product using this flow, because the alternative — no pairing at all — is what we have now.

### 3. The token is delivered exactly once, to the poller that asked for it

The poll is unauthenticated, so the pairing id it carries is the only thing linking a poll to a
pending pairing — and it is therefore a secret of the same weight as the code. It is a 32-byte
random value returned only in the response to `POST /v1/pair`, never displayed, never logged.

On success the `mae_` token is returned once and the pending row is destroyed. A second poll gets
`already_redeemed`, not the token again.

### 4. Credentials go to the OS keychain

Keychain on macOS, with a `0600` file only where no keychain exists — as ADR-0009 §3 already said.
The `mae_` token is exchanged for a `mwk_` worker token at first registration, and that is what is
persisted; the `mae_` is used once and dropped.

**Unpairing is part of this decision, not a follow-up.** *Forget this machine* clears the keychain
entry and revokes the host from the console. A flow with an entrance and no exit is one people are
right to be wary of installing.

### 5. `mae_` tokens and the existing curl path both survive

Nothing is removed. A scripted fleet rollout — the dedicated machine in the corner with six phones
on a hub — should not have to drive a GUI, and `WORKER_REGISTRATION_TOKEN` keeps working exactly as
it does today. This ADR adds the path for a person; it does not close the path for a script.

## Consequences

Deliberately accepted:

- **Phishing is not eliminated, only narrowed.** See §2. Named here so nobody later believes it was
  overlooked.
- **A new unauthenticated endpoint on the control plane**, which is a surface that did not exist
  before. It is the price of the agent having no credential yet, and it is why §2 is written out
  rather than assumed.
- **Polling, not push.** A websocket would be fewer round trips and one more thing to hold open
  before the agent is even paired. The poll is bounded by the code's own TTL.

Rejected, with reasons:

- **Console mints, user pastes into the agent.** See §1: it puts a bearer credential back in a text
  field and asks the unauthenticated side to prove ownership.
- **A QR code instead of a typed code.** Better on a phone, worse here: the console is usually on the
  same screen as the agent window, so the user would be photographing their own monitor. A code they
  can read and type works in every arrangement, including a remote machine over SSH. QR can be added
  beside it later; it cannot be the only path.
- **Signing the agent's request with a device key.** Solves nothing at this stage — an unenrolled
  agent's key is as unattested as its request.

## Verification

The gate is ADR-0009's, unchanged and now reachable: **a person who has never seen MFARM, on a
machine we do not control, plugs in a phone and sees it in the console inside two minutes, without
typing a command or entering a password.** Pairing is the step this ADR is responsible for, and it
passes when the only thing they typed was eight characters they read off their own screen.
