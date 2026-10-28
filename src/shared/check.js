// The compile + compare pipeline. The server's verifier and the contributor's
// `td check` both run this, so a local result predicts the server result.

import fs from 'node:fs';
import path from 'node:path';
import { CoffObject } from './coff.js';
import { parseListing, normalizePath } from './listing.js';
import { compareObject } from './compare.js';
import { lintAnnotations, hex } from './annotations.js';
import { lintPreprocessed } from './lint.js';
import { compileUnits, prepareJobDir } from './build.js';
import { scanAnnotations } from './project.js';

/**
 * @param {object} p
 * @param {string} p.repoDir
 * @param {string} p.jobDir
 * @param {object} p.project
 * @param {string[]} p.units                  .cpp files to compile and compare
 * @param {Record<string,string>} [p.overrides] submitted file contents
 * @param {Map<string,object>} p.symbols      ID -> {kind, addr, size, library}
 * @param {Map<string,string>} p.nameIndex    decorated name -> ID
 * @param {import('./pe.js').PEImage} p.pe
 * @param {Record<string,object>} p.runners
 */
// lintUnits: units whose preprocessed output is scanned (default: all compiled units).
// analyze: replaces the in-process analysis of the compiler output (the server runs it in worker
// threads, so a check of many units doesn't block it).
export async function checkUnits({ repoDir, jobDir, project, units, overrides = {}, symbols, nameIndex, pe, runners, timeoutMs, lintUnits = null, analyze = null }) {
  const scan = scanAnnotations(repoDir, project, overrides);
  const annotationErrors = [...scan.errors, ...lintAnnotations(scan.annotations, symbols)];

  prepareJobDir({ repoDir, jobDir, project, overrides });
  const compiled = await compileUnits({ jobDir, units, project, runners, timeoutMs, preprocess: (f) => !lintUnits || lintUnits.has(f) });

  const roots = { sourceDirs: project.sourceDirs, includeDirs: project.includeDirs };
  const names = withGlobalBindings(compiled, scan.annotations, nameIndex);
  const results = analyze
    ? await analyze({ compiled, annotations: scan.annotations, roots, nameIndex: names })
    : analyzeCompiled({ compiled, annotations: scan.annotations, roots, symbols, nameIndex: names, pe });
  return { annotationErrors, units: results, annotations: scan.annotations };
}

/**
 * A GLOBAL annotation binds its variable's decorated name in the unit that defines it, or that
 * declares it (an annotated extern: the listing names it as EXTRN). References from the other
 * units of the same check resolve to that ID too, as they do on main once the name is learned:
 * the name index the units are compared with includes them.
 */
export function withGlobalBindings(compiled, annotations, nameIndex) {
  const globals = annotations.filter((a) => a.kind === 'GLOBAL' && a.name);
  if (!globals.length) return nameIndex;
  const byFile = new Map();
  for (const a of globals) byFile.set(a.file, [...(byFile.get(a.file) ?? []), a]);
  const out = new Map(nameIndex);
  for (const c of compiled) {
    if (!c.ok || !c.cod) continue;
    const anns = [...(byFile.get(c.file) ?? []), ...(c.includes ?? []).flatMap((h) => byFile.get(h) ?? [])];
    if (!anns.length) continue;
    const listing = parseListing(fs.readFileSync(c.cod, 'latin1'));
    for (const a of anns) {
      const matches = (d) => d === a.name || (d && d.endsWith('::' + a.name));
      const hit = listing.data.find((d) => matches(d.demangled))?.symbol ?? [...listing.names].find(([sym, d]) => sym.startsWith('?') && matches(d))?.[0];
      if (hit && !out.has(hit)) out.set(hit, a.id);
    }
  }
  return out;
}

/** Lints and compares the compiler output of each unit against the original. */
export function analyzeCompiled({ compiled, annotations, roots, symbols, nameIndex, pe }) {
  const projectRoots = [...roots.sourceDirs, ...roots.includeDirs].map((d) => '/' + normalizePath(d) + '/');
  const isProjectFile = (f) => projectRoots.some((r) => f.includes(r));

  const results = [];
  for (const c of compiled) {
    const unit = { file: c.file, compiled: c.ok, log: trimLog(c.log), includes: c.includes ?? [], lintErrors: [], functions: [], inferred: [], bindings: {}, unannotated: [], errors: [] };
    if (c.pre) unit.lintErrors = lintPreprocessed(fs.readFileSync(c.pre, 'latin1'), isProjectFile);
    if (c.ok) {
      try {
        const obj = new CoffObject(fs.readFileSync(c.obj));
        const listing = parseListing(c.cod ? fs.readFileSync(c.cod, 'latin1') : '');
        Object.assign(unit, compareObject({ obj, listing, file: c.file, annotations, symbols, nameIndex, pe }));
      } catch (e) {
        unit.errors.push({ file: c.file, message: `could not analyze compiler output: ${e.message}` });
      }
    }
    results.push(unit);
  }
  return results;
}

function trimLog(log) {
  if (!log) return '';
  // Drop the noise cl.exe prints for every file, keep diagnostics.
  const lines = log.split(/\r?\n/).filter((l) => l.trim() && !/^(== |Microsoft \(R\)|Copyright \(C\)|Note: including file:)/.test(l) && !/^\S+\.(c|cpp|cc|cxx)$/i.test(l.trim()));
  return lines.slice(0, 200).join('\n');
}

/** Flattens a check result into per-ID function results. */
export function functionResults(check) {
  const out = new Map();
  for (const u of check.units) for (const f of u.functions) out.set(f.id, { ...f, file: u.file });
  return out;
}

export function jobDirFor(base, name) {
  return path.join(base, name.replace(/[^A-Za-z0-9_-]/g, '_'));
}

/** `files`: the files the user asked about; annotation problems elsewhere in the repo are not theirs. */
export function summarizeCheck(result, rec, files = null) {
  return {
    annotationErrors: files ? result.annotationErrors.filter((e) => files.has(e.file)) : result.annotationErrors,
    units: result.units.map((u) => ({
      file: u.file,
      compiled: u.compiled,
      log: u.compiled ? undefined : u.log,
      lintErrors: u.lintErrors,
      errors: u.errors,
      unannotated: u.unannotated,
      functions: u.functions.map((f) => ({
        id: f.id,
        name: f.demangled,
        addr: f.addr != null ? '0x' + hex(f.addr) : null,
        status: f.status,
        score: f.score,
        size: f.size,
        diffRegions: f.diffRegions?.slice(0, 12),
        relocations: f.relocations,
        ...(f.deletingDestructor && { deletingDestructor: true }),
      })),
    })),
    referenceConflicts: rec.conflicts,
    unknownReferences: rec.unknown.map((x) => ({ symbol: x.decorated, addr: '0x' + hex(x.addr) })),
  };
}
