/**
 * Shared helpers for every page.
 *
 * WHY EVERYTHING HERE IS TEXT OR CONTENT-DESC. MediShop is Jetpack Compose, and Compose emits no
 * resource-ids at all — `~accessibility id` and `//*[@text=…]` are the only handles that exist. The
 * console's element inspector says so for each element, and every selector below came from it.
 *
 * That is worth knowing before writing a suite against any Compose app: the usual advice, "always
 * select by id", is not available, and a suite that waits for one will wait forever.
 */
export class Page {
  constructor(driver) { this.driver = driver; }

  /** An element by its visible text. */
  byText(text) { return this.driver.$(`//*[@text=${xpathLiteral(text)}]`); }

  /** An element by its accessibility label — preferred over text where an app provides one. */
  byLabel(label) { return this.driver.$(`~${label}`); }

  /**
   * Wait for something to appear, and say what was being waited for when it does not.
   *
   * The default WebdriverIO timeout message names a selector; on a Compose app that selector is an
   * xpath full of copy, and the useful sentence is "the cart never loaded", not the xpath.
   */
  async waitFor(el, what, timeout = 20_000) {
    await el.waitForDisplayed({ timeout, timeoutMsg: `${what} did not appear within ${timeout / 1000}s` });
    return el;
  }

  async isShowing(text, timeout = 8_000) {
    try {
      await this.byText(text).waitForDisplayed({ timeout });
      return true;
    } catch { return false; }
  }
}

/** XPath 1.0 has no escape for a quote inside a literal; `concat()` is the only way. */
export function xpathLiteral(v) {
  return v.includes("'") ? `concat('${v.split("'").join(`', "'", '`)}')` : `'${v}'`;
}
