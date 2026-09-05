/**
 * WHICH MACHINE IS THIS, and does the answer survive being executed?
 *
 * WHY THIS FILE WAS REWRITTEN. Its first version asserted that the device-host guard appeared on a
 * LINE BELOW `. "$ENV_FILE"`. That was true, stayed true, and meant nothing: the variable the guard
 * reads — CONTROL_PLANE_URL — is not in that env file and never has been. install-worker-service.sh
 * writes it to deploy/.state/worker.env, the WORKER unit's EnvironmentFile. So the guard could not
 * fire on the only machine it exists for, the boot unit went on failing on every boot, and a green
 * test said the fix had landed. It was verified by reading, which is what a line-order assertion
 * is, and the lab disagreed the moment anyone watched a boot.
 *
 * So these tests RUN the decision. deploy/lib/host-role.sh takes the deploy directory and the kvm
 * node as arguments precisely so a test can put real files behind it on a machine with no /dev/kvm.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, 'lib', 'host-role.sh');

/** A deploy/ directory: always an .env, and a worker.env only when a worker was installed. */
function deployDir({ workerEnv = null, env = 'POSTGRES_USER=mfarm\nBACKUP_BUCKET=\n' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mfarm-role-'));
  writeFileSync(join(dir, '.env'), env);
  if (workerEnv !== null) {
    mkdirSync(join(dir, '.state'), { recursive: true });
    writeFileSync(join(dir, '.state', 'worker.env'), workerEnv);
  }
  return dir;
}

/** A file standing in for /dev/kvm, or a path that does not exist. */
function kvmNode(dir, present) {
  const p = join(dir, 'kvm');
  if (present) writeFileSync(p, '');
  return p;
}

function isDeviceHost(dir, { kvm = true, exported = null } = {}) {
  const out = execFileSync('bash', ['-c',
    `set -euo pipefail; . "$1"; if mfarm_is_device_host "$2" "$3"; then echo yes; else echo no; fi`,
    'bash', lib, dir, kvmNode(dir, kvm),
  ], { encoding: 'utf8', env: exported === null ? process.env : { ...process.env, CONTROL_PLANE_URL: exported } });
  return out.trim() === 'yes';
}

describe('a device host is the machine whose control plane is somewhere else', () => {
  /**
   * THE DEFECT THIS FILE EXISTS FOR, as a test. The lab's deploy/.env has no CONTROL_PLANE_URL —
   * these are its real keys — and its worker.env has the real value. The shipped guard read only
   * the first file and answered "not a device host" on a device host.
   */
  test('the URL is found in worker.env, which is where it is actually written', () => {
    const dir = deployDir({
      env: 'POSTGRES_USER=mfarm\nPOSTGRES_PASSWORD=x\nAPP_DB_PASSWORD=y\nAPI_PORT=3000\n',
      workerEnv: 'REGION=lab\nCONTROL_PLANE_URL=https://34-100-138-213.sslip.io\nCF_INSTANCES=2\n',
    });
    assert.equal(isDeviceHost(dir), true,
      'the lab is a device host; a guard that reads only deploy/.env cannot see that');
  });

  test('a single-host farm keeps its control plane — loopback is not somewhere else', () => {
    for (const url of ['http://127.0.0.1:3000', 'http://localhost:3000', 'http://[::1]:3000']) {
      const dir = deployDir({ workerEnv: `CONTROL_PLANE_URL=${url}\n` });
      assert.equal(isDeviceHost(dir), false, `${url} is this machine, so it still owns the backups`);
    }
  });

  test('a machine with no worker installed is not a device host', () => {
    assert.equal(isDeviceHost(deployDir()), false);
  });

  test('a control plane has no /dev/kvm, whatever any file says', () => {
    const dir = deployDir({ workerEnv: 'CONTROL_PLANE_URL=https://farm.mfarm.dev\n' });
    assert.equal(isDeviceHost(dir, { kvm: false }), false);
  });

  test('an exported CONTROL_PLANE_URL overrides the file, so a human can force it from a shell', () => {
    const dir = deployDir({ workerEnv: 'CONTROL_PLANE_URL=http://127.0.0.1:3000\n' });
    assert.equal(isDeviceHost(dir, { exported: 'https://farm.mfarm.dev' }), true);
  });

  test('a repeated key resolves the way systemd EnvironmentFile resolves it — last wins', () => {
    const dir = deployDir({
      workerEnv: 'CONTROL_PLANE_URL=http://127.0.0.1:3000\nCONTROL_PLANE_URL=https://farm.mfarm.dev\n',
    });
    assert.equal(isDeviceHost(dir), true);
  });
});

describe('farm-up.sh asks before it decides anything for a control plane', () => {
  const script = readFileSync(join(here, 'farm-up.sh'), 'utf8');
  const lines = script.split('\n');
  const lineOf = (re) => lines.findIndex((l) => re.test(l));

  test('the device-host exit comes before the backup policy it used to die on', () => {
    const guard = lineOf(/^if mfarm_is_device_host /);
    const backup = lineOf(/BACKUP_BUCKET:-\}" \] \|\| die/);
    assert.ok(guard > 0, 'the device-host guard is gone');
    assert.ok(backup > 0, 'the backup preflight is gone');
    assert.ok(guard < backup,
      "a device host must stop BEFORE the control plane's backup policy, which is not its decision");
  });

  test('the control-plane host still has its own early exit', () => {
    assert.match(script, /if \[ ! -e \/dev\/kvm \]/,
      'a machine with no kvm must still stop before trying to boot devices');
  });
});
