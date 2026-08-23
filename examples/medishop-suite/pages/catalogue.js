import { Page } from './base.js';

export class CataloguePage extends Page {
  get title() { return this.byText('Search Medicines'); }
  /**
   * The add control, matched several ways on purpose.
   *
   * Compose renders this as an icon button on some layouts and a labelled one on others — the
   * catalogue shows a bare `+` while the wider card shows `Add`. A single-text selector matched in
   * the console's inspector and then failed on the running app, which is the everyday reality of
   * selecting by copy and the reason the inspector labels text selectors BRITTLE.
   *
   * A union is the honest fix here. The real fix belongs in the app: a `testTag` on this button
   * would give it a resource-id and make all of this one stable selector.
   */
  get addButton() {
    return this.driver.$(
      "//*[@text='Add' or @content-desc='Add' or @text='+' or @content-desc='Add to cart'"
      + " or contains(@content-desc,'Add')]",
    );
  }
  product(name) { return this.byText(name); }

  async waitUntilReady() {
    await this.waitFor(this.title, 'the medicine catalogue');
    return this;
  }

  async addFirstProduct() {
    await (await this.addButton).click();
    return this;
  }
}
