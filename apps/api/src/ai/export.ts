import type { ActionTarget } from './agent.ts';

/**
 * AN AI RUN, AS A SCRIPT (ADR-0043, capability C9).
 *
 * The path from an AI run to a CI gate. An AI run is non-deterministic and billed per step; a
 * WebDriver script on the hub is deterministic and costs device time only. So a run that PASSED is
 * a recording of one route through the app that works — and writing it down as code is how a team
 * keeps that route checked on every build without paying a model to rediscover it.
 *
 * LOCATORS, BEST FIRST: resource id / accessibility name, then accessibility label, then visible
 * text, and coordinates only as a last resort — each coordinate fallback is marked in the script,
 * because a script that taps (540, 1210) passes on this panel and fails on the next one.
 *
 * WHAT IT DOES NOT PRETEND. The agent's verdict was a judgement about a screen, not an assertion,
 * so the script ends with the agent's own evidence as a comment and a placeholder assertion to fill
 * in. A generated `expect(true)` would be a green test that checks nothing.
 */

export type ScriptLang = 'webdriverio' | 'python';

export interface ExportStep {
  n: number;
  phase: string;
  action: { tool: string; input: Record<string, unknown>; target?: ActionTarget | null } | null;
  result: string | null;
}

export interface ExportRun {
  id: string;
  prompt: string;
  platform: 'android' | 'ios';
  region: string | null;
  appRef: string | null;
  status: string;
  summary: string | null;
  evidence: string | null;
}

type Locator =
  | { by: 'id'; value: string }
  | { by: 'accessibility'; value: string }
  | { by: 'text'; value: string }
  | { by: 'point'; x: number; y: number };

const ANDROID_KEYCODES: Record<string, number> = { back: 4, home: 3, enter: 66, app_switch: 187 };

function locatorFor(t: ActionTarget | null | undefined, platform: 'android' | 'ios'): Locator | null {
  if (!t) return null;
  // Only a value that named this element alone on its screen. Steps recorded before `unique`
  // existed keep the old best-first order: there is no screen left to check them against.
  const usable = (k: 'id' | 'label' | 'text') => Boolean(t[k]) && (t.unique ? t.unique[k] : true);
  // iOS `name` IS the accessibility identifier, so on iOS the id and the label strategies collapse.
  if (usable('id')) return platform === 'ios' ? { by: 'accessibility', value: t.id! } : { by: 'id', value: t.id! };
  if (usable('label')) return { by: 'accessibility', value: t.label! };
  if (usable('text')) return { by: 'text', value: t.text! };
  return { by: 'point', x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
}

const js = (v: string) => JSON.stringify(v);
const py = (v: string) => JSON.stringify(v); // JSON string literals are valid Python string literals

function wdioSelector(l: Exclude<Locator, { by: 'point' }>, platform: 'android' | 'ios'): string {
  if (l.by === 'accessibility') return js(`~${l.value}`);
  if (l.by === 'id') return js(`id=${l.value}`);
  // Visible text.
  return platform === 'ios'
    ? js(`-ios predicate string:label == ${JSON.stringify(l.value)} OR value == ${JSON.stringify(l.value)}`)
    : js(`android=new UiSelector().text(${JSON.stringify(l.value)})`);
}

function pyLocator(l: Exclude<Locator, { by: 'point' }>, platform: 'android' | 'ios'): string {
  if (l.by === 'accessibility') return `AppiumBy.ACCESSIBILITY_ID, ${py(l.value)}`;
  if (l.by === 'id') return `AppiumBy.ID, ${py(l.value)}`;
  return platform === 'ios'
    ? `AppiumBy.IOS_PREDICATE, ${py(`label == ${JSON.stringify(l.value)} OR value == ${JSON.stringify(l.value)}`)}`
    : `AppiumBy.ANDROID_UIAUTOMATOR, ${py(`new UiSelector().text(${JSON.stringify(l.value)})`)}`;
}

function comment(lang: ScriptLang, text: string): string {
  const mark = lang === 'python' ? '#' : '//';
  return text.split('\n').map((l) => `${mark} ${l}`.trimEnd()).join('\n');
}

/** The body lines for one step, or null for steps a script has nothing to do for. */
function stepLines(lang: ScriptLang, s: ExportStep, platform: 'android' | 'ios'): string[] | null {
  const a = s.action;
  if (!a || a.tool === 'finish') return null;
  const i = a.input;
  const why = typeof i.why === 'string' && i.why ? ` — ${i.why}` : '';
  const head = comment(lang, `Step ${s.n}: ${a.tool}${why}`);
  const loc = locatorFor(a.target, platform);
  const W = lang === 'python';

  switch (a.tool) {
    case 'tap_element':
    case 'tap_point': {
      const l: Locator | null = a.tool === 'tap_point'
        ? { by: 'point', x: Number(i.x), y: Number(i.y) }
        : loc;
      if (!l) return [head, comment(lang, 'The element this tapped was not recorded; re-run to capture it.')];
      if (l.by === 'point') {
        return [head, comment(lang, `FRAGILE: no id, label or text names only this element — a tap at a fixed point.`),
          W ? `driver.tap([(${l.x}, ${l.y})])`
            : `await driver.action('pointer').move({ x: ${l.x}, y: ${l.y} }).down().up().perform();`];
      }
      return [head, W
        ? `driver.find_element(${pyLocator(l, platform)}).click()`
        : `await $(${wdioSelector(l, platform)}).click();`];
    }
    case 'type_text': {
      const text = String(i.text ?? '');
      const lines = [head];
      if (loc && loc.by !== 'point') {
        lines.push(W
          ? `driver.find_element(${pyLocator(loc, platform)}).send_keys(${py(text)})`
          : `await $(${wdioSelector(loc, platform)}).setValue(${js(text)});`);
      } else {
        lines.push(W
          ? `driver.switch_to.active_element.send_keys(${py(text)})`
          : `await driver.keys(${js(text)}.split(''));`);
      }
      if (i.submit === true) lines.push(...(stepLines(lang, { ...s, action: { tool: 'press_key', input: { key: 'enter' } } }, platform) ?? []).slice(1));
      return lines;
    }
    case 'scroll':
      return [head, W ? `swipe(driver, ${py(String(i.direction))})` : `await swipe(${js(String(i.direction))});`];
    case 'press_key': {
      const key = String(i.key);
      if (platform === 'ios') {
        return [head, W ? `driver.execute_script("mobile: pressButton", {"name": "home"})`
          : `await driver.execute('mobile: pressButton', { name: 'home' });`];
      }
      const code = ANDROID_KEYCODES[key] ?? 66;
      return [head, W ? `driver.press_keycode(${code})` : `await driver.pressKeyCode(${code});`];
    }
    case 'launch_app': {
      const id = String(i.app_id ?? '');
      const arg = platform === 'ios' ? 'bundleId' : 'appId';
      return [head, W ? `driver.execute_script("mobile: activateApp", {${py(arg)}: ${py(id)}})`
        : `await driver.execute('mobile: activateApp', { ${arg}: ${js(id)} });`];
    }
    case 'wait': {
      const ms = Math.min(Math.max(Number(i.seconds) || 1, 1), 10) * 1000;
      return [head, W ? `time.sleep(${ms / 1000})` : `await driver.pause(${ms});`];
    }
    default:
      return [head, comment(lang, `(${a.tool} has no script equivalent)`)];
  }
}

export function exportScript(lang: ScriptLang, run: ExportRun, steps: ExportStep[], hubOrigin: string): string {
  // Only the actions that happened — a step whose action failed is not part of the route that worked.
  const done = steps.filter((s) => s.action && s.result === 'ok');
  const body = done.map((s) => stepLines(lang, s, run.platform)).filter((x): x is string[] => x !== null);
  const fragile = done.filter((s) => {
    const l = s.action?.tool === 'tap_point' ? { by: 'point' } : locatorFor(s.action?.target, run.platform);
    return (s.action?.tool === 'tap_element' || s.action?.tool === 'tap_point') && (!l || l.by === 'point');
  }).length;
  const verdictNote = [
    `Generated by MFARM AI from run ${run.id} (${run.status}).`,
    `Task: ${run.prompt.replace(/\s+/g, ' ').trim()}`,
    ...(run.status !== 'passed' ? ['WARNING: this run did not pass, so this is the route it tried, not one known to work.'] : []),
    ...(fragile ? [`${fragile} tap(s) had no stable locator and use fixed coordinates — search for FRAGILE.`] : []),
  ];
  const hub = `${hubOrigin.replace(/\/+$/, '')}/wd/hub`;
  const platformName = run.platform === 'ios' ? 'iOS' : 'Android';
  const automation = run.platform === 'ios' ? 'XCUITest' : 'UiAutomator2';

  if (lang === 'python') {
    const caps = [
      `    "platformName": ${py(platformName)},`,
      `    "appium:automationName": ${py(automation)},`,
      run.region ? `    "mfarm:region": ${py(run.region)},` : null,
      run.appRef ? `    "mfarm:appId": ${py(run.appRef)},` : null,
      `    "mfarm:name": ${py(run.prompt.replace(/\s+/g, ' ').trim().slice(0, 120))},`,
    ].filter(Boolean).join('\n');
    return [
      comment('python', verdictNote.join('\n')),
      '#',
      '# pip install Appium-Python-Client pytest   ·   MFARM_API_KEY=mfk_… pytest this_file.py',
      'import base64',
      'import os',
      'import time',
      '',
      'import pytest',
      'from appium import webdriver',
      'from appium.options.common import AppiumOptions',
      'from appium.webdriver.appium_connection import AppiumConnection',
      'from appium.webdriver.common.appiumby import AppiumBy',
      '',
      `HUB = ${py(hub)}`,
      'KEY = os.environ["MFARM_API_KEY"]',
      '',
      '',
      'class _AuthConnection(AppiumConnection):',
      '    # The key as an Authorization header: several HTTP stacks drop https://key@host userinfo.',
      '    def get_remote_connection_headers(self, parsed_url, keep_alive=True):',
      '        headers = super().get_remote_connection_headers(parsed_url, keep_alive)',
      '        headers["Authorization"] = "Basic " + base64.b64encode(f"{KEY}:".encode()).decode()',
      '        return headers',
      '',
      '',
      'def swipe(driver, direction):',
      '    size = driver.get_window_size()',
      '    cx, cy = size["width"] // 2, size["height"] // 2',
      '    dx, dy = int(size["width"] * 0.3), int(size["height"] * 0.3)',
      '    # Content moves opposite to the finger: to reveal what is below, swipe up.',
      '    start, end = {"down": ((cx, cy + dy), (cx, cy - dy)), "up": ((cx, cy - dy), (cx, cy + dy)),',
      '                  "right": ((cx + dx, cy), (cx - dx, cy)), "left": ((cx - dx, cy), (cx + dx, cy))}[direction]',
      '    driver.swipe(start[0], start[1], end[0], end[1], 300)',
      '',
      '',
      '@pytest.fixture',
      'def driver():',
      '    options = AppiumOptions()',
      '    options.load_capabilities({',
      caps,
      '    })',
      '    d = webdriver.Remote(command_executor=_AuthConnection(HUB), options=options)',
      '    yield d',
      '    d.quit()',
      '',
      '',
      `def test_${run.id.replace(/-/g, '').slice(0, 8)}(driver):`,
      ...body.flat().map((l) => `    ${l}`),
      '',
      ...(run.evidence ? [comment('python', `The agent concluded: ${run.summary ?? ''}\nOn screen: ${run.evidence}`).split('\n').map((l) => `    ${l}`).join('\n')] : []),
      '    # TODO: assert what proves the task worked, e.g.',
      '    # assert driver.find_element(AppiumBy.ACCESSIBILITY_ID, "Order placed").is_displayed()',
      '',
    ].join('\n');
  }

  const caps = [
    `      platformName: ${js(platformName)},`,
    `      'appium:automationName': ${js(automation)},`,
    run.region ? `      'mfarm:region': ${js(run.region)},` : null,
    run.appRef ? `      'mfarm:appId': ${js(run.appRef)},` : null,
    `      'mfarm:name': ${js(run.prompt.replace(/\s+/g, ' ').trim().slice(0, 120))},`,
  ].filter(Boolean).join('\n');
  return [
    comment('webdriverio', verdictNote.join('\n')),
    '//',
    '// npm i -D webdriverio   ·   MFARM_API_KEY=mfk_… npx tsx this_file.ts',
    "import { remote } from 'webdriverio';",
    '',
    `const hub = new URL(${js(hub)});`,
    '',
    'async function main() {',
    '  const driver = await remote({',
    "    protocol: hub.protocol.replace(':', '') as 'https' | 'http',",
    '    hostname: hub.hostname,',
    '    port: Number(hub.port) || (hub.protocol === \'https:\' ? 443 : 80),',
    "    path: '/wd/hub',",
    '    // Not `user`/`key`: WebdriverIO drops those for a non-cloud host — see examples/medishop-suite.',
    "    headers: { authorization: `Basic ${Buffer.from(`${process.env.MFARM_API_KEY}:`).toString('base64')}` },",
    '    capabilities: {',
    caps,
    '    },',
    '  });',
    '  const $ = driver.$.bind(driver);',
    '  const swipe = async (direction: string) => {',
    '    const { width, height } = await driver.getWindowSize();',
    '    const [cx, cy, dx, dy] = [width / 2, height / 2, width * 0.3, height * 0.3].map(Math.round);',
    '    // Content moves opposite to the finger: to reveal what is below, swipe up.',
    '    const [[x1, y1], [x2, y2]] = ({ down: [[cx, cy + dy], [cx, cy - dy]], up: [[cx, cy - dy], [cx, cy + dy]],',
    '      right: [[cx + dx, cy], [cx - dx, cy]], left: [[cx - dx, cy], [cx + dx, cy]] } as Record<string, number[][]>)[direction]!;',
    "    await driver.action('pointer').move({ x: x1, y: y1 }).down().move({ x: x2, y: y2, duration: 300 }).up().perform();",
    '  };',
    '  void swipe;',
    '  try {',
    ...body.flat().map((l) => `    ${l}`),
    '',
    ...(run.evidence ? comment('webdriverio', `The agent concluded: ${run.summary ?? ''}\nOn screen: ${run.evidence}`).split('\n').map((l) => `    ${l}`) : []),
    '    // TODO: assert what proves the task worked, e.g.',
    "    // await expect($('~Order placed')).toBeDisplayed();",
    '  } finally {',
    '    await driver.deleteSession();',
    '  }',
    '}',
    '',
    'main().catch((err) => { console.error(err); process.exitCode = 1; });',
    '',
  ].join('\n');
}
