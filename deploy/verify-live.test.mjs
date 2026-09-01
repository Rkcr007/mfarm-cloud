// verify-live.sh's tunnel check, against a fake control plane.
//
// WHY THIS EXISTS. The tunnel count was sampled ONCE, up with the control-plane checks, and asserted
// on much later — after a fleet wait that can run for minutes. On a farm that had just been started
// that snapshot was always from before the agent existed, so the script reported
//
//     ✗ no agent tunnel connected — every live view is dead, however healthy the fleet looks
//     ✓ 3 devices READY
//
// while the worker log showed `data-plane tunnel connected` seconds afterwards. Re-running always
// said the farm was live, which is the tell: a check whose answer depends on when you happened to
// sample it is not measuring the farm.
//
// It is the same shape as the drift check in `farm-online.test.mjs` — a line that is always wrong
// in one direction is one people learn to scroll past, and then the run where it means something
// looks exactly like the twenty before it.
//
// `curl` is stubbed on PATH and answers by URL. The tunnel gauge is the interesting one: it can be
// made to appear only after N reads, which is precisely the race, and the sampling is counted so a
// test can prove the script re-read at all rather than getting lucky.
//
//   node --test deploy/verify-live.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'verify-live.sh');

/**
 * A control plane on disk.
 *
 * `tunnelAfter` is the number of gauge reads that answer 0 before the agent "connects" — 0 means it
 * was there all along, and a large number means it never arrives. `devices` is what /v1/devices
 * reports, which is what the fleet wait is waiting for.
 */
function farm({ devices = 3, tunnelAfter = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'verify-live-'));
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, 'deploy', 'secrets'), { recursive: true });
  mkdirSync(join(root, 'deploy', '.state'), { recursive: true });

  copyFileSync(SCRIPT, join(root, 'deploy', 'verify-live.sh'));
  writeFileSync(join(root, 'deploy', 'farm.env'),
    'MFARM_PUBLIC_HOST=farm.example.test\nMFARM_TURN_HOST=turn.example.test\n');
  // Both must exist or the script skips the checks under test rather than running them.
  writeFileSync(join(root, 'deploy', 'secrets', 'metrics_token'), 'tok\n');
  writeFileSync(join(root, 'deploy', '.state', 'api_key'), 'mfk_test\n');

  const counter = join(root, 'gauge-reads');
  writeFileSync(counter, '0');

  // Answers by URL. Everything not named here succeeds silently, which keeps the stub to the two
  // endpoints this test is actually about.
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
url=""
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
case "$url" in
  *"/metrics")
    n=$(cat ${counter}); n=$((n+1)); echo "$n" > ${counter}
    if [ "$n" -gt ${tunnelAfter} ]; then echo "mfarm_tunnel_hosts_connected 1"
    else echo "mfarm_tunnel_hosts_connected 0"; fi
    ;;
  *"/v1/devices")  echo '{"available":${devices},"devices":[]}' ;;
  *"/health")      echo 'ok' ;;
  *"/v1/version")  echo '{"short":"testsha","sha":"testsha"}' ;;
  *"/dp")          echo '426' ;;
  *)               echo '' ;;
esac
exit 0
`);
  chmodSync(join(bin, 'curl'), 0o755);

  // The relay check shells out to these; neither is what this file is about.
  for (const tool of ['nc', 'openssl', 'dig', 'ss']) {
    writeFileSync(join(bin, tool), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, tool), 0o755);
  }

  const run = () => {
    try {
      return execFileSync('bash', [join(root, 'deploy', 'verify-live.sh')], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          // 0 so the fleet loop's trailing `sleep 15` never runs: with devices present the loop
          // breaks before it, and with none there is nothing to wait for.
          DEVICE_WAIT_SECONDS: devices > 0 ? '30' : '0',
          // The real default is 60s. Exercising the "never connects" branch honestly means letting
          // the wait expire, and doing that at full length would put a minute into every CI run.
          TUNNEL_WAIT_SECONDS: '2',
        },
      });
    } catch (e) {
      // A farm that is not live exits non-zero; the OUTPUT is what these tests assert on.
      return `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
  };
  const gaugeReads = () => Number(readFileSync(counter, 'utf8').trim());
  return { run, gaugeReads, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a tunnel that connects during the fleet wait is seen, not reported dead', () => {
  // THE REGRESSION. The first read answers 0 — the agent has not connected yet — and the old code
  // asserted on exactly that value however long it waited afterwards.
  const f = farm({ devices: 3, tunnelAfter: 1 });
  try {
    const out = f.run();
    assert.doesNotMatch(out, /no agent tunnel connected/,
      'a tunnel that arrives during the wait must not be reported as dead');
    assert.match(out, /agent tunnel\(s\) connected/);
    // Proves it RE-READ rather than got lucky: one sample could never have seen the change.
    assert.ok(f.gaugeReads() >= 2, `expected more than one gauge read, got ${f.gaugeReads()}`);
  } finally { f.cleanup(); }
});

test('a tunnel that never connects is still reported, and still fails', () => {
  // The assertion must be able to come out both ways, or the fix above has just disabled a check
  // instead of correcting it. This is the half that makes the other half mean something.
  const f = farm({ devices: 3, tunnelAfter: 9999 });
  try {
    const out = f.run();
    assert.match(out, /no agent tunnel connected/,
      'a genuinely absent tunnel must still be a failure');
  } finally { f.cleanup(); }
});

test('a farm with no devices does not wait for a tunnel nobody is bringing up', () => {
  // The device host being off is the deliberate idle state and 95% of the bill, so it is the most
  // common way this script is run. Waiting a minute there would add a minute to learn nothing.
  const f = farm({ devices: 0, tunnelAfter: 9999 });
  try {
    const started = Date.now();
    const out = f.run();
    const elapsed = Date.now() - started;
    assert.match(out, /looks STOPPED/, 'no devices and no agent is the idle state, not a fault');
    assert.ok(elapsed < 30_000, `should not wait for a tunnel with no devices; took ${elapsed}ms`);
  } finally { f.cleanup(); }
});
