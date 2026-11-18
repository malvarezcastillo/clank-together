import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Verifier, BuildRetryError, clearBuildRetry } from '../src/server/verify.js';
import { Merger } from '../src/server/merge.js';
import { Maintenance } from '../src/server/maintenance.js';

const files = { 'src/a.cpp': '// FUNCTION: fn_00001\nint f() { return 1; }\n' };
const analysis = (compiled, timedOut = false) => ({ annotationErrors: [], units: [{ file: 'src/a.cpp', compiled, timedOut, log: 'compiler diagnostic', functions: [], lintErrors: [], unannotated: [] }] });
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE batches (id INTEGER PRIMARY KEY, user_id INTEGER, base_commit TEXT, files_json TEXT, result_json TEXT, state TEXT, kind TEXT DEFAULT 'code', cost INTEGER DEFAULT 1, finished_at INTEGER, merged_commit TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, symbol_id TEXT, state TEXT, cleanup_cycles INTEGER DEFAULT 0, updated_at INTEGER);
    CREATE TABLE attempts (id INTEGER PRIMARY KEY, task_id INTEGER, batch_id INTEGER, user_id INTEGER, state TEXT, result_json TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE func_status (symbol_id TEXT PRIMARY KEY, code_hash TEXT, effective_hash TEXT);
    INSERT INTO users VALUES (1, 'author');
    INSERT INTO tasks (id, symbol_id, state) VALUES (1, 'fn_00001', 'verifying');
    INSERT INTO attempts VALUES (1, 1, 1, 1, 'verifying', '{"approvedEvidence":true}');
  `);
  const store = { get: (sql, ...args) => db.prepare(sql).get(...args), all: (sql, ...args) => db.prepare(sql).all(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args), tx: (fn) => fn(), event() {} };
  store.run('INSERT INTO batches (id, user_id, base_commit, files_json, result_json, state) VALUES (1, 1, ?, ?, ?, ?)', 'head', JSON.stringify(files), JSON.stringify({ splitKeepCode: true }), 'verifying');
  const repo = { head: () => 'head', size: () => 100, trackedPaths: () => new Set(Object.keys(files)), isAncestor: () => true,
    mergeOntoHead: () => ({ files, conflicts: [] }), show: () => files['src/a.cpp'], showMany: (_commit, paths) => new Map(paths.map((p) => [p, files['src/a.cpp']])),
    commitFiles: () => assert.fail('must not commit') };
  const verifier = new Verifier({ store, repo, config: { dataDir: '.' }, project: { sourceDirs: ['src'], headerGlobs: [], matchPolicy: {} },
    tasks: { allowedPathsForTasks: () => ['src/**'] }, log: { info() {}, error() {} } });
  for (const method of ['freeTextGate', 'droppedAnnotations', 'undefinedGate', 'globalsGate', 'changedOutside']) verifier[method] = () => [];
  verifier.check = async () => ({ check: analysis(false, true), rec: { conflicts: [], unknown: [] }, changedHeaders: [] });
  const merger = new Merger({ store, repo, config: {}, verifier, log: verifier.log });
  return { store, repo, verifier, merger, batch: () => store.get('SELECT * FROM batches WHERE id = 1') };
}

test('failed candidate skips baseline discovery and evaluation does not invent removed regressions', async () => {
  const v = Object.create(Verifier.prototype);
  v.regressions = () => assert.fail('incomplete builds cannot measure regressions');
  v.project = { matchPolicy: {} };
  for (const timedOut of [false, true]) assert.equal(await v.refreshBaselines(analysis(false, timedOut), files, 'test'), 0);
  const result = v.evaluate({ check: analysis(false), rec: { conflicts: [], unknown: [] }, targetId: 'fn_00001', files, changedHeaders: [] });
  assert.equal(result.state, 'needs_cleanup');
  assert.deepEqual(result.feedback.regressions, []);
});

test('verification timeout preserves author evidence and cleanup count, then retry clears diagnostic', async (t) => {
  const f = fixture(t);
  f.verifier.refreshBaselines = () => assert.fail('no baseline after timeout');
  await f.verifier.verifyBatch(f.batch());
  assert.equal(f.batch().state, 'queued');
  const result = JSON.parse(f.batch().result_json);
  assert.equal(result.buildRetry.kind, 'timeout');
  assert.equal(result.buildRetry.stage, 'verification');
  assert.ok(result.buildRetry.retryAt > Date.now());
  assert.equal(f.store.get('SELECT cleanup_cycles FROM tasks WHERE id = 1').cleanup_cycles, 0);
  assert.equal(f.store.get('SELECT state FROM attempts WHERE id = 1').state, 'queued');
  assert.equal(JSON.parse(f.store.get('SELECT result_json FROM attempts WHERE id = 1').result_json).approvedEvidence, true);
  clearBuildRetry(f.store, 1);
  assert.equal(JSON.parse(f.batch().result_json).buildRetry, undefined);
  assert.equal(JSON.parse(f.batch().result_json).splitKeepCode, true);
});

test('ordinary candidate compiler error still routes cleanup without baseline work', async (t) => {
  const f = fixture(t);
  f.verifier.check = async () => ({ check: analysis(false), rec: { conflicts: [], unknown: [] }, changedHeaders: [] });
  f.verifier.refreshBaselines = () => assert.fail('no baseline after failure');
  const finished = [];
  f.verifier.finish = (_attempt, state, _score, feedback) => finished.push({ state, feedback });
  await f.verifier.verifyBatch(f.batch());
  assert.equal(finished[0].state, 'needs_cleanup');
  assert.equal(finished[0].feedback.summary, 'compilation failed');
});

test('baseline failure is infrastructure, never an accepted incomplete baseline', async () => {
  const v = Object.create(Verifier.prototype);
  v.repo = { head: () => 'head' };
  v.regressions = () => [{ id: 'fn_00001', file: 'src/a.cpp' }];
  for (const timedOut of [true, false]) {
    v.check = async () => ({ check: analysis(false, timedOut) });
    await assert.rejects(v.refreshBaselines(analysis(true), files, 'test'), (e) => e instanceof BuildRetryError && e.diagnostic.kind === (timedOut ? 'timeout' : 'baseline_failed'));
    assert.equal(v.baselineAt.size, 0);
  }
});

for (const baseline of [false, true]) test(`merge ${baseline ? 'baseline' : 'candidate'} timeout preserves approvals and yields lane`, async (t) => {
  const f = fixture(t);
  f.store.run("UPDATE batches SET state = 'open' WHERE id = 1");
  f.store.run("UPDATE attempts SET state = 'approved'");
  f.store.run("UPDATE tasks SET state = 'approved'");
  f.verifier.mergeCheck = async () => ({ check: analysis(baseline, !baseline), changedHeaders: [] });
  f.verifier.refreshBaselines = () => { if (baseline) throw new BuildRetryError(analysis(false, true), 'baseline'); assert.fail('no baseline after timeout'); };
  await f.merger.merge(f.batch());
  assert.equal(f.batch().state, 'open');
  assert.equal(f.store.get('SELECT state FROM attempts WHERE id = 1').state, 'approved');
  assert.equal(f.store.get('SELECT state FROM tasks WHERE id = 1').state, 'approved');
  assert.equal(f.merger.next(), null);
  f.store.run("INSERT INTO batches (id,user_id,base_commit,files_json,state) VALUES (2,1,'head',?,'open')", JSON.stringify(files));
  f.store.run("INSERT INTO attempts VALUES (2,1,2,1,'approved',NULL)");
  assert.equal(f.merger.next().batch.id, 2);
});

test('timed-out split child stays independently retryable without noSplit or bounce', async (t) => {
  const f = fixture(t);
  f.store.run("UPDATE batches SET state = 'open' WHERE id = 1");
  f.store.run("INSERT INTO batches (id,user_id,base_commit,files_json,state,result_json) VALUES (2,1,'head',?,'open','{\"splitFrom\":1}')", JSON.stringify(files));
  f.store.run("UPDATE attempts SET batch_id = 2, state = 'approved'");
  f.verifier.mergeCheck = async () => ({ check: analysis(false, true), changedHeaders: [] });
  await f.merger.merge(f.store.get('SELECT * FROM batches WHERE id = 2'));
  assert.equal(f.store.get('SELECT batch_id FROM attempts WHERE id = 1').batch_id, 2);
  assert.equal(f.batch().state, 'open');
  assert.equal(JSON.parse(f.batch().result_json).noSplit, undefined);
  assert.equal(f.store.get('SELECT state FROM batches WHERE id = 2').state, 'open');
});

test('maintenance timeout queues work and baseline failure cannot appear as changed source', async (t) => {
  const f = fixture(t);
  f.store.run("UPDATE batches SET kind = 'maintenance' WHERE id = 1");
  const m = new Maintenance({ ...f, project: f.verifier.project, log: f.verifier.log });
  const outcome = await m.run(1);
  assert.equal(outcome.state, 'queued');
  assert.equal(f.batch().state, 'queued');
  assert.equal(JSON.parse(f.batch().result_json).buildRetry.stage, 'maintenance');
  await assert.rejects(m.changedFunctions(analysis(true), files, 'head'), (e) => e instanceof BuildRetryError && e.diagnostic.stage === 'maintenance-baseline');
});

test('maintenance: renaming a function, its own helpers and a declared-only callee is not a code change; calling another one is', async (t) => {
  const f = fixture(t);
  f.store.currentVersion = () => ({ id: 1 });
  // fn_00002 (at 0x401100) is declared-only in the source: no binding, known to the database by name.
  f.store.symbolMap = () => new Map([
    ['fn_00001', { kind: 'function', addr: 0x401000 }],
    ['fn_00002', { kind: 'function', addr: 0x401100, name: 'FillRange' }],
    ['fn_00003', { kind: 'function', addr: 0x401200, name: 'Other' }],
  ]);
  const m = new Maintenance({ ...f, project: f.verifier.project, log: f.verifier.log });
  const { effectiveHash } = await import('../src/shared/compare.js');
  // fn_00001 as compiled under `self`: its exception handler (named after it) and a call to `callee`.
  const fn = (self, callee) => {
    const handler = `__ehhandler$${self}`;
    const refs = [[handler, 6, 'abs', 0], [callee, 37, 'rel', -4]];
    const effective = refs.map(([n, at, kind, add]) => `${at}:${kind}:?${n}+${add}`);
    const parts = { bytesHash: 'b', effective, unresolvedRefs: refs.map(([n, at, kind, add], index) => ({ index, name: n, addend: add, prefix: `${at}:${kind}:` })), is64: false };
    const relocations = [{ offset: 6, symbol: handler, ok: true, unresolved: true, actual: 0xeee000 }, { offset: 37, symbol: callee, ok: true, unresolved: true, actual: 0x401100 }];
    return { id: 'fn_00001', symbol: self, status: 'mismatch', score: 0.5, effectiveHash: effectiveHash(Buffer.from([0]), [0], effective), effectiveParts: parts, relocations };
  };
  const unit = (self, callee) => ({ file: 'src/a.cpp', compiled: true, functions: [fn(self, callee)], bindings: { [self]: 'fn_00001' }, lintErrors: [], unannotated: [] });
  f.verifier.check = async () => ({ check: { units: [unit('?sub_401000@@YAXXZ', '?sub_401100@@YAXPAX0PBX@Z')] } });
  const changed = async (self, callee) => (await m.changedFunctions({ units: [unit(self, callee)] }, files, 'head')).map((c) => c.id);
  assert.deepEqual(await changed('?Load@@YAXXZ', '?FillRange@@YAXPAX0PBX@Z'), [], 'only names changed');
  assert.deepEqual(await changed('?Load@@YAXXZ', '?Other@@YAXPAX0PBX@Z'), ['fn_00001'], 'now calling a different function');
});

test('maintenance: a lambda inside a renamed method keeps its exception handler', async (t) => {
  const f = fixture(t);
  f.store.currentVersion = () => ({ id: 1 });
  // Main resolved its handler through the database, under the old spelling; the renamed one is not
  // known yet, and the original's relocation at that spot reaches a different address.
  const oldSelf = '??R<lambda_1>@?1??Slot11@CSkill@@UAEXH@Z@QBE@H@Z';
  const newSelf = '??R<lambda_1>@?1??OnSkillEffect@CSkill@@UAEXH@Z@QBE@H@Z';
  f.store.symbolMap = () => new Map([['fn_00001', { kind: 'function', addr: 0x401000 }], ['gl_00001', { kind: 'global', addr: 0xeee000, decorated: `__ehhandler$${oldSelf}` }]]);
  const m = new Maintenance({ ...f, project: f.verifier.project, log: f.verifier.log });
  const { effectiveHash } = await import('../src/shared/compare.js');
  const before = { id: 'fn_00001', symbol: oldSelf, status: 'exact', score: 1, effectiveHash: effectiveHash(Buffer.from([0]), [0], [`6:abs:${0xeee000}`]), relocations: [] };
  const handler = `__ehhandler$${newSelf}`;
  const effective = [`6:abs:?${handler}+0`];
  // Same masked bytes on both sides (effectiveHash hashes the zeroed bytes with sha1).
  const { createHash } = await import('node:crypto');
  const bytesHash = createHash('sha1').update(Buffer.from([0])).digest('hex');
  const after = { id: 'fn_00001', symbol: newSelf, status: 'exact', score: 1, effectiveHash: effectiveHash(Buffer.from([0]), [0], effective),
    effectiveParts: { bytesHash, effective, unresolvedRefs: [{ index: 0, name: handler, addend: 0, prefix: '6:abs:' }], is64: false },
    relocations: [{ offset: 6, symbol: handler, ok: true, unresolved: true, actual: 0xddd000 }] };
  const unit = (fn) => ({ file: 'src/a.cpp', compiled: true, functions: [fn], bindings: { [fn.symbol]: 'fn_00001' }, lintErrors: [], unannotated: [] });
  f.verifier.check = async () => ({ check: { units: [unit(before)] } });
  assert.deepEqual((await m.changedFunctions({ units: [unit(after)] }, files, 'head')).map((c) => c.id), []);
});

test('maintenance: a callee no symbol knows, respelled from C to C++ linkage, is not a code change; another identifier is', async (t) => {
  const f = fixture(t);
  f.store.currentVersion = () => ({ id: 1 });
  f.store.symbolMap = () => new Map([['fn_00001', { kind: 'function', addr: 0x401000 }]]);
  const m = new Maintenance({ ...f, project: f.verifier.project, log: f.verifier.log });
  const { effectiveHash } = await import('../src/shared/compare.js');
  const self = '?FindShopId@@YAHXZ';
  const fn = (callee) => {
    const effective = [`37:rel:?${callee}+-4`];
    const parts = { bytesHash: 'b', effective, unresolvedRefs: [{ index: 0, name: callee, addend: -4, prefix: '37:rel:' }], is64: false };
    return { id: 'fn_00001', symbol: self, status: 'mismatch', score: 0.5, effectiveHash: effectiveHash(Buffer.from([0]), [0], effective), effectiveParts: parts,
      relocations: [{ offset: 37, symbol: callee, ok: true, unresolved: true, actual: 0x4e5b50 }] };
  };
  const unit = (callee) => ({ file: 'src/a.cpp', compiled: true, functions: [fn(callee)], bindings: { [self]: 'fn_00001' }, lintErrors: [], unannotated: [] });
  f.verifier.check = async () => ({ check: { units: [unit('__Traits_compare')] } });
  const changed = async (callee) => (await m.changedFunctions({ units: [unit(callee)] }, files, 'head')).map((c) => c.id);
  assert.deepEqual(await changed('??$_Traits_compare@U?$char_traits@D@std@@@std@@YAHPBDI0I@Z'), [], 'same identifier, C++ linkage');
  assert.deepEqual(await changed('??$_Traits_equal@U?$char_traits@D@std@@@std@@YA_NPBDI0I@Z'), ['fn_00001'], 'a different function');
});

test('maintenance: a thread_local moved from a deleted helper into a lambda at its call site is not a code change; reaching other data is', async (t) => {
  const f = fixture(t);
  f.store.currentVersion = () => ({ id: 1 });
  f.store.symbolMap = () => new Map([['fn_00001', { kind: 'function', addr: 0x401000 }]]);
  const m = new Maintenance({ ...f, project: f.verifier.project, log: f.verifier.log });
  const { effectiveHash } = await import('../src/shared/compare.js');
  const self = '?RegisterLuaFunctions@CTipBoxMgr@@QAE_NXZ';
  // The thread_local, its init guard and its atexit thunk: no database symbol, the scope they are
  // named after is the deleted DecryptName<K,N> on main and the call site's lambda now.
  const statics = (scope) => [`?name@?1??${scope}@4V?$EncryptedName@$0BC@$0K@@@A`, `?$TSS0@?1??${scope}@4HA`, `??__Fname@?1??${scope}@YAXXZ`];
  const fn = (scope, lands) => {
    const refs = statics(scope);
    const effective = refs.map((n, i) => `${10 + i * 6}:abs:?${n}+0`);
    const parts = { bytesHash: 'b', effective, unresolvedRefs: refs.map((n, i) => ({ index: i, name: n, addend: 0, prefix: `${10 + i * 6}:abs:` })), is64: false };
    return { id: 'fn_00001', symbol: self, status: 'exact', score: 1, effectiveHash: effectiveHash(Buffer.from([0]), [0], effective), effectiveParts: parts,
      relocations: refs.map((n, i) => ({ offset: 10 + i * 6, symbol: n, ok: true, unresolved: true, actual: lands[i] })) };
  };
  const original = [0x1357000, 0x1357010, 0x0e60000];
  const unit = (fnc) => ({ file: 'src/a.cpp', compiled: true, functions: [fnc], bindings: { [self]: 'fn_00001' }, lintErrors: [], unannotated: [] });
  f.verifier.check = async () => ({ check: { units: [unit(fn('??$DecryptName@$0K@$0BC@@?A0x1@@YAPBDAAY0BC@$$CBD@Z', original))] } });
  const changed = async (lands) => (await m.changedFunctions({ units: [unit(fn('??R<lambda_1>@?5??RegisterLuaFunctions@CTipBoxMgr@@QAE_NXZ@QBE@XZ', lands))] }, files, 'head')).map((c) => c.id);
  assert.deepEqual(await changed(original), [], 'same code, statics renamed after their new scope');
  assert.deepEqual(await changed([0x1357000, 0x1357010, 0x0e60040]), ['fn_00001'], 'a static that reaches other data is a change');
});

test('a batch that edits a unit outside its tasks merges whole: one function sent back returns it all', async (t) => {
  const f = fixture(t);
  const refactor = { ...files, 'src/caller.cpp': 'int g() { return f(); }\n' };
  f.store.run('UPDATE batches SET files_json = ? WHERE id = 1', JSON.stringify(refactor));
  f.repo.mergeOntoHead = () => ({ files: refactor, conflicts: [] });
  f.verifier.tasks.ownUnitsForTasks = () => new Set(['src/a.cpp']);
  f.verifier.check = async () => ({ check: { annotationErrors: [], units: [] }, rec: { conflicts: [], unknown: [] }, changedHeaders: [] });
  f.verifier.refreshBaselines = async () => 0;
  f.verifier.evaluate = () => ({ state: 'peer_review', score: 0.5, feedback: { summary: '' } });
  f.verifier.finish = () => {};
  f.verifier.withdraw = () => {};
  await f.verifier.verifyBatch(f.batch());
  assert.match(JSON.parse(f.batch().result_json).noSplit, /cross-unit refactor/);
  f.store.run("UPDATE batches SET state = 'open' WHERE id = 1");
  f.store.run("INSERT INTO tasks (id, symbol_id, state) VALUES (2, 'fn_00002', 'approved')");
  f.store.run("INSERT INTO attempts VALUES (2, 2, 1, 1, 'approved', NULL)");
  f.store.run("UPDATE attempts SET state = 'rejected' WHERE id = 1");
  assert.equal(f.merger.next(), null, 'its approved part never merges on its own');
});
