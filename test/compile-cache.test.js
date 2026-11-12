import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileUnits, prepareJobDir } from '../src/shared/build.js';
import { acquireSlot } from '../src/shared/slots.js';

// A compiler that "includes" src/a.h (reported like cl /showIncludes), embeds the header text in
// its outputs and counts its runs.
const compiler = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const pre = args.includes('/P');
const src = args.at(-1);
const header = path.join(process.cwd(), 'src', 'a.h');
fs.appendFileSync(process.env.CALLS, pre ? 'pre\\n' : 'compile\\n');
const text = fs.readFileSync(src, 'utf8') + fs.readFileSync(header, 'utf8');
if (pre) fs.writeFileSync(args.find((a) => a.startsWith('/Fi')).slice(3), 'i:' + text);
else {
  fs.writeFileSync(args.find((a) => a.startsWith('/Fo')).slice(3), 'obj:' + text);
  fs.writeFileSync(args.find((a) => a.startsWith('/Fa')).slice(3), 'cod:' + text);
  console.log('Note: including file: ' + header);
}
`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'u.cpp'), 'unit\n');
  fs.writeFileSync(path.join(repo, 'src', 'a.h'), 'header 1\n');
  const cl = path.join(root, 'cl.cjs');
  fs.writeFileSync(cl, compiler);
  const calls = path.join(root, 'calls');
  const project = { toolchain: 'stub', cflags: ['/c'], includeDirs: [], sourceDirs: ['src'] };
  const runners = { stub: { type: 'native', clPath: process.execPath, env: { CALLS: calls }, slots: false } };
  // The stub runs as node <cl.cjs> <args>: the "compiler" is node, the script its first flag.
  project.cflags = [cl, '/c'];
  const count = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0);
  const build = async (name) => {
    const jobDir = path.join(root, name);
    prepareJobDir({ repoDir: repo, jobDir, project });
    const [r] = await compileUnits({ jobDir, units: ['src/u.cpp'], project, runners });
    return { r, jobDir };
  };
  return { root, repo, build, count };
}

test('compile cache: another job directory reuses outputs until an included header changes', async (t) => {
  const prev = process.env.TD_COMPILE_CACHE;
  const { root, repo, build, count } = fixture(t);
  process.env.TD_COMPILE_CACHE = path.join(root, 'cache');
  t.after(() => (prev === undefined ? delete process.env.TD_COMPILE_CACHE : (process.env.TD_COMPILE_CACHE = prev)));

  const first = await build('job1');
  assert.equal(first.r.ok, true);
  assert.equal(count(), 2);

  const second = await build('job2');
  assert.equal(second.r.ok, true);
  assert.equal(second.r.cached, true);
  assert.equal(count(), 2, 'no compiler run for an identical unit in another job directory');
  assert.equal(fs.readFileSync(second.r.obj, 'utf8'), 'obj:unit\nheader 1\n');
  assert.equal(fs.readFileSync(second.r.pre, 'utf8'), 'i:unit\nheader 1\n');
  assert.deepEqual(second.r.includes, ['src/a.h'], 'the include list resolves against the new job directory');

  fs.writeFileSync(path.join(repo, 'src', 'a.h'), 'header 2\n');
  const third = await build('job3');
  assert.notEqual(third.r.cached, true);
  assert.equal(count(), 4, 'a changed header compiles again');
  assert.equal(fs.readFileSync(third.r.obj, 'utf8'), 'obj:unit\nheader 2\n');

  fs.writeFileSync(path.join(repo, 'src', 'a.h'), 'header 1\n');
  const fourth = await build('job4');
  assert.equal(fourth.r.cached, true, 'the earlier header version is still a hit');
  assert.equal(fs.readFileSync(fourth.r.obj, 'utf8'), 'obj:unit\nheader 1\n');
});

test('incremental job directory follows edits, deletions and dropped overrides', (t) => {
  const { root, repo } = fixture(t);
  const project = { sourceDirs: ['src'], includeDirs: [] };
  const jobDir = path.join(root, 'job');
  const read = (rel) => (fs.existsSync(path.join(jobDir, rel)) ? fs.readFileSync(path.join(jobDir, rel), 'utf8') : null);
  prepareJobDir({ repoDir: repo, jobDir, project, overrides: { 'src/u.cpp': 'override\n' }, incremental: true });
  assert.equal(read('src/u.cpp'), 'override\n');
  fs.writeFileSync(path.join(jobDir, 'out', 'keep.obj'), 'x');

  fs.writeFileSync(path.join(repo, 'src', 'a.h'), 'header edited\n');
  fs.writeFileSync(path.join(repo, 'src', 'new.h'), 'new\n');
  prepareJobDir({ repoDir: repo, jobDir, project, incremental: true });
  assert.equal(read('src/u.cpp'), 'unit\n', 'a file no longer overridden comes back from the source');
  assert.equal(read('src/a.h'), 'header edited\n');
  assert.equal(read('src/new.h'), 'new\n');
  assert.equal(read('out/keep.obj'), 'x');

  fs.rmSync(path.join(repo, 'src', 'new.h'));
  prepareJobDir({ repoDir: repo, jobDir, project, overrides: { 'src/a.h': null }, incremental: true });
  assert.equal(read('src/new.h'), null);
  assert.equal(read('src/a.h'), null, 'a deleting override removes the file');
});

test('compile slots: never more holders than slots; a dead holder is taken over', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-slots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    const release = await acquireSlot({ dir, count: 2 });
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 30));
    active--;
    release();
  }));
  assert.equal(peak, 2);

  // A slot left by a process that no longer runs.
  fs.writeFileSync(path.join(dir, '0.slot'), `999999999 ${Date.now()}\n`);
  const release = await Promise.race([acquireSlot({ dir, count: 1 }), new Promise((_, no) => setTimeout(() => no(new Error('stuck on a dead slot')), 2000))]);
  release();
});
