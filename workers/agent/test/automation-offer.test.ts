/**
 * Whether a device is offered for WebDriver — D60.
 *
 * Two things can each withdraw it, on different clocks: the automation server, and the phone
 * itself. The defect this exists for is a phone with a healthy Appium that could not start a
 * session, advertised all the same.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AutomationOffer } from '../src/automation-offer.ts';

const URL = 'mfarm+tunnel:/automation/phone-A';

/** Every change the agent was told about, in order. */
const recorder = () => {
  const calls: Array<[string, string | undefined]> = [];
  return { calls, offer: new AutomationOffer((id, url) => calls.push([id, url])) };
};

describe('AutomationOffer', () => {
  test('a device with a server and nothing blocking it is offered', () => {
    const { calls, offer } = recorder();
    offer.serverIs('phone-A', URL);
    assert.deepEqual(calls, [['phone-A', URL]]);
    assert.equal(offer.offered('phone-A'), URL);
  });

  test('a blocked device is not offered, however healthy its server', () => {
    const { calls, offer } = recorder();
    offer.blockedBy('phone-A', 'refuses adb');
    offer.serverIs('phone-A', URL);
    assert.deepEqual(calls, [], 'nothing was ever advertised, so there is nothing to say');
    assert.equal(offer.offered('phone-A'), undefined);
  });

  test('blocking a device that is on offer withdraws it', () => {
    const { calls, offer } = recorder();
    offer.serverIs('phone-A', URL);
    offer.blockedBy('phone-A', 'refuses adb');
    assert.deepEqual(calls, [['phone-A', URL], ['phone-A', undefined]]);
  });

  /** The person flipped the switch. Nothing is restarted; the next beat carries it. */
  test('unblocking puts it back, with the server it already had', () => {
    const { calls, offer } = recorder();
    offer.serverIs('phone-A', URL);
    offer.blockedBy('phone-A', 'refuses adb');
    offer.blockedBy('phone-A', undefined);
    assert.deepEqual(calls.at(-1), ['phone-A', URL]);
  });

  /**
   * THE ONE THE TWO-CALLER VERSION GOT WRONG. Appium flaps on its own schedule; if its recovery
   * simply re-advertised, a phone that is still blocked would be offered again by an event that has
   * nothing to do with why it was withdrawn.
   */
  test('the server coming back does not re-offer a device that is still blocked', () => {
    const { calls, offer } = recorder();
    offer.serverIs('phone-A', URL);
    offer.blockedBy('phone-A', 'refuses adb');
    offer.serverIs('phone-A', undefined);
    offer.serverIs('phone-A', URL);
    assert.deepEqual(calls, [['phone-A', URL], ['phone-A', undefined]]);
    assert.equal(offer.offered('phone-A'), undefined);
  });

  /** And the mirror image: a phone being unblocked must not advertise a server that is down. */
  test('unblocking does not offer a device whose server is down', () => {
    const { calls, offer } = recorder();
    offer.blockedBy('phone-A', 'refuses adb');
    offer.blockedBy('phone-A', undefined);
    assert.deepEqual(calls, []);
  });

  test('saying the same thing twice tells the agent once', () => {
    const { calls, offer } = recorder();
    offer.serverIs('phone-A', URL);
    offer.serverIs('phone-A', URL);
    offer.blockedBy('phone-A', 'refuses adb');
    offer.blockedBy('phone-A', 'refuses adb');
    assert.equal(calls.length, 2);
  });

  test('one device being blocked says nothing about the one beside it', () => {
    const { offer } = recorder();
    offer.serverIs('phone-A', URL);
    offer.serverIs('phone-B', 'mfarm+tunnel:/automation/phone-B');
    offer.blockedBy('phone-A', 'refuses adb');
    assert.equal(offer.offered('phone-A'), undefined);
    assert.equal(offer.offered('phone-B'), 'mfarm+tunnel:/automation/phone-B');
    assert.equal(offer.blockerOf('phone-A'), 'refuses adb');
    assert.equal(offer.blockerOf('phone-B'), undefined);
  });
});
