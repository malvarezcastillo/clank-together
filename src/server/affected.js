// Which units a header change can affect. Compiling every includer of a widely used header (700 to
// 1200 units for stpl.h and friends) took half an hour or more per batch and held up everyone
// else. A unit can only compile differently when its source mentions something the change
// touched: a name on a changed line, or the class/struct/union/enum the changed lines sit in
// (a new field moves every offset after it). Those are found with git grep over the includers.
//
// The judgement is textual, so a unit that reaches a changed type only through another header's
// inline code is missed; such a unit is compiled again whenever its own file or any of its
// headers change, and by the full rebuild.

const KEYWORDS = new Set(
  `alignas alignof and asm auto bool break case catch char class const constexpr const_cast continue decltype default delete do double
   dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not nullptr
   operator or private protected public register reinterpret_cast return short signed sizeof static static_assert static_cast struct switch
   template this throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while define ifdef ifndef endif
   include pragma undef elif line error __cdecl __stdcall __fastcall __thiscall __forceinline __inline __declspec int8_t int16_t int32_t
   int64_t uint8_t uint16_t uint32_t uint64_t size_t NULL TRUE FALSE BOOL DWORD WORD BYTE INT UINT LONG ULONG VOID FUNCTION INLINED STUB`.split(/\s+/),
);

// Whole identifiers only (not the "x16" of 0x16).
const IDENT = /(?<![A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_]{2,}/g;

// Plain lowercase words on a changed line are parameter and local names (rect, count, key):
// they say nothing about which units use the change and match nearly every file. Names with a
// capital, a digit or an underscore (CRect, m_buffer, unk_0124) are kept.
const telling = (w) => !KEYWORDS.has(w) && /[A-Z0-9_]/.test(w);

// The code of a line: no comments, no #include (its path is not code).
function code(line, state) {
  let s = line;
  if (state.block) {
    const end = s.indexOf('*/');
    if (end < 0) return '';
    s = s.slice(end + 2);
    state.block = false;
  }
  s = s.replace(/\/\*.*?\*\//g, ' ');
  const open = s.indexOf('/*');
  if (open >= 0) {
    state.block = true;
    s = s.slice(0, open);
  }
  s = s.replace(/\/\/.*$/, '');
  if (/^\s*#\s*include\b/.test(s)) return '';
  // String and character literals are text, not names.
  return s.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/** For each line, the innermost named class/struct/union/enum it is inside (or null). */
function enclosingTypes(lines) {
  const out = new Array(lines.length).fill(null);
  const stack = []; // names (or null for other braces)
  let pending = null; // a type head seen, waiting for its opening brace
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\/\/.*$/, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
    // "class T" in a template parameter list is not a type being defined.
    const head = /\b(?:class|struct|union|enum)\s+(?:__declspec\([^)]*\)\s*)?([A-Za-z_]\w*)[^;]*$/.exec(line.replace(/template\s*<[^>]*>/g, ''));
    if (head && head[1].length > 2) pending = head[1];
    out[i] = [...stack].reverse().find(Boolean) ?? pending ?? null;
    for (const c of line) {
      if (c === '{') {
        stack.push(pending);
        pending = null;
      } else if (c === '}') stack.pop();
      else if (c === ';' && pending && !line.includes('{')) pending = null; // a forward declaration
    }
    if (out[i] === null) out[i] = [...stack].reverse().find(Boolean) ?? null;
  }
  return out;
}

// A complete one-line declaration of an ordinary function (`Ret Name(args) const;`). Adding,
// removing or re-signaturing one cannot change a class layout, vtable or special-member
// triviality, so only units naming the function can compile differently (calls, overloads).
// Virtual/override, inline, templates, friends, operators, constructors and destructors still
// count as touching their enclosing type.
const DECL = /^\s*(?:static\s+)?(?:[A-Za-z_][\w:<>,*&\s]*?[\s*&])([A-Za-z_]\w*)\s*\([^(){};]*\)\s*(?:const\s*)?(?:noexcept\s*)?;\s*$/;
const NOT_PLAIN = /\b(virtual|override|final|inline|__forceinline|__inline|template|friend|operator|explicit|typedef|using|extern|default|delete)\b|[=:]\s*0\s*;|#/;
export function plainDeclaration(c, type) {
  if (NOT_PLAIN.test(c)) return null;
  const m = DECL.exec(c);
  if (!m || m[1] === type || /\b~/.test(c)) return null;
  return m[1];
}

// `struct X;` / `class X;` / `enum class X : int;` at namespace scope only introduces the name X:
// no layout or code changes except in units that name X. Inside a class it would declare a
// nested type that can change how later members resolve, so that stays conservative.
export const FORWARD = /^\s*(?:class|struct|union|enum(?:\s+(?:class|struct))?)\s+(?:__declspec\([^)]*\)\s*)?([A-Za-z_]\w*)\s*(?::\s*[\w:\s]+)?;\s*$/;

/**
 * Names a header change touches: identifiers on changed lines and the types around them.
 * `isVirtual(name)` reports a function name declared virtual anywhere: a plain-looking
 * declaration of it may implicitly override (vtable change), so it counts as touching its type.
 */
export function changedNames(before, after, { isVirtual = () => true } = {}) {
  const a = (before ?? '').replace(/\r\n/g, '\n').split('\n');
  const b = (after ?? '').replace(/\r\n/g, '\n').split('\n');
  const inA = new Map();
  const inB = new Map();
  for (const l of a) inA.set(l, (inA.get(l) ?? 0) + 1);
  for (const l of b) inB.set(l, (inB.get(l) ?? 0) + 1);
  const names = new Set();
  const take = (lines, other) => {
    const types = enclosingTypes(lines);
    const seen = new Map();
    const state = { block: false };
    lines.forEach((l, i) => {
      const c = code(l, state);
      seen.set(l, (seen.get(l) ?? 0) + 1);
      // A line that is new (or appears more often than before) is a changed line.
      if (seen.get(l) <= (other.get(l) ?? 0) || !c.trim()) return;
      const fn = plainDeclaration(c, types[i]);
      if (fn && (!types[i] || !isVirtual(fn))) {
        names.add(fn);
        return;
      }
      const fwd = !types[i] && FORWARD.exec(c);
      if (fwd) {
        names.add(fwd[1]);
        return;
      }
      for (const m of c.match(IDENT) ?? []) if (telling(m)) names.add(m);
      if (types[i]) names.add(types[i]);
    });
  };
  take(b, inA);
  take(a, inB);
  return [...names];
}

/**
 * Of `units`, those whose source mentions any of `names` (git grep -w over HEAD's tree plus the
 * submitted files). Returns null when the change is too broad to narrow down (every includer
 * is compiled then).
 */
export function unitsMentioning(repo, units, names, files = {}, { maxNames = 400 } = {}) {
  if (!names.length || !units.length) return [];
  if (names.length > maxNames) return null;
  const hits = new Set();
  const inSubmission = units.filter((u) => typeof files[u] === 'string');
  for (const u of inSubmission) if (names.some((n) => new RegExp(`\\b${n}\\b`).test(files[u]))) hits.add(u);
  const onMain = units.filter((u) => typeof files[u] !== 'string');
  // In chunks: the pathspec list can be long.
  for (let i = 0; i < onMain.length; i += 400) {
    const part = onMain.slice(i, i + 400);
    try {
      const out = repo.git(['grep', '-l', '-w', '-F', ...names.flatMap((n) => ['-e', n]), 'HEAD', '--', ...part]);
      for (const line of out.split('\n')) if (line.startsWith('HEAD:')) hits.add(line.slice(5));
    } catch {
      // git grep exits 1 when nothing matches
    }
  }
  return [...hits];
}


const virtualCache = new WeakMap();
/**
 * Every function name declared `virtual` somewhere on main or in `files` (cached per HEAD). A
 * plain-looking member declaration with such a name may implicitly override. Null when unknown.
 */
export function virtualNames(repo, files = {}) {
  const head = repo.head();
  let cached = virtualCache.get(repo);
  if (cached?.head !== head) {
    const set = new Set();
    try {
      const out = repo.git(['grep', '-h', '-o', '-E', '\\bvirtual\\b[^;{(]*\\b[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\\(', 'HEAD', '--']);
      for (const line of out.split('\n')) { const m = /([A-Za-z_]\w*)\s*\($/.exec(line); if (m) set.add(m[1]); }
    } catch (e) {
      if (e.status !== 1) return null;
    }
    cached = { head, set };
    virtualCache.set(repo, cached);
  }
  const set = new Set(cached.set);
  for (const text of Object.values(files)) for (const m of String(text ?? '').matchAll(/\bvirtual\b[^;{(]*\b([A-Za-z_]\w*)\s*\(/g)) set.add(m[1]);
  return set;
}