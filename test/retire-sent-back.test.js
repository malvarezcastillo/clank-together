import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, now } from '../src/server/db.js';
import { retireSentBack } from '../src/server/batches.js';
import { Quality } from '../src/server/quality.js';
import { Credits } from '../src/server/credits.js';

function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-retire-'));
  const file = path.join(dir, 'td.sqlite');
  const s = new Store(file);
  t.after(() => {
    if (s.db.isOpen) s.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { s, file };
}

function seed(s) {
  s.run(`INSERT INTO versions (id, sha256, file, size, is_current, created_at) VALUES ('1.0', 'x', 'x', 1, 1, ?)`, now());
  const user = (name) => Number(s.run(`INSERT INTO users (name, role, status, created_at) VALUES (?, 'contributor', 'active', ?)`, name, now()).lastInsertRowid);
  const author = user('author');
  const reviewers = [user('r1'), user('r2'), user('r3')];
  const task = (addr, state) => {
    const symbol = s.ensureSymbol({ kind: 'function', versionId: '1.0', addr, size: 8 }).symbol.id;
    return Number(s.run(`INSERT INTO tasks (symbol_id, state, updated_at) VALUES (?, ?, ?)`, symbol, state, now()).lastInsertRowid);
  };
  const attempt = (taskId, state, summary) =>
    Number(s.run(`INSERT INTO attempts (task_id, user_id, base_commit, files_json, state, result_json, created_at) VALUES (?, ?, 'c', '{}', ?, ?, ?)`,
      taskId, author, state, JSON.stringify({ feedback: { summary } }), now()).lastInsertRowid);
  return { author, reviewers, task, attempt };
}

const state = (s, id) => s.get('SELECT state, result_json FROM attempts WHERE id = ?', id);

test('finishing a function retires its older sent-back attempts, keeping why they came back', (t) => {
  const { s } = store(t);
  const { task, attempt } = seed(s);
  const finished = task(0x401000, 'done');
  const old = attempt(finished, 'needs_cleanup', 'compilation failed');
  const returned = attempt(finished, 'returned', null);
  const merged = attempt(finished, 'merged', null);
  const open = task(0x401040, 'needs_cleanup');
  const stillWanted = attempt(open, 'needs_cleanup', 'compilation failed');

  retireSentBack(s, finished, 'fn was merged by batch 9');
  retireSentBack(s, open, 'not finished');

  const r = state(s, old);
  assert.equal(r.state, 'superseded');
  assert.deepEqual(JSON.parse(r.result_json), { feedback: { summary: 'compilation failed' }, retired: 'needs_cleanup', retiredBecause: 'fn was merged by batch 9' });
  assert.equal(state(s, returned).state, 'superseded');
  assert.equal(state(s, merged).state, 'merged');
  assert.equal(state(s, stillWanted).state, 'needs_cleanup', 'an unfinished task keeps its work to do');
});

test('the one-time sweep retires attempts of finished tasks once; quality and reviewer credit still count them', (t) => {
  const { s, file } = store(t);
  const { author, reviewers, task, attempt } = seed(s);
  const done = task(0x402000, 'done');
  const skipped = task(0x402040, 'skipped');
  const open = task(0x402080, 'needs_cleanup');
  const broken = attempt(done, 'needs_cleanup', 'compilation failed');
  const objected = attempt(skipped, 'needs_cleanup', 'not byte-identical');
  const pending = attempt(open, 'needs_cleanup', 'compilation failed');
  for (const r of reviewers) s.run(`INSERT INTO peer_reviews (attempt_id, reviewer_id, verdict, weight, reason, created_at) VALUES (?, ?, 'different', 1, 'differs', ?)`, objected, r, now());
  s.run(`DELETE FROM meta WHERE key = 'migration_retire_finished_sent_back'`);
  const before = new Quality({ store: s }).numbers(author, null, 0);

  s.retireFinishedSentBack();
  assert.equal(state(s, broken).state, 'superseded');
  assert.equal(state(s, objected).state, 'superseded');
  assert.equal(state(s, pending).state, 'needs_cleanup');

  const later = attempt(done, 'needs_cleanup', 'compilation failed');
  s.db.close();
  const reopened = new Store(file);
  try {
    assert.equal(state(reopened, later).state, 'needs_cleanup', 'the sweep runs once; later ones are the merge path\'s job');
    assert.deepEqual(new Quality({ store: reopened }).numbers(author, null, 0), { ...before, submitted: before.submitted + 1, broken: before.broken + 1, brokenRate: (before.broken + 1) / (before.submitted + 1) });
    new Credits({ store: reopened }).sync();
    for (const r of reviewers) assert.ok(reopened.get(`SELECT 1 FROM credit_ledger WHERE user_id = ? AND reason = 'review'`, r), 'an upheld objection still pays its reviewer');
  } finally {
    reopened.db.close();
  }
});
