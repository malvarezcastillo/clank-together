// Builders for synthetic COFF objects and PE images used by the tests.

export function buildCoff({ sections, symbols }) {
  const strings = [];
  let strSize = 4;
  const addString = (s) => {
    const off = strSize;
    strings.push(Buffer.from(s + '\0', 'latin1'));
    strSize += s.length + 1;
    return off;
  };
  const nameField = (name, isSymbol) => {
    const b = Buffer.alloc(8);
    if (name.length <= 8) b.write(name, 'latin1');
    else if (isSymbol) b.writeUInt32LE(addString(name), 4);
    else b.write('/' + addString(name), 'latin1');
    return b;
  };

  const headerSize = 20 + sections.length * 40;
  let p = headerSize;
  const layout = sections.map((s) => {
    const dataPtr = p;
    p += s.data.length;
    const relocPtr = p;
    p += (s.relocs?.length ?? 0) * 10;
    return { dataPtr, relocPtr };
  });
  const symPtr = p;

  const header = Buffer.alloc(20);
  header.writeUInt16LE(0x14c, 0);
  header.writeUInt16LE(sections.length, 2);
  header.writeUInt32LE(symPtr, 8);
  header.writeUInt32LE(symbols.length, 12);

  const secHeaders = sections.map((s, i) => {
    const h = Buffer.alloc(40);
    nameField(s.name, false).copy(h, 0);
    h.writeUInt32LE(s.data.length, 16);
    h.writeUInt32LE(layout[i].dataPtr, 20);
    h.writeUInt32LE(s.relocs?.length ? layout[i].relocPtr : 0, 24);
    h.writeUInt16LE(s.relocs?.length ?? 0, 32);
    h.writeUInt32LE(s.characteristics ?? 0x60501020, 36);
    return h;
  });

  const body = [];
  sections.forEach((s) => {
    body.push(s.data);
    for (const r of s.relocs ?? []) {
      const b = Buffer.alloc(10);
      b.writeUInt32LE(r.offset, 0);
      b.writeUInt32LE(r.symbolIndex, 4);
      b.writeUInt16LE(r.type, 8);
      body.push(b);
    }
  });

  const symTable = symbols.map((s) => {
    const b = Buffer.alloc(18);
    nameField(s.name, true).copy(b, 0);
    b.writeUInt32LE(s.value ?? 0, 8);
    b.writeInt16LE(s.section, 12);
    b.writeUInt16LE(s.type ?? 0, 14);
    b.writeUInt8(s.storageClass ?? 2, 16);
    return b;
  });
  const strTable = Buffer.concat([Buffer.alloc(4), ...strings]);
  strTable.writeUInt32LE(strSize, 0);
  return Buffer.concat([header, ...secHeaders, ...body, ...symTable, strTable]);
}

/**
 * A CodeView (C13) .debug$S section with one line table per function, as /Z7 writes it.
 * @param {Array<{symbolIndex: number, file: string, lines: Array<[offset: number, line: number]>}>} functions
 * @returns {{data: Buffer, relocs: Array<{offset, symbolIndex, type}>}}
 */
export function buildDebugS(functions) {
  const files = [...new Set(functions.map((f) => f.file))];
  const strings = Buffer.concat([Buffer.alloc(1), ...files.map((f) => Buffer.from(f + '\0', 'latin1'))]);
  const nameOffset = (f) => 1 + files.slice(0, files.indexOf(f)).reduce((n, s) => n + s.length + 1, 0);
  // File checksum entries: name offset, checksum size 0, kind 0, padded to 4 bytes.
  const checksums = Buffer.concat(files.map((f) => { const b = Buffer.alloc(8); b.writeUInt32LE(nameOffset(f), 0); return b; }));
  const fileId = (f) => files.indexOf(f) * 8;

  const parts = [Buffer.from([4, 0, 0, 0])];
  const relocs = [];
  let at = 4;
  const subsection = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(type, 0);
    head.writeUInt32LE(body.length, 4);
    const pad = Buffer.alloc((4 - (body.length % 4)) % 4);
    parts.push(head, body, pad);
    const bodyAt = at + 8;
    at += 8 + body.length + pad.length;
    return bodyAt;
  };
  for (const fn of functions) {
    const body = Buffer.alloc(12 + 12 + fn.lines.length * 8);
    body.writeUInt32LE(Math.max(...fn.lines.map(([o]) => o)) + 1, 8);
    body.writeUInt32LE(fileId(fn.file), 12);
    body.writeUInt32LE(fn.lines.length, 16);
    body.writeUInt32LE(12 + fn.lines.length * 8, 20);
    fn.lines.forEach(([offset, line], i) => {
      body.writeUInt32LE(offset, 24 + i * 8);
      body.writeUInt32LE((line | 0x80000000) >>> 0, 28 + i * 8);
    });
    const bodyAt = subsection(0xf2, body);
    relocs.push({ offset: bodyAt, symbolIndex: fn.symbolIndex, type: 0x0b }, { offset: bodyAt + 4, symbolIndex: fn.symbolIndex, type: 0x0a });
  }
  subsection(0xf3, strings);
  subsection(0xf4, checksums);
  return { data: Buffer.concat(parts), relocs };
}

/**
 * @param {{imageBase?: number, sections: Array<{name, rva, data, virtualSize?, characteristics?}>, baseRelocs?: number[], relocsStripped?: boolean}} p
 *        baseRelocs are virtual addresses of HIGHLOW fixups. relocsStripped marks the image as linked
 *        without a relocation table (IMAGE_FILE_RELOCS_STRIPPED), as a packer leaves it.
 *        imports, tls: {rva, size} of the import and TLS directories (data the sections hold).
 */
export function buildPe({ imageBase = 0x400000, sections, baseRelocs = [], relocsStripped = false, imports = null, tls = null }) {
  const all = [...sections];
  if (baseRelocs.length) {
    const pages = new Map();
    for (const va of baseRelocs) {
      const rva = va - imageBase;
      const page = rva & ~0xfff;
      if (!pages.has(page)) pages.set(page, []);
      pages.get(page).push(rva & 0xfff);
    }
    const blocks = [];
    for (const [page, offs] of pages) {
      if (offs.length % 2) offs.push(-1);
      const b = Buffer.alloc(8 + offs.length * 2);
      b.writeUInt32LE(page, 0);
      b.writeUInt32LE(b.length, 4);
      offs.forEach((o, i) => b.writeUInt16LE(o < 0 ? 0 : (3 << 12) | o, 8 + i * 2));
      blocks.push(b);
    }
    const last = all[all.length - 1];
    const rva = Math.ceil((last.rva + last.data.length) / 0x1000) * 0x1000 + 0x1000;
    all.push({ name: '.reloc', rva, data: Buffer.concat(blocks), characteristics: 0x42000040, isReloc: true });
  }

  const peOff = 0x40;
  const optSize = 224;
  const secTable = peOff + 4 + 20 + optSize;
  let raw = Math.ceil((secTable + all.length * 40) / 0x200) * 0x200;
  const placed = all.map((s) => {
    const rawSize = Math.ceil(s.data.length / 0x200) * 0x200;
    const r = { ...s, rawPtr: raw, rawSize };
    raw += rawSize;
    return r;
  });
  const buf = Buffer.alloc(raw);
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(peOff, 0x3c);
  buf.writeUInt32LE(0x4550, peOff);
  const coff = peOff + 4;
  buf.writeUInt16LE(0x14c, coff);
  buf.writeUInt16LE(placed.length, coff + 2);
  buf.writeUInt16LE(optSize, coff + 16);
  if (relocsStripped) buf.writeUInt16LE(0x0001, coff + 18);
  const opt = coff + 20;
  buf.writeUInt16LE(0x10b, opt);
  buf.writeUInt32LE(0x1000, opt + 16);
  buf.writeUInt32LE(imageBase, opt + 28);
  buf.writeUInt32LE(16, opt + 92);
  if (imports) {
    buf.writeUInt32LE(imports.rva, opt + 96 + 1 * 8);
    buf.writeUInt32LE(imports.size, opt + 100 + 1 * 8);
  }
  if (tls) {
    buf.writeUInt32LE(tls.rva, opt + 96 + 9 * 8);
    buf.writeUInt32LE(tls.size, opt + 100 + 9 * 8);
  }
  const reloc = placed.find((s) => s.isReloc);
  if (reloc) {
    buf.writeUInt32LE(reloc.rva, opt + 96 + 5 * 8);
    buf.writeUInt32LE(reloc.data.length, opt + 100 + 5 * 8);
  }
  placed.forEach((s, i) => {
    const o = secTable + i * 40;
    buf.write(s.name, o, 'latin1');
    buf.writeUInt32LE(s.virtualSize ?? s.data.length, o + 8);
    buf.writeUInt32LE(s.rva, o + 12);
    buf.writeUInt32LE(s.rawSize, o + 16);
    buf.writeUInt32LE(s.rawPtr, o + 20);
    buf.writeUInt32LE(s.characteristics ?? 0x60000020, o + 36);
    s.data.copy(buf, s.rawPtr);
  });
  return buf;
}

/**
 * A tiny "game": Player_Update at 0x401000 calls Callee at 0x401100 and reads
 * g_val at 0x405000.
 *
 *   55             push ebp
 *   8b ec          mov ebp, esp
 *   e8 rel32       call Callee
 *   a1 imm32       mov eax, [g_val]
 *   5d             pop ebp
 *   c3             ret
 */
export const FN_ADDR = 0x401000;
export const CALLEE_ADDR = 0x401100;
export const GLOBAL_ADDR = 0x405000;

export function fixture({ objPatch, globalName = '?g_val@@3HA', relocsStripped = false } = {}) {
  const text = Buffer.alloc(0x200, 0xcc);
  const code = Buffer.from([0x55, 0x8b, 0xec, 0xe8, 0, 0, 0, 0, 0xa1, 0, 0, 0, 0, 0x5d, 0xc3]);
  code.copy(text, 0);
  text.writeInt32LE(CALLEE_ADDR - (FN_ADDR + 8), 4);
  text.writeUInt32LE(GLOBAL_ADDR, 9);
  Buffer.from([0xc3]).copy(text, CALLEE_ADDR - FN_ADDR);
  const data = Buffer.alloc(0x10);
  const pe = buildPe({
    sections: [
      { name: '.text', rva: 0x1000, data: text },
      { name: '.data', rva: 0x5000, data, characteristics: 0xc0000040 },
    ],
    baseRelocs: relocsStripped ? [] : [FN_ADDR + 9],
    relocsStripped,
  });

  const objCode = Buffer.from(code);
  objPatch?.(objCode);
  const obj = buildCoff({
    sections: [
      {
        name: '.text$mn',
        data: objCode,
        characteristics: 0x60501020, // code, COMDAT
        relocs: [
          { offset: 4, symbolIndex: 2, type: 0x14 },
          { offset: 9, symbolIndex: 3, type: 0x06 },
        ],
      },
    ],
    symbols: [
      { name: '.text$mn', section: 1, storageClass: 3 },
      { name: '?Update@Player@@QAEXXZ', section: 1, type: 0x20, storageClass: 2 },
      { name: '?Callee@@YAXXZ', section: 0, type: 0x20, storageClass: 2 },
      { name: globalName, section: 0, storageClass: 2 },
    ],
  });

  const listing = [
    '; Listing generated by Microsoft (R) Optimizing Compiler Version 16.00.40219.01',
    'PUBLIC\t?Update@Player@@QAEXXZ\t\t\t\t; Player::Update',
    'EXTRN\t?Callee@@YAXXZ:PROC\t\t\t\t; Callee',
    `EXTRN\t${globalName}:DWORD\t\t\t\t; g_val`,
    '; Function compile flags: /Ogtp',
    '; File z:\\job\\src\\player.cpp',
    ';\tCOMDAT ?Update@Player@@QAEXXZ',
    '_TEXT\tSEGMENT',
    '?Update@Player@@QAEXXZ PROC\t\t\t\t; Player::Update, COMDAT',
    '',
    '; 5    : {',
    '',
    '  00000\t55\t\t push\t ebp',
    '  00001\t8b ec\t\t mov\t ebp, esp',
    '',
    '; 6    :     Callee();',
    '',
    '  00003\te8 00 00 00 00\t call\t ?Callee@@YAXXZ\t\t; Callee',
    '',
    '; 7    :     return g_val;',
    '',
    `  00008\ta1 00 00 00 00\t mov\t eax, DWORD PTR ${globalName} ; g_val`,
    '',
    '; 8    : }',
    '',
    '  0000d\t5d\t\t pop\t ebp',
    '  0000e\tc3\t\t ret\t 0',
    '?Update@Player@@QAEXXZ ENDP\t\t\t\t; Player::Update',
    '_TEXT\tENDS',
    'END',
  ].join('\r\n');

  const source = ['#include "player.h"', '', '// FUNCTION: fn_00001', 'int Player::Update()', '{', '    Callee();', '    return g_val;', '}', ''].join('\n');
  return { pe, obj, listing, source };
}
