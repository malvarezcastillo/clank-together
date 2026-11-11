import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Repo } from '../src/server/git.js';
import { lintSubmission } from '../src/shared/lint.js';
import { withMovedObjects } from '../src/server/maintenance.js';
import { hashEffectiveParts } from '../src/shared/compare.js';
import { prepareJobDir } from '../src/shared/build.js';
import { removeUnitsFromCompileCommands, scanAnnotations } from '../src/shared/project.js';
import { sourceIncluders } from '../src/server/includers.js';

const author = 'T <t@example.invalid>';

function repository(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-delete-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.cpp'), '#include "old.h"\nint a;\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.cpp'), 'int b;\n');
  fs.writeFileSync(path.join(dir, 'src', 'old.h'), 'int old();\n');
  git('add', '-A');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'base');
  return { dir, repo: new Repo(dir), git };
}

const project = { sourceDirs: ['src'], includeDirs: [], compile: { units: { 'src/a.cpp': 0, 'src/b.cpp': 0 }, shapes: [[]] } };

test('commitFiles deletes null entries and writes the others in one commit', (t) => {
  const { repo, git } = repository(t);
  const base = repo.head();
  const commit = repo.commitFiles({ 'src/old.h': null, 'src/a.cpp': 'int a;\n' }, 'drop old.h', author);
  assert.notEqual(commit, base);
  assert.deepEqual(git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort(), ['src/a.cpp', 'src/b.cpp']);
  assert.equal(git('show', 'HEAD:src/a.cpp'), 'int a;');
});

test('a deletion merges onto an unchanged head and conflicts when main edited the file', (t) => {
  const { dir, repo, git } = repository(t);
  const base = repo.head();
  assert.deepEqual(repo.mergeOntoHead(base, { 'src/old.h': null }), { files: { 'src/old.h': null }, conflicts: [] });
  fs.writeFileSync(path.join(dir, 'src', 'old.h'), 'int old();\nint newer();\n');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-am', 'edit');
  assert.deepEqual(repo.mergeOntoHead(base, { 'src/old.h': null }).conflicts, ['src/old.h']);
});

test('a moved file takes along what main changed at its old path', (t) => {
  const { dir, repo, git } = repository(t);
  const base = repo.head();
  fs.writeFileSync(path.join(dir, 'src', 'b.cpp'), 'int b;\nint newer;\n');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-am', 'edit');
  const moved = repo.mergeOntoHead(base, { 'src/b.cpp': null, 'src/x/b.cpp': '#include "y.h"\nint b;\n' });
  assert.deepEqual(moved, { files: { 'src/b.cpp': null, 'src/x/b.cpp': '#include "y.h"\nint b;\nint newer;\n' }, conflicts: [] });
  assert.deepEqual(repo.mergeOntoHead(base, { 'src/b.cpp': null }).conflicts, ['src/b.cpp'], 'a plain deletion still conflicts');
});

test('a pending change follows a file main moved since its base, includes included', (t) => {
  const { dir, repo, git } = repository(t);
  const base = repo.head();
  fs.mkdirSync(path.join(dir, 'src', 'x'));
  git('mv', 'src/old.h', 'src/x/old.h');
  fs.writeFileSync(path.join(dir, 'src', 'a.cpp'), '#include "x/old.h"\nint a;\n');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-am', 'move');
  const r = repo.mergeOntoHead(base, { 'src/a.cpp': '#include "old.h"\nint a;\nint more;\n', 'src/old.h': 'int old();\nint added();\n' });
  assert.deepEqual(r, { files: { 'src/a.cpp': '#include "x/old.h"\nint a;\nint more;\n', 'src/x/old.h': 'int old();\nint added();\n' }, conflicts: [] });
  git('rm', '-q', 'src/b.cpp');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'drop');
  assert.deepEqual(repo.mergeOntoHead(base, { 'src/b.cpp': 'int b2;\n' }).conflicts, ['src/b.cpp'], 'a file main removed is not written back');
});

test('files over 1 MB merge', (t) => {
  const { dir, repo, git } = repository(t);
  const big = 'int x;\n'.repeat(200000);
  fs.writeFileSync(path.join(dir, 'src', 'b.cpp'), big);
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-am', 'big');
  const base = repo.head();
  fs.writeFileSync(path.join(dir, 'src', 'b.cpp'), 'int head;\n' + big);
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-am', 'head edit');
  const r = repo.mergeOntoHead(base, { 'src/b.cpp': big + 'int tail;\n' });
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.files['src/b.cpp'], 'int head;\n' + big + 'int tail;\n');
});

test("main's references to a moved unit's statics read under its new object path", () => {
  const parts = (obj) => ({ bytesHash: 'b', is64: false, effective: [`4:abs:?${obj}|?kSecret@@3QBEB+0`, '9:rel:4198400'], unresolvedRefs: [{ index: 0, name: `${obj}|?kSecret@@3QBEB`, addend: 0, prefix: '4:abs:' }] });
  const fn = (obj) => ({ effectiveParts: parts(obj), effectiveHash: hashEffectiveParts(parts(obj)), relocations: [{ offset: 4, symbol: `${obj}|?kSecret@@3QBEB`, actual: 1234 }] });
  const moves = new Map([['src/a/u.cpp', 'src/u.cpp']]);
  const moved = withMovedObjects(fn('src/u.obj'), moves);
  assert.equal(moved.effectiveHash, fn('src/a/u.obj').effectiveHash);
  assert.equal(moved.relocations[0].symbol, 'src/a/u.obj|?kSecret@@3QBEB');
  assert.equal(withMovedObjects(fn('src/other.obj'), moves).effectiveHash, fn('src/other.obj').effectiveHash, 'another unit keeps its names');
});

test('only maintenance lint accepts a deletion, and only of a tracked file', () => {
  const opts = { allowedPaths: ['src/**'], trackedPaths: ['src/old.h'] };
  assert.match(lintSubmission({ 'src/old.h': null }, opts)[0].message, /content must be a string/);
  assert.deepEqual(lintSubmission({ 'src/old.h': null }, { ...opts, allowDeletions: true }), []);
  assert.match(lintSubmission({ 'src/gone.h': null }, { ...opts, allowDeletions: true })[0].message, /only a file main tracks/);
});

test('the compile overlay, annotation scan and includers drop a deleted file', (t) => {
  const { dir, repo } = repository(t);
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-delete-job-'));
  t.after(() => fs.rmSync(jobDir, { recursive: true, force: true }));
  prepareJobDir({ repoDir: dir, jobDir, project, overrides: { 'src/old.h': null } });
  assert.equal(fs.existsSync(path.join(jobDir, 'src', 'old.h')), false);
  fs.writeFileSync(path.join(dir, 'src', 'b.cpp'), '// FUNCTION: fn_00001\nint b() { return 0; }\n');
  assert.equal(scanAnnotations(dir, project, { 'src/b.cpp': null }).annotations.length, 0);
  assert.deepEqual(sourceIncluders(repo, project, ['src/old.h'], { 'src/a.cpp': null }), []);
});

test('a deleted unit leaves the build list', () => {
  const text = JSON.stringify({ units: { 'src/a.cpp': 0, 'src/b.cpp': 0 }, shapes: [[]] });
  const r = removeUnitsFromCompileCommands(project, text, ['src/a.cpp']);
  assert.deepEqual(r.removed, ['src/a.cpp']);
  assert.deepEqual(Object.keys(JSON.parse(r.text).units), ['src/b.cpp']);
  assert.equal(removeUnitsFromCompileCommands(project, text, ['src/c.cpp']), null);
});
