// Compares compiled functions (COFF object + listing) against the original
// executable, using the symbol database to locate each annotated function.

import { insnAt, normalizePath } from './listing.js';
import { FUNCTION_KINDS, hex } from './annotations.js';

export const STATUS = {
  EXACT: 'exact', // every byte and every relocation target matches
  UNRESOLVED: 'match_unresolved', // bytes match, but some relocation targets are not yet known symbols
  MISMATCH: 'mismatch',
  MISSING: 'missing', // annotated, but the compiler emitted no such function
  NO_ADDRESS: 'no_address', // annotated ID has no address in the current target version
};

// Above this size the similarity score (only a hint for size-mismatched functions) is per-offset.
const MAX_LCS = 2048;
const MAX_DIFF_REGIONS = 24;

/**
 * Binds annotations to the functions/data the compiler emitted for one unit.
 * Function annotations of the unit itself and of every header the listing shows
 * code from are bound by source line; stacked annotations on one definition
 * take its template instances in order, or by their `<detail>`.
 *
 * @returns {{byAnn: Map<object,string>, bindings: Map<string,string>, errors: object[]}}
 *          byAnn: annotation -> decorated name (per definition: folded functions share an ID
 *          across many definitions, each is compared only with code compiled from itself);
 *          bindings: decorated name -> ID (only names that stand for exactly one ID)
 *          (only names that stand for exactly one ID, so they can be learned)
 */
// The compiler's first listed line of a function (its opening brace) is at most this many lines
// below the annotated signature; anything further is another function.
const MAX_SIGNATURE_LINES = 12;

export function bindAnnotations({ listing, file, annotations, nameIndex = new Map(), symbols = new Map(), sizes = new Map() }) {
  const byAnn = new Map();
  const skipped = new Set();
  const errors = [];
  // A compiled function whose decorated name is already known to be another ID is never taken.
  const ownerOf = (p) => nameIndex.get(p.symbol) ?? null;

  // Procs per source file of the listing, and the annotation files they belong to.
  const procsByFile = new Map();
  for (const p of listing.procs) {
    if (!p.sourceFile || p.firstLine === null) continue;
    if (!procsByFile.has(p.sourceFile)) procsByFile.set(p.sourceFile, []);
    procsByFile.get(p.sourceFile).push(p);
  }
  const annsByFile = new Map();
  for (const a of annotations) {
    if (!FUNCTION_KINDS.includes(a.kind)) continue;
    if (!annsByFile.has(a.file)) annsByFile.set(a.file, []);
    annsByFile.get(a.file).push(a);
  }
  const sourceFiles = [...procsByFile.keys()];

  for (const [annFile, anns] of annsByFile) {
    const key = '/' + normalizePath(annFile);
    const sf = sourceFiles.find((s) => s.endsWith(key));
    const own = annFile === file;
    if (!sf) {
      if (own) for (const a of anns) if (a.kind === 'FUNCTION') errors.push({ file, line: a.line, message: `${a.id}: no compiled function found after this annotation (inlined or not emitted?)` });
      continue;
    }
    const procs = procsByFile.get(sf).slice().sort((a, b) => a.firstLine - b.firstLine);
    const lines = [...new Set(anns.map((a) => a.targetLine))].sort((a, b) => a - b);
    lines.forEach((line, i) => {
      const next = Math.min(i + 1 < lines.length ? lines[i + 1] : Infinity, line + MAX_SIGNATURE_LINES + 1);
      const group = anns.filter((a) => a.targetLine === line);
      const groupIds = new Set(group.map((a) => a.id));
      const candidates = procs.filter((p) => p.firstLine >= line && p.firstLine < next && (!ownerOf(p) || groupIds.has(ownerOf(p))));
      if (!candidates.length) {
        if (own) for (const a of group) if (a.kind === 'FUNCTION') errors.push({ file, line: a.line, message: `${a.id}: no compiled function found after this annotation (inlined or not emitted?)` });
        return;
      }
      const used = new Set();
      const take = (a, p) => (used.add(p.symbol), byAnn.set(a, p.symbol));
      const free = () => candidates.filter((p) => !used.has(p.symbol));
      // 1. The decorated name the database knows for this ID (template instance, overload).
      for (const a of group) {
        const known = symbols.get(a.id)?.decorated;
        if (!known) continue;
        const hit = candidates.find((p) => p.symbol === known);
        if (hit) take(a, hit);
        // Known name but not compiled here: this unit holds other instances only.
        else if (candidates.every((p) => p.symbol !== known) && !own) skipped.add(a);
      }
      const pending = () => group.filter((a) => !byAnn.has(a) && !skipped.has(a));
      // 2. The template arguments given as detail.
      for (const a of pending().filter((g) => g.detail)) {
        const inner = a.detail.replace(/^<|>$/g, '');
        const hit = free().find((p) => p.demangled?.includes(`<${inner}>`)) ?? free().find((p) => p.demangled?.includes(inner));
        if (hit) take(a, hit);
      }
      // 3. The size of the original function.
      for (const a of pending()) {
        const size = symbols.get(a.id)?.size;
        const hit = size ? free().find((p) => sizes.get(p.symbol) === size) : null;
        if (hit && free().filter((p) => sizes.get(p.symbol) === size).length === 1) take(a, hit);
      }
      // 4. In order; more addresses than compiled copies means one body stands for several identical functions.
      for (const a of pending()) {
        const f = free()[0];
        byAnn.set(a, f ? (used.add(f.symbol), f.symbol) : candidates[0].symbol);
      }
    });
  }

  const idsPerSymbol = new Map();
  for (const [a, sym] of byAnn) idsPerSymbol.set(sym, [...new Set([...(idsPerSymbol.get(sym) ?? []), a.id])]);
  const bindings = new Map([...idsPerSymbol].filter(([, ids]) => ids.length === 1).map(([sym, ids]) => [sym, ids[0]]));

  for (const a of annotations) {
    if (a.file !== file) continue;
    if (a.kind === 'GLOBAL' && a.name) {
      const hit = listing.data.find((d) => d.demangled === a.name || (d.demangled && d.demangled.endsWith('::' + a.name)));
      if (hit) bindings.set(hit.symbol, a.id);
    } else if (a.kind === 'VTABLE') {
      const cls = /\b(?:class|struct)\s+(?:__declspec\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_:]*)/.exec(a.targetText);
      if (cls) {
        const want = `${cls[1]}::\`vftable'`;
        for (const [sym, dem] of listing.names) if (dem && dem.endsWith(want) && sym.startsWith('??_7')) bindings.set(sym, a.id);
      }
    }
  }
  return { byAnn, bindings, errors };
}

/**
 * @param {object} p
 * @param {import('./coff.js').CoffObject} p.obj
 * @param {object} p.listing                parsed listing
 * @param {string} p.file                   repo-relative source path of this TU
 * @param {Array<object>} p.annotations     annotations of this file
 * @param {Map<string, object>} p.symbols   ID -> {kind, addr, size} for the current target version
 * @param {Map<string, string>} p.nameIndex decorated name -> ID, learned from already-merged code
 * @param {import('./pe.js').PEImage} p.pe
 */
export function compareObject({ obj, listing, file, annotations, symbols, nameIndex = new Map(), pe }) {
  const objFns = new Map(obj.functions().map((f) => [f.name, f]));
  const sizes = new Map([...objFns].map(([n, f]) => [n, f.bytes.length]));
  const { byAnn, bindings, errors } = bindAnnotations({ listing, file, annotations, nameIndex, symbols, sizes });
  const resolve = (name) => bindings.get(name) ?? nameIndex.get(name) ?? null;
  const procsBySymbol = new Map(listing.procs.map((p) => [p.symbol, p]));

  const functions = [];
  const inferred = [];
  // The unit's own annotations, plus header annotations that bound to code compiled here.
  const toCompare = annotations.filter((x) => FUNCTION_KINDS.includes(x.kind) && (x.file === file || byAnn.has(x)));
  for (const a of toCompare) {
    const symbol = byAnn.get(a) ?? null;
    const sym = symbols.get(a.id);
    const base = { id: a.id, kind: a.kind, file: a.file, line: a.line, symbol, demangled: symbol ? listing.names.get(symbol) ?? null : null };
    if (!sym || sym.addr == null) {
      functions.push({ ...base, status: STATUS.NO_ADDRESS, score: 0 });
      continue;
    }
    const fn = symbol ? objFns.get(symbol) : null;
    if (!fn) {
      functions.push({ ...base, addr: sym.addr, status: STATUS.MISSING, score: 0 });
      continue;
    }
    const r = compareFunction({ fn, addr: sym.addr, origSize: sym.size, pe, resolve, symbols, proc: procsBySymbol.get(symbol), literalOf: (s) => obj.literal(s) });
    inferred.push(...r.inferred);
    delete r.inferred;
    functions.push({ ...base, addr: sym.addr, ...r });
  }

  const boundSymbols = new Set([...bindings.keys(), ...byAnn.values()]);
  const unannotated = [...objFns.keys()].filter((n) => !boundSymbols.has(n) && !isCompilerGenerated(n));
  return { file, functions, bindings: Object.fromEntries(bindings), inferred: dedupeInferred(inferred), unannotated, errors };
}

function isCompilerGenerated(name) {
  // scalar/vector deleting destructors, thunks, CRT helpers
  return /^\?\?_[GEH]|^__|^\$|^_\$E/.test(name);
}

function dedupeInferred(list) {
  const m = new Map();
  for (const x of list) m.set(x.symbol, x);
  return [...m.values()];
}

// A __FILE__ value: a source file name, with or without directories (the 15890 client has bare names).
const SOURCE_PATH_RE = /(?:^|[\\/])([^\\/]+\.(?:c|cc|cpp|cxx|h|hpp|inl))$/i;

/**
 * A constant matches when the original holds the same bytes where it points. __FILE__ strings
 * hold the build machine's path, so two source paths match when their file names agree.
 */
export function compareLiteral(ours, addr, pe, name) {
  let orig;
  try {
    orig = pe.read(addr, ours.length);
  } catch {
    return { ok: false, reason: 'original points outside the image' };
  }
  if (orig.equals(ours)) return { ok: true, reason: null };
  const wide = name.startsWith('??_C@_1');
  const decode = (b) => (wide ? b.toString('utf16le') : b.toString('latin1')).replace(/\0+$/, '');
  const a = decode(ours);
  // The original string may be longer than ours; read it to its terminator for the message and path check.
  let full = decode(orig);
  try {
    const more = pe.read(addr, 520);
    const end = wide ? more.indexOf(Buffer.from([0, 0])) : more.indexOf(0);
    full = decode(more.subarray(0, end < 0 ? more.length : end + (wide ? 2 : 1)));
  } catch {}
  const pa = SOURCE_PATH_RE.exec(a);
  const pb = SOURCE_PATH_RE.exec(full);
  if (pa && pb && pa[1].toLowerCase() === pb[1].toLowerCase()) return { ok: true, reason: null };
  const show = (s) => JSON.stringify(s.length > 60 ? s.slice(0, 57) + '...' : s);
  return { ok: false, reason: `constant differs: ours ${show(a)}, original ${show(full)}` };
}

/** Compares one compiled function with the original bytes at `addr`. */
export function compareFunction({ fn, addr, origSize, pe, resolve, symbols, proc, literalOf }) {
  const ours = fn.bytes;
  const compareLen = Math.max(ours.length, origSize || 0);
  const orig = pe.read(addr, compareLen);
  const masked = new Uint8Array(compareLen);
  const relocResults = [];
  const inferred = [];
  const baseRelocs = pe.baseRelocations();

  // x86 address arithmetic wraps at 32 bits; x64 image addresses do not wrap.
  const wrap = pe.is64 ? (x) => x : (x) => x >>> 0;

  for (const r of fn.relocs) {
    for (let k = 0; k < r.width && r.offset + k < compareLen; k++) masked[r.offset + k] = 1;
    if (r.kind === 'other' || r.offset + r.width > compareLen) continue;

    const symName = r.symbol?.name ?? '?';
    const id = resolve(symName);
    const target = id ? symbols.get(id) : null;
    const addend = r.width === 8 ? Number(ours.readBigInt64LE(r.offset)) : ours.readInt32LE(r.offset);
    let actual = null;
    let ok = true;
    let reason = null;

    if (r.kind === 'abs') {
      if (!baseRelocs.has(addr + r.offset)) {
        ok = false;
        reason = 'original has no absolute pointer at this offset';
      }
      const value = r.width === 8 ? Number(orig.readBigUInt64LE(r.offset)) : orig.readUInt32LE(r.offset);
      actual = wrap(value - addend);
    } else if (r.kind === 'rva') {
      actual = wrap(pe.imageBase + orig.readUInt32LE(r.offset) - addend);
    } else {
      // rel: value = target + addend - (field end + bias)
      actual = wrap(addr + r.offset + 4 + r.bias + orig.readInt32LE(r.offset) - addend);
    }

    // Constants (string literals, float/SIMD constants) defined in our object are checked by content.
    const literal = ok ? literalOf?.(r.symbol) : null;
    if (literal) {
      const res = compareLiteral(literal, actual, pe, symName);
      relocResults.push({ offset: r.offset, symbol: symName, id: null, ok: res.ok, unresolved: false, actual, reason: res.reason, literal: true });
      continue;
    }

    if (ok && target && target.addr != null) {
      if (target.addr !== actual) {
        ok = false;
        reason = `references ${id} (0x${hex(target.addr)}) but original references 0x${hex(actual)}`;
      }
    } else if (ok) {
      // Unknown symbol: record where the original points, so the symbol can be identified.
      const isSection = symName.startsWith('.') || symName.startsWith('$');
      if (!isSection) inferred.push({ symbol: symName, addr: actual });
    }
    relocResults.push({ offset: r.offset, symbol: symName, id, ok, unresolved: ok && !(target && target.addr != null), actual, reason });
  }

  const sameLength = !origSize || origSize === ours.length;
  if (sameLength && proc) maskLineNumbers({ ours, orig, masked, proc });

  // Byte comparison outside relocated fields.
  const diffs = [];
  let matched = 0;
  let considered = 0;
  if (sameLength) {
    for (let i = 0; i < ours.length; i++) {
      if (masked[i]) continue;
      considered++;
      if (ours[i] === orig[i]) matched++;
      else diffs.push(i);
    }
  }
  const badRelocs = relocResults.filter((r) => !r.ok);
  const relocBytes = relocResults.length * 4; // weight per checked reference, whatever its width
  let score;
  if (sameLength) {
    score = (matched + (relocResults.length - badRelocs.length) * 4) / Math.max(1, considered + relocBytes);
  } else {
    score = lcsRatio(maskBytes(ours, masked), maskBytes(orig.subarray(0, origSize), masked));
  }

  let status;
  if (sameLength && diffs.length === 0 && badRelocs.length === 0) {
    status = relocResults.some((r) => r.unresolved) ? STATUS.UNRESOLVED : STATUS.EXACT;
  } else {
    status = STATUS.MISMATCH;
  }

  return {
    status,
    score: Math.round(score * 10000) / 10000,
    size: { ours: ours.length, original: origSize ?? null },
    diffRegions: sameLength ? diffRegions(diffs, ours, orig, proc) : [],
    relocations: relocResults.filter((r) => !r.ok || r.unresolved),
    // Where the original points is only meaningful when the code lines up.
    inferred: status === STATUS.MISMATCH ? [] : inferred,
  };
}

/**
 * __LINE__ arguments (SMemAlloc(size, __FILE__, __LINE__, ...), error macros) carry the line
 * numbers of our files, not Blizzard's. A 16/32-bit immediate inside an instruction whose value is
 * exactly the source line the listing gives for that instruction is masked.
 */
function maskLineNumbers({ ours, orig, masked, proc }) {
  const insns = proc.insns;
  for (let k = 0; k < insns.length; k++) {
    const insn = insns[k];
    if (!insn.srcLine) continue;
    const start = insn.offset;
    const end = Math.min(ours.length, k + 1 < insns.length ? insns[k + 1].offset : ours.length);
    for (let p = start + 1; p + 2 <= end; p++) {
      const width = p + 4 <= end && ours.readUInt32LE(p) === insn.srcLine ? 4 : ours.readUInt16LE(p) === insn.srcLine && p + 2 === end ? 2 : 0;
      if (!width) continue;
      let differs = false;
      for (let i = p; i < p + width; i++) if (ours[i] !== orig[i]) differs = true;
      if (differs) for (let i = p; i < p + width; i++) masked[i] = 1;
      break;
    }
  }
}

function maskBytes(buf, masked) {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i++) if (masked[i]) out[i] = 0;
  return out;
}

function diffRegions(diffs, ours, orig, proc) {
  const regions = [];
  for (const off of diffs) {
    const last = regions[regions.length - 1];
    if (last && off - last.end <= 2) last.end = off + 1;
    else regions.push({ start: off, end: off + 1 });
  }
  return regions.slice(0, MAX_DIFF_REGIONS).map((r) => {
    const insn = proc ? insnAt(proc, r.start) : null;
    return {
      offset: r.start,
      length: r.end - r.start,
      ours: ours.subarray(r.start, r.end).toString('hex'),
      original: orig.subarray(r.start, r.end).toString('hex'),
      ourInstruction: insn ? `+0x${insn.offset.toString(16)}: ${insn.text}` : null,
      sourceLine: insn?.srcLine ?? null,
    };
  });
}

/** Similarity ratio based on the longest common subsequence, like difflib. */
export function lcsRatio(a, b) {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length > MAX_LCS || b.length > MAX_LCS) {
    let same = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) same++;
    return (2 * same) / (a.length + b.length);
  }
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return (2 * prev[b.length]) / (a.length + b.length);
}
