/**
 * The deployer, RUN — against a real git repository, with the registry and the API stubbed.
 *
 * `auto-deploy.test.mjs` proves the decision is right. This proves the script asks the decision the
 * right questions and then does what it said it would, which is a different failure surface and the
 * one that has actually bitten this project: `git merge --ff-only` against an unfetched remote ref
 * reported success and moved nothing, and a deploy that exits zero having changed nothing is the
 * canonical MFARM defect (D18, D19, and `deploy/mfarm-deploy.sh`'s own header).
 *
 * git is REAL here rather than stubbed. The fast-forward, the fetch and `rev-parse origin/main` are
 * the parts most likely to be subtly wrong, and a stub would agree with whatever I wrote.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));
const sh = (cmd, opts = {}) => execFileSync('bash', ['-c', cmd], { encoding: 'utf8', ...opts });

/** A throwaway farm: a real checkout with a real origin, plus stub `docker`, `curl` and deploy. */
function farm({ released = true, ready = true, deployOk = true, running = 'old' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mfarm-ad-'));
  mkdirSync(join(root, 'deploy', 'lib'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  for (const f of ['auto-deploy.sh', 'lib/autodeploy-decision.sh']) {
    writeFileSync(join(root, 'deploy', f), readFileSync(join(SRC, 'deploy', f)));
  }
  chmodSync(join(root, 'deploy', 'auto-deploy.sh'), 0o755);

  // THE BARE REPO'S HEAD IS SET EXPLICITLY, and this is not tidiness.
  //
  // `git init --bare` points HEAD at whatever `init.defaultBranch` says. On this laptop that is
  // `main` and every test passed; on the CI runner it is `master`, so the clone in
  // `newCommitUpstream` checked out nothing ("remote HEAD refers to nonexistent ref"), committed
  // onto a fresh `master`, and `push origin main` died with "src refspec main does not match any".
  // Nine of twelve tests failed on CI having passed locally.
  //
  // Reproduced before fixing, with GIT_CONFIG_GLOBAL pointing at an `init.defaultBranch = master`
  // config — the harness now names the branch it wants at every step instead of inheriting one.
  sh(`set -e
    git init -q --bare "${root}/upstream"
    git -C "${root}/upstream" symbolic-ref HEAD refs/heads/main
    git init -q "${root}"
    git -C "${root}" config user.email t@t && git -C "${root}" config user.name t
    git -C "${root}" add -A && git -C "${root}" commit -qm base
    git -C "${root}" branch -M main
    git -C "${root}" remote add origin "${root}/upstream"
    git -C "${root}" push -q origin main`);

  // The stubs. Each one records that it was called, so a test can assert on what the script DID
  // rather than only on what it printed.
  const stub = (name, body) => {
    const p = join(root, 'bin', name);
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(p, 0o755);
  };
  stub('docker', `echo "$@" >> "${root}/docker.log"\n[ "${released}" = true ] && exit 0 || exit 1`);
  // The stubs read their answers from files at RUN time rather than baking them in, so a test can
  // change the farm's health between ticks — which is the only way to express "a build that was
  // healthy yesterday and is not today", the case the rollback exists for.
  stub('curl', `
    echo "$@" >> "${root}/curl.log"
    for a in "$@"; do
      case "$a" in
        *"/v1/version") printf '{"sha":"%s"}' "$(cat "${root}/running" 2>/dev/null)"; exit 0 ;;
        *"/ready")
          # A SCRIPT of answers, when the test writes one: one character consumed per probe, y for
          # healthy and anything else for not. A stub that could only be all-healthy or all-broken
          # cannot express a FLAPPING build, and flapping is the only thing that distinguishes
          # "ready three times" from "ready three times in a row" — which is the whole rule.
          if [ -s "${root}/ready-script" ]; then
            p="$(cat "${root}/ready-script")"
            printf '%s' "\${p:1}" > "${root}/ready-script"
            [ "\${p:0:1}" = y ] && exit 0 || exit 22
          fi
          [ "$(cat "${root}/ready" 2>/dev/null)" = yes ] && exit 0 || exit 22 ;;
      esac
    done
    exit 0`);
  writeFileSync(join(root, 'ready'), ready ? 'yes' : 'no');
  writeFileSync(join(root, 'running'), running === 'old'
    ? sh(`git -C "${root}" rev-parse HEAD`).trim() : running);
  // Stands in for mfarm-deploy.sh: records the sha it was asked for, and can refuse.
  writeFileSync(join(root, 'deploy', 'mfarm-deploy.sh'),
    `#!/usr/bin/env bash\necho "$1" >> "${root}/deployed.log"\n[ "${deployOk}" = true ] && exit 0 || exit 1\n`);
  chmodSync(join(root, 'deploy', 'mfarm-deploy.sh'), 0o755);

  mkdirSync(join(root, 'deploy', '.state'), { recursive: true });
  writeFileSync(join(root, 'deploy', '.state', 'api_key'), 'k');
  return root;
}

/** Move origin/main on, without touching the local checkout — a merge landing while the box sleeps. */
function newCommitUpstream(root, file = 'f.txt') {
  const clone = mkdtempSync(join(tmpdir(), 'mfarm-up-'));
  sh(`set -e
    git clone -q --branch main "${root}/upstream" "${clone}"
    git -C "${clone}" config user.email t@t && git -C "${clone}" config user.name t
    echo hi > "${clone}/${file}"
    git -C "${clone}" add -A && git -C "${clone}" commit -qm next
    git -C "${clone}" push -q origin HEAD:refs/heads/main`);
  return sh(`git -C "${clone}" rev-parse HEAD`).trim();
}

/**
 * The health gate's real cadence is five probes six seconds apart, which is right for a farm and
 * absurd for a suite. The interval is overridden here; the PROBE COUNT is not reduced to one,
 * because "consecutive" is the property under test and a single probe cannot express it.
 */
const FAST = 'MFARM_AUTODEPLOY_READY_PROBES=3 MFARM_AUTODEPLOY_READY_INTERVAL=0';

const run = (root, args = '', env = '') => {
  try {
    return { code: 0, out: sh(
      `cd "${root}" && PATH="${root}/bin:$PATH" ${FAST} ${env} ./deploy/auto-deploy.sh ${args} 2>&1`) };
  } catch (e) {
    return { code: e.status, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
};
const state = (root, f) => {
  const p = join(root, 'deploy', '.state', 'autodeploy', f);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
};

describe('a tick against a farm that is already current', () => {
  test('deploys nothing and clears the pending clock', () => {
    const root = farm();
    const r = run(root);
    assert.equal(r.code, 0);
    assert.match(r.out, /verdict=current/);
    assert.equal(existsSync(join(root, 'deployed.log')), false, 'must not have deployed anything');
    assert.equal(state(root, 'pending-since'), null);
  });

  /**
   * The heartbeat is written on EVERY path, not only on a deploy. A tick that only recorded success
   * would make `mfarm_autodeploy_check_age_seconds` say "the timer is dead" for a farm whose timer
   * is alive and correctly doing nothing — which is the normal state, so the alert would be firing
   * almost all the time and would be turned off.
   */
  test('still leaves a heartbeat', () => {
    const root = farm();
    run(root);
    assert.ok(state(root, 'last-check') !== null, 'last-check must exist even when nothing happened');
    assert.equal(state(root, 'status'), 'current');
  });
});

describe('a tick that finds main ahead', () => {
  /**
   * THE FAST-FORWARD IS THE ASSERTION. `merge --ff-only origin/main` without a preceding fetch
   * exits zero and moves nothing — it did, on the lab, on 2026-09-07 — so proving the deploy ran is
   * not enough. The checkout must actually be at the new commit afterwards.
   */
  test('fetches, fast-forwards the checkout, and deploys that exact sha', () => {
    const root = farm();
    const want = newCommitUpstream(root);
    const r = run(root);
    assert.equal(r.code, 0, r.out);
    assert.equal(sh(`git -C "${root}" rev-parse HEAD`).trim(), want, 'the checkout did not move');
    assert.equal(readFileSync(join(root, 'deployed.log'), 'utf8').trim(), want);
    assert.equal(state(root, 'last-good-sha'), want);
    assert.equal(state(root, 'status'), 'current');
  });

  test('an unreleased commit is waited for, and nothing is built or merged', () => {
    const root = farm({ released: false });
    const before = sh(`git -C "${root}" rev-parse HEAD`).trim();
    newCommitUpstream(root);
    const r = run(root);
    assert.match(r.out, /verdict=waiting/);
    assert.equal(existsSync(join(root, 'deployed.log')), false);
    assert.equal(sh(`git -C "${root}" rev-parse HEAD`).trim(), before, 'must not move the tree yet');
  });

  test('--dry-run decides and reports without touching the farm', () => {
    const root = farm();
    const before = sh(`git -C "${root}" rev-parse HEAD`).trim();
    newCommitUpstream(root);
    const r = run(root, '--dry-run');
    assert.match(r.out, /would deploy/);
    assert.equal(existsSync(join(root, 'deployed.log')), false);
    assert.equal(sh(`git -C "${root}" rev-parse HEAD`).trim(), before);
  });
});

describe('a build that comes up and then fails its health gate', () => {
  /**
   * The gate is the reason this is an automatic deployer rather than an automatic outage.
   * `mfarm-deploy.sh` proves the right sha is answering; this proves it is STILL answering a minute
   * later, which a build that dies on its first real query does not.
   */
  test('is rolled back to the last build that passed one', () => {
    const root = farm();
    const good = newCommitUpstream(root, 'a.txt');
    assert.equal(run(root).code, 0);
    assert.equal(state(root, 'last-good-sha'), good);

    // Now a bad one: /ready never answers.
    writeFileSync(join(root, 'ready'), 'no');   // the new build comes up and never gets ready
    const bad = newCommitUpstream(root, 'b.txt');
    const r = run(root);
    assert.equal(r.code, 1);
    assert.match(r.out, /HEALTH GATE FAILED/);
    const deployed = readFileSync(join(root, 'deployed.log'), 'utf8').trim().split('\n');
    assert.equal(deployed.at(-1), good, 'the last deploy must be the rollback to the good build');
    assert.equal(state(root, 'failed-sha'), bad);
  });

  /**
   * THE VERDICT THAT MAKES THIS A DEPLOYER RATHER THAN A LOOP, at the level of the whole script.
   * Without the recorded failure the next tick recomputes the same origin/main, finds the farm
   * serving something older, and redeploys the bad commit — every five minutes, forever.
   */
  test('and the very next tick refuses it instead of trying again', () => {
    const root = farm();
    newCommitUpstream(root, 'a.txt');
    run(root);
    writeFileSync(join(root, 'ready'), 'no');   // the new build comes up and never gets ready
    newCommitUpstream(root, 'b.txt');
    run(root);
    const afterFirst = readFileSync(join(root, 'deployed.log'), 'utf8').trim().split('\n').length;

    const r = run(root);
    assert.equal(r.code, 1);
    assert.match(r.out, /REFUSING/);
    const afterSecond = readFileSync(join(root, 'deployed.log'), 'utf8').trim().split('\n').length;
    assert.equal(afterSecond, afterFirst, 'a blocked commit must not be deployed again');
  });

  /**
   * WHY THE GATE COUNTS CONSECUTIVE PROBES rather than "was it ever ready".
   *
   * A container that is restarting answers healthily in the gap between the old process leaving and
   * the new one falling over. A gate satisfied by one success is therefore satisfied by precisely
   * the failure it exists to catch — and the first version of this suite never noticed, because
   * every unhealthy farm it built was unhealthy on every single probe. Deleting the `ok=0` reset
   * left all eleven tests green.
   */
  test('a /ready that flaps is NOT ready, however many times it answers', () => {
    const root = farm();
    const good = newCommitUpstream(root, 'a.txt');
    run(root);
    // Healthy on every other probe: it answers `ready` far more than the three times the gate asks
    // for, and never three times running. A gate that counted totals would pass this build.
    writeFileSync(join(root, 'ready-script'), 'ynynynynynynynynynyn');
    newCommitUpstream(root, 'b.txt');
    const r = run(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /HEALTH GATE FAILED/);
    assert.equal(readFileSync(join(root, 'deployed.log'), 'utf8').trim().split('\n').at(-1), good,
      'a build that was ready once must still be rolled back');
  });

  /**
   * With nothing known-good on record, no target is invented. Rolling back to a derived commit
   * would move the farm onto something nobody chose, backwards past migrations that do not roll
   * back — see the header. The farm keeps serving the suspect build and the run says so loudly.
   */
  test('with no recorded good build the farm is left alone, loudly', () => {
    const root = farm({ ready: false });
    newCommitUpstream(root);
    const r = run(root);
    assert.equal(r.code, 1);
    assert.match(r.out, /no recorded good build/);
    assert.equal(readFileSync(join(root, 'deployed.log'), 'utf8').trim().split('\n').length, 1);
  });
});

describe('the guards', () => {
  test('the kill switch stops a tick that would otherwise deploy', () => {
    const root = farm();
    newCommitUpstream(root);
    mkdirSync(join(root, 'deploy', '.state', 'autodeploy'), { recursive: true });
    writeFileSync(join(root, 'deploy', '.state', 'autodeploy', 'paused'), '');
    const r = run(root);
    assert.match(r.out, /PAUSED/);
    assert.equal(existsSync(join(root, 'deployed.log')), false);
  });

  /**
   * A checkout with local commits is a human's work, and a script's options for resolving it are
   * all destructive. It stops, records, and says which.
   */
  test('a checkout that will not fast-forward stops the deploy rather than forcing it', () => {
    const root = farm();
    newCommitUpstream(root);
    sh(`set -e
      echo local > "${root}/local.txt"
      git -C "${root}" add -A
      git -C "${root}" -c user.email=t@t -c user.name=t commit -qm "a human was here"`);
    const r = run(root);
    assert.equal(r.code, 1);
    assert.match(r.out, /will not fast-forward/);
    assert.equal(existsSync(join(root, 'deployed.log')), false);
    assert.match(sh(`git -C "${root}" log -1 --format=%s`).trim(), /a human was here/);
  });

  /**
   * THE SCRIPT FAST-FORWARDS THE TREE IT IS RUNNING FROM. bash seeks its script file as it executes,
   * so rewriting those bytes mid-run resumes the shell at an offset in a different file. The tick
   * pins itself to a copy first; this asserts the re-exec actually happened, because the guard is
   * invisible when it works and catastrophic and non-deterministic when it does not.
   */
  test('a tick executes from a pinned copy, not from the tree it moves', () => {
    const root = farm();
    const r = run(root, '--dry-run', 'MFARM_AUTODEPLOY_TRACE=1');
    assert.equal(r.code, 0, r.out);
    // The child re-exec sets MFARM_AUTODEPLOY_PINNED; if the guard were removed the script would
    // run once, from $REPO_ROOT/deploy, and this marker would never be written.
    const pinned = state(root, 'pinned-from');
    assert.ok(pinned, 'the script did not record where it executed from');
    // OUTSIDE THE REPO, not merely "a different string". The first version of this test compared
    // against `join(root, 'deploy')` while the script recorded `./deploy` — two values that can
    // never be equal, so the assertion held with the guard deleted. Comparing resolved prefixes is
    // what makes it a test.
    assert.ok(!pinned.startsWith(realpathSync(root)),
      `the executing copy is inside the tree it fast-forwards: ${pinned}`);
  });
});
