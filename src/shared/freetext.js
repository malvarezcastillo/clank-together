// Free text in submissions. Agents read each other's code, so text in it could carry instructions
// to the next agent (prompt injection). A submission may therefore add no comments other than
// annotations and struct offset markers, and only string literals that exist in the original
// executable (text the original authors wrote). Identifier names are the only free text left.
// Comments and strings already on main are left alone: the rules apply to what a submission adds.

import iconv from 'iconv-lite';

const ANNOTATION_RE = /^\/\/\s*(FUNCTION|STUB|GLOBAL|VTABLE|STRING|SIZE|LIBRARY|OFFSET)\s*:\s*[\w.]+(\s+<[\w\s:<>,*&]{1,120}>)?\s*$/;
const OFFSET_RE = /^\/\*\s*(?:0x)?(?:[0-9A-Fa-f]{1,8}|-{2,8})\s*\*\/$/;
const BLANK_RE = /^(?:\/\/[\s\-=*\/]*|\/\*[\s\-=*]*\*\/)$/;
// The project marks inlined copies: // INLINED, optionally with the address range.
const INLINED_RE = /^\/\/\s*INLINED(?::\s*\[?\s*0x[0-9A-Fa-f]+\s*->\s*0x[0-9A-Fa-f]+\s*\]?)?\s*$/;
// A function whose original body is protector-virtualized: the reference build and address its
// source comes from, e.g. // VIRTUALIZED: 2025-06-04 0x0060C460 (verify.js checks the stub).
export const VIRTUALIZED_RE = /^\/\/\s*VIRTUALIZED:\s*(\d{4}-\d{2}-\d{2})\s+(0x[0-9A-Fa-f]{1,16})\s*$/;
const INCLUDE_RE = /^\s*#\s*include\s*$/;
const INCLUDE_PATH_RE = /^[\w.\/-]{1,200}$/;
const LINKAGE = new Set(['C', 'C++']);

/** Comments that are not free text: annotations, offset and inlining markers, separators. */
export function allowedComment(text) {
  const t = text.trim();
  return ANNOTATION_RE.test(t) || OFFSET_RE.test(t) || BLANK_RE.test(t) || INLINED_RE.test(t) || VIRTUALIZED_RE.test(t);
}

/**
 * Comments and string literals of C++ source. Adjacent literals ("a" "b") form one string.
 * @returns {{comments: {text: string, line: number}[], strings: {pieces: Buffer[], text: string, wide: boolean, line: number, include: string|null, linkage: boolean}[]}}
 */
export function scanText(src, executionCharset = null) {
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
      const { value, segments, end } = readQuoted(src, wide ? i + 1 : i);
      const prev = literals[literals.length - 1];
      if (prev && prev.end === lastCodeEnd(src, i) && prev.include === null) {
        prev.pieces.push({ value, segments });
        prev.wide ||= wide;
        prev.end = end;
      } else {
        const open = CALL_OPEN_RE.exec(src.slice(Math.max(0, i - 80), i));
        literals.push({ pieces: [{ value, segments }], wide, line, include: INCLUDE_RE.test(src.slice(lineBegin, i)) ? value : null, linkage: lastCode === 'extern', call: open?.[1] ?? null, length: open?.[2] != null ? Number(open[2]) : null, end });
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
    pieces: l.pieces.map((p) => encode(p, l.wide, executionCharset)),
    text: l.pieces.map((p) => p.value).join(''),
    wide: l.wide,
    line: l.line,
    include: l.include,
    linkage: l.linkage,
    call: l.call === null ? null : callWithKey(l.call, src.slice(l.end, l.end + 80), l.length),
  }));
  return { comments, strings };
}

// Index just past the last non-space character before `at`: where an adjacent literal would end.
function lastCodeEnd(src, at) {
  let j = at - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  return j + 1;
}

// `NAME(` right before a literal: the literal is the first argument of that call or macro; or
// `NAME(<decimal length>, ` for a macro that takes the encoded length first (lengthArgument rules).
const CALL_OPEN_RE = /\b([A-Za-z_]\w*)\s*\(\s*(?:([1-9]\d{0,4})\s*,\s*)?$/;
// `, <integer literal>)` right after it: the second and last argument, a constant key.
const CALL_KEY_RE = /^\s*,\s*(0[xX][0-9A-Fa-f]+|[1-9]\d*|0)(?:[uU](?:ll|LL|l|L)?|(?:ll|LL|l|L)[uU]?)?\s*\)/;

function callWithKey(name, after, length = null) {
  const m = CALL_KEY_RE.exec(after);
  return m ? { name, key: BigInt(m[1]), length } : null;
}

/**
 * Encodings a project may declare for literals the original stores encoded (data/decomp.json):
 *   "encodedLiterals": [{ "macro": "CRYPT_NAME", "kind": "xor-repeating-key", "keyBytes": 8, "includeTerminator": true }]
 * With "lengthArgument": true the macro is written MACRO(<length>, "text", key), the length being the
 * encoded size (an array initializer macro needs it, the preprocessor cannot count a literal).
 * A literal written as MACRO("text", key) is accepted when its encoded bytes and the key occur in
 * the original, which proves the text is the original's as much as a plain match does.
 */
const ENCODINGS = {
  'xor-repeating-key': (bytes, key, rule) => {
    const keyBytes = rule.keyBytes ?? 8;
    return Buffer.from(bytes.map((b, i) => b ^ Number((key >> BigInt(8 * (i % keyBytes))) & 0xffn)));
  },
};

export function encodedLiteralRules(list) {
  const rules = new Map();
  for (const rule of list ?? []) {
    if (!/^[A-Za-z_]\w*$/.test(rule.macro ?? '')) throw new Error(`encodedLiterals: invalid macro name ${JSON.stringify(rule.macro)}`);
    if (!ENCODINGS[rule.kind]) throw new Error(`encodedLiterals: unknown kind ${JSON.stringify(rule.kind)}`);
    const keyBytes = rule.keyBytes ?? 8;
    if (!Number.isInteger(keyBytes) || keyBytes < 1 || keyBytes > 8) throw new Error('encodedLiterals: keyBytes must be 1 to 8');
    if (rule.lengthArgument != null && typeof rule.lengthArgument !== 'boolean') throw new Error('encodedLiterals: lengthArgument must be a boolean');
    rules.set(rule.macro, rule);
  }
  return rules;
}

// Compilers store short constant data as aligned blocks and immediates (4, then 2 and 1 bytes for
// a tail), so the encoded bytes must occur either whole or in those pieces.
function chunks(bytes) {
  const out = [];
  let i = 0;
  for (; i + 4 <= bytes.length; i += 4) out.push(bytes.subarray(i, i + 4));
  if (i + 2 <= bytes.length) out.push(bytes.subarray(i, (i += 2)));
  if (i < bytes.length) out.push(bytes.subarray(i));
  return out;
}

function inOriginalEncoded(s, rules, inOriginal) {
  const rule = s.call && !s.wide ? rules.get(s.call.name) : undefined;
  if (!rule) return false;
  // A lengthArgument macro is written MACRO(<length>, "text", key); any other rule takes no length.
  if (Boolean(rule.lengthArgument) !== (s.call.length != null)) return false;
  const keyBytes = rule.keyBytes ?? 8;
  if (s.call.key >> BigInt(8 * keyBytes) !== 0n) return false;
  const key = Buffer.alloc(keyBytes);
  for (let i = 0; i < keyBytes; i++) key[i] = Number((s.call.key >> BigInt(8 * i)) & 0xffn);
  if (!chunks(key).every((c) => inOriginal(c))) return false;
  const plain = Buffer.concat([...s.pieces, ...(rule.includeTerminator ? [Buffer.alloc(1)] : [])]);
  // The length is what the compiler checks the initializer against: it must be the encoded size.
  if (rule.lengthArgument && s.call.length !== plain.length) return false;
  const encoded = ENCODINGS[rule.kind](plain, s.call.key, rule);
  return inOriginal(encoded) || chunks(encoded).every((c) => inOriginal(c));
}

const SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

// The decoded value of a "..." or '...' literal starting at its quote, and the index after it.
function readQuoted(src, at) {
  const q = src[at];
  let out = '';
  const segments = [];
  const append = (text, raw = false) => {
    out += text;
    const previous = segments[segments.length - 1];
    if (previous && previous.raw === raw) previous.text += text;
    else segments.push({ text, raw });
  };
  let j = at + 1;
  while (j < src.length && src[j] !== q && src[j] !== '\n') {
    if (src[j] !== '\\') {
      append(src[j++]);
      continue;
    }
    const e = src[j + 1];
    if (e in SIMPLE_ESCAPES) {
      append(SIMPLE_ESCAPES[e]);
      j += 2;
    } else if (e === 'x') {
      const m = /^[0-9A-Fa-f]+/.exec(src.slice(j + 2, j + 10));
      append(String.fromCharCode(m ? parseInt(m[0], 16) & 0xffff : 0), true);
      j += 2 + (m ? m[0].length : 0);
    } else if (e === 'u' || e === 'U') {
      const len = e === 'u' ? 4 : 8;
      const cp = parseInt(src.slice(j + 2, j + 2 + len), 16);
      append(cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '');
      j += 2 + len;
    } else if (/[0-7]/.test(e ?? '')) {
      const m = /^[0-7]{1,3}/.exec(src.slice(j + 1));
      append(String.fromCharCode(parseInt(m[0], 8)), true);
      j += 1 + m[0].length;
    } else if (e === '\n') {
      j += 2; // line continuation
    } else if (e === '\r' && src[j + 2] === '\n') {
      j += 3;
    } else {
      append(e ?? '');
      j += 2;
    }
  }
  return { value: out, segments, end: j + 1 };
}

// The bytes the compiler emits for a literal (without the terminator).
function encode(piece, wide, executionCharset) {
  if (wide) return Buffer.from(piece.value, 'utf16le');
  if (!executionCharset) {
    return [...piece.value].every((ch) => ch.codePointAt(0) <= 0xff) ? Buffer.from(piece.value, 'latin1') : Buffer.from(piece.value, 'utf8');
  }
  const parts = [];
  for (const segment of piece.segments) {
    if (segment.raw) {
      parts.push(Buffer.from(segment.text, 'latin1'));
      continue;
    }
    const bytes = iconv.encode(segment.text, executionCharset);
    if (iconv.decode(bytes, executionCharset) !== segment.text) return null;
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}

export function executionCharset(cflags) {
  let charset = null;
  for (const flag of cflags ?? []) {
    if (/^[/-]utf-8$/i.test(flag)) charset = 'utf8';
    const match = /^[/-]execution-charset:(.+)$/i.exec(flag);
    if (match) charset = match[1].replace(/^\.(\d+)$/, 'cp$1');
  }
  if (charset && !iconv.encodingExists(charset)) throw new Error(`unsupported execution character set: ${charset}`);
  return charset;
}

/**
 * Comments and strings a submitted file adds over its base version that are not allowed.
 * @param {string} text           submitted file
 * @param {string|null} baseText  the file on the base commit (null for a new file)
 * @param {(bytes: Buffer) => boolean} inOriginal  whether the bytes occur in the original executable
 * @param {Map} [encoded]  the project's encodedLiterals (encodedLiteralRules)
 * @returns {{line: number, message: string}[]}  the messages never repeat the text itself
 */
export function freeTextErrors(text, baseText, inOriginal, charset = null, encoded = new Map()) {
  return checkText(scanText(text, charset), baseText === null ? { comments: [], strings: [] } : scanText(baseText, charset), inOriginal, encoded);
}

/**
 * The same check for a whole submission against what all its files held together on the base:
 * comments and strings may move from one submitted file to another, each base occurrence once.
 * @returns {{file: string, line: number, message: string}[]}
 */
export function freeTextErrorsAcross(files, pooledBase, inOriginal, { charsetForFile = () => null, baseFiles = null, encoded = new Map() } = {}) {
  const bases = baseFiles ? Object.entries(baseFiles).filter(([, text]) => text !== null).map(([file, text]) => scanText(text, charsetForFile(file))) : [scanText(pooledBase)];
  const pool = { comments: counts(bases.flatMap((base) => base.comments.map((c) => c.text.trim()))), strings: counts(bases.flatMap((base) => base.strings.map(stringKey))) };
  const errors = [];
  for (const [file, text] of Object.entries(files)) {
    if (typeof text !== 'string') continue;
    for (const e of checkText(scanText(text, charsetForFile(file)), pool, inOriginal, encoded)) errors.push({ file, ...e });
  }
  return errors;
}

function checkText(now, base, inOriginal, encoded) {
  const errors = [];
  const baseComments = base.comments instanceof Map ? base.comments : counts(base.comments.map((c) => c.text.trim()));
  for (const c of now.comments) {
    const t = c.text.trim();
    if (take(baseComments, t) || allowedComment(t)) continue;
    errors.push({ line: c.line, message: 'comments are not allowed in submissions (only annotations like // FUNCTION: fn_00001 and offset markers like /* 0010 */); remove it' });
  }

  const baseStrings = base.strings instanceof Map ? base.strings : counts(base.strings.map(stringKey));
  for (const s of now.strings) {
    if (s.pieces.some((piece) => piece === null)) {
      errors.push({ line: s.line, message: 'this string literal cannot be represented in the configured execution character set' });
      continue;
    }
    if (take(baseStrings, stringKey(s))) continue;
    if (s.include !== null) {
      if (!INCLUDE_PATH_RE.test(s.include) || s.include.startsWith('/')) {
        errors.push({ line: s.line, message: '#include paths may only use letters, digits and . _ / - and must be relative' });
      }
      continue;
    }
    if (s.linkage && LINKAGE.has(s.text)) continue;
    const whole = Buffer.concat(s.pieces);
    if (inOriginal(whole) || (s.pieces.length > 1 && s.pieces.every((p) => inOriginal(p))) || inOriginalEncoded(s, encoded, inOriginal)) continue;
    errors.push({ line: s.line, message: "this string literal does not occur in the original executable; submissions may only use the original's strings" });
  }
  return errors;
}

const stringKey = (s) => `${s.wide ? 'L' : ''}${s.include !== null ? '#' : ''}${s.pieces.some((p) => p === null) ? `unencodable:${s.text}` : Buffer.concat(s.pieces).toString('hex')}`;

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
