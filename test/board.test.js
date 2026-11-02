import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, now } from '../src/server/db.js';
import { snapshot, diff, folderOf } from '../src/server/board.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-board-'));
  const s = new Store(path.join(dir, 'td.sqlite'));
  t.after(() => {
    s.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  s.run(`INSERT INTO versions (id, sha256, file, size, is_current, created_at) VALUES ('1.0', 'x', 'x', 1, 1, ?)`, now());
  const user = (name) => Number(s.run(`INSERT INTO users (name, role, status, created_at) VALUES (?, 'contributor', 'active', ?)`, name, now()).lastInsertRowid);
  let addr = 0x401000;
  const task = (state, unit = 'Source/UI/Chat/Box.cpp', extra = {}) => {
    const symbol = s.ensureSymbol({ kind: 'function', versionId: '1.0', addr: (addr += 0x40), size: 8, unit }).symbol.id;
    return Number(s.run(`INSERT INTO tasks (symbol_id, state, lease_user, preferred_until, updated_at) VALUES (?, ?, ?, ?, ?)`, symbol, state, extra.lease ?? null, extra.until ?? null, extra.at ?? now()).lastInsertRowid);
  };
  const batch = (userId, state, kind = 'code') => Number(s.run(`INSERT INTO batches (user_id, kind, base_commit, files_json, state, created_at) VALUES (?, ?, 'c', '{}', ?, ?)`, userId, kind, state, now()).lastInsertRowid);
  const attempt = (taskId, userId, batchId, state, summary = null) =>
    Number(s.run(`INSERT INTO attempts (task_id, user_id, batch_id, base_commit, files_json, state, result_json, created_at) VALUES (?, ?, ?, 'c', '{}', ?, ?, ?)`,
      taskId, userId, batchId, state, JSON.stringify({ feedback: { summary } }), now()).lastInsertRowid);
  return { s, user, task, batch, attempt };
}

test('each unfinished function sits in its stage; finished ones are not on the board', (t) => {
  const { s, user, task, batch, attempt } = fixture(t);
  const ann = user('ann');
  const bob = user('bob');
  const open = task('open');
  const leased = task('leased', 'Source/Client/Mode/GameMode.cpp', { lease: bob });
  const queued = task('verifying');
  attempt(queued, ann, batch(ann, 'queued'), 'queued');
  const compiling = task('verifying');
  const building = batch(ann, 'verifying');
  attempt(compiling, ann, building, 'verifying');
  const review = task('peer_review');
  const reviewed = attempt(review, ann, batch(ann, 'open'), 'peer_review');
  s.run(`INSERT INTO peer_reviews (attempt_id, reviewer_id, verdict, weight, reason, created_at) VALUES (?, ?, 'same', 1, 'r', ?)`, reviewed, bob, now());
  const merging = task('merging');
  attempt(merging, ann, batch(ann, 'merging'), 'approved');
  const back = task('needs_cleanup', 'Source/UI/Chat/Box.cpp', { until: now() + 3600_000 });
  attempt(back, ann, batch(ann, 'returned'), 'needs_cleanup', 'compilation failed');
  const done = task('done');
  attempt(done, ann, batch(ann, 'merged'), 'merged');
  task('skipped');

  const b = snapshot(s, { builds: [{ job: `batch-${building}`, lane: 'verify', batch: building, done: 3, total: 4, startedAt: '2026-11-02T12:00:00.000Z', active: true }, { job: 'batch-1', lane: 'verify', batch: 1, done: 9, total: 9, active: false }] });
  const at = Object.fromEntries(b.functions.map((f) => [f.task, f]));
  assert.deepEqual(b.counts, { open: 1, leased: 1, queued: 1, compiling: 1, review: 1, merging: 1, back: 1 });
  assert.equal(at[open], undefined, 'open functions are counted per folder, not listed');
  assert.deepEqual(b.folders.open, { 'Source/UI': 1 });
  assert.equal(at[done], undefined, 'merged functions leave the board');
  assert.equal(at[leased].stage, 'leased');
  assert.equal(at[leased].who, 'bob');
  assert.equal(at[queued].stage, 'queued');
  assert.equal(at[compiling].stage, 'compiling');
  assert.deepEqual(at[compiling].build, { done: 3, total: 4 });
  assert.deepEqual(at[review].votes, { same: 1, different: 0 });
  assert.equal(at[merging].stage, 'merging');
  assert.equal(at[back].why, 'compilation failed');
  assert.equal(at[back].blocker.kind, 'reserved');
  assert.deepEqual(b.builds, [{ job: `batch-${building}`, lane: 'verify', batch: building, done: 3, total: 4, startedAt: '2026-11-02T12:00:00.000Z', author: 'ann' }], 'a stale job folder is not a running build');
});

test('a running maintenance batch holds the queue; a build retry says until when', (t) => {
  const { s, user, task, batch, attempt } = fixture(t);
  const ann = user('ann');
  const waiting = task('verifying');
  attempt(waiting, ann, batch(ann, 'queued'), 'queued');
  const retried = task('verifying');
  const later = batch(ann, 'queued');
  s.run(`UPDATE batches SET result_json = json_object('buildRetry', json_object('retryAt', ?)) WHERE id = ?`, now() + 60_000, later);
  attempt(retried, ann, later, 'queued');
  const maint = batch(ann, 'verifying', 'maintenance');
  const b = snapshot(s);
  const at = Object.fromEntries(b.functions.map((f) => [f.task, f]));
  assert.deepEqual(at[waiting].blocker, { kind: 'maintenance', batch: maint });
  assert.equal(at[retried].blocker.kind, 'retry');
});

test('the live diff sends moves and removals only, and nothing when the board is still', (t) => {
  const { s, user, task, batch, attempt } = fixture(t);
  const ann = user('ann');
  const a = task('peer_review');
  const attemptA = attempt(a, ann, batch(ann, 'open'), 'peer_review');
  const b = task('leased', 'Source/UI/Chat/Box.cpp', { lease: ann, at: 1000 });
  const first = snapshot(s, { now: 5000 });
  assert.equal(diff(first, snapshot(s, { now: 5000 })), null);

  s.run(`UPDATE tasks SET state = 'done' WHERE id = ?`, a);
  s.run(`UPDATE attempts SET state = 'merged' WHERE id = ?`, attemptA);
  s.run(`UPDATE tasks SET state = 'verifying' WHERE id = ?`, b);
  attempt(b, ann, batch(ann, 'queued'), 'queued');
  const change = diff(first, snapshot(s, { now: 5000 }));
  assert.deepEqual(change.remove, [a], 'the merged function disappears');
  assert.deepEqual(change.upsert.map((f) => [f.task, f.stage]), [[b, 'queued']]);
});

test('a column over the cap is counted per folder instead of listed', (t) => {
  const { s, task } = fixture(t);
  for (let i = 0; i < 3; i++) task('needs_cleanup');
  const b = snapshot(s, { cap: 2 });
  assert.ok(b.overflow.includes('back'));
  assert.equal(b.functions.length, 0);
  assert.deepEqual(b.folders.back, { 'Source/UI': 3 });
  assert.equal(folderOf('Source/Render/Primitives/AlphaRectangle.cpp'), 'Source/Render');
  assert.equal(folderOf(null), '(unplaced)');
});
