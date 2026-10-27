import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Store, hashToken, now } from '../src/server/db.js';
import { Accounts } from '../src/server/accounts.js';
import { Merger } from '../src/server/merge.js';
import { PeerReviews } from '../src/server/peer.js';
import { createApp, DEFAULT_CONFIG } from '../src/server/app.js';
import { Verifier } from '../src/server/verify.js';

async function fixture(t) {
  const store = new Store(':memory:');
  const project = { matchPolicy: { approvals: 1, approvalsWithHeaderChanges: 2 } };
  const accounts = new Accounts(store);
  const peers = new PeerReviews({ store, project });
  const merger = new Merger({ store, project, peers });
  const server = createApp({
    store, project, accounts, peers, merger, runsWorker: false,
    config: { ...DEFAULT_CONFIG, dataDir: os.tmpdir() },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const user = (role) => {
    const id = Number(store.run(`INSERT INTO users (name, role, status, created_at) VALUES (?, ?, 'active', ?)`, role, role, now()).lastInsertRowid);
    const token = `tds_${role}`;
    store.run('INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)', id, hashToken(token), now(), now() + 60_000);
    return { id, role, cookie: `td_session=${token}` };
  };
  let nextSymbol = 0;
  const attempt = (author, state = 'in_review', batchId = null) => {
    const symbol = `fn_${++nextSymbol}`;
    store.run(`INSERT INTO symbols (id, kind, created_at) VALUES (?, 'function', ?)`, symbol, now());
    const taskId = Number(store.run('INSERT INTO tasks (symbol_id, state, updated_at) VALUES (?, ?, ?)', symbol, state, now()).lastInsertRowid);
    return Number(store.run(`INSERT INTO attempts (task_id, user_id, base_commit, files_json, state, batch_id, created_at) VALUES (?, ?, 'base', '{}', ?, ?, ?)`, taskId, author.id, state, batchId, now()).lastInsertRowid);
  };
  const post = async (path, body, { cookie, token, csrf = true } = {}) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie && { cookie }), ...(token && { authorization: `Bearer ${token}` }), ...(csrf && { 'x-td-csrf': '1' }) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { store, accounts, user, attempt, post };
}

test('admins can manually approve, request changes, and reject their own attempts', async (t) => {
  const { store, user, attempt, post } = await fixture(t);
  const admin = user('admin');
  for (const [action, state] of [['approve', 'approved'], ['request_changes', 'needs_cleanup'], ['reject', 'rejected']]) {
    const id = attempt(admin);
    const result = await post(`/api/attempts/${id}/review`, { action, comment: 'Checked the original and submission manually.' }, admin);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.state, state);
    const row = store.get('SELECT * FROM reviews WHERE attempt_id = ?', id);
    assert.equal(row.reviewer_id, admin.id);
    assert.equal(row.action, action);
    assert.equal(row.comment, 'Checked the original and submission manually.');
    assert.equal(store.get('SELECT state FROM attempts WHERE id = ?', id).state, state);
    assert.equal((await post(`/api/attempts/${id}/review`, { action }, admin)).status, 409);
  }
});

test('non-admin self-review, API-token manual review, and missing CSRF remain forbidden', async (t) => {
  const { store, accounts, user, attempt, post } = await fixture(t);
  for (const role of ['contributor', 'reviewer', 'maintainer']) {
    const author = user(role);
    const id = attempt(author);
    assert.equal((await post(`/api/attempts/${id}/review`, { action: 'approve' }, author)).status, 403);
    assert.equal(store.get('SELECT state FROM attempts WHERE id = ?', id).state, 'in_review');
    assert.equal(store.get('SELECT COUNT(*) AS n FROM reviews WHERE attempt_id = ?', id).n, 0);
  }
  const admin = user('admin');
  const id = attempt(admin);
  const token = accounts.createApiToken(admin.id, 'agent').token;
  assert.equal((await post(`/api/attempts/${id}/review`, { action: 'approve' }, { token })).status, 403);
  assert.equal((await post(`/api/attempts/${id}/review`, { action: 'approve' }, { cookie: admin.cookie, csrf: false })).status, 403);
  assert.equal((await post(`/api/attempts/${id}/review`, { action: 'approve' })).status, 401);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM reviews WHERE attempt_id = ?', id).n, 0);
});

test('admin self-review before peers finish still requires explicit manual override', async (t) => {
  const { store, user, attempt, post } = await fixture(t);
  const admin = user('admin');
  const peer = user('contributor');
  const id = attempt(admin, 'peer_review');
  store.run('INSERT INTO peer_leases (attempt_id, reviewer_id, expires_at) VALUES (?, ?, ?)', id, peer.id, now() + 60_000);
  assert.equal((await post(`/api/attempts/${id}/review`, { action: 'approve' }, admin)).status, 409);
  assert.equal((await post(`/api/peer-reviews/${id}/verdict`, { verdict: 'same', reason: 'The original and submitted logic match.' }, admin)).status, 403);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM peer_reviews WHERE attempt_id = ?', id).n, 0);
  const result = await post(`/api/attempts/${id}/review`, { action: 'approve', skipPeerReview: true }, admin);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.state, 'approved');
  assert.equal(store.get('SELECT COUNT(*) AS n FROM peer_leases WHERE attempt_id = ?', id).n, 0);
  const event = store.get(`SELECT data FROM events WHERE type = 'review' ORDER BY id DESC LIMIT 1`);
  assert.equal(JSON.parse(event.data).skippedPeerReview, true);
});

test('admin batch self-review leaves peer review alone unless explicitly skipped', async (t) => {
  const { store, user, attempt, post } = await fixture(t);
  const admin = user('admin');
  const batch = Number(store.run(`INSERT INTO batches (user_id, base_commit, files_json, state, created_at) VALUES (?, 'base', '{}', 'open', ?)`, admin.id, now()).lastInsertRowid);
  const ready = attempt(admin, 'in_review', batch);
  const pending = attempt(admin, 'peer_review', batch);
  const result = await post(`/api/batches/${batch}/review`, { action: 'approve' }, admin);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.results, [{ attemptId: ready, state: 'approved' }]);
  assert.equal(store.get('SELECT state FROM attempts WHERE id = ?', pending).state, 'peer_review');
  const skipped = await post(`/api/batches/${batch}/review`, { action: 'approve', attemptIds: [pending], skipPeerReview: true }, admin);
  assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
  assert.deepEqual(skipped.body.results, [{ attemptId: pending, state: 'approved' }]);
});

test('identical resubmissions retain an explicit review waiver without inventing peer votes', async (t) => {
  const { store, user, attempt, post } = await fixture(t);
  const admin = user('admin');
  const original = attempt(admin, 'peer_review');
  const hash = 'same-compiled-code';
  store.run('UPDATE attempts SET result_json=? WHERE id=?', JSON.stringify({ feedback: { target: { codeHash: hash } } }), original);
  assert.equal((await post(`/api/attempts/${original}/review`, { action: 'approve', skipPeerReview: true }, admin)).status, 200);
  const taskId = store.get('SELECT task_id FROM attempts WHERE id=?', original).task_id;
  const resubmit = () => Number(store.run(`INSERT INTO attempts(task_id,user_id,base_commit,files_json,state,created_at) VALUES(?,?,'new-main','{}','verifying',?)`, taskId,admin.id,now()).lastInsertRowid);
  const peers = new PeerReviews({ store, project: { matchPolicy: {} } });
  const verifier = Object.create(Verifier.prototype);
  Object.assign(verifier, { store, peers });
  const identical = resubmit();
  assert.equal(verifier.carryOver(store.get('SELECT * FROM attempts WHERE id=?', identical), { codeHash: hash }), true);
  assert.equal(peers.confirmed(identical), true, 'merge verification must see the same confirmation as initial verification');
  assert.equal(store.get('SELECT peer_skipped FROM attempts WHERE id=?', identical).peer_skipped, 1);
  assert.equal(store.get('SELECT COUNT(*) n FROM peer_reviews WHERE attempt_id=?', identical).n, 0);
  const audit = JSON.parse(store.get("SELECT data FROM events WHERE type='review_waiver_carried' ORDER BY id DESC LIMIT 1").data);
  assert.deepEqual(audit, { attempt: identical, from: original, codeHash: hash });
  const changed = resubmit();
  assert.equal(verifier.carryOver(store.get('SELECT * FROM attempts WHERE id=?', changed), { codeHash: 'different-code' }), false);
  assert.equal(peers.confirmed(changed), false, 'changed code does not inherit the waiver');
  assert.equal(store.get('SELECT regressions_accepted FROM attempts WHERE id=?', identical).regressions_accepted, 0, 'score overrides are not transferred');
});
