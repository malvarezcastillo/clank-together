import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { unitPrelude } from '../src/shared/build.js';
import { Repo } from '../src/server/git.js';
import { sourceIncluders } from '../src/server/includers.js';

test('a unit has a prelude only when the project names a prelude folder and its file exists', () => {
  const have = new Set(['Source/Linkage/Source/A.cpp.h']);
  const exists = (rel) => have.has(rel);
  assert.equal(unitPrelude({ unitPrelude: 'Source/Linkage' }, 'Source/A.cpp', exists), 'Source/Linkage/Source/A.cpp.h');
  assert.equal(unitPrelude({ unitPrelude: 'Source/Linkage/' }, 'Source/A.cpp', exists), 'Source/Linkage/Source/A.cpp.h', 'a trailing slash is the same folder');
  assert.equal(unitPrelude({ unitPrelude: 'Source/Linkage' }, 'Source/B.cpp', exists), null, 'no file: no /FI');
  assert.equal(unitPrelude({}, 'Source/A.cpp', exists), null, 'projects without the setting are unchanged');
});

test('changing a prelude recompiles exactly the unit it is forced into', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-prelude-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'Source', 'Linkage', 'Source'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Source', 'A.cpp'), 'int a;\n');
  fs.writeFileSync(path.join(dir, 'Source', 'B.cpp'), 'int b;\n');
  fs.writeFileSync(path.join(dir, 'Source', 'Linkage', 'Source', 'A.cpp.h'), '#pragma once\n');
  git('add', '-A');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'base');
  const units = { 'Source/A.cpp': 0, 'Source/B.cpp': 0 };
  const project = { sourceDirs: ['Source'], includeDirs: [], unitPrelude: 'Source/Linkage', compile: { units } };
  const repo = new Repo(dir);
  assert.deepEqual(sourceIncluders(repo, project, ['Source/Linkage/Source/A.cpp.h']), ['Source/A.cpp']);
  assert.deepEqual(sourceIncluders(repo, { ...project, unitPrelude: undefined }, ['Source/Linkage/Source/A.cpp.h']), [], 'without the setting it is an ordinary header');
});
