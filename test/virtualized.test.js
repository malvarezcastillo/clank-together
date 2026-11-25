import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedComment } from '../src/shared/freetext.js';
import { virtualizedMarker, isVirtualizedStub } from '../src/server/verify.js';

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
