// Address provenance next to function IDs. A project that opts in (data/decomp.json
// "offsetAnnotations": true) writes, directly above every FUNCTION or STUB line, a line
//   // OFFSET: 0x00AE97D0
// with the address the symbol database has for that ID (eight upper-case hex digits). The ID stays
// authoritative; the address is for people reading the source. An OFFSET line with no ID right
// below it, a missing or wrong one, and a blank line inside an annotation block are rejected.
// Only blocks a submission adds or changes are checked: existing code on main is left alone.

const ANNOTATION_RE = /^(\s*)\/\/\s*(OFFSET|FUNCTION|STUB)\s*:\s*(\S+)\s*$/;
const ADDRESS_RE = /^0x[0-9A-F]{8}$/;

/**
 * The annotation blocks of a file: consecutive OFFSET/FUNCTION/STUB lines (and blank lines
 * between them) up to the code they annotate.
 * @returns {{line: number, items: {line: number, kind: string, value: string}[], blankLines: number[], key: string}[]}
 */
export function annotationBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!ANNOTATION_RE.test(lines[i])) continue;
    const items = [];
    const blankLines = [];
    let j = i;
    for (; j < lines.length; j++) {
      const m = ANNOTATION_RE.exec(lines[j]);
      if (m) items.push({ line: j + 1, kind: m[2], value: m[3] });
      else if (lines[j].trim() === '') blankLines.push(j + 1);
      else break;
    }
    // The block's identity, to tell blocks a submission changed from ones it kept as they are.
    const target = j < lines.length ? lines[j].trim() : '';
    // Every blank line after the first annotation and before the code is inside the block.
    blocks.push({ line: i + 1, items, blankLines: j < lines.length ? blankLines : [], key: `${items.map((x) => `${x.kind}:${x.value}`).join('|')}=>${target}` });
    i = j - 1;
  }
  return blocks;
}

/**
 * OFFSET rule errors for the blocks of `text` that `baseText` does not hold as they are.
 * @param {string} text
 * @param {string|null} baseText  the file on the base commit (null for a new file)
 * @param {(id: string) => number|null|undefined} addressOf  the symbol database's address of an ID
 * @returns {{line: number, message: string}[]}
 */
export function offsetErrors(text, baseText, addressOf) {
  const kept = new Map();
  for (const b of baseText === null ? [] : annotationBlocks(baseText)) kept.set(b.key, (kept.get(b.key) ?? 0) + 1);
  const errors = [];
  for (const b of annotationBlocks(text)) {
    const n = kept.get(b.key) ?? 0;
    if (n > 0) {
      kept.set(b.key, n - 1);
      continue;
    }
    for (const blank of b.blankLines) errors.push({ line: blank, message: 'blank line inside an annotation block: annotations sit directly above what they annotate' });
    b.items.forEach((item, k) => {
      if (item.kind === 'OFFSET') {
        const next = b.items[k + 1];
        if (!next || next.kind === 'OFFSET') errors.push({ line: item.line, message: 'OFFSET line without its FUNCTION line right below it: remove it, or add the ID it belongs to' });
        if (!ADDRESS_RE.test(item.value)) errors.push({ line: item.line, message: `OFFSET must be eight upper-case hex digits like 0x00AE97D0, got ${item.value}` });
        return;
      }
      const prev = b.items[k - 1];
      const addr = addressOf(item.value);
      const want = addr == null ? null : `0x${addr.toString(16).toUpperCase().padStart(8, '0')}`;
      if (!prev || prev.kind !== 'OFFSET') {
        errors.push({ line: item.line, message: `${item.value} needs "// OFFSET: ${want ?? '0x........'}" on the line right above it (td symbol ${item.value})` });
      } else if (want && prev.value !== want) {
        errors.push({ line: prev.line, message: `OFFSET ${prev.value} is not the address of ${item.value} (${want}, td symbol ${item.value})` });
      }
    });
  }
  return errors;
}
