// Minimal reader for PE32 (x86) and PE32+ (x64) images (the original target executable).
// Addresses are plain numbers; x64 image addresses (0x140000000 and up) stay well below 2^53.

const IMAGE_REL_BASED_HIGHLOW = 3;
const IMAGE_REL_BASED_DIR64 = 10;

export class PEImage {
  /** @param {Buffer} buf */
  constructor(buf) {
    this.buf = buf;
    if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE file (missing MZ header)');
    const peOff = buf.readUInt32LE(0x3c);
    if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('not a PE file (missing PE signature)');

    const coff = peOff + 4;
    this.machine = buf.readUInt16LE(coff);
    const numSections = buf.readUInt16LE(coff + 2);
    const optSize = buf.readUInt16LE(coff + 16);
    const opt = coff + 20;
    const magic = buf.readUInt16LE(opt);
    if (magic !== 0x10b && magic !== 0x20b) throw new Error(`unsupported optional header magic 0x${magic.toString(16)}`);
    this.is64 = magic === 0x20b;
    this.pointerSize = this.is64 ? 8 : 4;

    this.imageBase = this.is64 ? Number(buf.readBigUInt64LE(opt + 24)) : buf.readUInt32LE(opt + 28);
    this.entryPoint = this.imageBase + buf.readUInt32LE(opt + 16);
    const dirsAt = this.is64 ? 108 : 92;
    const numDirs = buf.readUInt32LE(opt + dirsAt);
    this.dataDirs = [];
    for (let i = 0; i < numDirs; i++) {
      this.dataDirs.push({ rva: buf.readUInt32LE(opt + dirsAt + 4 + i * 8), size: buf.readUInt32LE(opt + dirsAt + 8 + i * 8) });
    }

    this.sections = [];
    const secTable = opt + optSize;
    for (let i = 0; i < numSections; i++) {
      const o = secTable + i * 40;
      this.sections.push({
        name: buf.toString('latin1', o, o + 8).replace(/\0+$/, ''),
        virtualSize: buf.readUInt32LE(o + 8),
        rva: buf.readUInt32LE(o + 12),
        rawSize: buf.readUInt32LE(o + 16),
        rawPtr: buf.readUInt32LE(o + 20),
        characteristics: buf.readUInt32LE(o + 36),
      });
    }
    this._relocs = null;
  }

  sectionForRva(rva) {
    return this.sections.find((s) => rva >= s.rva && rva < s.rva + Math.max(s.virtualSize, s.rawSize));
  }

  sectionForVa(va) {
    return this.sectionForRva(va - this.imageBase);
  }

  /** Reads `len` bytes at virtual address `va`. Uninitialized (bss) bytes read as zero. */
  read(va, len) {
    const rva = va - this.imageBase;
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; ) {
      const s = this.sectionForRva(rva + i);
      if (!s) throw new Error(`address 0x${(va + i).toString(16)} is not inside any section`);
      const secOff = rva + i - s.rva;
      const secEnd = Math.max(s.virtualSize, s.rawSize);
      const n = Math.min(len - i, secEnd - secOff);
      if (secOff < s.rawSize) {
        const rawN = Math.min(n, s.rawSize - secOff);
        this.buf.copy(out, i, s.rawPtr + secOff, s.rawPtr + secOff + rawN);
      }
      i += n;
    }
    return out;
  }

  readU32(va) {
    return this.read(va, 4).readUInt32LE(0);
  }

  readU64(va) {
    return Number(this.read(va, 8).readBigUInt64LE(0));
  }

  isCode(va) {
    const s = this.sectionForVa(va);
    return !!s && (s.characteristics & 0x20000000) !== 0; // IMAGE_SCN_MEM_EXECUTE
  }

  /** Set of virtual addresses that carry a base relocation (absolute pointers: HIGHLOW on x86, DIR64 on x64). */
  baseRelocations() {
    if (this._relocs) return this._relocs;
    const set = new Set();
    const dir = this.dataDirs[5];
    if (dir && dir.rva && dir.size) {
      const s = this.sectionForRva(dir.rva);
      let p = s.rawPtr + (dir.rva - s.rva);
      const end = p + dir.size;
      while (p + 8 <= end) {
        const page = this.buf.readUInt32LE(p);
        const blockSize = this.buf.readUInt32LE(p + 4);
        if (blockSize < 8) break;
        for (let e = p + 8; e < p + blockSize; e += 2) {
          const entry = this.buf.readUInt16LE(e);
          const type = entry >> 12;
          if (type === IMAGE_REL_BASED_HIGHLOW || type === IMAGE_REL_BASED_DIR64) set.add(this.imageBase + page + (entry & 0xfff));
        }
        p += blockSize;
      }
    }
    this._relocs = set;
    return set;
  }
}
