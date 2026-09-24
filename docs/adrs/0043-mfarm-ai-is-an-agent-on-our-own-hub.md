# ADR-0043 — MFARM AI is an agent on our own hub

**Status:** Accepted · 2026-09-24 · extends ADR-0018 · product tracker: [AI_PRODUCT_LINE.md](../AI_PRODUCT_LINE.md)

## Context

[google/artemis](https://github.com/google/artemis) (Apache-2.0) turns an English instruction into
taps, types and swipes on an Android phone: a planner/operator/checker loop, element location by
accessibility tree first and vision as a fallback, a fast reactive profile (~3–5 s/step) and a
deliberate one (~15–40 s/step), and an MCP server so coding agents can drive a phone. The owner asked
what it could add to MFARM, then asked for it as a product line: an MCP server, a console section, and
every capability that fits, tracked until built.

Artemis as shipped does not fit the farm. It is Python beside the phone, speaking **local ADB** by
serial number. MFARM gives customers no ADB — they get WebDriver sessions, the live view and runs —
and hosting Artemis on our device hosts would put a second runtime on every host and make it
Android-only.

But everything Artemis needs from a device is already served by `/wd/hub`: screenshot, page source
(the accessibility tree), W3C pointer actions, key presses, app activation and logs. The hub forwards
every command verbatim and records each as a step (migration 041).

## Decision

**1. The capability is rebuilt natively over the hub; Artemis's code is not embedded.** (Owner
decision, 2026-09-24, over the alternative of installing Artemis on each host.) One agent drives
Android and iOS, and every AI action goes through the same hub as a scripted command. So it is
recorded, the device is reset afterwards (ADR-0012), and the run lands in the same evidence, shares
and flake history. Artemis itself remains usable, as a *client*, through the MCP server.

**2. The MCP server (`mfarm mcp`) is pure Model A.** It lives in the zero-dependency CLI and is a
WebDriver client of the hub: the customer's agent is the process, MFARM is the device and the record.
ADR-0018 is untouched. It holds one device at a time and releases it on `end_session`, on stdin
closing, and on SIGINT/SIGTERM. The agent's view of the screen is `parseUiTree` in
`@mfarm/protocol`, vendored into the CLI, so the MCP server and MFARM's own engine number elements
identically.

**3. An AI run is MFARM running its own process, and that does not contradict ADR-0018.** ADR-0018
refused to run the *customer's test code*, for two reasons. We would track every framework forever,
and we would stand between a customer and their own exit code. An AI run holds no customer code: the
prompt is data, the loop is ours, and its verdict is ours to state. What ADR-0018 keeps holds here
too. The execution is a record (`runs` + `sessions` + `execution_events`), the end is declared
(the agent's `finish`, or a stated failure reason), and the farm retries devices, never the test.

**4. MFARM pays the model provider and bills per AI step.** (Owner decision, 2026-09-24. I
recommended bring-your-own-key and was overruled.) One model call is one step, priced by an exported
server constant. Its tokens are stored, so the price can be re-derived from data. A per-run step cap
and a per-org monthly AI budget stop a run *before* it bills past either.

**5. The engine drives the hub in-process with a per-run key.** Each AI run mints an
`automation`-scope API key that expires with the run and is revoked when it ends. The engine sends
WebDriver commands with Fastify `inject()` against `/wd/hub`, so allocation, app install, run joining,
step recording and release all use the hub's existing code. There is no socket and no new trust path.
These keys are hidden from the org's key list.

**6. AI runs are not a CI gate.** They are non-deterministic and the console says so. The path to a
gate is capability C9: export a passed run as a WebDriver script, which then runs on the hub like any
suite.

## Consequences

- The hub's forwarding stays the one door to a device. Nothing here widens what a tenant can reach.
- `apps/api` gains its first model-provider dependency (`@anthropic-ai/sdk`) and a secret
  (`ANTHROPIC_API_KEY`). Without the secret, AI runs are refused with a clear reason rather than
  queued forever.
- Model choice is `MFARM_AI_MODEL` (default `claude-opus-5`; effort `low` for Flash, `high` for Pro).
  A cheaper model is a pricing decision for the owner, not an engineering default.
- **Addendum 2026-09-25 — the credential is provider-agnostic** (owner request). The key is
  `MFARM_AI_API_KEY`; `MFARM_AI_PROVIDER` names the wire protocol — `anthropic` (default) or `openai`,
  meaning any OpenAI-compatible Chat Completions endpoint (OpenAI, Gemini, OpenRouter, Mistral, Groq,
  Ollama, vLLM, LiteLLM) — and `MFARM_AI_BASE_URL` points either at a gateway. The agent loop still
  speaks the Anthropic shape internally; `ai/provider.ts` translates at that one boundary. Adaptive
  thinking, effort and prompt caching are Anthropic features and are dropped on the `openai` path,
  so Flash and Pro differ there only by step cap and the Pro plan/verify turns. `ANTHROPIC_API_KEY`
  remains a fallback. The per-step prices were derived from `claude-opus-5` and do not change with
  the provider: another model changes MFARM's cost per step, not what a customer is billed.
- An AI run in flight when the API restarts is marked `error: interrupted`. It is not resumed: its
  in-memory key is gone and the device state is unknown.
