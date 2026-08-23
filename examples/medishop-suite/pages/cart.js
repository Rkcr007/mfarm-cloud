import { Page } from './base.js';

export class CartPage extends Page {
  get title() { return this.byText('Your Cart'); }
  get orderSummary() { return this.byText('Order Summary'); }
  get promoField() { return this.byText('Promo code'); }
  lineItem(name) { return this.byText(name); }

  async waitUntilReady() {
    await this.waitFor(this.orderSummary, 'the cart');
    return this;
  }
}
