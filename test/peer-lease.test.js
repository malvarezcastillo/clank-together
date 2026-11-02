import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, now } from '../src/server/db.js';
import { PeerReviews } from '../src/server/peer.js';

function fixture() {
  const store = new Store(':memory:');
  store.run(`INSERT INTO versions (id, sha256, file, size, is_current, created_at) VALUES ('1.0', 'x', 'x', 1, 1, ?)`, now());
  const user = (name) => ({ id: Number(store.run(`INSERT INTO users (name, role, status, created_at) VALUES (?, 'contributor', 'active', ?)`, name, now()).lastInsertRowid) });
  const author = user('author');
  store.run(`INSERT INTO symbols (id, kind, created_at) VALUES ('fn_1', 'function', ?)`, now());
  const taskId = Number(store.run(`INSERT INTO tasks (symbol_id, state, updated_at) VALUES ('fn_1', 'peer_review', ?)`, now()).lastInsertRowid);
  const attemptId = Number(store.run(`INSERT INTO attempts (task_id, user_id, base_commit, files_json, state, created_at) VALUES (?, ?, 'base', '{}', 'peer_review', ?)`, taskId, author.id, now()).lastInsertRowid);
  return { store, user, attemptId };
}

test('a peer review claim lasts five minutes by default', () => {
  const { store, user, attemptId } = fixture();
  const peers = new PeerReviews({ store, project: { matchPolicy: {} } });
  const before = now();
  peers.claim(user('reviewer'), attemptId);
  const { expires_at: expires } = store.get('SELECT expires_at FROM peer_leases WHERE attempt_id = ?', attemptId);
  assert.ok(expires >= before + 5 * 60_000 && expires <= now() + 5 * 60_000);
});

test('leases taken under a longer limit are cut to the current one when the service starts', () => {
  const { store, user, attemptId } = fixture();
  const holder = user('holder');
  store.run('INSERT INTO peer_leases (attempt_id, reviewer_id, expires_at) VALUES (?, ?, ?)', attemptId, holder.id, now() + 60 * 60_000);
  new PeerReviews({ store, project: { matchPolicy: {} } });
  const { expires_at: expires } = store.get('SELECT expires_at FROM peer_leases WHERE attempt_id = ?', attemptId);
  assert.ok(expires <= now() + 5 * 60_000);
});
