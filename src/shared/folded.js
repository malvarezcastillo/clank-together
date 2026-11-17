// `// FOLDED: fn_.....` marks a source function whose code the original linker folded into another
// function (identical COMDAT folding): one address, kept under that function's ID. Folding needs
// identical bytes, so the claim is checked: the folded definition must compile to the code at its
// ID's address. A match whose references are not all known yet (match_unresolved) is accepted, as
// it is for any function; anything else means the code is not the folded copy it claims to be.

import { STATUS } from './compare.js';

/**
 * Errors for FOLDED definitions of `files` that do not compile to the code at their ID's address.
 * @param {{units: {folded?: object[]}[]}} check
 * @param {Set<string>} files  the submitted files: only their FOLDED definitions are the submission's
 * @returns {{file: string, line: number, id: string, message: string}[]}
 */
export function foldedErrors(check, files) {
  const errors = [];
  const seen = new Set();
  for (const u of check.units) {
    for (const f of u.folded ?? []) {
      if (!files.has(f.file)) continue;
      const key = `${f.file}:${f.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (f.status === STATUS.EXACT || f.status === STATUS.UNRESOLVED) continue;
      const why =
        f.status === STATUS.MISSING ? 'no compiled function was found for it'
        : f.status === STATUS.NO_ADDRESS ? `${f.id} has no address in the symbol database`
        : `it compiles to different code (${(f.score * 100).toFixed(1)}%${f.size ? `, ${f.size.ours}/${f.size.original} bytes` : ''})`;
      errors.push({ file: f.file, line: f.line, id: f.id, message: `"// FOLDED: ${f.id}" claims the linker folded this function into ${f.id}, but ${why}: folding needs identical code; annotate it as its own function or make it compile to ${f.id}'s code` });
    }
  }
  // A definition compiled in several units is proven by any copy that matches.
  return errors.filter((e) => !check.units.some((u) => (u.folded ?? []).some((f) => f.file === e.file && f.line === e.line && (f.status === STATUS.EXACT || f.status === STATUS.UNRESOLVED))));
}
