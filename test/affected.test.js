import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedNames } from '../src/server/affected.js';

test('a header change names what it touched, not parameters, paths, strings or hex', () => {
  const before = [
    '#include "Engine/Source/Base/Types.h"',
    'struct Foo {',
    '  int a;',
    '};',
    'template <class T> struct Bar { T x; };',
    'bool GetRect(CRect& rect);',
    '#define K 1',
  ].join('\n');
  const after = [
    '#include "Engine/Source/Base/Other.h"',
    'struct Foo {',
    '  int a;',
    '  int m_new; // 0x16 the new field',
    '};',
    'template <class T> struct Bar { T x; char pad[0x16]; };',
    'bool GetRect(CRect& rect, int count);',
    '#define K "d:\\BuildServer\\WoW"',
  ].join('\n');
  const names = new Set(changedNames(before, after));
  for (const n of ['Foo', 'm_new', 'Bar', 'GetRect', 'CRect']) assert.ok(names.has(n), `expected ${n}`);
  for (const n of ['rect', 'count', 'Engine', 'Other', 'x16', 'BuildServer', 'WoW', 'T', 'the']) assert.ok(!names.has(n), `did not expect ${n}`);
  assert.deepEqual(changedNames('a\r\nb\r\n', 'a\nb\n'), [], 'line endings alone change nothing');
});
