import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Repo } from '../src/server/git.js';
import { Verifier, encodeCheck, decodeCheck } from '../src/server/verify.js';

// Real git/source snapshots; the compile seam records work and returns deterministic analysis.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  const commit = (files) => {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      if (text === null) fs.rmSync(path.join(dir, file), { force: true });
      else fs.writeFileSync(path.join(dir, file), text);
    }
    git('add', '-A');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'change');
    return git('rev-parse', 'HEAD');
  };
  commit({ 'src/a.cpp': '#include "shared.h"\n#include "a.h"\nint a = VALUE;\n', 'src/b.cpp': '#include "shared.h"\nint b = VALUE;\n',
    'src/shared.h': '#define VALUE 1\n', 'src/a.h': '#define A 1\n' });
  const rows = new Map();
  const symbols = new Map();
  const names = new Map();
  const version = { id: 'one', sha256: 'first' };
  const store = {
    currentVersion: () => version, symbolMap: () => symbols, nameIndex: () => names,
    get: (_sql, id) => rows.get(id),
    run: (_sql, id, head, check_json) => rows.set(id, { head, check_json }),
  };
  const verifier = new Verifier({ store, repo: new Repo(dir), config: { dataDir: dir },
    project: { sourceDirs: ['src'], includeDirs: ['src'] }, log: { info() {} } });
  const units = ['src/a.cpp', 'src/b.cpp'];
  verifier.includersOf = () => units;
  const calls = [];
  const failures = new Set();
  let during = null;
  // What each unit's comparison looked up (check.js inputsCurrent): nothing, unless a test says so.
  const reads = new Map();
  verifier.check = async (files, _job, { onlyUnits } = {}) => {
    const cacheSnapshot = verifier.checkSnapshot(files);
    const selected = onlyUnits ?? units;
    calls.push([...selected]);
    const check = { annotationErrors: cacheSnapshot.annotationErrors, analysisNames: [...names], units: selected.map((file) => ({
      file, compiled: !failures.has(file), includes: file === units[0] ? ['src/shared.h', 'src/a.h'] : ['src/shared.h'],
      lintErrors: [], errors: [], functions: [{ id: file, status: 'mismatch', comparisonStatus: 'mismatch', score: 0.5,
        asm: '0000  ret', differingBytes: 1, diffRegions: [{ offset: 0, length: 1, ours: 'c3', original: '90' }] }],
      inferred: [], bindings: {}, unannotated: [], globalBindings: [],
      inputs: reads.get(file) ?? { names: [], symbols: [] },
    })) };
    if (during) { const fn = during; during = null; await fn(); }
    return { check, rec: {}, changedHeaders: Object.keys(files).filter((f) => f.endsWith('.h')), cacheSnapshot };
  };
  const files = { 'src/shared.h': '#define VALUE 2\n' };
  return { verifier, rows, version, symbols, names, calls, failures, commit, files, units, reads, during: (fn) => { during = fn; } };
}

test('expanded retries reuse unchanged units, rebuild private and shared dependencies, and match fresh analysis', async (t) => {
  const f = fixture(t);
  const first = await f.verifier.mergeCheck({ id: 1 }, f.files);
  assert.equal(first.compiled, 2);
  const retry = await f.verifier.mergeCheck({ id: 1 }, f.files);
  assert.equal(retry.compiled, 0);
  assert.deepEqual(retry.check.units[0].functions, first.check.units[0].functions, 'warm merges keep the listing, regions and byte count');
  f.commit({ 'src/a.h': '#define A 2\n' });
  const partial = await f.verifier.mergeCheck({ id: 1 }, f.files);
  assert.deepEqual(f.calls.at(-1), ['src/a.cpp']);
  assert.equal(partial.reused, 1);
  const fresh = await f.verifier.check(f.files, 'fresh');
  assert.deepEqual([...partial.check.units].sort((a, b) => a.file.localeCompare(b.file)), fresh.check.units);
  const changed = { 'src/shared.h': '#define VALUE 3\n' };
  assert.equal((await f.verifier.mergeCheck({ id: 1 }, changed)).compiled, 2);
});

test('added/deleted include candidates and project/toolchain/target changes invalidate evidence', async (t) => {
  const f = fixture(t);
  await f.verifier.mergeCheck({ id: 1 }, f.files);
  for (const change of [
    () => f.commit({ 'src/optional.h': '#define OPTIONAL 1\n' }),
    () => f.commit({ 'src/optional.h': null }),
    () => { f.verifier.project.flags = ['/O2']; },
    () => { f.verifier.config.toolchainLock = { clSha256: 'new' }; },
    () => { f.version.sha256 = 'second'; },
  ]) {
    change();
    assert.equal((await f.verifier.mergeCheck({ id: 1 }, f.files)).compiled, 2);
  }
});

test('a name or symbol invalidates only the units whose comparison read it', async (t) => {
  const f = fixture(t);
  f.symbols.set('fn_a', { id: 'fn_a', kind: 'function', addr: 0x401000, size: 8 });
  f.reads.set('src/a.cpp', { names: [['?Callee@@YAXXZ', null]], symbols: [['fn_a', [0x401000, 8, null]]] });
  await f.verifier.mergeCheck({ id: 1 }, f.files);
  f.names.set('?Other@@YAXXZ', 'fn_other');
  f.symbols.set('fn_other', { id: 'fn_other', kind: 'function', addr: 0x402000, size: 4 });
  assert.equal((await f.verifier.mergeCheck({ id: 1 }, f.files)).compiled, 0, 'what no unit read changes no result');
  f.names.set('?Callee@@YAXXZ', 'fn_callee');
  assert.equal((await f.verifier.mergeCheck({ id: 1 }, f.files)).compiled, 1);
  assert.deepEqual(f.calls.at(-1), ['src/a.cpp'], 'a name it could not resolve is now known');
  f.reads.set('src/a.cpp', { names: [['?Callee@@YAXXZ', 'fn_callee']], symbols: [['fn_a', [0x401000, 8, null]]] });
  await f.verifier.mergeCheck({ id: 1 }, f.files);
  f.symbols.get('fn_a').addr = 0x401010;
  assert.equal((await f.verifier.mergeCheck({ id: 1 }, f.files)).compiled, 1);
  assert.deepEqual(f.calls.at(-1), ['src/a.cpp'], 'the address of a symbol it was compared with was corrected');
});

test('split children retain their own retries without overwriting parent provenance', async (t) => {
  const f = fixture(t);
  await f.verifier.mergeCheck({ id: 1 }, f.files);
  const parent = f.rows.get(1).check_json;
  const childFiles = { ...f.files, 'src/a.cpp': '#include "shared.h"\nint child;\n' };
  assert.equal((await f.verifier.mergeCheck({ id: 2 }, childFiles, { id: 1 })).compiled, 1);
  assert.equal((await f.verifier.mergeCheck({ id: 2 }, childFiles, { id: 1 })).compiled, 0);
  assert.deepEqual(f.rows.get(1).check_json, parent);
  assert.deepEqual(decodeCheck(f.rows.get(2).check_json).cacheSnapshot.overrides, childFiles);
});

test('failed units retry and legacy or unknown provenance never becomes a hit', async (t) => {
  const f = fixture(t);
  f.failures.add('src/a.cpp');
  await f.verifier.mergeCheck({ id: 1 }, f.files);
  f.failures.clear();
  assert.equal((await f.verifier.mergeCheck({ id: 1 }, f.files)).compiled, 1);
  const saved = decodeCheck(f.rows.get(1).check_json);
  delete saved.cacheSnapshot;
  f.rows.set(1, { head: f.verifier.repo.head(), check_json: encodeCheck(saved) });
  assert.equal((await f.verifier.mergeCheck({ id: 1 }, f.files)).compiled, 2);
});

test('format 3 evidence is rebuilt but its additional emitter coverage is preserved', async (t) => {
  const f = fixture(t);
  const files = { 'src/a.cpp': 'int a = 2;\n' };
  const old = await f.verifier.check(files, 'legacy verification');
  old.cacheSnapshot.format = 3;
  for (const u of old.check.units) for (const fn of u.functions) {
    delete fn.asm;
    delete fn.diffRegions;
    delete fn.differingBytes;
  }
  f.rows.set(1, { head: old.cacheSnapshot.head, check_json: JSON.stringify(old) });
  const retry = await f.verifier.mergeCheck({ id: 2 }, files, { id: 1 });
  assert.equal(retry.reused, 0);
  assert.deepEqual(f.calls.at(-1), f.units, 'the old parent knew that src/b.cpp was also required');
  assert.equal(retry.check.units[1].functions[0].differingBytes, 1);
  assert.equal((await f.verifier.mergeCheck({ id: 2 }, files, { id: 1 })).compiled, 0);
});

test('compile-start HEAD survives a commit while compilation awaits', async (t) => {
  const f = fixture(t);
  const start = f.verifier.repo.head();
  f.during(async () => { f.commit({ 'src/a.h': '#define A 7\n' }); });
  await f.verifier.mergeCheck({ id: 1 }, f.files);
  assert.equal(f.rows.get(1).head, start);
  assert.notEqual(f.verifier.repo.head(), start);
  assert.equal((await f.verifier.mergeCheck({ id: 1 }, f.files)).compiled, 1);
  const result = await f.verifier.check(f.files, 'verification');
  const builtAt = result.cacheSnapshot.head;
  f.commit({ 'src/a.h': '#define A 8\n' });
  f.verifier.rememberCheck(3, result);
  assert.equal(f.rows.get(3).head, builtAt);
});

test('unrelated annotations refresh errors without recompiling other units', async (t) => {
  const f = fixture(t);
  f.commit({ 'src/unrelated.cpp': 'int unrelated;\n' });
  await f.verifier.mergeCheck({ id: 1 }, f.files);
  f.commit({ 'src/unrelated.cpp': '// FUNCTION: fn_unknown\nint unrelated;\n' });
  const retry = await f.verifier.mergeCheck({ id: 1 }, f.files);
  assert.equal(retry.compiled, 0);
  assert.deepEqual(retry.check.annotationErrors, f.verifier.checkSnapshot(f.files).annotationErrors);
});

test('GLOBAL annotations do not force unchanged units to compile when binding context is stable', async (t) => {
  const f = fixture(t);
  f.commit({ 'src/global.cpp': '// GLOBAL: gl_00001 gValue\nint gValue;\n' });
  await f.verifier.mergeCheck({ id: 1 }, f.files);
  f.commit({ 'src/a.h': '#define A 42\n' });
  const retry = await f.verifier.mergeCheck({ id: 1 }, f.files);
  assert.equal(retry.compiled, 1);
  assert.equal(retry.reused, 1);
  assert.equal(retry.check.units.find((u) => u.file === 'src/b.cpp').functions[0].status, 'mismatch');
});

test('reconciliation starts from comparison status rather than cached approvals', async (t) => {
  const f = fixture(t);
  await f.verifier.mergeCheck({ id: 1 }, f.files);
  const row = f.rows.get(1);
  const saved = decodeCheck(row.check_json);
  saved.check.units[0].functions[0].status = 'exact';
  row.check_json = encodeCheck(saved);
  const retry = await f.verifier.mergeCheck({ id: 1 }, f.files);
  assert.equal(retry.compiled, 0);
  assert.equal(retry.check.units[0].functions[0].status, 'mismatch');
});

test('GLOBAL fallback crossing HEAD requests new coverage instead of certifying new includers', async (t) => {
  const f = fixture(t);
  f.commit({ 'src/global.cpp': '// GLOBAL: gl_00001\nint gValue;\n' });
  // b.cpp was compared while nothing bound the global's name.
  f.reads.set('src/b.cpp', { names: [['?gValue@@3HA', null]], symbols: [] });
  await f.verifier.mergeCheck({ id: 1 }, f.files);
  const original = f.rows.get(1).check_json;
  f.commit({ 'src/a.h': '#define A 42\n' });
  const check = f.verifier.check;
  f.verifier.check = async (...args) => {
    const result = await check(...args);
    result.check.analysisNames = [['?gValue@@3HA', 'gl_00001']];
    return result;
  };
  f.during(async () => {
    f.commit({ 'src/c.cpp': '#include "shared.h"\nint c = VALUE;\n' });
    f.units.push('src/c.cpp');
  });
  const retry = await f.verifier.mergeCheck({ id: 1 }, f.files);
  assert.equal(retry.retryRequired, true);
  assert.deepEqual(f.rows.get(1).check_json, original, 'old coverage is not relabeled with the newer HEAD');
  const checked = await f.verifier.mergeCheck({ id: 1 }, f.files);
  assert.equal(checked.retryRequired, undefined);
  assert.ok(checked.check.units.some((u) => u.file === 'src/c.cpp'), 'next attempt discovers the new includer');
});

test('unrelated unnamed registrations reuse compilation but reconcile newly known addresses', async (t) => {
  const f = fixture(t);
  const check = f.verifier.check;
  f.reads.set('src/a.cpp', { names: [['?NewGlobal@@3HA', null]], symbols: [] });
  f.verifier.check = async (...args) => {
    const result = await check(...args);
    result.check.units[0].inferred = [{ symbol: '?NewGlobal@@3HA', addr: 0x405000 }];
    return result;
  };
  const before = await f.verifier.mergeCheck({ id: 1 }, f.files);
  assert.ok(before.rec.unknown.some((r) => r.addr === 0x405000));
  f.symbols.set('gl_00001', { id: 'gl_00001', kind: 'global', addr: 0x405000, size: 4 });
  const after = await f.verifier.mergeCheck({ id: 1 }, f.files);
  assert.equal(after.compiled, 0);
  assert.deepEqual(after.rec.learned, [{ decorated: '?NewGlobal@@3HA', id: 'gl_00001', addr: 0x405000 }]);
  f.symbols.get('gl_00001').decorated = '?NewGlobal@@3HA';
  f.names.set('?NewGlobal@@3HA', 'gl_00001');
  assert.equal((await f.verifier.mergeCheck({ id: 1 }, f.files)).compiled, 1, 'decorated resolution changes still invalidate the analysis that read the name');
  assert.deepEqual(f.calls.at(-1), ['src/a.cpp']);
});

test('cold merges honor affected-unit selection without losing verification emitter coverage', async (t) => {
  const f = fixture(t);
  f.commit({
    'src/shared.h': '#define FEATURE_VALUE 1\n',
    'src/a.cpp': '#include "shared.h"\nint a = FEATURE_VALUE;\n',
    'src/b.cpp': '#include "shared.h"\nint b;\n',
  });
  const files = { 'src/shared.h': '#define FEATURE_VALUE 2\n' };
  const cold = await f.verifier.mergeCheck({ id: 1 }, files);
  assert.deepEqual(f.calls.at(-1), ['src/a.cpp'], 'cold cache does not expand back to every includer');
  assert.equal(cold.compiled, 1);
  const withEmitter = { id: 2, result_json: JSON.stringify({ check: [{ file: 'src/b.cpp' }] }) };
  const emitted = await f.verifier.mergeCheck(withEmitter, files);
  assert.deepEqual(new Set(emitted.check.units.map((u) => u.file)), new Set(f.units), 'verification emitter units are always covered, even without reusable results');
});

test('cold new headers retain every includer when narrowing is unavailable', async (t) => {
  const f = fixture(t);
  const result = await f.verifier.mergeCheck({ id: 1 }, { 'src/new.h': '#define NEW_VALUE 1\n' });
  assert.deepEqual(new Set(result.check.units.map((u) => u.file)), new Set(f.units));
});
