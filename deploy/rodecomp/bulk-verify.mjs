import fs from 'node:fs';
import path from 'node:path';
import { openServer } from '/app/src/server/app.js';

const data = '/var/lib/docker/volumes/rodecomp_data/_data';
const ctx = openServer(data);
const units = Object.keys(ctx.project.compile.units).filter(file => file.startsWith('Source/'));
const started = Date.now();
console.log(JSON.stringify({ phase: 'compile-start', units: units.length, head: ctx.repo.head(), at: started }));
const result = await ctx.verifier.check({}, 'admin-readable-source-import', { onlyUnits: units, lint: false, timeoutMs: 6 * 3600_000 });
const check = result.check;
fs.writeFileSync(path.join(data, 'admin-bulk/full-check.json'), JSON.stringify({ check, rec: result.rec, changedHeaders: [] }));
const summary = {
  phase: 'compile-complete',
  commit: ctx.repo.head(),
  units: check.units.length,
  compiled: check.units.filter(unit => unit.compiled).length,
  failed: check.units.filter(unit => !unit.compiled).map(unit => ({ file: unit.file, log: unit.log })),
  annotationErrors: check.annotationErrors,
  unitDiagnostics: check.units.flatMap(unit => unit.errors.map(error => ({ file: unit.file, ...error }))),
  referenceConflicts: result.rec.conflicts,
  seconds: (Date.now() - started) / 1000
};
fs.writeFileSync(path.join(data, 'admin-bulk/verify-result.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, annotationErrors: summary.annotationErrors.length, unitDiagnostics: summary.unitDiagnostics.length, referenceConflicts: summary.referenceConflicts.length }, null, 2));
process.exitCode = summary.failed.length ? 1 : 0;
