import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Verifier } from '../src/server/verify.js';

// A header's template copy that one unit stops emitting (or emits differently) is not a regression
// unless the header changed; a unit's own function is.
test('header-defined copies are not regressions while the header is unchanged', () => {
  const grep = 'HEAD:Engine/H/stpl.h:FUNCTION: fn_00002\nHEAD:Engine/H/stpl.h:FUNCTION: fn_00003\n';
  const v = Object.create(Verifier.prototype);
  v.repo = { git: () => grep };
  const found = [
    { id: 'fn_00001', file: 'Engine/A.cpp', was: 'exact', now: 'mismatch' },
    { id: 'fn_00002', file: 'Engine/A.cpp', was: 'exact', now: 'removed' },
    { id: 'fn_00003', file: 'Engine/A.cpp', was: 'exact', now: 'removed' },
    { id: 'fn_00004', file: 'Engine/A.cpp', was: 'exact', now: 'mismatch' },
  ];
  const results = new Map([
    ['fn_00001', { file: 'Engine/A.cpp' }],
    ['fn_00004', { file: 'Engine/H/other.h' }],
  ]);
  assert.deepEqual(v.withoutHeaderCopies(found, results, { 'Engine/A.cpp': '' }).map((r) => r.id), ['fn_00001']);

  // Header changed: a removed annotation counts, a still-annotated copy not compiled here does not.
  const header = '// FUNCTION: fn_00002 <A>\ntemplate<class T> void f() {}\n';
  const files = { 'Engine/A.cpp': '', 'Engine/H/stpl.h': header, 'Engine/H/other.h': '' };
  assert.deepEqual(v.withoutHeaderCopies(found, results, files).map((r) => r.id), ['fn_00001', 'fn_00003', 'fn_00004']);
});

// A recorded status older than main (a header change merged since): main is compiled once and the
// record brought up to date, so the submission is compared with what main builds.
test('a stale baseline is measured again on main before it counts as a regression', async () => {
  const rows = new Map([['fn_02237', { status: 'mismatch', score: 0.8589, code_hash: 'old', confirmed: 1 }]]);
  const events = [];
  const v = Object.create(Verifier.prototype);
  v.log = { info() {} };
  v.repo = { head: () => 'c0ffee' };
  v.store = {
    get: (_, id) => rows.get(id),
    run: (_, file, status, score, hash, commit, at, id) => rows.set(id, { ...rows.get(id), file, status, score, code_hash: hash }),
    event: (...e) => events.push(e),
  };
  const fn = (score, codeHash) => ({ units: [{ file: 'Engine/FrameScript.cpp', compiled: true, functions: [{ id: 'fn_02237', status: 'mismatch', score, codeHash }] }] });
  v.regressions = (check) => {
    const now_ = check.units[0].functions[0];
    const row = rows.get('fn_02237');
    return Math.abs(row.score - now_.score) > 1e-4 ? [{ id: 'fn_02237', file: 'Engine/FrameScript.cpp' }] : [];
  };
  let compiles = 0;
  v.check = async () => (compiles++, { check: fn(0.8612, 'main') });
  const submission = fn(0.8612, 'main');
  assert.equal(await v.refreshBaselines(submission, {}, 'batch-1'), 1);
  assert.equal(rows.get('fn_02237').score, 0.8612);
  assert.equal(rows.get('fn_02237').confirmed, 1, 'the confirmation stays');
  assert.deepEqual(v.regressions(submission), [], 'no regression against what main builds');
  // A real regression is measured on main once per commit, not on every batch.
  assert.equal(await v.refreshBaselines(fn(0.5, 'worse'), {}, 'batch-2'), 0);
  assert.equal(await v.refreshBaselines(fn(0.5, 'worse'), {}, 'batch-3'), 0);
  assert.equal(compiles, 1);
  assert.equal(events.length, 1);
});
