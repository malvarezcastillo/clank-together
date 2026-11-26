import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/db.js';
import { Verifier } from '../src/server/verify.js';
import { reconcile } from '../src/shared/reconcile.js';

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
test('a stale baseline is measured again on main before it counts as a regression', async (t) => {
  const v = baselineFixture(t);
  const { store, repo, unit } = v;
  const { symbol } = store.ensureSymbol({ kind: 'function', versionId: 'one', addr: 0x401000, size: 8 });
  store.run('INSERT INTO func_status (symbol_id, file, status, score, code_hash, confirmed, commit_hash, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, 0)',
    symbol.id, unit, 'mismatch', 0.8589, 'old', repo.head());
  const row = () => store.get('SELECT score, confirmed FROM func_status WHERE symbol_id = ?', symbol.id);
  const fn = (score, codeHash) => v.result({ id: symbol.id, status: 'mismatch', score, codeHash });
  v.regressions = (check) => Math.abs(row().score - check.units[0].functions[0].score) > 1e-4 ? [{ id: symbol.id, file: unit }] : [];
  let compiles = 0;
  v.check = async () => (compiles++, { check: fn(0.8612, 'main') });
  const submission = fn(0.8612, 'main');
  assert.equal(await v.refreshBaselines(submission, {}, 'batch-1'), 1);
  assert.equal(row().score, 0.8612);
  assert.equal(row().confirmed, 1, 'the confirmation stays');
  assert.deepEqual(v.regressions(submission), [], 'no regression against what main builds');
  // A real regression is measured on main once per commit, not on every batch.
  assert.equal(await v.refreshBaselines(fn(0.5, 'worse'), {}, 'batch-2'), 0);
  assert.equal(await v.refreshBaselines(fn(0.5, 'worse'), {}, 'batch-3'), 0);
  assert.equal(compiles, 1);
  assert.equal(store.get("SELECT COUNT(*) AS n FROM events WHERE type = 'baseline_refreshed'").n, 1);
});

function baselineFixture(t) {
  const v = Object.create(Verifier.prototype);
  v.log = { info() {} };
  v.repo = { head: () => 'c0ffee' };
  v.store = new Store(':memory:');
  t.after(() => v.store.db.close());
  v.store.run("INSERT INTO versions (id, sha256, file, size, is_current, created_at) VALUES ('one', 'hash', 'target.exe', 1024, 1, 0)");
  v.unit = 'Engine/FrameScript.cpp';
  v.result = (...functions) => ({ units: [{ file: v.unit, compiled: true, functions, inferred: [], bindings: {} }] });
  return v;
}

test('baseline refresh replaces evidence even without a score change and measures other emitted functions', async (t) => {
  const v = baselineFixture(t);
  const { store, unit } = v;
  const fn = store.ensureSymbol({ kind: 'function', versionId: 'one', addr: 0x401000, size: 8 }).symbol;
  const inline = store.ensureSymbol({ kind: 'function', versionId: 'one', addr: 0x401008, size: 8 }).symbol;
  store.run('INSERT INTO func_status (symbol_id, file, status, score, code_hash, commit_hash, updated_at) VALUES (?, ?, ?, 1, ?, ?, 0)',
    fn.id, unit, 'exact', 'same', 'previous');
  const result = { id: fn.id, addr: 0x401000, status: 'exact', score: 1, codeHash: 'same', size: { ours: 8, original: 8 }, differingBytes: 0,
    asm: '0000  ret', diffRegions: [], relocations: [], file: 'Engine/Script.inl', line: 12 };
  v.regressions = () => [{ id: fn.id, file: unit }];
  v.check = async () => ({ check: v.result(result, { ...result, id: inline.id, addr: 0x401008 }) });
  assert.equal(await v.refreshBaselines(v.result(), {}, 'first'), 2);
  const row = () => store.get('SELECT * FROM func_status WHERE symbol_id = ?', fn.id);
  const measured = row();
  assert.deepEqual([measured.file, measured.commit_hash, measured.comparison_version, measured.comparison_addr, measured.comparison_size], [unit, 'c0ffee', 'one', 0x401000, 8]);
  assert.deepEqual([measured.our_size, measured.differing_bytes, measured.failing_references], [8, 0, 0]);
  assert.deepEqual(JSON.parse(measured.comparison_json), { asm: result.asm, size: result.size, diffRegions: [], relocations: [], file: result.file, line: result.line });
  assert.equal(store.get('SELECT comparison_addr FROM func_status WHERE symbol_id = ?', inline.id).comparison_addr, 0x401008);

  v.repo.head = () => 'new-main';
  v.check = async () => ({ check: v.result({ id: fn.id, addr: result.addr, status: 'missing', score: 0 }) });
  assert.equal(await v.refreshBaselines(v.result(), {}, 'second'), 1);
  const missing = row();
  assert.equal(missing.commit_hash, 'new-main');
  assert.deepEqual([missing.comparison_json, missing.comparison_version, missing.comparison_addr, missing.comparison_size, missing.our_size, missing.differing_bytes, missing.failing_references], Array(7).fill(null));
});

test('baseline evidence counts a wrong reconciled address without changing the score or raw comparison', async (t) => {
  const v = baselineFixture(t);
  const fn = v.store.ensureSymbol({ kind: 'function', versionId: 'one', addr: 0x401000, size: 8 }).symbol;
  const callee = v.store.ensureSymbol({ kind: 'function', versionId: 'one', addr: 0x401008 }).symbol;
  v.store.run('UPDATE symbols SET decorated = ? WHERE id = ?', '?Target', callee.id);
  const relocations = [{ symbol: '?Target', actual: 0x401010, ok: true, unresolved: true }, { symbol: '?Target', actual: 0x401008, ok: true, unresolved: true }];
  const result = { id: fn.id, addr: 0x401000, status: 'match_unresolved', comparisonStatus: 'match_unresolved', score: 1,
    size: { ours: 8, original: 8 }, differingBytes: 0, relocations };
  const check = v.result(result);
  check.units[0].inferred = [{ symbol: '?Target', addr: 0x401010 }];
  const rec = reconcile(check, v.store.symbolMap('one'));
  v.regressions = () => [{ id: fn.id, file: v.unit }];
  v.check = async () => ({ check, rec });
  await v.refreshBaselines(v.result(), {}, 'changed-references');
  const row = v.store.get('SELECT * FROM func_status WHERE symbol_id = ?', fn.id);
  assert.deepEqual([row.status, row.score, row.differing_bytes, row.failing_references, row.reloc_only], ['mismatch', 1, 0, 1, 0]);
  const refs = JSON.parse(row.comparison_json).relocations;
  assert.equal(refs[0].ok, false);
  assert.deepEqual(refs[1], relocations[1]);
  assert.equal(relocations[0].ok, true, 'cache retains raw evidence for the next reconciliation');
});

// A header layout fix that moves a peer-confirmed function in another unit closer to the original
// is progress; moving it away is a regression its reviewers never saw.
test('a peer-confirmed function may move closer to the original, not away from it', () => {
  const v = Object.create(Verifier.prototype);
  v.repo = { git: () => '' };
  v.store = { all: () => [{ symbol_id: 'fn_19918', file: 'WoW/Missile_C.cpp', status: 'mismatch', score: 0.9, confirmed: 1 }] };
  const at = (score) => ({ units: [{ file: 'WoW/Missile_C.cpp', compiled: true, functions: [{ id: 'fn_19918', status: 'mismatch', score }] }] });
  assert.deepEqual(v.regressions(at(0.905)), []);
  assert.deepEqual(v.regressions(at(0.9)), []);
  assert.deepEqual(v.regressions(at(0.895)).map((r) => r.was), ['peer-confirmed']);
});

// A function whose annotation an older merge removed from main (its record still says exact)
// is not "removed" by every later submission of the unit it was recorded at.
test('a function main no longer annotates is no regression', () => {
  const v = Object.create(Verifier.prototype);
  const found = [
    { id: 'fn_07162', file: 'Engine/SE3.cpp', was: 'exact', now: 'removed' },
    { id: 'fn_00009', file: 'Engine/SE3.cpp', was: 'exact', now: 'removed' },
  ];
  v.repo = { git: () => 'HEAD:Engine/SE3.cpp:FUNCTION: fn_00009\n' };
  assert.deepEqual(v.withoutHeaderCopies(found, new Map(), {}).map((r) => r.id), ['fn_00009'], 'still on main: removing it counts');
  v.repo = { git: () => { throw Object.assign(new Error('git grep'), { status: 1 }); } };
  assert.deepEqual(v.withoutHeaderCopies(found, new Map(), {}), []);
  v.repo = { git: () => { throw Object.assign(new Error('git broke'), { status: 128 }); } };
  assert.equal(v.withoutHeaderCopies(found, new Map(), {}).length, 2, 'main unknown: strict');
});
