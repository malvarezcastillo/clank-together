import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newPrototypes, definesFunction, undefinedDeclarations } from '../src/server/undefined.js';

test('functions a submission declares but nobody defines are found', () => {
  const before = 'static void LoadAddOnMetadata(UIADDON* addon, const char* line) {\n}\n';
  const after = [
    'int32_t LocaleStringToIndex(const char* locale);',
    'int32_t LocaleIndexToClientLocale(int32_t index);',
    'void Helper(int a);',
    'void Known(int a);',
    'void Elsewhere(int a);',
    'static void LoadAddOnMetadata(UIADDON* addon, const char* line) {',
    '    return Compute(addon);',
    '    x = Other(1);',
    '    ScopedGuard resultGuard(addon);',
    '    std::vector<int> timeslots(16);',
    '}',
    'static const CImVector s_shipMarkerColor(0xFF, 0xFF, 0xFF, 0xFF);',
    'class Widget {',
    '    void Member(int a);',
    '    virtual std::size_t BlockSize() const = 0;',
    '    virtual void SetKey(int key) = 0;',
    '};',
    'void Helper(int a) {',
    '}',
  ].join('\n');
  assert.deepEqual(newPrototypes(after, before).sort(), ['Elsewhere', 'Helper', 'Known', 'LocaleIndexToClientLocale', 'LocaleStringToIndex', 'Member'], 'locals constructed with arguments are not prototypes');
  assert.ok(definesFunction(after, 'Helper'));
  assert.ok(!definesFunction(after, 'LocaleStringToIndex'));
  const missing = undefinedDeclarations({ 'a.cpp': after }, { before: () => before, known: (n) => n === 'Known', existsElsewhere: (n) => n === 'Elsewhere' });
  assert.deepEqual(missing.sort(), ['LocaleIndexToClientLocale', 'LocaleStringToIndex', 'Member']);
  assert.deepEqual(undefinedDeclarations({ 'a.cpp': before }, { before: () => before, known: () => false, existsElsewhere: () => false }), [], 'nothing new, nothing to report');
});
