# ADR-0046 — the model writes a test once; the farm runs it

**Status:** Accepted · 2026-09-27 · amends ADR-0043 (AI runs: C2, C3, C4, C6, C7, C9) · the owner chose §6's
recommended pricing and asked for phase 1 to start the same day

## Context

The owner, 2026-09-27: an AI login test costs ₹40–50, "and that's not even a test started … what we
are having today is not worth it." The goal is **high inference and interaction at low cost**, the
thing that makes a customer choose MFARM's AI over writing Appium by hand.

### Where the ₹40–50 comes from

It is not the provider's bill. It is the shape of the engine multiplied by a flat price:

1. **A flat price per model call.** `pricing.ts` charges ₹4 a call on Flash and ₹9 on Pro, whatever
   model answered and whatever it read. The figure was derived from `claude-opus-5` list prices and
   was to be recalibrated from measured tokens; it never was. The farm runs on Groq's free tier, where
   a call costs MFARM nothing.
2. **One action per call.** `agent.ts` sets `disable_parallel_tool_use` and tells the model "tap the
   field first, then type_text", so each form field is two paid calls. Waiting is a paid call
   (`wait`); so is saying "passed" (`finish`); Pro adds a plan call and a confirm call. A login is
   ~10–12 calls, all spent before the feature under test is reached.
3. **Every run rediscovers the route.** A saved test, and every run-on-upload of it (C7), runs the
   full agent loop from its English prompt. Nothing learned by the last passing run is reused, so a
   suite of five saved tests on a team uploading ten builds a week costs 50 full agent runs a week.
4. **Every call carries a full screenshot.** The element list is already lean (`parseUiTree` drops
   invisible and meaningless nodes, caps at 150), so the image is most of each call's input: the
   tracker records ~2.4–3.4k input tokens a step on the farm; on Claude a 720×1280 screen is ~1.2k
   image tokens and a 1080×2340 one ~3.4k (tokens ≈ w×h/750).

The first three are structural. A cheaper model alone moves the bill from ₹44 to perhaps ₹5 and
leaves re-runs paying it forever; it does not change what the product is.

### What the industry converged on

Every tool that sells AI testing at scale separates **authoring** (AI) from **running** (no AI):

- **Momentic** caches each resolved step (position, appearance, text, accessibility signals). On
  replay the stored signals are matched against the live screen and the action runs **without an LLM
  call**; on a mismatch the step is re-resolved by AI and the entry is **healed in place**. The cache
  is saved only from passing runs, expires after 14 days, and is scoped per branch. Cached steps run
  within ~52 ms of hand-written Playwright.
- **Stagehand (Browserbase)** caches the resolved selector per action with a page fingerprint and
  validates the page still matches before replaying — "a wrong cached click is worse than a slow
  click" — falling back to inference on drift and re-caching the new resolution. Reports second runs
  up to ~80% faster, the second making no LLM call at all.
- **Octomind**: "AI doesn't belong in test runtime" — AI writes and fixes tests, execution is
  deterministic Playwright; AI is invoked again only to auto-fix a test the UI broke.
- **GPT Driver (MobileBoost)**, mobile: deterministic commands are "fast, deterministic, and free to
  execute"; AI is a fallback when a command fails (a popup, a missing element). Billed per AI step.
- **Midscene.js** caches the plan by prompt and the located element by locate-prompt.
- **Google Artemis** (our inspiration): accessibility tree first, OCR second, vision only for
  canvas/Compose/Flutter; Flash is one call per step at 3–5 s; "fast-action bursts" chain several
  taps into one call; old history is folded into summaries.

MFARM already has most of the parts. C9 (`export.ts`) turns a passed run into best-first locators,
and every step records which of id / label / text were **unique** on its screen (`ActionTarget.unique`)
— that is exactly the step-cache entry the tools above store. It is written to a file for the
customer and never read back by us.

## Decision

**AI is an author and a repairer, not a runtime.** A passing AI run is compiled into a plan; the plan
is what runs from then on. The model is called only for the part of a run the plan cannot do.

### 1. Four ways to run a step, cheapest first

| Tier | What runs | Model calls | Cost to MFARM |
|---|---|---|---|
| **0 Replay** | The compiled step: match the screen, resolve the locator in the parsed tree, act, wait for the screen to settle, check what should appear | 0 | ₹0 |
| **1 Local recovery** | Alternate locators (id → label → text → normalised text → same kind at the same relative place), scroll-search, the interruption rules (§4) | 0 | ₹0 |
| **2 Scoped heal** | One grounding call for THIS step only: its intent, its recorded target, the current element list → the element to use. Screenshot only when the tree is poor | 1, small model | ~₹0.3 |
| **3 Agent** | The existing loop, from this step on, with the remaining intents | a few | ~₹0.3 each |

A run that reaches tier 3 and passes writes a new plan version. A heal is persisted only when the
whole run passes (Momentic's rule): a failing run never teaches the plan anything.

**Never "try anyway".** Every replayed step checks the screen BEFORE (its anchors are present) and
AFTER (its expected next anchors appear, within a settle timeout). Any mismatch is a miss that drops
to the next tier. A replay that taps the wrong thing is worse than a heal that costs ₹0.3.

### 2. What a compiled plan holds

`ai_test_plans` (migration 065), one row per version, pointing at the saved test and the run that
wrote it:

- **steps**, each: the intent in words (the agent's `why`); the action (`tap`, `fill`, `scroll`,
  `key`, `launch`); the target's locator set with its uniqueness (from `ActionTarget`); the typed text
  **as placeholders only** — `{{PIN}}` stays `{{PIN}}` (ADR-0045); a **before** signature (package,
  and up to eight stable anchors: unique ids and static labels, never numbers, times or counts); an
  **after** expectation (the next step's anchors, or the assertion for the last step).
- **assertion**: what proves the verdict, as a check the executor evaluates — text / id / label that
  must be present (or absent). Compiled from a new structured `expect` field on `finish` (§3.5).
  This also gives C9's exported script a real assertion instead of its TODO.
- **model** that authored it, **source run**, **build** it last passed on, **created_at**.

The run page says how each step ran: "7 of 7 steps replayed · 0 AI calls · ₹0 · 11 s", and a heal
shows its diff — "step 3: 'Sign in' is now 'Log in' — healed".

### 3. Authoring gets cheaper and faster (applies to every AI call that remains)

1. **Compound actions.** `fill(index, text, submit?)` taps and types in one call;
   `fill_form([{index, text}], then_tap?)` fills a screen's fields in one call (Artemis's bursts).
   The executor stops a batch if the screen changes under it. The "tap first, then type" instruction
   goes. A login becomes one decision.
2. **Settle, don't wait.** After every action the executor polls the tree until two reads match or
   the expected element appears (bounded). `wait` stays for genuinely long loads, and is rarely paid.
3. **Interruptions are rules, not calls** (§4) — the model never pays to press "Allow".
4. **Text first.** A call sends the element list; the screenshot is attached only when the tree is
   poor (few meaningful elements for the screen's area: canvas, Flutter, WebView), after an action
   that had no visible effect, for a verdict, or when the model asks (`look`). When sent it is
   downscaled to 768 px on the long edge as JPEG (~0.4k tokens instead of 1.2–3.4k), and `tap_point`
   coordinates are scaled back. Evidence screenshots are still kept at full size; they are not the
   model's input.
5. **The verdict is checked locally.** `finish` carries `expect`; the executor checks it on the
   settled screen. A pass the screen does not show is refused and the loop continues — the agent can
   no longer declare victory on a screen that disagrees, and Pro's confirm call is replaced by the
   check.
6. **History is compressed**: the last 8 steps verbatim, older ones as one summary line.
7. **Model by job, not by profile.** Acting calls use a small fast vision model; two steps without
   progress, or a failed heal, escalate the next call to a stronger one; Pro's plan uses the stronger
   one once. Each model's capabilities are one table in `provider.ts` (Haiku 4.5, for one, rejects
   `output_config.effort` and takes budgeted rather than adaptive thinking — the loop sends both on
   every call today). A free tier is never production: Groq's free tier caps output at 1,000 tokens a
   minute and has a daily cap (D54).
8. **Output is short**: `why` is one short sentence and acting calls get a small `max_tokens`.

### 4. Interruption rules

Before tier 0 and before any model call, the executor clears known interruptions by rule: Android
permission prompts (the permission controller's allow buttons; `autoGrantPermissions` already covers
install-time grants), "isn't responding" (Wait), a soft keyboard covering the target, the app having
left the foreground (relaunch the app under test). An org can add rules for its own app ("if 'Rate
us' is on screen, tap 'Not now'"), as Maestro's conditional flows do. A rule firing is recorded as a
step, costs nothing, and is never billed.

### 5. Shared sub-flows (after the plan works)

Most tests of one app begin the same way: launch, dismiss onboarding, log in. A plan's steps are
grouped by intent, and a group is cached per app package keyed by its normalised intent and its
before-signature. A new saved test on the same app replays the login it shares with every other test
and pays only for its new part. This is the multiplier that makes a suite cheap, not just a test.

### 6. What the customer pays — decided: pay for AI only when AI works

The owner chose this on 2026-09-27, over the two alternatives below.

- A replayed run is **device-minutes only**; its AI line reads ₹0.
- Every model call that does run (authoring, heal, agent) is billed from its **measured** tokens ×
  the model's price × a margin, rounded up, and shown on the run. No-action turns, rule firings and
  local checks are never billed.
- The monthly budget and step cap stay; the budget now counts real spend.

Not chosen: a flat price per authoring run with a cap and free replays; or an included allowance of
AI calls per plan. Until phase 1c ships, the flat ₹4/₹9 is charged once per CALL — the other steps a
call takes cost nothing.

### 7. What is measured

Each run records model calls, tokens and **actual** cost per call (by model), and steps by tier
(replayed / recovered / healed / agent). An eval suite (`deploy/ai-eval.mjs`) runs a fixed task set
on the farm — Settings, API Demos, and a small login app — and reports success rate, calls, tokens,
cost and wall time per model and profile. No model, prompt or pricing change ships without its
numbers. Targets:

| Measure | Today (est.) | Target |
|---|---|---|
| Login test, first (authoring) run | ~11 calls, ₹44 billed | ≤ 4 calls, ≤ ₹2 cost |
| Re-run of an unchanged saved test | the same again | 0 calls, ₹0 AI |
| Re-run after a small UI change | the same again | 1 heal, ~₹0.3 |
| Seconds per replayed step | 5+ (model per step) | 1–2 |

## Consequences

- **Re-runs become free and fast**, which is what a regression suite needs and what per-call AI
  pricing can never offer. C7 (run on upload) becomes affordable: most uploads replay.
- **Verdicts become reproducible.** A replayed pass is an assertion that held, not a model's opinion.
- **Faster runs also cut device-minutes**, which the customer pays for too.
- **More state to keep right**: plan versions, heal persistence, per-app sub-flow caches. Every miss
  drops a tier; nothing is replayed on a screen that does not match.
- **Replay sees less than an agent.** It checks the compiled assertion, not "does this look right".
  Pro can keep one AI verdict call at the end of a replayed run, billed as one call.
- **Exploratory runs stay agentic.** A saved test is either `regression` (replays) or `explore`
  (always the agent — finding what nobody wrote down is its point).

## Rollout

Each phase ships and is verified on the farm before the next starts; each is measured by the eval.

1. **Fewer, smaller calls** (no migration), as three PRs:
   - **1a — fewer calls:** several actions per call (`type_text` names its field, so tapping it is no
     longer a call of its own), settle after every action, interruption rules, the verdict's `expect`
     checked on the screen (replacing Pro's confirm call when it holds), one charge per call.
   - **1b — smaller calls:** text-first observation with downscaling; history compression.
   - **1c — the right model, the real price:** the model table and routing; every call's actual cost
     recorded; §6's pricing.
   Exit: a login authoring run in ≤ 4 calls on the eval.
2. **Compile and replay** (migration 065, this ADR accepted): the plan table; the compiler (reusing
   `export.ts`'s `locatorFor`); tiers 0–2 in the runner; tier 3 hand-off; the run page's per-tier line
   and heal diffs. Exit: an unchanged saved test re-runs with 0 model calls; a renamed button heals in
   one call and the next run replays it.
3. **Shared sub-flows** per app package. Exit: a second saved test on the same app replays its login.
4. **Pricing** — whichever §6 option the owner chooses; console reads it from `/v1/ai/pricing`.
5. **Only if volume justifies it:** a self-hosted grounding model (UI-TARS / Qwen-VL class) for
   tier 2, on a GPU host, once paid heal calls cost more than the host.

## Alternatives considered

- **Keep the agent on every run, just use a cheaper model.** ~₹5 a login instead of ₹44, forever,
  on every build, and still ~10 calls of latency. Rejected as the end state; adopted as §3.7.
- **Export as script (C9) is enough.** It is the same idea, but it hands the customer a file to
  maintain — the manual-QA buyer (the largest one, §1 of the tracker) cannot — and it never heals.
  Replay keeps the plan inside MFARM, healed by MFARM.
- **Bring your own key.** Moves the bill, not the waste; the owner chose MFARM-paid (2026-09-24).

## Sources

- Momentic, step caching: https://momentic.ai/docs/reliability/step-cache
- Browserbase, how caching works in Stagehand: https://www.browserbase.com/blog/stagehand-caching
- Octomind, AI doesn't belong in test runtime: https://www.octomind.dev/blog/ai-doesnt-belong-in-test-runtime
- GPT Driver (MobileBoost): https://www.mobileboost.io/
- Midscene.js, caching: https://midscenejs.com/caching.html
- Google Artemis: https://github.com/google/artemis
