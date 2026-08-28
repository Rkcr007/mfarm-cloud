/**
 * A DOM small enough to render the console into, and nothing more.
 *
 * WHY NOT jsdom. The console is 3,000 lines of plain browser JavaScript served with no build step,
 * and the thing worth testing about it is narrow: does each screen build a tree, or does it throw?
 * That needs `createElement` and a place to put children — not layout, not CSSOM, not a parser. A
 * full DOM would be a dependency, a version to keep current, and a much larger surface to be
 * surprised by, in exchange for fidelity this test does not use.
 *
 * WHAT IT IS NOT. It does not lay out, measure, match selectors, or fire events. `querySelector`
 * answers null and `getBoundingClientRect` answers zeroes, so anything that depends on geometry is
 * outside what this can check. It is a shim for building trees, and the test says so.
 *
 * `getElementById` MINTS elements on demand rather than being handed a list of ids. The console
 * reaches for around twenty by id at module scope, and a hard-coded list would be a second place to
 * update every time someone adds one — which is exactly the kind of maintenance that makes a test
 * get deleted.
 */

class ShimNode {
  children: ShimNode[] = [];
  parentElement: ShimNode | null = null;
  textContent = '';

  append(...kids: unknown[]): void {
    for (const k of kids.flat(9)) {
      if (k === null || k === undefined || k === false) continue;
      if (k instanceof ShimNode) { k.parentElement = this; this.children.push(k); }
      else this.children.push(new ShimText(String(k)));
    }
  }
  appendChild(k: ShimNode): ShimNode { this.append(k); return k; }
  replaceChildren(...kids: unknown[]): void { this.children = []; this.append(...kids); }
  remove(): void {
    const p = this.parentElement;
    if (p) p.children = p.children.filter((c) => c !== this);
  }
  get firstElementChild(): ShimNode | null {
    return this.children.find((c) => c instanceof ShimElement) ?? null;
  }
  /**
   * Answers with a fresh detached element rather than null.
   *
   * This shim does not match selectors — it has no engine and does not want one. The choice is
   * therefore between answering null and answering something harmless, and null loses: the console
   * chains on these (`$('reach-pill').querySelector('.dot').className = …`), so null turns a lookup
   * this shim cannot perform into a TypeError that reads like a bug in the console.
   *
   * THE COST, stated plainly: "no such element" is not a state this shim can represent, so a test
   * must not assert on one. Everything here checks that a screen BUILDS, which never depends on it.
   */
  querySelector(): ShimElement { return new ShimElement('div'); }
  querySelectorAll(): ShimNode[] { return []; }
  closest(): null { return null; }
  addEventListener(): void {}
  removeEventListener(): void {}
  focus(): void {}
  blur(): void {}
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

class ShimText extends ShimNode {
  constructor(text: string) { super(); this.textContent = text; }
}

class ShimElement extends ShimNode {
  tagName: string;
  id = '';
  className = '';
  hidden = false;
  disabled = false;
  checked = false;
  value = '';
  /**
   * Plain properties AND `setProperty`, because the console writes both: `n.style.width = …` for
   * ordinary declarations, and `setProperty('--dev-aspect', …)` for the custom properties the
   * device frame is sized with — a dashed name is not a valid JS identifier, so there is no other
   * way to set one.
   */
  readonly style: Record<string, unknown> = {
    setProperty(this: Record<string, unknown>, k: string, v: string) { this[k] = v; },
    getPropertyValue(this: Record<string, unknown>, k: string) { return (this[k] as string) ?? ''; },
    removeProperty(this: Record<string, unknown>, k: string) { delete this[k]; },
  };
  readonly dataset: Record<string, string> = {};
  readonly attrs = new Map<string, string>();
  readonly classList = {
    add: (...c: string[]) => { this.className = [...new Set([...this.className.split(' '), ...c])].join(' ').trim(); },
    remove: (...c: string[]) => { this.className = this.className.split(' ').filter((x) => !c.includes(x)).join(' '); },
    contains: (c: string) => this.className.split(' ').includes(c),
    toggle: () => {},
  };

  constructor(tagName: string) { super(); this.tagName = tagName.toUpperCase(); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  get isContentEditable(): boolean { return false; }
}

/**
 * Count every element in a tree.
 *
 * Takes an ARRAY as readily as a node, because that is what a screen returns — `screenDevices()`
 * hands back `[pageHead(...), card(...)]` and the console's `add()` flattens it on the way in.
 * Counting only single nodes reported zero for every screen in the suite, which looked exactly like
 * the bug this file was written to catch.
 */
export function countElements(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((n: number, k) => n + countElements(k), 0);
  if (!(node instanceof ShimNode)) return 0;
  let n = node instanceof ShimElement ? 1 : 0;
  for (const c of node.children) n += countElements(c);
  return n;
}

/**
 * Every class name in a tree.
 *
 * The shim deliberately does not match selectors, so this is how a test asks "was this element
 * drawn". Used for the parts of the device panel that carry no text at all — a punch-hole and a side
 * button are pure geometry, and `textOf` sees nothing of either.
 */
export function classesOf(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(classesOf);
  if (!(node instanceof ShimNode)) return [];
  const own = node instanceof ShimElement && typeof node.className === 'string'
    ? node.className.split(/\s+/).filter(Boolean)
    : [];
  return [...own, ...node.children.flatMap(classesOf)];
}

/** Every bit of text in a tree, joined — enough to assert a screen said the thing it should. */
export function textOf(node: unknown): string {
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (!(node instanceof ShimNode)) return '';
  if (node instanceof ShimText) return node.textContent;
  return [node.textContent, ...node.children.map(textOf)].join(' ');
}

/**
 * Install the shim on `globalThis`.
 *
 * Called before `console.js` is imported, because that module touches `document` while it is being
 * evaluated — it reads `document.documentElement` and binds listeners at the top level.
 */
export function installDom(): void {
  const byId = new Map<string, ShimElement>();
  const make = (tag: string) => new ShimElement(tag);

  const document = {
    documentElement: make('html'),
    body: make('body'),
    createElement: make,
    createElementNS: (_ns: string, tag: string) => make(tag),
    createTextNode: (t: string) => new ShimText(t),
    getElementById: (id: string) => {
      let el = byId.get(id);
      if (!el) { el = make('div'); el.id = id; byId.set(id, el); }
      return el;
    },
    querySelector: () => make('div'),
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    hidden: false,
    activeElement: null as ShimElement | null,
  };

  /**
   * `defineProperty`, not assignment. Node defines some of these itself — `navigator` is a
   * getter-only property on `globalThis` since Node 21 — and a plain assignment throws
   * "Cannot set property navigator of #<Object> which has only a getter", which took out the whole
   * file the first time this ran.
   */
  const g = globalThis as Record<string, unknown>;
  const set = (name: string, value: unknown) =>
    Object.defineProperty(g, name, { value, writable: true, configurable: true });

  const location = { hash: '', host: 'farm.test', origin: 'https://farm.test', href: 'https://farm.test/' };

  set('document', document);
  set('Node', ShimNode);
  set('HTMLElement', ShimElement);
  set('DOMParser', class { parseFromString() { throw new Error('The shim does not parse XML.'); } });
  set('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} });
  set('location', location);
  set('navigator', { clipboard: { writeText: async () => {} } });
  // The console boots on import: it calls the API, then polls and ticks. A rejecting `fetch` sends
  // it down its own "not signed in" path, which is a legitimate state and needs no server.
  set('fetch', async () => { throw new Error('offline in tests'); });
  set('WebSocket', class { static OPEN = 1; close() {} send() {} addEventListener() {} });
  set('RTCPeerConnection', class { close() {} addEventListener() {} });
  set('window', { addEventListener: () => {}, removeEventListener: () => {}, location });
}
