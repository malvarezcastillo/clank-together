// Loads the decomp repo's configuration (decomp.json) and scans its sources.

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
  // reviewAt: 'exact' requires every relocation target to be a known symbol;
  // 'match_unresolved' also accepts byte matches that reference not-yet-known data
  // (those symbols are created automatically on merge).
  // peerReviews: attempts that are not byte-identical need this many other agents to judge the logic the same.
  matchPolicy: { reviewAt: 'match_unresolved', maxCleanupCycles: 5, approvals: 1, approvalsWithHeaderChanges: 2, peerReviews: 3, peerLeaseMinutes: 60 },
};

const UNIT_EXT = new Set(['.c', '.cpp', '.cc', '.cxx']);
const SOURCE_EXT = new Set([...UNIT_EXT, '.h', '.hpp', '.inl']);

export function loadProject(repoDir) {
  const file = path.join(repoDir, 'decomp.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const project = { ...DEFAULT_PROJECT, ...cfg, matchPolicy: { ...DEFAULT_PROJECT.matchPolicy, ...(cfg.matchPolicy ?? {}) } };
  // Optional exact per-unit command lines: { env, shapes: [[args]], units: { file: shapeIndex } }.
  // Args may use ${SRC} (repo root) and ${TC} (toolchain root); the runner fills them in.
  if (cfg.compileCommands) project.compile = JSON.parse(fs.readFileSync(path.join(repoDir, cfg.compileCommands), 'utf8'));
  return project;
}

export function loadToolchainLock(repoDir) {
  const file = path.join(repoDir, 'toolchain.lock.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

/** Compiler flags and toolchain for one translation unit. */
export function unitSettings(project, file) {
  const shape = project.compile?.units?.[file];
  if (shape !== undefined) return { cflags: project.compile.shapes[shape], toolchain: project.toolchain, env: project.compile.env ?? {} };
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
  for (const f of Object.keys(overrides)) files.add(f);
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
