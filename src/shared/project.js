// Loads the decomp repo's configuration (data/decomp.json) and scans its sources.

import fs from 'node:fs';
import path from 'node:path';
import { parseAnnotations } from './annotations.js';
import { matchesAny } from './lint.js';

export const DEFAULT_PROJECT = {
  name: 'decomp',
  sourceDirs: ['src'],
  includeDirs: ['include'],
  headerGlobs: ['include/**'],
  toolchain: 'msvc2010',
  cflags: ['/nologo', '/c', '/O2', '/Gy', '/GS-', '/EHsc', '/MT'],
  fileOverrides: [],
  allowedPragmas: undefined,
  lintLimits: {},
  globalRules: false, // opt-in source storage/provenance checks; no symbol-database definition exemption
  // reviewAt: 'exact' requires every relocation target to be a known symbol;
  // 'match_unresolved' also accepts byte matches that reference not-yet-known data
  // (those symbols are created automatically on merge).
  // peerReviews: attempts that are not byte-identical need this many other agents to judge the logic the same.
  matchPolicy: { reviewAt: 'match_unresolved', maxCleanupCycles: 5, approvals: 1, approvalsWithHeaderChanges: 2, peerReviews: 3, peerLeaseMinutes: 5 },
};

const UNIT_EXT = new Set(['.c', '.cpp', '.cc', '.cxx']);
const SOURCE_EXT = new Set([...UNIT_EXT, '.h', '.hpp', '.inl']);

export function loadProject(repoDir, readFile = (file) => readProjectFile(repoDir, file)) {
  const cfg = JSON.parse(readFile('data/decomp.json') ?? '{}');
  const project = { ...DEFAULT_PROJECT, ...cfg, matchPolicy: { ...DEFAULT_PROJECT.matchPolicy, ...(cfg.matchPolicy ?? {}) } };
  // Optional exact per-unit command lines: { env, shapes: [[args]], units: { file: shapeIndex } }.
  // Args may use ${SRC} (repo root) and ${TC} (toolchain root); the runner fills them in.
  if (cfg.compileCommands) {
    const commands = readFile(cfg.compileCommands);
    if (commands === null) throw new Error(`missing compile commands: ${cfg.compileCommands}`);
    project.compile = JSON.parse(commands);
  }
  return project;
}

/**
 * The command shape a unit that is not in the build list yet gets: the one most units of its
 * folder use (or of the nearest parent folder that has units), else the most common one.
 */
export function inferShape(project, file) {
  const units = project.compile?.units;
  if (!units) return null;
  if (units[file] !== undefined) return units[file];
  const tally = (prefix) => {
    const n = new Map();
    for (const [f, s] of Object.entries(units)) if (f.startsWith(prefix)) n.set(s, (n.get(s) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  };
  const parts = file.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const s = tally(parts.slice(0, i).join('/') + '/');
    if (s !== undefined) return s;
  }
  return tally('') ?? 0;
}

/**
 * The build list with new units added (each with its inferred shape), as the text the repository
 * stores it in, or null when nothing is new. `text` is the list as it is on main.
 */
export function addUnitsToCompileCommands(project, text, files) {
  if (!project.compile?.units || text === null) return null;
  const doc = JSON.parse(text);
  const added = files.filter((f) => isUnit(f) && doc.units[f] === undefined && !/(^|\/)Win32\//.test(f));
  if (!added.length) return null;
  for (const f of added) doc.units[f] = inferShape({ compile: doc }, f);
  doc.units = Object.fromEntries(Object.entries(doc.units).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { text: JSON.stringify(doc, null, 1), added, units: doc.units };
}

/** The build list without the given units, or null when none of them is listed. */
export function removeUnitsFromCompileCommands(project, text, files) {
  if (!project.compile?.units || text === null) return null;
  const doc = JSON.parse(text);
  const removed = files.filter((f) => doc.units[f] !== undefined);
  if (!removed.length) return null;
  for (const f of removed) delete doc.units[f];
  return { text: JSON.stringify(doc, null, 1), removed, units: doc.units };
}

export function loadToolchainLock(repoDir, readFile = (file) => readProjectFile(repoDir, file)) {
  return JSON.parse(readFile('data/toolchain.lock.json') ?? '{}');
}

function readProjectFile(repoDir, file) {
  const absolute = path.join(repoDir, file);
  return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
}

/** Compiler flags and toolchain for one translation unit. */
export function unitSettings(project, file) {
  // A unit the build list does not have yet compiles the way it will once it is added (merge.js).
  const shape = project.compile?.units ? inferShape(project, file) : undefined;
  if (shape !== undefined && shape !== null) return { cflags: project.compile.shapes[shape], toolchain: project.toolchain, env: project.compile.env ?? {} };
  let cflags = project.cflags;
  let toolchain = project.toolchain;
  for (const o of project.fileOverrides ?? []) {
    if (matchesAny(file, [o.glob])) {
      if (o.cflags) cflags = o.cflags;
      if (o.toolchain) toolchain = o.toolchain;
    }
  }
  return { cflags, toolchain, env: {} };
}

/** Repo-relative paths of all source files (forward slashes). */
export function listSources(repoDir, project, { unitsOnly = false } = {}) {
  // With exact compile commands, the build's own unit list is authoritative.
  if (unitsOnly && project.compile?.units) return Object.keys(project.compile.units).sort();
  const out = [];
  const dirs = [...new Set([...project.sourceDirs, ...project.includeDirs])];
  for (const d of dirs) walk(path.join(repoDir, d), d, out);
  return out.filter((f) => (unitsOnly ? UNIT_EXT : SOURCE_EXT).has(path.posix.extname(f).toLowerCase())).sort();
}

function walk(abs, rel, out) {
  if (!fs.existsSync(abs)) return;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(path.join(abs, e.name), r, out);
    else out.push(r);
  }
}

export function isUnit(file) {
  return UNIT_EXT.has(path.posix.extname(file).toLowerCase());
}

/**
 * Annotations of the whole repo, optionally with some files replaced
 * (the contents of a submission).
 */
export function scanAnnotations(repoDir, project, overrides = {}) {
  const files = new Set(listSources(repoDir, project));
  for (const [f, text] of Object.entries(overrides)) {
    if (text === null) files.delete(f);
    else files.add(f);
  }
  const annotations = [];
  const errors = [];
  for (const f of [...files].sort()) {
    const text = f in overrides ? overrides[f] : fs.readFileSync(path.join(repoDir, f), 'utf8');
    const r = parseAnnotations(text, f);
    annotations.push(...r.annotations);
    errors.push(...r.errors);
  }
  return { annotations, errors };
}
