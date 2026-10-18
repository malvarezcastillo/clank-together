import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Verifier } from '../src/server/verify.js';

// A header's template copy that one unit stops emitting (or emits differently) is not a regression
// unless the header changed; a unit's own function is.
test('header-defined copies are not regressions while the header is unchanged', () => {
  const grep = 'HEAD:Engine/H/stpl.h:FUNCTION: fn_00002\nHEAD:Engine/H/stpl.h:FUNCTION: fn_00003\n';
  const v = Object.create(Verifier.prototype);
  v.repo = { git: () => grep };
  const found = [
    { id: 'fn_00001', file: 'Engine/A.cpp', was: 'exact', now: 'mismatch' },
    { id: 'fn_00002', file: 'Engine/A.cpp', was: 'exact', now: 'removed' },
    { id: 'fn_00003', file: 'Engine/A.cpp', was: 'exact', now: 'removed' },
    { id: 'fn_00004', file: 'Engine/A.cpp', was: 'exact', now: 'mismatch' },
  ];
  const results = new Map([
    ['fn_00001', { file: 'Engine/A.cpp' }],
    ['fn_00004', { file: 'Engine/H/other.h' }],
  ]);
  assert.deepEqual(v.withoutHeaderCopies(found, results, { 'Engine/A.cpp': '' }).map((r) => r.id), ['fn_00001']);

  // Header changed: a removed annotation counts, a still-annotated copy not compiled here does not.
  const header = '// FUNCTION: fn_00002 <A>\ntemplate<class T> void f() {}\n';
  const files = { 'Engine/A.cpp': '', 'Engine/H/stpl.h': header, 'Engine/H/other.h': '' };
  assert.deepEqual(v.withoutHeaderCopies(found, results, files).map((r) => r.id), ['fn_00001', 'fn_00003', 'fn_00004']);
});
