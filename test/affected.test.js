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
  // A re-signatured plain declaration only affects units that name the function (GetRect).
  for (const n of ['Foo', 'm_new', 'Bar', 'GetRect']) assert.ok(names.has(n), `expected ${n}`);
  for (const n of ['rect', 'count', 'Engine', 'Other', 'x16', 'BuildServer', 'WoW', 'T', 'the']) assert.ok(!names.has(n), `did not expect ${n}`);
  assert.deepEqual(changedNames('a\r\nb\r\n', 'a\nb\n'), [], 'line endings alone change nothing');
});

test('plain function declarations name only the function; layout and special members name the type', () => {
  const base = ['class CGameMode {', 'public:', '  int m_count;', '  void Existing();', '};'];
  const withLine = (line) => [...base.slice(0, 4), line, ...base.slice(4)].join('\n');
  const of = (line, isVirtual = () => false) => new Set(changedNames(base.join('\n'), withLine(line), { isVirtual }));
  for (const line of ['  void DrawTimeAttackTimer();', '  static int CountOf(CItem* item) const;', '  std::vector<int> FindByItemId(int itemId, unsigned char identified);']) {
    const names = of(line);
    assert.ok(!names.has('CGameMode'), `${line} does not touch the layout`);
    assert.equal(names.size, 1, `${line} names only its function`);
  }
  for (const line of ['  virtual void Draw();', '  void Slot15(int w, int h) override;', '  CGameMode(int mode);', '  ~CGameMode();', '  int m_extra;',
    '  void Inline() { m_count++; }', '  bool operator==(const CGameMode& o) const;', '  template <class T> void Each(T fn);', '  friend void Peek(CGameMode&);']) {
    assert.ok(of(line).has('CGameMode'), `${line} touches the type`);
  }
  assert.deepEqual(changedNames('void Old(int a);\n', 'void Old(int a, CRect b);\n'), ['Old'], 'a re-signatured free declaration names the function');
  assert.ok(of('  void Draw();', (n) => n === 'Draw').has('CGameMode'), 'a name declared virtual elsewhere may implicitly override');
  assert.ok(new Set(changedNames(base.join('\n'), withLine('  void DrawTimeAttackTimer();'))).has('CGameMode'), 'without virtual-name evidence, member declarations stay conservative');
});

test('namespace-scope forward declarations name only the declared type', () => {
  const base = 'struct Old;\nclass CGameMode {\n  int m_count;\n};\n';
  for (const fwd of ['struct vector3d;', 'class CItem;', 'enum class EMode : int;']) {
    const name = /(\w+)\s*(?::[^;]*)?;$/.exec(fwd)[1];
    assert.deepEqual(changedNames(base, `${fwd}\n${base}`), [name], fwd);
  }
  assert.ok(changedNames(base, base.replace('  int m_count;', '  struct Nested;\n  int m_count;')).includes('CGameMode'), 'a nested forward declaration names its enclosing type');
  assert.ok(changedNames(base, base.replace('struct Old;', 'struct Old { int x; };')).includes('Old'), 'a definition is not a forward declaration');
});
