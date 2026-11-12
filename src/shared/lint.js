// Static gate for submissions: runs before anything is compiled.
// Everything submitted is untrusted, so this is deliberately strict.

import path from 'node:path';

export const DEFAULT_LIMITS = {
  maxFiles: 24,
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
 * Files a submission moves: an added file whose name (without directory) matches exactly one file
 * the submission deletes. A moved file is judged against the file it replaces, like an edit of it.
 * @param {Record<string,string|null>} files  path -> content (null: deleted)
 * @param {(path: string) => boolean} isNew   whether main does not hold the path
 * @returns {Map<string,string>}  added path -> deleted path
 */
export function movedFrom(files, isNew) {
  const fileName = (p) => p.slice(p.lastIndexOf('/') + 1).toLowerCase();
  const deleted = new Map();
  for (const [p, content] of Object.entries(files ?? {})) {
    if (content !== null) continue;
    const n = normalizeRepoPath(p);
    if (!n) continue;
    const k = fileName(n);
    deleted.set(k, deleted.has(k) ? null : n); // two deletions of one name: ambiguous
  }
  const out = new Map();
  for (const [p, content] of Object.entries(files ?? {})) {
    if (typeof content !== 'string') continue;
    const n = normalizeRepoPath(p);
    const from = n && deleted.get(fileName(n));
    if (from && isNew(n)) out.set(n, from);
  }
  return out;
}

/**
 * Explicit-template declarations (`extern template ...;`) belong in the unit's linkage prelude
 * (project.unitPrelude), not in the game source. Only lines a submission adds are refused: what main
 * already has passes, so work that touches such a file is not held up.
 * @param {(path: string) => string | null} baseText  the file's text on main (null when new)
 */
export function externTemplateErrors(file, text, preludeDir, baseText) {
  if (!preludeDir) return [];
  const dir = preludeDir.replace(/\/+$/, '');
  if (file.startsWith(`${dir}/`)) return [];
  const declarations = (s) => {
    const code = stripCommentsAndStrings(s ?? '');
    const out = [];
    const re = /^[ \t]*extern\s+template\b[^;{]*;/gm;
    let m;
    while ((m = re.exec(code))) out.push({ text: m[0].replace(/\s+/g, ' ').trim(), index: m.index });
    return { code, out };
  };
  const before = new Map();
  for (const d of declarations(baseText?.(file)).out) before.set(d.text, (before.get(d.text) ?? 0) + 1);
  const { code, out } = declarations(text);
  const errors = [];
  for (const d of out) {
    const left = before.get(d.text) ?? 0;
    if (left > 0) {
      before.set(d.text, left - 1);
      continue;
    }
    const prelude = /\.(c|cc|cpp|cxx)$/i.test(file) ? `${dir}/${file}.h` : `the linkage prelude (${dir}/<unit>.h) of each unit that needs it`;
    errors.push({ file, line: lineOf(code, d.index), message: `extern template declarations go in ${prelude}, not in the game source; the build forces that file into the unit` });
  }
  return errors;
}

/**
 * Checks a submission's shape and content.
 * @param {Record<string,string>} files   path -> content
 * @param {{allowedPaths: string[], limits?: object, allowedPragmas?: string[], baseSize?: (path: string) => number | null, trackedPaths?: Iterable<string>}} opts
 *   baseSize: the file's size on main (null when new). Only the part of a file beyond its size
 *   on main counts toward maxTotalBytes; a single file has no size limit of its own.
 *   trackedPaths: every file main holds. A path that differs from one of them (or from another
 *   file of the submission) only by letter case is rejected: on case-insensitive checkouts the
 *   two are one file, so the second silently overwrites or never reaches the commit.
 *   unitPrelude / baseText: with a linkage prelude folder, extern template lines a submission adds
 *   to game source are refused (externTemplateErrors); baseText gives a file's text on main.
 */
export function lintSubmission(files, { allowedPaths, limits = {}, allowedPragmas, baseSize = () => null, trackedPaths = [], allowDeletions = false, unitPrelude = null, baseText = null } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const errors = [];
  const entries = Object.entries(files ?? {});
  if (entries.length === 0) errors.push({ file: null, message: 'submission contains no files' });
  if (entries.length > L.maxFiles) errors.push({ file: null, message: `too many files (${entries.length} > ${L.maxFiles})` });

  const byFold = new Map();
  for (const t of trackedPaths) byFold.set(t.toLowerCase(), t);
  const submittedFold = new Map();
  const moved = allowDeletions ? movedFrom(files, (f) => baseSize(f) === null) : new Map();
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
    if (content === null && allowDeletions) {
      if (tracked !== n) errors.push({ file: n, message: 'only a file main tracks can be deleted' });
      continue;
    }
    if (typeof content !== 'string') {
      errors.push({ file: n, message: 'content must be a string' });
      continue;
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    const base = baseSize(n) ?? (moved.has(n) ? baseSize(moved.get(n)) : null) ?? 0;
    total += Math.max(0, bytes - base);
    if (content.includes('\0')) errors.push({ file: n, message: 'file contains NUL bytes' });
    errors.push(...lintSource(n, content, { allowedPragmas, maxInitializerNumbers: L.maxInitializerNumbers }));
    errors.push(...externTemplateErrors(n, content, unitPrelude, baseText));
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
