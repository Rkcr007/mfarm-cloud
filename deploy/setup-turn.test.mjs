// setup-turn.sh's coturn config, rendered (TURN_CONF_OUT) rather than installed, and read back.
//
// The peer rules are the part worth a test. The relay is the one service the farm deliberately puts
// on the internet over UDP, and what it may forward TO is the whole of its security: a rule that lets
// it reach a private address hands that address to anyone holding ordinary viewer credentials. It
// moved to the control plane (ADR-0047), whose own private address sits in the range the old config
// allowed wholesale.
//
// The script is copied into a temp directory WITHOUT farm.env beside it, so every input is the
// environment's — the checked-in farm.env would otherwise answer for the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function render(env, { secret = 'a'.repeat(64) } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'setup-turn-'));
  copyFileSync(join(here, 'setup-turn.sh'), join(root, 'setup-turn.sh'));
  const secretFile = join(root, 'secrets', 'turn_secret');
  if (secret !== null) {
    execFileSync('mkdir', ['-p', join(root, 'secrets')]);
    writeFileSync(secretFile, secret);
  }
  const out = join(root, 'turnserver.conf');
  let status = 0;
  let output = '';
  try {
    output = execFileSync('bash', [join(root, 'setup-turn.sh')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        PUBLIC_IP: '34.100.138.213', PRIVATE_IP: '10.160.0.3', TURN_REALM: 'turn.mfarm.dev',
        SECRET_FILE: secretFile, TURN_CONF_OUT: out,
        ...env,
      },
    });
  } catch (e) {
    status = e.status ?? 1;
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const conf = existsSync(out) ? readFileSync(out, 'utf8') : '';
  return { conf, status, output, secretFile, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const lines = (conf, key) => conf.split('\n').filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1));

test('every private range is denied, and only the named device hosts are let back in', () => {
  const r = render({ MFARM_RELAY_PEERS: '10.160.0.2 10.160.0.9' });
  try {
    assert.equal(r.status, 0, r.output);
    const denied = lines(r.conf, 'denied-peer-ip');
    for (const range of ['10.0.0.0-10.255.255.255', '100.64.0.0-100.127.255.255', '127.0.0.0-127.255.255.255',
      '169.254.0.0-169.254.255.255', '172.16.0.0-172.31.255.255', '192.168.0.0-192.168.255.255']) {
      assert.ok(denied.includes(range), `${range} is not denied`);
    }
    assert.deepEqual(lines(r.conf, 'allowed-peer-ip'), ['10.160.0.2', '10.160.0.9']);
    // THE REGRESSION. The old config let the whole VPC range back in — which, on the control plane,
    // includes the control plane.
    assert.ok(!r.conf.includes('10.160.0.0-10.160.255.255'), 'the whole VPC range is allowed again');
    assert.ok(!lines(r.conf, 'allowed-peer-ip').includes('10.160.0.3'), 'the relay may forward to its own host');
    assert.match(r.conf, /^no-loopback-peers$/m);
  } finally { r.cleanup(); }
});

test('with no device hosts named, no private address is reachable at all', () => {
  const r = render({ MFARM_RELAY_PEERS: '' });
  try {
    assert.equal(r.status, 0, r.output);
    assert.deepEqual(lines(r.conf, 'allowed-peer-ip'), []);
  } finally { r.cleanup(); }
});

test('it advertises the public address, relays on the private one, and uses the shared secret', () => {
  const r = render({ MFARM_RELAY_PEERS: '10.160.0.2' }, { secret: `${'b'.repeat(64)}\n` });
  try {
    assert.equal(r.status, 0, r.output);
    assert.deepEqual(lines(r.conf, 'external-ip'), ['34.100.138.213/10.160.0.3']);
    assert.deepEqual(lines(r.conf, 'relay-ip'), ['10.160.0.3']);
    assert.deepEqual(lines(r.conf, 'listening-ip'), ['10.160.0.3']);
    assert.deepEqual(lines(r.conf, 'static-auth-secret'), ['b'.repeat(64)], 'not the secret the API signs with');
    assert.match(r.conf, /^use-auth-secret$/m);
    // The relay ports and the firewall rule `mfarm-allow-turn` must agree, or media never arrives.
    assert.deepEqual([lines(r.conf, 'min-port'), lines(r.conf, 'max-port')], [['49152'], ['65535']]);
  } finally { r.cleanup(); }
});

test('an empty secret is refused rather than written into a relay nobody can authenticate to', () => {
  const r = render({ MFARM_RELAY_PEERS: '10.160.0.2' }, { secret: '' });
  try {
    assert.notEqual(r.status, 0);
    assert.match(r.output, /empty/);
    assert.equal(r.conf, '', 'a config was written anyway');
  } finally { r.cleanup(); }
});

test('a missing secret is generated where SECRET_FILE says', () => {
  const r = render({ MFARM_RELAY_PEERS: '10.160.0.2' }, { secret: null });
  try {
    assert.equal(r.status, 0, r.output);
    const made = readFileSync(r.secretFile, 'utf8').trim();
    assert.match(made, /^[0-9a-f]{64}$/);
    assert.deepEqual(lines(r.conf, 'static-auth-secret'), [made]);
  } finally { r.cleanup(); }
});
