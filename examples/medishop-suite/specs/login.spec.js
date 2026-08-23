/**
 * Sign-in, the flow every other test depends on.
 *
 * One device per spec file, held for the whole file: allocation costs a few seconds and a
 * powerwash reset costs a minute, so a device per TEST would spend more time recycling than
 * testing. That is a farm-shaped decision, not an Appium one, and it is the main thing that
 * changes when a suite moves off a laptop.
 */
import { test as nodeTest, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, farmTest, CREDENTIALS } from '../farm.js';
import { LoginPage } from '../pages/login.js';
import { HomePage } from '../pages/home.js';

let driver, login, home;

// `test`, plus one line telling the farm the outcome. Without it the farm sees a session open and
// close and cannot tell a pass from a failure — so the console's Runs screen reads "Not reported"
// for the whole run rather than showing a green tick it has not earned.
const test = farmTest(() => driver, nodeTest);

before(async () => {
  driver = await connect();
  login = new LoginPage(driver);
  home = new HomePage(driver);
  await login.waitUntilReady();
});

after(async () => { await driver?.deleteSession().catch(() => {}); });

describe('sign in', () => {
  test('the app opens on the practice portal', async () => {
    assert.ok(await login.isShowing('Sign in to the Practice Portal'));
  });

  test('the wrong password does not sign anyone in', async () => {
    await login.signIn({ email: CREDENTIALS.email, password: 'definitely-not-the-password' });
    // Still on the form: no greeting, and the sign-in heading is where it was.
    assert.ok(await login.isShowing('Welcome Back'), 'a bad password must leave you on the sign-in screen');
    assert.ok(!(await home.isShowing('Good Morning,', 3000)), 'a bad password must not reach the home screen');
  });

  test('the real credentials reach the home screen', async () => {
    await login.signIn(CREDENTIALS);
    await home.waitUntilReady();
    assert.ok(await (await home.userName).isDisplayed(), 'the signed-in user should be named on the home screen');
  });
});
