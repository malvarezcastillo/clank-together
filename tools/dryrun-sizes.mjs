// Dry run of symbol size corrections: compiles the given units of main once, then compares the
// same objects with the database sizes and with the proposed ones. Nothing is written.
//   node tools/dryrun-sizes.mjs --data <dataDir> --sizes <id->size json> --units <units json> --out <dir>
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openServer } from '../src/server/app.js';
import { checkUnits, analyzeCompiled } from '../src/shared/check.js';
import { scanAnnotations } from '../src/shared/project.js';
import { bestResults } from '../src/server/verify.js';
import { reconcile } from '../src/shared/reconcile.js';

const { values } = parseArgs({ options: { data: { type: 'string' }, sizes: { type: 'string' }, units: { type: 'string' }, out: { type: 'string' } } });
const ctx = openServer(values.data);
const sizes = JSON.parse(fs.readFileSync(values.sizes, 'utf8'));
const units = JSON.parse(fs.readFileSync(values.units, 'utf8'));
const v = ctx.store.currentVersion();
const symbols = ctx.store.symbolMap(v.id);
const nameIndex = ctx.store.nameIndex();
const scan = scanAnnotations(ctx.repo.dir, ctx.project, {});
const pe = ctx.getPe();

let compiled;
const t0 = Date.now();
await checkUnits({
  scan, repoDir: ctx.repo.dir, jobDir: path.join(values.out, 'job'), project: ctx.project, units, overrides: {}, symbols, nameIndex,
  pe, runners: ctx.config.runners, timeoutMs: 6 * 3600_000, lintUnits: new Set(), unitOrder: units,
  analyze: async (args) => { compiled = args.compiled; return []; },
});
console.log(`compiled ${compiled.length} units (${compiled.filter((c) => c.ok).length} ok) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

const roots = { sourceDirs: ctx.project.sourceDirs, includeDirs: ctx.project.includeDirs };
const run = (syms) => {
  const check = { units: analyzeCompiled({ compiled, annotations: scan.annotations, roots, symbols: syms, nameIndex, pe }) };
  for (const u of check.units) for (const f of u.functions) f.comparisonStatus = f.status;
  reconcile(check, syms);
  return new Map([...bestResults(check)].map(([id, { f, unit }]) => [id, { status: f.status, score: f.score, unit, ours: f.size?.ours }]));
};
const A = run(symbols);
const patched = new Map([...symbols].map(([id, s]) => [id, sizes[id] != null ? { ...s, size: sizes[id] } : s]));
const B = run(patched);

const rows = ['id\tunit\tours\tdb_size\tnew_size\told_status\told_score\tnew_status\tnew_score'];
for (const [id, a] of A) {
  const b = B.get(id);
  rows.push([id, a.unit, a.ours, symbols.get(id)?.size, sizes[id] ?? '', a.status, a.score, b?.status, b?.score].join('\t'));
}
fs.writeFileSync(path.join(values.out, 'functions.tsv'), rows.join('\n') + '\n');
fs.rmSync(path.join(values.out, 'job'), { recursive: true, force: true });
console.log('done');
