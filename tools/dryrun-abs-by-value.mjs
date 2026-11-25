// Dry run of "judge absolute pointers by value when the image has no relocation table".
// Compiles every unit of main once (the server's own pipeline and compilers), then compares the same
// objects twice: with the current rule and with the new one. Nothing is written to the database.
//
//   node tools/dryrun-abs-by-value.mjs --data <dataDir> --out <dir>
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openServer } from '../src/server/app.js';
import { PEImage } from '../src/shared/pe.js';
import { checkUnits, analyzeCompiled } from '../src/shared/check.js';
import { scanAnnotations, listSources } from '../src/shared/project.js';
import { bestResults } from '../src/server/verify.js';
import { reconcile } from '../src/shared/reconcile.js';

const { values } = parseArgs({ options: { data: { type: 'string' }, out: { type: 'string' } } });
const ctx = openServer(values.data);
const out = values.out;
fs.mkdirSync(out, { recursive: true });

const v = ctx.store.currentVersion();
const symbols = ctx.store.symbolMap(v.id);
const nameIndex = ctx.store.nameIndex();
const head = ctx.repo.head();
const scan = scanAnnotations(ctx.repo.dir, ctx.project, {});
const units = listSources(ctx.repo.dir, ctx.project, { unitsOnly: true });
const jobDir = path.join(out, 'job');

const t0 = Date.now();
let compiled;
// Compile once; analysis is passed in so we can keep `compiled` and analyze it twice.
await checkUnits({
  scan, repoDir: ctx.repo.dir, jobDir, project: ctx.project, units, overrides: {}, symbols, nameIndex,
  pe: ctx.getPe(), runners: ctx.config.runners, timeoutMs: 6 * 3600_000, lintUnits: new Set(), unitOrder: units,
  analyze: async (args) => { compiled = args.compiled; return []; },
});
console.log(`compiled ${compiled.length} units (${compiled.filter((c) => c.ok).length} ok) in ${((Date.now() - t0) / 1000).toFixed(0)}s at ${head}`);

const roots = { sourceDirs: ctx.project.sourceDirs, includeDirs: ctx.project.includeDirs };
const run = (label, pe) => {
  const t = Date.now();
  const unitsOut = analyzeCompiled({ compiled, annotations: scan.annotations, roots, symbols, nameIndex, pe });
  const check = { units: unitsOut };
  for (const u of check.units) for (const f of u.functions) f.comparisonStatus = f.status;
  reconcile(check, symbols);
  const best = new Map([...bestResults(check)].map(([id, { f, unit }]) => [id, { status: f.status, score: f.score, unit }]));
  console.log(`${label}: analyzed in ${((Date.now() - t) / 1000).toFixed(0)}s, ${best.size} functions`);
  return best;
};

const peFile = fs.readFileSync(v.file);
const oldPe = new PEImage(peFile);
oldPe.relocsStripped = false; // the current rule: an absolute pointer without a base relocation fails
const newPe = new PEImage(peFile);
if (!newPe.relocsStripped) throw new Error('target is not RELOCS_STRIPPED; the new rule would change nothing');
const A = run('current rule', oldPe);
const B = run('by value', newPe);

const rows = ['id\tunit\told_status\told_score\tnew_status\tnew_score\tdb_status\tdb_score'];
const db = new Map(ctx.store.all('SELECT symbol_id, status, score FROM func_status').map((r) => [r.symbol_id, r]));
for (const [id, a] of A) {
  const b = B.get(id);
  const d = db.get(id);
  rows.push([id, a.unit, a.status, a.score, b?.status, b?.score, d?.status ?? '', d?.score ?? ''].join('\t'));
}
fs.writeFileSync(path.join(out, 'functions.tsv'), rows.join('\n') + '\n');
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({ head, units: compiled.length, ok: compiled.filter((c) => c.ok).length, at: Date.now() }, null, 2));
fs.rmSync(jobDir, { recursive: true, force: true });
console.log(`wrote ${out}/functions.tsv`);
