import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fixture, FN_ADDR, CALLEE_ADDR, GLOBAL_ADDR } from './helpers.js';
import { openServer, createApp } from '../src/server/app.js';
import { Store, now } from '../src/server/db.js';
import { STATUS } from '../src/shared/compare.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let dataDir, ctx, server, base;
const quiet = { info() {}, error() {}, warn() {} };

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-test-'));
  fs.writeFileSync(path.join(dataDir, 'server.json'), JSON.stringify({ listen: { host: '127.0.0.1', port: 0 }, verifyConcurrency: 1 }));
  const repoDir = path.join(dataDir, 'repo');
  fs.cpSync(path.join(ROOT, 'template'), repoDir, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: repoDir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

  const store = new Store(path.join(dataDir, 'td.sqlite'));
  const exe = path.join(dataDir, 'target.exe');
  const pe = fixture().pe;
  fs.writeFileSync(exe, pe);
  store.run('INSERT INTO versions (id, sha256, file, size, is_current, created_at) VALUES (?, ?, ?, ?, 1, ?)', '1.0', crypto.createHash('sha256').update(pe).digest('hex'), exe, pe.length, now());
  store.ensureSymbol({ kind: 'function', versionId: '1.0', addr: FN_ADDR, size: 15 });
  store.ensureSymbol({ kind: 'function', versionId: '1.0', addr: CALLEE_ADDR, size: 1, name: 'Callee' });
  store.db.close();

  ctx = openServer(dataDir, { log: quiet });
  ctx.tasks.generate();
  ctx.verifier.start();
  server = createApp(ctx);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  ctx.config.publicUrl = base;
});

after(() => {
  ctx.verifier.stop();
  server.close();
  ctx.store.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(method, p, body, { token, cookie, csrf = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  if (cookie && csrf) headers['x-td-csrf'] = '1';
  const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json(), setCookie: res.headers.get('set-cookie') };
}
const call = (method, p, body, token) => request(method, p, body, { token });

const PASSWORD = 'correct horse battery';
/** Creates an approved account and returns an API token for it. */
async function activeUser(name, role = 'contributor') {
  await ctx.accounts.createUser(name, role, PASSWORD);
  return ctx.accounts.createApiToken(ctx.accounts.byName(name).id, 'test').token;
}
async function login(name, password = PASSWORD) {
  const r = await request('POST', '/api/login', { name, password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.setCookie.split(';')[0];
}

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('public info, symbol snapshot, and the target is not served by default', async () => {
  const info = (await call('GET', '/api/info')).body;
  assert.equal(info.version.id, '1.0');
  assert.match(info.version.sha256, /^[0-9a-f]{64}$/);
  assert.equal(info.version.download, null);
  assert.equal((await fetch(`${base}/api/target/1.0`)).status, 404);

  // "contributors": approved accounts only.
  ctx.config.distributeTarget = 'contributors';
  assert.equal((await fetch(`${base}/api/target/1.0`)).status, 401);
  const token = await activeUser('downloader');
  const res = await fetch(`${base}/api/target/1.0`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), info.version.sha256);
  ctx.config.distributeTarget = false;
  const snap = (await call('GET', '/api/symbols')).body;
  assert.deepEqual(snap.symbols.map((s) => s[0]).sort(), ['fn_00001', 'fn_00002']);
});

test('the repository can be cloned over HTTP but not pushed to', async () => {
  const dest = path.join(dataDir, 'clone');
  await promisify(execFile)("git", ["clone", "-q", `${base}/repo.git`, dest]);
  assert.ok(fs.existsSync(path.join(dest, 'decomp.json')));
  const res = await fetch(`${base}/repo.git/info/refs?service=git-receive-pack`);
  assert.equal(res.status, 403);
});

test('claim and static-gate rejection', async () => {
  const token = await activeUser('alice');
  assert.equal((await call('GET', '/api/me', null, token)).body.name, 'alice');
  assert.equal((await call('GET', '/api/me', null, 'td_bogus')).status, 401);

  const claim = await call('POST', '/api/tasks/claim', {}, token);
  assert.equal(claim.status, 200);
  const ctxBody = claim.body;
  assert.equal(ctxBody.annotation, `// FUNCTION: ${ctxBody.symbol.id}`);
  assert.ok(ctxBody.allowedPaths.includes('include/**'));

  const head = ctx.repo.head();
  const sub = await call('POST', `/api/tasks/${ctxBody.task.id}/submit`, { baseCommit: head, files: { 'src/player.cpp': `// FUNCTION: ${ctxBody.symbol.id}\nvoid f() { __asm nop }\n` } }, token);
  assert.equal(sub.status, 200);

  const result = await waitFor(async () => {
    const r = (await call('GET', `/api/attempts/${sub.body.attemptId}`, null, token)).body;
    return ['rejected', 'needs_cleanup', 'in_review'].includes(r.state) && r;
  });
  assert.equal(result.state, 'rejected');
  assert.ok(result.feedback.lintErrors.some((e) => e.message.includes('inline assembly')));
  assert.equal(ctx.tasks.get(ctxBody.task.id).state, 'open');

  // Lease is gone after submitting.
  assert.equal((await call('POST', `/api/tasks/${ctxBody.task.id}/heartbeat`, {}, token)).status, 409);
});

test('symbol allocation returns stable IDs', async () => {
  const token = await activeUser('bob');
  const a = (await call('POST', '/api/symbols', { kind: 'global', addr: '0x' + GLOBAL_ADDR.toString(16), name: 'g_val' }, token)).body;
  assert.match(a.id, /^gl_\d{5}$/);
  assert.equal(a.annotation, `// GLOBAL: ${a.id}`);
  const again = (await call('POST', '/api/symbols', { kind: 'global', addr: '0x' + GLOBAL_ADDR.toString(16) }, token)).body;
  assert.equal(again.id, a.id);
  assert.equal(again.created, false);
  assert.equal((await call('POST', '/api/symbols', { kind: 'global', addr: '0x401000' }, token)).status, 400);
  assert.equal((await call('POST', '/api/symbols', { kind: 'global', addr: '0x900000' }, token)).status, 400);
});

test('review rules: no self review, approval moves to merge queue', async () => {
  const author = ctx.store.get(`SELECT id FROM users WHERE name = 'alice'`);
  const task = ctx.store.get(`SELECT * FROM tasks WHERE state = 'open' LIMIT 1`);
  const attemptId = Number(
    ctx.store.run(`INSERT INTO attempts (task_id, user_id, base_commit, files_json, state, result_json, created_at) VALUES (?, ?, ?, '{}', 'in_review', '{}', ?)`, task.id, author.id, ctx.repo.head(), now()).lastInsertRowid,
  );
  ctx.store.run(`UPDATE tasks SET state = 'in_review' WHERE id = ?`, task.id);

  const alice = ctx.store.get(`SELECT * FROM users WHERE name = 'alice'`);
  ctx.store.run(`UPDATE users SET role = 'reviewer' WHERE id = ?`, alice.id);
  assert.throws(() => ctx.merger.review({ ...alice, role: 'reviewer' }, attemptId, 'approve'), /own attempt/);

  ctx.merger.pump = async () => {}; // merging needs a real compiler
  const carolToken = await activeUser('carol', 'reviewer');
  // Reviews need a browser session; an API token is not enough.
  assert.equal((await call('GET', '/api/review/queue', null, carolToken)).status, 403);
  const cookie = await login('carol');
  const queue = await request('GET', '/api/review/queue', null, { cookie });
  assert.ok(queue.body.some((q) => q.id === attemptId));
  const r = await request('POST', `/api/attempts/${attemptId}/review`, { action: 'approve' }, { cookie });
  assert.equal(r.body.state, 'approved');
  assert.equal(ctx.tasks.get(task.id).state, 'approved');
  // Stop the merger from picking it up (it would need a compiler).
  ctx.store.run(`UPDATE tasks SET state = 'done' WHERE id = ?`, task.id);
});

test('evaluate routes results', () => {
  const fn = (status, score) => ({ id: 'fn_00001', status, score, relocations: [] });
  const check = (f, extra = {}) => ({ annotationErrors: [], units: [{ file: 'src/a.cpp', compiled: true, lintErrors: [], functions: f ? [f] : [], unannotated: [], ...extra }] });
  const rec = { conflicts: [], unknown: [], learned: [] };
  const ev = (c, r = rec) => ctx.verifier.evaluate({ check: c, rec: r, targetId: 'fn_00001', files: { 'src/a.cpp': '' }, changedHeaders: [] });

  assert.equal(ev(check(fn(STATUS.EXACT, 1))).state, 'in_review');
  assert.equal(ev(check(fn(STATUS.UNRESOLVED, 1))).state, 'in_review');
  assert.equal(ev(check(fn(STATUS.MISMATCH, 0.8))).state, 'peer_review');
  assert.equal(ev(check(fn(STATUS.MISSING, 0))).state, 'needs_cleanup');
  assert.equal(ev(check(null)).state, 'needs_cleanup');
  assert.equal(ev(check(fn(STATUS.EXACT, 1), { compiled: false, log: 'error C2065' })).state, 'needs_cleanup');
  assert.equal(ev(check(fn(STATUS.EXACT, 1), { lintErrors: [{ message: 'x' }] })).state, 'rejected');
  // A definitively wrong reference of the target bounces; an ambiguity elsewhere does not.
  const withRef = { ...fn(STATUS.UNRESOLVED, 1), relocations: [{ symbol: '?Foo@@YAXXZ', ok: true, unresolved: true }] };
  assert.equal(ev(check(withRef), { ...rec, conflicts: [{ symbol: '?Foo@@YAXXZ', hard: true, message: 'Foo is elsewhere' }] }).state, 'needs_cleanup');
  assert.equal(ev(check(withRef), { ...rec, conflicts: [{ symbol: '?Bar@@YAXXZ', hard: true, message: 'Bar is elsewhere' }] }).state, 'in_review');
  assert.equal(ev(check(withRef), { ...rec, conflicts: [{ symbol: '?Foo@@YAXXZ', message: 'Foo seen twice' }] }).state, 'in_review');
});

test('regressions are detected against func_status', () => {
  ctx.store.run(`INSERT INTO func_status (symbol_id, file, status, score, commit_hash, updated_at) VALUES ('fn_00002', 'src/a.cpp', 'exact', 1, 'x', 0)`);
  const check = { annotationErrors: [], units: [{ file: 'src/a.cpp', compiled: true, lintErrors: [], functions: [{ id: 'fn_00002', status: STATUS.MISMATCH, score: 0.5 }], unannotated: [] }] };
  assert.deepEqual(ctx.verifier.regressions(check).map((r) => r.id), ['fn_00002']);
  ctx.store.run(`DELETE FROM func_status`);
});

test('expired leases return to the pool', async () => {
  const token = await activeUser('dave');
  const c = (await call('POST', '/api/tasks/claim', {}, token)).body;
  ctx.store.run('UPDATE tasks SET lease_expires = 1 WHERE id = ?', c.task.id);
  assert.equal(ctx.tasks.sweepExpired(), 1);
  assert.notEqual(ctx.tasks.get(c.task.id).state, 'leased');
});

test('registration needs admin approval before anything works', async () => {
  const reg = await request('POST', '/api/register', { name: 'erin', password: PASSWORD });
  assert.equal(reg.status, 200);
  assert.equal(reg.body.status, 'pending');
  assert.equal(reg.body.token, undefined);
  assert.equal((await request('POST', '/api/register', { name: 'ERIN', password: PASSWORD })).status, 409, 'names are case-insensitive');
  assert.equal((await request('POST', '/api/register', { name: 'shorty', password: 'short' })).status, 400);

  const pending = await request('POST', '/api/login', { name: 'erin', password: PASSWORD });
  assert.equal(pending.status, 403);
  assert.match(pending.body.error, /approval/);
  assert.equal((await request('POST', '/api/login', { name: 'erin', password: 'wrong password!!' })).status, 401);

  await ctx.accounts.createUser('root', 'admin', PASSWORD);
  const admin = await login('root');
  const list = await request('GET', '/api/admin/users?status=pending', null, { cookie: admin });
  assert.deepEqual(list.body.users.map((u) => u.name), ['erin']);
  assert.equal((await request('POST', '/api/admin/users/erin/approve', {}, { cookie: admin, csrf: false })).status, 403, 'CSRF header required');
  assert.equal((await request('POST', '/api/admin/users/erin/approve', {}, { cookie: admin })).status, 200);

  const erin = await login('erin');
  const me = await request('GET', '/api/me', null, { cookie: erin });
  assert.equal(me.body.via, 'session');
  assert.equal((await request('GET', '/api/admin/users', null, { cookie: erin })).status, 403, 'contributors are not admins');
});

test('API tokens: created in the browser, limited scope, revocable', async () => {
  const erin = await login('erin');
  const t = await request('POST', '/api/me/tokens', { label: 'laptop' }, { cookie: erin });
  assert.equal(t.status, 200);
  assert.match(t.body.token, /^td_/);
  const token = t.body.token;

  assert.equal((await call('GET', '/api/me', null, token)).body.name, 'erin');
  assert.equal((await call('GET', '/api/tasks', null, token)).status, 200);
  // A token cannot mint more tokens or touch accounts.
  assert.equal((await call('POST', '/api/me/tokens', { label: 'x' }, token)).status, 403);
  assert.equal((await call('POST', '/api/me/password', { current: PASSWORD, password: 'something else 123' }, token)).status, 403);

  const list = (await request('GET', '/api/me/tokens', null, { cookie: erin })).body;
  assert.equal(list[0].label, 'laptop');
  assert.ok(list[0].last_used_at, 'last use is recorded');
  assert.equal((await request('POST', `/api/me/tokens/${t.body.id}/revoke`, {}, { cookie: erin })).status, 200);
  assert.equal((await call('GET', '/api/me', null, token)).status, 401, 'revoked token stops working at once');
});

test('revoking an account kills its tokens, sessions and leases', async () => {
  const token = await activeUser('frank');
  const session = await login('frank');
  const claim = await call('POST', '/api/tasks/claim', {}, token);
  assert.equal(claim.status, 200);

  const admin = await login('root');
  const r = await request('POST', '/api/admin/users/frank/revoke', {}, { cookie: admin });
  assert.equal(r.status, 200);
  assert.equal(r.body.releasedLeases, 1);
  assert.equal((await call('GET', '/api/me', null, token)).status, 401);
  assert.equal((await request('GET', '/api/me', null, { cookie: session })).status, 401);
  assert.equal((await request('POST', '/api/login', { name: 'frank', password: PASSWORD })).status, 403);
  assert.notEqual(ctx.tasks.get(claim.body.task.id).state, 'leased');

  // Reinstating does not bring old tokens back.
  assert.equal((await request('POST', '/api/admin/users/frank/reinstate', {}, { cookie: admin })).status, 200);
  assert.equal((await call('GET', '/api/me', null, token)).status, 401);
  await login('frank');
});

test('the last admin cannot be revoked or demoted', async () => {
  const admin = await login('root');
  assert.equal((await request('POST', '/api/admin/users/root/revoke', {}, { cookie: admin })).status, 409);
  assert.equal((await request('POST', '/api/admin/users/root/role', { role: 'contributor' }, { cookie: admin })).status, 409);
});

test('changing the password logs out browser sessions', async () => {
  const s = await login('erin');
  const r = await request('POST', '/api/me/password', { current: PASSWORD, password: 'a brand new password' }, { cookie: s });
  assert.equal(r.status, 200);
  assert.equal((await request('GET', '/api/me', null, { cookie: s })).status, 401);
  await login('erin', 'a brand new password');
});

test('peer review: three other agents must agree, by reading only', async () => {
  const author = await activeUser('pauthor');
  const r1 = await activeUser('peer1');
  const r2 = await activeUser('peer2');
  const r3 = await activeUser('peer3');
  const r4 = await activeUser('peer4');
  ctx.merger.pump = async () => {};

  const authorId = ctx.accounts.byName('pauthor').id;
  const task = ctx.store.get(`SELECT * FROM tasks WHERE state IN ('open', 'needs_cleanup') LIMIT 1`);
  const feedback = { summary: 'not byte-identical', target: { score: 0.8, diffRegions: [{ offset: 4 }] } };
  const attempt = Number(
    ctx.store.run(
      `INSERT INTO attempts (task_id, user_id, base_commit, files_json, state, score, result_json, created_at, finished_at) VALUES (?, ?, ?, ?, 'peer_review', 0.8, ?, ?, ?)`,
      task.id, authorId, ctx.repo.head(), JSON.stringify({ 'src/a.cpp': '// FUNCTION: fn_00001\nint f() { return 1; }\n' }), JSON.stringify({ feedback }), now(), now(),
    ).lastInsertRowid,
  );
  ctx.store.run(`UPDATE tasks SET state = 'peer_review' WHERE id = ?`, task.id);

  assert.ok(!(await call('GET', '/api/peer-reviews', null, author)).body.some((x) => x.attempt_id === attempt), 'authors do not see their own attempts');
  const claim = await call('POST', '/api/peer-reviews/claim', { attemptId: attempt }, r1);
  assert.equal(claim.status, 200);
  assert.equal(claim.body.required, 3);
  assert.ok(claim.body.instructions.some((i) => /Do not compile/.test(i)));
  assert.equal(JSON.stringify(claim.body).includes('diffRegions'), false, 'no machine verdict in the review context');
  assert.equal(claim.body.original.read[0], `td_disassemble ${task.symbol_id}`);

  await call('POST', '/api/peer-reviews/claim', { attemptId: attempt }, r2);
  await call('POST', '/api/peer-reviews/claim', { attemptId: attempt }, r3);
  assert.equal((await call('POST', '/api/peer-reviews/claim', { attemptId: attempt }, r4)).status, 409, 'no more reviewers than needed');

  assert.equal((await call('POST', `/api/peer-reviews/${attempt}/verdict`, { verdict: 'same', reason: 'short' }, r1)).status, 400);
  assert.equal((await call('POST', `/api/peer-reviews/${attempt}/verdict`, { verdict: 'same', reason: 'all branches and calls agree' }, author)).status, 403);
  assert.equal((await call('POST', `/api/peer-reviews/${attempt}/verdict`, { verdict: 'same', reason: 'all branches and calls agree' }, r1)).body.state, 'peer_review');
  assert.equal((await call('POST', `/api/peer-reviews/${attempt}/verdict`, { verdict: 'same', reason: 'same loop bounds and the same return' }, r1)).status, 409, 'one verdict per account');
  assert.equal((await call('POST', `/api/peer-reviews/${attempt}/verdict`, { verdict: 'same', reason: 'checked every condition and field access' }, r2)).body.state, 'peer_review');
  const done = await call('POST', `/api/peer-reviews/${attempt}/verdict`, { verdict: 'same', reason: 'identical behavior, only register use differs' }, r3);
  assert.equal(done.body.state, 'in_review');
  assert.equal(ctx.tasks.get(task.id).state, 'in_review');
  assert.ok(ctx.peers.confirmed(attempt));

  // A single "different" sends the next attempt back with the reason.
  const second = Number(
    ctx.store.run(`INSERT INTO attempts (task_id, user_id, base_commit, files_json, state, created_at) VALUES (?, ?, ?, '{}', 'peer_review', ?)`, task.id, authorId, ctx.repo.head(), now()).lastInsertRowid,
  );
  await call('POST', '/api/peer-reviews/claim', { attemptId: second }, r4);
  const no = await call('POST', `/api/peer-reviews/${second}/verdict`, { verdict: 'different', reason: 'the original checks the flag before the loop, this does not' }, r4);
  assert.equal(no.body.state, 'needs_cleanup');
  assert.equal(ctx.peers.verdicts(second)[0].reason.untrusted, true);
  ctx.store.run(`UPDATE tasks SET state = 'done' WHERE id = ?`, task.id);
});
