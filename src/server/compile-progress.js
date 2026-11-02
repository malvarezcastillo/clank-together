import fs from 'node:fs';
import path from 'node:path';

const UNIT_SCRIPT = /_cpp\.sh$/;
const UNIT_DONE = /_cpp\.status$/;

/**
 * Compile progress of every job directory under `jobsDir`: a unit is queued when its
 * `<unit>_cpp.sh` is written to `out/` and done once its `<unit>_cpp.status` exists.
 * Jobs named `batch-N` or `maintenance-N` carry their batch id.
 */
export function compileProgress(jobsDir) {
  let jobs;
  try {
    jobs = fs.readdirSync(jobsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const job of jobs) {
    let files;
    try {
      files = fs.readdirSync(path.join(jobsDir, job.name, 'out'));
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    let total = 0;
    let done = 0;
    for (const f of files) {
      if (UNIT_SCRIPT.test(f)) total++;
      else if (UNIT_DONE.test(f)) done++;
    }
    if (!total) continue;
    const m = /^(batch|maintenance)-(\d+)$/.exec(job.name);
    out.push({
      job: job.name,
      batch: m ? Number(m[2]) : null,
      done,
      total,
      percent: Math.round((done / total) * 1000) / 10,
    });
  }
  return out.sort((a, b) => a.job.localeCompare(b.job));
}
