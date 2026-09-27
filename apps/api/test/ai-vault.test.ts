/**
 * ADR-0045 without a database: a secret sealed at rest, bound to its org and name, and the text a
 * task, the model and a script see of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillSecrets, hideSecrets, seal, secretNamesIn, secretParts, SECRET_NAME, unseal, vaultKey } from '../src/ai/vault.ts';

const KEY = vaultKey('-----BEGIN PRIVATE KEY-----\ntest signing key\n-----END PRIVATE KEY-----');
const ORG = '11111111-1111-1111-1111-111111111111';

test('a sealed value opens with its key, org and name — and with nothing else', () => {
  const sealed = seal(KEY, ORG, 'PIN', '4812');
  assert.ok(!sealed.includes(Buffer.from('4812')), 'the value is not in the sealed bytes');
  assert.equal(unseal(KEY, ORG, 'PIN', sealed), '4812');
  assert.equal(unseal(KEY, '22222222-2222-2222-2222-222222222222', 'PIN', sealed), null, 'copied to another org');
  assert.equal(unseal(KEY, ORG, 'PASSCODE', sealed), null, 'renamed');
  assert.equal(unseal(vaultKey('another signing key'), ORG, 'PIN', sealed), null, 'the signing key was rotated');
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 1;
  assert.equal(unseal(KEY, ORG, 'PIN', tampered), null, 'a flipped bit');
  assert.notDeepEqual(seal(KEY, ORG, 'PIN', '4812'), sealed, 'a fresh IV each time: equal values do not look equal');
});

test('the key is derived the same way every time from the same signing key', () => {
  assert.deepEqual(vaultKey('k'), vaultKey('k'));
  assert.notDeepEqual(vaultKey('k'), vaultKey('k2'));
  assert.equal(vaultKey('k').length, 32);
});

test('names are capitals, digits and _, starting with a letter, at most 40', () => {
  for (const ok of ['PIN', 'LOGIN_EMAIL', 'A', `A${'B'.repeat(39)}`]) assert.ok(SECRET_NAME.test(ok), ok);
  for (const bad of ['pin', '1PIN', '_PIN', 'PIN-2', '', `A${'B'.repeat(40)}`]) assert.ok(!SECRET_NAME.test(bad), bad);
});

test('a task names its secrets; typing fills them; unknown ones are listed, not guessed', () => {
  assert.deepEqual(secretNamesIn('Log in with {{EMAIL}}, then {{PIN}}, then {{ PIN }} again; {{pin}} is not one'), ['EMAIL', 'PIN']);
  assert.deepEqual(fillSecrets('{{PIN}}', { PIN: '4812' }), { text: '4812', missing: [] });
  assert.deepEqual(fillSecrets('code {{PIN}} for {{EMAIL}}', { PIN: '4812' }), { text: 'code 4812 for {{EMAIL}}', missing: ['EMAIL'] });
  assert.deepEqual(fillSecrets('no secrets here', {}), { text: 'no secrets here', missing: [] });
});

test('what the model reads has each value replaced by its name — longest first, so one inside another goes whole', () => {
  assert.equal(hideSecrets('PIN field shows 4812', { PIN: '4812' }), 'PIN field shows {{PIN}}');
  assert.equal(hideSecrets('code 48123 then 4812', { PIN: '4812', LONG: '48123' }), 'code {{LONG}} then {{PIN}}');
  assert.equal(hideSecrets('nothing', { EMPTY: '' }), 'nothing', 'an empty value would match everywhere');
});

test('a script writes a typed secret as code that reads it — never as its value', () => {
  assert.deepEqual(secretParts('code {{PIN}}!'), [{ text: 'code ' }, { secret: 'PIN' }, { text: '!' }]);
  assert.deepEqual(secretParts('{{PIN}}'), [{ secret: 'PIN' }]);
  assert.deepEqual(secretParts('plain'), [{ text: 'plain' }]);
});
