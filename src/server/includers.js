// Units that include a header, transitively, read from the sources themselves (#include "..."),
// not from what earlier compiles recorded: unit_deps holds only units some merge compiled, so a
// header nobody's merge touched yet shows no includers there.

import { listSources } from '../shared/project.js';

const INCLUDE_RE = /^\s*#\s*include\s+"([^"]+)"/gm;
const snapshots = new WeakMap();

function sourceSnapshot(repo, project) {
  const head = repo.head();
  const roots = JSON.stringify([project.sourceDirs, project.includeDirs]);
  const cached = snapshots.get(repo);
  if (cached?.head === head && cached.roots === roots) return cached;
  const paths = listSources(repo.dir, project).filter((file) => !/[\r\n]/.test(file));
  const snapshot = { head, roots, sources: repo.showMany(head, paths) };
  snapshots.set(repo, snapshot);
  return snapshot;
}

/**
 * @param {import('./git.js').Repo} repo
 * @param {object} project       sourceDirs, includeDirs, compile.units
 * @param {string[]} headers     repo paths of the changed headers
 * @param {Record<string,string>} files  submitted contents (override what main has)
 * @returns {string[]} units (compile.json .cpp files) that include any of `headers`
 */
export function sourceIncluders(repo, project, headers, files = {}) {
  if (!headers.length) return [];
  const { sources } = sourceSnapshot(repo, project);
  const read = (f) => Object.hasOwn(files, f) ? files[f] : sources.get(f);
  const roots = [...project.sourceDirs, ...project.includeDirs].map((d) => d.replace(/\/+$/, ''));
  const known = new Set([...sources.keys(), ...Object.keys(files)]);
  const resolve = (from, spec) => {
    const dir = from.slice(0, from.lastIndexOf('/') + 1);
    for (const base of [dir.replace(/\/$/, ''), ...roots]) {
      const p = normalize(base ? `${base}/${spec}` : spec);
      if (known.has(p)) return p;
    }
    return null;
  };
  const edges = new Map();
  // A unit's linkage prelude is forced in with /FI, not #included: it is the unit's first include.
  const preludeDir = project.unitPrelude ? project.unitPrelude.replace(/\/+$/, '') : null;
  const includesOf = (f) => {
    if (!edges.has(f)) {
      const text = read(f) ?? '';
      const listed = [...text.matchAll(INCLUDE_RE)].map((m) => resolve(f, m[1])).filter(Boolean);
      const prelude = preludeDir && /\.(c|cc|cpp|cxx)$/i.test(f) ? `${preludeDir}/${f}.h` : null;
      edges.set(f, prelude && known.has(prelude) ? [prelude, ...listed] : listed);
    }
    return edges.get(f);
  };
  const reverse = new Map();
  for (const file of known) {
    for (const dependency of includesOf(file)) {
      if (!reverse.has(dependency)) reverse.set(dependency, []);
      reverse.get(dependency).push(file);
    }
  }
  const affected = new Set(headers);
  const pending = [...headers];
  while (pending.length) {
    for (const parent of reverse.get(pending.pop()) ?? []) {
      if (affected.has(parent)) continue;
      affected.add(parent);
      pending.push(parent);
    }
  }
  const units = listSources(repo.dir, project, { unitsOnly: true });
  return units.filter((u) => affected.has(u) && files[u] !== null);
}

function normalize(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}
