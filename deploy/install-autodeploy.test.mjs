/**
 * Who is allowed to install the auto-deploy timer.
 *
 * WHY THIS FILE EXISTS, WRITTEN AFTER THE FACT. The first version of the installer guarded on
 * `deploy/.state/api_key`, on the premise that only a control plane has deploy state. **`mfarm-lab`
 * has had that file since 2026-08-18.** Run on the lab, the guard passed and the installer wrote
 * both units onto the DEVICE HOST — the one machine whose checkout must not be fast-forwarded
 * unattended, because the worker and the boot unit both `ExecStart` out of that tree.
 *
 * It shipped with no test at all, and it was caught by running it on the real lab. That is the
 * sixth-plus instance of `docs/DEFECTS.md`'s oldest family: a control whose premise is false in the
 * state it is offered in.
 *
 * A test cannot know what files a particular VM happens to have — which is exactly why the guard
 * must not depend on one. What it CAN pin is that the installer asks `mfarm_is_device_host`, the
 * repo's single answer to that question, and honours it. So this drives the real
 * `mfarm_is_device_host` against fabricated deploy directories, and then drives the installer
 * itself against a tree that looks like a device host.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));
const lib = join(SRC, 'deploy', 'lib', 'host-role.sh');

/** `mfarm_is_device_host <deployDir> <kvmPath>` — exit 0 means yes. */
function isDeviceHost(deployDir, kvm) {
  try {
    execFileSync('bash', ['-c',
      `set -u; . "$1"; mfarm_is_device_host "$2" "$3"`, 'bash', lib, deployDir, kvm]);
    return true;
  } catch { return false; }
}

/** A deploy dir with the given worker.env contents, plus whatever else a caller wants. */
function deployDir({ controlPlaneUrl, apiKey = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mfarm-role-'));
  mkdirSync(join(root, '.state'), { recursive: true });
  if (controlPlaneUrl) {
    writeFileSync(join(root, '.state', 'worker.env'), `CONTROL_PLANE_URL=${controlPlaneUrl}\n`);
  }
  // THE FILE THE BROKEN GUARD KEYED ON. Present by default here precisely because it is present on
  // the real lab: a fixture that omitted it would agree with the bug.
  if (apiKey) writeFileSync(join(root, '.state', 'api_key'), 'k');
  return root;
}

/** Something that exists, standing in for /dev/kvm. */
const KVM = () => {
  const d = mkdtempSync(join(tmpdir(), 'mfarm-kvm-'));
  const f = join(d, 'kvm');
  writeFileSync(f, '');
  return f;
};

describe('mfarm_is_device_host', () => {
  test('a box with kvm pointed at a remote control plane is a device host', () => {
    assert.equal(isDeviceHost(deployDir({ controlPlaneUrl: 'https://farm.mfarm.dev' }), KVM()), true);
  });

  /**
   * THE ASSERTION THE SHIPPED GUARD WOULD HAVE FAILED. The real lab has an `api_key`; a guard that
   * reads "has deploy state, therefore control plane" says no here and is wrong.
   */
  test('and still is when it also has an api_key, which the real lab does', () => {
    const d = deployDir({ controlPlaneUrl: 'https://farm.mfarm.dev', apiKey: true });
    assert.equal(isDeviceHost(d, KVM()), true,
      'deploy state does not make a box a control plane — mfarm-lab has had api_key since 2026-08-18');
  });

  test('a control plane running its own API is not a device host', () => {
    assert.equal(isDeviceHost(deployDir({ controlPlaneUrl: 'http://127.0.0.1:3000' }), KVM()), false);
    assert.equal(isDeviceHost(deployDir({ controlPlaneUrl: 'http://localhost:3000' }), KVM()), false);
  });

  test('no kvm means no devices, whatever the url says', () => {
    assert.equal(isDeviceHost(deployDir({ controlPlaneUrl: 'https://farm.mfarm.dev' }),
      '/definitely/no/such/kvm'), false);
  });

  test('no control-plane url at all is not a device host', () => {
    assert.equal(isDeviceHost(deployDir({}), KVM()), false);
  });
});

describe('install-autodeploy-service.sh', () => {
  /** A checkout that looks like a device host, with the installer in it. */
  function labTree() {
    const root = mkdtempSync(join(tmpdir(), 'mfarm-lab-'));
    mkdirSync(join(root, 'deploy', 'lib'), { recursive: true });
    for (const f of ['install-autodeploy-service.sh', 'lib/host-role.sh']) {
      cpSync(join(SRC, 'deploy', f), join(root, 'deploy', f));
    }
    mkdirSync(join(root, 'deploy', '.state'), { recursive: true });
    writeFileSync(join(root, 'deploy', '.state', 'worker.env'), 'CONTROL_PLANE_URL=https://farm.mfarm.dev\n');
    writeFileSync(join(root, 'deploy', '.state', 'api_key'), 'k');
    execFileSync('chmod', ['+x', join(root, 'deploy', 'install-autodeploy-service.sh')]);
    return root;
  }

  /**
   * MFARM_KVM_PATH stands in for /dev/kvm, which exists on neither a developer's machine nor a CI
   * runner. Without that seam the device-host branch is unreachable by any test — which is exactly
   * how a guard that never worked came to ship.
   */
  const run = (root, args = '', kvm = KVM()) => {
    try {
      return { code: 0, out: execFileSync('bash', ['-c',
        `MFARM_KVM_PATH="${kvm}" "${root}/deploy/install-autodeploy-service.sh" ${args} 2>&1`],
        { encoding: 'utf8' }) };
    } catch (e) { return { code: e.status, out: (e.stdout ?? '') + (e.stderr ?? '') }; }
  };

  /**
   * THE REGRESSION. It must refuse BEFORE it needs sudo, so this test is meaningful on a machine
   * where sudo would prompt — and so the refusal is the first thing the installer does rather than
   * something it gets around to after writing a unit file.
   */
  test('refuses a device host, and refuses it before touching systemd', () => {
    const r = run(labTree());
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /DEVICE HOST/);
    assert.doesNotMatch(r.out, /installed mfarm-autodeploy/,
      'it installed units on a device host — the exact bug this file exists for');
  });

  test('and names the by-hand path instead of just saying no', () => {
    const r = run(labTree());
    assert.match(r.out, /merge --ff-only/);
    assert.match(r.out, /systemctl restart mfarm-worker/);
  });
});
