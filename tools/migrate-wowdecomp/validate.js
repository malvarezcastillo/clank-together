#!/usr/bin/env node
// Compiles units of a converted tree through the coordinator's own pipeline and compares
// the verdicts with verify15890.py's (byte_match15890 dump).
//
//   node validate.js --tree <dir> --symbols <symbols.json> --dump <dump dir> --exe <Wow15890-64.exe>
//                    --cl <cl.exe> --tc <toolchain root> [--units a.cpp,b.cpp | --sample N] [--jobs 8]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PEImage } from '../../src/shared/pe.js';
import { loadProject } from '../../src/shared/project.js';
import { checkUnits } from '../../src/shared/check.js';
import { reconcile } from '../../src/shared/reconcile.js';
import { STATUS } from '../../src/shared/compare.js';
import { hex } from '../../src/shared/annotations.js';

const { values: o } = parseArgs({
  options: {
    tree: { type: 'string' }, symbols: { type: 'string' }, dump: { type: 'string' }, exe: { type: 'string' },
    cl: { type: 'string' }, tc: { type: 'string' }, units: { type: 'string' }, sample: { type: 'string', default: '20' },
    jobs: { type: 'string', default: String(Math.max(1, os.cpus().length - 2)) }, show: { type: 'string', default: '8' },
    image: { type: 'string' }, memory: { type: 'string', default: '6g' }, user: { type: 'string', default: '1000:1000' },
  },
});

const snap = JSON.parse(fs.readFileSync(o.symbols, 'utf8'));
const V = snap.current;
const symbols = new Map();
for (const s of snap.symbols) {
  const [addr, size] = s.addrs[V] ?? [null, null];
  symbols.set(s.id, { id: s.id, kind: s.kind, addr, size, decorated: s.decorated, library: s.library });
}
const nameIndex = new Map(snap.symbols.filter((s) => s.decorated).map((s) => [s.decorated, s.id]));
const verdicts = new Map(JSON.parse(fs.readFileSync(path.join(o.dump, 'byte_match15890.json'), 'utf8')).map(([ea, sym, v]) => [ea, v]));

const project = loadProject(o.tree);
let units = o.units ? o.units.split(',') : null;
if (!units) {
  // Units with the most proven functions first: the best test of the comparer.
  const perUnit = new Map();
  for (const p of snap.proven) perUnit.set(p.file, (perUnit.get(p.file) ?? 0) + 1);
  units = [...perUnit].filter(([f]) => project.compile.units[f] !== undefined).sort((a, b) => b[1] - a[1]).slice(0, Number(o.sample)).map(([f]) => f);
}

const pe = new PEImage(fs.readFileSync(o.exe));
// --image: the coordinator's sandbox (cl.exe under Wine in Docker); otherwise a local cl.exe.
const runner = o.image
  ? { type: 'docker', image: o.image, jobs: Number(o.jobs), memory: o.memory, cpus: Number(o.jobs), user: o.user }
  : { type: 'native', clPath: o.cl, toolchainRoot: o.tc, jobs: Number(o.jobs), env: { PATH: `${path.dirname(o.cl)};${process.env.PATH}` } };
const t0 = Date.now();
const check = await checkUnits({
  repoDir: o.tree,
  jobDir: path.join(os.tmpdir(), 'td-validate'),
  project,
  units,
  symbols,
  nameIndex,
  pe,
  runners: { [project.toolchain]: runner },
  timeoutMs: 600_000,
});
const rec = reconcile(check, symbols);
const secs = ((Date.now() - t0) / 1000).toFixed(0);

const matrix = {};
const disagreements = [];
let failedUnits = 0;
// One result per ID: a header function compiled in several units counts once, with its best result.
const RANK = { exact: 4, match_unresolved: 3, mismatch: 2, missing: 1, no_address: 0 };
const best = new Map();
for (const u of check.units) {
  if (!u.compiled) {
    failedUnits++;
    console.log(`COMPILE FAILED ${u.file}\n${u.log.split('\n').slice(0, 6).join('\n')}`);
  }
  for (const f of u.functions) {
    const prev = best.get(f.id);
    if (!prev || RANK[f.status] > RANK[prev.f.status]) best.set(f.id, { f, u });
  }
}
for (const { f, u } of best.values()) {
  {
    const theirs = f.addr != null ? verdicts.get(f.addr) ?? 'none' : 'no_addr';
    const key = `${f.status} / theirs ${theirs}`;
    matrix[key] = (matrix[key] ?? 0) + 1;
    const oursMatch = f.status === STATUS.EXACT || f.status === STATUS.UNRESOLVED;
    if ((theirs === 'IDENTICAL') !== oursMatch) disagreements.push({ ...f, theirs, unit: u.file });
  }
}
console.log(`\n${check.units.length} units (${failedUnits} failed to compile) in ${secs}s`);
console.log(Object.entries(matrix).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${String(n).padStart(6)}  ${k}`).join('\n'));
console.log(`reference conflicts: ${rec.conflicts.length}, unknown references: ${rec.unknown.length}, learned names: ${rec.learned.length}`);
console.log(`\ndisagreements: ${disagreements.length}`);
for (const d of disagreements.slice(0, Number(o.show))) {
  console.log(`\n${d.id} ${d.demangled ?? d.symbol} @0x${d.addr != null ? hex(d.addr) : '?'} ours=${d.status} ${d.score} theirs=${d.theirs} size ${d.size?.ours}/${d.size?.original}  (${d.file}:${d.line})`);
  for (const r of (d.diffRegions ?? []).slice(0, 4)) console.log(`   +0x${r.offset.toString(16)} ours ${r.ours} orig ${r.original}  ${r.ourInstruction ?? ''}`);
  for (const r of (d.relocations ?? []).filter((x) => !x.ok).slice(0, 4)) console.log(`   reloc +0x${r.offset.toString(16)} ${r.symbol}: ${r.reason}`);
}
fs.writeFileSync(path.join(os.tmpdir(), 'td-validate.json'), JSON.stringify({ matrix, disagreements, conflicts: rec.conflicts }, null, 1));
