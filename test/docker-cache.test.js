import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileUnits, prepareJobDir } from '../src/shared/build.js';

// A Docker stand-in: `image inspect` prints the image ID it was given; `run` executes the unit
// scripts with a stub compiler that writes outputs from the unit and the header it "includes",
// and records the image it was started with.
const IMAGE_ID = 'sha256:' + 'ab'.repeat(32);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-dcache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'u.cpp'), 'unit\n');
  fs.writeFileSync(path.join(repo, 'src', 'a.h'), 'header 1\n');
  const cl = path.join(root, 'cl.cjs');
  fs.writeFileSync(cl, `
const fs = require('node:fs');
const args = process.argv.slice(2);
const job = process.env.JOB;
const p = (w) => w.replace(/^Z:\\\\job/, job).replaceAll('\\\\', '/');
const src = p(args.at(-1));
const text = fs.readFileSync(src, 'utf8') + fs.readFileSync(job + '/src/a.h', 'utf8');
fs.appendFileSync(process.env.CALLS, (args.includes('/P') ? 'pre' : 'compile') + '\\n');
if (args.includes('/P')) fs.writeFileSync(p(args.find((a) => a.startsWith('/Fi')).slice(3)), 'i:' + text);
else {
  fs.writeFileSync(p(args.find((a) => a.startsWith('/Fo')).slice(3)), 'obj:' + text);
  fs.writeFileSync(p(args.find((a) => a.startsWith('/Fa')).slice(3)), 'cod:' + text);
  console.log('Note: including file: Z:\\\\job\\\\src\\\\a.h');
}
`);
  const calls = path.join(root, 'calls');
  const images = path.join(root, 'images');
  const docker = path.join(root, 'docker');
  fs.writeFileSync(docker, `#!/bin/sh
if [ "$1" = image ]; then echo ${IMAGE_ID}; exit 0; fi
for a; do img=$a; case "$a" in sha256:*|stub) echo "$a" >> ${JSON.stringify(images)};; esac; done
job=$(printf '%s\\n' "$@" | sed -n 's/^\\(.*\\):\\/job:rw$/\\1/p')
for s in "$job"/out/*.sh; do
  sed -e 's#^\\. /opt/td/env.sh##' -e "s#/job/#$job/#g" -e "s#^td_cl #JOB=$job CALLS=${calls} ${JSON.stringify(process.execPath)} ${cl} #" -e "s# td_cl # JOB=$job CALLS=${calls} ${JSON.stringify(process.execPath)} ${cl} #g" "$s" > "$s.run"
  sh "$s.run"
done
`, { mode: 0o755 });
  const project = { toolchain: 'stub', cflags: ['/c'], includeDirs: [], sourceDirs: ['src'] };
  const runners = { stub: { type: 'docker', docker, image: 'stub', jobs: 1 } };
  const count = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0);
  const started = () => (fs.existsSync(images) ? fs.readFileSync(images, 'utf8').split('\n').filter(Boolean) : []);
  const cache = { dir: path.join(root, 'cache'), capMb: 100 };
  const build = async (name, { pre = true } = {}) => {
    const jobDir = path.join(root, name);
    prepareJobDir({ repoDir: repo, jobDir, project });
    const [r] = await compileUnits({ jobDir, units: ['src/u.cpp'], project, runners, cache, preprocess: () => pre });
    return r;
  };
  return { repo, build, count, started };
}

test('docker runner: a unit compiled from the same inputs is not compiled again; any input change compiles', { skip: process.platform === 'win32' }, async (t) => {
  const { repo, build, count, started } = fixture(t);

  const first = await build('job1');
  assert.equal(first.ok, true);
  assert.equal(count(), 2, 'compile and /P');
  assert.deepEqual(started(), [IMAGE_ID], 'the container runs the image by the ID the cache key holds');

  const second = await build('job2');
  assert.equal(second.cached, true);
  assert.equal(count(), 2);
  assert.equal(started().length, 1, 'no container when every unit hits');
  assert.equal(fs.readFileSync(second.obj, 'utf8'), 'obj:unit\nheader 1\n');
  assert.equal(fs.readFileSync(second.pre, 'utf8'), 'i:unit\nheader 1\n');
  assert.deepEqual(second.includes, ['src/a.h']);

  fs.writeFileSync(path.join(repo, 'src', 'a.h'), 'header 2\n');
  const third = await build('job3');
  assert.notEqual(third.cached, true, 'an included header changed');
  assert.equal(fs.readFileSync(third.obj, 'utf8'), 'obj:unit\nheader 2\n');

  fs.writeFileSync(path.join(repo, 'src', 'b.h'), 'new\n');
  const fourth = await build('job4');
  assert.notEqual(fourth.cached, true, 'a file added to the tree can change include resolution');
});
