import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, FN_ADDR, CALLEE_ADDR, GLOBAL_ADDR } from './helpers.js';
import { PEImage } from '../src/shared/pe.js';
import { CoffObject } from '../src/shared/coff.js';
import { parseListing } from '../src/shared/listing.js';
import { parseAnnotations, lintAnnotations } from '../src/shared/annotations.js';
import { compareObject, STATUS } from '../src/shared/compare.js';
import { foldedErrors } from '../src/shared/folded.js';

const FILE = 'src/player.cpp';
const symbols = new Map(
  [
    { id: 'fn_00001', kind: 'function', addr: FN_ADDR, size: 15 },
    { id: 'fn_00002', kind: 'function', addr: CALLEE_ADDR, size: 1 },
    { id: 'gl_00001', kind: 'global', addr: GLOBAL_ADDR, size: 4 },
  ].map((s) => [s.id, s]),
);
const nameIndex = new Map([['?Callee@@YAXXZ', 'fn_00002'], ['?g_val@@3HA', 'gl_00001']]);

// The fixture's definition annotated FOLDED instead of FUNCTION: the same compiled code, claimed to
// be folded into fn_00001 (which another definition carries as its FUNCTION).
function foldedUnit({ objPatch } = {}) {
  const f = fixture({ objPatch });
  const source = f.source.replace('// FUNCTION: fn_00001', '// FOLDED: fn_00001');
  const { annotations, errors } = parseAnnotations(source, FILE);
  const unit = compareObject({ obj: new CoffObject(f.obj), listing: parseListing(f.listing), file: FILE, annotations, symbols, nameIndex, pe: new PEImage(f.pe) });
  return { unit, annotations, errors };
}

test('FOLDED parses as a function annotation of its ID', () => {
  const { annotations, errors } = foldedUnit();
  assert.deepEqual(errors, []);
  assert.deepEqual(annotations.map((a) => [a.kind, a.id]), [['FOLDED', 'fn_00001']]);
  assert.deepEqual(lintAnnotations(annotations, symbols), []);
  assert.equal(lintAnnotations(parseAnnotations('// FOLDED: fn_99999\nvoid f() {\n}\n', FILE).annotations, symbols).length, 1, 'an ID the database lacks');
  assert.equal(parseAnnotations('// FOLDED: gl_00001\nvoid f() {\n}\n', FILE).errors.length, 1, 'not a function ID');
});

test('a FOLDED definition that compiles to the code at its ID is proven, and never stands for the ID', () => {
  const { unit } = foldedUnit();
  assert.deepEqual(unit.functions, [], 'not a result of fn_00001');
  assert.equal(unit.folded.length, 1);
  assert.equal(unit.folded[0].status, STATUS.EXACT);
  assert.ok(!Object.keys(unit.bindings).includes('?Update@Player@@QAEXXZ'), 'its decorated name is not bound to fn_00001');
  assert.deepEqual(foldedErrors({ units: [unit] }, new Set([FILE])), []);
});

test('a FOLDED definition whose code differs from its ID is refused', () => {
  const { unit } = foldedUnit({ objPatch: (b) => (b[13] = 0x90) });
  assert.equal(unit.folded[0].status, STATUS.MISMATCH);
  const errors = foldedErrors({ units: [unit] }, new Set([FILE]));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, FILE);
  assert.match(errors[0].message, /compiles to different code/);
  assert.deepEqual(foldedErrors({ units: [unit] }, new Set(['src/other.cpp'])), [], 'only the submitted files are judged');
});

test('a FOLDED definition compiled in several units is proven by any matching copy', () => {
  const good = foldedUnit().unit;
  const bad = foldedUnit({ objPatch: (b) => (b[13] = 0x90) }).unit;
  assert.deepEqual(foldedErrors({ units: [bad, good] }, new Set([FILE])), []);
});
