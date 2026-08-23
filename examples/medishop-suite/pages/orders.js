import { Page } from './base.js';

export class OrdersPage extends Page {
  get title() { return this.byText('Order History'); }
  async waitUntilReady() { await this.waitFor(this.title, 'order history'); return this; }
}
