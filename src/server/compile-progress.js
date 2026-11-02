import fs from 'node:fs';
import path from 'node:path';

const UNIT_SCRIPT = /_cpp\.sh$/;
const UNIT_DONE = /_cpp\.status$/;
export const ACTIVE_MS = 10 * 60_000;

/**
 * Compile progress of every job directory under `jobsDir`: a unit is queued when its
 * `<unit>_cpp.sh` is written to `out/` and done once its `<unit>_cpp.status` exists.
 * Jobs named `batch-N` or `maintenance-N` carry their batch id. A job is `active` while
 * `out/` keeps changing; a folder a stopped worker left behind goes quiet.
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
    let updated = 0;
    for (const f of files) {
      const unit = UNIT_SCRIPT.test(f);
      const finished = !unit && UNIT_DONE.test(f);
      if (unit) total++;
      else if (finished) done++;
      else continue;
      try {
        updated = Math.max(updated, fs.statSync(path.join(dir, f)).mtimeMs);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    if (!total) continue;
    const m = /^(batch|maintenance)-(\d+)$/.exec(job.name);
    out.push({
      job: job.name,
      batch: m ? Number(m[2]) : null,
      done,
      total,
      percent: Math.round((done / total) * 1000) / 10,
      updatedAt: new Date(updated).toISOString(),
      active: now - updated < activeMs,
    });
  }
  return out.sort((a, b) => a.job.localeCompare(b.job));
}
