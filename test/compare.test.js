import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, buildCoff, buildDebugS, buildPe, FN_ADDR, CALLEE_ADDR, GLOBAL_ADDR } from './helpers.js';
import { PEImage } from '../src/shared/pe.js';
import { CoffObject } from '../src/shared/coff.js';
import { parseListing } from '../src/shared/listing.js';
import { parseAnnotations } from '../src/shared/annotations.js';
import { compareObject, compareFunction, bindAnnotations, STATUS, lcsRatio, sameOriginal, isDeletingDestructor, resolvedEffectiveHash, sameTarget } from '../src/shared/compare.js';
import { reconcile } from '../src/shared/reconcile.js';

const FILE = 'src/player.cpp';

function symbols(extra = []) {
  return new Map(
    [
      { id: 'fn_00001', kind: 'function', addr: FN_ADDR, size: 15 },
      { id: 'fn_00002', kind: 'function', addr: CALLEE_ADDR, size: 1 },
      { id: 'gl_00001', kind: 'global', addr: GLOBAL_ADDR, size: 4 },
      ...extra,
    ].map((s) => [s.id, s]),
  );
}

function run({ objPatch, globalName, nameIndex = new Map(), syms = symbols(), relocsStripped = false } = {}) {
  const f = fixture({ objPatch, globalName, relocsStripped });
  const { annotations } = parseAnnotations(f.source, FILE);
  const result = compareObject({
    obj: new CoffObject(f.obj),
    listing: parseListing(f.listing),
    file: FILE,
    annotations,
    symbols: syms,
    nameIndex,
    pe: new PEImage(f.pe),
  });
  return { result, fn: result.functions[0] };
}

test('PE reader maps addresses and base relocations', () => {
  const pe = new PEImage(fixture().pe);
  assert.equal(pe.imageBase, 0x400000);
  assert.equal(pe.read(FN_ADDR, 3).toString('hex'), '558bec');
  assert.ok(pe.baseRelocations().has(FN_ADDR + 9));
  assert.ok(pe.isCode(FN_ADDR));
  assert.ok(!pe.isCode(GLOBAL_ADDR));
});

test('COFF reader extracts functions and relocations', () => {
  const fns = new CoffObject(fixture().obj).functions();
  assert.equal(fns.length, 1);
  assert.equal(fns[0].name, '?Update@Player@@QAEXXZ');
  assert.equal(fns[0].bytes.length, 15);
  assert.deepEqual(fns[0].relocs.map((r) => [r.offset, r.symbol.name]), [[4, '?Callee@@YAXXZ'], [9, '?g_val@@3HA']]);
});

test('exact match when every referenced symbol is known', () => {
  const { fn } = run({ nameIndex: new Map([['?Callee@@YAXXZ', 'fn_00002'], ['?g_val@@3HA', 'gl_00001']]) });
  assert.equal(fn.status, STATUS.EXACT);
  assert.equal(fn.score, 1);
  assert.equal(fn.symbol, '?Update@Player@@QAEXXZ');
  assert.equal(fn.demangled, 'Player::Update');
});

// A packer that strips the relocation table leaves every absolute pointer unmarked: its value is
// then the only evidence, and a correct one must count. With a table, a pointer the original does
// not relocate is not one (an immediate that happens to equal an address), and stays a failure.
test('absolute pointers are judged by value only when the original has no relocation table', () => {
  const known = new Map([['?Callee@@YAXXZ', 'fn_00002'], ['?g_val@@3HA', 'gl_00001']]);
  const stripped = run({ nameIndex: known, relocsStripped: true }).fn;
  assert.equal(stripped.status, STATUS.EXACT, 'right address, no table: exact');
  assert.equal(stripped.score, 1);

  const elsewhere = symbols([{ id: 'gl_00002', kind: 'global', addr: GLOBAL_ADDR + 8, size: 4 }]);
  const wrong = run({ nameIndex: new Map([['?Callee@@YAXXZ', 'fn_00002'], ['?g_val@@3HA', 'gl_00002']]), syms: elsewhere, relocsStripped: true }).fn;
  assert.equal(wrong.status, STATUS.MISMATCH, 'wrong address, no table: still a mismatch');
  assert.match(wrong.relocations[0].reason, /references gl_00002/);

  const pe = new PEImage(fixture({ relocsStripped: true }).pe);
  assert.equal(pe.relocsStripped, true);
  assert.equal(pe.baseRelocations().size, 0);
  assert.equal(new PEImage(fixture().pe).relocsStripped, false);
});

test('with a relocation table, an absolute pointer it does not mark is a mismatch', () => {
  // The original keeps its table, but has no fixup at +9: the field there is not a pointer.
  const f = fixture();
  const pe = new PEImage(f.pe);
  pe._relocs = new Set();
  const { annotations } = parseAnnotations(f.source, FILE);
  const known = new Map([['?Callee@@YAXXZ', 'fn_00002'], ['?g_val@@3HA', 'gl_00001']]);
  const fn = compareObject({ obj: new CoffObject(f.obj), listing: parseListing(f.listing), file: FILE, annotations, symbols: symbols(), nameIndex: known, pe }).functions[0];
  assert.equal(fn.status, STATUS.MISMATCH);
  assert.equal(fn.relocations[0].reason, 'original has no absolute pointer at this offset');
});

test('effectiveHash ignores the per-unit tags MSVC gives anonymous namespaces and lambda closures', () => {
  // Unknown references hash by name; editing the unit rewrites these hex tags without changing code.
  const hash = (globalName) => run({ nameIndex: new Map([['?Callee@@YAXXZ', 'fn_00002']]), globalName }).fn.effectiveHash;
  assert.equal(hash('?v@?A0x0c4fce31@@3HA'), hash('?v@?A0x9d2e7710@@3HA'));
  assert.equal(hash('??<lambda_invoker_cdecl>@_Closure_wrapper_63e67006_4@@CAXXZ'), hash('??<lambda_invoker_cdecl>@_Closure_wrapper_f1ab2c9b_4@@CAXXZ'));
  // A different closure of the same unit, or a different name, is a different reference.
  assert.notEqual(hash('??<lambda_invoker_cdecl>@_Closure_wrapper_63e67006_4@@CAXXZ'), hash('??<lambda_invoker_cdecl>@_Closure_wrapper_63e67006_5@@CAXXZ'));
  assert.notEqual(hash('?v@?A0x0c4fce31@@3HA'), hash('?w@?A0x0c4fce31@@3HA'));
});

test('effectiveHash identifies a label of the function by where it lands, not by its unit-wide number', () => {
  // A jump table entry: the compiler numbers $LN labels across the unit, so an edit elsewhere renumbers them.
  const hash = (name, value, section = 1) => {
    const f = fixture();
    const obj = new CoffObject(f.obj);
    Object.assign(obj.symbols[3], { name, value, section });
    const { annotations } = parseAnnotations(f.source, FILE);
    return compareObject({ obj, listing: parseListing(f.listing), file: FILE, annotations, symbols: symbols(), nameIndex: new Map([['?Callee@@YAXXZ', 'fn_00002']]), pe: new PEImage(f.pe) }).functions[0].effectiveHash;
  };
  assert.equal(hash('$LN2792@Update', 13), hash('$LN2790@Update', 13));
  assert.notEqual(hash('$LN2792@Update', 13), hash('$LN2792@Update', 14), 'another target in the function is a change');
  assert.notEqual(hash('$LN2792@Update', 13, 0), hash('$LN2790@Update', 13, 0), 'a label outside the function still hashes by name');
});

test('a reference to a label of the function is checked by where the original points', () => {
  // A switch table's entry: nothing names the label, the place in the function is all there is.
  const known = new Map([['?Callee@@YAXXZ', 'fn_00002']]);
  const compare = (pointsTo) => {
    const f = fixture();
    f.pe.writeUInt32LE(pointsTo, f.pe.indexOf(Buffer.from('558bec', 'hex')) + 9);
    const obj = new CoffObject(f.obj);
    Object.assign(obj.symbols[3], { name: '$LN7@Update', value: 13, section: 1, storageClass: 6 });
    const { annotations } = parseAnnotations(f.source, FILE);
    return compareObject({ obj, listing: parseListing(f.listing), file: FILE, annotations, symbols: symbols(), nameIndex: known, pe: new PEImage(f.pe) }).functions[0];
  };
  const same = compare(FN_ADDR + 13);
  assert.equal(same.status, STATUS.EXACT, 'the same place in the function: nothing left unresolved');
  assert.deepEqual(same.relocations, []);
  const other = compare(FN_ADDR + 2);
  assert.equal(other.status, STATUS.MISMATCH, 'the original sends that case elsewhere');
  assert.match(other.relocations[0].reason, /refers to \+0xd of the function .* but original references 0x0*40\w+/);
});

test('a caller of a renamed function has the same effective code once the new name is bound', () => {
  const known = new Map([['?Callee@@YAXXZ', 'fn_00002'], ['?g_val@@3HA', 'gl_00001']]);
  const before = run({ nameIndex: known }).fn;
  // The callee is renamed in the same submission: the database does not know the new name yet.
  const renamed = run({ nameIndex: new Map([['?g_val@@3HA', 'gl_00001']]) }).fn;
  assert.notEqual(renamed.effectiveHash, before.effectiveHash, 'unresolved, the reference hashes by name');
  const bound = (name) => (name === '?Callee@@YAXXZ' ? CALLEE_ADDR : null);
  assert.equal(resolvedEffectiveHash(renamed, bound), resolvedEffectiveHash(before, bound), 'bound to the same address it is the same code');
  const elsewhere = (name) => (name === '?Callee@@YAXXZ' ? CALLEE_ADDR + 0x10 : null);
  assert.notEqual(resolvedEffectiveHash(renamed, elsewhere), resolvedEffectiveHash(before, bound), 'a call to another function is a change');
});

test('unknown references are resolved through the symbol database addresses', () => {
  const { result, fn } = run();
  assert.equal(fn.status, STATUS.UNRESOLVED);
  const check = { units: [result], annotationErrors: [] };
  const rec = reconcile(check, symbols());
  assert.equal(result.functions[0].status, STATUS.EXACT);
  assert.deepEqual(rec.learned.map((l) => [l.decorated, l.id]).sort(), [['?Callee@@YAXXZ', 'fn_00002'], ['?Update@Player@@QAEXXZ', 'fn_00001'], ['?g_val@@3HA', 'gl_00001']]);
  assert.deepEqual(rec.conflicts, []);
});

test('a reference to data with no symbol stays unresolved and is reported', () => {
  const syms = symbols();
  syms.delete('gl_00001');
  const { result } = run({ syms });
  const rec = reconcile({ units: [result], annotationErrors: [] }, syms);
  assert.equal(result.functions[0].status, STATUS.UNRESOLVED);
  assert.deepEqual(rec.unknown, [{ decorated: '?g_val@@3HA', addr: GLOBAL_ADDR }]);
});

// `mov eax, [ecx + t_count@SECREL]; ret` at 0x401000, with the TLS template in .tls at 0x403000:
// the field holds the variable's offset in the template.
function tlsCase({ field, directory = true, known = true }) {
  const code = Buffer.from([0x8b, 0x81, 0, 0, 0, 0, 0xc3]);
  const text = Buffer.alloc(0x20, 0xcc);
  code.copy(text);
  text.writeUInt32LE(field, 2);
  const tls = Buffer.alloc(0x40);
  tls.writeUInt32LE(0x403000, 0x20); // the directory: where the template starts and ends
  tls.writeUInt32LE(0x403020, 0x24);
  const pe = new PEImage(buildPe({
    sections: [{ name: '.text', rva: 0x1000, data: text }, { name: '.tls', rva: 0x3000, data: tls, characteristics: 0xc0000040 }],
    relocsStripped: true,
    tls: directory ? { rva: 0x3020, size: 24 } : null,
  }));
  const obj = new CoffObject(buildCoff({
    sections: [{ name: '.text$mn', data: code, relocs: [{ offset: 2, symbolIndex: 1, type: 0x0b }] }],
    symbols: [{ name: '?Get@@YAHXZ', section: 1, type: 0x20 }, { name: '?t_count@@3HA', section: 0 }],
  }));
  const syms = new Map([['gl_00007', { id: 'gl_00007', kind: 'global', addr: 0x403008, size: 4 }]]);
  return compareFunction({ fn: obj.functions()[0], addr: 0x401000, origSize: 7, pe, resolve: (name) => (known && name === '?t_count@@3HA' ? 'gl_00007' : null), symbols: syms });
}

test('a thread-local variable is checked by its offset in the TLS template', () => {
  const pe = new PEImage(fixture().pe);
  assert.equal(pe.tlsBase(), null, 'an image without thread-local data');

  const right = tlsCase({ field: 8 });
  assert.equal(right.status, STATUS.EXACT);
  const wrong = tlsCase({ field: 0xc });
  assert.equal(wrong.status, STATUS.MISMATCH, 'the original reads another thread-local variable');
  assert.match(wrong.relocations[0].reason, /references gl_00007 \(0x00403008\) but original references 0x0040300c/);
  assert.notEqual(right.effectiveHash, tlsCase({ field: 8, known: false }).effectiveHash);

  // A name the database does not know yet is learned from where the original points, like any other.
  const unknown = tlsCase({ field: 8, known: false });
  assert.equal(unknown.status, STATUS.UNRESOLVED);
  assert.deepEqual(unknown.inferred, [{ symbol: '?t_count@@3HA', addr: 0x403008 }]);

  // Without a TLS directory there is nothing to measure the offset from: masked, as before.
  assert.equal(tlsCase({ field: 0xc, directory: false }).status, STATUS.EXACT);
});

// `push offset literal; ret`: the same instruction bytes whatever the constant holds.
function literalCase(content, name = '??_C@_05A@hello@') {
  const code = Buffer.from([0x68, 0, 0, 0, 0, 0xc3]);
  const text = Buffer.alloc(0x20, 0xcc);
  code.copy(text);
  text.writeUInt32LE(0x402000, 1);
  const rdata = Buffer.alloc(0x40);
  rdata.write('hello\0', 'latin1');
  const pe = new PEImage(buildPe({ sections: [{ name: '.text', rva: 0x1000, data: text }, { name: '.rdata', rva: 0x2000, data: rdata, characteristics: 0x40000040 }], relocsStripped: true }));
  const obj = new CoffObject(buildCoff({
    sections: [
      { name: '.text$mn', data: code, relocs: [{ offset: 1, symbolIndex: 1, type: 0x06 }] },
      { name: '.rdata', data: Buffer.from(content, 'latin1'), characteristics: 0x40301040 },
    ],
    symbols: [{ name: '?Name@@YAPBDXZ', section: 1, type: 0x20 }, { name, section: 2 }],
  }));
  return compareFunction({ fn: obj.functions()[0], addr: 0x401000, origSize: 6, pe, resolve: () => null, symbols: new Map(), literalOf: (s) => obj.literal(s) });
}

test('effectiveHash tells which constant a function refers to', () => {
  const hello = literalCase('hello\0');
  assert.equal(hello.status, STATUS.EXACT);
  const other = literalCase('jello\0');
  assert.equal(other.status, STATUS.MISMATCH);
  assert.equal(hello.codeHash, other.codeHash, 'the instructions are the same bytes');
  assert.notEqual(hello.effectiveHash, other.effectiveHash, 'another string is other code');
  assert.equal(hello.effectiveHash, literalCase('hello\0', '??_C@_05B@hello@').effectiveHash, 'the same string under another symbol name');
  // __FILE__ holds the build machine's path: the file name is what counts, as it does when compared.
  assert.equal(literalCase('z:\\job\\src\\player.cpp\0').effectiveHash, literalCase('d:\\work\\src\\player.cpp\0').effectiveHash);
  assert.notEqual(literalCase('z:\\job\\src\\player.cpp\0').effectiveHash, literalCase('z:\\job\\src\\enemy.cpp\0').effectiveHash);
});

test('calling the wrong function is a mismatch', () => {
  const syms = symbols([{ id: 'fn_00003', kind: 'function', addr: 0x401200, size: 1, decorated: '?Callee@@YAXXZ' }]);
  const { fn } = run({ syms, nameIndex: new Map([['?Callee@@YAXXZ', 'fn_00003']]) });
  assert.equal(fn.status, STATUS.MISMATCH);
  assert.match(fn.relocations[0].reason, /fn_00003/);
});

test('reconcile flags a decorated name that is already bound elsewhere', () => {
  const syms = symbols([{ id: 'fn_00003', kind: 'function', addr: 0x401200, size: 1, decorated: '?Callee@@YAXXZ' }]);
  const { result } = run({ syms });
  const rec = reconcile({ units: [result], annotationErrors: [] }, syms);
  assert.equal(rec.conflicts.length, 1);
  assert.equal(result.functions[0].status, STATUS.MISMATCH);
});

// A function with the x86 EH prologue and its handler stub, as MSVC emits them.
function ehImage({ copyDiffers = false } = {}) {
  const text = Buffer.alloc(0x400, 0xcc);
  const FN = 0x401000, COPY = 0x401080, THUNK = 0x401100, STUB_A = 0x401200, STUB_B = 0x401220, HANDLER = 0x401300, CALLEE = 0x401340;
  const put = (va, bytes) => Buffer.from(bytes).copy(text, va - 0x401000);
  const rel = (va, at, target) => text.writeInt32LE(target - (va + at + 4), va - 0x401000 + at);
  const body = (va, stub) => {
    put(va, [0x55, 0x8b, 0xec, 0x6a, 0xff, 0x68, 0, 0, 0, 0, 0xe8, 0, 0, 0, 0, 0x5d, 0xc3]);
    text.writeUInt32LE(stub, va - 0x401000 + 6);
    rel(va, 11, CALLEE);
  };
  body(FN, STUB_A);
  body(COPY, STUB_B);
  if (copyDiffers) put(COPY + 15, [0x90]);
  put(THUNK, [0xe9, 0, 0, 0, 0]);
  rel(THUNK, 1, FN);
  for (const [stub, info] of [[STUB_A, 0x405000], [STUB_B, 0x405040]]) {
    put(stub, [0xb8, 0, 0, 0, 0, 0xe9, 0, 0, 0, 0]);
    text.writeUInt32LE(info, stub - 0x401000 + 1);
    rel(stub, 6, HANDLER);
  }
  put(CALLEE, [0xc3]);
  const pe = new PEImage(buildPe({
    sections: [{ name: '.text', rva: 0x1000, data: text }, { name: '.data', rva: 0x5000, data: Buffer.alloc(0x100), characteristics: 0xc0000040 }],
    baseRelocs: [FN + 6, COPY + 6, STUB_A + 1, STUB_B + 1],
  }));
  return { pe, target: { addr: FN, size: 17 }, COPY, THUNK, CALLEE };
}

test('a thunk or an EH-only copy of a named function reaches the same code', () => {
  const { pe, target, COPY, THUNK, CALLEE } = ehImage();
  assert.ok(sameTarget(pe, target, THUNK), 'jmp thunk to the function');
  assert.ok(sameTarget(pe, target, COPY), 'copy differing only in its EH FuncInfo');
  assert.ok(!sameTarget(pe, target, CALLEE), 'another function');
  assert.ok(!sameTarget(pe, target, COPY + 1), 'not a function start');
  const changed = ehImage({ copyDiffers: true });
  assert.ok(!sameTarget(changed.pe, changed.target, changed.COPY), 'a copy with other code');
});

// .idata at RVA 0x2000: one descriptor for sdk.dll whose IAT holds Foo twice and Bar once.
function importImage() {
  const idata = Buffer.alloc(0x100);
  const RVA = 0x2000, ILT = 0x40, IAT = 0x60, DLL = 0x80, FOO = 0x90, BAR = 0xa0;
  idata.writeUInt32LE(RVA + ILT, 0);
  idata.writeUInt32LE(RVA + DLL, 12);
  idata.writeUInt32LE(RVA + IAT, 16);
  [FOO, FOO, BAR].forEach((name, i) => {
    idata.writeUInt32LE(RVA + name, ILT + i * 4);
    idata.writeUInt32LE(RVA + name, IAT + i * 4);
  });
  idata.write('SDK.dll', DLL, 'latin1');
  idata.write('Foo', FOO + 2, 'latin1');
  idata.write('Bar', BAR + 2, 'latin1');
  const pe = new PEImage(buildPe({
    sections: [{ name: '.text', rva: 0x1000, data: Buffer.alloc(0x10, 0xc3) }, { name: '.idata', rva: RVA, data: idata, characteristics: 0x40000040 }],
    imports: { rva: RVA, size: 40 },
  }));
  const slot = (i) => 0x400000 + RVA + IAT + i * 4;
  return { pe, slot };
}

test('two import slots of the same DLL export are the same target', () => {
  const { pe, slot } = importImage();
  assert.equal(pe.imports().get(slot(0)), 'sdk.dll!Foo');
  assert.ok(sameTarget(pe, { addr: slot(0), size: 4 }, slot(1)), 'Foo imported twice');
  assert.ok(!sameTarget(pe, { addr: slot(0), size: 4 }, slot(2)), 'Foo is not Bar');
});

test('reconcile accepts a known name the original reaches through an equivalent copy', () => {
  const { pe, target, COPY } = ehImage();
  const syms = new Map([['fn_00009', { id: 'fn_00009', kind: 'function', ...target, decorated: '?Tidy@@YAXXZ' }]]);
  const check = { units: [{ bindings: {}, inferred: [{ symbol: '?Tidy@@YAXXZ', addr: COPY }], functions: [] }], annotationErrors: [] };
  assert.equal(reconcile(check, syms, pe).conflicts.length, 0);
  assert.equal(reconcile(check, syms).conflicts.length, 1, 'without the image it stays a conflict');
});

test('byte differences are reported with the instruction at that offset', () => {
  const { fn } = run({ objPatch: (b) => (b[13] = 0x90) });
  assert.equal(fn.status, STATUS.MISMATCH);
  assert.equal(fn.diffRegions.length, 1);
  assert.equal(fn.diffRegions[0].offset, 13);
  assert.equal(fn.diffRegions[0].ours, '90');
  assert.equal(fn.diffRegions[0].original, '5d');
  assert.match(fn.diffRegions[0].ourInstruction, /pop ebp/);
  assert.equal(fn.diffRegions[0].sourceLine, 8);
  assert.ok(fn.score > 0.9 && fn.score < 1);
});

test('size mismatches fall back to a similarity score', () => {
  const syms = symbols();
  syms.get('fn_00001').size = 20;
  const { fn } = run({ syms });
  assert.equal(fn.status, STATUS.MISMATCH);
  assert.ok(fn.score > 0.5 && fn.score < 1);
});

test('annotation with an ID that has no address in this version', () => {
  const syms = symbols();
  syms.get('fn_00001').addr = null;
  const { fn } = run({ syms });
  assert.equal(fn.status, STATUS.NO_ADDRESS);
});

// The optimizer may schedule code inlined from a header first: the listing then shows the
// header's line before the function's own. Where the function is defined comes from its debug info.
function inlinedHeaderFirst() {
  const listing = parseListing(
    [
      '; File z:\\job\\src\\player.cpp',
      '?Update@Player@@QAEXXZ PROC\t\t\t\t; Player::Update, COMDAT',
      '; File z:\\toolchain\\include\\xtree',
      '; 1597 :         _Tree_find_result<_Nodeptr> _Result{};',
      '  00000\t8b 49 04\t mov\t ecx, DWORD PTR [ecx+4]',
      '; File z:\\job\\src\\player.cpp',
      '; 5    : {',
      '  00003\tc3\t\t ret\t 0',
      '?Update@Player@@QAEXXZ ENDP\t\t\t\t; Player::Update',
      'END',
    ].join('\r\n'),
  );
  const { annotations } = parseAnnotations(fixture().source, FILE);
  return { listing, annotations };
}

test('an annotation binds to its function when inlined header code comes first', () => {
  const { listing, annotations } = inlinedHeaderFirst();
  const bind = (locations) => bindAnnotations({ listing, file: FILE, annotations, locations });
  assert.equal(bind(new Map()).byAnn.size, 0, 'the listing alone puts the function in xtree');
  const { byAnn, errors } = bind(new Map([['?Update@Player@@QAEXXZ', { file: 'z:\\job\\src\\player.cpp', line: 4 }]]));
  assert.deepEqual(errors, []);
  assert.deepEqual([...byAnn.values()], ['?Update@Player@@QAEXXZ']);
});

test('a function inlining code of the annotated file does not take its annotation', () => {
  const { listing, annotations } = inlinedHeaderFirst();
  // Defined in a header, it contains player.cpp's line 4 only through inlining.
  const { byAnn } = bindAnnotations({ listing, file: FILE, annotations, locations: new Map([['?Update@Player@@QAEXXZ', { file: 'z:\\job\\src\\player.h', line: 30 }]]) });
  assert.equal(byAnn.size, 0);
});

test('COFF reader takes each function\'s definition line from its CodeView line table', () => {
  const debug = buildDebugS([
    { symbolIndex: 1, file: 'z:\\job\\src\\player.cpp', lines: [[0, 4], [3, 6], [8, 7]] },
    { symbolIndex: 2, file: 'z:\\job\\src\\other.cpp', lines: [[0, 12]] },
  ]);
  const obj = new CoffObject(
    buildCoff({
      sections: [
        { name: '.text$mn', data: Buffer.alloc(16, 0xc3), characteristics: 0x60501020 },
        { name: '.debug$S', data: debug.data, relocs: debug.relocs, characteristics: 0x42100040 },
      ],
      symbols: [
        { name: '.text$mn', section: 1, storageClass: 3 },
        { name: '?Update@Player@@QAEXXZ', section: 1, type: 0x20, storageClass: 2 },
        { name: '?Other@@YAXXZ', section: 1, value: 8, type: 0x20, storageClass: 2 },
      ],
    }),
  );
  assert.deepEqual(Object.fromEntries(obj.functionLines()), {
    '?Update@Player@@QAEXXZ': { file: 'z:\\job\\src\\player.cpp', line: 4 },
    '?Other@@YAXXZ': { file: 'z:\\job\\src\\other.cpp', line: 12 },
  });
  assert.equal(new CoffObject(fixture().obj).functionLines().size, 0, 'no debug info, no locations');
});

test('lcsRatio', () => {
  assert.equal(lcsRatio(Buffer.from('abcd'), Buffer.from('abcd')), 1);
  assert.equal(lcsRatio(Buffer.from('abcd'), Buffer.from('abxd')), 0.75);
  assert.equal(lcsRatio(Buffer.alloc(0), Buffer.alloc(0)), 1);
});

// Every unit's s_ScriptFunctions is its own table: a file-local static is known by object and name.
test('a file-local static resolves by its unit, never by the bare name', () => {
  const f = fixture();
  const { annotations } = parseAnnotations(f.source, FILE);
  const obj = new CoffObject(f.obj);
  const real = obj.dataSymbols.bind(obj);
  obj.dataSymbols = () => [...real(), { name: '?g_val@@3HA', section: 2, storageClass: 3 }];
  const syms = symbols([{ id: 'gl_09999', kind: 'global', addr: 0x405000, size: 4, decorated: '?g_val@@3HA' }]);
  const compare = (nameIndex) =>
    compareObject({ obj, listing: parseListing(f.listing), file: FILE, annotations, symbols: syms, nameIndex, pe: new PEImage(f.pe) }).functions[0];
  // Another unit's static of the same name (at another address) does not make this one wrong.
  const other = compare(new Map([['?Callee@@YAXXZ', 'fn_00002'], ['?g_val@@3HA', 'gl_09999']]));
  assert.notEqual(other.status, STATUS.MISMATCH);
  const own = compare(new Map([['?Callee@@YAXXZ', 'fn_00002'], ['?g_val@@3HA', 'gl_09999'], ['src/player.obj|?g_val@@3HA', 'gl_00001']]));
  assert.equal(own.status, STATUS.EXACT);
});

test('sameOriginal: two copies of a function match when their calls reach the same target', () => {
  // Two 12-byte copies at 0x1000 and 0x1100: mov ecx, 1; call 0x2000; ret; nop; nop.
  const image = Buffer.alloc(0x200, 0xcc);
  const copy = (at, target) => {
    const off = at - 0x1000;
    image.set([0xb9, 1, 0, 0, 0, 0xe8], off);
    image.writeInt32LE(target - (at + 10), off + 6);
    image.set([0xc3, 0x90], off + 10);
  };
  copy(0x1000, 0x2000);
  copy(0x1100, 0x2000);
  copy(0x1180, 0x2040);
  const pe = { read: (va, len) => image.subarray(va - 0x1000, va - 0x1000 + len) };
  assert.equal(sameOriginal(pe, 0x1000, 0x1100, 12), true, 'same call target from two places');
  assert.equal(sameOriginal(pe, 0x1000, 0x1180, 12), false, 'calls another function');
  image[0x101] = 2; // mov ecx, 2
  assert.equal(sameOriginal(pe, 0x1000, 0x1100, 12), false, 'an immediate differs');
  assert.equal(sameOriginal(pe, 0x1000, 0x1100, 0), false, 'no size, no claim');
});

test('isDeletingDestructor tells scalar deleting destructors from plain ones', () => {
  const at = (hexBytes) => {
    const bytes = Buffer.from(hexBytes, 'hex');
    return { pe: { read: (va, len) => bytes.subarray(va - 0x1000, va - 0x1000 + len) }, size: bytes.length };
  };
  // CSurfaceDX9 at 0x5708F0: test [ebp+8], 1 / operator delete / retn 4.
  const deleting = at('558bec6aff689de2eb0064a100000000505156a1981b360133c5508d45f464a3000000008bf18975f0c70634d60d01c745fc000000008b4e1085c9740d8b0151ff5008c7461000000000c745fcffffffff8bcee8281a0000f6450801740b6a1456e829198f0083c4088bc68b4df464890d00000000595e8be55dc20400');
  assert.equal(isDeletingDestructor(deleting.pe, 0x1000, deleting.size), true);
  // ??1CFile@@UAE@XZ: a plain destructor (no flags argument).
  const plain = at('558bec6aff68c096eb0064a100000000505156a1981b360133c5508d45f464a3000000008bf18975f0c70604960d01c745fc00000000e8d5960500c745fcffffffff8d4e14e82676fdff8b4df464890d00000000595e8be55dc3');
  assert.equal(isDeletingDestructor(plain.pe, 0x1000, plain.size), false);
  assert.equal(isDeletingDestructor(deleting.pe, 0x1000, 0), false, 'unknown size');
});
