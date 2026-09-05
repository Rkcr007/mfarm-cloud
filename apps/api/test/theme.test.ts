/**
 * THE LIGHT THEME, AND THE BOUNDARY IT KEEPS CROSSING.
 *
 * Document 01's whole idea in one sentence: *"The console is a neutral desk. The device is the warm
 * object sitting on it."* The desk changes when the lights come on. The phone does not — a
 * powered-off panel is near-black in a bright room and in a dark one.
 *
 * That boundary is invisible in the source. `background: var(--s-inset)` is correct on a card and
 * WRONG on the device's screen, and the two lines look identical. It broke exactly that way while
 * stage 8 was being written: `.dev-overlay` sits inside `.mf-glass`, took the chrome token, and the
 * phone's screen turned white in light theme. A screenshot found it; nothing else could have.
 *
 * SOURCE-LEVEL ASSERTIONS, because there is no DOM here and no CSSOM. That is a real limit — these
 * cannot tell whether a colour is legible, only whether it is allowed to change. Contrast is a
 * human's job and a screenshot's; this file guards the rule that makes the screenshots comparable.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

let css = '';
let tokens = '';
before(async () => {
  css = await readFile(join(PUBLIC, 'console.css'), 'utf8');
  tokens = await readFile(join(PUBLIC, 'design-tokens.css'), 'utf8');
});

/**
 * Every token name defined inside a given selector block.
 *
 * Anchored to the START OF A LINE, because both of these selectors also appear inside the prose
 * above them — `indexOf` found the one in the comment, sliced a block that defined nothing, and
 * reported all forty-eight colour tokens as missing from the light theme. A guard that fails
 * loudly against correct code is worse than no guard.
 */
function tokensIn(src: string, selector: string): Set<string> {
  const at = src.indexOf(`\n${selector}`);
  assert.ok(at >= 0, `${selector} does not start a line in design-tokens.css`);
  const open = src.indexOf('{', at);
  const close = src.indexOf('\n}', open);
  return new Set([...src.slice(open, close).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

describe('the light theme re-derives every token the dark one defines', () => {
  /**
   * A TOKEN DEFINED IN ONE THEME AND NOT THE OTHER is the failure mode with no symptom: the light
   * page silently keeps the dark value, which is usually near-black text on a near-white card, and
   * it only shows up on the one screen nobody opened.
   */
  test('no token is dark-only', () => {
    const dark = tokensIn(tokens, ':root {');
    const light = tokensIn(tokens, "[data-theme='light']");

    // Shape, type, motion and density are theme-independent by design — only colour re-derives.
    // Only the colour families. `--r-*` (radius), `--m-*` (motion) and `--f-*` (frame geometry)
    // are theme-independent by design and must NOT be duplicated into the light block.
    const colourish = /^--(s|b|t|ok|warn|bad|log|on-accent|accent|hover)-|^--(info|warn|mf-accent)$/;
    const missing = [...dark].filter((t) => colourish.test(t) && !light.has(t));

    assert.deepEqual(missing, [],
      'these carry their DARK value into the light theme — usually invisible, always wrong');
  });

  /**
   * By counting every definition rather than by carving out two blocks: a non-greedy match on
   * `[data-theme='light'] { ... }` stops at the first `\n}` it finds, which in a file with
   * commented braces is not the end of the block. The claim is simply "every definition of this
   * token is the same colour", and that is what gets asserted.
   */
  test('the destructive confirm is the one colour that does not soften', () => {
    const all = [...tokens.matchAll(/--bad-solid:\s*(#[0-9A-Fa-f]{6})/g)].map((m) => m[1].toUpperCase());
    assert.equal(all.length, 2, 'expected one definition per theme');
    assert.equal(new Set(all).size, 1,
      'quarantine and release exist to be used correctly, not gently — see document 05 §03');
  });
});

/**
 * THE DESK / DEVICE BOUNDARY.
 *
 * Everything from the frame section down describes a physical object. If any of it reads a chrome
 * token, that part of the phone follows the room — which is how the screen turned white.
 */
describe('the device does not follow the room', () => {
  /**
   * Every rule whose SELECTOR is in the frame's own namespace, found by parsing rather than by
   * slicing at a line number. The first version of this sliced from `.mf-glass` to the end of the
   * file and swept up every chrome rule that happened to sit below it — reporting eighteen
   * violations that were all correct code. A guard that cries wolf gets deleted.
   */
  function frameRules(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().split('\n').pop()!.trim();
      if (/(^|[\s,>])\.mf-/.test(` ${sel}`)) out.push([sel, m[2]]);
    }
    assert.ok(out.length > 10, 'the frame section has moved — this guard is measuring nothing');
    return out;
  }

  test('no rule inside the device frame reads a surface, border or text token', () => {
    const offenders = frameRules()
      .filter(([, body]) => /var\(\s*--(s|b|t)-/.test(body))
      .map(([sel]) => sel);
    assert.deepEqual(offenders, [],
      'a phone is the same object in both themes; these would repaint it when the lights came on');
  });

  /**
   * And the overlay specifically, because it is the one that broke: it is a SIBLING of the video
   * inside the glass, so it is the device's screen showing a message rather than a panel on the
   * page. Its selector does not contain `mf-` and so it sits outside the section check above.
   */
  test('the panel overlay is painted with literals, not chrome tokens', () => {
    const at = css.indexOf('.dev-overlay {');
    assert.ok(at > 0, '.dev-overlay is gone — has the panel been restructured?');
    const block = css.slice(at, css.indexOf('\n}', at));
    assert.doesNotMatch(block, /var\(\s*--(s|b|t)-/,
      'this element covers the device screen; a chrome token turns the phone white in light theme');
    assert.match(block, /background:\s*#0[0-9A-F]{5}/i,
      'a powered-off panel is near-black in a bright room and in a dark one');
  });
});

/**
 * WHAT THE CONSOLE STILL PAINTS BY HAND.
 *
 * Not a ban — the frame section is deliberately full of literals. This is a CEILING on the chrome,
 * so that the next person to add a hardcoded hex to a card or a button has to notice they are doing
 * it. The number only goes down.
 */
describe('the chrome goes through tokens', () => {
  test('the console paints no colour of its own outside the device frame', () => {
    // Everything OUTSIDE the frame's namespace, by the same parse the boundary test uses.
    const chrome = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => !/(^|[\s,>])\.mf-/.test(` ${m[1].trim().split('\n').pop()!.trim()}`))
      .map((m) => m[2])
      .join('\n');
    const withoutFallbacks = chrome.replace(/var\(\s*--[A-Za-z0-9-]+\s*,[^)]*\)/g, 'VAR');
    const bare = withoutFallbacks
      .split('\n')
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*'))
      .flatMap(([n, l]) => [...l.matchAll(/#[0-9A-Fa-f]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => `${n}: ${m[0]}`));

    /**
     * The survivors, each with a reason:
     *   - `.btn.primary kbd` and the two `color: #fff`-equivalents sit ON a filled accent, which is
     *     dark purple in BOTH themes, so white is correct in both.
     *   - the tap ripple and the inspector outline are drawn over the device's framebuffer.
     *   - `.dev-video` and the chrome-off chassis are the device.
     */
    assert.ok(bare.length <= 16,
      `${bare.length} hardcoded colours in the console chrome (ceiling 16):\n  ${bare.join('\n  ')}`);
  });
});

/**
 * THE SIX BEATS ACTUALLY CHANGE SOMETHING.
 *
 * The failure this guards against has no symptom in any other test: three of the six beats had a
 * `transition` declared for a property and no rule that ever changed it, so they read as correct
 * code and moved nothing. Beat 02's wake glow, beat 04's cross-fade and beat 06's settle were all
 * inert for a week.
 *
 * A transition is a promise about how a value will change. If nothing changes the value, the
 * promise is about nothing — and only a rendered frame mid-transition can tell you, which is why
 * this file asserts the SHAPE and a screenshot pass asserts the motion.
 */
describe('the bring-up choreography moves', () => {
  /**
   * Declarations that set a property, ignoring `transition` and `animation` themselves.
   *
   * THE WHOLE SELECTOR GROUP, not its last line. `.devpanel[data-beat="0"] .mf-chassis,` and its
   * two siblings share one block, and taking `.split('\n').pop()` saw only the third — so beats 0
   * and 1 looked like they set nothing while the rule that holds them flat was right there. Third
   * parser in this file to make the same mistake; the lesson is that a CSS selector is not a line.
   */
  function settersFor(beat: string): string[] {
    const out: string[] = [];
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1];
      if (!sel.includes(`data-beat="${beat}"`)) continue;
      for (const decl of m[2].split(';')) {
        const prop = decl.split(':')[0]?.trim();
        if (prop && !/^(transition|animation)/.test(prop)) out.push(prop);
      }
    }
    return [...new Set(out)];
  }

  for (const [beat, what] of [
    ['0', 'the unresolved frame — blur, opacity, scale'],
    ['2', 'the wake glow ramping up behind the glass'],
    ['4', 'the pixels crossing over the glow, and the sheen with them'],
    ['6', 'the composition settling'],
  ] as const) {
    test(`beat ${beat} changes a property: ${what}`, () => {
      const props = settersFor(beat);
      assert.ok(props.length > 0,
        `beat ${beat} has no rule that changes anything — a transition with nothing to transition `
        + 'is a comment that looks like code');
    });
  }

  /**
   * And the two that must NOT be animated by this file, because they are the device's own
   * behaviour rather than the bring-up's: depth lands on the socket (beat 3) via the chassis rule,
   * and beat 5 is the tile, which lives outside the frame.
   */
  test('depth is held flat before beat 3 and never after', () => {
    for (const early of ['0', '1', '2']) {
      assert.ok(settersFor(early).includes('box-shadow') || settersFor(early).includes('opacity'),
        `beat ${early} should hold the device flat and contactless`);
    }
    /**
     * Depth lands by the flat rule CEASING TO APPLY, not by a rule of its own — so beat 3 must not
     * set `box-shadow`. It does still carry the wake glow, which is correct: the screen is awake
     * from beat 2 and stays lit until real pixels replace it at beat 4. The first version of this
     * asserted beat 3 set nothing at all and failed against exactly that.
     */
    assert.ok(!settersFor('3').includes('box-shadow'),
      'depth lands because the flat rule stops matching, not because a fourth rule fires');
  });
});
