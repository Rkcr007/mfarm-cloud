import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import type { UiElement } from '@mfarm/protocol';
import {
  runAgent, sameElement, shows, interruptionOn, AGENT_TOOLS,
  type Device, type Model, type Sink, type StepRecord, type AgentTiming,
} from '../src/ai/agent.ts';

/**
 * THE LOOP ITSELF (ADR-0046) — fewer, cheaper calls — with a phone whose screens change when it is
 * tapped and a model that answers from a script. No database, no hub: what is under test is how many
 * calls a task costs, which of its steps are billed, and what the loop does without asking.
 */

const FAST: AgentTiming = { pollMs: 1, maxMs: 30, afterActionMs: 0, expectMs: 30, focusMs: 0 };

// ---------------------------------------------------------------- the phone

const node = (a: Record<string, string>) =>
  `<node ${Object.entries({ displayed: 'true', ...a }).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`;
const xml = (...nodes: string[]) => `<hierarchy>${nodes.join('')}</hierarchy>`;

const LOGIN = xml(
  node({ class: 'android.widget.EditText', text: 'Email', 'resource-id': 'com.acme:id/email', clickable: 'true', focusable: 'true', bounds: '[40,400][1040,520]' }),
  node({ class: 'android.widget.EditText', text: 'Password', 'resource-id': 'com.acme:id/password', clickable: 'true', focusable: 'true', bounds: '[40,560][1040,680]' }),
  node({ class: 'android.widget.Button', text: 'Log in', 'resource-id': 'com.acme:id/login', clickable: 'true', bounds: '[390,1160][690,1260]' }),
  node({ class: 'android.widget.TextView', text: 'Forgot password?', bounds: '[40,1300][600,1360]' }),
);
const HOME = xml(
  node({ class: 'android.widget.TextView', text: 'Welcome back, Asha', bounds: '[40,200][1040,300]' }),
  node({ class: 'android.widget.Button', text: 'Orders', clickable: 'true', bounds: '[40,400][500,500]' }),
  node({ class: 'android.widget.Button', text: 'Account', clickable: 'true', bounds: '[540,400][1040,500]' }),
);
const PERMISSION = xml(
  node({ class: 'android.widget.TextView', text: 'Allow Acme to send you notifications?', bounds: '[40,900][1040,1000]' }),
  node({ class: 'android.widget.Button', text: 'Allow', 'resource-id': 'com.android.permissioncontroller:id/permission_allow_button', clickable: 'true', bounds: '[40,1100][1040,1200]' }),
  node({ class: 'android.widget.Button', text: "Don't allow", 'resource-id': 'com.android.permissioncontroller:id/permission_deny_button', clickable: 'true', bounds: '[40,1220][1040,1320]' }),
);

interface Phone extends Device {
  screen: string;
  taps: Array<[number, number]>;
  typed: string[];
  sources: number;
}

/** A phone that shows `screen`, moves to another when a tap lands inside a `goto` box, and records all of it. */
function phone(screen: string, goto: Array<{ box: [number, number, number, number]; to: string | (() => string) }> = []): Phone {
  const p: Phone = {
    platform: 'android',
    screen,
    taps: [],
    typed: [],
    sources: 0,
    async screenshot() { return 'iVBORw0KGgo='; },
    async source() { p.sources++; return p.screen; },
    async size() { return { width: 1080, height: 2400 }; },
    async tap(x, y) {
      p.taps.push([x, y]);
      const hit = goto.find(({ box: [x1, y1, x2, y2] }) => x >= x1 && x <= x2 && y >= y1 && y <= y2);
      if (hit) p.screen = typeof hit.to === 'function' ? hit.to() : hit.to;
    },
    async typeText(t) { p.typed.push(t); },
    async swipe() {},
    async pressKey() {},
    async launchApp() {},
  };
  return p;
}

// ---------------------------------------------------------------- the model

type Tool = { tool: string; input: Record<string, unknown> };

function scripted(turns: Tool[][]): Model & { calls: Anthropic.Beta.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const m = (async (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
    calls.push(params);
    const turn = turns.shift() ?? [];
    const content = params.tools
      ? turn.map((t, i) => ({ type: 'tool_use', id: `tu_${calls.length}_${i}`, name: t.tool, input: { why: 'because', ...t.input } }))
      : [{ type: 'text', text: '1. Log in. 2. See the welcome.' }];
    return {
      id: `msg_${calls.length}`, type: 'message', role: 'assistant', model: params.model, content,
      stop_reason: turn.length ? 'tool_use' : 'end_turn', stop_sequence: null,
      usage: { input_tokens: 2000, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as Anthropic.Beta.BetaMessage;
  }) as Model & { calls: typeof calls };
  m.calls = calls;
  return m;
}

function sink(): Sink & { steps: StepRecord[] } {
  const steps: StepRecord[] = [];
  return { steps, async beforeStep() { return null; }, async record(s) { steps.push(s); } };
}

const run = (task: string, device: Device, model: Model, s: Sink, profile: 'flash' | 'pro' = 'flash') =>
  runAgent({ task, profile, device, sink: s, model, modelId: 'test-model', timing: FAST });

const loginTurn: Tool[] = [
  { tool: 'type_text', input: { index: 0, text: 'asha@example.test', submit: false } },
  { tool: 'type_text', input: { index: 1, text: 'hunter2', submit: false } },
  { tool: 'tap_element', input: { index: 2 } },
  { tool: 'finish', input: { passed: true, summary: 'Logged in', evidence: 'Welcome shown', expect: 'Welcome back' } },
];

// ---------------------------------------------------------------- tests

test('a login is ONE model call: both fields, the button and a verdict the loop checks itself', async () => {
  const device = phone(LOGIN, [{ box: [390, 1160, 690, 1260], to: HOME }]);
  const model = scripted([loginTurn]);
  const s = sink();
  const out = await run('Log in as asha', device, model, s);

  assert.equal(out.status, 'passed', JSON.stringify(out));
  assert.equal(model.calls.length, 1, 'one call did the whole login');
  assert.deepEqual(s.steps.map((x) => x.action?.tool), ['type_text', 'type_text', 'tap_element', 'finish']);
  assert.deepEqual(s.steps.map((x) => x.billed), [true, false, false, false], 'one call, one charge');
  assert.deepEqual(s.steps.map((x) => x.n), [1, 2, 3, 4]);
  assert.equal(s.steps[1]!.usage.input, 0, 'the call\'s tokens are counted once, on its first step');

  // Each field was tapped at its centre before it was typed into — no separate "tap the field" call.
  assert.deepEqual(device.taps, [[540, 460], [540, 620], [540, 1210]]);
  assert.deepEqual(device.typed, ['asha@example.test', 'hunter2']);
  // And each step records the field it typed into, which Export as script turns into a locator.
  assert.equal(s.steps[0]!.action?.target?.id, 'com.acme:id/email');
  assert.equal(s.steps[1]!.action?.target?.id, 'com.acme:id/password');
  assert.equal(s.steps[3]!.result, 'passed');
});

test('several actions in one call are allowed — the flag that forbade them is off', async () => {
  const model = scripted([loginTurn]);
  await run('Log in as asha', phone(LOGIN, [{ box: [390, 1160, 690, 1260], to: HOME }]), model, sink());
  assert.deepEqual(model.calls[0]!.tool_choice, { type: 'auto', disable_parallel_tool_use: false });
  const typeText = AGENT_TOOLS.find((t) => t.name === 'type_text') as { input_schema: { required: string[] } };
  assert.ok(typeText.input_schema.required.includes('index'), 'type_text names its field');
  const system = (model.calls[0]!.system as Array<{ text: string }>)[0]!.text;
  assert.doesNotMatch(system, /tap the field first/, 'the instruction that doubled every field is gone');
});

test('a verdict whose expect is not on the screen is refused, and the run carries on', async () => {
  // The Log in button does nothing: the model hoped, the screen disagrees.
  const device = phone(LOGIN);
  const model = scripted([
    loginTurn,
    [{ tool: 'finish', input: { passed: false, summary: 'Nothing happened', evidence: 'Still on login', expect: 'Log in' } }],
  ]);
  const s = sink();
  const out = await run('Log in as asha', device, model, s);
  assert.equal(out.status, 'failed');
  assert.equal(model.calls.length, 2);
  assert.match(s.steps[3]!.result ?? '', /^refused: “Welcome back” is not on the screen/);
  // The refusal is in what the model reads next.
  const next = (model.calls[1]!.messages[0]!.content as Array<{ type: string; text?: string }>)[0]!.text!;
  assert.match(next, /refused: “Welcome back” is not on the screen/);
});

test('the loop waits for an expected screen that is still loading, rather than refusing it', async () => {
  let reads = 0;
  const device = phone(LOGIN, [{ box: [390, 1160, 690, 1260], to: LOGIN }]);
  const source = device.source.bind(device);
  // After the tap, the home screen appears only on the fourth read — a login that takes a moment.
  device.source = async () => (device.taps.length >= 3 && ++reads >= 4 ? HOME : source());
  const model = scripted([loginTurn]);
  const out = await runAgent({
    task: 'Log in as asha', profile: 'flash', device, sink: sink(), model, modelId: 'test-model',
    timing: { ...FAST, expectMs: 500 },
  });
  assert.equal(out.status, 'passed', JSON.stringify(out));
  assert.equal(model.calls.length, 1);
});

test('a failure cannot be concluded after actions, before their result was seen', async () => {
  const model = scripted([
    [{ tool: 'tap_element', input: { index: 2 } }, { tool: 'finish', input: { passed: false, summary: 'x', evidence: 'x', expect: '' } }],
    [{ tool: 'finish', input: { passed: true, summary: 'In', evidence: 'Welcome', expect: 'Welcome back' } }],
  ]);
  const s = sink();
  const out = await run('Log in', phone(LOGIN, [{ box: [390, 1160, 690, 1260], to: HOME }]), model, s);
  assert.equal(out.status, 'passed');
  assert.match(s.steps[1]!.result ?? '', /^refused: a failure is concluded on a screen you have seen/);
});

test('later actions of a call find their element again by what it is — or are not done', async () => {
  // Tapping "Forgot password?" leaves the login screen, so the password field named next is gone.
  const device = phone(LOGIN, [{ box: [40, 1300, 600, 1360], to: HOME }]);
  const model = scripted([
    [{ tool: 'tap_element', input: { index: 3 } }, { tool: 'type_text', input: { index: 1, text: 'hunter2', submit: false } }],
    [{ tool: 'finish', input: { passed: false, summary: 'Wrong screen', evidence: 'Welcome', expect: '' } }],
  ]);
  const s = sink();
  await run('Reset the password', device, model, s);
  assert.equal(s.steps[1]!.result, 'failed: the screen changed before this step could act on it; it was not done');
  assert.deepEqual(device.typed, [], 'nothing was typed into a screen the model never saw');
  assert.equal(device.taps.length, 1);
});

test('a call\'s later action lands on its element where it is NOW, not where it was', async () => {
  // After the first field is typed into, a banner appears ABOVE the form: every field moves down 100px
  // and every element after it is renumbered — [1] is now the e-mail field, and the password is [2].
  const BANNER = node({ class: 'android.widget.TextView', text: 'Check your e-mail address', bounds: '[40,200][1040,280]' });
  const SHIFTED = LOGIN
    .replace('<hierarchy>', `<hierarchy>${BANNER}`)
    .replace('[40,400][1040,520]', '[40,500][1040,620]')
    .replace('[40,560][1040,680]', '[40,660][1040,780]');
  const device = phone(LOGIN);
  const typeText = device.typeText.bind(device);
  device.typeText = async (t) => { await typeText(t); device.screen = SHIFTED; };
  const model = scripted([[
    { tool: 'type_text', input: { index: 0, text: 'asha@example.test', submit: false } },
    { tool: 'type_text', input: { index: 1, text: 'hunter2', submit: false } },
  ], [{ tool: 'finish', input: { passed: false, summary: 'x', evidence: 'x', expect: '' } }]]);
  await run('Fill the form', device, model, sink());
  assert.deepEqual(device.taps, [[540, 460], [540, 720]], 'the password field was tapped where it had moved to');
});

test('a permission prompt is answered by rule: never shown to the model, recorded, not billed', async () => {
  const device = phone(PERMISSION, [{ box: [40, 1100, 1040, 1200], to: LOGIN }, { box: [390, 1160, 690, 1260], to: HOME }]);
  const model = scripted([loginTurn]);
  const s = sink();
  const out = await run('Log in as asha', device, model, s);
  assert.equal(out.status, 'passed');
  assert.equal(model.calls.length, 1, 'the prompt cost no call');
  assert.equal(s.steps[0]!.model, 'rule');
  assert.equal(s.steps[0]!.billed, false);
  assert.equal(s.steps[0]!.action?.target?.text, 'Allow');
  const shown = (model.calls[0]!.messages[0]!.content as Array<{ type: string; text?: string }>)
    .map((b) => b.text ?? '').join('\n');
  assert.doesNotMatch(shown, /notifications\?/, 'the model saw the login screen, not the prompt');
  assert.match(shown, /Allowed the permission the app asked for \(answered by MFARM, not you\)/);
});

test('a task ABOUT permissions gets the prompt — the rule stands aside', async () => {
  assert.equal(interruptionOn(parse(PERMISSION), 'android', "Deny notifications and check the app still opens"), null);
  assert.equal(interruptionOn(parse(PERMISSION), 'ios', 'Log in'), null, 'iOS alerts are not matched by Android ids');
  assert.equal(interruptionOn(parse(PERMISSION), 'android', 'Log in')?.rule, 'permission');
});

test('Pro: a verdict the screen confirms counts at once — no second call to confirm it', async () => {
  const model = scripted([[], loginTurn]); // the first answer is the plan (no tools)
  const s = sink();
  const out = await run('Log in as asha', phone(LOGIN, [{ box: [390, 1160, 690, 1260], to: HOME }]), model, s, 'pro');
  assert.equal(out.status, 'passed');
  assert.equal(model.calls.length, 2, 'plan + one acting call; the confirm call is gone');
  assert.deepEqual(s.steps.map((x) => x.phase), ['plan', 'act', 'act', 'act', 'act']);
});

test('Pro: a verdict with nothing to check is still confirmed on a fresh screen', async () => {
  const bare: Tool = { tool: 'finish', input: { passed: true, summary: 'ok', evidence: 'ok', expect: '' } };
  const model = scripted([[], [bare], [bare]]);
  const out = await run('Look at the screen', phone(HOME), model, sink(), 'pro');
  assert.equal(out.status, 'passed');
  assert.equal(model.calls.length, 3);
});

test('the screen is read until it stops changing before the model is shown it', async () => {
  const device = phone(LOGIN);
  let n = 0;
  // The first three reads show a spinner; the model must be shown the login form.
  const SPINNER = xml(node({ class: 'android.widget.TextView', text: 'Loading…', bounds: '[0,0][100,100]' }));
  device.source = async () => { device.sources++; return ++n <= 3 ? SPINNER.replace('Loading…', `Loading ${n}`) : LOGIN; };
  const model = scripted([[{ tool: 'finish', input: { passed: true, summary: 'ok', evidence: 'ok', expect: 'Log in' } }]]);
  await runAgent({ task: 'Open', profile: 'flash', device, sink: sink(), model, modelId: 'm', timing: { ...FAST, maxMs: 500 } });
  const shown = (model.calls[0]!.messages[0]!.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? '').join('');
  assert.match(shown, /"Log in"/);
  assert.doesNotMatch(shown, /Loading/);
});

test('typing into a field that is slow to take focus waits once more — it never taps twice', async () => {
  const device = phone(LOGIN);
  let first = true;
  const typeText = device.typeText.bind(device);
  device.typeText = async (t) => {
    if (first) { first = false; throw new Error('no field has focus — tap the field first'); }
    return typeText(t);
  };
  const model = scripted([
    [{ tool: 'type_text', input: { index: 0, text: 'asha@example.test', submit: false } }],
    [{ tool: 'finish', input: { passed: true, summary: 'ok', evidence: 'ok', expect: 'Log in' } }],
  ]);
  const s = sink();
  await run('Type the email', device, model, s);
  assert.equal(s.steps[0]!.result, 'ok');
  assert.equal(device.taps.length, 1);
  assert.deepEqual(device.typed, ['asha@example.test']);
});

test('sameElement: a shared id is not an answer; the text decides, then the place', () => {
  const rows = [
    el({ index: 0, id: 'android:id/title', text: 'Network', y: 100 }),
    el({ index: 1, id: 'android:id/title', text: 'Display', y: 200 }),
  ];
  assert.equal(sameElement(rows[1]!, [...rows].reverse())?.text, 'Display');
  const icon = el({ index: 0, x: 500, y: 500 });
  assert.equal(sameElement(icon, [el({ index: 3, x: 510, y: 505 })])?.index, 3, 'nothing named: matched nearby');
  assert.equal(sameElement(icon, [el({ index: 3, x: 900, y: 1500 })]), undefined, 'and only nearby');
});

test('shows: case and spacing aside, in text, label or id', () => {
  const els = [el({ text: 'Welcome  back, Asha' }), el({ label: 'Cart, 3 items' })];
  assert.ok(shows(els, 'welcome back'));
  assert.ok(shows(els, 'cart, 3'));
  assert.ok(!shows(els, 'Goodbye'));
  assert.ok(!shows(els, '   '), 'an empty expect proves nothing');
});

// ---------------------------------------------------------------- helpers

function el(over: Partial<UiElement>): UiElement {
  return {
    index: 0, kind: 'TextView', text: null, label: null, id: null, x: 0, y: 0, width: 100, height: 40,
    clickable: true, focused: false, ...over,
  };
}

import { parseUiTree } from '@mfarm/protocol';
function parse(x: string): UiElement[] {
  return parseUiTree(x);
}
