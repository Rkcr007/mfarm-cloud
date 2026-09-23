# MFARM AI — the product line and its tracker

> **This file is the system of record for the AI product line.** Every PR that ships, changes or
> drops a capability below updates its row in the same commit. A row says `Shipped` only when it is
> merged, deployed and was exercised against the deployed farm — the same bar as
> `docs/AGENT_BUILD_PLAN.md`. Decisions live in [ADR-0043](adrs/0043-mfarm-ai-is-an-agent-on-our-own-hub.md).

Started 2026-09-24. Prompted by [google/artemis](https://github.com/google/artemis), an Android
agent that turns an English instruction into taps, types and swipes.

## 1. What we are selling

**One sentence:** *describe the test in English, and a real device does it — with the video, logcat
and step-by-step evidence MFARM already records, on Android and iOS.*

MFARM today sells the **hub** (ADR-0018 Model A): bring your Appium suite, we supply clean devices,
evidence and flake history. That market is people who already write WebDriver code. The AI line
opens three markets the hub cannot reach:

| Buyer | Their problem today | What MFARM AI gives them |
|---|---|---|
| **Manual QA teams** (the largest group in Indian app shops) | Regression is a spreadsheet of click-paths run by hand before every release | Paste the click-path in English; it runs on a real device with a recording, every build |
| **Product / release managers** | "Does checkout still work on the new build?" needs an engineer | A one-line smoke check they can type themselves, from the console |
| **Developers using AI coding agents** (Claude Code, Cursor, Codex…) | The agent can write the fix but cannot see a phone | `mfarm mcp` — the agent borrows a farm device, reproduces, reads logcat, verifies |
| **Existing hub customers** | Flutter/canvas screens break locators; a red run needs a human to triage | Vision-backed steps where locators fail, and an AI read of why a run failed |

### Why us and not Artemis / a competitor

- **Artemis needs a phone on your desk and ADB.** We have the phones. Our agent drives them through
  the hub, so the customer never gets raw ADB, every device is still reset after use (ADR-0012), and
  the run lands in the same evidence, share-link and flake history as a scripted run.
- **Android and iOS from one agent** — the hub already speaks UiAutomator2 and XCUITest. Artemis is
  Android-only.
- **Priced per step, not per seat.** A team pays for what it ran.

### Packaging and price (first cut — recalibrate from measured tokens, §4)

MFARM pays the model provider and meters every AI step (owner decision, 2026-09-24).

| Item | Unit | Price | Why |
|---|---|---|---|
| Device time | per device-minute | existing rate (unchanged) | AI runs hold a device like any session |
| **AI step — Flash** | per step | `AI_STEP_PRICE_INR.flash` | One observe→act turn, low effort |
| **AI step — Pro** | per step | `AI_STEP_PRICE_INR.pro` | Plans, checks each action before it runs, verifies after; more thinking |
| AI diagnosis of a failed run | per diagnosis | `AI_STEP_PRICE_INR.diagnose` | One model call over the steps, logcat tail and final screen |
| MCP server | free | — | It only drives the hub; the customer pays device-minutes as usual |

The prices are one exported server constant, never restated in the console (the console reads them
from the API), so the price a customer is quoted and the price they are metered cannot drift. Every
step also stores its real input/output/cache tokens, so the constant can be re-derived from data
rather than guessed. **Guard-rails a customer can see:** a per-run step cap (default 40 Flash /
80 Pro) and a per-org monthly AI budget; a run that would exceed either stops with a clear reason
instead of billing past it.

## 2. Capabilities and where each fits

| # | Capability | What it is | Fits MFARM because… |
|---|---|---|---|
| C1 | **MCP server** (`mfarm mcp`) | Stdio MCP server in the zero-dep CLI: list devices/apps, start a session, screenshot, UI tree, tap/type/swipe/key, launch app, logcat, end session | Pure Model A — the customer's agent is the process; we only expose the hub |
| C2 | **AI run engine** | Server-side observe→act loop over the hub: screenshot + accessibility tree in, one action out, per-step persistence | Reuses sessions, evidence, reset and billing; one engine for Android and iOS |
| C3 | **Flash / Pro profiles** | Flash: act each turn. Pro: plan with checkpoints, pre-action check, final verdict + report | Mirrors Artemis's two modes; lets a customer trade speed for rigour |
| C4 | **AI step metering** | Every step billed at a server price, tokens recorded; step cap and monthly budget | Owner decision: MFARM pays, bills per step |
| C5 | **Console "AI testing" section** | New nav section: write a prompt, pick app/device/profile, run; list and detail with a step trajectory (screenshot, reasoning, action) and live progress | The sellable surface for non-coders |
| C6 | **Saved AI tests** | Name and save a prompt+app+profile; re-run in one click; history per saved test | Turns a one-off into a regression suite |
| C7 | **Exploratory run on upload** | Opt-in: when a build is uploaded, run a saved exploratory prompt against it | Finds bugs nobody wrote a test for |
| C8 | **AI failure diagnosis** | On a failed run (scripted or AI), explain why from steps + logcat + last screenshot | Complements failure classification (ADR-0039) |
| C9 | **Export as script** | Turn a passed AI run's actions into a WebdriverIO / pytest script | Moves a customer from AI runs onto the hub, where runs are deterministic and cheap |
| C10 | **Share an AI run** | Share links carry the trajectory, like result shares | Reuses ADR-0036/0040 |

## 3. Tracker

Status: `Planned` → `Building` → `Merged` → `Shipped` (deployed and exercised on the farm).

| # | Capability | Status | PR | Notes |
|---|---|---|---|---|
| C1 | MCP server | Merged | #202 | `mfarm mcp`: 12 tools over `/wd/hub`; needs an npm publish to reach customers (2FA — owner runs it) |
| C2 | AI run engine | Merged | | `src/ai/agent.ts` (loop) + `runner.ts` (claims, per-run key, hub via `inject`); `/v1/ai/*`; migration 061 |
| C3 | Flash / Pro profiles | Merged | | Pro = a plan step + verdict re-confirmed on a fresh screen; effort `low`/`high` |
| C4 | AI step metering | Merged | | `ai_steps` is the ledger (price at the time of the step, real tokens); step cap; monthly budget (`orgs.ai_monthly_budget_inr`, default ₹2000); screenshots expire with artifact retention |
| C5 | Console AI section | Planned | | |
| C6 | Saved AI tests | Planned | | |
| C7 | Exploratory run on upload | Planned | | |
| C8 | AI failure diagnosis | Planned | | |
| C9 | Export as script | Planned | | |
| C10 | Share an AI run | Planned | | |

## 4. Open questions and what would change them

- **Real cost per step.** Unknown until measured on the farm. The first 20 real runs set the price.
- **Which model.** Defaults to `claude-opus-5` for both profiles (effort `low` for Flash, `high` for
  Pro), overridable by `MFARM_AI_MODEL`. A cheaper model for Flash is a pricing decision for the
  owner, not an engineering default.
- **Turning it on.** `ANTHROPIC_API_KEY` in `deploy/.env` on the control plane. Unset, `POST /v1/ai/runs`
  answers 503 and the runner never starts — every farm is AI-off until its owner opts in.
- **Determinism.** AI runs are not a CI gate. The console says so; C9 is the path to a gate.
