import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileProgress, describeJob, pipeline } from '../src/server/compile-progress.js';
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
    { job: 'baseline-batch-8608', lane: 'baseline', batch: 8608, done: 1, total: 1, percent: 100, startedAt: new Date(now - 3 * 3_600_000).toISOString(), updatedAt: new Date(now - 3 * 3_600_000).toISOString(), active: false },
    { job: 'maintenance-10026', lane: 'maintenance', batch: 10026, done: 3, total: 8, percent: 37.5, startedAt: new Date(now - 30_000).toISOString(), updatedAt: new Date(now - 30_000).toISOString(), active: true },
  ]);
  assert.deepEqual(compileProgress(path.join(dir, 'missing'), { now }), []);
});

test('job folder names map to the lane that builds them', () => {
  assert.deepEqual(describeJob('batch-12'), { lane: 'verify', batch: 12 });
  assert.deepEqual(describeJob('merge-12'), { lane: 'merge', batch: 12 });
  assert.deepEqual(describeJob('maintenance-12'), { lane: 'maintenance', batch: 12 });
  assert.deepEqual(describeJob('maintenance-base-5dcd3c8ee0'), { lane: 'maintenance-base', batch: null });
  assert.deepEqual(describeJob('baseline-merge-12'), { lane: 'baseline', batch: 12 });
  assert.deepEqual(describeJob('check-3-99'), { lane: 'check', batch: null });
  assert.deepEqual(describeJob('something'), { lane: 'other', batch: null });
});

test('the public pipeline shows running builds oldest first, without stale folders or private checks', () => {
  const job = (name, startedAt, active, extra = {}) => ({ job: name, ...describeJob(name), done: 1, total: 4, percent: 25, startedAt, updatedAt: startedAt, active, ...extra });
  const batches = { 7: { kind: 'code', state: 'merging', author: 'dori' }, 9: { kind: 'maintenance', state: 'verifying', author: 'ragnarok-clanker' } };
  assert.deepEqual(
    pipeline([
      job('maintenance-9', '2026-11-02T12:05:00.000Z', true),
      job('merge-7', '2026-11-02T12:00:00.000Z', true),
      job('baseline-batch-1', '2026-10-31T00:00:00.000Z', false),
      job('check-3-99', '2026-11-02T12:01:00.000Z', true),
      job('maintenance-base-abc', '2026-11-02T12:06:00.000Z', true),
    ], (id) => batches[id]),
    [
      { job: 'merge-7', lane: 'merge', batch: 7, author: 'dori', kind: 'code', state: 'merging', done: 1, total: 4, percent: 25, startedAt: '2026-11-02T12:00:00.000Z' },
      { job: 'maintenance-9', lane: 'maintenance', batch: 9, author: 'ragnarok-clanker', kind: 'maintenance', state: 'verifying', done: 1, total: 4, percent: 25, startedAt: '2026-11-02T12:05:00.000Z' },
      { job: 'maintenance-base-abc', lane: 'maintenance-base', batch: null, author: null, kind: null, state: null, done: 1, total: 4, percent: 25, startedAt: '2026-11-02T12:06:00.000Z' },
    ],
  );
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
