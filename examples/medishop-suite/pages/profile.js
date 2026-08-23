import { Page } from './base.js';

export class ProfilePage extends Page {
  get name() { return this.byText('Rahul Arora'); }
  get email() { return this.byText('trainer@way2automation.com'); }
  async waitUntilReady() { await this.waitFor(this.name, 'the profile screen'); return this; }
}
