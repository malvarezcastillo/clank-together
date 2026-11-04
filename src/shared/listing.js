// Parser for MSVC assembly listings (cl.exe /FAcs -> .cod files).
//
// The listing is used for two things the object file alone cannot give us
// without a demangler and a disassembler:
//   * which compiled function belongs to which source line (to associate
//     annotations with symbols), and demangled names for symbols;
//   * readable instruction text at each offset, for mismatch feedback.

const PROC_RE = /^(\S+)\s+PROC\b(?:[^;]*;\s*(.*))?$/;
const ENDP_RE = /^(\S+)\s+ENDP\b/;
const FILE_RE = /^;\s*File\s+(.+?)\s*$/;
// `; 42   : code of line 42` (the source text is listed after the line number).
const SRC_LINE_RE = /^;\s*(\d+)\s*:(.*)$/;
// A line whose code can put its own line number into the instruction stream. A macro that
// expands to __LINE__ without spelling it on the calling line is not recognized.
const LINE_MACRO_RE = /\b__LINE__\b/;
const NAME_DECL_RE = /^(?:PUBLIC|EXTRN)\s+([^\s:]+)(?::\S+)?\s*(?:;\s*(.*))?$/;
const DATA_RE = /^(\S+)\s+(?:DB|DW|DD|DQ|DT)\b.*?;\s*(.+)$/;
// The byte column may wrap: the first line then ends right after the bytes (no tab, no text)
// and a continuation line carries the rest of the bytes and the instruction.
const INSN_RE = /^\s+([0-9a-f]{5,8})\t([0-9a-f ]+?)(?:\t+\s*(.*))?$/;
const INSN_CONT_RE = /^\t([0-9a-f]{2}(?: [0-9a-f]{2})*)\s*\t*\s*(.*)$/;

export function normalizePath(p) {
  return p.replace(/\\/g, '/').toLowerCase();
}

export function parseListing(text) {
  const names = new Map();
  const procs = [];
  const data = [];
  let file = null;
  let proc = null;
  let srcLine = null;
  let srcHasLine = false;
  let pendingInsn = null;

  const cleanDemangled = (d) => (d ? d.replace(/,\s*COMDAT\s*$/, '').trim() : null);

  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = FILE_RE.exec(line))) {
      file = normalizePath(m[1]);
      continue;
    }
    if ((m = NAME_DECL_RE.exec(line))) {
      if (m[2]) names.set(m[1], cleanDemangled(m[2]));
      continue;
    }
    if ((m = PROC_RE.exec(line))) {
      proc = { symbol: m[1], demangled: cleanDemangled(m[2]), file, firstLine: null, sourceFile: null, insns: [] };
      if (proc.demangled) names.set(proc.symbol, proc.demangled);
      procs.push(proc);
      srcLine = null;
      srcHasLine = false;
      continue;
    }
    if ((m = ENDP_RE.exec(line))) {
      proc = null;
      pendingInsn = null;
      continue;
    }
    if (proc) {
      if ((m = SRC_LINE_RE.exec(line))) {
        srcLine = parseInt(m[1], 10);
        srcHasLine = LINE_MACRO_RE.test(m[2]);
        if (proc.firstLine === null) {
          proc.firstLine = srcLine;
          proc.sourceFile = file;
        }
        continue;
      }
      if ((m = INSN_RE.exec(line))) {
        // lineMacro: the line spells __LINE__, so a constant equal to its number is that line
        // number (compare.js masks it). Without it, such a constant is a coincidence and is code.
        const insn = { offset: parseInt(m[1], 16), text: (m[3] ?? '').replace(/\s+/g, ' ').trim(), srcLine, lineMacro: srcHasLine };
        proc.insns.push(insn);
        pendingInsn = insn.text ? null : insn;
        continue;
      }
      if (pendingInsn && (m = INSN_CONT_RE.exec(line))) {
        if (m[2]) {
          pendingInsn.text = m[2].replace(/\s+/g, ' ').trim();
          pendingInsn = null;
        }
        continue;
      }
    } else if ((m = DATA_RE.exec(line))) {
      const demangled = cleanDemangled(m[2]);
      data.push({ symbol: m[1], demangled });
      names.set(m[1], demangled);
    }
  }
  return { procs, data, names };
}

/** The listed instruction covering byte `offset` of a proc. */
export function insnAt(proc, offset) {
  let best = null;
  for (const i of proc.insns) {
    if (i.offset <= offset) best = i;
    else break;
  }
  return best;
}
