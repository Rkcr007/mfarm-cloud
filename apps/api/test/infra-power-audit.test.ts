/**
 * The two mechanisms underneath the Infrastructure page: the power ledger (054) and the
 * append-only operations log (053), plus the release that migration 016 never had.
 *
 * WHY THESE ARE TESTED AT THE DATABASE RATHER THAN THROUGH A ROUTE. Both are TRIGGERS and DEFINER
 * FUNCTIONS, chosen precisely so that they cannot be bypassed by a route that forgets them — so a
 * test that only ever drove them through a route would be testing the route. Every case below
 * writes to `hosts` the way the heartbeat and the reaper write to it, and asserts what the database
 * did on its own.
 *
 * THE CASE THIS FILE EXISTS FOR is the last one in the power suite: a host quiet for 100 seconds.
 * The reaper quarantines at 90; the heartbeat only moves `up_since` after 120. A host that returns
 * inside that 30-second window trips neither rule, and the first implementation of this ledger
 * recorded it as powered off, forever, while it ran and billed.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withSystem, closePools } from '../src/db.ts';

const REGION = `pwr-${randomUUID().slice(0, 8)}`;

const q = <T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string, params: unknown[] = [],
) => withSystem(async (c) => (await c.query<T>(sql, params)).rows);

async function newHost(name: string, opts: { upHoursAgo?: number; state?: string } = {}) {
  const rows = await q<{ id: string }>(
    `INSERT INTO hosts (region, hostname, state, protocol_version, up_since, last_heartbeat_at)
     VALUES ($1,$2,$3,2,$4,$4) RETURNING id`,
    [REGION, `${name}-${randomUUID().slice(0, 6)}`, opts.state ?? 'UP',
     opts.upHoursAgo === undefined ? null : new Date(Date.now() - opts.upHoursAgo * 3600_000)]);
  return rows[0].id;
}

const intervals = (hostId: string) =>
  q<{ started_at: Date; ended_at: Date | null; ended_by: string | null }>(
    'SELECT started_at, ended_at, ended_by FROM host_power_intervals WHERE host_id = $1 ORDER BY started_at',
    [hostId]);

const openOnes = async (hostId: string) =>
  (await intervals(hostId)).filter((i) => i.ended_at === null);

/** A beat, exactly as `POST /v1/workers/heartbeat` writes it — including the up_since CASE. */
const beat = (hostId: string) => q(
  `UPDATE hosts SET
     last_heartbeat_at = now(),
     up_since = CASE
       WHEN up_since IS NULL THEN now()
       WHEN last_heartbeat_at IS NULL THEN now()
       WHEN last_heartbeat_at < now() - interval '2 minutes' THEN now()
       ELSE up_since END
   WHERE id = $1`, [hostId]);

/**
 * Backdate the open interval, so a fixture can represent a host that has been up for a while.
 *
 * NEEDED BECAUSE `GREATEST(started_at, ...)` IS DOING ITS JOB. Without it, a fixture that beats and
 * then rewinds the heartbeat describes a host whose last beat predates its own power-on — which
 * cannot happen, and which the trigger correctly collapses to a zero-length interval rather than
 * writing `ended_at < started_at` and failing the heartbeat over accounting.
 */
const upFor = (hostId: string, hours: number) => q(
  `UPDATE host_power_intervals SET started_at = now() - make_interval(hours => $2)
    WHERE host_id = $1 AND ended_at IS NULL`, [hostId, hours]);

/** Rewind a host's clocks, to simulate silence without waiting for it. */
const goQuiet = (hostId: string, seconds: number) => q(
  `UPDATE hosts SET last_heartbeat_at = now() - make_interval(secs => $2) WHERE id = $1`,
  [hostId, seconds]);

before(async () => {
  await q(`INSERT INTO regions (code,name) VALUES ($1,'Power Test') ON CONFLICT (code) DO NOTHING`, [REGION]);
});

after(async () => {
  /**
   * THE ONLY WAY TO CLEAN AN APPEND-ONLY TABLE, and the fact that it takes this much is the feature.
   *
   * Migration 053's trigger refuses every DELETE, including one issued by the owner the API connects
   * as, and names the two ways past it: `DISABLE TRIGGER` and `session_replication_role`. Both are
   * deliberate acts by somebody with a prompt rather than something a bug in a route can do by
   * accident — so a fixture cleanup is exactly the shape that SHOULD have to opt in, in writing.
   *
   * BY ACTOR, not by target: these rows are written against random target ids on purpose (each has
   * to be a fresh row), so a cleanup keyed on this region's hosts left every one of them behind —
   * they turned up in the console's own events feed.
   */
  await q(`ALTER TABLE infra_operations DISABLE TRIGGER infra_operations_append_only`);
  await q(`DELETE FROM infra_operations WHERE actor_email = 'someone@example.test'`);
  await q(`ALTER TABLE infra_operations ENABLE TRIGGER infra_operations_append_only`);
  await q('DELETE FROM hosts WHERE region = $1', [REGION]);
  await q('DELETE FROM regions WHERE code = $1', [REGION]);
  await closePools();
});

describe('the power ledger', () => {
  test('a first beat opens an interval', async () => {
    const h = await newHost('first');
    await beat(h);
    const open = await openOnes(h);
    assert.equal(open.length, 1);
  });

  test('ordinary beats do not open a second one', async () => {
    const h = await newHost('steady');
    await beat(h);
    await beat(h);
    await beat(h);
    assert.equal((await intervals(h)).length, 1, 'one power-on, one interval');
  });

  test('going DOWN closes it at the LAST BEAT, not at the moment we noticed', async () => {
    const h = await newHost('stopped');
    await beat(h);
    await upFor(h, 1);                           // it had been running for an hour
    await goQuiet(h, 300);                       // it actually died five minutes ago
    await q(`UPDATE hosts SET state = 'DOWN' WHERE id = $1`, [h]);

    const [i] = await intervals(h);
    assert.ok(i.ended_at, 'interval left open after the host went down');
    assert.equal(i.ended_by, 'stopped');
    const noticedLate = Date.now() - i.ended_at!.getTime();
    assert.ok(noticedLate > 250_000,
      `ended ${Math.round(noticedLate / 1000)}s ago; it should be ~300, not ~0 — billing the `
      + 'minutes the control plane took to notice is the error this guards');
  });

  test('a REAPER quarantine closes it, and calls the gap silence', async () => {
    const h = await newHost('silent');
    await beat(h);
    await upFor(h, 1);
    await goQuiet(h, 120);
    await q('SELECT quarantine_host($1, $2, $3)', [h, 'no heartbeat for 90s', 'reaper']);

    const [i] = await intervals(h);
    assert.equal(i.ended_by, 'silence');
    assert.ok(i.ended_at);
  });

  test('an OPERATOR quarantine does NOT — a drained host is switched on and still costing money',
    async () => {
      const h = await newHost('drained');
      await beat(h);
      await q('SELECT quarantine_host($1, $2, $3)', [h, 'maintenance', 'operator']);

      const open = await openOnes(h);
      assert.equal(open.length, 1,
        'draining a host stopped its meter; the cost page would then look best on its worst day');
    });

  test('THE 100-SECOND GAP: quiet past the reaper, back before up_since moves', async () => {
    const h = await newHost('flapper');
    await beat(h);
    await upFor(h, 1);

    // The reaper acts at 90 seconds and closes the interval.
    await goQuiet(h, 100);
    await q('SELECT quarantine_host($1, $2, $3)', [h, 'no heartbeat for 90s', 'reaper']);
    assert.equal((await openOnes(h)).length, 0, 'precondition: the reaper closed it');

    // The host returns at 100 seconds. The heartbeat's own rule leaves `up_since` alone, because
    // the gap is under two minutes — so nothing about a restart is signalled.
    await beat(h);

    const open = await openOnes(h);
    assert.equal(open.length, 1,
      'the host is running and billing, and the ledger had it switched off forever');
    // It resumes AT THE BEAT rather than at the original power-on, so the silent gap is not
    // re-billed on the way back.
    assert.ok(Date.now() - open[0].started_at.getTime() < 10_000);
  });

  test('a restart after a long silence closes the old interval and opens a new one', async () => {
    const h = await newHost('rebooted');
    await beat(h);
    await upFor(h, 1);
    await goQuiet(h, 600);
    await beat(h);                                // gap > 2 minutes, so up_since moves

    const all = await intervals(h);
    assert.equal(all.length, 2);
    assert.equal(all[0].ended_by, 'restarted');
    assert.equal(all[1].ended_at, null);
  });

  test('there is never more than one open interval — the constraint, not the convention', async () => {
    const h = await newHost('dup');
    await beat(h);
    await assert.rejects(
      () => q('INSERT INTO host_power_intervals (host_id, started_at) VALUES ($1, now())', [h]),
      /host_power_intervals_open_idx|duplicate key/,
      'two open intervals would double every cost computed from this table, silently');
  });
});

describe('releasing an operator quarantine', () => {
  test('it restores exactly the devices the drain withdrew', async () => {
    const h = await newHost('drain-release');
    const mk = async (state: string) => (await q<{ id: string }>(
      `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, capabilities)
       VALUES ($1,$2,'android','cuttlefish','Pixel Test','14',$3,'{}') RETURNING id`,
      [h, REGION, state]))[0].id;

    const ready = await mk('READY');
    const busy = await mk('SESSION_ACTIVE');
    // Quarantined in its OWN right, before the drain. `quarantined_from` stays NULL for it.
    const sick = await mk('QUARANTINED');

    await q('SELECT quarantine_host($1, $2, $3)', [h, 'maintenance window', 'operator']);
    const n = (await q<{ n: number }>('SELECT release_host_quarantine($1) AS n', [h]))[0].n;
    assert.equal(Number(n), 1, 'one device withdrawn, one restored');

    const states = Object.fromEntries((await q<{ id: string; state: string }>(
      'SELECT id, state::text AS state FROM devices WHERE host_id = $1', [h]))
      .map((d) => [d.id, d.state]));

    assert.equal(states[ready], 'READY', 'the drained device came back');
    assert.equal(states[busy], 'SESSION_ACTIVE', 'a tenant mid-session was never evicted');
    assert.equal(states[sick], 'QUARANTINED',
      'un-draining a host laundered a sick device back into the pool');

    const host = (await q<{ state: string; quarantine_source: string | null }>(
      'SELECT state::text AS state, quarantine_source FROM hosts WHERE id = $1', [h]))[0];
    assert.equal(host.state, 'UP');
    assert.equal(host.quarantine_source, null);
  });

  test('it REFUSES a reaper quarantine — declaring a silent host healthy does not make packets arrive',
    async () => {
      const h = await newHost('silent-release');
      await q('SELECT quarantine_host($1, $2, $3)', [h, 'no heartbeat for 90s', 'reaper']);
      const n = (await q<{ n: number }>('SELECT release_host_quarantine($1) AS n', [h]))[0].n;
      assert.equal(Number(n), -1);
      const state = (await q<{ state: string }>('SELECT state::text AS state FROM hosts WHERE id = $1', [h]))[0].state;
      assert.equal(state, 'QUARANTINED');
    });

  test('-1 and 0 are different answers', async () => {
    const h = await newHost('empty-drain');
    // Drained with no devices to withdraw: a real outcome, and NOT "there was nothing to release".
    await q('SELECT quarantine_host($1, $2, $3)', [h, 'maintenance', 'operator']);
    assert.equal(Number((await q<{ n: number }>('SELECT release_host_quarantine($1) AS n', [h]))[0].n), 0);
    // Now there genuinely is nothing to release.
    assert.equal(Number((await q<{ n: number }>('SELECT release_host_quarantine($1) AS n', [h]))[0].n), -1);
  });
});

describe('the operations log is append-only, and the database is what enforces it', () => {
  const insert = (result = 'accepted') => q<{ id: string }>(
    `INSERT INTO infra_operations (actor_email, action, target_kind, target_id, target_label, result)
     VALUES ('someone@example.test', 'drain', 'host', $1, 'a-host', $2) RETURNING id`,
    [randomUUID(), result]);

  test('an outcome may be written once', async () => {
    const [{ id }] = await insert();
    await q(`UPDATE infra_operations SET result = 'succeeded', finished_at = now() WHERE id = $1`, [id]);
    const [row] = await q<{ result: string }>('SELECT result FROM infra_operations WHERE id = $1', [id]);
    assert.equal(row.result, 'succeeded');
  });

  test('...and not twice', async () => {
    const [{ id }] = await insert();
    await q(`UPDATE infra_operations SET result = 'failed' WHERE id = $1`, [id]);
    await assert.rejects(
      () => q(`UPDATE infra_operations SET result = 'succeeded' WHERE id = $1`, [id]),
      /already settled/);
  });

  test('a settled row cannot be walked back to accepted', async () => {
    const [{ id }] = await insert();
    await q(`UPDATE infra_operations SET result = 'noop' WHERE id = $1`, [id]);
    await assert.rejects(
      () => q(`UPDATE infra_operations SET result = 'accepted' WHERE id = $1`, [id]),
      /already settled|only be updated to a settled result/);
  });

  test('WHO DID IT cannot be edited, even by the owner the API connects as', async () => {
    const [{ id }] = await insert();
    await assert.rejects(
      () => q(`UPDATE infra_operations SET actor_email = 'someone-else@example.test',
                      result = 'succeeded' WHERE id = $1`, [id]),
      /immutable apart from its outcome/);
  });

  test('rows are never deleted', async () => {
    const [{ id }] = await insert();
    await assert.rejects(
      () => q('DELETE FROM infra_operations WHERE id = $1', [id]),
      /append-only/);
  });

  /* -------------------------------------------------- migration 055: the in-flight progress note */

  test('AN OPEN ROW MAY SAY WHERE IT GOT TO, without claiming an outcome', async () => {
    const [{ id }] = await insert();
    await q(`UPDATE infra_operations SET detail = 'last seen STAGING after 25s' WHERE id = $1`, [id]);
    const [row] = await q<{ result: string; detail: string; finished_at: Date | null }>(
      'SELECT result, detail, finished_at FROM infra_operations WHERE id = $1', [id]);
    assert.equal(row.result, 'accepted', 'a progress note settled the row');
    assert.equal(row.detail, 'last seen STAGING after 25s');
    assert.equal(row.finished_at, null);
  });

  test('...and may then still settle, once', async () => {
    const [{ id }] = await insert();
    await q(`UPDATE infra_operations SET detail = 'still starting' WHERE id = $1`, [id]);
    await q(`UPDATE infra_operations SET result = 'succeeded', finished_at = now() WHERE id = $1`, [id]);
    await assert.rejects(
      () => q(`UPDATE infra_operations SET result = 'failed' WHERE id = $1`, [id]),
      /already settled/);
  });

  test('an open row cannot be given a finish time while it is still open', async () => {
    const [{ id }] = await insert();
    await assert.rejects(
      () => q(`UPDATE infra_operations SET finished_at = now() WHERE id = $1`, [id]),
      /still accepted, so it cannot have finished/,
      'an unfinished operation could claim a duration, which every "how long did that take" query '
      + 'would then get wrong in the direction of looking complete');
  });

  test('a progress note still cannot rewrite who did it', async () => {
    const [{ id }] = await insert();
    await assert.rejects(
      () => q(`UPDATE infra_operations SET actor_email = 'someone-else@example.test',
                      detail = 'still starting' WHERE id = $1`, [id]),
      /immutable apart from its outcome/);
  });

  test('`unknown` is a settled outcome in its own right, not a flavour of failure', async () => {
    const [{ id }] = await insert();
    await q(`UPDATE infra_operations SET result = 'unknown',
               detail = 'The provider stopped answering.' WHERE id = $1`, [id]);
    const [row] = await q<{ result: string }>('SELECT result FROM infra_operations WHERE id = $1', [id]);
    assert.equal(row.result, 'unknown');
    // And it cannot then decay into a failure, which is how somebody ends up pressing Start on a
    // machine that is already starting.
    await assert.rejects(
      () => q(`UPDATE infra_operations SET result = 'failed' WHERE id = $1`, [id]),
      /already settled/);
  });
});
