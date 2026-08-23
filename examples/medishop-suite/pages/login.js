import { Page } from './base.js';

export class LoginPage extends Page {
  /** The two EditTexts are the only fields on the screen, and Compose gives them no ids. */
  get emailField() { return this.driver.$$('android.widget.EditText')[0]; }
  get passwordField() { return this.driver.$$('android.widget.EditText')[1]; }
  get signInButton() { return this.byText('Sign In'); }

  async waitUntilReady() {
    // The app shows a splash ("INITIALIZING SYSTEM") before the form, so the first thing a suite
    // must do is wait for the form rather than the app.
    await this.waitFor(this.byText('Welcome Back'), 'the sign-in screen', 40_000);
    return this;
  }

  async signIn({ email, password }) {
    const e = await this.emailField;
    await e.clearValue();
    await e.setValue(email);

    const p = await this.passwordField;
    await p.clearValue();
    await p.setValue(password);

    await (await this.signInButton).click();
    return this;
  }
}
