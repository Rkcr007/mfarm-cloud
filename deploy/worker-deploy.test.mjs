// worker-deploy.sh, against a fake git, npm and systemd — and a REAL node.
//
// WHY THIS EXISTS. The device host's deploy was written down in five places as "git pull, restart
// the worker". #254 gave the agent a dependency its first import reaches, and from that commit on
// those two commands would have stopped the worker for good: nothing installed `werift`, the unit
// retried five times and gave up. It was found on 2026-10-10 by asking the device host what it had
// before deploying to it — thirteen days behind `main`, and `node_modules/werift` absent (D82).
//
// So the assertions that matter here are about ORDER and REFUSAL: the install comes before the
// restart, and there is no restart at all while something the agent declares cannot be resolved.
//
// WHAT IS REAL AND WHAT IS NOT. `git`, `npm`, `sudo`, `systemctl` and `journalctl` are stubs on
// PATH that write what they were asked to one log. `node` is the real one, resolving against a real
// `node_modules` this file builds — because the gate under test is Node's own lookup, and a stubbed
// lookup would be testing the stub. The fake `npm install` "installs" by creating the package.
//
//   node --test deploy/worker-deploy.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'worker-deploy.sh');

/**
 * A device host on disk.
 *
 * `declares` is what the agent's package.json names; `installed` is what is in `node_modules`
 * before the run; `npmInstalls` is what the fake `npm install` adds (so leaving a name out is how
 * "the install ran and the package is still not there" is reached). `pids` is what systemd answers
 * for the worker's MainPID on each successive ask — two different values is a crash loop.
 */
function host({
  have = 'aaaaaaa1', want = 'bbbbbbb2',
  declares = ['werift', 'ws'], installed = ['ws'], npmInstalls = ['werift'],
  npmExit = 0, fetchExit = 0, mergeExit = 0, hasUnit = true,
  state = 'active', pids = ['4242', '4242'], lockRewritten = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'worker-deploy-'));
  const bin = join(root, 'bin');
  const log = join(root, 'calls');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, 'deploy'), { recursive: true });
  mkdirSync(join(root, 'workers', 'agent'), { recursive: true });
  copyFileSync(SCRIPT, join(root, 'deploy', 'worker-deploy.sh'));

  writeFileSync(join(root, 'workers', 'agent', 'package.json'), JSON.stringify({
    name: '@mfarm/agent', type: 'module',
    dependencies: Object.fromEntries(declares.map((d) => [d, '1.0.0'])),
  }));
  const install = (name) => {
    const dir = join(root, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), '');
  };
  installed.forEach(install);

  writeFileSync(join(root, 'HEAD'), have);
  writeFileSync(join(root, 'pids'), pids.join('\n') + '\n');
  if (lockRewritten) writeFileSync(join(root, 'lock-dirty'), '');

  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };

  // `git -C <root> <verb> …` — the script never calls it any other way.
  stub('git', `shift 2
case "$1" in
  fetch) exit ${fetchExit} ;;
  rev-parse) if [ "$2" = HEAD ]; then cat "${root}/HEAD"; else echo "${want}"; fi ;;
  merge) [ ${mergeExit} = 0 ] && printf '%s' "${want}" > "${root}/HEAD"; exit ${mergeExit} ;;
  diff) [ -f "${root}/lock-dirty" ] && exit 1; exit 0 ;;
  checkout) rm -f "${root}/lock-dirty" ;;
esac`);

  stub('npm', `[ ${npmExit} = 0 ] || exit ${npmExit}
${npmInstalls.map((n) => `mkdir -p "${root}/node_modules/${n}" && echo '{"name":"${n}","version":"1.0.0","main":"index.js"}' > "${root}/node_modules/${n}/package.json" && : > "${root}/node_modules/${n}/index.js"`).join('\n')}
exit 0`);

  stub('sudo', 'exec "$@"');

  // MainPID is answered from a queue, so "the pid changed while we waited" can be staged.
  stub('systemctl', `case "$1" in
  cat) exit ${hasUnit ? 0 : 1} ;;
  restart) exit 0 ;;
  is-active) echo "${state}" ;;
  show) head -1 "${root}/pids"; sed -i.bak 1d "${root}/pids" ;;
esac`);

  stub('journalctl', 'echo "THE WORKER\'S LAST LINES"');

  const run = (...args) => {
    const r = spawnSync('bash', [join(root, 'deploy', 'worker-deploy.sh'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MFARM_WORKER_SETTLE_SECONDS: '0' },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  /** Every external command the script ran, in order. */
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const at = (re) => calls().findIndex((c) => re.test(c));
  return { run, calls, at, root };
}

const RESTART = /^systemctl restart mfarm-worker/;
const INSTALL = /^npm install/;
const MERGE = /^git .* merge --ff-only/;

test('it fetches, fast-forwards, installs and only then restarts', () => {
  const h = host();
  const r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.ok(h.at(/^git .* fetch/) >= 0, 'it never fetched');
  assert.ok(h.at(/^git .* fetch/) < h.at(MERGE), 'it merged before it fetched');
  assert.ok(h.at(MERGE) < h.at(INSTALL), 'it installed before the checkout moved');
  assert.ok(h.at(INSTALL) < h.at(RESTART),
    'it restarted the worker before installing what the new code imports — D82');
  assert.match(r.out, /The worker is running bbbbbbb/);
});

test('THE REGRESSION: no restart while something the agent declares is not installed', () => {
  // The install "succeeds" and the package is still not there — a registry that served a partial
  // tree, a workspace npm did not link, an optional dependency. What matters is what Node finds.
  const h = host({ npmInstalls: [] });
  const r = h.run();
  assert.equal(r.code, 1, r.out);
  assert.equal(h.at(RESTART), -1, `it restarted the worker onto code it cannot load:\n${h.calls().join('\n')}`);
  assert.match(r.out, /Still not installed after npm install: werift/);
  assert.match(r.out, /NOT restarting/);
});

test('a failed install leaves the worker alone, and says it is still running', () => {
  const h = host({ npmExit: 1 });
  const r = h.run();
  assert.equal(r.code, 1, r.out);
  assert.equal(h.at(RESTART), -1);
  assert.match(r.out, /has NOT been restarted/);
});

test('a checkout already at main is still installed and restarted', () => {
  // Every documented call is `git pull && ./deploy/worker-deploy.sh`, so the checkout has usually
  // moved before this runs. "Nothing to fast-forward" must not become "nothing to do".
  const h = host({ have: 'bbbbbbb2' });
  const r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.equal(h.at(MERGE), -1, 'it merged a checkout that was already there');
  assert.ok(h.at(INSTALL) >= 0 && h.at(INSTALL) < h.at(RESTART));
});

test('a worker that restarts again while it is watched is reported, not called started', () => {
  // `is-active` says "active" between a crash and the next attempt. A pid that changed is the tell.
  const h = host({ pids: ['4242', '4311'] });
  const r = h.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /did not stay up/);
  assert.match(r.out, /THE WORKER'S LAST LINES/, 'it did not show the journal it told the reader to look at');
});

test('a worker that is not active is reported', () => {
  const r = host({ state: 'activating' }).run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /did not stay up/);
});

test('--check changes nothing and exits non-zero while anything is behind or missing', () => {
  const h = host();
  const r = h.run('--check');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /at aaaaaaa; origin\/main is bbbbbbb/);
  assert.match(r.out, /NOT installed: werift/);
  for (const re of [MERGE, INSTALL, RESTART]) assert.equal(h.at(re), -1, `--check ran: ${re}`);
});

test('--check exits zero on a host that is current and whole', () => {
  const r = host({ have: 'bbbbbbb2', installed: ['ws', 'werift'] }).run('--check');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /everything resolves/);
});

test('a fetch that fails stops everything: a stale origin/main is not deployed', () => {
  const h = host({ fetchExit: 1 });
  const r = h.run();
  assert.equal(r.code, 1, r.out);
  for (const re of [MERGE, INSTALL, RESTART]) assert.equal(h.at(re), -1);
});

test('a checkout that cannot fast-forward is not installed over or restarted', () => {
  const h = host({ mergeExit: 1 });
  const r = h.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Cannot fast-forward/);
  for (const re of [INSTALL, RESTART]) assert.equal(h.at(re), -1);
});

test('it refuses a machine with no worker unit, before it touches git', () => {
  const h = host({ hasUnit: false });
  const r = h.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /mfarm-deploy\.sh/, 'it did not name what the control plane uses instead');
  assert.equal(h.at(/^git/), -1);
});

test('a lockfile npm rewrote is put back, so the next fast-forward is not refused', () => {
  const h = host({ lockRewritten: true });
  const r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.ok(h.at(/^git .* checkout .*package-lock\.json/) >= 0, 'the rewritten lockfile was left modified');
});
