import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSharing, setShared, sharedByDefault } from '../src/sharing.ts';

/**
 * Discovered is not shared — ADR-0009 §2.
 *
 * The behaviour under test is a guardrail rather than a feature, so the cases that matter are the
 * ones where something goes wrong: a missing file, a corrupt file, a device nobody has been asked
 * about. Every one of them must fail CLOSED. A bug here does not break a build — it offers
 * somebody's personal phone, with their banking and 2FA apps on it, to their colleagues, and
 * nothing about that is visible from the console.
 */

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mfarm-sharing-'));
  path = join(dir, 'shared.json');
});

after(async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); });

describe('what is shared by default', () => {
  test('a phone is not', async () => {
    const policy = await loadSharing(path);
    assert.equal(policy.allows('RZCX61ANKGE', 'physical'), false);
  });

  test('a Cuttlefish instance is', async () => {
    // Infrastructure somebody provisioned on purpose, whose reason for existing is to be
    // scheduled. Defaulting the whole fleet off would take the existing farm out of service to fix
    // a problem it does not have.
    const policy = await loadSharing(path);
    assert.equal(policy.allows('0.0.0.0:6520', 'cuttlefish'), true);
    assert.equal(policy.allows(undefined, 'cuttlefish'), true);
    assert.equal(sharedByDefault('cuttlefish'), true);
    assert.equal(sharedByDefault('physical'), false);
  });

  test('a device with no serial follows its tier, because it cannot be named', async () => {
    await setShared('something-else', true, path);
    const policy = await loadSharing(path);
    assert.equal(policy.allows(undefined, 'physical'), false);
    assert.equal(policy.allows(undefined, 'avd'), true);
  });
});

describe('recording a decision', () => {
  test('sharing a phone, and taking it back', async () => {
    await setShared('RZCX61ANKGE', true, path);
    assert.equal((await loadSharing(path)).allows('RZCX61ANKGE', 'physical'), true);

    await setShared('RZCX61ANKGE', false, path);
    assert.equal((await loadSharing(path)).allows('RZCX61ANKGE', 'physical'), false);
  });

  test('one phone shared does not share the one beside it', async () => {
    // The whole point of per-device: two phones on one laptop, one of them somebody's own.
    await setShared('WORK-PHONE', true, path);
    const policy = await loadSharing(path);
    assert.equal(policy.allows('WORK-PHONE', 'physical'), true);
    assert.equal(policy.allows('PERSONAL-PHONE', 'physical'), false);
  });

  test('a default-on device can be withheld and stays withheld', async () => {
    // "Not shared" and "never asked" must be distinguishable, or a Cuttlefish instance taken out of
    // service would silently come back the next time the file was read.
    await setShared('0.0.0.0:6520', false, path);
    assert.equal((await loadSharing(path)).allows('0.0.0.0:6520', 'cuttlefish'), false);
  });

  test('the decision survives being written twice', async () => {
    await setShared('A', true, path);
    await setShared('B', true, path);
    await setShared('A', false, path);
    const policy = await loadSharing(path);
    assert.equal(policy.allows('A', 'physical'), false);
    assert.equal(policy.allows('B', 'physical'), true);
  });

  test('the file is not world-readable', async () => {
    // Not a credential, but it IS a statement about whose phone strangers may drive.
    await setShared('RZCX61ANKGE', true, path);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

describe('failing closed', () => {
  test('a missing file shares nothing', async () => {
    const policy = await loadSharing(join(dir, 'does-not-exist.json'));
    assert.equal(policy.allows('RZCX61ANKGE', 'physical'), false);
  });

  test('a corrupt file shares nothing', async () => {
    // The failure mode has to be an inconvenience somebody notices, never a silent disclosure.
    await writeFile(path, 'not json at all');
    assert.equal((await loadSharing(path)).allows('RZCX61ANKGE', 'physical'), false);
  });

  test('a file with the wrong shape shares nothing', async () => {
    await writeFile(path, JSON.stringify({ shared: 'RZCX61ANKGE' }));
    assert.equal((await loadSharing(path)).allows('RZCX61ANKGE', 'physical'), false);
  });

  test('non-string entries are dropped rather than trusted', async () => {
    await writeFile(path, JSON.stringify({ shared: [null, 42, 'RZCX61ANKGE', { serial: 'X' }] }));
    const policy = await loadSharing(path);
    assert.equal(policy.allows('RZCX61ANKGE', 'physical'), true);
    assert.equal(policy.shared.size, 1, 'only the string survived');
  });
});
