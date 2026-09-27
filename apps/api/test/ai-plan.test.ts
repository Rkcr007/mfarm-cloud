import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiElement } from '@mfarm/protocol';
import type { ActionTarget } from '../src/ai/agent.ts';
import { compilePlan, locate, locatable, needsElement, type RecordedStep } from '../src/ai/plan.ts';

/**
 * A SAVED TEST'S ROUTE (ADR-0046 phase 2): what a passing run keeps, and how a step's element is found
 * again. The rule this defends: a route is kept only when every step can be found again FOR CERTAIN —
 * a replay that taps the wrong thing is worse than paying a model.
 */

const target = (over: Partial<ActionTarget>): ActionTarget => ({
  kind: 'Button', text: null, label: null, id: null, x: 0, y: 0, width: 100, height: 40,
  unique: { id: false, label: false, text: false }, ...over,
});
const el = (index: number, over: Partial<UiElement>): UiElement => ({
  index, kind: 'Button', text: null, label: null, id: null, x: 0, y: 0, width: 100, height: 40,
  clickable: true, focused: false, ...over,
});
const step = (tool: string, input: Record<string, unknown>, result: string | null, t: ActionTarget | null = null, model = 'm'): RecordedStep =>
  ({ action: { tool, input, target: t }, result, model });

const EMAIL = target({ kind: 'EditText', id: 'com.acme:id/email', label: 'Email', unique: { id: true, label: true, text: false } });
const LOGIN = target({ text: 'Log in', id: 'com.acme:id/login', unique: { id: true, label: false, text: true } });
const passed = step('finish', { passed: true, expect: 'Welcome back', summary: 's' }, 'passed');

test('a passing run with an expect is kept as its route: what worked, without its reasons', () => {
  const plan = compilePlan([
    step('tap_element', { index: 0, why: 'permission' }, 'ok', LOGIN, 'rule'),     // a rule's answer: replay applies rules itself
    step('type_text', { index: 0, text: '{{EMAIL}}', submit: false, why: 'the e-mail' }, 'ok', EMAIL),
    step('tap_element', { index: 9, why: 'wrong' }, 'failed: there is no element [9] on this screen'),
    step('wait', { seconds: 2, why: 'loading' }, 'ok'),
    step('finish', { passed: true, expect: 'Nope' }, 'refused: “Nope” is not on the screen'),
    step('tap_element', { index: 1, why: 'log in' }, 'ok', LOGIN),
    passed,
  ]);
  assert.deepEqual(plan, {
    expect: 'Welcome back',
    steps: [
      { tool: 'type_text', input: { index: 0, text: '{{EMAIL}}', submit: false }, target: EMAIL, intent: 'the e-mail' },
      { tool: 'tap_element', input: { index: 1 }, target: LOGIN, intent: 'log in' },
    ],
  });
});

test('no route without a pass that names what proves it', () => {
  const tap = step('tap_element', { index: 1 }, 'ok', LOGIN);
  assert.equal(compilePlan([tap, step('finish', { passed: true, expect: '' }, 'passed')]), null, 'no expect');
  assert.equal(compilePlan([tap, step('finish', { passed: false, expect: 'Error' }, 'failed')]), null, 'a failure');
  assert.equal(compilePlan([tap]), null, 'no verdict');
  assert.equal(compilePlan([passed]), null, 'nothing to replay');
});

test('no route when a step could not be found again for certain', () => {
  const shared = target({ id: 'android:id/title', unique: { id: false, label: false, text: false } });
  assert.equal(compilePlan([step('tap_element', { index: 3 }, 'ok', shared), passed]), null, 'nothing named it alone');
  assert.equal(compilePlan([step('tap_element', { index: 3 }, 'ok', null), passed]), null, 'no target recorded');
  assert.equal(compilePlan([step('tap_point', { x: 5, y: 5 }, 'ok'), passed]), null, 'a bare coordinate');
  assert.equal(compilePlan([step('tap_element', { index: 3 }, 'ok', { ...LOGIN, unique: undefined }), passed]), null,
    'recorded before uniqueness was');
  // Actions that need no element are kept without one.
  assert.equal(compilePlan([step('press_key', { key: 'back' }, 'ok'), passed])?.steps[0]?.tool, 'press_key');
  // A replay's own scroll looking for an element is not route: the next replay looks again.
  const searched = compilePlan([step('scroll', { direction: 'down', search: true }, 'ok', null, 'replay'),
    step('tap_element', { index: 1 }, 'ok', LOGIN, 'replay'), passed]);
  assert.deepEqual(searched?.steps.map((x) => x.tool), ['tap_element']);
  assert.equal(compilePlan([step('scroll', { direction: 'down' }, 'ok'), passed])?.steps[0]?.tool, 'scroll',
    'a scroll the model chose is route');
});

test('locate finds the element by the locator that named it alone — and only if it still does', () => {
  const now = [el(0, { kind: 'EditText', id: 'com.acme:id/email', label: 'Email' }), el(4, { text: 'Log in', id: 'com.acme:id/login' })];
  assert.equal(locate(LOGIN, now)?.index, 4, 'by id first');
  assert.equal(locate(LOGIN, [el(7, { text: 'Log in', id: 'com.acme:id/sign_in' })])?.index, 7, 'then by text');
  assert.equal(locate(LOGIN, [el(7, { text: 'Sign in', id: 'com.acme:id/sign_in' })]), undefined, 'the app changed');
  assert.equal(locate(LOGIN, [el(1, { text: 'Log in' }), el(2, { text: 'Log in' })]), undefined, 'two — not certain');
  assert.equal(locate(LOGIN, [el(1, { kind: 'TextView', text: 'Log in', id: 'com.acme:id/login' })]), undefined,
    'a different kind of thing is not the button');
});

test('which steps need an element, and which targets can be found again', () => {
  assert.ok(needsElement({ tool: 'tap_element', input: { index: 1 } }));
  assert.ok(needsElement({ tool: 'type_text', input: { index: 0 } }));
  assert.ok(!needsElement({ tool: 'type_text', input: { index: -1 } }), 'the focused field');
  assert.ok(!needsElement({ tool: 'scroll', input: {} }));
  assert.ok(locatable(LOGIN));
  assert.ok(!locatable(target({ id: 'x', unique: { id: false, label: false, text: false } })));
  assert.ok(!locatable(target({ unique: { id: true, label: false, text: false } })), 'unique, but no value');
});

// ---------------------------------------------------------------- what a repair changed

import { diffRoutes, stepWords, type PlanStep } from '../src/ai/plan.ts';

const ps = (tool: string, input: Record<string, unknown>, t: ActionTarget | null = null): PlanStep => ({ tool, input, target: t, intent: '' });
const SIGN_IN = target({ text: 'Sign in', id: 'com.acme:id/sign_in', unique: { id: true, label: false, text: true } });
const V1 = [ps('type_text', { index: 0, text: '{{EMAIL}}' }, EMAIL), ps('tap_element', { index: 1 }, LOGIN)];

test('a step in words: what it does, to what a person calls the element', () => {
  assert.equal(stepWords(V1[0]!), 'Type “{{EMAIL}}” into “Email”');
  assert.equal(stepWords(V1[1]!), 'Tap “Log in”');
  assert.equal(stepWords(ps('tap_element', {}, target({ id: 'com.acme:id/menu_button' }))), 'Tap “menu_button”');
  assert.equal(stepWords(ps('scroll', { direction: 'down' })), 'Scroll down');
});

test('a renamed button is one changed step; the steps around it are not reported', () => {
  const v2 = [V1[0]!, ps('tap_element', { index: 1 }, SIGN_IN)];
  assert.deepEqual(diffRoutes(V1, v2), [{ kind: 'changed', step: 2, before: 'Tap “Log in”', after: 'Tap “Sign in”' }]);
  assert.deepEqual(diffRoutes(V1, V1), [], 'an unchanged route has nothing to say');
});

test('a new step and a dropped one are said as such, at their places', () => {
  const consent = ps('tap_element', { index: 3 }, target({ text: 'Accept cookies', unique: { id: false, label: false, text: true } }));
  assert.deepEqual(diffRoutes(V1, [consent, ...V1]), [{ kind: 'added', step: 1, before: null, after: 'Tap “Accept cookies”' }]);
  assert.deepEqual(diffRoutes([consent, ...V1], V1), [{ kind: 'removed', step: 1, before: 'Tap “Accept cookies”', after: null }]);
  assert.deepEqual(diffRoutes([...V1, consent], V1), [{ kind: 'removed', step: 3, before: 'Tap “Accept cookies”', after: null }],
    'a removed step is numbered where it was in the old route');
});
