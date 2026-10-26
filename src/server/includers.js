// Units that include a header, transitively, read from the sources themselves (#include "..."),
// not from what earlier compiles recorded: unit_deps holds only units some merge compiled, so a
// header nobody's merge touched yet shows no includers there.

import { listSources } from '../shared/project.js';

const INCLUDE_RE = /^\s*#\s*include\s+"([^"]+)"/gm;

/**
 * @param {import('./git.js').Repo} repo
 * @param {object} project       sourceDirs, includeDirs, compile.units
 * @param {string[]} headers     repo paths of the changed headers
 * @param {Record<string,string>} files  submitted contents (override what main has)
 * @returns {string[]} units (compile.json .cpp files) that include any of `headers`
 */
export function sourceIncluders(repo, project, headers, files = {}) {
  if (!headers.length) return [];
  const read = (f) => files[f] ?? repo.show('HEAD', f);
  const roots = [...project.sourceDirs, ...project.includeDirs].map((d) => d.replace(/\/+$/, ''));
  const known = new Set([...listSources(repo.dir, project), ...Object.keys(files)]);
  const resolve = (from, spec) => {
    const dir = from.slice(0, from.lastIndexOf('/') + 1);
    for (const base of [dir.replace(/\/$/, ''), ...roots]) {
      const p = normalize(base ? `${base}/${spec}` : spec);
      if (known.has(p)) return p;
    }
    return null;
  };
  const edges = new Map();
  const includesOf = (f) => {
    if (!edges.has(f)) {
      const text = read(f) ?? '';
      edges.set(f, [...text.matchAll(INCLUDE_RE)].map((m) => resolve(f, m[1])).filter(Boolean));
    }
    return edges.get(f);
  };
  const want = new Set(headers);
  const reaches = new Map();
  const hits = (f, seen = new Set()) => {
    if (reaches.has(f)) return reaches.get(f);
    if (seen.has(f)) return false;
    seen.add(f);
    const r = includesOf(f).some((h) => want.has(h) || hits(h, seen));
    reaches.set(f, r);
    return r;
  };
  const units = listSources(repo.dir, project, { unitsOnly: true });
  return units.filter((u) => hits(u));
}

function normalize(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}
