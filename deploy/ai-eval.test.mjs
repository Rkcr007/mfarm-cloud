// Unit tests for the counting in ai-eval.mjs.
//
// The eval is how ADR-0046's claims are judged, so the one thing it must not do is count wrong: a
// "calls" figure that counted every STEP would make a one-call login read as four calls, and one that
// counted rule steps would bill the model for a permission prompt it never saw.
//
//   node --test deploy/ai-eval.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { summarise, table, TASKS } from './ai-eval.mjs';

const step = (input, output, action = { tool: 'tap_element', input: {} }) => ({ tokens: { input, output }, action });

test('a call is a step that carries tokens; the rest of the call, and rule steps, are not calls', () => {
  const steps = [
    step(0, 0, { tool: 'tap_element', input: { rule: 'permission' } }), // answered by rule
    step(2800, 140),                                                    // one call…
    step(0, 0), step(0, 0), step(0, 0),                                 // …that did four steps
    step(900, 60, { tool: 'finish', input: {} }),                       // a second call
  ];
  const run = { status: 'passed', stopReason: null, costInr: 1.23, model: 'm',
    startedAt: '2026-09-27T10:00:00.000Z', endedAt: '2026-09-27T10:00:31.450Z' };
  assert.deepEqual(summarise('login', run, steps), {
    task: 'login', status: 'passed', stopReason: null, calls: 2, steps: 6, byRule: 1,
    inputTokens: 3700, outputTokens: 200, costInr: 1.23, seconds: 31.5, model: 'm', replayed: 0, route: null,
  });
});

test('a run of a saved route counts its replayed steps and names the route — and no calls', () => {
  const replay = (tool) => ({ tokens: { input: 0, output: 0 }, action: { tool, input: {} }, by: 'replay' });
  const r = summarise('login #2', { status: 'passed', costInr: 0, planVersion: 1 }, [replay('type_text'), replay('tap_element'), replay('finish')]);
  assert.equal(r.calls, 0);
  assert.equal(r.replayed, 3);
  assert.equal(r.route, 1);
  assert.match(table([r]), /3 \(route v1\)/);
});

test('a run that never started has no wall time rather than a made-up one', () => {
  const r = summarise('x', { status: 'error', stopReason: 'no_device', costInr: 0, startedAt: null, endedAt: null }, []);
  assert.equal(r.seconds, null);
  assert.equal(r.calls, 0);
  assert.match(table([r]), /error \(no_device\)/);
});

test('the fixed tasks include a login-shaped one, and every task names what proves it done', () => {
  assert.ok(TASKS.some((t) => /password/i.test(t.prompt)), 'a form with a password field');
  for (const t of TASKS) assert.match(t.prompt, /check that/, t.id);
  assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length);
});
