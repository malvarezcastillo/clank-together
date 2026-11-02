import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, now } from '../src/server/db.js';
import { AUTHOR_HOLD_MS, AUTHOR_TRIES, returnBatch } from '../src/server/batches.js';
import { Tasks } from '../src/server/tasks.js';

test('a function sent back is held for its author 20 minutes; older, longer holds end 20 minutes after their send-back', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-hold-'));
  const file = path.join(dir, 'td.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let s = new Store(file);
  s.run(`INSERT INTO versions (id, sha256, file, size, is_current, created_at) VALUES ('1.0', 'x', 'x', 1, 1, ?)`, now());
  const user = Number(s.run(`INSERT INTO users (name, role, status, created_at) VALUES ('ann', 'contributor', 'active', ?)`, now()).lastInsertRowid);
  const task = (addr, state, until = null) => {
    const symbol = s.ensureSymbol({ kind: 'function', versionId: '1.0', addr, size: 8 }).symbol.id;
    return Number(s.run(`INSERT INTO tasks (symbol_id, state, preferred_user, preferred_until, updated_at) VALUES (?, ?, ?, ?, ?)`, symbol, state, until ? user : null, until, now()).lastInsertRowid);
  };
  const sent = task(0x401000, 'verifying');
  const batch = Number(s.run(`INSERT INTO batches (user_id, base_commit, files_json, state, created_at) VALUES (?, 'c', '{}', 'verifying', ?)`, user, now()).lastInsertRowid);
  s.run(`INSERT INTO attempts (task_id, user_id, batch_id, base_commit, files_json, state, created_at) VALUES (?, ?, ?, 'c', '{}', 'verifying', ?)`, sent, user, batch, now());

  const before = now();
  returnBatch(s, batch, 'compilation failed');
  const held = s.get('SELECT preferred_user, preferred_until FROM tasks WHERE id = ?', sent);
  assert.equal(AUTHOR_HOLD_MS, 20 * 60_000);
  assert.equal(held.preferred_user, user);
  assert.ok(held.preferred_until >= before + AUTHOR_HOLD_MS && held.preferred_until <= now() + AUTHOR_HOLD_MS);

  const legacy = task(0x401040, 'needs_cleanup', now() + 5 * 3600_000);
  s.run('UPDATE tasks SET updated_at = ? WHERE id = ?', now() - 3600_000, legacy);
  const recent = task(0x4010c0, 'needs_cleanup', now() + 6 * 3600_000);
  const short = task(0x401080, 'needs_cleanup', now() + 5 * 60_000);
  const shortUntil = s.get('SELECT preferred_until FROM tasks WHERE id = ?', short).preferred_until;
  s.db.close();
  s = new Store(file);
  try {
    const until = (id) => s.get('SELECT preferred_until FROM tasks WHERE id = ?', id).preferred_until;
    assert.ok(until(legacy) < now(), 'sent back an hour ago: no longer reserved');
    assert.ok(until(recent) <= now() + AUTHOR_HOLD_MS && until(recent) > now() + AUTHOR_HOLD_MS - 60_000, 'sent back just now: 20 minutes left');
    assert.equal(until(short), shortUntil, 'a shorter hold is kept as it is');
  } finally {
    s.db.close();
  }
});

test('after three of its author\'s attempts came back, a function is open to everyone and no longer held for them', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-tries-'));
  const s = new Store(path.join(dir, 'td.sqlite'));
  t.after(() => {
    s.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  s.run(`INSERT INTO versions (id, sha256, file, size, is_current, created_at) VALUES ('1.0', 'x', 'x', 1, 1, ?)`, now());
  const user = (name) => Number(s.run(`INSERT INTO users (name, role, status, created_at) VALUES (?, 'contributor', 'active', ?)`, name, now()).lastInsertRowid);
  const ann = user('ann');
  const bob = user('bob');
  const symbol = s.ensureSymbol({ kind: 'function', versionId: '1.0', addr: 0x402000, size: 8 }).symbol.id;
  const task = Number(s.run(`INSERT INTO tasks (symbol_id, state, updated_at) VALUES (?, 'verifying', ?)`, symbol, now()).lastInsertRowid);
  const submit = (who) => {
    s.run(`UPDATE tasks SET state = 'verifying' WHERE id = ?`, task);
    const batch = Number(s.run(`INSERT INTO batches (user_id, base_commit, files_json, state, created_at) VALUES (?, 'c', '{}', 'verifying', ?)`, who, now()).lastInsertRowid);
    s.run(`INSERT INTO attempts (task_id, user_id, batch_id, base_commit, files_json, state, created_at) VALUES (?, ?, ?, 'c', '{}', 'verifying', ?)`, task, who, batch, now());
    returnBatch(s, batch, 'compilation failed');
    return s.get('SELECT preferred_user, preferred_until FROM tasks WHERE id = ?', task);
  };
  const tasks = new Tasks({ store: s, repo: { head: () => 'c' }, project: { matchPolicy: { maxCleanupCycles: 99 } }, config: {} });

  assert.equal(AUTHOR_TRIES, 3);
  for (let i = 1; i < AUTHOR_TRIES; i++) assert.equal(submit(ann).preferred_user, ann, `try ${i}: still ann's to fix`);
  assert.throws(() => tasks.claim({ id: bob, name: 'bob' }, task), /reserved for the author/, 'bob waits while ann holds it');

  const third = submit(ann);
  assert.equal(third.preferred_user, null, 'the third try that came back releases it');
  assert.equal(third.preferred_until, null);
  assert.equal(tasks.claim({ id: bob, name: 'bob' }, task), task, 'another agent may take it at once');

  s.run(`UPDATE tasks SET state = 'verifying', lease_user = NULL WHERE id = ?`, task);
  assert.equal(submit(bob).preferred_user, bob, 'a new author gets their own three tries');
});
