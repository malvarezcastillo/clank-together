import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintSubmission } from '../src/shared/lint.js';

const opts = { allowedPaths: ['Source/**'], unitPrelude: 'Source/Linkage' };
const decl = 'extern template std::string::basic_string(const std::string&);\n';
const messages = (errors) => errors.map((e) => `${e.file}:${e.line} ${e.message}`);

test('an extern template line a submission adds to game source is refused and names the prelude', () => {
  const errors = lintSubmission({ 'Source/Game/A.cpp': `#include <string>\n\n${decl}int a;\n` }, { ...opts, baseText: () => '#include <string>\n\nint a;\n' });
  assert.deepEqual(messages(errors), [
    'Source/Game/A.cpp:3 extern template declarations go in Source/Linkage/Source/Game/A.cpp.h, not in the game source; the build forces that file into the unit',
  ]);
});

test('lines main already has pass, so editing such a file is not held up; a second copy is still new', () => {
  const base = `${decl}int a;\n`;
  assert.deepEqual(lintSubmission({ 'Source/Game/A.cpp': `${decl}int a;\nint b;\n` }, { ...opts, baseText: () => base }), []);
  assert.equal(lintSubmission({ 'Source/Game/A.cpp': `${decl}${decl}int a;\n` }, { ...opts, baseText: () => base }).length, 1);
});

test('a multi-line declaration and one in a header are refused too; a commented-out one is not code', () => {
  const multi = 'extern template std::_Tree_find_result<int>\nTree::_Find_lower_bound<int>(const int&) const;\n';
  assert.equal(lintSubmission({ 'Source/Game/A.cpp': multi }, { ...opts, baseText: () => null }).length, 1);
  const header = lintSubmission({ 'Source/Game/A.h': decl }, { ...opts, baseText: () => null });
  assert.match(header[0].message, /linkage prelude \(Source\/Linkage\/<unit>\.h\) of each unit/);
  assert.deepEqual(lintSubmission({ 'Source/Game/A.cpp': `// ${decl}/* ${decl} */int a;\n` }, { ...opts, baseText: () => null }), []);
});

test('preludes may hold them, and projects without unitPrelude are unchanged', () => {
  assert.deepEqual(lintSubmission({ 'Source/Linkage/Source/Game/A.cpp.h': `#pragma once\n${decl}` }, { ...opts, baseText: () => null }), []);
  assert.deepEqual(lintSubmission({ 'Source/Game/A.cpp': decl }, { allowedPaths: ['Source/**'], baseText: () => null }), []);
});

test('an explicit instantiation definition (without extern) stays allowed in game source', () => {
  assert.deepEqual(lintSubmission({ 'Source/Game/A.cpp': 'template std::string::basic_string(const std::string&);\n' }, { ...opts, baseText: () => null }), []);
});
