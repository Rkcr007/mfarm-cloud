/**
 * SECURITY DEFINER functions: who owns them, and who may call them.
 *
 * WHY THIS EXISTS AS A TEST AND NOT ONLY AS A CI STEP. `ci.yml` has asserted both of these since it
 * was written, and it is the only place they were asserted — so `npm test` could be green on a
 * change that made a fleet-wide definer function callable by every role, and the first sign of it
 * was a red X several minutes after a push.
 *
 * That is exactly what happened on 2026-09-04. Migration 037 replaced `allocate_device` to add the
 * device-class predicate, granted EXECUTE to `mfarm_app`, and did not revoke PUBLIC — because a
 * DROP-and-CREATE does not inherit the previous function's ACL, and Postgres grants EXECUTE to
 * PUBLIC on every new function. Migration 012 had made that revoke for the old signature and said
 * why; dropping the function threw it away. The local suite could not see it.
 *
 * A guard that only exists in CI costs a round trip every time somebody trips it, and teaches
 * people that green locally means nothing. This is the same two assertions, where they can fail in
 * two seconds.
 *
 * DERIVED FROM THE CATALOG, never from a list of function names. A list is a thing somebody has to
 * remember to update, and the failure it is guarding against arrives precisely as a function nobody
 * remembered.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { withSystem, closePools } from '../src/db.ts';

after(async () => { await closePools(); });

interface DefinerRow {
  fn: string;
  owner: string;
  owner_is_super: boolean;
  public_can_execute: boolean;
}

const definers = () => withSystem(async (c) => {
  const { rows } = await c.query<DefinerRow>(
    `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS fn,
            pg_get_userbyid(p.proowner)                                        AS owner,
            (SELECT rolsuper FROM pg_roles WHERE oid = p.proowner)             AS owner_is_super,
            has_function_privilege('public', p.oid, 'EXECUTE')                 AS public_can_execute
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
      ORDER BY 1`,
  );
  return rows;
});

describe('SECURITY DEFINER functions', () => {
  test('the fleet has some, so this test is not passing on an empty set', async () => {
    const rows = await definers();
    assert.ok(rows.length >= 5, `expected several definer functions, found ${rows.length}`);
  });

  /**
   * A definer function executes as its OWNER. One owned by the cluster superuser turns every call
   * into a superuser call, which is the opposite of what SECURITY DEFINER is for here: migration
   * 012 created `mfarm_definer` precisely so that the privilege these functions carry is the
   * narrow one they need and not the whole cluster.
   */
  test('none is owned by a superuser', async () => {
    const bad = (await definers()).filter((r) => r.owner_is_super);
    assert.deepEqual(
      bad.map((r) => `${r.fn} owned by ${r.owner}`), [],
      'a definer function owned by a superuser executes as one',
    );
  });

  /**
   * EXECUTE IS GRANTED TO PUBLIC ON EVERY NEW FUNCTION. That is the default, it is silent, and it
   * makes every explicit grant beside it decorative — the app pool could already call the function,
   * and so could anything else that can reach the database.
   *
   * It bites hardest on a REPLACEMENT: `CREATE OR REPLACE` keeps the existing ACL, but a
   * DROP-then-CREATE — which is what a signature change requires — does not, so a revoke made years
   * ago silently stops applying the day somebody adds a parameter.
   */
  test('none is EXECUTE-able by PUBLIC', async () => {
    const bad = (await definers()).filter((r) => r.public_can_execute);
    assert.deepEqual(
      bad.map((r) => r.fn), [],
      'REVOKE EXECUTE ... FROM PUBLIC in the migration that created it — see 012 and 037',
    );
  });

  /**
   * The fleet-wide mutations, specifically. RLS says nothing about a definer function: it runs as
   * its owner, so the only thing standing between a tenant-scoped pool and a fleet-wide write is
   * the EXECUTE grant. These are called on the system pool and must be unreachable from the app
   * pool even though `mfarm_app` is a legitimate, non-superuser role.
   */
  test('the fleet-wide ones are unreachable from the app pool', async () => {
    const fleetWide = ['expire_sessions', 'promote_queued', 'quarantine_host', 'record_metering'];
    const rows = await withSystem(async (c) => {
      const { rows } = await c.query<{ fn: string; app_can_execute: boolean }>(
        `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS fn,
                has_function_privilege('mfarm_app', p.oid, 'EXECUTE')                AS app_can_execute
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.prosecdef AND p.proname = ANY($1)`,
        [fleetWide],
      );
      return rows;
    });

    assert.ok(rows.length > 0, 'none of the fleet-wide functions exist — has the schema moved?');
    assert.deepEqual(
      rows.filter((r) => r.app_can_execute).map((r) => r.fn), [],
      'these are called on the system pool; the app pool must not reach them',
    );
  });

  /**
   * And the tenant-facing one IS reachable, which is the assertion that proves the three above are
   * measuring something rather than describing a database where nothing is granted at all.
   */
  test('the tenant-facing allocator IS reachable from the app pool', async () => {
    const [row] = await withSystem(async (c) => {
      const { rows } = await c.query<{ ok: boolean }>(
        `SELECT has_function_privilege('mfarm_app', p.oid, 'EXECUTE') AS ok
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'allocate_device'`,
      );
      return rows;
    });
    assert.ok(row?.ok, 'the app pool allocates devices; without this grant every session 500s');
  });
});
