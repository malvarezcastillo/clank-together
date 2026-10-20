// Functions a submission declares but nobody defines. The server compiles units one by one and
// compares their code; it never links. A call to a function declared only by its prototype
// compiles fine (an external reference) and no comparison notices, so an agent could "port" a
// function by calling helpers that exist nowhere (CAsyncObjectCancel, LocaleStringToIndex), and
// main would no longer link. A newly declared function must be defined in the submission, exist
// elsewhere in the repository, or be a known function of the original (the symbol database).

const NOT_A_TYPE = new Set(['return', 'delete', 'throw', 'else', 'case', 'goto', 'sizeof', 'new', 'do', 'if', 'while', 'for', 'switch', 'co_return']);

// A file-scope or class-scope prototype on one line: `ret name(params) [const];`
const PROTOTYPE = /^\s*((?:[A-Za-z_][\w:<>,*&\s]*?)[\s*&])([A-Za-z_]\w*)\s*\(([^;{}()]*(?:\([^()]*\)[^;{}()]*)*)\)\s*(?:const\s*)?(?:=\s*0\s*)?;\s*(?:\/\/.*)?$/;

function lineSet(text) {
  const m = new Map();
  for (const l of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
}

/**
 * For each line, whether it is at a scope where a prototype declares a function: file, namespace,
 * extern "C" or a class body. Inside a function body `Type name(args);` is a variable.
 */
function declarationScopes(lines) {
  const out = [];
  const stack = []; // true for scopes that hold declarations
  let pendingDecl = false; // a class/struct/union/namespace/extern head waits for its brace
  let block = false;
  for (const raw of lines) {
    let line = raw;
    if (block) {
      const e = line.indexOf('*/');
      line = e < 0 ? '' : line.slice(e + 2);
      if (e >= 0) block = false;
    }
    line = line.replace(/\/\*.*?\*\//g, ' ').replace(/\/\/.*$/, '').replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
    const open = line.indexOf('/*');
    if (open >= 0) {
      block = true;
      line = line.slice(0, open);
    }
    out.push(stack.every(Boolean));
    if (/\b(?:class|struct|union|namespace)\b[^;()]*$/.test(line.replace(/template\s*<[^>]*>/g, '')) || /\bextern\s+"C"/.test(raw)) pendingDecl = true;
    for (const c of line) {
      if (c === '{') {
        stack.push(pendingDecl);
        pendingDecl = false;
      } else if (c === '}') stack.pop();
      else if (c === ';') pendingDecl = false;
    }
  }
  return out;
}

/** Names of functions declared on lines the submission added (not in the base version). */
export function newPrototypes(after, before) {
  const old = lineSet(before);
  const seen = new Map();
  const out = new Set();
  const lines = String(after ?? '').replace(/\r\n/g, '\n').split('\n');
  const declScope = declarationScopes(lines);
  for (const [i, line] of lines.entries()) {
    seen.set(line, (seen.get(line) ?? 0) + 1);
    if (seen.get(line) <= (old.get(line) ?? 0) || !declScope[i]) continue;
    const m = PROTOTYPE.exec(line);
    if (!m) continue;
    const first = m[1].trim().split(/\s+/)[0];
    if (NOT_A_TYPE.has(first) || /=/.test(m[1])) continue;
    // A literal in the parentheses makes it an object constructed with arguments: CImVector c(0xFF, ...).
    if (/(?:^|[(,\s])(?:-?\d|'|")/.test(m[3])) continue;
    out.add(m[2]);
  }
  return [...out];
}

/** Whether `text` has a definition (a body) of a function called `name`. */
export function definesFunction(text, name) {
  const s = String(text ?? '');
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(s))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')' && --depth === 0) break;
    }
    const rest = s.slice(i + 1, i + 200);
    if (/^\s*(?:const\s*)?(?:noexcept\s*)?(?::[^;{]*)?\{/.test(rest)) return true;
  }
  return false;
}

/**
 * Functions the submission newly declares that are defined nowhere. `existsElsewhere(name)`:
 * the name occurs in the repository outside the submitted files; `known(name)`: a function of
 * the original has that name.
 */
export function undefinedDeclarations(files, { before, existsElsewhere, known }) {
  const declared = new Set();
  for (const [file, text] of Object.entries(files)) {
    if (typeof text !== 'string') continue;
    for (const n of newPrototypes(text, before(file))) declared.add(n);
  }
  const out = [];
  for (const name of declared) {
    if (Object.values(files).some((t) => typeof t === 'string' && definesFunction(t, name))) continue;
    if (known(name) || existsElsewhere(name)) continue;
    out.push(name);
  }
  return out;
}
