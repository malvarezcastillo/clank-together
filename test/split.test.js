import { test } from 'node:test';
import assert from 'node:assert/strict';
import { functionRegions, withoutFunctions } from '../src/server/split.js';

const file = `#include "a.h"

// FUNCTION: fn_00001
int a() {
  const char* s = "}";
  return 1; // }
}

// FUNCTION: fn_00002
// FUNCTION: fn_00003
int folded() { /* { */ return 2; }

// FUNCTION: fn_00004
int b() {
  return 4;
}
`;

test('function regions run from the annotations to the closing brace', () => {
  const r = functionRegions(file);
  assert.deepEqual([r.get('fn_00001').start, r.get('fn_00001').end], [2, 7]);
  assert.equal(r.get('fn_00002'), r.get('fn_00003'));
  assert.deepEqual([r.get('fn_00004').start, r.get('fn_00004').end], [12, 16]);
});

test('withoutFunctions restores pending functions from the base, or drops new ones', () => {
  const base = file.replace('return 4;', 'return 0; // old');
  const out = withoutFunctions({ 'a.cpp': file }, ['fn_00004'], () => base);
  assert.equal(out['a.cpp'], base);
  const dropped = withoutFunctions({ 'a.cpp': file }, ['fn_00004'], () => null);
  assert.doesNotMatch(dropped['a.cpp'], /int b\(\)/);
  assert.match(dropped['a.cpp'], /int folded\(\)/);
  // One definition shared by a pending and a finished function can't be split.
  assert.equal(withoutFunctions({ 'a.cpp': file }, ['fn_00002'], () => null), null);
});

test('an annotated declaration is a region of its own instead of stopping the split', () => {
  const text = '// STUB: fn_00010\nvoid declared(int a);\n\n// FUNCTION: fn_00011\nint defined() {\n  return 1;\n}\n';
  const r = functionRegions(text);
  assert.deepEqual([r.get('fn_00010').start, r.get('fn_00010').end], [0, 2]);
  assert.deepEqual([r.get('fn_00011').start, r.get('fn_00011').end], [3, 7]);
  const out = withoutFunctions({ 'a.cpp': text }, ['fn_00011'], () => null);
  assert.equal(out['a.cpp'], '// STUB: fn_00010\nvoid declared(int a);\n\n');
});
