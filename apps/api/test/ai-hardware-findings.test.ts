import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiElement } from '@mfarm/protocol';
import { actionTarget } from '../src/ai/agent.ts';
import { exportScript, type ExportRun, type ExportStep } from '../src/ai/export.ts';
import { aiInputBudget, approxTokens, fitToBudget } from '../src/ai/diagnose.ts';
import { pickRegion } from '../src/ai/queue.ts';

/**
 * What the first real AI runs on the farm found (2026-09-26, Groq qwen3.8-27b on Cuttlefish) —
 * each one pinned here without a device, a model or a database.
 */

const el = (over: Partial<UiElement>): UiElement => ({
  kind: 'TextView', text: null, label: null, id: null, x: 0, y: 0, width: 100, height: 40,
  clickable: true, focused: false, ...over,
} as UiElement);

// Android Settings, as the device showed it: every row's title shares one resource id.
const settings = [
  el({ id: 'android:id/title', text: 'Network & internet', y: 100 }),
  el({ id: 'android:id/title', text: 'Display', y: 200 }),
  el({ id: 'android:id/title', text: 'About phone', y: 300 }),
  el({ id: 'com.android.settings:id/search_action_bar', label: 'Search settings', y: 20 }),
];

const run: ExportRun = {
  id: 'a11ae84c-d3d5-497f-8b85-e6019e4219b5', prompt: 'Open Display', platform: 'android', region: 'lab',
  appRef: null, status: 'passed', summary: 'ok', evidence: 'ok',
};
const tapStep = (target: ReturnType<typeof actionTarget>): ExportStep =>
  ({ n: 1, phase: 'act', action: { tool: 'tap_element', input: { index: 1, why: 'open Display' }, target }, result: 'ok' });

test('a tapped element records which of its locators name it alone on that screen', () => {
  const t = actionTarget('tap_element', { index: 1 }, settings)!;
  assert.deepEqual(t.unique, { id: false, label: false, text: true });
  const search = actionTarget('tap_element', { index: 3 }, settings)!;
  assert.deepEqual(search.unique, { id: true, label: true, text: false });
});

test('the export never uses a shared id — the Settings "Display" row is found by its text', () => {
  const script = exportScript('webdriverio', run, [tapStep(actionTarget('tap_element', { index: 1 }, settings))], 'https://farm.mfarm.dev');
  assert.doesNotMatch(script, /id=android:id\/title/, 'that id taps whichever row comes first');
  assert.match(script, /UiSelector\(\)\.text\(\\"Display\\"\)/);
  const py = exportScript('python', run, [tapStep(actionTarget('tap_element', { index: 1 }, settings))], 'https://farm.mfarm.dev');
  assert.doesNotMatch(py, /android:id\/title/);
});

test('with nothing unique the export falls back to a FRAGILE point, and old steps keep id-first', () => {
  const twins = [el({ id: 'x:id/row', text: 'Same' }), el({ id: 'x:id/row', text: 'Same', y: 50 })];
  const fragile = exportScript('webdriverio', run, [tapStep(actionTarget('tap_element', { index: 1 }, twins))], 'https://farm.mfarm.dev');
  assert.match(fragile, /FRAGILE/);
  assert.doesNotMatch(fragile, /x:id\/row/);

  // Recorded before `unique` existed: nothing to check against, so the old order stands.
  const legacy = { kind: 'TextView', text: 'Display', label: null, id: 'android:id/title', x: 0, y: 200, width: 100, height: 40 };
  assert.match(exportScript('webdriverio', run, [tapStep(legacy)], 'https://farm.mfarm.dev'), /id=android:id\/title/);
});

test('diagnosis sheds the oldest log lines first, then the oldest commands, and the screenshot last', () => {
  const logLines = Array.from({ length: 250 }, (_, i) => `I/Noise: a fairly ordinary log line number ${i}`).concat(['E/AndroidRuntime: FATAL']);
  const commands = Array.from({ length: 40 }, (_, i) => `POST /session/s/element/${i}/click → 200`);
  const render = (k: { commands: string[]; logLines: string[]; image: boolean }) => `${k.commands.join('\n')}\n${k.logLines.join('\n')}`;
  const all = { commands, logLines, image: true };

  assert.equal(fitToBudget(null, all, render), all, 'no budget, nothing dropped');

  const fits = fitToBudget(6_000, all, render);
  assert.equal(fits.commands.length, 40, 'commands untouched while log lines can still go');
  assert.equal(fits.image, true);
  assert.ok(fits.logLines.length < logLines.length);
  assert.equal(fits.logLines.at(-1), 'E/AndroidRuntime: FATAL', 'the newest line survives');
  assert.ok(approxTokens(render(fits)) + 2_048 + 300 <= 6_000);

  const tight = fitToBudget(2_600, all, render);
  assert.equal(tight.logLines.length, 0);
  assert.ok(tight.commands.length < 40 && tight.commands.at(-1) === commands.at(-1), 'then the oldest commands');
  assert.equal(tight.image, true, 'the screenshot is the last thing to go');

  assert.equal(fitToBudget(500, all, render).image, false);
});

test('MFARM_AI_MAX_INPUT_TOKENS: a positive integer, else no budget', () => {
  assert.equal(aiInputBudget({}), null);
  assert.equal(aiInputBudget({ MFARM_AI_MAX_INPUT_TOKENS: '6000' }), 6000);
  assert.equal(aiInputBudget({ MFARM_AI_MAX_INPUT_TOKENS: ' 6000 ' }), 6000);
  assert.equal(aiInputBudget({ MFARM_AI_MAX_INPUT_TOKENS: '0' }), null);
  assert.equal(aiInputBudget({ MFARM_AI_MAX_INPUT_TOKENS: 'lots' }), null);
});

test('a run with no region takes the farm default, else the only region — never "required" at allocation', () => {
  assert.equal(pickRegion('android', 'eu', 'lab', ['lab', 'eu']), 'eu', 'what was asked wins');
  assert.equal(pickRegion('android', null, 'lab', []), 'lab', 'then MFARM_DEFAULT_REGION');
  assert.equal(pickRegion('android', undefined, null, ['lab']), 'lab', 'then the one region there is');
  assert.throws(() => pickRegion('android', null, null, ['eu', 'lab']),
    (e: { statusCode: number; code: string; message: string }) =>
      e.statusCode === 400 && e.code === 'region_required' && /eu, lab/.test(e.message));
  assert.throws(() => pickRegion('ios', null, null, []),
    (e: { code: string; message: string }) => e.code === 'no_region' && /no iOS devices/.test(e.message));
});
