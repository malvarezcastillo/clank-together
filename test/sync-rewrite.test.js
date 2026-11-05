import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { localCommitsOnUpstream } from '../src/client/ops.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a' };
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
const commit = (dir, file, text, msg = file) => {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-qm', msg);
  return git(dir, 'rev-parse', 'HEAD');
};

// A server repo and a contributor clone of it; the clone's history is main as it was.
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-sync-rewrite-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = path.join(root, 'server');
  fs.mkdirSync(server);
  git(server, 'init', '-q', '-b', 'main');
  commit(server, 'a.cpp', 'a\n');
  commit(server, 'b.cpp', 'b\n');
  commit(server, 'c.cpp', 'c\n');
  const clone = path.join(root, 'clone');
  git(root, 'clone', '-q', server, clone);
  const ws = { git: (...args) => git(clone, ...args) };
  // The server rewrites every commit after the first (new authors, same changes).
  const rewrite = () => {
    git(server, 'checkout', '-q', '--detach', 'HEAD~2');
    for (const [f, text] of [['b.cpp', 'b\n'], ['c.cpp', 'c\n']]) {
      fs.writeFileSync(path.join(server, f), text);
      git(server, 'add', f);
      execFileSync('git', ['commit', '-qm', f], { cwd: server, env: { ...env, GIT_AUTHOR_NAME: 'renamed' } });
    }
    git(server, 'branch', '-f', 'main', 'HEAD');
    git(server, 'checkout', '-q', 'main');
    git(clone, 'fetch', '-q', 'origin');
  };
  return { server, clone, ws, rewrite };
}

test('a clone whose commits main has under new IDs may follow the rewrite', (t) => {
  const { ws, rewrite } = setup(t);
  rewrite();
  assert.throws(() => ws.git('merge', '--ff-only', '@{u}'), 'a fast-forward is impossible after the rewrite');
  assert.equal(localCommitsOnUpstream(ws), true, 'every commit of the clone is on main by content');
});

test('a clone with a commit main does not have stays where it is', (t) => {
  const { clone, ws, rewrite } = setup(t);
  commit(clone, 'mine.cpp', 'unpublished work\n');
  rewrite();
  assert.equal(localCommitsOnUpstream(ws), false, 'its own work would be lost');
});

test('an up-to-date clone or one only behind main is simply not ahead', (t) => {
  const { server, ws } = setup(t);
  assert.equal(localCommitsOnUpstream(ws), true);
  commit(server, 'd.cpp', 'd\n');
  ws.git('fetch', '-q', 'origin');
  assert.equal(localCommitsOnUpstream(ws), true, 'behind is the ordinary fast-forward case');
});
