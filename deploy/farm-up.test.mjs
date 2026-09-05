/**
 * `farm-up.sh` RUNS ON TWO KINDS OF MACHINE, and only one of them owns a control plane.
 *
 * WHY THIS FILE EXISTS. The device host's boot unit failed on every boot from 3 to 5 September,
 * exiting in one second on "BACKUP_BUCKET is empty" — a control-plane backup policy that a machine
 * with no database has no business having an opinion about. Nothing surfaced it, because the
 * devices come up anyway from a separate worker unit, so a permanently failing boot unit looked
 * exactly like a working farm.
 *
 * It is tested by READING THE SCRIPT rather than by running it: running it starts Postgres, mints
 * secrets and boots Cuttlefish. What can be checked cheaply is the thing that was actually wrong —
 * the ORDER of the guard against the load of the variable it reads.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'farm-up.sh'), 'utf8');
const lines = script.split('\n');
const lineOf = (re) => lines.findIndex((l) => re.test(l));

describe('farm-up.sh knows which machine it is on', () => {
  test('a device host is detected and stops before the control-plane work', () => {
    const guard = lineOf(/^if \[ -e \/dev\/kvm \] && \[ -n "\$\{CONTROL_PLANE_URL:-\}" \]/);
    assert.ok(guard > 0, 'the device-host guard is gone');

    const backup = lineOf(/BACKUP_BUCKET:-\}" \] \|\| die/);
    assert.ok(backup > 0, 'the backup preflight is gone');
    assert.ok(guard < backup,
      'a device host must stop BEFORE the control plane\'s backup policy, which is not its decision');
  });

  /**
   * THE MISTAKE THIS ALMOST SHIPPED AS. The first version of the guard sat above `. "$ENV_FILE"`
   * and read `CONTROL_PLANE_URL` before anything had defined it, so it could never fire — a guard
   * placed where it cannot see its own subject is the same defect it was written to fix.
   */
  test('the guard reads a variable the env file has already defined', () => {
    const sourced = lineOf(/^set -a; \. "\$ENV_FILE"; set \+a/);
    const guard = lineOf(/^if \[ -e \/dev\/kvm \] && \[ -n "\$\{CONTROL_PLANE_URL:-\}" \]/);
    assert.ok(sourced > 0, 'the env file is no longer sourced here');
    assert.ok(sourced < guard,
      'CONTROL_PLANE_URL comes from the env file; a guard above the source line always sees empty');
  });

  /**
   * And the control-plane host keeps ITS exit, which is the mirror of this one. Two machines, two
   * early exits, one discriminator — `/dev/kvm` — so they cannot disagree about which is which.
   */
  test('the control-plane host still has its own early exit', () => {
    assert.match(script, /if \[ ! -e \/dev\/kvm \]/,
      'a machine with no kvm must still stop before trying to boot devices');
  });
});
