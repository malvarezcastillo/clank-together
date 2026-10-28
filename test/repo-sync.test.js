import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Repo } from '../src/server/git.js';
import { openServer, createApp } from '../src/server/app.js';
import { now } from '../src/server/db.js';
import { fixture as binaryFixture } from './helpers.js';

const quiet = { info() {}, error() {} };

function repositories(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-repo-sync-'));
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const remote = path.join(root, 'remote.git');
  const producer = path.join(root, 'producer');
  const dataDir = path.join(root, 'server');
  const local = path.join(dataDir, 'repo');
  const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  fs.mkdirSync(dataDir);
  git(root, 'init', '--bare', '-q', '-b', 'main', remote);
  git(root, 'clone', '-q', remote, producer);
  const commit = (dir, files, message = 'fixture change') => {
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), typeof content === 'string' ? content : JSON.stringify(content));
    }
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  };
  const base = commit(producer, {
    'data/decomp.json': { name: 'before', sourceDirs: ['src'], includeDirs: ['include'], headerGlobs: ['include/**'], obsoleteSetting: true },
    'src/base.cpp': 'int base_value;\n',
    '.gitattributes': '* text eol=lf\n',
    '.gitignore': 'ignored.txt\n',
  });
  git(producer, 'push', '-q', 'origin', 'HEAD');
  git(root, 'clone', '-q', remote, local);
  git(local, 'remote', 'rename', 'origin', 'publish');
  git(local, 'remote', 'add', 'origin', path.join(root, 'wrong-remote.git'));
  const advance = (files) => {
    const head = commit(producer, files);
    git(producer, 'push', '-q', 'origin', 'HEAD');
    return head;
  };
  return { root, remote, producer, dataDir, local, git, commit, base, advance, cleanup, repo: new Repo(local) };
}

function serverFixture(t, repos) {
  fs.writeFileSync(path.join(repos.dataDir, 'server.json'), JSON.stringify({ pushRemote: 'publish', verifyConcurrency: 2, publicUrl: 'http://127.0.0.1', listen: { host: '127.0.0.1', port: 0 } }));
  const ctx = openServer(repos.dataDir, { log: quiet });
  const exe = path.join(repos.dataDir, 'target.exe');
  const pe = binaryFixture().pe;
  fs.writeFileSync(exe, pe);
  ctx.store.run(`INSERT INTO versions (id, sha256, file, size, is_current, created_at) VALUES ('test', 'test', ?, ?, 1, ?)`, exe, pe.length, now());
  const user = Number(ctx.store.run(`INSERT INTO users (name, role, status, created_at) VALUES ('maintainer', 'maintainer', 'active', ?)`, now()).lastInsertRowid);
  repos.cleanup.push(() => { ctx.verifier.stop(); ctx.store.db.close(); });
  const batch = (kind, base = repos.base, files = { 'forbidden.txt': 'invalid\n' }) => {
    const id = Number(ctx.store.run(`INSERT INTO batches (user_id, base_commit, files_json, state, kind, created_at) VALUES (?, ?, ?, 'queued', ?, ?)`, user, base, JSON.stringify(files), kind, now()).lastInsertRowid);
    if (kind === 'code') {
      ctx.store.run(`INSERT OR IGNORE INTO symbols (id, kind, unit, created_at) VALUES ('fn_1', 'function', 'src/base.cpp', ?)`, now());
      const task = Number(ctx.store.run(`INSERT INTO tasks (symbol_id, state, updated_at) VALUES ('fn_1', 'verifying', ?)`, now()).lastInsertRowid);
      ctx.store.run(`INSERT INTO attempts (task_id, user_id, base_commit, files_json, state, batch_id, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`, task, user, base, JSON.stringify(files), id, now());
    }
    return id;
  };
  return { ctx, batch, user };
}

async function drained(verifier) {
  for (let i = 0; i < 100 && verifier.running; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(verifier.running, 0, 'verification finishes');
}

test('sync fetches pushRemote and fast-forwards its current branch, preserving local-ahead work', (t) => {
  const r = repositories(t);
  const remoteHead = r.advance({ 'src/remote.cpp': 'int remote_value;\n' });
  assert.deepEqual(r.repo.sync('publish'), { remote: 'publish', branch: 'refs/heads/main', before: r.base, head: remoteHead, remoteHead, state: 'fast-forward' });
  assert.equal(fs.readFileSync(path.join(r.local, 'src/remote.cpp'), 'utf8'), 'int remote_value;\n');
  assert.equal(r.repo.sync('publish').state, 'current');
  const ahead = r.commit(r.local, { 'src/local.cpp': 'int local_value;\n' });
  assert.equal(r.repo.sync('publish').state, 'ahead');
  assert.equal(r.repo.head(), ahead);
  assert.equal(r.repo.show('HEAD', 'src/local.cpp'), 'int local_value;\n');
});

test('divergence gives both commits and leaves both histories and worktree intact', (t) => {
  const r = repositories(t);
  const local = r.commit(r.local, { 'src/local.cpp': 'int local_value;\n' });
  const remote = r.advance({ 'src/remote.cpp': 'int remote_value;\n' });
  assert.throws(() => r.repo.sync('publish'), (e) => /diverged/.test(e.message) && e.message.includes(local) && e.message.includes(remote) && /maintainer.*reconcile/.test(e.message));
  assert.equal(r.repo.head(), local);
  assert.equal(r.repo.show('HEAD', 'src/local.cpp'), 'int local_value;\n');
  assert.equal(r.repo.show(remote, 'src/remote.cpp'), 'int remote_value;\n');
  assert.equal(r.repo.isClean(), true);
});

test('dirty tracked, staged and untracked files are preserved, as are ignored files upstream would track', (t) => {
  const r = repositories(t);
  r.advance({ 'src/base.cpp': 'int upstream_value;\n', 'new.txt': 'remote\n' });
  fs.writeFileSync(path.join(r.local, 'src/base.cpp'), 'int operator_edit;\n');
  fs.writeFileSync(path.join(r.local, 'new.txt'), 'local\n');
  r.git(r.local, 'add', 'src/base.cpp');
  const index = r.git(r.local, 'show', ':src/base.cpp');
  assert.throws(() => r.repo.sync('publish'), /dirty server working tree/);
  assert.equal(r.repo.head(), r.base);
  assert.equal(r.git(r.local, 'show', ':src/base.cpp'), index);
  assert.equal(fs.readFileSync(path.join(r.local, 'new.txt'), 'utf8'), 'local\n');
});

test('ignored untracked content is not overwritten by a fast-forward', (t) => {
  const r = repositories(t);
  fs.writeFileSync(path.join(r.local, 'ignored.txt'), 'operator data\n');
  fs.writeFileSync(path.join(r.producer, 'ignored.txt'), 'remote data\n');
  r.git(r.producer, 'add', '-f', 'ignored.txt');
  r.advance({ 'src/remote.cpp': 'int remote_value;\n' });
  assert.throws(() => r.repo.sync('publish'), /overwritten|untracked/i);
  assert.equal(r.repo.head(), r.base);
  assert.equal(fs.readFileSync(path.join(r.local, 'ignored.txt'), 'utf8'), 'operator data\n');
});

test('failed fetch never reuses FETCH_HEAD or reports success', (t) => {
  const r = repositories(t);
  r.repo.sync('publish');
  r.git(r.local, 'remote', 'set-url', 'publish', path.join(r.root, 'unavailable.git'));
  assert.throws(() => r.repo.sync('publish'), /repository sync.*failed.*local HEAD/s);
  assert.equal(r.repo.head(), r.base);
});

test('code and maintenance admission waits for every active lane and retries dirty sync safely', async (t) => {
  const r = repositories(t);
  const { ctx, batch } = serverFixture(t, r);
  const remote = r.advance({ 'src/remote.cpp': 'int remote_value;\n' });
  const code = batch('code', remote);
  const maintenance = batch('maintenance', remote);
  for (const lane of [ctx.verifier, ctx.merger, ctx.checks]) {
    lane.running = 1;
    ctx.verifier.pump();
    assert.equal(r.repo.head(), r.base);
    assert.equal(ctx.store.get('SELECT state FROM batches WHERE id = ?', code).state, 'queued');
    lane.running = 0;
  }
  fs.writeFileSync(path.join(r.local, 'operator.txt'), 'preserve me\n');
  ctx.verifier.pump();
  for (const id of [code, maintenance]) {
    const row = ctx.store.get('SELECT state, result_json FROM batches WHERE id = ?', id);
    assert.equal(row.state, 'queued');
    assert.match(JSON.parse(row.result_json).repositorySync.error, /dirty server working tree/);
  }
  assert.equal(ctx.verifier.repositoryBlocked, true);
  assert.equal(fs.readFileSync(path.join(r.local, 'operator.txt'), 'utf8'), 'preserve me\n');
  fs.renameSync(path.join(r.local, 'operator.txt'), path.join(r.root, 'preserved.txt'));
  ctx.verifier.pump();
  await drained(ctx.verifier);
  assert.equal(r.repo.head(), remote);
  assert.equal(ctx.verifier.repositoryBlocked, false);
  for (const id of [code, maintenance]) {
    const row = ctx.store.get('SELECT state, result_json FROM batches WHERE id = ?', id);
    assert.equal(row.state, 'returned');
    assert.match(row.result_json, /static gate/);
    assert.equal(JSON.parse(row.result_json).repositorySync, undefined);
  }
});

test('sync failure blocks new merge/check work and an operator reconciliation resumes queued work', async (t) => {
  const r = repositories(t);
  const { ctx, batch, user } = serverFixture(t, r);
  const queued = batch('maintenance');
  const approved = batch('code');
  ctx.store.run(`UPDATE batches SET state = 'open' WHERE id = ?`, approved);
  ctx.store.run(`UPDATE attempts SET state = 'approved' WHERE batch_id = ?`, approved);
  const checkId = Number(ctx.store.run(`INSERT INTO check_jobs (user_id, files_hash, files_json, state, created_at) VALUES (?, 'test', '{}', 'queued', ?)`, user, now()).lastInsertRowid);
  const local = r.commit(r.local, { 'src/local.cpp': 'int local_value;\n' });
  const remote = r.advance({ 'src/remote.cpp': 'int remote_value;\n' });
  ctx.verifier.pump();
  const error = JSON.parse(ctx.store.get('SELECT result_json FROM batches WHERE id = ?', queued).result_json).repositorySync.error;
  assert.ok(error.includes(local) && error.includes(remote));
  await ctx.merger.pump();
  ctx.checks.pump();
  assert.equal(ctx.store.get('SELECT state FROM batches WHERE id = ?', approved).state, 'open');
  assert.equal(ctx.store.get('SELECT state FROM check_jobs WHERE id = ?', checkId).state, 'queued');
  assert.equal(r.repo.head(), local);
  // Deliberate operator reconciliation, not an automatic reset/rebase by sync.
  r.git(r.producer, 'fetch', '-q', r.local, 'main');
  r.git(r.producer, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'merge', '-q', '--no-edit', 'FETCH_HEAD');
  r.git(r.producer, 'push', '-q', 'origin', 'HEAD');
  ctx.verifier.pump();
  await drained(ctx.verifier);
  assert.equal(ctx.verifier.repositoryBlocked, false);
  assert.equal(ctx.store.get('SELECT state FROM batches WHERE id = ?', queued).state, 'returned');
  ctx.checks.pump();
  for (let i = 0; i < 100 && ctx.checks.running; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ctx.store.get('SELECT state FROM check_jobs WHERE id = ?', checkId).state, 'done');
  assert.equal(ctx.repo.show('HEAD', 'src/local.cpp'), 'int local_value;\n');
  assert.equal(ctx.repo.show('HEAD', 'src/remote.cpp'), 'int remote_value;\n');
});

test('concurrent batches retain their snapshot until maintenance and code both finish', async (t) => {
  const r = repositories(t);
  const { ctx, batch } = serverFixture(t, r);
  ctx.config.verifyConcurrency = 2;
  const releases = [];
  const hold = () => new Promise((resolve) => releases.push(resolve));
  const code = batch('code');
  const maintenance = batch('maintenance');
  ctx.verifier.verifyBatch = async (b) => { await hold(); ctx.store.run(`UPDATE batches SET state = 'returned' WHERE id = ?`, b.id); };
  ctx.maintenance.run = async (id) => { await hold(); ctx.store.run(`UPDATE batches SET state = 'returned' WHERE id = ?`, id); };
  ctx.verifier.pump();
  assert.equal(ctx.verifier.running, 2);
  assert.equal(ctx.store.get('SELECT state FROM batches WHERE id = ?', code).state, 'verifying');
  assert.equal(ctx.store.get('SELECT state FROM batches WHERE id = ?', maintenance).state, 'verifying');
  const remote = r.advance({ 'src/cohort.cpp': 'int cohort_value;\n' });
  const next = batch('maintenance');
  ctx.verifier.pump();
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.verifier.running, 1);
  assert.equal(r.repo.head(), r.base);
  assert.equal(ctx.store.get('SELECT state FROM batches WHERE id = ?', next).state, 'queued');
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.repo.head(), remote);
  assert.equal(ctx.store.get('SELECT state FROM batches WHERE id = ?', next).state, 'verifying');
  releases.shift()();
  await drained(ctx.verifier);
});

test('FF reloads compile-command paths and invalidates old checks before maintenance uses new roots', async (t) => {
  const r = repositories(t);
  const { ctx, batch } = serverFixture(t, r);
  const id = batch('maintenance', r.base, { 'fresh/empty.h': '' });
  ctx.store.run(`INSERT INTO batch_checks (batch_id, head, check_json) VALUES (?, ?, '{}')`, id, r.base);
  const shared = ctx.project;
  const remote = r.advance({
    'data/decomp.json': { name: 'after', sourceDirs: ['newsrc'], includeDirs: ['fresh'], headerGlobs: ['fresh/**'], toolchain: 'newtool', compileCommands: 'data/new-commands.json' },
    'data/new-commands.json': { shapes: [['/c']], units: {} },
    'data/toolchain.lock.json': { newtool: { clSha256: 'new-digest' } },
  });
  ctx.verifier.pump();
  await drained(ctx.verifier);
  assert.equal(ctx.store.get('SELECT state FROM batches WHERE id = ?', id).state, 'merged');
  assert.equal(ctx.repo.isAncestor(remote), true);
  assert.equal(ctx.repo.show('HEAD', 'fresh/empty.h'), '');
  assert.equal(ctx.project, shared);
  assert.equal(ctx.maintenance.project, shared);
  assert.equal(ctx.tasks.project, shared);
  assert.equal(ctx.project.name, 'after');
  assert.equal(ctx.project.obsoleteSetting, undefined);
  assert.deepEqual(ctx.project.compile, { shapes: [['/c']], units: {} });
  assert.equal(ctx.config.envDigest, 'new-digest');
  assert.equal(ctx.store.get('SELECT COUNT(*) AS n FROM batch_checks').n, 0);
});

test('split web serves only published config and lock snapshots, even during an unpublished FF', async (t) => {
  const r = repositories(t);
  const { ctx } = serverFixture(t, r);
  ctx.verifier.syncRepository();
  const web = openServer(r.dataDir, { log: quiet });
  web.runsWorker = false;
  const server = createApp(web);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  r.cleanup.push(async () => { await new Promise((resolve) => server.close(resolve)); web.store.db.close(); });
  const info = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/info`);
    assert.equal(response.status, 200);
    return response.json();
  };
  r.advance({ 'data/decomp.json': { name: 'published', toolchain: 'newtool' }, 'data/toolchain.lock.json': { newtool: { clSha256: 'published-digest' } } });
  r.repo.sync('publish'); // Repo moved, but the worker has not reloaded/published project data yet.
  let response = await info();
  assert.equal(response.project, 'before');
  assert.equal(response.toolchain, 'msvc2010');
  assert.deepEqual(response.toolchainLock, {});
  fs.writeFileSync(path.join(r.local, 'data/decomp.json'), '{partial worktree write');
  ctx.verifier.refreshProject();
  ctx.store.setMeta('repository_project_head', r.repo.head());
  response = await info();
  assert.equal(response.project, 'published');
  assert.equal(response.toolchain, 'newtool');
  assert.deepEqual(response.toolchainLock, { newtool: { clSha256: 'published-digest' } });
  assert.equal(web.config.envDigest, 'published-digest');
});

test('startup refreshes an idle worker even with no queued batches', (t) => {
  const r = repositories(t);
  const { ctx } = serverFixture(t, r);
  const remote = r.advance({ 'data/decomp.json': { name: 'startup-refreshed' } });
  ctx.verifier.start();
  ctx.verifier.stop();
  assert.equal(r.repo.head(), remote);
  assert.equal(ctx.project.name, 'startup-refreshed');
  assert.equal(ctx.store.getMeta('repository_project_head'), remote);
});

test('missing incoming compile commands block verification without publishing stale project data', async (t) => {
  const r = repositories(t);
  const { ctx, batch } = serverFixture(t, r);
  ctx.verifier.syncRepository();
  const id = batch('maintenance');
  const remote = r.advance({ 'data/decomp.json': { name: 'broken', compileCommands: 'data/commands.json' } });
  ctx.verifier.pump();
  assert.equal(r.repo.head(), remote);
  assert.equal(ctx.project.name, 'before');
  assert.equal(ctx.store.getMeta('repository_project_head'), r.base);
  const row = ctx.store.get('SELECT state, result_json FROM batches WHERE id = ?', id);
  assert.equal(row.state, 'queued');
  assert.match(JSON.parse(row.result_json).repositorySync.error, /missing compile commands: data\/commands\.json/);
  const repaired = r.advance({ 'data/commands.json': { shapes: [['/c']], units: {} } });
  ctx.verifier.pump();
  await drained(ctx.verifier);
  assert.equal(ctx.project.name, 'broken');
  assert.equal(ctx.store.getMeta('repository_project_head'), repaired);
  assert.equal(ctx.verifier.repositoryBlocked, false);
  assert.equal(ctx.store.get('SELECT state FROM batches WHERE id = ?', id).state, 'returned');
});
