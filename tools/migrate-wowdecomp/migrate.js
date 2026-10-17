#!/usr/bin/env node
// Converts a wowdecomp tree from address tags to stable symbol IDs.
//
//   node migrate.js --dump <dir from dump_db.py> --tree <clone of wowdecomp15890> --out <dir>
//
// 1. Builds one symbol per function across builds, joined through the address maps:
//      15890 x64  <-map_15595_15890-  15595 x64  <-map64_15595-  15595 x86
//    and one per data symbol (joined by decorated name), then assigns IDs:
//    fn_ / gl_ / vt_ / st_, ordered by 15890 address, then 15595 x64, then x86.
// 2. Rewrites the tree in place:
//      // OFFSET: 0x14...   (15890)   -> // FUNCTION: fn_xxxxx
//      // OFFSET: #0x14...  (15595 x64), %0x00... (15595 x86)  -> the same, by map
//      // OFFSET: [a, b<T>]            -> one line per distinct ID, template args kept as detail
//      // STATIC: ...                  -> // GLOBAL: gl_xxxxx (or VTABLE/STRING by kind)
//      // PROVEN: ...                  -> removed (match status lives in the coordinator)
//    Tags that cannot be resolved become `// TODO(retag): <original tag>` and are listed in the report.
// 3. Writes <out>/symbols.json (for `td-server symbols load`) and <out>/report.json.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { formatSymbolId } from '../../src/shared/annotations.js';

const { values: opt } = parseArgs({ options: { dump: { type: 'string' }, tree: { type: 'string' }, out: { type: 'string' } } });
for (const k of ['dump', 'tree', 'out']) if (!opt[k]) throw new Error(`--${k} is required`);
fs.mkdirSync(opt.out, { recursive: true });

const V890 = '15890-x64';
const V595 = '15595-x64';
const V595X86 = '15595-x86';
const X64_MIN = 0x140000000;
const load = (n) => JSON.parse(fs.readFileSync(path.join(opt.dump, n + '.json'), 'utf8'));
const hexa = (n) => '0x' + n.toString(16).toUpperCase();

// ---------------------------------------------------------------- functions

const funcs = { [V890]: new Map(), [V595]: new Map(), [V595X86]: new Map() };
for (const [ea, size, name, flags] of load('func_15890_x64')) funcs[V890].set(ea, { size, name, flags });
for (const [ea, size, name, flags] of load('func_15595_x64')) funcs[V595].set(ea, { size, name, flags });
for (const [ea, size, name, flags] of load('func_15595_x86')) funcs[V595X86].set(ea, { size, name, flags });

const status890 = new Map(load('status15890').map(([ea, size, st, mod, file]) => [ea, { st, mod, file }]));
const to890 = new Map();
const from890 = new Map();
for (const [a, b] of load('map_15595_15890')) if (funcs[V595].has(a) && funcs[V890].has(b)) (to890.set(a, b), from890.set(b, a));
const x86to64 = new Map();
const x64to86 = new Map();
for (const [a, b] of load('map64_15595')) if (funcs[V595X86].has(a) && funcs[V595].has(b) && !x64to86.has(b)) (x86to64.set(a, b), x64to86.set(b, a));

const decorated890 = new Map();
for (const [ea, sym, verdict] of load('byte_match15890')) if (verdict === 'IDENTICAL' && sym) decorated890.set(ea, sym);

const isNamed = (n) => n && !/^(sub|nullsub|j|unknown_libname)_[0-9A-Fa-f]+/.test(n);
const entities = [];
const fnAt = { [V890]: new Map(), [V595]: new Map(), [V595X86]: new Map() };
function addFunc(addrs) {
  const e = { kind: 'function', addrs, name: null, decorated: null, library: false, unit: null };
  for (const [v, a] of Object.entries(addrs)) if (a != null) fnAt[v].set(a, e);
  entities.push(e);
  return e;
}
for (const ea of [...funcs[V890].keys()].sort((a, b) => a - b)) {
  const e595 = from890.get(ea) ?? null;
  const e = addFunc({ [V890]: ea, [V595]: e595, [V595X86]: e595 != null ? x64to86.get(e595) ?? null : null });
  const st = status890.get(ea);
  e.library = st?.st === 'library';
  e.unit = st?.file ? st.file.replace(/\\/g, '/') : null;
  e.decorated = decorated890.get(ea) ?? null;
  const n = funcs[V890].get(ea).name;
  if (isNamed(n)) e.name = n;
}
for (const ea of [...funcs[V595].keys()].sort((a, b) => a - b)) {
  if (fnAt[V595].has(ea)) continue;
  const e = addFunc({ [V890]: null, [V595]: ea, [V595X86]: x64to86.get(ea) ?? null });
  const n = funcs[V595].get(ea).name;
  if (isNamed(n)) e.name = n;
}
for (const ea of [...funcs[V595X86].keys()].sort((a, b) => a - b)) {
  if (fnAt[V595X86].has(ea)) continue;
  const e = addFunc({ [V890]: null, [V595]: null, [V595X86]: ea });
  const n = funcs[V595X86].get(ea).name;
  if (isNamed(n)) e.name = n;
}

// ---------------------------------------------------------------- data

const dataAt = { [V890]: new Map(), [V595]: new Map(), [V595X86]: new Map() };
const dataKind = (sym) => (sym?.startsWith('??_7') ? 'vtable' : sym?.startsWith('??_C@') ? 'string' : 'global');
function addData(addrs, decorated = null, kind = dataKind(decorated)) {
  const e = { kind, addrs, name: null, decorated, library: false, unit: null };
  for (const [v, a] of Object.entries(addrs)) if (a != null) dataAt[v].set(a, e);
  entities.push(e);
  return e;
}
const data595 = new Map(load('data_15595_x64').map(([s, p, ea]) => [s, ea]));
const joined = new Set();
for (const [sym, plain, ea] of load('data_15890_x64').sort((a, b) => a[2] - b[2])) {
  if (dataAt[V890].has(ea)) continue;
  const old = data595.get(sym);
  const e = addData({ [V890]: ea, [V595]: old != null && !dataAt[V595].has(old) ? old : null }, sym);
  e.name = plain;
  if (old != null) joined.add(sym);
}
for (const [sym, plain, ea] of load('data_15595_x64').sort((a, b) => a[2] - b[2])) {
  if (joined.has(sym) || dataAt[V595].has(ea)) continue;
  addData({ [V595]: ea }, sym).name = plain;
}

// ---------------------------------------------------------------- tags

const report = { files: 0, changedFiles: 0, tags: 0, functionTags: 0, staticTags: 0, provenRemoved: 0, unresolved: [], duplicates: [], conflicts: [] };
const SRC_EXT = /\.(c|cc|cpp|cxx|h|hpp|inl)$/i;
const TAG_RE = /^(\s*)\/\/\s*(OFFSET|STATIC):\s*(.+?)\s*$/;
const PROVEN_RE = /^\s*\/\/\s*PROVEN:/;
const TOKEN_RE = /^([%#]?)0x([0-9A-Fa-f]+)$/;

/** Splits `[a, b<X, Y>, c]` at top-level commas. */
function splitList(body) {
  const inner = body.replace(/^\[/, '').replace(/\]$/, '');
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '<') depth++;
    if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function versionOf(prefix, addr) {
  if (prefix === '#') return V595;
  if (prefix === '%') return V595X86;
  return addr >= X64_MIN ? V890 : null;
}

/** Resolves one entry like `#0x1405E5B10<EvtMessage>` or `%0x00F49520/0x000E3D630`. */
function resolveEntry(entry, isStatic, where) {
  const t = /^([^<]+?)\s*(<.*>)?$/.exec(entry);
  const detail = t?.[2] ?? null;
  const parts = (t?.[1] ?? entry).split('/');
  const found = [];
  let bare = false;
  for (const p of parts) {
    const m = TOKEN_RE.exec(p.trim());
    if (!m) continue;
    const addr = parseInt(m[2], 16);
    const v = versionOf(m[1], addr);
    if (!v) continue;
    let e = (isStatic ? dataAt : fnAt)[v].get(addr);
    if (!e && isStatic) e = addData({ [v]: addr });
    if (e) found.push(e);
    if (v === V890) bare = true;
  }
  const uniq = [...new Set(found)];
  if (uniq.length > 1) report.conflicts.push({ ...where, entry, ids: uniq.length });
  return uniq.length ? { e: uniq[0], detail, bare } : null;
}

/** Qualified name of the function defined on a line like `int CFoo::Bar(int x) {` (no overload info). */
function definedName(line) {
  const m = /([~\w]+(?:<[^()]*>)?(?:::[~\w]+(?:<[^()]*>)?)*|operator\s*[^\s(]+)\s*\(/.exec(line ?? '');
  return m ? m[1].replace(/<[^()]*>/g, '') : null;
}

function nextCodeLine(lines, i) {
  for (let j = i + 1; j < lines.length; j++) {
    const s = lines[j].trim();
    if (!s || s.startsWith('//')) continue;
    return s;
  }
  return null;
}

const fileTags = []; // [{file, line, e, detail, kind}]
function walk(dir, rel, out) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.') || (!rel && ['bin', 'out', 'build'].includes(d.name))) continue;
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) walk(path.join(dir, d.name), r, out);
    else if (SRC_EXT.test(d.name)) out.push(r);
  }
}
const files = [];
walk(opt.tree, '', files);

const rewritten = new Map();
for (const file of files) {
  report.files++;
  const abs = path.join(opt.tree, file);
  const text = fs.readFileSync(abs, 'latin1');
  if (!/\/\/\s*(OFFSET|STATIC|PROVEN):/.test(text)) continue;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const out = [];
  let changed = false;
  lines.forEach((line, i) => {
    if (PROVEN_RE.test(line)) {
      report.provenRemoved++;
      changed = true;
      return;
    }
    const m = TAG_RE.exec(line);
    if (!m) return void out.push(line);
    const [, indent, kind, body] = m;
    const isStatic = kind === 'STATIC';
    report.tags++;
    isStatic ? report.staticTags++ : report.functionTags++;
    const entries = body.startsWith('[') ? splitList(body) : [body];
    const where = { file, line: i + 1 };
    const seen = new Set();
    const resolved = [];
    for (const entry of entries) {
      const r = resolveEntry(entry, isStatic, where);
      if (!r) {
        report.unresolved.push({ ...where, entry, tag: line.trim() });
        continue;
      }
      if (seen.has(r.e)) continue;
      seen.add(r.e);
      resolved.push(r);
    }
    changed = true;
    if (!resolved.length) return void out.push(`${indent}// TODO(retag): ${line.trim().replace(/^\/\/\s*/, '')}`);
    const defName = isStatic ? null : definedName(nextCodeLine(lines, i));
    for (const r of resolved) {
      const placeholder = { kind: isStatic ? 'data' : 'function', e: r.e, bare: r.bare, defName, detail: entries.length > 1 ? r.detail : null, file, line: i + 1, indent, outIndex: out.length };
      fileTags.push(placeholder);
      out.push(placeholder);
    }
    if (resolved.length < entries.length && entries.length > 1) {
      // Keep a trace of list entries that did not resolve.
      for (const u of report.unresolved.filter((x) => x.file === file && x.line === i + 1)) out.push(`${indent}// TODO(retag): unresolved list entry ${u.entry}`);
    }
  });
  if (changed) rewritten.set(file, { out, eol });
}

// ---------------------------------------------------------------- map sanity

// A proven (bare 15890) tag owns its address. An old-address tag that the map sends to the same
// 15890 function but sits on a differently named definition is a wrong map pair: the old function
// keeps its 15595 addresses as a symbol of its own, without a 15890 address.
const owners = new Map(); // entity -> Set of defined names with a bare tag
for (const t of fileTags) if (t.kind === 'function' && t.bare && t.defName) owners.set(t.e, (owners.get(t.e) ?? new Set()).add(t.defName.split('::').pop()));
const splits = new Map();
report.mapRejected = [];
for (const t of fileTags) {
  if (t.kind !== 'function' || t.bare || !t.defName) continue;
  const names = owners.get(t.e);
  if (!names || names.has(t.defName.split('::').pop())) continue;
  // Several differently named owners, or a stub-sized function: the linker folds those, the pair can be right.
  const size890 = funcs[V890].get(t.e.addrs[V890])?.size ?? 0;
  if (names.size > 1 || size890 < 24) continue;
  if (!splits.has(t.e)) {
    const old = t.e;
    const e = { kind: 'function', addrs: { [V890]: null, [V595]: old.addrs[V595], [V595X86]: old.addrs[V595X86] }, name: null, decorated: null, library: false, unit: null };
    old.addrs[V595] = null;
    old.addrs[V595X86] = null;
    entities.push(e);
    splits.set(old, e);
    report.mapRejected.push({ file: t.file, line: t.line, defined: t.defName, owner: [...names].join(','), ea890: hexa(old.addrs[V890]) });
  }
  t.e = splits.get(t.e);
}

// ---------------------------------------------------------------- IDs

const counters = { fn: 0, gl: 0, vt: 0, st: 0 };
const prefixOf = { function: 'fn', global: 'gl', vtable: 'vt', string: 'st' };
const sortKey = (e) => [e.addrs[V890], e.addrs[V595], e.addrs[V595X86]].map((a) => (a == null ? Infinity : a));
const ordered = entities.slice().sort((a, b) => {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
});
// Data entities created only from a tag that nothing else knows still need an ID; all others too.
for (const e of ordered) e.id = formatSymbolId(prefixOf[e.kind], ++counters[prefixOf[e.kind]]);

const annotationFor = { function: 'FUNCTION', global: 'GLOBAL', vtable: 'VTABLE', string: 'STRING' };
const firstUse = new Map();
for (const t of fileTags) {
  const key = t.e.id;
  if (firstUse.has(key) && t.kind === 'function') {
    const prev = firstUse.get(key);
    // Template instances and identical copies legitimately share a body; a second tag elsewhere is a duplicate.
    if (prev.file !== t.file || t.detail == null) report.duplicates.push({ id: key, first: prev.file, again: t.file });
  } else firstUse.set(key, t);
}

for (const [file, { out, eol }] of rewritten) {
  const lines = out.map((x) => {
    if (typeof x === 'string') return x;
    const kw = annotationFor[x.e.kind];
    return `${x.indent}// ${kw}: ${x.e.id}${x.detail ? ' ' + x.detail : ''}`;
  });
  fs.writeFileSync(path.join(opt.tree, file), lines.join(eol), 'latin1');
  report.changedFiles++;
}

// ---------------------------------------------------------------- outputs

const used = new Set(fileTags.map((t) => t.e.id));
const symbols = ordered.map((e) => ({
  id: e.id,
  kind: e.kind,
  name: e.name,
  decorated: e.decorated,
  library: e.library,
  unit: e.unit,
  addrs: Object.fromEntries(Object.entries(e.addrs).filter(([, a]) => a != null).map(([v, a]) => [v, [a, (e.kind === 'function' ? funcs[v].get(a)?.size : null) ?? null]])),
}));
// Functions already proven byte-identical against 15890 by verify15890.py, and tagged with that address.
const proven = [];
for (const t of fileTags) {
  if (t.kind !== 'function') continue;
  const ea = t.e.addrs[V890];
  if (ea != null && decorated890.has(ea)) proven.push({ id: t.e.id, file: t.file });
}

fs.writeFileSync(path.join(opt.out, 'symbols.json'), JSON.stringify({ versions: [V890, V595, V595X86], current: V890, symbols, proven }));
const summary = {
  ...report,
  unresolved: report.unresolved.length,
  duplicates: report.duplicates.length,
  conflicts: report.conflicts.length,
  symbols: Object.fromEntries(Object.entries(counters).map(([k, n]) => [k, n])),
  taggedIds: used.size,
  proven: proven.length,
  maps: { to890: to890.size, x86to64: x86to64.size, rejected: report.mapRejected.length },
};
fs.writeFileSync(path.join(opt.out, "report.json"), JSON.stringify({ summary, unresolved: report.unresolved, duplicates: report.duplicates, conflicts: report.conflicts, mapRejected: report.mapRejected }, null, 1));
console.log(JSON.stringify(summary, null, 2));
