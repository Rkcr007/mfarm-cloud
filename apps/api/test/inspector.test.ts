/**
 * The element inspector's pure half: which node a tap lands on, and what selector identifies it.
 *
 * These two functions are the whole reliability story. Everything else in the inspector is an adb
 * round trip and a box drawn on a video; if the hit test picks the wrong node, or the selector it
 * hands over matches something else, a person writes a test that passes for the wrong reason — and
 * that is worse than an inspector that does not work at all.
 *
 * `parseHierarchy` is deliberately absent: it uses DOMParser and belongs to the browser. What is
 * testable here is everything downstream of it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { nodeAt, selectorsFor, type UiNode, type Selector } from '../public/live.js';

/** Bounds as the parser produces them, with the derived `area` the hit test sorts on. */
const node = (o: Partial<UiNode>): UiNode => {
  const n: UiNode = { i: 0, cls: 'android.widget.View', pkg: 'com.acme', text: '', desc: '', id: '',
    clickable: false, enabled: true, scrollable: false,
    x1: 0, y1: 0, x2: 0, y2: 0, area: 0, ...o };
  return { ...n, area: (n.x2 - n.x1) * (n.y2 - n.y1) };
};

// A realistic nest: the window contains a list, which contains a row, which contains a button.
const ROOT   = node({ i: 0, cls: 'android.widget.FrameLayout', x1: 0, y1: 0, x2: 720, y2: 1280 });
const LIST   = node({ i: 1, cls: 'androidx.recyclerview.widget.RecyclerView', x1: 0, y1: 200, x2: 720, y2: 1100, scrollable: true });
const ROW    = node({ i: 2, cls: 'android.view.ViewGroup', x1: 20, y1: 300, x2: 700, y2: 420 });
const BUTTON = node({ i: 3, cls: 'android.widget.Button', x1: 600, y1: 330, x2: 690, y2: 390, text: 'Add', clickable: true });
const TREE = [ROOT, LIST, ROW, BUTTON];

describe('hit test', () => {
  test('a tap picks the smallest node containing it, not the window', () => {
    // THE WHOLE POINT. Every ancestor also contains the point — the root contains every point on
    // the screen — so without picking by area, tapping a button selects the window every time.
    assert.equal(nodeAt(TREE, 640, 360), BUTTON);
  });

  test('a tap beside the button falls through to the row that holds it', () => {
    assert.equal(nodeAt(TREE, 100, 360), ROW);
  });

  test('a tap outside every child still finds the window', () => {
    assert.equal(nodeAt(TREE, 10, 60), ROOT);
  });

  test('a tap on an edge counts as inside', () => {
    // Bounds are inclusive in a uiautomator dump; an off-by-one here makes the edge of every
    // control unpickable, which reads as "the inspector randomly ignores me".
    assert.equal(nodeAt(TREE, 600, 330), BUTTON);
    assert.equal(nodeAt(TREE, 690, 390), BUTTON);
  });

  test('nothing under the point is null rather than a guess', () => {
    assert.equal(nodeAt([BUTTON], 10, 10), null);
    assert.equal(nodeAt([], 100, 100), null);
  });
});

describe('selectors', () => {
  test('a resource-id wins, and is offered as an id rather than an xpath', () => {
    const n = node({ cls: 'android.widget.Button', id: 'com.acme:id/submit', text: 'Submit', x2: 10, y2: 10 });
    const [first] = selectorsFor(n, [n]);
    assert.equal(first.strategy, 'id');
    assert.equal(first.value, 'com.acme:id/submit');
    assert.equal(first.quality, 'stable');
  });

  test('with no id, the accessibility label is preferred over visible text', () => {
    // Both work today. The description is what a screen reader depends on, so it survives a
    // rewording; the text does not.
    const n = node({ desc: 'Add to cart', text: 'Add', x2: 10, y2: 10 });
    const sels = selectorsFor(n, [n]);
    assert.equal(sels[0].strategy, 'accessibility id');
    assert.equal(sels[0].value, 'Add to cart');
    assert.ok(sels.findIndex((s: Selector) => s.how === 'xpath by text') > 0);
  });

  test('text-based selectors are labelled brittle, not offered as if equal', () => {
    const n = node({ text: 'Add', x2: 10, y2: 10 });
    const byText = selectorsFor(n, [n]).find((s: Selector) => s.how === 'xpath by text');
    assert.ok(byText, 'a node with visible text must offer a text selector');
    assert.equal(byText.quality, 'brittle');
    assert.equal(byText.value, "//*[@text='Add']");
  });

  test("an apostrophe in the text does not produce a broken xpath", () => {
    // XPath 1.0 has no escape for a quote inside a literal, so the only correct answer is concat().
    // Getting this wrong yields a selector that either throws in the client or, worse, parses and
    // matches nothing — a test that fails for a reason nowhere near the real one.
    const n = node({ text: "Rahul's cart", x2: 10, y2: 10 });
    const byText = selectorsFor(n, [n]).find((s: Selector) => s.how === 'xpath by text');
    assert.ok(byText);
    assert.match(byText.value, /concat\(/);
    assert.ok(!/\[@text='Rahul's cart'\]/.test(byText.value), `unescaped quote: ${byText.value}`);
  });

  test('the positional fallback counts from one, among its own class only', () => {
    // XPath indices are 1-based, and `(//X)[0]` matches nothing at all — a silent, total failure.
    const a = node({ cls: 'android.widget.EditText', x2: 10, y2: 10 });
    const b = node({ cls: 'android.widget.EditText', y1: 20, x2: 10, y2: 30 });
    const other = node({ cls: 'android.widget.Button', x2: 10, y2: 10 });
    const sels = selectorsFor(b, [a, other, b]);
    const pos = sels.find((s: Selector) => s.how === 'xpath by position');
    assert.ok(pos, 'every node must at least get a positional fallback');
    assert.equal(pos.value, '(//android.widget.EditText)[2]');
    assert.equal(pos.quality, 'brittle');
  });

  test('a node with nothing identifying yields no selector rather than a useless one', () => {
    // Common in Compose: a bare layout node with no id, no description and no text. Returning
    // `//android.view.View` here would look like an answer and match half the screen.
    const bare = node({ cls: 'android.view.View', x2: 10, y2: 10 });
    // Only the positional fallback, which is honest about what it is.
    const sels = selectorsFor(bare, [bare]);
    assert.equal(sels.length, 1);
    assert.equal(sels[0].how, 'xpath by position');
  });

  test('a Compose node — no id, description only — still gets a stable handle', () => {
    // The case the inspector exists for. Compose emits no resource-ids, so if this produced only
    // brittle options the feature would not solve the problem it was built for.
    const n = node({ cls: 'android.view.View', desc: 'Cart, 4 items', clickable: true, x2: 10, y2: 10 });
    const sels = selectorsFor(n, [n]);
    assert.equal(sels[0].quality, 'stable');
    assert.equal(sels[0].strategy, 'accessibility id');
  });
});
