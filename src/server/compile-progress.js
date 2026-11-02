import fs from 'node:fs';
import path from 'node:path';

const UNIT_SCRIPT = /_cpp\.sh$/;
const UNIT_DONE = /_cpp\.status$/;
export const ACTIVE_MS = 10 * 60_000;

/**
 * What a job folder compiles, from the name the verifier gives it: `batch-N` verifies a code batch,
 * `merge-N` recompiles it while merging, `maintenance-N` and `maintenance-base-<commit>` build a
 * maintenance batch and the main it is compared with, `baseline-<job>` refreshes main's scores for
 * that job, `check-<user>-<id>` is a contributor's remote check.
 */
export function describeJob(name) {
  const base = /^baseline-(.+)$/.exec(name);
  if (base) return { ...describeJob(base[1]), lane: 'baseline' };
  let m = /^(batch|merge|maintenance)-(\d+)$/.exec(name);
  if (m) return { lane: m[1] === 'batch' ? 'verify' : m[1], batch: Number(m[2]) };
  if (/^maintenance-base-[0-9a-f]+$/.test(name)) return { lane: 'maintenance-base', batch: null };
  m = /^check-\d+-\d+$/.exec(name);
  if (m) return { lane: 'check', batch: null };
  return { lane: 'other', batch: null };
}

/**
 * Compile progress of every job directory under `jobsDir`: a unit is queued when its
 * `<unit>_cpp.sh` is written to `out/` and done once its `<unit>_cpp.status` exists.
 * A job is `active` while `out/` keeps changing; a folder a stopped worker left behind goes quiet.
 */
export function compileProgress(jobsDir, { now = Date.now(), activeMs = ACTIVE_MS } = {}) {
  let jobs;
  try {
    jobs = fs.readdirSync(jobsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const job of jobs) {
    const dir = path.join(jobsDir, job.name, 'out');
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    let total = 0;
    let done = 0;
    let started = Infinity;
    let updated = 0;
    for (const f of files) {
      const unit = UNIT_SCRIPT.test(f);
      if (unit) total++;
      else if (UNIT_DONE.test(f)) done++;
      else continue;
      try {
        const t = fs.statSync(path.join(dir, f)).mtimeMs;
        if (unit) started = Math.min(started, t);
        updated = Math.max(updated, t);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    if (!total) continue;
    out.push({
      job: job.name,
      ...describeJob(job.name),
      done,
      total,
      percent: Math.round((done / total) * 1000) / 10,
      startedAt: new Date(started).toISOString(),
      updatedAt: new Date(updated).toISOString(),
      active: now - updated < activeMs,
    });
  }
  return out.sort((a, b) => a.job.localeCompare(b.job));
}

/**
 * The public view of the build pipeline: running builds only, with the batch they belong to.
 * Contributors' remote checks are private and left out.
 */
export function pipeline(jobs, batchInfo) {
  return jobs
    .filter((j) => j.active && j.lane !== 'check')
    .map((j) => {
      const b = j.batch === null ? null : batchInfo(j.batch);
      return {
        job: j.job,
        lane: j.lane,
        batch: j.batch,
        author: b?.author ?? null,
        kind: b?.kind ?? null,
        state: b?.state ?? null,
        done: j.done,
        total: j.total,
        percent: j.percent,
        startedAt: j.startedAt,
      };
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
