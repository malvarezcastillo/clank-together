// Regions a protector (Themida, WinLicense) rewrote in the original.
//
// The build the protector was given marks a region with the SDK's macros: a START marker, the
// code, an END marker, each marker being  EB 10 "WL  " <id> 00 00 00 00 00 00 00 "WL  "  (a jump
// over sixteen bytes; END's id is START's plus one). The protector moves the code into a section
// of its own and leaves, byte for byte in the same place: a jmp or call into that section over the
// START marker's first five bytes, random bytes over the code, and nine two-byte  mov reg,reg  over
// the END marker. A mutated region (MUTATE, id 0x10) keeps the last thirteen bytes of its START
// marker; a virtualized one has random bytes there too.
//
// An UNPROTECTED region (id 0x20) holds code for the build the protector has not been run on, so
// the protector removes it: the jump over START's first five bytes goes to the end of the region,
// the rest of START stays, the code is overwritten and END becomes eighteen NOPs.
//
// So a function compiled with the same markers lines up with the original everywhere, and all of
// it but the region itself can be compared.

export const MARKER_LENGTH = 18;
const WL = [0x57, 0x4c, 0x20, 0x20];
const MUTATE = 0x10;
const UNPROTECTED = 0x20;
const NOP = 0x90;

/** The id of the SDK marker these eighteen bytes are, or null. */
export function markerId(bytes, at = 0) {
  if (at + MARKER_LENGTH > bytes.length || bytes[at] !== 0xeb || bytes[at + 1] !== 0x10) return null;
  for (let i = 0; i < 4; i++) if (bytes[at + 2 + i] !== WL[i] || bytes[at + 14 + i] !== WL[i]) return null;
  for (let i = 7; i < 14; i++) if (bytes[at + i] !== 0) return null;
  return bytes[at + 6];
}

/**
 * The marked regions of compiled code, in order: `{ start, end, id }`, from the START marker's
 * first byte to the byte after the END marker. `error` when the markers do not pair up.
 */
export function markedRegions(bytes) {
  const regions = [];
  let open = null;
  for (let i = 0; i + MARKER_LENGTH <= bytes.length; i++) {
    const id = markerId(bytes, i);
    if (id === null) continue;
    if (open === null) {
      if (id & 1) return { regions: [], error: `an END marker (id 0x${id.toString(16)}) at +0x${i.toString(16)} without its START` };
      open = { start: i, id };
    } else {
      if (id !== open.id + 1) return { regions: [], error: `the region that starts at +0x${open.start.toString(16)} (id 0x${open.id.toString(16)}) is not closed by its END marker` };
      regions.push({ start: open.start, end: i + MARKER_LENGTH, id: open.id });
      open = null;
    }
    i += MARKER_LENGTH - 1;
  }
  if (open) return { regions: [], error: `the region that starts at +0x${open.start.toString(16)} has no END marker` };
  return { regions, error: null };
}

/**
 * Why the original does not hold what a protector leaves of this region, or null when it does.
 * @param {import('./pe.js').PEImage} pe
 * @param {number} addr  the function's address
 * @param {Buffer} orig  the original's bytes from addr
 */
export function regionMismatch(pe, addr, orig, { start, end, id }) {
  const at = `+0x${start.toString(16)}`;
  if (end > orig.length) return `the region at ${at} ends past the original function`;
  if (orig[start] !== 0xe9 && orig[start] !== 0xe8) return `the original has no jump at ${at}, where the region starts`;
  const dest = addr + start + 5 + orig.readInt32LE(start + 1);
  if (id === UNPROTECTED) return unprotectedMismatch(orig, dest - addr, { start, end, id });
  const section = pe.sectionForVa(dest);
  if (!section || section === pe.sectionForVa(addr) || dest - pe.imageBase - section.rva < section.rawSize) {
    return `the original's jump at ${at} does not leave for a section whose bytes the file lacks`;
  }
  // What is left of the START marker says which macro it was.
  const restored = Buffer.concat([Buffer.from([0xeb, 0x10, 0x57, 0x4c, 0x20]), orig.subarray(start + 5, start + MARKER_LENGTH)]);
  const kept = orig[start + 5] === 0x20 ? markerId(restored) : null;
  if (kept !== null ? kept !== id : id === MUTATE) {
    return `the region at ${at} is marked with id 0x${id.toString(16)}, the original's ${kept !== null ? `with 0x${kept.toString(16)}` : 'is not a mutated one'}`;
  }
  for (let i = end - MARKER_LENGTH; i < end; i += 2) {
    const modrm = orig[i + 1];
    if (orig[i] !== 0x89 || modrm < 0xc0 || ((modrm >> 3) & 7) !== (modrm & 7)) {
      return `the original's region at ${at} does not end at +0x${end.toString(16)}: its body is not ${end - start - 2 * MARKER_LENGTH} bytes long`;
    }
  }
  return null;
}

/** The same for a region the protector removed instead of rewriting. */
function unprotectedMismatch(orig, dest, { start, end, id }) {
  const at = `+0x${start.toString(16)}`;
  if (orig[start] !== 0xe9 || dest !== end) return `the original's jump at ${at} does not skip the region, which ends at +0x${end.toString(16)}`;
  const restored = Buffer.concat([Buffer.from([0xeb, 0x10, 0x57, 0x4c, 0x20]), orig.subarray(start + 5, start + MARKER_LENGTH)]);
  if (markerId(restored) !== id) return `the region at ${at} is marked with id 0x${id.toString(16)}, the original's is not a removed one`;
  for (let i = end - MARKER_LENGTH; i < end; i++) {
    if (orig[i] !== NOP) return `the original's region at ${at} does not end at +0x${end.toString(16)}: its body is not ${end - start - 2 * MARKER_LENGTH} bytes long`;
  }
  return null;
}
