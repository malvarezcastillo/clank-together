import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newVariables, scanVariables, definesVariable, globalViolations } from '../src/server/globals.js';

const rules = (files, options = {}) => globalViolations(files, options).map((e) => `${e.name}:${e.rule}`).sort();

test('an extern needs a definition, not a symbol-table entry, another extern, or a local namesake', () => {
  assert.deepEqual(rules({ 'a.h': 'extern int g_lost;' }, { known: () => true }), ['g_lost:undefined-extern']);
  assert.deepEqual(rules({ 'a.h': 'extern int g_lost;' }, { repository: { 'b.h': 'extern int g_lost;', 'b.cpp': 'void f() { int g_lost; }' } }), ['g_lost:undefined-extern']);
  assert.deepEqual(rules({ 'a.h': 'extern int g_owned;', 'a.cpp': '// GLOBAL: gl_00001\nint g_owned;' }), []);
  assert.deepEqual(rules({ 'a.h': 'extern int g_owned;' }, { repository: { 'a.cpp': '// GLOBAL: gl_00001\nint g_owned;' } }), []);
});

test('a static or differently scoped definition cannot satisfy an external declaration', () => {
  const repository = { 'a.cpp': 'static int count; namespace A { int value; }' };
  assert.deepEqual(rules({ 'a.h': 'extern int count; extern int value;' }, { repository }), ['count:undefined-extern', 'value:undefined-extern']);
  assert.deepEqual(rules({ 'a.h': 'namespace A { extern int value; }' }, { repository }), []);
  assert.equal(definesVariable('namespace A { int value; }', 'A::value'), true);
  assert.equal(definesVariable('namespace A { int value; }', 'value'), false);
});

test('local statics, namespace storage, class-static definitions and mutable pointers need IDs', () => {
  const text = [
    'int g_count;',
    '// GLOBAL: gl_00002',
    'int g_annotated = 0;',
    'constexpr int kLimit = 4;',
    'const int kMax = 16;',
    'const char* g_name = "x";',
    'namespace {',
    '  float s_scale;',
    '}',
    'class C {',
    '  int m_field;',
    '  static int s_shared;',
    '};',
    'int C::s_shared;',
    'void f() {',
    '  int local = 0;',
    '  static int s_calls;',
    '}',
  ].join('\n');
  assert.deepEqual(rules({ 'a.cpp': text }), ['C::s_shared:unannotated-global', 'f::s_calls:unannotated-global', 'g_count:unannotated-global', 'g_name:unannotated-global', 's_scale:unannotated-global']);
  assert.deepEqual(newVariables(text, null).filter((v) => v.member).map((v) => v.name), ['C::s_shared']);
});

test('multiline tables and function-pointer declarations are checked', () => {
  const declarations = 'extern int\n  (WSAAPI* g_receive)(int, char*, int, int);\nextern const int values[2];';
  assert.deepEqual(rules({ 'a.h': declarations }), ['g_receive:undefined-extern', 'values:undefined-extern']);
  const definitions = '// GLOBAL: gl_00003\nint(WSAAPI* g_receive)(int, char*, int, int);\n// GLOBAL: gl_00004\nconst int values[2] = {\n  1, 2\n};';
  assert.deepEqual(rules({ 'a.h': declarations, 'a.cpp': definitions }), []);
  assert.deepEqual(rules({ 'a.cpp': 'static int table[] = {\n  1, 2,\n};\n' }), ['table:unannotated-global']);
  assert.deepEqual(rules({ 'a.cpp': 'std::vector<int> values(16);' }), ['values:unannotated-global']);
});

test('annotations live on definitions and source units include the owner header', () => {
  const repository = { 'owner.cpp': 'int g_other;' };
  assert.deepEqual(rules({ 'a.h': '// GLOBAL: gl_00005\nextern int g_other;' }, { repository }), ['g_other:annotated-extern']);
  assert.deepEqual(rules({ 'a.cpp': 'extern int g_other;' }, { repository }), ['g_other:extern-in-unit']);
  assert.deepEqual(rules({ 'a.cpp': '// GLOBAL: gl_00005\nextern int g_other = 1;' }), [], 'extern with an initializer really is a definition');
  assert.deepEqual(rules({ 'a.h': 'extern __declspec(dllimport) int importedValue;' }), [], 'DLL imports intentionally have no project definition');
});

test('changed annotations and removed definitions are checked; unrelated legacy code is unchanged', () => {
  const base = { 'a.h': 'extern int g_value;', 'a.cpp': '// GLOBAL: gl_00006\nint g_value;' };
  const opts = { before: (f) => base[f] ?? null, repository: base };
  assert.deepEqual(rules({ 'a.cpp': '' }, opts), ['g_value:undefined-extern']);
  assert.deepEqual(rules({ 'a.cpp': 'int g_value;' }, opts), ['g_value:unannotated-global']);
  assert.deepEqual(rules({ 'a.h': '// GLOBAL: gl_00006\nextern int g_value;' }, opts), ['g_value:annotated-extern']);
  assert.deepEqual(rules({ 'a.cpp': '', 'owner.cpp': base['a.cpp'] }, opts), [], 'moving a definition does not orphan its extern');
  assert.deepEqual(rules({ 'a.cpp': 'int legacy;\nvoid f() {}' }, { before: () => 'int legacy;' }), []);
});

test('comments, strings, prototypes and ordinary fields do not become globals', () => {
  const text = '// extern int fake;\nvoid f(int a);\nstruct C {\n int member;\n void f();\n};\nvoid g() { int x; const char* s = "extern int fake;"; }';
  assert.deepEqual(scanVariables(text), []);
  assert.deepEqual(rules({ 'a.cpp': '// STRING: st_00001\nconst char* message = "x";' }), []);
  assert.deepEqual(rules({ 'a.cpp': 'constexpr int table[2] = {1, 2};' }), ['table:unannotated-global'], 'constexpr arrays still occupy storage');
});

test('forward declarations, defaulted special members and default arguments are not variables', () => {
  const text = 'class LuaScript; struct World; union Storage;\nC::C() = default; C::~C() = default;\nvoid f(int x = 4);\nint C::operator()(int x) { return x; }\n';
  assert.deepEqual(scanVariables(text), []);
  assert.deepEqual(rules({ 'a.cpp': 'void f() { if (true) { static int visits; } }' }), ['f::visits:unannotated-global']);
});

test('annotation edits cannot be hidden by unchanged declaration text or whitespace', () => {
  const original = '// GLOBAL: gl_00001\nint g_count;';
  assert.deepEqual(rules({ 'a.cpp': 'int g_count;' }, { before: () => original }), ['g_count:unannotated-global']);
  assert.deepEqual(rules({ 'a.cpp': '// GLOBAL: gl_00001\n\n int\n g_count;' }, { before: () => original }), []);
});

test('an internal static annotated with its dynamic initializer needs no data ID; external storage still does', () => {
  const registration = '// OFFSET: 0x00494730\n// FUNCTION: fn_45545\nstatic bool s_registered = (Get()->Register(10014, Create), true);';
  assert.deepEqual(rules({ 'a.cpp': registration }), []);
  assert.deepEqual(rules({ 'a.cpp': '// FUNCTION: fn_45545\nbool g_registered = (Get()->Register(10014, Create), true);' }), ['g_registered:unannotated-global'], 'external linkage is addressable data');
  assert.deepEqual(rules({ 'a.cpp': 'static bool s_registered = (Get()->Register(10014, Create), true);' }), ['s_registered:unannotated-global']);
  assert.deepEqual(rules({ 'a.cpp': 'void f() {\n  // FUNCTION: fn_45545\n  static bool s_once = Init();\n}' }), ['f::s_once:unannotated-global'], 'a local static keeps a guard and storage');
});
