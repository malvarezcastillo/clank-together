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

/** Names a header change touches: identifiers on changed lines and the types around them. */
export function changedNames(before, after) {
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
