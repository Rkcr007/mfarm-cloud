import { Page } from './base.js';

export class HomePage extends Page {
  get greeting() { return this.byText('Good Morning,'); }
  get userName() { return this.byText('Rahul Arora'); }
  category(name) { return this.byText(name); }
  tab(name) { return this.byText(name); }

  async waitUntilReady() {
    await this.waitFor(this.greeting, 'the home screen', 30_000);
    return this;
  }

  async openCategory(name) {
    await (await this.category(name)).click();
    return this;
  }

  /**
   * The bottom navigation is only on the top-level screens.
   *
   * Learned by driving it: tapping a category opens a catalogue that has a Back button and NO tab
   * bar, so a suite that assumes the tabs are always there fails on the second step with a
   * misleading "element not found".
   */
  async openTab(name) {
    // The bar only exists on top-level screens. If we are somewhere deeper — a catalogue, a product
    // — walk back until it reappears, rather than failing with "element wasn't found", which says
    // nothing about the fact that the app simply is not showing tabs right now.
    for (let i = 0; i < 3; i++) {
      if (await this.isShowing(name, 2500)) break;
      await this.driver.back();
    }
    await (await this.tab(name)).click();
    return this;
  }
}
