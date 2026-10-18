// Splitting a batch: the functions that are already approved merge on their own, while the rest
// stays in review. The approved part is the submitted files with every pending function put back
// the way it is on the batch's base commit (or removed, when the submission added it). The merge
// re-verifies the result on main, so a split that breaks anything is caught there.
//
// When that does not build (the approved functions call a pending one by its new signature, or a
// helper the submission added), `keepCode` keeps the pending functions' new code and takes out only
// their annotations: main compiles, they do not count as done, and their review goes on.

import { parseAnnotations } from '../shared/annotations.js';

/**
 * Function definitions in a file by symbol ID: the annotation lines through the closing brace.
 * Several IDs on one definition (folded functions) share a region.
 * @returns {Map<string, {start: number, end: number, ids: string[]}>|null}  0-based, end exclusive
 */
export function functionRegions(text) {
  const { annotations } = parseAnnotations(text);
  const lines = text.split('\n');
  const groups = new Map();
  for (const a of annotations) {
    if (a.kind !== 'FUNCTION' && a.kind !== 'STUB') continue;
    const g = groups.get(a.targetLine) ?? { start: a.line - 1, targetLine: a.targetLine, ids: [], lines: new Map() };
    g.start = Math.min(g.start, a.line - 1);
    g.ids.push(a.id);
    g.lines.set(a.id, a.line - 1);
    groups.set(a.targetLine, g);
  }
  const out = new Map();
  for (const g of groups.values()) {
    // A definition runs to its closing brace; an annotated declaration to its semicolon.
    const end = bodyEnd(lines, g.targetLine - 1) ?? declarationEnd(lines, g.targetLine - 1);
    if (end === null) return null;
    const region = { start: g.start, end, ids: g.ids, lines: g.lines };
    for (const id of g.ids) out.set(id, region);
  }
  return out;
}

// Index of the line after the one that ends a declaration (its semicolon) starting at `from`.
function declarationEnd(lines, from) {
  for (let i = from; i < Math.min(lines.length, from + 20); i++) if (lines[i].replace(/\/\/.*$/, '').includes(';')) return i + 1;
  return null;
}

// Index of the line after the brace that closes the body starting at or after line `from`.
function bodyEnd(lines, from) {
  let depth = 0;
  let opened = false;
  let block = false;
  for (let i = from; i < lines.length; i++) {
    const s = lines[i];
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (block) {
        if (c === '*' && s[j + 1] === '/') (block = false), j++;
        continue;
      }
      if (c === '/' && s[j + 1] === '/') break;
      if (c === '/' && s[j + 1] === '*') {
        block = true;
        j++;
        continue;
      }
      if (c === '"' || c === "'") {
        for (j++; j < s.length && s[j] !== c; j++) if (s[j] === '\\') j++;
        continue;
      }
      if (c === ';' && !opened) return null; // a declaration, not a definition
      if (c === '{') (depth++, (opened = true));
      else if (c === '}' && --depth === 0 && opened) return i + 1;
    }
  }
  return null;
}

/**
 * The submitted files without the changes to `ids`.
 * @param {Record<string,string>} files     submitted files
 * @param {Iterable<string>} ids            symbol IDs whose changes are taken out
 * @param {(file: string) => string|null} baseText  the file on the batch's base commit
 * @param {{keepCode?: boolean}} [opts]     keep the pending code, without its annotations
 * @returns {Record<string,string>|null}    null when the functions can't be separated cleanly
 */
export function withoutFunctions(files, ids, baseText, { keepCode = false } = {}) {
  const pending = new Set(ids);
  const out = {};
  for (const [file, text] of Object.entries(files)) {
    const regions = functionRegions(text);
    if (!regions) return null;
    const mine = [...new Set([...regions].filter(([id]) => pending.has(id)).map(([, r]) => r))];
    if (!mine.length) {
      out[file] = text;
      continue;
    }
    if (keepCode) {
      const drop = mine.flatMap((r) => r.ids.filter((id) => pending.has(id)).map((id) => r.lines.get(id))).sort((a, b) => b - a);
      const lines = text.split('\n');
      for (const i of drop) lines.splice(i, 1);
      out[file] = lines.join('\n');
      continue;
    }
    const base = baseText(file);
    const baseRegions = base === null ? new Map() : functionRegions(base);
    if (!baseRegions) return null;
    const baseLines = base === null ? [] : base.split('\n');
    const lines = text.split('\n');
    // Replace from the bottom so earlier line numbers stay valid.
    for (const r of mine.sort((a, b) => b.start - a.start)) {
      // One body annotated for several functions (identical copies in the binary), some of them
      // pending: the body stays for the others, only the pending ones' annotation lines go.
      if (r.ids.some((id) => !pending.has(id))) {
        const drop = r.ids.filter((id) => pending.has(id)).map((id) => r.lines.get(id)).sort((a, b) => b - a);
        for (const i of drop) lines.splice(i, 1);
        continue;
      }
      const b = baseRegions.get(r.ids[0]);
      if (b && (b.ids.length !== r.ids.length || b.ids.some((id) => !r.ids.includes(id)))) return null;
      lines.splice(r.start, r.end - r.start, ...(b ? baseLines.slice(b.start, b.end) : []));
    }
    out[file] = lines.join('\n');
  }
  return out;
}
