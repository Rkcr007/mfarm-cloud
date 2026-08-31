// farm-online.sh's address-drift check, against a fake gcloud and a fake resolver.
//
// WHY THIS EXISTS. The check was broken for twelve days and nothing noticed, because the way it
// broke was to report DRIFT *every* time rather than never. It compared the VM's address to the
// name in `deploy/farm.env` with `[ "$LAB_IP" = "$MFARM_TURN_HOST" ]`, which worked while that
// variable held an sslip.io IP literal and stopped working the moment `mfarm.dev` landed on
// 2026-08-20 — an IP is never string-equal to a hostname.
//
// A warning that is always on is one people scroll past, so the start where an address had
// genuinely moved would have looked exactly like the twelve before it. That is the failure this
// file is here to keep fixed, and it is why the interesting assertions below are the NEGATIVE ones:
// the check must be able to come out both ways, or it is not a check.
//
// `gcloud` and `dig` are stubbed on PATH. The script is copied into a temp directory with its own
// `farm.env`, because it sources the one sitting next to it — which is also what lets each case
// choose the names under test.
//
//   node --test deploy/farm-online.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'farm-online.sh');

/**
 * A farm on disk: the real script, a farm.env we control, and stubs for the two external tools.
 *
 * `dns` maps a hostname to what the resolver answers; a name absent from it resolves to nothing,
 * which is how the "DNS is down" case is reached. `addresses` is what gcloud reports each VM
 * actually has, so drift is simulated by making the two disagree.
 */
function farm({ publicHost, turnHost, addresses, dns }) {
  const root = mkdtempSync(join(tmpdir(), 'farm-online-'));
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });

  copyFileSync(SCRIPT, join(root, 'farm-online.sh'));
  writeFileSync(join(root, 'farm.env'),
    `MFARM_PUBLIC_HOST=${publicHost}\nMFARM_TURN_HOST=${turnHost}\n`);

  // Only the three verbs the script uses. `describe` is the one that matters; start and ssh just
  // have to succeed quickly so the test does not sit in the 40-iteration SSH wait.
  const cases = Object.entries(addresses)
    .map(([vm, ip]) => `      ${vm}) echo "${ip}" ;;`).join('\n');
  writeFileSync(join(bin, 'gcloud'), `#!/bin/sh
[ "$1" = compute ] || exit 1
case "$2" in
  ssh) exit 0 ;;
  instances)
    case "$3" in
      start) echo "Instance external IP is 0.0.0.0"; exit 0 ;;
      describe)
        case "$4" in
${cases}
          *) exit 1 ;;
        esac
        ;;
    esac
    ;;
esac
exit 1
`);
  chmodSync(join(bin, 'gcloud'), 0o755);

  // `dig +short <name>` — prints one address per line, nothing at all for an unknown name, which
  // is exactly how the real thing behaves for NXDOMAIN.
  const answers = Object.entries(dns)
    .map(([name, ip]) => `  ${name}) echo "${ip}" ;;`).join('\n');
  writeFileSync(join(bin, 'dig'), `#!/bin/sh
for a in "$@"; do case "$a" in -*) ;; *) name="$a" ;; esac; done
case "$name" in
${answers}
esac
exit 0
`);
  chmodSync(join(bin, 'dig'), 0o755);

  const run = () => execFileSync('bash', [join(root, 'farm-online.sh')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { root, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The remediation block, printed only when something actually drifted. */
const REMEDIATION = 'An address moved';

test('both addresses matching their names is reported as a match, with no drift', () => {
  const f = farm({
    publicHost: 'farm.mfarm.dev',
    turnHost: 'turn.mfarm.dev',
    addresses: { 'mfarm-cp': '34.100.138.213', 'mfarm-lab': '34.100.159.34' },
    dns: { 'farm.mfarm.dev': '34.100.138.213', 'turn.mfarm.dev': '34.100.159.34' },
  });
  try {
    const out = f.run();
    // THE REGRESSION ASSERTION. This is the exact configuration that ran on 2026-09-01 with both
    // addresses correct, and the old check called it DRIFT twice.
    assert.doesNotMatch(out, /DRIFT/, 'correct addresses must not be reported as drift');
    assert.doesNotMatch(out, new RegExp(REMEDIATION));
    assert.match(out, /device host is 34\.100\.159\.34, matching turn\.mfarm\.dev/);
    assert.match(out, /control plane is 34\.100\.138\.213, matching farm\.mfarm\.dev/);
  } finally { f.cleanup(); }
});

test('an address that really moved is reported as drift, with the remediation', () => {
  const f = farm({
    publicHost: 'farm.mfarm.dev',
    turnHost: 'turn.mfarm.dev',
    // The device host came back on a different address; DNS still points at the old one.
    addresses: { 'mfarm-cp': '34.100.138.213', 'mfarm-lab': '35.200.1.1' },
    dns: { 'farm.mfarm.dev': '34.100.138.213', 'turn.mfarm.dev': '34.100.159.34' },
  });
  try {
    const out = f.run();
    assert.match(out, /DRIFT: device host is 35\.200\.1\.1 but turn\.mfarm\.dev resolves to 34\.100\.159\.34/);
    assert.match(out, new RegExp(REMEDIATION));
    // The half that did NOT move must still read as fine, or the operator cannot tell which to fix.
    assert.match(out, /control plane is 34\.100\.138\.213, matching farm\.mfarm\.dev/);
  } finally { f.cleanup(); }
});

test('a name that will not resolve is UNRESOLVED, and is not counted as drift', () => {
  const f = farm({
    publicHost: 'farm.mfarm.dev',
    turnHost: 'turn.mfarm.dev',
    addresses: { 'mfarm-cp': '34.100.138.213', 'mfarm-lab': '34.100.159.34' },
    dns: { 'farm.mfarm.dev': '34.100.138.213' },   // turn.mfarm.dev answers nothing
  });
  try {
    const out = f.run();
    assert.match(out, /UNRESOLVED: device host is 34\.100\.159\.34/);
    // "DNS is down" and "the address moved" need different actions. Telling someone to re-reserve
    // an address because their resolver is broken sends them at the wrong problem.
    assert.doesNotMatch(out, /DRIFT/);
    assert.doesNotMatch(out, new RegExp(REMEDIATION));
  } finally { f.cleanup(); }
});

test('a bare IP in farm.env still works, so reverting the domain does not re-break this', () => {
  const f = farm({
    publicHost: '34.100.138.213',
    turnHost: '34.100.159.34',
    addresses: { 'mfarm-cp': '34.100.138.213', 'mfarm-lab': '34.100.159.34' },
    dns: {},   // nothing resolvable: an IP literal must not need the resolver at all
  });
  try {
    const out = f.run();
    assert.doesNotMatch(out, /DRIFT/);
    assert.doesNotMatch(out, /UNRESOLVED/);
  } finally { f.cleanup(); }
});
