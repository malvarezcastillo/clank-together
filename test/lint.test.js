import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnnotations, lintAnnotations, declaredName } from '../src/shared/annotations.js';
import { lintSubmission, lintPreprocessed, normalizeRepoPath, globToRegExp } from '../src/shared/lint.js';

test('annotations bind to the next code line and use stable IDs', () => {
  const src = ['// FUNCTION: fn_00012', '// comment', '', 'void Foo::Bar()', '{', '}', '// GLOBAL: gl_00003', 'static int g_count = 0;', '// SIZE: 0x24', '// VTABLE: vt_00001', 'class Foo {'].join('\n');
  const { annotations, errors } = parseAnnotations(src, 'src/foo.cpp');
  assert.deepEqual(errors, []);
  assert.deepEqual(annotations.map((a) => [a.kind, a.id ?? a.size, a.targetLine]), [['FUNCTION', 'fn_00012', 4], ['GLOBAL', 'gl_00003', 8], ['SIZE', 0x24, 11], ['VTABLE', 'vt_00001', 11]]);
  assert.equal(annotations[1].name, 'g_count');
});

test('addresses in annotations are rejected', () => {
  const { errors } = parseAnnotations('// FUNCTION: GAME 0x401000\nvoid f() {}\n', 'a.cpp');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /symbol ID, not an address/);
});

test('wrong prefix and typos are reported', () => {
  assert.equal(parseAnnotations('// GLOBAL: fn_00001\nint x;\n').errors.length, 1);
  assert.equal(parseAnnotations('// Function: fn_00001\nvoid f();\n').errors.length, 1);
  assert.equal(parseAnnotations('// FUNCTION: fn_00001\n').errors.length, 1);
});

test('annotation lint: folded functions allowed, duplicate data warned, unknown IDs and library code rejected', () => {
  const src = '// FUNCTION: fn_00001\nvoid a(){}\n// FUNCTION: fn_00001\nvoid b(){}\n// FUNCTION: fn_00002\nvoid c(){}\n// FUNCTION: fn_00009\nvoid d(){}\n// GLOBAL: gl_00001\nint x;\n// GLOBAL: gl_00001\nint y;\n';
  const { annotations } = parseAnnotations(src, 'x.cpp');
  const syms = new Map([['fn_00001', { kind: 'function' }], ['fn_00002', { kind: 'function', library: true }], ['gl_00001', { kind: 'global' }]]);
  const res = lintAnnotations(annotations, syms);
  const errors = res.filter((e) => e.severity !== 'warning').map((e) => e.message);
  const warnings = res.filter((e) => e.severity === 'warning').map((e) => e.message);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((m) => m.includes('library')));
  assert.ok(errors.some((m) => m.includes('fn_00009')));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /gl_00001 is also annotated/);
});

test('annotation details and stacking', () => {
  const { annotations } = parseAnnotations('// FUNCTION: fn_00010 <CAnimKitInst>\n// FUNCTION: fn_00011 <int, float>\ntemplate <class T> void f() {}\n', 'x.h');
  assert.deepEqual(annotations.map((a) => [a.id, a.detail, a.targetLine]), [['fn_00010', '<CAnimKitInst>', 3], ['fn_00011', '<int, float>', 3]]);
});

test('declaredName', () => {
  assert.equal(declaredName('static int g_count = 0;'), 'g_count');
  assert.equal(declaredName('const char* Foo::s_names[4] = {'), 'Foo::s_names');
  assert.equal(declaredName('MyType g_obj;'), 'g_obj');
});

test('repo paths are normalized strictly', () => {
  assert.equal(normalizeRepoPath('src/a.cpp'), 'src/a.cpp');
  for (const bad of ['../x.cpp', '/etc/passwd', 'src/../../x', 'C:/x.cpp', 'src\\a.cpp', 'src/.hidden.cpp', 'src//a.cpp']) assert.equal(normalizeRepoPath(bad), null, bad);
});

test('globs', () => {
  assert.ok(globToRegExp('include/**').test('include/a/b.h'));
  assert.ok(globToRegExp('src/**').test('src/x.cpp'));
  assert.ok(!globToRegExp('src/*.cpp').test('src/a/x.cpp'));
});

const allowed = { allowedPaths: ['src/player.cpp', 'include/**'] };

test('clean submissions pass', () => {
  const errors = lintSubmission({ 'src/player.cpp': '#include "player.h"\n#pragma once\nint f() { return 1; }\n// __asm in a comment is fine\nconst char* s = "__asm";\n' }, allowed);
  assert.deepEqual(errors, []);
});

test('banned constructs and paths are rejected', () => {
  const cases = {
    'inline asm': 'void f() { __asm { int 3 } }',
    'short asm': 'void f() { _asm nop }',
    emit: 'void f() { __emit 0x90; }',
    'pragma comment': '#pragma comment(linker, "/foo")',
    'code_seg': '#pragma code_seg(".text")',
    'unknown pragma': '#pragma bogus',
    'line directive': '#line 1 "x.cpp"',
    naked: '__declspec(naked) void f() {}',
    'absolute include': '#include "/etc/passwd"',
    'parent include': '#include "../../secret.h"',
    'macro include': '#include MACRO',
    '__pragma': '__pragma(code_seg(".x")) void f(){}',
  };
  for (const [name, code] of Object.entries(cases)) {
    assert.ok(lintSubmission({ 'src/player.cpp': code }, allowed).length > 0, name);
  }
  assert.ok(lintSubmission({ 'src/other.cpp': 'int x;' }, allowed).length > 0, 'path outside task');
  assert.ok(lintSubmission({ 'src/player.txt': 'int x;' }, { allowedPaths: ['src/**'] }).length > 0, 'extension');
  assert.ok(lintSubmission({}, allowed).length > 0, 'empty');
});

test('large numeric initializers are rejected', () => {
  const blob = 'unsigned char code[] = {' + Array.from({ length: 300 }, (_, i) => `0x${(i & 0xff).toString(16)}`).join(',') + '};';
  assert.ok(lintSubmission({ 'src/player.cpp': blob }, allowed).some((e) => e.message.includes('initializer')));
});

test('single files have no size limit; only what a submission adds beyond main counts', () => {
  const big = (kb) => 'int x;\n'.repeat(Math.ceil((kb * 1024) / 7));
  const tooLarge = (files, sizes) => lintSubmission(files, { ...allowed, baseSize: (f) => sizes[f] ?? null }).filter((e) => /too large/.test(e.message));
  assert.equal(tooLarge({ 'src/unit.cpp': big(300) }, {}).length, 0, 'a new 300 KB file');
  assert.equal(tooLarge({ 'src/unit.cpp': big(1000) }, { 'src/unit.cpp': 800 * 1024 }).length, 0, 'grows by 200 KB');
  assert.equal(tooLarge({ 'src/unit.cpp': big(1300) }, { 'src/unit.cpp': 200 * 1024 }).length, 1, 'adds more than maxTotalBytes');
  assert.equal(tooLarge({ 'src/unit.cpp': big(800), 'src/player.cpp': big(500) }, { 'src/unit.cpp': 800 * 1024, 'src/player.cpp': 500 * 1024 }).length, 0, 'two big files count only what they add');
});

test('a moved file counts against the file it replaces, not as new bytes', () => {
  const big = (kb) => 'int x;\n'.repeat(Math.ceil((kb * 1024) / 7));
  const opts = (sizes) => ({ ...allowed, allowDeletions: true, trackedPaths: Object.keys(sizes), baseSize: (f) => sizes[f] ?? null });
  const tooLarge = (files, sizes) => lintSubmission(files, opts(sizes)).filter((e) => /too large/.test(e.message));
  assert.equal(tooLarge({ 'src/a/unit.cpp': big(1300), 'src/unit.cpp': null }, { 'src/unit.cpp': 1300 * 1024 }).length, 0, 'moved, same size');
  assert.equal(tooLarge({ 'src/a/unit.cpp': big(1300), 'src/other.cpp': null }, { 'src/other.cpp': 1300 * 1024 }).length, 1, 'a different name is new code');
  assert.equal(tooLarge({ 'src/a/unit.cpp': big(1300), 'src/b/unit.cpp': null, 'src/c/unit.cpp': null }, { 'src/b/unit.cpp': 1300 * 1024, 'src/c/unit.cpp': 1300 * 1024 }).length, 1, 'ambiguous source counts as new');
});

test('preprocessed output catches asm hidden behind macros, ignoring compiler headers', () => {
  const pre = ['#line 1 "C:\\\\vc\\\\include\\\\intrin.h"', 'void sys() { __asm int 3 }', '#line 1 "z:\\\\job\\\\src\\\\player.cpp"', 'void f() { __asm { nop } }'].join('\n');
  const errors = lintPreprocessed(pre, (f) => f.includes('/src/'));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /inline assembly/);
  assert.match(errors[0].file, /player\.cpp/);
});

test('paths that differ from main or each other only by letter case are rejected', () => {
  const opts = { allowedPaths: ['src/**'], trackedPaths: ['src/Utility/MD5.cpp', 'src/Utility/MD5.h'] };
  const clash = lintSubmission({ 'src/Utility/Md5.cpp': 'int x;\n' }, opts);
  assert.equal(clash.length, 1);
  assert.match(clash[0].message, /only by letter case from src\/Utility\/MD5\.cpp/);
  assert.deepEqual(lintSubmission({ 'src/Utility/MD5.cpp': 'int x;\n' }, opts), [], 'the tracked spelling itself is fine');
  assert.deepEqual(lintSubmission({ 'src/Utility/Md5State.cpp': 'int x;\n' }, opts), [], 'a distinct name is fine');
  const twins = lintSubmission({ 'src/a/Foo.cpp': 'int x;\n', 'src/a/foo.cpp': 'int y;\n' }, { allowedPaths: ['src/**'] });
  assert.equal(twins.length, 1);
  assert.match(twins[0].message, /in the same submission/);
});
