// Parser for symbol annotations in decomp source files.
//
// Annotations carry a stable symbol ID, never an address. The coordinator's
// symbol database maps each ID to its address in every supported version of
// the target executable, so moving to a new target version never requires
// re-tagging the source.
//
//   // FUNCTION: fn_00123     decompiled (or attempted) function
//   // STUB: fn_00124         placeholder, not yet decompiled
//   // GLOBAL: gl_00045       global or static variable
//   // VTABLE: vt_00007       vtable of the following class
//   // STRING: st_00310       string literal
//   // SIZE: 0x24             expected sizeof() of the following class/struct
//
// An annotation applies to the next line of code that is not blank, not a
// comment and not another annotation. Several annotations may stack on one
// definition when one source body stands for several functions of the binary
// (template instances, identical copies). Text after the ID is a detail; for
// templates it names the instance: `// FUNCTION: fn_01234 <CAnimKitInst>`.

export const KIND_PREFIX = { FUNCTION: 'fn', STUB: 'fn', GLOBAL: 'gl', VTABLE: 'vt', STRING: 'st' };
export const PREFIX_KIND = { fn: 'function', gl: 'global', vt: 'vtable', st: 'string' };
export const FUNCTION_KINDS = ['FUNCTION', 'STUB'];

const ANNOTATION_RE = /^\s*\/\/\s*(FUNCTION|STUB|GLOBAL|VTABLE|STRING|SIZE)\s*:\s*(.*?)\s*$/;
const ID_RE = /^(fn|gl|vt|st)_([0-9]{5,})$/;
const SIZE_BODY_RE = /^0x([0-9a-fA-F]{1,8})$/;
// Lines that look like an annotation attempt (a keyword followed by an ID or an address), so typos
// are reported instead of ignored. Ordinary comments ("// Function declarations") are not.
const LOOKS_LIKE_RE = /^\s*\/\/\s*(FUNCTION|STUB|GLOBAL|VTABLE|STRING|SIZE|LIBRARY)\s*:?\s*((fn|gl|vt|st)_\d+|0x[0-9a-f]+)/i;

export function isSymbolId(s) {
  return ID_RE.test(s);
}

export function formatSymbolId(prefix, n) {
  return `${prefix}_${String(n).padStart(5, '0')}`;
}

/**
 * @param {string} text  file contents
 * @param {string} file  repo-relative path, used in results and errors
 * @returns {{annotations: Array<object>, errors: Array<object>}}
 */
export function parseAnnotations(text, file = '<input>') {
  const lines = text.split(/\r?\n/);
  const annotations = [];
  const errors = [];
  let pending = [];
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;

    if (inBlockComment) {
      if (raw.includes('*/')) inBlockComment = false;
      continue;
    }

    const m = ANNOTATION_RE.exec(raw);
    if (m) {
      const [, kind, body] = m;
      if (kind === 'SIZE') {
        const s = SIZE_BODY_RE.exec(body);
        if (!s) errors.push({ file, line: lineNo, message: `malformed SIZE annotation: "${raw.trim()}"` });
        else pending.push({ kind, size: parseInt(s[1], 16), file, line: lineNo });
      } else {
        const [token, ...rest] = body.split(/\s+/);
        const id = ID_RE.exec(token);
        if (!id) {
          errors.push({ file, line: lineNo, message: `malformed ${kind} annotation, expected "// ${kind}: ${KIND_PREFIX[kind]}_00000" (a symbol ID, not an address): "${raw.trim()}"` });
        } else if (id[1] !== KIND_PREFIX[kind]) {
          errors.push({ file, line: lineNo, message: `${kind} annotation needs a ${KIND_PREFIX[kind]}_ ID, got ${token}` });
        } else {
          pending.push({ kind, id: token, detail: rest.join(' ') || null, file, line: lineNo });
        }
      }
      continue;
    }
    if (LOOKS_LIKE_RE.test(raw)) {
      errors.push({ file, line: lineNo, message: `unrecognized annotation (keywords are upper case, followed by ':' and a symbol ID): "${raw.trim()}"` });
      continue;
    }

    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }

    if (pending.length) {
      for (const p of pending) {
        p.targetLine = lineNo;
        p.targetText = trimmed;
        if (p.kind === 'GLOBAL' || p.kind === 'STRING') p.name = declaredName(trimmed);
        annotations.push(p);
      }
      pending = [];
    }
  }
  for (const p of pending) {
    errors.push({ file, line: p.line, message: `${p.kind} annotation is not followed by any code` });
  }
  return { annotations, errors };
}

/** Best-effort name of the variable declared on a line like `static int g_count = 0;` */
export function declaredName(line) {
  let s = line.replace(/\/\/.*$/, '');
  const cut = s.search(/[=;{(]/);
  if (cut >= 0) s = s.slice(0, cut);
  s = s.replace(/\[[^\]]*\]/g, '').trim();
  const m = /([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_~][A-Za-z0-9_]*)*)\s*$/.exec(s);
  return m ? m[1] : null;
}

/**
 * Checks a whole-repo annotation set against the symbol database.
 * @param {Array<object>} annotations
 * @param {Map<string, {kind: string, library?: boolean}>} [symbols]  ID -> symbol record
 */
export function lintAnnotations(annotations, symbols) {
  const errors = [];
  const seen = new Map();
  for (const a of annotations) {
    if (a.kind === 'SIZE') continue;
    const prev = seen.get(a.id);
    // One function ID on several definitions is legitimate: the original linker folded identical
    // functions into one. One data ID twice is suspicious, but only a warning.
    if (prev && !FUNCTION_KINDS.includes(a.kind)) errors.push({ file: a.file, line: a.line, severity: 'warning', message: `${a.id} is also annotated at ${prev.file}:${prev.line}` });
    else if (!prev) seen.set(a.id, a);

    if (symbols) {
      const sym = symbols.get(a.id);
      if (!sym) errors.push({ file: a.file, line: a.line, message: `${a.id} does not exist in the symbol database (request a new ID with \`td symbol new\`)` });
      else if (sym.library) errors.push({ file: a.file, line: a.line, id: a.id, rule: 'library', message: `${a.id} is marked as library code and must not be decompiled` });
    }
  }
  return errors;
}

/** Hex without prefix; works for 64-bit image addresses (anything below 2^53). */
export function hex(n, width = 8) {
  return Number(n).toString(16).padStart(width, '0');
}
