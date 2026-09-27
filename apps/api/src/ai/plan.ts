import type { UiElement } from '@mfarm/protocol';
import type { ActionTarget } from './agent.ts';

/**
 * A SAVED TEST'S ROUTE (ADR-0046 phase 2) — the model writes a test once; the farm runs it.
 *
 * When a run of a saved test passes, and its verdict named what on the screen proves it (`expect`),
 * the steps that worked are kept as a plan: each action, the element it landed on, and which of that
 * element's id / label / text named it ALONE on its screen (`ActionTarget.unique`, recorded since
 * C9). The next run replays the plan with no model (agent.ts), finds each element again by the
 * locator that was unique, and checks `expect` on the screen itself. Where the app no longer matches,
 * the model takes over from that step; a run that then passes writes the next version.
 *
 * A route is only kept when every step can be found again for certain. A tap at a bare coordinate, or
 * on an element nothing named alone, would replay onto whatever is there now — and a replay that taps
 * the wrong thing is worse than a model call that costs a rupee.
 */

export interface PlanStep {
  tool: string;
  /** As the agent sent it, minus `why`; typed text as its `{{PLACEHOLDER}}` (ADR-0045). */
  input: Record<string, unknown>;
  target: ActionTarget | null;
  /** What the step was for, in the agent's words — shown on the run, and read by a model taking over. */
  intent: string;
}

export interface RunPlan {
  id: string;
  version: number;
  steps: PlanStep[];
  expect: string;
}

export interface RecordedStep {
  action: { tool: string; input: Record<string, unknown>; target?: ActionTarget | null } | null;
  result: string | null;
  model: string;
}

/** The actions a route may hold. `wait` is not one — replay waits for each element anyway. */
const REPLAYABLE = new Set(['tap_element', 'type_text', 'scroll', 'press_key', 'launch_app']);

/** Whether a step acts on an element that must be found on the screen first. */
export function needsElement(s: { tool: string; input: Record<string, unknown> }): boolean {
  if (s.tool === 'tap_element') return true;
  if (s.tool !== 'type_text') return false;
  const i = Number(s.input.index ?? -1);
  return Number.isInteger(i) && i >= 0;
}

const LOCATORS = ['id', 'label', 'text'] as const;

/** Whether a recorded target can be found again for certain: one of its locators named it alone. */
export function locatable(t: ActionTarget | null | undefined): t is ActionTarget {
  return Boolean(t?.unique && LOCATORS.some((k) => t.unique![k] && t[k] !== null));
}

/**
 * The element a recorded target was, on the screen as it is now — by the first locator that named it
 * alone then AND names exactly one element of the same kind now. Undefined when none does: the app
 * changed, or this is not the screen the step was taken on.
 */
export function locate(t: ActionTarget, elements: UiElement[]): UiElement | undefined {
  for (const k of LOCATORS) {
    if (!t.unique?.[k] || t[k] === null) continue;
    const hits = elements.filter((e) => e.kind === t.kind && e[k] === t[k]);
    if (hits.length === 1) return hits[0];
  }
  return undefined;
}

/**
 * The route a passing run took, or null when it cannot be replayed for certain: the run did not pass
 * with an `expect`, or a step that worked was one no replay can repeat safely.
 */
export function compilePlan(steps: RecordedStep[]): { steps: PlanStep[]; expect: string } | null {
  const verdict = [...steps].reverse().find((s) => s.action?.tool === 'finish' && s.result === 'passed');
  const expect = typeof verdict?.action?.input.expect === 'string' ? verdict.action.input.expect.trim() : '';
  if (!expect) return null;
  const out: PlanStep[] = [];
  for (const s of steps) {
    // Only what worked: a failed step, a refused verdict and a rule's answer (replay applies the rules
    // itself) are not part of the route.
    if (!s.action || s.result !== 'ok' || s.model === 'rule') continue;
    const { tool, input, target } = s.action;
    if (tool === 'wait') continue;
    if (!REPLAYABLE.has(tool)) return null;
    if (needsElement({ tool, input }) && !locatable(target)) return null;
    const { why, ...rest } = input;
    out.push({ tool, input: rest, target: target ?? null, intent: typeof why === 'string' ? why : '' });
  }
  return out.length ? { steps: out, expect } : null;
}
