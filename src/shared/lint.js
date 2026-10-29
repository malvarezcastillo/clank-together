// Static gate for submissions: runs before anything is compiled.
// Everything submitted is untrusted, so this is deliberately strict.

import path from 'node:path';

export const DEFAULT_LIMITS = {
  maxFiles: 24,
  maxFileBytes: 256 * 1024,
  // A file main already holds may grow this much beyond its size there (Unit_C.cpp is 800 KB).
  maxFileGrowth: 128 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxNotesBytes: 4000,
  maxInitializerNumbers: 256,
};

const SOURCE_EXT = new Set(['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.inl']);
const DEFAULT_PRAGMAS = ['once', 'pack', 'warning', 'intrinsic', 'function', 'inline_depth', 'inline_recursion', 'optimize', 'push_macro', 'pop_macro', 'auto_inline', 'check_stack', 'pointers_to_members', 'vtordisp', 'init_seg'];

// Constructs that could make a "match" without real C++ code, or escape the build.
const BANNED = [
  { re: /\b_{1,2}asm\b/, message: 'inline assembly is not allowed' },
  { re: /\b_{1,2}emit\b/, message: '__emit is not allowed' },
  { re: /__declspec\s*\(\s*(allocate|naked)\b/, message: '__declspec(allocate/naked) is not allowed' },
  { re: /^\s*#\s*(import|using|line)\b/m, message: '#import, #using and #line are not allowed' },
  { re: /^\s*#\s*pragma\s+(comment|section|code_seg|data_seg|const_seg|bss_seg|alloc_text|include_alias)\b/m, message: 'this #pragma is not allowed' },
];

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(p, globs) {
  return globs.some((g) => globToRegExp(g).test(p));
}

/** Safe repo-relative path, or null. */
export function normalizeRepoPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 200) return null;
  if (p.includes('\\') || p.includes('\0') || p.includes(':')) return null;
  if (p.startsWith('/') || p.startsWith('.')) return null;
  const n = path.posix.normalize(p);
  if (n !== p || n.split('/').some((s) => s === '..' || s === '' || s.startsWith('.'))) return null;
  if (!/^[A-Za-z0-9_\-./]+$/.test(n)) return null;
  return n;
}

/** Removes comments and string/char literal contents, keeping line structure. */
export function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      out += ' ';
    } else if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') i++;
        i++;
      }
      out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Checks one file's contents. Also used on preprocessed output. */
export function lintSource(file, text, { allowedPragmas = DEFAULT_PRAGMAS, maxInitializerNumbers = DEFAULT_LIMITS.maxInitializerNumbers } = {}) {
  const errors = [];
  const code = stripCommentsAndStrings(text);

  for (const b of BANNED) {
    const re = new RegExp(b.re.source, b.re.flags.includes('m') ? 'gm' : 'g');
    let m;
    while ((m = re.exec(code))) errors.push({ file, line: lineOf(code, m.index), message: b.message });
  }

  const pragmaRe = /^\s*#\s*pragma\s+([A-Za-z_]+)/gm;
  let m;
  while ((m = pragmaRe.exec(code))) {
    if (!allowedPragmas.includes(m[1])) errors.push({ file, line: lineOf(code, m.index), message: `#pragma ${m[1]} is not on the allowed list` });
  }
  if (/__pragma\s*\(|_Pragma\s*\(/.test(code)) errors.push({ file, line: 1, message: '__pragma()/_Pragma() is not allowed, use #pragma' });

  const includeRe = /^\s*#\s*include\s*(.*)$/gm;
  while ((m = includeRe.exec(text))) {
    const arg = m[1].replace(/\/\/.*$|\/\*.*$/, '').trim();
    const q = /^(["<])([^">]+)[">]$/.exec(arg);
    const line = lineOf(text, m.index);
    if (!q) {
      errors.push({ file, line, message: `#include must use a literal "file" or <file>, got: ${arg}` });
    } else if (/(^|[\\/])\.\.([\\/]|$)/.test(q[2]) || /^[\\/]/.test(q[2]) || q[2].includes(':')) {
      errors.push({ file, line, message: `#include path must be relative and inside the include directories: ${q[2]}` });
    }
  }

  // Long numeric initializer lists are how machine code gets smuggled in as data.
  const initRe = /=\s*\{([^{}]*)\}/g;
  while ((m = initRe.exec(code))) {
    const numbers = m[1].match(/\b(0x[0-9a-fA-F]+|\d+)\b/g);
    if (numbers && numbers.length > maxInitializerNumbers) {
      errors.push({ file, line: lineOf(code, m.index), message: `initializer with ${numbers.length} numeric values exceeds the limit of ${maxInitializerNumbers}; large tables need maintainer approval` });
    }
  }
  return errors;
}

/**
 * Checks a submission's shape and content.
 * @param {Record<string,string>} files   path -> content
 * @param {{allowedPaths: string[], limits?: object, allowedPragmas?: string[], baseSize?: (path: string) => number | null, trackedPaths?: Iterable<string>}} opts
 *   baseSize: the file's size on main (null when new). The size limits count what a submission
 *   adds: a file main already holds may be larger than maxFileBytes by maxFileGrowth over its size
 *   there, and only the part beyond the main size counts toward maxTotalBytes.
 *   trackedPaths: every file main holds. A path that differs from one of them (or from another
 *   file of the submission) only by letter case is rejected: on case-insensitive checkouts the
 *   two are one file, so the second silently overwrites or never reaches the commit.
 */
export function lintSubmission(files, { allowedPaths, limits = {}, allowedPragmas, baseSize = () => null, trackedPaths = [] } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const errors = [];
  const entries = Object.entries(files ?? {});
  if (entries.length === 0) errors.push({ file: null, message: 'submission contains no files' });
  if (entries.length > L.maxFiles) errors.push({ file: null, message: `too many files (${entries.length} > ${L.maxFiles})` });

  const byFold = new Map();
  for (const t of trackedPaths) byFold.set(t.toLowerCase(), t);
  const submittedFold = new Map();
  let total = 0;
  for (const [p, content] of entries) {
    const n = normalizeRepoPath(p);
    if (!n) {
      errors.push({ file: p, message: 'invalid path' });
      continue;
    }
    const fold = n.toLowerCase();
    const tracked = byFold.get(fold);
    if (tracked !== undefined && tracked !== n) errors.push({ file: n, message: `path differs only by letter case from ${tracked} on main; use that path or a distinct name` });
    const twin = submittedFold.get(fold);
    if (twin !== undefined && twin !== n) errors.push({ file: n, message: `path differs only by letter case from ${twin} in the same submission` });
    submittedFold.set(fold, n);
    if (!SOURCE_EXT.has(path.posix.extname(n).toLowerCase())) errors.push({ file: n, message: 'only C/C++ source and header files may be submitted' });
    if (!matchesAny(n, allowedPaths)) errors.push({ file: n, message: `path is not allowed for this task (allowed: ${allowedPaths.join(', ')})` });
    if (typeof content !== 'string') {
      errors.push({ file: n, message: 'content must be a string' });
      continue;
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    const base = baseSize(n) ?? 0;
    total += Math.max(0, bytes - base);
    const max = Math.max(L.maxFileBytes, base ? base + L.maxFileGrowth : 0);
    if (bytes > max) errors.push({ file: n, message: base > L.maxFileBytes ? `file too large (${bytes} bytes; it may grow by ${L.maxFileGrowth} bytes over its ${base} on main)` : `file too large (${bytes} bytes)` });
    if (content.includes('\0')) errors.push({ file: n, message: 'file contains NUL bytes' });
    errors.push(...lintSource(n, content, { allowedPragmas, maxInitializerNumbers: L.maxInitializerNumbers }));
  }
  if (total > L.maxTotalBytes) errors.push({ file: null, message: `submission too large (${total} bytes beyond what main holds)` });
  return errors;
}

/**
 * Checks preprocessed output (cl /P), so macros cannot hide banned constructs.
 * Only text that originates from project files is checked; compiler headers are trusted.
 */
export function lintPreprocessed(text, isProjectFile) {
  const errors = [];
  let current = null;
  let chunk = [];
  const flush = () => {
    if (current && isProjectFile(current) && chunk.length) {
      for (const e of lintSource(current, chunk.join('\n'), { allowedPragmas: DEFAULT_PRAGMAS.concat(['comment']), maxInitializerNumbers: Infinity })) {
        if (e.message.startsWith('#include') || e.message.includes('#line')) continue;
        errors.push({ ...e, line: null, message: `after preprocessing: ${e.message}` });
      }
    }
    chunk = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const m = /^#line\s+\d+\s+"(.*)"/.exec(line) || /^#\s*\d+\s+"(.*)"/.exec(line);
    if (m) {
      flush();
      current = m[1].replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase();
      continue;
    }
    chunk.push(line);
  }
  flush();
  const seen = new Set();
  return errors.filter((e) => {
    const k = e.file + e.message;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
