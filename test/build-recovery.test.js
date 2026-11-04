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
    mergeOntoHead: () => ({ files, conflicts: [] }), show: () => files['src/a.cpp'], commitFiles: () => assert.fail('must not commit') };
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
