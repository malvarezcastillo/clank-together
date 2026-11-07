// Source-level storage checks. This scanner balances C++ declaration scopes and initializers;
// it is not a type checker. Compilation still validates types and preprocessor configurations.
// A symbol database entry supplies provenance, never a missing C++ definition.

import { parseAnnotations } from '../shared/annotations.js';

const IDENT = /^[A-Za-z_]\w*$/;
const NON_DECL = new Set(['using', 'typedef', 'return', 'delete', 'throw', 'break', 'continue', 'case', 'goto', 'if', 'else', 'while', 'for', 'switch', 'do', 'static_assert', 'namespace', 'enum', 'template', 'friend']);
const SPECIFIERS = new Set(['extern', 'static', 'inline', 'thread_local', 'constexpr', 'constinit', 'const', 'volatile', 'register', 'mutable']);
const BUILTIN = /^(?:bool|char|wchar_t|char8_t|char16_t|char32_t|short|int|long|float|double|signed|unsigned|auto|(?:std::)?(?:u?int(?:8|16|32|64)_t|size_t|ptrdiff_t))$/;

function tokensOf(text) {
  const out = [];
  const re = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|^[ \t]*\#[^\n]*(?:\\\r?\n[^\n]*)*|(?:u8|[uUL])?"(?:\\[\s\S]|[^"\\])*"|(?:u8|[uUL])?'(?:\\[\s\S]|[^'\\])*'|[A-Za-z_]\w*|(?:\d[\w.]*|\.\d[\w.]*)|::|&&|->|\.\.\.|[^\s]/gm;
  let line = 1;
  let last = 0;
  for (const m of text.matchAll(re)) {
    for (let i = last; i < m.index; i++) if (text[i] === '\n') line++;
    const tokenLine = line;
    for (const c of m[0]) if (c === '\n') line++;
    last = m.index + m[0].length;
    if (/^(?:\/\/|\/\*|\s*#)/.test(m[0])) continue;
    out.push({ value: m[0], line: tokenLine });
  }
  return out;
}

function pairsOf(tokens) {
  const pairs = new Map();
  const stack = [];
  const closing = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < tokens.length; i++) {
    const v = tokens[i].value;
    if (['(', '[', '{'].includes(v)) stack.push(i);
    else if (closing[v] && tokens[stack.at(-1)]?.value === closing[v]) {
      const start = stack.pop();
      pairs.set(start, i);
    }
  }
  return pairs;
}

function qualified(scope, name) {
  const prefix = scope.names.join('::');
  return prefix && !name.startsWith(prefix + '::') ? `${prefix}::${name}` : name;
}

function splitDeclarators(tokens) {
  const parts = [];
  let start = 0, depth = 0, angle = 0;
  for (let i = 0; i < tokens.length; i++) {
    const v = tokens[i].value;
    if (['(', '[', '{'].includes(v)) depth++;
    else if ([')', ']', '}'].includes(v)) depth--;
    else if (!depth && v === '<') angle++;
    else if (!depth && v === '>' && angle) angle--;
    else if (!depth && !angle && v === ',') {
      parts.push(tokens.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(tokens.slice(start));
  return parts;
}

function variable(part, scope, inheritedType = []) {
  if (!part.length || NON_DECL.has(part[0].value)) return null;
  if (['class', 'struct', 'union'].includes(part[0].value) && part.length === 2) return null;
  if (part.some((t) => t.value === '~' || t.value === 'operator')) return null;
  let tokens = part;
  // Attributes and declspecs do not change where the variable's name is.
  const imported = tokens.some((t) => t.value === 'dllimport');
  tokens = tokens.filter((t) => !['__cdecl', '__stdcall', '__fastcall', '__vectorcall', 'WINAPI', 'WSAAPI', 'CALLBACK'].includes(t.value));
  const clean = [];
  for (let i = 0; i < tokens.length; i++) {
    if (['__declspec', 'alignas'].includes(tokens[i].value) && tokens[i + 1]?.value === '(') {
      let depth = 1;
      i += 2;
      for (; i < tokens.length && depth; i++) depth += (tokens[i].value === '(' ? 1 : tokens[i].value === ')' ? -1 : 0);
      i--;
    } else clean.push(tokens[i]);
  }
  tokens = clean;
  const pairs = pairsOf(tokens);
  let firstSpecial = tokens.findIndex((t) => ['=', '{', '[', '('].includes(t.value));
  if (firstSpecial < 0) firstSpecial = tokens.length;
  let nameIndex = firstSpecial - 1;
  let functionPointer = false;
  if (tokens[firstSpecial]?.value === '(') {
    const end = pairs.get(firstSpecial);
    const group = tokens.slice(firstSpecial + 1, end);
    const star = group.findLastIndex((t) => ['*', '&', '&&'].includes(t.value));
    if (star >= 0 && group.slice(0, star).every((t) => ['::', 'const', 'volatile'].includes(t.value)) && IDENT.test(group[star + 1]?.value ?? '')) {
      functionPointer = true;
      nameIndex = firstSpecial + star + 2;
    } else {
      const args = tokens.slice(firstSpecial + 1, end);
      // A literal-led direct initializer is unambiguous; parameter defaults in a prototype are not.
      const firstArg = args[0]?.value ?? '';
      if (!/^(?:[\d"']|(?:u8|[uUL])["']|true$|false$|nullptr$|[-+]$)/.test(firstArg)) return null;
    }
  }
  if (!IDENT.test(tokens[nameIndex]?.value ?? '')) return null;
  let nameStart = nameIndex;
  while (nameStart >= 2 && tokens[nameStart - 1].value === '::' && IDENT.test(tokens[nameStart - 2].value)) nameStart -= 2;
  const name = tokens.slice(nameStart, nameIndex + 1).map((t) => t.value).join('');
  let type = functionPointer ? tokens.slice(0, firstSpecial) : tokens.slice(0, nameStart);
  if (inheritedType.length) type = [...inheritedType, ...type];
  if (!type.some((t) => IDENT.test(t.value) && !SPECIFIERS.has(t.value)) || type.some((t) => ['=', '.', '->', 'return'].includes(t.value))) return null;
  const specs = new Set(type.map((t) => t.value));
  const initializer = tokens.findIndex((t) => t.value === '=' || t.value === '{');
  const directInit = !functionPointer && tokens[firstSpecial]?.value === '(';
  const initialized = initializer >= 0 || directInit;
  const declaredExtern = specs.has('extern');
  const definition = (!declaredExtern || initialized) && (scope.kind !== 'class' || specs.has('inline') || (specs.has('constexpr') && initialized));
  if (scope.kind === 'class' && !specs.has('static') && !specs.has('inline')) return null;
  if (scope.kind === 'function' && !specs.has('static') && !specs.has('thread_local') && !declaredExtern) return null;
  const array = tokens.slice(nameIndex + 1).some((t) => t.value === '[');
  const typeText = type.filter((t) => !SPECIFIERS.has(t.value)).map((t) => t.value).join('').replace(/\s/g, '');
  const primitive = BUILTIN.test(typeText) || /^(?:unsigned|signed)?(?:longlong|long|short|int|char)$/.test(typeText);
  const valueTokens = initializer < 0 ? [] : tokens.slice(initializer + 1);
  const constantValue = valueTokens.length > 0 && !valueTokens.some((t) => t.value === '(' || t.value === 'new' || t.value === '[');
  const folded = !functionPointer && !array && primitive && (specs.has('constexpr') || specs.has('const')) && constantValue;
  return {
    name: qualified(scope, name), line: part[0].line,
    extern: declaredExtern && !definition, declaredExtern, definition, folded, imported,
    member: scope.kind === 'class', local: scope.kind === 'function',
    internal: scope.internal || (scope.kind !== 'class' && specs.has('static')),
    signature: [...type, ...tokens.slice(nameStart)].map((t) => t.value).join(' '),
    type,
  };
}

/** Records include function pointers, multiline arrays, namespace/class storage and local statics. */
export function scanVariables(text, file = '<input>') {
  const tokens = tokensOf(String(text ?? '').replace(/\r\n/g, '\n'));
  const pairs = pairsOf(tokens);
  const out = [];
  function walk(start, end, scope) {
    let statement = start;
    for (let i = start; i < end; i++) {
      const v = tokens[i].value;
      if (['public', 'private', 'protected'].includes(v) && tokens[i + 1]?.value === ':') { statement = i + 2; i++; continue; }
      if (v === '(' || v === '[') { i = pairs.get(i) ?? i; continue; }
      if (v === '{') {
        const close = pairs.get(i);
        if (close === undefined) break;
        const prefix = tokens.slice(statement, i);
        const words = prefix.map((t) => t.value);
        const ns = words.indexOf('namespace');
        const cls = ['class', 'struct', 'union'].includes(words[0]) ? 0 : -1;
        const linkage = words[0] === 'extern' && /^"C(?:\+\+)?"$/.test(words[1] ?? '');
        if (ns >= 0 || cls >= 0 || linkage) {
          const names = ns >= 0 ? words.slice(ns + 1).filter((w) => IDENT.test(w)) : cls >= 0 ? [words[cls + 1]].filter((w) => IDENT.test(w ?? '')) : [];
          walk(i + 1, close, { kind: cls >= 0 ? 'class' : scope.kind, names: [...scope.names, ...names], internal: scope.internal || (ns >= 0 && !names.length) });
          i = close;
          statement = close + 1;
        } else if (words[0] === 'enum') {
          i = close; statement = close + 1;
        } else if ((!words.includes('=') && words.includes(')') && !variable(prefix, scope)) || (scope.kind === 'function' && !variable(prefix, scope))) {
          // A function body, or a nested control-flow block in one.
          const paren = words.indexOf('(');
          const fnName = IDENT.test(words[paren - 1] ?? '') ? words[paren - 1] : '<block>';
          walk(i + 1, close, { ...scope, kind: 'function', names: scope.kind === 'function' ? scope.names : [...scope.names, fnName] });
          i = close; statement = close + 1;
        } else {
          i = close; // brace initializer; the terminating semicolon owns the declaration
        }
        continue;
      }
      if (v !== ';') continue;
      const parts = splitDeclarators(tokens.slice(statement, i));
      let inheritedType = [];
      for (const part of parts) {
        const record = variable(part, scope, inheritedType);
        if (!record) continue;
        inheritedType = record.type;
        delete record.type;
        out.push({ ...record, file });
      }
      statement = i + 1;
    }
  }
  walk(0, tokens.length, { kind: 'file', names: [], internal: false });
  const annotations = parseAnnotations(String(text ?? ''), file).annotations;
  for (const r of out) {
    const ann = annotations.find((a) => a.targetLine === r.line && ['GLOBAL', 'STRING', 'VTABLE'].includes(a.kind));
    r.annotation = ann ? `${ann.kind}:${ann.id}` : null;
    // An internal-linkage static whose only trace in the original is its dynamic initializer
    // (a registration whose storage the optimizer removed) carries that initializer's FUNCTION ID.
    const initializer = annotations.find((a) => a.targetLine === r.line && a.kind === 'FUNCTION');
    r.initializer = !ann && r.internal && !r.local && r.definition && initializer ? initializer.id : null;
  }
  return out;
}

function recordKey(r) {
  return `${r.name}|${r.local}|${r.internal}|${r.definition}|${r.signature}|${r.annotation ?? ''}`;
}

export function newVariables(after, before) {
  const old = new Set(scanVariables(before).map(recordKey));
  return scanVariables(after).filter((r) => !old.has(recordKey(r)));
}

export function definesVariable(text, name) {
  return scanVariables(text).some((r) => r.definition && !r.local && !r.internal && r.name === name);
}

/**
 * Apply changed files over main. Existing violations are reported by audit mode, not re-rejected
 * on unrelated edits. Removing the last definition is checked even if the extern is unchanged.
 * `repository` is source content from main, not the symbol database or other pending batches.
 */
export function globalViolations(files, { before = () => null, repository = {}, audit = false } = {}) {
  const all = new Map(Object.entries(repository).map(([f, t]) => [f, scanVariables(t, f)]));
  const previous = new Map();
  for (const [file, text] of Object.entries(files)) {
    previous.set(file, scanVariables(before(file), file));
    all.set(file, scanVariables(text, file));
  }
  const definitions = new Map();
  for (const records of all.values()) for (const r of records) {
    if (!r.definition || r.local || r.internal) continue;
    if (!definitions.has(r.name)) definitions.set(r.name, []);
    definitions.get(r.name).push(r);
  }
  const removed = new Set();
  for (const records of previous.values()) for (const r of records) if (r.definition && !r.local && !r.internal && !definitions.has(r.name)) removed.add(r.name);
  const errors = [];
  for (const [file, records] of all) {
    const submitted = Object.hasOwn(files, file);
    const old = new Set((previous.get(file) ?? []).map(recordKey));
    for (const v of records) {
      const added = submitted && (audit || !old.has(recordKey(v)));
      if (!added && !removed.has(v.name)) continue;
      const report = (rule, message) => errors.push({ file, line: v.line, name: v.name, rule, message });
      if (v.extern) {
        if (added && v.annotation) report('annotated-extern', `${v.name}: put the stable ID on its definition, not on this extern declaration`);
        if (added && /\.(c|cc|cpp|cxx)$/i.test(file) && !v.imported) report('extern-in-unit', `${v.name}: include its owner's header instead of declaring an extern variable in a source unit`);
        if (!v.imported && !definitions.has(v.name)) report('undefined-extern', `${v.name}: no external definition exists in main plus this payload; a symbol ID or another extern is not a definition`);
      } else if (added && v.definition && !v.folded && !v.annotation && !v.initializer) {
        report('unannotated-global', `${v.name}: static-storage definitions need a stable GLOBAL ID (or the appropriate STRING/VTABLE ID)`);
      }
    }
  }
  return errors;
}
