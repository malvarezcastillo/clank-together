import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, FN_ADDR, CALLEE_ADDR, GLOBAL_ADDR } from './helpers.js';
import { PEImage } from '../src/shared/pe.js';
import { CoffObject } from '../src/shared/coff.js';
import { parseListing } from '../src/shared/listing.js';
import { parseAnnotations } from '../src/shared/annotations.js';
import { compareObject, STATUS, lcsRatio } from '../src/shared/compare.js';
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

function run({ objPatch, nameIndex = new Map(), syms = symbols() } = {}) {
  const f = fixture({ objPatch });
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

test('lcsRatio', () => {
  assert.equal(lcsRatio(Buffer.from('abcd'), Buffer.from('abcd')), 1);
  assert.equal(lcsRatio(Buffer.from('abcd'), Buffer.from('abxd')), 0.75);
  assert.equal(lcsRatio(Buffer.alloc(0), Buffer.alloc(0)), 1);
});
