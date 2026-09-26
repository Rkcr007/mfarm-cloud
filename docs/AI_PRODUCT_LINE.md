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
| C1 | MCP server | **Verified on hardware** | #202, #209, #215 | `mfarm mcp`: 12 tools over `/wd/hub`. 2026-09-24 a real MCP client drove a real MFARM X1 Pro on the farm end to end (allocate, tree, screenshot, tap opened Gallery, swipe, keys, logcat, release; 0 stray stdout lines). That run found two defects, fixed in #209. Customers get it after `npm publish` (2FA — owner runs it) **2026-09-26: `type_text` was broken** — it asked for the focused field with `POST element/active`, which Appium 2 answers "unknown command"; the 09-24 hardware run never typed. #215 uses the W3C GET, proven on a real device (typed "Display" into Settings search and read it back). Ships to customers in `@mfarm/cli` 0.2.0, not yet published. |
| C2 | AI run engine | **Shipped** | #203, #215 | 2026-09-26 on the farm (Groq `qwen/qwen3.8-27b`, Cuttlefish): Flash and Pro runs drove real devices end to end. `src/ai/agent.ts` (loop) + `runner.ts` (claims, per-run key, hub via `inject`); `/v1/ai/*`; migration 061 **Typing was broken until #215:** 7 of 7 `type_text` steps failed on the farm (`POST element/active` → "unknown command"), and the run still reached a verdict — the agent gave up and said the field "never registered". Re-verify a typing run after deploy. |
| C3 | Flash / Pro profiles | **Shipped** | #203 | 2026-09-26 on the farm (Groq `qwen/qwen3.8-27b`, Cuttlefish): Pro planned, recovered from a launch that did not land, and re-confirmed "Dark theme" on a fresh screen (10 steps). Flash read "Android version 17" in 5. Pro = a plan step + verdict re-confirmed on a fresh screen; effort `low`/`high` |
| C4 | AI step metering | **Shipped** | #203 | 2026-09-26 on the farm (Groq `qwen/qwen3.8-27b`, Cuttlefish): every step metered at its price with real tokens (~2.4–3.4k in); the budget meter moved ₹0 → ₹150. `ai_steps` is the ledger (price at the time of the step, real tokens); step cap; monthly budget (`orgs.ai_monthly_budget_inr`, default ₹2000); screenshots expire with artifact retention |
| C5 | Console AI section | Merged | #204 | Farm › AI testing (`#/ai`, `G E`): prompt, Flash/Pro, build, region; recent runs; budget meter; run page with step trajectory + the screen at each step, Stop, Run again, link to the session's recording & log. Prices only from `/v1/ai/pricing` |
| C6 | Saved AI tests | **Shipped** | #205, #214 | 2026-09-26 on the farm (Groq `qwen/qwen3.8-27b`, Cuttlefish): a saved test ran on demand against `io.appium.android.apis@latest` and passed; its history shows each run. #214: a saved test with no region (what the console saves on a one-region farm) now resolves one per run. `ai_tests` (migration 062): name, prompt, mode, the app package it is about; Run = `<package>@latest`; last 10 verdicts on the row; archive keeps history |
| C7 | Exploratory run on upload | **Shipped** | #205, #214 | 2026-09-26 on the farm (Groq `qwen/qwen3.8-27b`, Cuttlefish): uploading API Demos 6.0.17 answered 201 with `aiRuns` and the saved test ran against THAT build id (`trigger=upload`) and passed. `run_on_upload` on a saved test: a NEW build of its package (not a re-upload) queues it against that build id. Best effort — an upload never fails for AI; the answer carries `aiRuns` / `aiRunsSkipped`; `mfarm app upload` prints them |
| C8 | AI failure diagnosis | Merged — **failed on hardware, fixed in #214** | #207, #214, #215 | 2026-09-26 on the farm (Groq `qwen/qwen3.8-27b`, Cuttlefish): a 500 — the request was 17.5k tokens and Groq's free tier refuses any over 7k (413), and a model error escaped as "Internal error". #214: a 503 saying what the provider said, nothing billed; `MFARM_AI_MAX_INPUT_TOKENS` trims oldest log lines first. Re-verify after deploy. `POST /v1/ai/diagnoses {sessionId}` (migration 063): the reported failure, last 40 WebDriver commands, the last 250 logcat lines, the last screenshot and any AI steps → one structured call → app_bug / test_bug / environment / unknown + evidence + fix. Billed from the same budget; kept, so it is shown rather than re-bought. "Explain this failure" under every failed result 09-26 after #214: the 503 and the input budget work on the farm; one diagnosis then failed inside Groq's strict JSON mode (`json_validate_failed`) — the same request parsed on 2 of 2 re-sends, so #215 asks once more. |
| C9 | Export as script | Merged — **defect fixed in #214** | #208, #214 | 2026-09-26 on the farm (Groq `qwen/qwen3.8-27b`, Cuttlefish): both files generated, but the Settings "Display" tap exported as `id=android:id/title` — an id every row shares, so the script taps the first row. #214: a step records which locators are unique on its screen; only those are used. `GET /v1/ai/runs/:id/script?lang=webdriverio\|python`: each step now records the element it landed on (`action.target`); locators best-first (id → accessibility → text → marked FRAGILE coordinates); auth by header exactly as `examples/` do; ends in a TODO assertion, never a fake one. Generated files are parse-checked in tests (TypeScript + Python `ast`), including a hostile prompt |
| C10 | Share an AI run | **Shipped** | #208 | 2026-09-26 on the farm (Groq `qwen/qwen3.8-27b`, Cuttlefish): a passed run's result link opened anonymously with the task, verdict and every step's screen. "Share" on a passed/failed AI run → the existing result link; the public page adds the task, verdict and every step with its screen (`/v1/shares/:token/ai-steps/:n/screenshot`, scoped to that run). **Typed text is never sent** — only its length |

## 4. Open questions and what would change them

- **Real cost per step.** Unknown until measured on the farm. The first 20 real runs set the price.
- **Which model.** Defaults to `claude-opus-5` for both profiles (effort `low` for Flash, `high` for
  Pro), overridable by `MFARM_AI_MODEL`. A cheaper model for Flash is a pricing decision for the
  owner, not an engineering default.
- **Turning it on.** `MFARM_AI_API_KEY` in `deploy/.env` on the control plane (runbook: "Turn on AI
  runs"). Unset, `POST /v1/ai/runs` answers 503 and the runner never starts — every farm is AI-off
  until its owner opts in. The key is provider-agnostic: `MFARM_AI_PROVIDER` picks the wire protocol
  (`anthropic`, or `openai` for any OpenAI-compatible endpoint) and `MFARM_AI_BASE_URL` a gateway.
  `ANTHROPIC_API_KEY` still works as a fallback.
- **Determinism.** AI runs are not a CI gate. The console says so; C9 is the path to a gate.
- **Verifying without a paid key (2026-09-26).** The owner wants C2–C10 exercised on the farm before
  paying for model calls. The first key tried (Gemini, prepaid project) was valid but out of credit —
  402 on every current model; 2.5-series ids answer 404 to new users. GitHub Models, which #213 named
  here as a free path, is NOT one: it was retired 2026-07-30 and `models.github.ai` now answers
  `200 OK` in plain text to every path. What worked is **Groq's free tier** with `qwen/qwen3.8-27b`,
  its only model that takes an image and tools: ~0.8s per model call, but **7,000 input tokens a
  minute** and ~4.4k counted per step, so about one step every 35s and **one run at a time**
  (`AI_MAX_CONCURRENT_RUNS=1`) — two at once starved each other into `model_error`. Runbook: "Turn on
  AI runs". **The day's real ceiling is 200,000 tokens (TPD)** — about 45 steps; one afternoon of
  verification used all of it, and the next call is refused for ~45 minutes (a wait the retry does
  not sit through). Caveat: a free model's token counts do NOT calibrate the price of the model we
  will sell on.
- **Flash and Pro on a non-Anthropic provider are the same model.** `effort` is Anthropic-only and is
  dropped by the `openai` adapter, so the only Pro difference there is the plan step and the verdict
  re-check. Open: a separate Pro model id before Pro is sold on such a provider.
