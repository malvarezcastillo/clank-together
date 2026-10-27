import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Repo } from '../src/server/git.js';
import { sourceIncluders } from '../src/server/includers.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-includers-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const repo = new Repo(dir);
  const project = { sourceDirs: ['src'], includeDirs: [], compile: { units: { 'src/a.cpp': 0, 'src/b.cpp': 0 } } };
  repo.commitFiles({
    'src/target.h': 'int value();\n',
    'src/left.h': '#include "right.h"\n#include "target.h"\n',
    'src/right.h': '#include "left.h"\n',
    'src/a.cpp': '#include "left.h"\n',
    'src/b.cpp': '#include "right.h"\n',
    'src/한글 file.h': 'const char* name = "이름";\n',
  }, 'fixture', 'test <test@example.invalid>');
  return { dir, repo, project };
}

test('batch blob reads preserve UTF-8 bytes, spaces, empty files and absent paths', () => {
  const { dir, repo } = fixture();
  try {
    repo.commitFiles({ 'src/empty.h': '' }, 'empty header', 'test <test@example.invalid>');
    const files = ['src/한글 file.h', 'src/empty.h', 'src/missing.h', 'src/target.h'];
    const snapshot = repo.showMany(repo.head(), files);
    assert.equal(snapshot.get(files[0]), 'const char* name = "이름";\n');
    assert.equal(snapshot.get(files[1]), '');
    assert.equal(snapshot.get(files[2]), null);
    assert.equal(snapshot.get(files[3]), 'int value();\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('include cycles, submitted overrides and head changes preserve transitive dependencies', () => {
  const { dir, repo, project } = fixture();
  try {
    assert.deepEqual(sourceIncluders(repo, project, ['src/target.h']), ['src/a.cpp', 'src/b.cpp']);
    fs.writeFileSync(path.join(dir, 'src/left.h'), 'int dirtyWorkingTree;\n');
    assert.deepEqual(sourceIncluders(repo, project, ['src/target.h']), ['src/a.cpp', 'src/b.cpp'], 'reads committed sources, not uncommitted data');
    assert.deepEqual(sourceIncluders(repo, project, ['src/target.h'], { 'src/left.h': '#include "right.h"\n' }), [], 'overrides apply to this query only');
    assert.deepEqual(sourceIncluders(repo, project, ['src/target.h']), ['src/a.cpp', 'src/b.cpp']);
    repo.commitFiles({ 'src/left.h': '#include "right.h"\n' }, 'remove target include', 'test <test@example.invalid>');
    assert.deepEqual(sourceIncluders(repo, project, ['src/target.h']), [], 'a new commit invalidates cached source content');
    assert.deepEqual(sourceIncluders(repo, project, ['src/new.h'], { 'src/a.cpp': '#include "new.h"\n', 'src/new.h': 'int next();\n' }), ['src/a.cpp']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
