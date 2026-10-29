import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openServer } from '../src/server/app.js';
import { Repo } from '../src/server/git.js';
import { now } from '../src/server/db.js';
import { deleteOrphanHeader } from '../src/server/orphan-header.js';

const header = 'Source/UI/Window/WindowAncestry.h';
const declarations = '#ifndef WINDOW_ANCESTRY_H\r\n#define WINDOW_ANCESTRY_H\r\nstruct WindowAncestry {\r\n  WindowAncestry* parent;\r\n  WindowAncestry();\r\n  bool IsDescendantOf(const WindowAncestry* ancestor) const;\r\n};\r\n#endif\r\n';
const cli = fileURLToPath(new URL('../src/server/cli.js', import.meta.url));

function fixture(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-orphan-test-'));
  const data = path.join(dir, 'data');
  const repoDir = path.join(data, 'repo');
  const backupDir = path.join(dir, 'backups');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(backupDir);
  const repo = new Repo(repoDir);
  repo.git(['init', '-q', '-b', 'main']);
  repo.git(['config', 'core.autocrlf', 'false']);
  repo.commitFiles({
    'data/decomp.json': JSON.stringify({ sourceDirs: ['Source'], includeDirs: [], headerGlobs: ['Source/**/*.h'] }),
    [header]: declarations,
    'Source/owner.cpp': 'int value;\n',
    ...files,
  }, 'fixture', 'Fixture <fixture@example.invalid>');
  const ctx = openServer(data, { log: { info() {}, error() {} } });
  ctx.store.run("INSERT INTO users (name, role, status, created_at) VALUES ('admin', 'admin', 'active', ?)", now());
  const options = () => ({ admin: 'admin', file: header, reason: 'Ancestry declarations migrated to owned window types', expectedHead: repo.head(), expectedBlob: repo.git(['rev-parse', `HEAD:${header}`]).trim(), backupDir, workerStopped: true });
  const events = () => ctx.store.all("SELECT user_id, type, data FROM events WHERE type LIKE 'orphan_header_%' ORDER BY id").map((r) => ({ ...r, data: JSON.parse(r.data) }));
  t.after(() => { ctx.store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ctx, dir, data, repo: ctx.repo, backupDir, options, events, remove: (extra = {}) => deleteOrphanHeader(ctx, { ...options(), ...extra }) };
}

for (const [source, content] of [
  ['Source/use.cpp', '#include "UI/Window/WindowAncestry.h"\n'],
  ['Source/use.hpp', '#include "WINDOWANCESTRY.H"\n'],
  ['CMakeLists.txt', 'set(HEADERS Source/UI/Window/WindowAncestry.h)\n'],
  ['build/project.vcxproj', Buffer.from('<ClInclude Include="Source\\UI\\Window\\WindowAncestry.h" />', 'utf16le')],
  ['data/commands.json', '{"forcedInclude":"WindowAncestry.h"}'],
]) {
  test(`refuses references from ${source} without changing the tree or audit`, (t) => {
    const f = fixture(t, { [source]: content });
    const before = f.repo.head();
    assert.throws(() => f.remove(), /referenced by/);
    assert.equal(f.repo.head(), before);
    assert.equal(f.repo.isClean(), true);
    assert.deepEqual(fs.readFileSync(path.join(f.repo.dir, header)), Buffer.from(declarations));
    assert.deepEqual(f.events(), []);
  });
}

test('deletes only an unreferenced declaration header, backs up exact bytes, audits identity and publishes', (t) => {
  const f = fixture(t, { [header]: declarations + '// WindowAncestry.h owns only these declarations.\r\n' });
  const before = f.options();
  const original = fs.readFileSync(path.join(f.repo.dir, header));
  const mirror = path.join(f.dir, 'mirror.git');
  execFileSync('git', ['init', '--bare', '-q', mirror]);
  f.repo.git(['remote', 'add', 'mirror', mirror]);
  f.ctx.config.pushRemote = 'mirror';
  const result = f.remove();
  assert.equal(fs.existsSync(path.join(f.repo.dir, header)), false);
  assert.equal(f.repo.show('HEAD', header), null);
  assert.equal(f.repo.git(['diff-tree', '--no-commit-id', '--name-status', '-r', result.commit]).trim(), `D\t${header}`);
  assert.equal(f.repo.git(['rev-parse', 'HEAD^']).trim(), before.expectedHead);
  assert.equal(f.repo.isClean(), true);
  assert.deepEqual(fs.readFileSync(result.backup), original);
  assert.equal(f.repo.git(['show', '-s', '--format=%an', 'HEAD']).trim(), process.env.TD_GIT_AUTHOR_NAME ?? 'admin');
  assert.equal(execFileSync('git', ['--git-dir', mirror, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim(), result.commit);
  assert.equal(f.ctx.store.getMeta('repository_project_head'), result.commit);
  assert.deepEqual(f.events().map((e) => [e.type, e.user_id, e.data.expectedHead, e.data.expectedBlob, e.data.reason]), [
    ['orphan_header_delete_started', 1, before.expectedHead, before.expectedBlob, before.reason],
    ['orphan_header_deleted', 1, before.expectedHead, before.expectedBlob, before.reason],
  ]);
  assert.equal(f.events()[1].data.commit, result.commit);
});

test('refuses stored dependency references including case and path-separator variants', (t) => {
  const f = fixture(t);
  f.ctx.store.run('INSERT INTO unit_deps (unit, header) VALUES (?, ?)', 'Source/owner.cpp', 'SOURCE\\UI\\WINDOW\\WINDOWANCESTRY.H');
  assert.throws(() => f.remove(), /stored unit_deps/);
  assert.equal(f.repo.isClean(), true);
});

test('requires active admin, reason, full hashes and explicit stopped/drained worker', (t) => {
  const f = fixture(t);
  f.ctx.store.run("INSERT INTO users (name, role, status, created_at) VALUES ('maintainer', 'maintainer', 'active', ?)", now());
  for (const [options, error] of [
    [{ admin: 'maintainer' }, /active admin/], [{ reason: '' }, /reason/],
    [{ expectedHead: 'abc' }, /full Git/], [{ expectedBlob: 'abc' }, /full Git/],
    [{ workerStopped: false }, /stop and drain/], [{ backupDir: f.repo.dir }, /outside/],
  ]) assert.throws(() => f.remove(options), error);
  f.ctx.store.setMeta('worker_seen', now());
  assert.throws(() => f.remove(), /active or not drained/);
  f.ctx.store.setMeta('worker_seen', 0);
  f.ctx.store.run("INSERT INTO batches (user_id, base_commit, files_json, state, created_at) VALUES (1, ?, '{}', 'verifying', ?)", f.repo.head(), now());
  assert.throws(() => f.remove(), /active or not drained/);
  assert.equal(f.repo.isClean(), true);
});

test('rejects traversal, units, outside roots, untracked files and dirty trees without discarding edits', (t) => {
  const f = fixture(t, { 'outside.h': 'struct Outside;\n' });
  for (const file of ['../outside.h', 'Source/../outside.h', '/outside.h', 'Source\\escape.h', 'Source/owner.cpp', 'outside.h', 'Source/untracked.h']) {
    assert.throws(() => f.remove({ file }), /path must|outside configured|tracked regular/);
  }
  fs.writeFileSync(path.join(f.repo.dir, 'Source/owner.cpp'), 'int unrelated_edit;\n');
  assert.throws(() => f.remove(), /dirty repository/);
  assert.equal(fs.readFileSync(path.join(f.repo.dir, 'Source/owner.cpp'), 'utf8'), 'int unrelated_edit;\n');
  assert.equal(f.repo.show('HEAD', header), declarations);
});

for (const text of [
  '// FUNCTION: fn_00001\nvoid f();\n', '// STUB: fn_00001\n', '// GLOBAL: gl_00001\nextern int g;\n',
  '// VTABLE: vt_00001\nstruct X;\n', '// STRING: st_00001\n', '// IMPL: fn_00001\n', '// DATA: gl_00001\n',
  '// FUNCTION fn_00001\nvoid f();\n', 'void f() <% %>\n',
  'struct Stored { int field; } global;\n',
  'inline void f() {}\n', 'struct X { void f() {} };\n', 'static int value;\n', 'int value = 2;\n', '#define GET() value\n',
]) {
  test(`refuses implementation, storage or provenance: ${text.trim()}`, (t) => {
    const f = fixture(t, { [header]: text });
    assert.throws(() => f.remove(), /provenance|declaration-only/);
    assert.equal(f.repo.isClean(), true);
  });
}

test('refuses a header registered as a compile unit or symbol owner', (t) => {
  const f = fixture(t, {
    'data/decomp.json': JSON.stringify({ sourceDirs: ['Source'], includeDirs: [], headerGlobs: [], compileCommands: 'data/compile.json' }),
    'data/compile.json': JSON.stringify({ units: { [header]: 0 }, shapes: [[]] }),
  });
  assert.throws(() => f.remove(), /translation unit or function owner/);
  f.repo.commitFiles({ 'data/compile.json': JSON.stringify({ units: {}, shapes: [[]] }) }, 'remove compile registration', 'Fixture <fixture@example.invalid>');
  f.ctx.store.run("INSERT INTO symbols (id, kind, unit, created_at) VALUES ('fn_00001', 'function', ?, ?)", header, now());
  assert.throws(() => f.remove(), /translation unit or function owner/);
  assert.equal(f.repo.isClean(), true);
});

test('exclusive administrative lock refuses a concurrent or unrecovered deletion', (t) => {
  const f = fixture(t);
  const lock = path.join(f.data, 'orphan-header.lock');
  fs.writeFileSync(lock, 'another administrator');
  assert.throws(() => f.remove(), /EEXIST/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another administrator');
  assert.equal(f.repo.isClean(), true);
});

test('rejects a tracked symlink even on hosts that check it out as an ordinary file', (t) => {
  const f = fixture(t);
  const blob = f.repo.git(['hash-object', '-w', '--stdin'], { input: 'owner.cpp' }).trim();
  f.repo.git(['update-index', '--cacheinfo', `120000,${blob},${header}`]);
  f.repo.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'symlink']);
  // core.symlinks=false represents links as files on Windows; the Git mode must still reject it.
  f.repo.git(['config', 'core.symlinks', 'false']);
  fs.writeFileSync(path.join(f.repo.dir, header), 'owner.cpp');
  assert.throws(() => f.remove(), /tracked regular/);
});

test('rejects stale expected HEAD and blob before making a backup or deletion', (t) => {
  const f = fixture(t);
  const stale = f.options();
  f.repo.commitFiles({ 'Source/new.cpp': 'int new_value;\n' }, 'advance', 'Fixture <fixture@example.invalid>');
  assert.throws(() => deleteOrphanHeader(f.ctx, stale), /HEAD changed/);
  assert.throws(() => f.remove({ expectedBlob: '0'.repeat(40) }), /blob changed/);
  assert.equal(f.repo.isClean(), true);
  assert.deepEqual(f.events(), []);
});

test('CAS rejects a HEAD race after removal and restores only the deleted file/index entry', (t) => {
  const f = fixture(t);
  const oldHead = f.repo.head();
  const git = f.repo.git.bind(f.repo);
  const racedHead = git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', `${oldHead}^{tree}`, '-p', oldHead, '-m', 'concurrent writer']).trim();
  let raced = false;
  f.repo.git = (args, opts) => {
    if (args[0] === 'update-ref' && !raced) {
      raced = true;
      git(['update-ref', 'HEAD', racedHead, oldHead]);
      fs.writeFileSync(path.join(f.repo.dir, 'Source/owner.cpp'), 'int concurrent_edit;\n');
      git(['add', '--', 'Source/owner.cpp']);
    }
    return git(args, opts);
  };
  assert.throws(() => f.remove(), /update-ref failed/);
  assert.equal(f.repo.head(), racedHead);
  assert.equal(fs.readFileSync(path.join(f.repo.dir, header), 'utf8'), declarations);
  assert.equal(f.repo.git(['show', `:${header}`]), declarations);
  assert.equal(f.repo.git(['show', ':Source/owner.cpp']), 'int concurrent_edit;\n');
  assert.deepEqual(f.events().map((e) => e.type), ['orphan_header_delete_started', 'orphan_header_delete_failed']);
  assert.equal(fs.readFileSync(f.events()[0].data.backup, 'utf8'), declarations);
});

test('commit failure leaves the original header, index and HEAD intact with durable backup/audit', (t) => {
  const f = fixture(t);
  const before = f.repo.head();
  const git = f.repo.git.bind(f.repo);
  f.repo.git = (args, opts) => {
    if (args[0] === 'commit-tree') throw new Error('injected commit failure');
    return git(args, opts);
  };
  assert.throws(() => f.remove(), /injected commit failure/);
  assert.equal(f.repo.head(), before);
  assert.equal(f.repo.isClean(), true);
  assert.equal(fs.readFileSync(path.join(f.repo.dir, header), 'utf8'), declarations);
  assert.equal(f.events().at(-1).type, 'orphan_header_delete_failed');
  assert.equal(fs.readFileSync(f.events()[0].data.backup, 'utf8'), declarations);
});

test('failure staging the deletion restores exact bytes without touching another staged edit', (t) => {
  const f = fixture(t);
  const before = f.repo.head();
  const git = f.repo.git.bind(f.repo);
  f.repo.git = (args, opts) => {
    if (args[0] === 'update-index' && args[1] === '--force-remove' && !opts?.env) {
      fs.writeFileSync(path.join(f.repo.dir, 'Source/owner.cpp'), 'int staged_edit;\n');
      git(['add', '--', 'Source/owner.cpp']);
      throw new Error('injected index failure');
    }
    return git(args, opts);
  };
  assert.throws(() => f.remove(), /injected index failure/);
  assert.equal(f.repo.head(), before);
  assert.equal(fs.readFileSync(path.join(f.repo.dir, header), 'utf8'), declarations);
  assert.equal(f.repo.git(['show', `:${header}`]), declarations);
  assert.equal(f.repo.git(['show', ':Source/owner.cpp']), 'int staged_edit;\n');
  assert.equal(f.events().at(-1).type, 'orphan_header_delete_failed');
});

test('the real td-server CLI deletes a temp-repository header and records the temp-DB audit', (t) => {
  const f = fixture(t);
  const o = f.options();
  const output = execFileSync(process.execPath, [cli, 'maintenance', 'delete-orphan-header', header,
    '--data', f.data, '--admin', 'admin', '--reason', o.reason, '--expected-head', o.expectedHead,
    '--expected-blob', o.expectedBlob, '--backup-dir', f.backupDir, '--worker-stopped'], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(f.repo.head(), result.commit);
  assert.equal(fs.existsSync(path.join(f.repo.dir, header)), false);
  assert.equal(f.events().at(-1).data.commit, result.commit);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), declarations);
});
