// Free text in submissions. Agents read each other's code, so text in it could carry instructions
// to the next agent (prompt injection). A submission may therefore add no comments other than
// annotations and struct offset markers, and only string literals that exist in the original
// executable (text the original authors wrote). Identifier names are the only free text left.
// Comments and strings already on main are left alone: the rules apply to what a submission adds.

const ANNOTATION_RE = /^\/\/\s*(FUNCTION|STUB|GLOBAL|VTABLE|STRING|SIZE|LIBRARY)\s*:\s*[\w.]+(\s+<[\w\s:<>,*&]{1,120}>)?\s*$/;
const OFFSET_RE = /^\/\*\s*(?:0x)?(?:[0-9A-Fa-f]{1,8}|-{2,8})\s*\*\/$/;
const BLANK_RE = /^(?:\/\/[\s\-=*\/]*|\/\*[\s\-=*]*\*\/)$/;
// The project marks inlined copies: // INLINED, optionally with the address range.
const INLINED_RE = /^\/\/\s*INLINED(?::\s*\[?\s*0x[0-9A-Fa-f]+\s*->\s*0x[0-9A-Fa-f]+\s*\]?)?\s*$/;
const INCLUDE_RE = /^\s*#\s*include\s*$/;
const INCLUDE_PATH_RE = /^[\w.\/-]{1,200}$/;
const LINKAGE = new Set(['C', 'C++']);

/** Comments that are not free text: annotations, offset and inlining markers, separators. */
export function allowedComment(text) {
  const t = text.trim();
  return ANNOTATION_RE.test(t) || OFFSET_RE.test(t) || BLANK_RE.test(t) || INLINED_RE.test(t);
}

/**
 * Comments and string literals of C++ source. Adjacent literals ("a" "b") form one string.
 * @returns {{comments: {text: string, line: number}[], strings: {pieces: Buffer[], text: string, wide: boolean, line: number, include: string|null, linkage: boolean}[]}}
 */
export function scanText(src) {
  const comments = [];
  const literals = [];
  let line = 1;
  let lineBegin = 0; // where the current line starts
  let lastCode = ''; // the token before a literal, to recognize extern "C"
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '\n') {
      line++;
      i++;
      lineBegin = i;
      continue;
    }
    if (c === '/' && n === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      comments.push({ text: src.slice(i, j).replace(/\r$/, ''), line });
      i = j;
      continue;
    }
    if (c === '/' && n === '*') {
      const start = line;
      let j = i + 2;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) {
        if (src[j] === '\n') line++;
        j++;
      }
      comments.push({ text: src.slice(i, j + 2), line: start });
      i = j + 2;
      continue;
    }
    const wide = c === 'L' && (n === '"' || n === "'") && !/\w/.test(src[i - 1] ?? '');
    if (c === '"' || (wide && n === '"')) {
      const { value, end } = readQuoted(src, wide ? i + 1 : i);
      const prev = literals[literals.length - 1];
      if (prev && prev.end === lastCodeEnd(src, i) && prev.include === null) {
        prev.pieces.push(value);
        prev.wide ||= wide;
        prev.end = end;
      } else {
        literals.push({ pieces: [value], wide, line, include: INCLUDE_RE.test(src.slice(lineBegin, i)) ? value : null, linkage: lastCode === 'extern', end });
      }
      i = end;
      continue;
    }
    if (c === "'" || (wide && n === "'")) {
      // Character constants (also multi-character ones like 'MVER') are not free text.
      i = readQuoted(src, wide ? i + 1 : i).end;
      continue;
    }
    if (/\w/.test(c)) {
      let j = i;
      while (j < src.length && /\w/.test(src[j])) j++;
      lastCode = src.slice(i, j);
      i = j;
      continue;
    }
    if (!/\s/.test(c)) lastCode = c;
    i++;
  }
  const strings = literals.map((l) => ({
    pieces: l.pieces.map((p) => encode(p, l.wide)),
    text: l.pieces.join(''),
    wide: l.wide,
    line: l.line,
    include: l.include,
    linkage: l.linkage,
  }));
  return { comments, strings };
}

// Index just past the last non-space character before `at`: where an adjacent literal would end.
function lastCodeEnd(src, at) {
  let j = at - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  return j + 1;
}

const SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

// The decoded value of a "..." or '...' literal starting at its quote, and the index after it.
function readQuoted(src, at) {
  const q = src[at];
  let out = '';
  let j = at + 1;
  while (j < src.length && src[j] !== q && src[j] !== '\n') {
    if (src[j] !== '\\') {
      out += src[j++];
      continue;
    }
    const e = src[j + 1];
    if (e in SIMPLE_ESCAPES) {
      out += SIMPLE_ESCAPES[e];
      j += 2;
    } else if (e === 'x') {
      const m = /^[0-9A-Fa-f]+/.exec(src.slice(j + 2, j + 10));
      out += String.fromCharCode(m ? parseInt(m[0], 16) & 0xffff : 0);
      j += 2 + (m ? m[0].length : 0);
    } else if (e === 'u' || e === 'U') {
      const len = e === 'u' ? 4 : 8;
      const cp = parseInt(src.slice(j + 2, j + 2 + len), 16);
      out += cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
      j += 2 + len;
    } else if (/[0-7]/.test(e ?? '')) {
      const m = /^[0-7]{1,3}/.exec(src.slice(j + 1));
      out += String.fromCharCode(parseInt(m[0], 8));
      j += 1 + m[0].length;
    } else if (e === '\n') {
      j += 2; // line continuation
    } else if (e === '\r' && src[j + 2] === '\n') {
      j += 3;
    } else {
      out += e ?? '';
      j += 2;
    }
  }
  return { value: out, end: j + 1 };
}

// The bytes the compiler emits for a literal (without the terminator).
function encode(s, wide) {
  if (wide) return Buffer.from(s, 'utf16le');
  // Narrow literals are in the ANSI code page; characters beyond Latin-1 keep their UTF-8 bytes.
  return [...s].every((ch) => ch.codePointAt(0) <= 0xff) ? Buffer.from(s, 'latin1') : Buffer.from(s, 'utf8');
}

/**
 * Comments and strings a submitted file adds over its base version that are not allowed.
 * @param {string} text           submitted file
 * @param {string|null} baseText  the file on the base commit (null for a new file)
 * @param {(bytes: Buffer) => boolean} inOriginal  whether the bytes occur in the original executable
 * @returns {{line: number, message: string}[]}  the messages never repeat the text itself
 */
export function freeTextErrors(text, baseText, inOriginal) {
  const now = scanText(text);
  const base = baseText === null ? { comments: [], strings: [] } : scanText(baseText);
  const errors = [];

  const baseComments = counts(base.comments.map((c) => c.text.trim()));
  for (const c of now.comments) {
    const t = c.text.trim();
    if (take(baseComments, t) || allowedComment(t)) continue;
    errors.push({ line: c.line, message: 'comments are not allowed in submissions (only annotations like // FUNCTION: fn_00001 and offset markers like /* 0010 */); remove it' });
  }

  const baseStrings = counts(base.strings.map(stringKey));
  for (const s of now.strings) {
    if (take(baseStrings, stringKey(s))) continue;
    if (s.include !== null) {
      if (!INCLUDE_PATH_RE.test(s.include) || s.include.startsWith('/')) {
        errors.push({ line: s.line, message: '#include paths may only use letters, digits and . _ / - and must be relative' });
      }
      continue;
    }
    if (s.linkage && LINKAGE.has(s.text)) continue;
    const whole = Buffer.concat(s.pieces);
    if (inOriginal(whole) || (s.pieces.length > 1 && s.pieces.every((p) => inOriginal(p)))) continue;
    errors.push({ line: s.line, message: "this string literal does not occur in the original executable; submissions may only use the original's strings" });
  }
  return errors;
}

const stringKey = (s) => `${s.wide ? 'L' : ''}${s.include !== null ? '#' : ''}${Buffer.concat(s.pieces).toString('hex')}`;

function counts(list) {
  const m = new Map();
  for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

function take(m, key) {
  const n = m.get(key) ?? 0;
  if (!n) return false;
  m.set(key, n - 1);
  return true;
}
