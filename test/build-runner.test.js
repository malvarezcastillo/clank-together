import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileUnits, dockerDeadlineMs, outputBase, run } from '../src/shared/build.js';
import { analyzeCompiled, summarizeCheck } from '../src/shared/check.js';

const compiler = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const pre = args.includes('/P');
const file = args.at(-1).replaceAll('\\\\', '/').split('/').at(-1);
const mode = file.split('.')[0];
const base = path.join(process.cwd(), 'out', file.replaceAll('.', '_'));
fs.appendFileSync(base + '.calls', pre ? 'pre\\n' : 'compile\\n');
fs.writeFileSync(base + (pre ? '.i' : '.obj'), 'partial');
if (mode === 'error') process.exit(2);
if ((!pre && mode === 'compile-timeout') || (pre && mode === 'pre-timeout')) setInterval(() => {}, 1000);
`;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'out'));
  const cl = path.join(dir, 'compiler.cjs');
  fs.writeFileSync(cl, compiler);
  return { dir, cl, project: { toolchain: 'stub', cflags: ['/c'], includeDirs: [], sourceDirs: [] } };
}

test('Docker deadlines scale by work waves, retain floors and explicit overrides', () => {
  const deadline = (unitCount, jobs, timeoutMs = 300_000) => dockerDeadlineMs({ unitCount, jobs, timeoutMs, scaleTimeout: true });
  assert.equal(deadline(1, 2), 300_000);
  assert.equal(deadline(20, 2), 300_000);
  assert.equal(deadline(21, 2), 330_000);
  assert.equal(deadline(21, 4), 300_000);
  assert.equal(deadline(348, 2), 1_200_000);
  assert.equal(deadline(348, 4), 1_200_000);
  assert.equal(deadline(10000, 2, 21_600_000), 21_600_000);
  assert.equal(dockerDeadlineMs({ unitCount: 348, jobs: 2, timeoutMs: 25 }), 25);
});

for (const mode of ['compile-timeout', 'pre-timeout', 'error', 'success']) {
  test(`compiler process: ${mode} never accepts incomplete artifacts`, async (t) => {
    const { dir, cl, project } = fixture(t);
    const file = `${mode}.cpp`;
    const [result] = await compileUnits({ jobDir: dir, units: [file], project, timeoutMs: 1000,
      runners: { stub: { type: 'wine', wine: process.execPath, clPath: cl } } });
    assert.equal(result.timedOut, mode.endsWith('timeout'));
    assert.equal(result.ok, mode === 'success');
    const base = path.join(dir, 'out', outputBase(file));
    assert.ok(fs.existsSync(base + '.obj'));
    assert.equal(fs.readFileSync(base + '.calls', 'utf8'), ['compile-timeout', 'error'].includes(mode) ? 'compile\n' : 'compile\npre\n');
    if (!result.ok) {
      assert.equal(result.obj, null);
      assert.equal(result.pre, null);
      assert.equal(result.cod, null);
      const units = analyzeCompiled({ compiled: [result], annotations: [], roots: project, symbols: new Map(), nameIndex: new Map() });
      assert.equal(units[0].timedOut, result.timedOut);
      const summary = summarizeCheck({ units, annotationErrors: [] }, { conflicts: [], unknown: [] });
      assert.equal(summary.units[0].timedOut, result.timedOut);
    }
  });
}

test('timeout waits for asynchronous cancellation before returning', async () => {
  let cancelled = false;
  const result = await run(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], {
    timeoutMs: 20,
    onTimeout: async () => { await new Promise((resolve) => setTimeout(resolve, 400)); cancelled = true; },
  });
  assert.equal(result.timedOut, true);
  assert.equal(cancelled, true);
});

// Execute the generated POSIX unit scripts with actual stub compiler children. The
// Docker stand-in only supplies the mount/env mapping and process cancellation.
test('Docker keeps completed units but rejects partial outputs after batch cancellation', { skip: process.platform === 'win32' }, async (t) => {
  const { dir, cl, project } = fixture(t);
  const docker = path.join(dir, 'docker');
  fs.writeFileSync(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const pidFile = path.join(dir, 'pid');
if (process.argv[2] === 'kill') {
  process.kill(-Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
  setTimeout(() => { fs.writeFileSync(path.join(dir, 'cancelled'), 'yes'); }, 150);
} else {
  const files = fs.readdirSync(path.join(dir, 'out')).filter(f => f.endsWith('.sh')).sort();
  const script = files.map(f => fs.readFileSync(path.join(dir, 'out', f), 'utf8')
    .replace('. /opt/td/env.sh', '')
    .replaceAll('/job/', dir + '/')
    .replaceAll('td_cl ', JSON.stringify(process.execPath) + ' ' + JSON.stringify(${JSON.stringify(cl)}) + ' '))
    .map(s => '(\\n' + s + '\\n)').join('\\n');
  const child = cp.spawn('sh', ['-c', script], { cwd: dir, detached: true, stdio: 'inherit' });
  fs.writeFileSync(pidFile, String(child.pid));
  child.on('close', code => process.exit(code ?? 1));
}
`, { mode: 0o755 });
  const units = ['a-success.cpp', 'error.cpp', 'pre-timeout.cpp'];
  const results = await compileUnits({ jobDir: dir, units, project, timeoutMs: 2000,
    runners: { stub: { type: 'docker', docker, image: 'stub', jobs: 1 } } });
  assert.equal(fs.readFileSync(path.join(dir, 'cancelled'), 'utf8'), 'yes');
  assert.equal(results[0].ok, true);
  assert.equal(results[0].timedOut, false);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].timedOut, false);
  assert.equal(results[1].obj, null);
  assert.equal(results[2].ok, false);
  assert.equal(results[2].timedOut, true);
  assert.equal(results[2].obj, null);
  assert.equal(results[2].pre, null);
  assert.ok(fs.existsSync(path.join(dir, 'out', 'pre-timeout_cpp.obj')));
  assert.ok(fs.existsSync(path.join(dir, 'out', 'pre-timeout_cpp.i')));
});
