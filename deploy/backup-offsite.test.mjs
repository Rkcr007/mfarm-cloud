// backup-offsite.sh, against a fake bucket.
//
// The script itself is twenty lines of logic wrapped around one external tool, and every one of its
// failure modes is a case where it must NOT write the receipt — because the receipt is what the
// alert reads, and a receipt written on a bad day is worse than no off-box backup at all. It would
// report the farm as recoverable while the bucket holds a truncated archive.
//
// `gcloud` is stubbed with a shell script on PATH that models a bucket as a directory. That is
// enough to exercise every branch: upload, existence, reported size. What it cannot cover is IAM
// and the real API, which is what `DRILL_BUCKET=... deploy/restore-drill.sh` is for.
//
//   node --test deploy/backup-offsite.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'backup-offsite.sh');

/**
 * A fake `gcloud storage` whose bucket is a directory.
 *
 * `truncateTo` makes `ls -l` report a size that disagrees with the object on disk, which is the
 * only way to simulate the failure the size check exists for — a transfer that left a plausible
 * name behind. Every invocation is logged so a test can assert what was NOT called.
 */
function fakeGcloud(root, { truncateTo = null, failUpload = false } = {}) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const bucket = join(root, 'bucket');
  mkdirSync(bucket, { recursive: true });
  const log = join(root, 'gcloud.log');

  writeFileSync(join(bin, 'gcloud'), `#!/bin/sh
echo "$@" >> ${log}
[ "$1" = storage ] || exit 1
shift
case "$1" in
  cp)
    shift
    ${failUpload ? 'echo "AccessDeniedException" >&2; exit 1' : ''}
    # everything but the last argument is a source
    LAST=""
    for a in "$@"; do LAST="$a"; done
    for a in "$@"; do
      [ "$a" = "$LAST" ] && continue
      [ "$a" = "-n" ] && continue
      DEST="${bucket}/$(basename "$a")"
      if [ ! -f "$DEST" ]; then cp "$a" "$DEST"; echo "Copying $a"; fi
    done
    ;;
  ls)
    shift
    [ "$1" = "-l" ] && shift
    NAME="$(basename "$1")"
    [ -f "${bucket}/$NAME" ] || exit 1
    ${truncateTo === null ? 'echo "$(wc -c < "' + bucket + '/$NAME" | tr -d " ") 2026-01-01T00:00:00Z $1"'
                          : `echo "${truncateTo} 2026-01-01T00:00:00Z $1"`}
    ;;
  *) exit 1 ;;
esac
`);
  chmodSync(join(bin, 'gcloud'), 0o755);
  return { bin, bucket, calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

/**
 * A backup directory holding `pairs` complete backups, newest last.
 *
 * MTIMES ARE SET EXPLICITLY, one minute apart, and that is not decoration. The script picks the
 * newest with `ls -1t`, which orders by mtime and breaks ties in a way that is not specified — so
 * files written in the same filesystem timestamp tick can come back in any order. Writing them in
 * a loop is fast enough to land in one tick on a fast disk: this test passed locally and failed on
 * CI, naming the OLDEST backup. The fixture was wrong, not the script, and a fixture that depends
 * on how long a write takes will lie again.
 */
function seedBackups(root, pairs, { orphanDump = false } = {}) {
  const dir = join(root, 'backups');
  mkdirSync(dir, { recursive: true });
  const names = [];
  const base = Date.now() - 86_400_000;
  const age = (i) => new Date(base + i * 60_000);
  for (let i = 0; i < pairs; i++) {
    const stamp = `2026010${i + 1}T000000Z`;
    const dump = join(dir, `mfarm-${stamp}.dump`);
    const globals = join(dir, `mfarm-${stamp}.globals.sql`);
    writeFileSync(dump, `dump-${i}`.repeat(100));
    writeFileSync(globals, 'CREATE ROLE mfarm_app;');
    utimesSync(dump, age(i), age(i));
    utimesSync(globals, age(i), age(i));
    names.push(`mfarm-${stamp}.dump`);
  }
  if (orphanDump) {
    // Newest by mtime, but with no companion roles file. Restoring it into a fresh cluster would
    // die on the first GRANT, so it is not a backup and must not be what the receipt names.
    const orphan = join(dir, 'mfarm-29991231T000000Z.dump');
    writeFileSync(orphan, 'orphan');
    utimesSync(orphan, age(pairs + 10), age(pairs + 10));
    names.push('mfarm-29991231T000000Z.dump');
  }
  return { dir, names };
}

function run(env, { bin } = {}) {
  try {
    const out = execFileSync('sh', [SCRIPT], {
      env: { ...process.env, PATH: bin ? `${bin}:${process.env.PATH}` : process.env.PATH, ...env },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'offsite-'));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('a confirmed upload writes a receipt naming the newest backup', () => {
  const root = workspace();
  const { dir, names } = seedBackups(root, 3);
  const g = fakeGcloud(root);

  const r = run({ BACKUP_DIR: dir, BACKUP_BUCKET: 'gs://b' }, g);
  assert.equal(r.code, 0, r.out);

  const receipt = JSON.parse(readFileSync(join(dir, '.offsite-receipt'), 'utf8'));
  assert.equal(receipt.newest, names.at(-1));
  assert.equal(receipt.bucket, 'gs://b');
  assert.ok(receipt.bytes > 0);
});

test('every backup goes up, not only the newest', () => {
  // The newest is what the receipt CONFIRMS, but a bucket holding only the last six hours is not a
  // backup story. `cp -n` makes the older ones free after the first run.
  const root = workspace();
  const { dir } = seedBackups(root, 3);
  const g = fakeGcloud(root);
  run({ BACKUP_DIR: dir, BACKUP_BUCKET: 'gs://b' }, g);
  for (let i = 1; i <= 3; i++) {
    assert.ok(existsSync(join(g.bucket, `mfarm-2026010${i}T000000Z.dump`)), `pair ${i} is in the bucket`);
    assert.ok(existsSync(join(g.bucket, `mfarm-2026010${i}T000000Z.globals.sql`)), `roles ${i} are in the bucket`);
  }
});

test('a truncated remote copy is refused, and leaves no receipt', () => {
  const root = workspace();
  const { dir } = seedBackups(root, 1);
  const g = fakeGcloud(root, { truncateTo: 12 });

  const r = run({ BACKUP_DIR: dir, BACKUP_BUCKET: 'gs://b' }, g);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /truncated/);
  assert.ok(!existsSync(join(dir, '.offsite-receipt')),
    'a receipt here would report the farm recoverable from an archive that is not');
});

test('a failed upload is refused, and leaves no receipt', () => {
  const root = workspace();
  const { dir } = seedBackups(root, 1);
  const g = fakeGcloud(root, { failUpload: true });

  const r = run({ BACKUP_DIR: dir, BACKUP_BUCKET: 'gs://b' }, g);
  assert.notEqual(r.code, 0);
  assert.ok(!existsSync(join(dir, '.offsite-receipt')));
});

test('a stale receipt is not refreshed when the newest backup fails to land', () => {
  // The alert reads mtime, so refreshing the receipt on a run that could not confirm the newest
  // dump would convert a real outage into a permanently green dashboard.
  const root = workspace();
  const { dir } = seedBackups(root, 1);
  const ok = fakeGcloud(root);
  run({ BACKUP_DIR: dir, BACKUP_BUCKET: 'gs://b' }, ok);
  const first = readFileSync(join(dir, '.offsite-receipt'), 'utf8');

  // A newer backup appears and the bucket starts refusing writes. Explicit mtimes for the same
  // reason as in seedBackups: `ls -1t` must see this as unambiguously the newest.
  const newer = new Date();
  for (const [f, body] of [['mfarm-20260202T000000Z.dump', 'newer'.repeat(100)],
                           ['mfarm-20260202T000000Z.globals.sql', 'CREATE ROLE mfarm_app;']]) {
    writeFileSync(join(dir, f), body);
    utimesSync(join(dir, f), newer, newer);
  }
  const broken = fakeGcloud(root, { failUpload: true });

  const r = run({ BACKUP_DIR: dir, BACKUP_BUCKET: 'gs://b' }, broken);
  assert.notEqual(r.code, 0);
  assert.equal(readFileSync(join(dir, '.offsite-receipt'), 'utf8'), first,
    'the receipt must still name the OLD backup, so its mtime goes stale and pages');
});

test('a dump with no roles file is not treated as the newest backup', () => {
  const root = workspace();
  const { dir } = seedBackups(root, 1, { orphanDump: true });
  const g = fakeGcloud(root);

  const r = run({ BACKUP_DIR: dir, BACKUP_BUCKET: 'gs://b' }, g);
  assert.equal(r.code, 0, r.out);
  const receipt = JSON.parse(readFileSync(join(dir, '.offsite-receipt'), 'utf8'));
  assert.equal(receipt.newest, 'mfarm-20260101T000000Z.dump',
    'a dump without its roles dies on the first GRANT; the pair is the unit, not the file');
});

test('nothing is ever deleted from the bucket', () => {
  // Local retention prunes at 28. Mirroring that upward would give the bucket the same seven-day
  // horizon and undo the reason it exists.
  const root = workspace();
  const { dir } = seedBackups(root, 2);
  const g = fakeGcloud(root);
  run({ BACKUP_DIR: dir, BACKUP_BUCKET: 'gs://b' }, g);
  assert.doesNotMatch(g.calls(), /\brm\b/, 'backup-offsite.sh must never delete remotely');
});

test('an unset bucket fails loudly rather than doing nothing', () => {
  const root = workspace();
  const { dir } = seedBackups(root, 1);
  const r = run({ BACKUP_DIR: dir, BACKUP_BUCKET: '' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /BACKUP_BUCKET is unset/);
});

test("'none' is an explicit opt-out: exits clean, and still writes no receipt", () => {
  const root = workspace();
  const { dir } = seedBackups(root, 1);
  const r = run({ BACKUP_DIR: dir, BACKUP_BUCKET: 'none' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /explicit choice/);
  assert.ok(!existsSync(join(dir, '.offsite-receipt')),
    'opting out must not fabricate evidence of a copy — the alert should fire and be silenced deliberately');
});

test('a bucket that is not gs:// is refused before anything is uploaded', () => {
  const root = workspace();
  const { dir } = seedBackups(root, 1);
  const r = run({ BACKUP_DIR: dir, BACKUP_BUCKET: 's3://b' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /must start with gs:\/\//);
});

test('an empty backup directory fails rather than reporting success', () => {
  const root = workspace();
  const dir = join(root, 'empty');
  mkdirSync(dir, { recursive: true });
  const r = run({ BACKUP_DIR: dir, BACKUP_BUCKET: 'gs://b' }, fakeGcloud(root));
  assert.notEqual(r.code, 0);
  assert.match(r.out, /no complete backup pair/);
});
