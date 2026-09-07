/**
 * "Should the box deploy this commit right now?" — the decision, executed.
 *
 * S7's first ceiling is that a released commit reaches the farm when a human runs a script. The
 * timer that removes the human is only safe because of this function, and every verdict in it
 * exists because of a specific way an unattended deploy goes wrong:
 *
 *   * `waiting` — Release runs AFTER CI, so `origin/main` names an unreleased commit for a few
 *     minutes after every merge, and `mfarm-deploy.sh` answers a failed pull by BUILDING ON THE BOX.
 *   * `blocked` — a timer with no memory of failure redeploys a bad commit every tick forever.
 *   * `unknown` — a failed `git fetch` must not be read as "main has not moved".
 *   * `paused`  — a kill switch that the rest of the logic can outvote is not a kill switch.
 *
 * Executed rather than read, for the reason `farm-up.test.mjs` records at length: a test that
 * asserts the text of a script stays green while the script does nothing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const lib = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'autodeploy-decision.sh');

const call = (fn, ...args) => execFileSync('bash', ['-c',
  `set -uo pipefail; . "$1"; shift; "$@"`, 'bash', lib, fn, ...args,
], { encoding: 'utf8' }).trim();

/** want / running / released / failed / paused, in the order the function takes them. */
const decide = (want, running, released = 'yes', failed = '', paused = '') =>
  call('mfarm_autodeploy_decision', want, running, released, failed, paused);

const WANT = '4319c3cbb7b1e0d4a9f2c6538e1a77d0b2e4f5a1';
const OLD  = '5089232ac41d8e6b0f3a2971cc84be55d1770f39';
const FULL = (s) => s;

describe('the timer deploys main, and refuses in every case where it should not', () => {
  test('a commit newer than what is serving is deployed', () => {
    assert.equal(decide(WANT, OLD), 'deploy');
  });

  test('the commit already serving is not redeployed', () => {
    assert.equal(decide(WANT, WANT), 'current');
    // `docker ps` prints the full sha; a checkout may be printed either way.
    assert.equal(decide(WANT, WANT.slice(0, 7)), 'current');
    assert.equal(decide(WANT, WANT.slice(0, 12)), 'current');
  });

  /**
   * THE TRAP THIS SESSION WALKED INTO BY HAND on 2026-09-07, four minutes after merging #128.
   *
   * `Release` fires on `workflow_run` after CI completes, so between a merge and its image there is
   * a window in which `origin/main` is a commit the registry has never heard of. `mfarm-deploy.sh`
   * answers a failed pull by building the image ON THE BOX — which fails on `mfarm-cp` (no
   * permission to read `deploy/secrets/metrics_token`) and, on a box where it succeeded, would put
   * an artifact CI never tested into production. Waiting is the only correct answer, and it must
   * survive however many ticks the Release takes.
   */
  test('an unreleased commit is waited for, never built', () => {
    assert.equal(decide(WANT, OLD, ''), 'waiting');
  });

  /**
   * THE VERDICT THAT MAKES THIS A DEPLOYER RATHER THAN A LOOP.
   *
   * A bad commit deploys, fails its health gate and is rolled back. Five minutes later the timer
   * recomputes the same `origin/main`, finds the farm serving something older, and — with no memory
   * of what just happened — does the whole thing again. One bad merge becomes a restart every tick
   * until a human intervenes, which is strictly worse than the manual deploy this replaces.
   */
  test('a commit that already failed its health gate is never retried', () => {
    assert.equal(decide(WANT, OLD, 'yes', WANT), 'blocked');
  });

  /**
   * Blocked BEFORE waiting, and the order is load-bearing rather than incidental. If the registry
   * were consulted first, a failed commit whose image had since been garbage-collected would report
   * `waiting` — "the farm is one Release away from being fine" — when it is one human away.
   */
  test('a failed commit reads as blocked even with no image, not as waiting', () => {
    assert.equal(decide(WANT, OLD, '', WANT), 'blocked');
  });

  test('a failure recorded against an older commit does not block the new one', () => {
    assert.equal(decide(WANT, OLD, 'yes', OLD), 'deploy');
  });

  /**
   * An unreadable `origin/main` must not read as "main has not moved". `git fetch` fails on a box
   * with no network more often than for any other reason, and `current` would be a lie told by a
   * script that had learned nothing.
   */
  test('an unreadable origin/main deploys nothing and says so', () => {
    for (const want of ['', 'unknown']) {
      assert.equal(decide(want, OLD), 'unknown', `"${want}" must not produce an action`);
    }
  });

  /**
   * An unreadable RUNNING sha is different: main is known, so there is a correct thing to deploy.
   * Refusing here would mean an API that is down — precisely when a deploy might fix it — also
   * disables the deployer.
   */
  test('an unreadable running sha does not stop a known main from landing', () => {
    for (const running of ['', 'unknown', 'abc']) {
      assert.equal(decide(WANT, running), 'deploy', `"${running}" should not block a known main`);
    }
  });

  test('the kill switch beats every other verdict', () => {
    assert.equal(decide(WANT, OLD, 'yes', '', 'paused'), 'paused');
    assert.equal(decide(WANT, WANT, 'yes', '', 'paused'), 'paused');
    assert.equal(decide('', '', '', '', 'paused'), 'paused');
  });

  /**
   * ARGUMENT ORDER, ASSERTED. Four of the five parameters are sha-shaped strings; transposing two
   * of them yields a function that still returns plausible verdicts against a real farm and is
   * wrong in a way no amount of staring at it reveals. `running` and `failed` are the dangerous
   * pair — swap them and a failed commit is redeployed forever, which is the exact defect `blocked`
   * exists to prevent.
   */
  test('running and failed are not interchangeable', () => {
    assert.equal(decide(WANT, WANT, 'yes', OLD), 'current');
    assert.equal(decide(WANT, OLD, 'yes', WANT), 'blocked');
  });
});

describe('rolling back needs a commit somebody chose', () => {
  const target = (lastGood, want) => call('mfarm_autodeploy_rollback_target', lastGood, want);

  test('the last build that passed its health gate is the target', () => {
    assert.equal(target(OLD, WANT), FULL(OLD));
  });

  /**
   * EMPTY IS A REAL ANSWER. On the first ever auto-deploy nothing has passed a health gate yet, and
   * a derived target — `origin/main~1`, the previous tag — would roll the farm onto a commit nobody
   * chose, backwards past migrations that do not roll back. The caller leaves the new build up,
   * records the failure so the next tick is `blocked`, and says so loudly.
   */
  test('with no recorded good build there is no target, and none is invented', () => {
    assert.equal(target('', WANT), '');
    assert.equal(target('unknown', WANT), '');
  });

  test('the commit that just failed is never the rollback target', () => {
    assert.equal(target(WANT, WANT), '');
    assert.equal(target(WANT.slice(0, 7), WANT), '');
  });
});
