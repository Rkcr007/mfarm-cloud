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
    // A replay's own scroll looking for an element is not part of the route: the next replay looks
    // again, as far as it needs to — the list may be longer or shorter by then.
    if (tool === 'wait' || (tool === 'scroll' && input.search === true)) continue;
    if (!REPLAYABLE.has(tool)) return null;
    if (needsElement({ tool, input }) && !locatable(target)) return null;
    const { why, ...rest } = input;
    out.push({ tool, input: rest, target: target ?? null, intent: typeof why === 'string' ? why : '' });
  }
  return out.length ? { steps: out, expect } : null;
}

// ---------------------------------------------------------------- what a repair changed

/** One difference between a route and the version a run repaired it into. `step` is 1-based. */
export interface RouteChange {
  kind: 'changed' | 'added' | 'removed';
  /** Its place in the new route; for a removed step, in the old one. */
  step: number;
  before: string | null;
  after: string | null;
}

/** The name a person knows an element by: its text, its label, or the last part of its id. */
function nameOf(t: ActionTarget | null): string | null {
  if (!t) return null;
  return t.text ?? t.label ?? (t.id ? t.id.slice(t.id.lastIndexOf('/') + 1) : null);
}

/** A route step in words — "Tap “Sign in”", "Type “{{EMAIL}}” into “Email”". */
export function stepWords(s: PlanStep): string {
  const name = nameOf(s.target);
  const on = name ? ` “${name}”` : '';
  switch (s.tool) {
    case 'tap_element': return `Tap${on}`;
    case 'type_text': return `Type “${String(s.input.text ?? '')}”${name ? ` into “${name}”` : ''}`;
    case 'scroll': return `Scroll ${String(s.input.direction ?? '')}`.trim();
    case 'press_key': return `Press ${String(s.input.key ?? '')}`.trim();
    case 'launch_app': return `Open ${String(s.input.app_id ?? '')}`.trim();
    default: return `${s.tool}${on}`;
  }
}

/**
 * What a repair changed, step by step: the two routes aligned by what each step does to which element
 * (the longest common run of steps), and each place they part reported — a step that became another
 * ("Tap “Log in”" → "Tap “Sign in”"), one the new route added, one it dropped.
 */
export function diffRoutes(before: PlanStep[], after: PlanStep[]): RouteChange[] {
  const key = (s: PlanStep) => stepWords(s);
  const a = before.map(key);
  const b = after.map(key);
  // lcs[i][j]: the longest common run of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: RouteChange[] = [];
  let i = 0;
  let j = 0;
  const removed: Array<{ step: number; words: string }> = [];
  const added: Array<{ step: number; words: string }> = [];
  const flush = () => {
    // A step dropped where one was added is a step that changed.
    while (removed.length && added.length) {
      const was = removed.shift()!;
      const now = added.shift()!;
      out.push({ kind: 'changed', step: now.step, before: was.words, after: now.words });
    }
    for (const now of added.splice(0)) out.push({ kind: 'added', step: now.step, before: null, after: now.words });
    for (const was of removed.splice(0)) out.push({ kind: 'removed', step: was.step, before: was.words, after: null });
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      added.push({ step: j + 1, words: b[j]! });
      j++;
    } else {
      removed.push({ step: i + 1, words: a[i]! });
      i++;
    }
  }
  flush();
  return out;
}
