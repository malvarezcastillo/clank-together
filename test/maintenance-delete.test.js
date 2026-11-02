import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Repo } from '../src/server/git.js';
import { lintSubmission } from '../src/shared/lint.js';
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
