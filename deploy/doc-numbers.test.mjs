/**
 * The numbers the top-level documents state about this repo, checked against the repo.
 *
 * WHY THIS EXISTS. `docs/STATUS.md` opens by saying every number on it "was read from the code, the
 * farm or `git` on that day, not carried forward" — and on 2026-09-11 it claimed 1474 tests, 49
 * migrations, 28 ADRs and 27 defects while the repo held 1607, 50, 34 and 45. `docs/APP_CONTEXT.md`
 * had decayed **within hours of being written**.
 *
 * That is this project's single most-repeated failure: HANDOFF entry 76 is about splitting documents
 * by rate of change so they stop dragging each other out of date, `mfarm-handoff-decays` is a note
 * about it, and `DEFECTS.md` carries two entries where the register was wrong about itself. Every
 * one of those was a person re-reading and noticing. This is the cheap part of that job done by CI.
 *
 * WHAT IS CHECKED AND WHAT IS NOT. Only facts derivable from the filesystem — files on disk and the
 * highest id in a register. Deliberately NOT the test count: it moves on most commits, so asserting
 * it would mean editing a document in every pull request, and a check people route around is worse
 * than no check. Those numbers carry the date they were measured instead, which is a claim about a
 * moment and cannot rot — see the "measured" suffix in both files.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let status = '';
let context = '';
let direction = '';
let handoff = '';
let migrations = 0;
let adrs = 0;
let adrFiles = [];
let highestDefect = 0;

before(async () => {
  status = await readFile(join(ROOT, 'docs', 'STATUS.md'), 'utf8');
  context = await readFile(join(ROOT, 'docs', 'APP_CONTEXT.md'), 'utf8');
  direction = await readFile(join(ROOT, 'docs', 'DIRECTION.md'), 'utf8');
  handoff = await readFile(join(ROOT, 'HANDOFF.md'), 'utf8');

  migrations = (await readdir(join(ROOT, 'apps', 'api', 'migrations')))
    .filter((f) => f.endsWith('.sql')).length;
  adrFiles = (await readdir(join(ROOT, 'docs', 'adrs'))).filter((f) => f.endsWith('.md'));
  adrs = adrFiles.length;

  const defects = await readFile(join(ROOT, 'docs', 'DEFECTS.md'), 'utf8');
  highestDefect = Math.max(...[...defects.matchAll(/\bD(\d+)\b/g)].map((m) => Number(m[1])));
});

describe('STATUS.md says true things about the repo', () => {
  test('the migration count is the number of migrations', () => {
    // Matched wherever it appears rather than in one table cell: the figure is quoted in prose too,
    // and a document that is right in its summary and wrong in its body is still wrong.
    const claims = [...status.matchAll(/(\d+) migrations/g)].map((m) => Number(m[1]));
    assert.ok(claims.length, 'STATUS.md should state a migration count');
    for (const n of claims) {
      assert.equal(n, migrations,
        `STATUS.md says ${n} migrations; apps/api/migrations has ${migrations}`);
    }
  });

  test('the ADR count is the number of ADRs', () => {
    const m = status.match(/(\d+) ADRs/);
    assert.ok(m, 'STATUS.md should state an ADR count');
    assert.equal(Number(m[1]), adrs, `STATUS.md says ${m[1]} ADRs; docs/adrs has ${adrs}`);
  });

  test('the defect count is not behind the register', () => {
    const m = status.match(/(\d+) recorded/);
    assert.ok(m, 'STATUS.md should state how many defects are recorded');
    assert.equal(Number(m[1]), highestDefect,
      `STATUS.md says ${m[1]} defects recorded; DEFECTS.md goes up to D${highestDefect}`);
  });
});

describe('APP_CONTEXT.md says true things about the repo', () => {
  test('the ADR count matches', () => {
    const m = context.match(/(\d+) decisions/);
    assert.ok(m, 'APP_CONTEXT.md should state a decision count');
    assert.equal(Number(m[1]), adrs);
  });

  test('the defect count is not behind the register', () => {
    // Spelled in words here, because this one is in prose. Both spellings are checked so that
    // rewriting the sentence cannot quietly drop the check.
    // Generated rather than listed: a hand-written table ran out at every new decade.
    const WORDS = {};
    const TENS = { forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
    const ONES = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
    for (const [t, tv] of Object.entries(TENS)) {
      WORDS[t] = tv;
      for (const [o, ov] of Object.entries(ONES)) WORDS[`${t}-${o}`] = tv + ov;
    }
    const m = context.match(/\*\*([A-Za-z-]+) defects are recorded/);
    assert.ok(m, 'APP_CONTEXT.md should state how many defects are recorded');
    const claimed = WORDS[m[1].toLowerCase()];
    assert.ok(claimed, `unrecognised number word "${m[1]}" — add it to WORDS above`);
    assert.equal(claimed, highestDefect,
      `APP_CONTEXT.md says ${m[1]} (${claimed}) defects; DEFECTS.md goes up to D${highestDefect}`);
  });
});

describe('a decision is in every document that lists decisions', () => {
  /**
   * A COUNT SAYS HOW MANY, NOT WHICH. On 2026-10-09 five ADRs (0049 to 0053) merged in one day. Each
   * pull request moved the ADR count checked above, so this file passed every time — while
   * `DIRECTION.md`'s table still stopped at 0048 and `HANDOFF.md` had no entry for any of the ten
   * pull requests. Both were found the next day by a person re-reading, which is the job this file
   * exists to take off a person.
   */
  test('DIRECTION.md has a row for every ADR', () => {
    const missing = adrFiles.filter((f) => !direction.includes(`(adrs/${f})`));
    assert.deepEqual(missing, [],
      `DIRECTION.md §3 has no row linking: ${missing.join(', ')}`);
  });

  test('the session log names the newest ADR', () => {
    // The newest only: the log began after the first ADRs were written, and an entry that names a
    // decision is what "this work has an entry" looks like from the filesystem.
    const newest = adrFiles.map((f) => f.slice(0, 4)).sort().at(-1);
    assert.ok(handoff.includes(`ADR-${newest}`),
      `HANDOFF.md never names ADR-${newest}; the work that decided it has no entry in the log`);
  });
});

describe('the numbers that move too fast to assert say WHEN they were taken', () => {
  /**
   * A test total changes on most commits, so pinning it would mean editing a document in every pull
   * request — and a check people route around is worse than no check. What it must not do is read as
   * a standing fact. A date turns it into a claim about a moment, which cannot go stale because it
   * was never about now.
   */
  test('a stated test count carries the date it was measured', () => {
    /**
     * PARAGRAPHS, NOT LINES. This repo hard-wraps prose, so the date that qualifies a number is
     * routinely on the line after it — the first version of this check reported a sentence reading
     * "the suite was 1441 ... on 2026-09-06" because the date had wrapped. A guard whose first
     * finding is a false positive is a guard people learn to skip.
     */
    for (const [name, src] of [['STATUS.md', status], ['APP_CONTEXT.md', context]]) {
      for (const para of src.split(/\n\s*\n/)) {
        if (!/\b1[,.]?\d{3}\b/.test(para)) continue;
        if (!/test|passing|suite/i.test(para)) continue;
        assert.match(para, /measured|20\d\d-\d\d-\d\d/,
          `${name} states a test count without saying when it was measured:\n  ${para.trim().slice(0, 200)}`);
      }
    }
  });
});
