import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, now } from '../src/server/db.js';
import { Tasks } from '../src/server/tasks.js';
import { Maintenance } from '../src/server/maintenance.js';

function fixture() {
  const store = new Store(':memory:');
  store.run(`INSERT INTO versions (id, sha256, file, size, is_current, created_at) VALUES ('1.0', 'x', 'x', 1, 1, ?)`, now());
  const user = (name, role = 'contributor') => ({ id: Number(store.run(`INSERT INTO users (name, role, status, created_at) VALUES (?, ?, 'active', ?)`, name, role, now()).lastInsertRowid), name, role });
  const tasks = new Tasks({ store, repo: { head: () => 'c' }, project: { matchPolicy: { maxCleanupCycles: 99 } }, config: {} });
  const batch = (who, state, kind = 'code') => Number(store.run(`INSERT INTO batches (user_id, base_commit, files_json, state, kind, created_at) VALUES (?, 'c', '{}', ?, ?, ?)`, who.id, state, kind, now()).lastInsertRowid);
  const attempt = (who, batchId, addr, state) => {
    const symbol = store.ensureSymbol({ kind: 'function', versionId: '1.0', addr, size: 8 }).symbol.id;
    const task = Number(store.run(`INSERT INTO tasks (symbol_id, state, updated_at) VALUES (?, ?, ?)`, symbol, state, now()).lastInsertRowid);
    const id = Number(store.run(`INSERT INTO attempts (task_id, user_id, batch_id, base_commit, files_json, state, created_at) VALUES (?, ?, ?, 'c', '{}', ?, ?)`, task, who.id, batchId, state, now()).lastInsertRowid);
    return { id, task };
  };
  return { store, tasks, user, batch, attempt };
}

test('a batch of any unfinished state is cancelled whole; its functions go back to the author', () => {
  const { store, tasks, user, batch, attempt } = fixture();
  const ann = user('ann');
  for (const state of ['queued', 'verifying', 'open', 'merging']) {
    const b = batch(ann, state);
    const attemptState = { queued: 'queued', verifying: 'verifying', open: 'peer_review', merging: 'approved' }[state];
    const a = attempt(ann, b, 0x401000 + 0x100 * ['queued', 'verifying', 'open', 'merging'].indexOf(state), attemptState);
    const r = tasks.cancelBatch(ann, b);
    assert.equal(r.was, state);
    assert.deepEqual(r.withdrawn, [a.id]);
    assert.equal(store.get('SELECT state FROM batches WHERE id = ?', b).state, 'returned');
    assert.equal(store.get('SELECT state FROM attempts WHERE id = ?', a.id).state, 'withdrawn');
    const t = store.get('SELECT state, lease_user FROM tasks WHERE id = ?', a.task);
    assert.deepEqual([t.state, t.lease_user], ['leased', ann.id], `${state}: the function is back in ann's claim`);
  }
});

test('only the author or an admin cancels, and only an unfinished batch', () => {
  const { tasks, user, batch } = fixture();
  const ann = user('ann');
  const bob = user('bob');
  const boss = user('boss', 'admin');
  const b = batch(ann, 'queued', 'maintenance');
  assert.throws(() => tasks.cancelBatch(bob, b), /no such batch of yours/);
  assert.equal(tasks.cancelBatch(boss, b).state, 'cancelled', 'an admin may cancel anyone\'s');
  assert.throws(() => tasks.cancelBatch(ann, b), /is returned; only batches that have not finished/);
  assert.throws(() => tasks.cancelBatch(ann, batch(ann, 'merged')), /is merged/);
});

test('a maintenance batch cancelled while it verifies records nothing and commits nothing', async () => {
  const { store, tasks, user, batch } = fixture();
  const ann = user('ann', 'maintainer');
  const b = batch(ann, 'verifying', 'maintenance');
  let committed = false;
  const m = new Maintenance({ store, repo: {}, project: {}, verifier: {}, merger: {}, log: { info() {}, error() {} } });
  m.verifyAndMerge = async () => {
    tasks.cancelBatch(ann, b);
    committed = true; // what a merge outcome would report; run() must not record it
    return { state: 'merged', commit: 'abc', result: {} };
  };
  await m.run(b);
  assert.ok(committed);
  const row = store.get('SELECT state, merged_commit, result_json FROM batches WHERE id = ?', b);
  assert.equal(row.state, 'returned');
  assert.equal(row.merged_commit, null);
  assert.equal(JSON.parse(row.result_json).cancelled, true);
});
