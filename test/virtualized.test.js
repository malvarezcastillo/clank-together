import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedComment } from '../src/shared/freetext.js';
import { virtualizedMarker, isVirtualizedStub } from '../src/server/verify.js';
import { buildCoff, buildPe } from './helpers.js';
import { PEImage } from '../src/shared/pe.js';
import { CoffObject } from '../src/shared/coff.js';
import { compareFunction, STATUS } from '../src/shared/compare.js';
import { markedRegions } from '../src/shared/protector.js';
import { lintSubmission, lintPreprocessed } from '../src/shared/lint.js';

// An image with .text (file-backed) at 0x401000 and .vm (no file bytes) at 0x1000000.
function image(code) {
  const text = { rva: 0x1000, virtualSize: 0x1000, rawSize: 0x1000, bytes: Buffer.alloc(0x1000, 0xcc) };
  code.copy(text.bytes, 0);
  const vm = { rva: 0xc00000, virtualSize: 0x100000, rawSize: 0x200, bytes: Buffer.alloc(0x200) };
  const sections = [text, vm];
  const imageBase = 0x400000;
  const sectionForVa = (va) => sections.find((s) => va - imageBase >= s.rva && va - imageBase < s.rva + s.virtualSize);
  return {
    imageBase,
    sectionForVa,
    read(va, len) {
      const s = sectionForVa(va);
      if (!s) throw new Error('outside');
      const out = Buffer.alloc(len);
      s.bytes.copy(out, 0, va - imageBase - s.rva, va - imageBase - s.rva + len);
      return out;
    },
  };
}

function jmpTo(at, dest) {
  const b = Buffer.from([0x55, 0x8b, 0xec, 0x83, 0xec, 0x18, 0xe9, 0, 0, 0, 0]);
  b.writeInt32LE(dest - (at + 6 + 5), 7);
  return b;
}

test('the VIRTUALIZED marker is an allowed comment only in its exact form', () => {
  assert.ok(allowedComment('// VIRTUALIZED: 2025-06-04 0x0060C460'));
  assert.ok(allowedComment('// VIRTUALIZED: emulated 0x01A42000'));
  assert.ok(!allowedComment('// VIRTUALIZED: emulated'));
  assert.ok(!allowedComment('// VIRTUALIZED: emulated 0x01A42000 by hand'));
  assert.ok(!allowedComment('// VIRTUALIZED: 2025-06-04 0x0060C460 copied from the patched client'));
  assert.ok(!allowedComment('// VIRTUALIZED: june 0x0060C460'));
  assert.ok(!allowedComment('// VIRTUALIZED: 2025-06-04'));
});

test('the marker belongs to the FUNCTION it is annotated with', () => {
  const files = {
    'a.cpp': [
      '// OFFSET: 0x0065B380',
      '// FUNCTION: fn_05138',
      '// VIRTUALIZED: 2025-06-04 0x0060C460',
      'void A() {}',
      '',
      '// OFFSET: 0x0065B1B0',
      '// FUNCTION: fn_05136',
      'void B() {}',
    ].join('\n'),
  };
  assert.deepEqual(virtualizedMarker(files, 'fn_05138'), { build: '2025-06-04', addr: '0x0060C460' });
  assert.equal(virtualizedMarker(files, 'fn_05136'), null);
});

test('a stub that jumps into a section the file has no bytes for is virtualized', () => {
  const at = 0x401000;
  assert.ok(isVirtualizedStub(image(jmpTo(at, 0x1000800)), at, 17));
});

test('ordinary code is not: a jump within .text or into file-backed bytes', () => {
  const at = 0x401000;
  assert.ok(!isVirtualizedStub(image(jmpTo(at, 0x401400)), at, 17));
  assert.ok(!isVirtualizedStub(image(jmpTo(at, 0x1000010)), at, 17));
  assert.ok(!isVirtualizedStub(image(Buffer.from([0x55, 0x8b, 0xec, 0x5d, 0xc3])), at, 5));
});

// The SDK's marker: a jump over "WL  ", the macro's id, seven zero bytes and "WL  " again.
const marker = (id) => Buffer.from([0xeb, 0x10, 0x57, 0x4c, 0x20, 0x20, id, 0, 0, 0, 0, 0, 0, 0, 0x57, 0x4c, 0x20, 0x20]);
const VM = 0x0c;
const MUTATE = 0x10;
const UNPROTECTED = 0x20;
const NOPS = Buffer.alloc(18, 0x90);
const HEAD = Buffer.from([0x55, 0x8b, 0xec]); // push ebp; mov ebp, esp
const TAIL = Buffer.from([0x5d, 0xc3]); // pop ebp; ret
const BODY = Buffer.from([0xa1, 0, 0, 0, 0, 0x40, 0xa3, 0, 0, 0, 0]); // mov eax, [g]; inc eax; mov [g], eax

/**
 * A function with one protected region, as we compile it and as the protector left it at 0x401000.
 * `left` changes what the original holds; `id` is the macro our source uses.
 */
function protectedCase({ id = VM, originalId = id, body = BODY, bodyLength = body.length, dest = 0x1000800, tail = TAIL, origSize, noEnd = false } = {}) {
  const ours = Buffer.concat([HEAD, marker(id), body, marker(id + 1), TAIL]);
  const start = HEAD.length;
  const left = Buffer.alloc(18 + bodyLength + 18, 0x5a); // the protector's random bytes
  left[0] = 0xe9;
  left.writeInt32LE(dest - (0x401000 + start + 5), 1);
  if (originalId === MUTATE) marker(MUTATE).copy(left, 5, 5);
  if (!noEnd) for (let i = 0; i < 9; i++) Buffer.from([0x89, [0xc0, 0xc9, 0xd2, 0xdb, 0xe4, 0xed, 0xf6, 0xff][i % 8]]).copy(left, 18 + bodyLength + 2 * i);
  const text = Buffer.alloc(0x200, 0xcc);
  Buffer.concat([HEAD, left, tail]).copy(text);
  const pe = new PEImage(buildPe({
    sections: [{ name: '.text', rva: 0x1000, data: text }, { name: '.vm', rva: 0xc00000, data: Buffer.alloc(0x200), virtualSize: 0x100000 }],
    relocsStripped: true,
  }));
  const obj = new CoffObject(buildCoff({
    sections: [{ name: '.text$mn', data: ours, relocs: [{ offset: start + 18 + 1, symbolIndex: 1, type: 0x06 }, { offset: start + 18 + 7, symbolIndex: 1, type: 0x06 }] }],
    symbols: [{ name: '?Check@@YAHXZ', section: 1, type: 0x20 }, { name: '?g_seed@@3HA', section: 0 }],
  }));
  const syms = new Map([['gl_00007', { id: 'gl_00007', kind: 'global', addr: 0x403008, size: 4 }]]);
  const resolve = (name) => (name === '?g_seed@@3HA' ? 'gl_00007' : null);
  return { ours, start, result: compareFunction({ fn: obj.functions()[0], addr: 0x401000, origSize: origSize ?? HEAD.length + left.length + tail.length, pe, resolve, symbols: syms }) };
}

test('SDK markers in compiled code pair up into regions', () => {
  const code = Buffer.concat([HEAD, marker(VM), BODY, marker(VM + 1), marker(MUTATE), marker(MUTATE + 1), TAIL]);
  assert.deepEqual(markedRegions(code), { regions: [{ start: 3, end: 50, id: VM }, { start: 50, end: 86, id: MUTATE }], error: null });
  assert.deepEqual(markedRegions(Buffer.concat([HEAD, BODY, TAIL])), { regions: [], error: null });
  assert.match(markedRegions(Buffer.concat([HEAD, marker(VM), BODY, TAIL])).error, /has no END marker/);
  assert.match(markedRegions(Buffer.concat([HEAD, marker(VM + 1), TAIL])).error, /END marker \(id 0xd\) at \+0x3 without its START/);
  assert.match(markedRegions(Buffer.concat([marker(VM), BODY, marker(MUTATE + 1)])).error, /not closed by its END marker/);
  assert.match(markedRegions(Buffer.concat([marker(VM), marker(MUTATE), marker(MUTATE + 1), marker(VM + 1)])).error, /not closed by its END marker/, 'regions do not nest');
});

test('a function marked like the protected build is compared outside its regions', () => {
  const { result, start } = protectedCase();
  assert.equal(result.status, STATUS.EXACT);
  assert.deepEqual(result.protected, [{ offset: start, length: 18 + BODY.length + 18, id: VM }]);
  assert.equal(result.protectedError, undefined);
  assert.deepEqual(result.relocations, [], 'references inside the region have nothing to be judged by');

  // The code after the region is compared like any other.
  const epilogue = protectedCase({ tail: Buffer.from([0xc9, 0xc3]) }).result;
  assert.equal(epilogue.status, STATUS.MISMATCH);
  assert.deepEqual(epilogue.protected, result.protected);
  assert.deepEqual(epilogue.diffRegions.map((d) => d.offset), [start + 18 + BODY.length + 18]);

  // The database measures a wholly virtualized function up to the protector's jump.
  const truncated = protectedCase({ origSize: start + 5 }).result;
  assert.equal(truncated.status, STATUS.EXACT);
  assert.equal(truncated.size.original, truncated.size.ours);

  // A mutated region keeps the rest of its START marker, which names the macro.
  assert.equal(protectedCase({ id: MUTATE }).result.status, STATUS.EXACT);
});

test('markers the original has no such region for hide nothing', () => {
  const cases = {
    'a body of another length': [{ bodyLength: BODY.length + 2 }, /has no jump|is not 11 bytes long/],
    'no END left where ours has one': [{ noEnd: true }, /its body is not 11 bytes long/],
    'a jump that stays in the file': [{ dest: 0x401100 }, /does not leave for a section whose bytes the file lacks/],
    'a jump into bytes the file has': [{ dest: 0x1000010 }, /does not leave for a section whose bytes the file lacks/],
    'VM in our source, MUTATE in the original': [{ id: VM, originalId: MUTATE }, /marked with id 0xc, the original's with 0x10/],
    'MUTATE in our source, VM in the original': [{ id: MUTATE, originalId: VM }, /marked with id 0x10, the original's is not a mutated one/],
  };
  for (const [name, [options, why]] of Object.entries(cases)) {
    const { result } = protectedCase(options);
    assert.equal(result.status, STATUS.MISMATCH, name);
    assert.equal(result.protected, undefined, name);
    assert.match(result.protectedError, why, name);
  }
  // Nor do they change what the function is measured against.
  const stub = protectedCase({ origSize: HEAD.length + 5, noEnd: true }).result;
  assert.equal(stub.status, STATUS.MISMATCH);
  assert.equal(stub.size.original, HEAD.length + 5);
});

// An UNPROTECTED region as the protector leaves it: a jump to its end, the rest of START, junk, NOPs.
function removedCase({ id = UNPROTECTED, dest, end = NOPS, keptId = UNPROTECTED } = {}) {
  const ours = Buffer.concat([HEAD, marker(id), BODY, marker(id + 1), TAIL]);
  const start = HEAD.length;
  const length = 18 + BODY.length + 18;
  const left = Buffer.alloc(length, 0x5a);
  left[0] = 0xe9;
  left.writeInt32LE((dest ?? 0x401000 + start + length) - (0x401000 + start + 5), 1);
  marker(keptId).copy(left, 5, 5);
  end.copy(left, length - 18);
  const text = Buffer.alloc(0x200, 0xcc);
  Buffer.concat([HEAD, left, TAIL]).copy(text);
  const pe = new PEImage(buildPe({ sections: [{ name: '.text', rva: 0x1000, data: text }], relocsStripped: true }));
  const obj = new CoffObject(buildCoff({
    sections: [{ name: '.text$mn', data: ours, relocs: [{ offset: start + 18 + 1, symbolIndex: 1, type: 0x06 }, { offset: start + 18 + 7, symbolIndex: 1, type: 0x06 }] }],
    symbols: [{ name: '?Check@@YAHXZ', section: 1, type: 0x20 }, { name: '?g_seed@@3HA', section: 0 }],
  }));
  return { start, length, result: compareFunction({ fn: obj.functions()[0], addr: 0x401000, origSize: HEAD.length + length + TAIL.length, pe, resolve: () => null, symbols: new Map() }) };
}

test('a region the protector removed is skipped by a jump to its end', () => {
  const { result, start, length } = removedCase();
  assert.equal(result.protectedError, undefined);
  assert.deepEqual(result.protected, [{ offset: start, length, id: UNPROTECTED }]);
  assert.equal(result.status, STATUS.EXACT);

  const cases = {
    'a jump that lands elsewhere': [{ dest: 0x401000 + start + length + 2 }, /does not skip the region, which ends at/],
    'a jump out of the file, as for a virtualized region': [{ dest: 0x1000800 }, /does not skip the region/],
    'END not turned into NOPs': [{ end: Buffer.alloc(18, 0x5a) }, /its body is not 11 bytes long/],
    'another macro left in the original': [{ keptId: MUTATE }, /marked with id 0x20, the original's is not a removed one/],
    'VM in our source': [{ id: VM }, /does not leave for a section whose bytes the file lacks/],
  };
  for (const [name, [options, why]] of Object.entries(cases)) {
    const bad = removedCase(options).result;
    assert.equal(bad.status, STATUS.MISMATCH, name);
    assert.equal(bad.protected, undefined, name);
    assert.match(bad.protectedError, why, name);
  }
});

test('the code inside a region is part of what the function is', () => {
  // Same bounds, another body: the comparison cannot tell them apart, the hash must.
  const decrement = Buffer.from(BODY);
  decrement[5] = 0x48; // dec eax
  const plain = protectedCase().result;
  const changed = protectedCase({ body: decrement }).result;
  assert.equal(changed.status, STATUS.EXACT);
  assert.notEqual(plain.effectiveHash, changed.effectiveHash);
  assert.equal(plain.effectiveHash, protectedCase().result.effectiveHash);
});

const EMITS = (id) => [...marker(id)].map((b) => `__asm _emit 0x${b.toString(16).toUpperCase().padStart(2, '0')}`);

test('the SDK markers are the only inline assembly allowed', () => {
  const allowed = { allowedPaths: ['src/**'] };
  const macros = `#define VM_START \\\n  ${EMITS(VM).join(' \\\n  ')}\n#define VM_END \\\n  ${EMITS(VM + 1).join(' \\\n  ')}\n`;
  assert.deepEqual(lintSubmission({ 'src/protector.h': '#pragma once\n' + macros }, allowed), []);
  const expanded = ['#line 1 "z:\\\\job\\\\src\\\\check.cpp"', `int Check() { ${EMITS(VM).join(' ')} g_seed++; ${EMITS(VM + 1).join(' ')} return 0; }`].join('\n');
  assert.deepEqual(lintPreprocessed(expanded, (f) => f.includes('/src/')), []);

  const bad = {
    'one byte more': [...EMITS(VM), '__asm _emit 0xC3'],
    'one byte less': EMITS(VM).slice(0, 17),
    'another jump distance': EMITS(VM).map((e, i) => (i === 1 ? '__asm _emit 0x12' : e)),
    'bytes where the zeroes go': EMITS(VM).map((e, i) => (i === 9 ? '__asm _emit 0xC3' : e)),
    'an instruction among them': EMITS(VM).map((e, i) => (i === 17 ? '__asm int 3' : e)),
  };
  for (const [name, emits] of Object.entries(bad)) {
    const code = `void f() { ${emits.join(' ')} }`;
    assert.ok(lintSubmission({ 'src/check.cpp': code }, allowed).some((e) => /inline assembly|__emit/.test(e.message)), name);
    assert.ok(lintPreprocessed('#line 1 "z:\\\\job\\\\src\\\\check.cpp"\n' + code, (f) => f.includes('/src/')).length > 0, `${name}, after preprocessing`);
  }
});
