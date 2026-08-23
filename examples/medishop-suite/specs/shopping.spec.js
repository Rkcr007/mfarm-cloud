/**
 * The shopping journey: browse, add, check the cart, and look at the other tabs.
 *
 * These are the assertions a real suite makes — that a flow reaches the screen it should and that
 * the screen carries the data it should — rather than screenshot comparisons, which on a software
 * renderer would be measuring the renderer.
 */
import { test as nodeTest, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, farmTest, CREDENTIALS } from '../farm.js';
import { LoginPage } from '../pages/login.js';
import { HomePage } from '../pages/home.js';
import { CataloguePage } from '../pages/catalogue.js';
import { CartPage } from '../pages/cart.js';
import { OrdersPage } from '../pages/orders.js';
import { ProfilePage } from '../pages/profile.js';

let driver, home, catalogue, cart, orders, profile;

// `test`, plus one line telling the farm the outcome. Without it the farm sees a session open and
// close and cannot tell a pass from a failure — so the console's Runs screen reads "Not reported"
// for the whole run rather than showing a green tick it has not earned.
const test = farmTest(() => driver, nodeTest);

before(async () => {
  driver = await connect();
  const login = new LoginPage(driver);
  home = new HomePage(driver);
  catalogue = new CataloguePage(driver);
  cart = new CartPage(driver);
  orders = new OrdersPage(driver);
  profile = new ProfilePage(driver);

  await login.waitUntilReady();
  await login.signIn(CREDENTIALS);
  await home.waitUntilReady();
});

after(async () => { await driver?.deleteSession().catch(() => {}); });

describe('browsing', () => {
  test('a category opens the medicine catalogue', async () => {
    await home.openCategory('Fever');
    await catalogue.waitUntilReady();
    assert.ok(await catalogue.isShowing('Paracetamol 500mg'), 'the catalogue should list a product');
  });

  test('a product can be added to the cart', async () => {
    await catalogue.addFirstProduct();
    // Back to a screen that has the tab bar; the catalogue does not.
    await driver.back();
    await home.waitUntilReady();
  });
});

describe('the cart', () => {
  test('holds line items and an order summary', async () => {
    await home.openTab('Cart');
    await cart.waitUntilReady();
    assert.ok(await cart.isShowing('Amoxicillin 250mg'), 'the seeded cart should list its items');
    assert.ok(await (await cart.promoField).isDisplayed(), 'the cart should offer a promo code field');
  });
});

describe('the other tabs', () => {
  test('orders shows history', async () => {
    await home.openTab('Orders');
    await orders.waitUntilReady();
    assert.ok(await orders.isShowing('Delivered'), 'order history should carry a status');
  });

  test('profile shows the signed-in account', async () => {
    await home.openTab('Profile');
    await profile.waitUntilReady();
    assert.ok(await (await profile.email).isDisplayed(), 'the profile should show the account email');
  });
});
