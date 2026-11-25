// Dry run: compiles the given units of main with a candidate data/compile.json and prints each
// function's status and score next to the database's. Nothing is written.
//   node tools/dryrun-units.mjs --data <dataDir> --compile <compile.json> --out <dir> <unit> ...
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openServer } from '../src/server/app.js';
import { checkUnits } from '../src/shared/check.js';
import { scanAnnotations } from '../src/shared/project.js';
import { bestResults } from '../src/server/verify.js';
import { reconcile } from '../src/shared/reconcile.js';

const { values, positionals } = parseArgs({ options: { data: { type: 'string' }, compile: { type: 'string' }, out: { type: 'string' } }, allowPositionals: true });
const ctx = openServer(values.data);
const compile = JSON.parse(fs.readFileSync(values.compile, 'utf8'));
const project = { ...ctx.project, compile: { ...ctx.project.compile, shapes: compile.shapes, units: compile.units } };
const v = ctx.store.currentVersion();
const symbols = ctx.store.symbolMap(v.id);
const nameIndex = ctx.store.nameIndex();
const scan = scanAnnotations(ctx.repo.dir, project, {});
const check = await checkUnits({
  scan, repoDir: ctx.repo.dir, jobDir: path.join(values.out, 'job'), project, units: positionals, overrides: {}, symbols, nameIndex,
  pe: ctx.getPe(), runners: ctx.config.runners, timeoutMs: 1800_000, lintUnits: new Set(), unitOrder: positionals,
});
for (const u of check.units) for (const f of u.functions) f.comparisonStatus = f.status;
reconcile(check, symbols);
const db = new Map(ctx.store.all('SELECT symbol_id, status, score FROM func_status').map((r) => [r.symbol_id, r]));
for (const u of check.units) console.log(`${u.file}: ${u.compiled ? 'compiled' : 'FAILED\n' + u.log}`);
for (const [id, { f, unit }] of bestResults(check)) {
  const d = db.get(id);
  console.log([unit, id, f.status, f.score, d?.status ?? '-', d?.score ?? '-'].join('\t'));
}
fs.rmSync(path.join(values.out, 'job'), { recursive: true, force: true });
