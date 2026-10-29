import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Repo } from '../src/server/git.js';

function repository(t, { ignorecase }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-repo-case-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'core.ignorecase', String(ignorecase));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'MD5.cpp'), 'int md5;\n');
  git('add', '-A');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'base');
  return { dir, repo: new Repo(dir), git };
}

const caseSensitive = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-case-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'a'), '');
    return !fs.existsSync(path.join(dir, 'A'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

test('a new file whose name differs from a tracked one only by case is committed even when the repo config says ignorecase', { skip: !caseSensitive && 'needs a case-sensitive filesystem' }, (t) => {
  const { repo, git } = repository(t, { ignorecase: true });
  repo.commitFiles({ 'src/Md5.cpp': 'int state;\n' }, 'add Md5.cpp', 'T <t@example.invalid>');
  assert.deepEqual(git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort(), ['src/MD5.cpp', 'src/Md5.cpp']);
  assert.equal(git('show', 'HEAD:src/Md5.cpp'), 'int state;');
});

test('commitFiles refuses to report success when a written file did not reach the index', (t) => {
  const { dir, repo, git } = repository(t, { ignorecase: false });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'src/ignored.cpp\n');
  git('add', '.gitignore');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'ignore');
  const before = repo.head();
  assert.throws(() => repo.commitFiles({ 'src/ignored.cpp': 'int x;\n' }, 'add ignored', 'T <t@example.invalid>'), /did not reach the index|ignored by one of your .gitignore/);
  assert.equal(repo.head(), before);
});

test('trackedPaths lists every file at a commit', (t) => {
  const { repo } = repository(t, { ignorecase: false });
  assert.deepEqual(repo.trackedPaths('HEAD'), ['src/MD5.cpp']);
});
