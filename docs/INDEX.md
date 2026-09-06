# MFARM — start here

**There are three documents. Everything else is reference under one of them.**

| | |
|---|---|
| **[STATUS.md](STATUS.md)** | What the product is, what works, what is left in priority order, and what it costs to run. **Open this first.** |
| **[DEFECTS.md](DEFECTS.md)** | Everything wrong with it, how each was found, and the rule for when one is closed. |
| **[DIRECTION.md](DIRECTION.md)** | What changed and why — every pivot, every decision and the alternative it rejected, the roads not taken, the invariants, and what hardware taught us that tests could not. |

---

### Why this page is now four lines

It used to be "the one curated page" and carried the status, the decisions and the roadmap together.
That made it the single most load-bearing file in the repo and the one most likely to be wrong: on
2026-09-06 it was found pinned thirteen days and sixteen migrations behind, listing four things as
pending that were already built and one library as unpublishable that had been on npm for a week.

Splitting it is not tidying. **Status decays weekly, decisions do not decay at all, and defects have
their own lifecycle** — keeping them in one document meant the parts that never change dragged the
part that changes constantly out of date, and nothing forced a re-read. Each of the three now has
one job and one reason to be edited.

The filename stays because a lot of things link to it.

---

### The rest, and where it sits

- **Operating it** — [START_HERE.md](START_HERE.md) (closed laptop → a device you can tap),
  [RUNBOOK.md](RUNBOOK.md) (start, ship, stop), [DOMAIN_PLAN.md](DOMAIN_PLAN.md).
- **Using it** — [EXECUTION_MODEL.md](EXECUTION_MODEL.md) (how a suite actually runs),
  [ci.md](ci.md), [RENDER_BASELINE.md](RENDER_BASELINE.md) (what SwiftShader can and cannot test),
  [../examples/medishop-suite/README.md](../examples/medishop-suite/README.md).
- **Building on it** — [AGENT_BUILD_PLAN.md](AGENT_BUILD_PLAN.md),
  [PHYSICAL_DEVICES.md](PHYSICAL_DEVICES.md), [adrs/](adrs/) (26 decisions; there is no 0013).
- **The record** — [../HANDOFF.md](../HANDOFF.md), the numbered session log. **Trust its dated
  entries over its summary sections:** the entries have held up under two audits, the summaries have
  been found carrying seventeen and then twelve stale claims.
- **Historical** — [MVP_PLAN.md](MVP_PLAN.md), [E2E_MVP_PLAN.md](E2E_MVP_PLAN.md), and the two
  `product_guide` files at the repo root. Read for reasoning, not for current truth.
