// Every function definition carries its provenance: `// FUNCTION:` (or `// STUB:`) with its ID, or
// `// INLINED` when the original has no standalone copy of it. A definition with none slips past
// every other gate: it compiles, nothing compares it, and nobody can tell what it stands for.
// Only definitions a submission adds or changes are checked: existing code on main is left alone.

const ANNOTATED_RE = /^\s*\/\/\s*(?:(?:FUNCTION|STUB)\s*:|INLINED\b)/;
const NOT_A_DEFINITION = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'sizeof', 'decltype', 'alignof', 'static_assert', 'operator']);

/**
 * Whether a line starts a function definition: a name, then a parameter list, then (on this or the
 * next line) the opening brace of a body. Declarations, calls, control statements, lambdas and
 * aggregate initializers are not.
 */
function definitionAt(lines, i) {
  const line = lines[i].replace(/\/\/.*$/, '').replace(/__declspec\s*\([^()]*\)|\[\[[^\]]*\]\]/g, ' ');
  if (/^\s*#/.test(line) || /[;=]\s*$/.test(line) || /^\s*[:,]/.test(line)) return false;
  const m = /^\s*(?:[\w:<>,*&~\s]+?\s+)?([~\w][\w:<>~]*)\s*\(/.exec(line);
  if (!m) return false;
  const name = m[1].split('::').pop();
  // An upper-case name called without a scope is a macro (ASSERT(x) {...}), not a definition.
  if (NOT_A_DEFINITION.has(name) || (!m[1].includes('::') && /^[A-Z_][A-Z0-9_]+$/.test(name))) return false;
  // The head must be a declaration: a return type or a qualified name (A::f), not an expression.
  const head = line.slice(0, m.index + m[0].length - 1).trim();
  if (!/\s/.test(head) && !head.includes('::')) return false;
  // The text from the parameter list on, joined over the next lines until a body brace or a
  // semicolon outside parentheses ends the declaration.
  let text = line.slice(line.indexOf('(', m.index));
  const ends = (s) => {
    let depth = 0;
    for (const c of s) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (depth === 0 && (c === '{' || c === ';')) return true;
    }
    return false;
  };
  for (let j = i + 1; j < Math.min(lines.length, i + 8) && !ends(text); j++) text += ' ' + lines[j].replace(/\/\/.*$/, '');
  let depth = 0;
  let k = 0;
  for (; k < text.length; k++) {
    if (text[k] === '(') depth++;
    else if (text[k] === ')' && --depth === 0) break;
  }
  const tail = text.slice(k + 1);
  // After the parameters: qualifiers, a trailing return type, a constructor's member initializers
  // (which hold parentheses and braces of their own), then the body.
  return /^\s*(?:const|noexcept|override|final|volatile|&|&&|->\s*[\w:<>*&\s]+|\s)*(?::[^;]*)?\{/.test(tail) && !/^\s*(?:const\s*)?=/.test(tail);
}

/** The annotation lines right above line `i` (comments, `template<...>` and attribute lines in between). */
function annotated(lines, i) {
  for (let j = i - 1; j >= 0; j--) {
    const t = lines[j].trim();
    if (ANNOTATED_RE.test(t)) return true;
    if (t.startsWith('//') || /^template\s*</.test(t) || /^\[\[.*\]\]$/.test(t)) continue;
    return false;
  }
  return false;
}

/**
 * Function definitions `text` has without any annotation. `key` is the definition's first line with
 * the function's own name masked: a definition main already has that was only renamed is the same
 * code, and stays exempt like any other definition already on main.
 */
function unannotatedDefinitions(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    if (inBlockComment) {
      if (lines[i].includes('*/')) inBlockComment = false;
      continue;
    }
    if (/^\s*\/\*/.test(lines[i]) && !lines[i].includes('*/')) {
      inBlockComment = true;
      continue;
    }
    if (definitionAt(lines, i) && !annotated(lines, i)) {
      const line = lines[i].trim();
      const name = /([~\w][\w:<>~]*)\s*\(/.exec(line.replace(/__declspec\s*\([^()]*\)|\[\[[^\]]*\]\]/g, ' '))?.[1]?.split('::').pop();
      const key = name && /^\w+$/.test(name) ? line.replace(new RegExp(`\\b${name}(?=\\s*\\()`), '\u0000') : line;
      out.push({ line: i + 1, key });
    }
  }
  return out;
}

/**
 * Errors for function definitions a submission adds or changes without `// FUNCTION:`, `// STUB:`
 * or `// INLINED` above them.
 * @param {string} text
 * @param {string|null} baseText  the file on the base commit (null for a new file)
 * @returns {{line: number, message: string}[]}
 */
export function unannotatedErrors(text, baseText) {
  const kept = new Map();
  for (const d of baseText === null ? [] : unannotatedDefinitions(baseText)) kept.set(d.key, (kept.get(d.key) ?? 0) + 1);
  const errors = [];
  for (const d of unannotatedDefinitions(text)) {
    const n = kept.get(d.key) ?? 0;
    if (n > 0) {
      kept.set(d.key, n - 1);
      continue;
    }
    errors.push({ line: d.line, message: `function definition without an annotation: add "// OFFSET:" and "// FUNCTION: fn_....." (td symbol), or "// INLINED" when the original has no standalone copy` });
  }
  return errors;
}
