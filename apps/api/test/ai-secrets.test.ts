import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aiRunNames, clipName, MASK, redact, redactDeep, redactForStrangers, secretsIn, stripToolMarkup,
} from '../src/ai/secrets.ts';

/**
 * What an AI run's task may SHOW (2026-09-26): a PIN and a passcode written into a task were printed
 * on the run list, the Runs page and the public share page.
 */

const LOGIN_TASK = 'open the app\nenter email as :  qa.tester1@example.org\npin : 4812\npasscode as : 539176';

test('the values after a secret\'s name are found — on the shape of the task that leaked', () => {
  assert.deepEqual(secretsIn(LOGIN_TASK), ['539176', '4812'], 'longest first');
  assert.equal(redact(LOGIN_TASK, secretsIn(LOGIN_TASK)),
    `open the app\nenter email as :  qa.tester1@example.org\npin : ${MASK}\npasscode as : ${MASK}`,
    'the e-mail is the owner\'s own identifier — kept for them, masked only for strangers');
});

test('the ways people write them', () => {
  assert.deepEqual(secretsIn('log in as demo@acme.test with password demo1234'), ['demo1234']);
  assert.deepEqual(secretsIn('Use OTP is 123456 when asked'), ['123456']);
  assert.deepEqual(secretsIn('password: hunter2.'), ['hunter2'], 'trailing punctuation is not the value');
  assert.deepEqual(secretsIn('api key = sk-abc123, then continue'), ['sk-abc123']);
  assert.deepEqual(secretsIn('PIN code: 4321'), ['4321']);
  assert.deepEqual(secretsIn('password "correct horse battery"'), ['correct horse battery'], 'quoted, spaces and all');
  assert.deepEqual(secretsIn('the passcode is \'sunshine\''), ['sunshine'], 'a quoted word is taken');
});

test('and the ways a sentence only LOOKS like one', () => {
  assert.deepEqual(secretsIn('pin the item to the top of the list'), [], 'no separator: a verb');
  assert.deepEqual(secretsIn('check the password is correct'), [], 'an unquoted plain word is not taken');
  assert.deepEqual(secretsIn('Open Settings and check the Android version'), []);
  assert.deepEqual(secretsIn(''), []);
  assert.deepEqual(secretsIn(null), []);
});

test('a value is masked wherever it appears, and never half of it', () => {
  assert.equal(redact('typed 12345 then 123', ['12345', '123']), `typed ${MASK} then ${MASK}`);
  assert.equal(redact(null, ['x']), null);
  assert.equal(redact('nothing to hide', []), 'nothing to hide');
  assert.deepEqual(
    redactDeep({ tool: 'type_text', input: { text: '4812', why: 'enter 4812' }, target: { text: '4812' } }, ['4812']),
    { tool: 'type_text', input: { text: MASK, why: `enter ${MASK}` }, target: { text: MASK } });
});

test('a stranger sees neither the secrets nor the account\'s e-mail', () => {
  const shown = redactForStrangers(LOGIN_TASK, secretsIn(LOGIN_TASK));
  assert.doesNotMatch(shown, /4812|539176|qa\.tester1|example\.org/);
  assert.match(shown, /pin : ••••/);
});

test('names are cut at a word, with an ellipsis — never mid-word', () => {
  const task = 'Open the Settings app and turn on the setting called "Quantum teleport mode". Pass only if that exact setting exists';
  const name = clipName(task, 80);
  assert.ok(name.length <= 80);
  assert.match(name, /…$/);
  assert.doesNotMatch(name, /\bPa…$/, 'the name the Runs page used to show');
  assert.equal(clipName('Short task', 80), 'Short task');
  assert.equal(clipName('  spaced \n out  ', 80), 'spaced out');
});

test('a run\'s names are masked BEFORE they are cut, so a secret cannot survive by being halved', () => {
  const names = aiRunNames(LOGIN_TASK);
  for (const n of Object.values(names)) {
    assert.doesNotMatch(n, /4812|539176/);
    assert.match(n, /^AI: /);
  }
  assert.ok(names.runName.length <= 200 && names.sessionName.length <= 300 && names.resultName.length <= 500,
    'inside the columns\' own limits (migrations 021, 048)');
});

test('markup meant for a parser is not shown to a person', () => {
  const plan = 'Plan: 1. Open Settings.\n\nAction: open it.\n\n<tool_call>\n<function=launch_app>\n<parameter=package>\ncom.android.settings\n</parameter>\n</function>\n</tool_call>';
  assert.equal(stripToolMarkup(plan), 'Plan: 1. Open Settings.\n\nAction: open it.');
  assert.equal(stripToolMarkup(null), null);
});
