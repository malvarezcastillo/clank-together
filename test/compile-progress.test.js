import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileProgress } from '../src/server/compile-progress.js';
import { Verifier } from '../src/server/verify.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-jobs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function job(dir, name, { queued, finished, at }) {
  const out = path.join(dir, name, 'out');
  fs.mkdirSync(out, { recursive: true });
  for (let i = 0; i < queued; i++) {
    for (const suffix of i < finished ? ['.sh', '.status', '.obj'] : ['.sh']) {
      const f = path.join(out, `Source_U${i}_cpp${suffix}`);
      fs.writeFileSync(f, '');
      fs.utimesSync(f, at / 1000, at / 1000);
    }
  }
}

test('reports finished/queued units, the batch id, and whether the job is still moving', (t) => {
  const dir = tempDir(t);
  const now = Date.UTC(2026, 10, 2, 12);
  job(dir, 'maintenance-10026', { queued: 8, finished: 3, at: now - 30_000 });
  job(dir, 'baseline-batch-8608', { queued: 1, finished: 1, at: now - 3 * 3_600_000 });
  fs.mkdirSync(path.join(dir, 'batch-7', 'out'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'preparing'));

  assert.deepEqual(compileProgress(dir, { now }), [
    { job: 'baseline-batch-8608', batch: null, done: 1, total: 1, percent: 100, updatedAt: new Date(now - 3 * 3_600_000).toISOString(), active: false },
    { job: 'maintenance-10026', batch: 10026, done: 3, total: 8, percent: 37.5, updatedAt: new Date(now - 30_000).toISOString(), active: true },
  ]);
  assert.deepEqual(compileProgress(path.join(dir, 'missing'), { now }), []);
});

test('a starting worker removes job folders an interrupted run left behind, unless they are kept', (t) => {
  const dir = tempDir(t);
  const jobs = path.join(dir, 'jobs');
  const quiet = { info() {}, error() {}, warn() {} };
  const verifier = (config) => new Verifier({ store: null, config: { dataDir: dir, ...config }, log: quiet });
  job(jobs, 'maintenance-base-5dcd3c8ee0', { queued: 2, finished: 2, at: Date.now() });
  job(jobs, 'batch-42', { queued: 2, finished: 0, at: Date.now() });

  verifier({ keepJobDirs: true }).clearStaleJobs();
  assert.deepEqual(fs.readdirSync(jobs).sort(), ['batch-42', 'maintenance-base-5dcd3c8ee0']);

  verifier({}).clearStaleJobs();
  assert.deepEqual(fs.readdirSync(jobs), []);

  fs.rmSync(jobs, { recursive: true });
  assert.doesNotThrow(() => verifier({}).clearStaleJobs());
});
