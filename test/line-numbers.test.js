import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListing } from '../src/shared/listing.js';
import { codeHash } from '../src/shared/compare.js';

// A listing of one function: `mov eax, N` (b8 NN 00 00 00) followed by ret, from source line `line`.
const listing = (line, code, value) => `; File c:\\job\\src\\f.cpp
?f@@YAHXZ PROC
; ${line}  : ${code}
  00000\tb8 ${value.toString(16).padStart(2, '0')} 00 00 00\t mov eax, ${value}
  00005\tc3\t ret 0
?f@@YAHXZ ENDP
`;
const bytes = (value) => Buffer.from([0xb8, value, 0, 0, 0, 0xc3]);
const hashAt = (line, code, value) => codeHash(bytes(value), parseListing(listing(line, code, value)).procs[0]);

test('the listing records which source lines spell __LINE__', () => {
  assert.equal(parseListing(listing(5, 'return 5;', 5)).procs[0].insns[0].lineMacro, false);
  assert.equal(parseListing(listing(42, 'return Log(__FILE__, __LINE__);', 42)).procs[0].insns[0].lineMacro, true);
  assert.equal(parseListing(listing(42, 'return MY__LINE__X;', 42)).procs[0].insns[0].lineMacro, false, 'a longer identifier is not __LINE__');
});

test('a constant that equals its line number is code: moving the function does not hide or reveal it', () => {
  // `return 5;` on line 5 and on line 6 is the same code; before, line 5 masked the 5.
  assert.equal(hashAt(5, 'return 5;', 5), hashAt(6, 'return 5;', 5));
  assert.notEqual(hashAt(5, 'return 5;', 5), hashAt(5, 'return 7;', 7), 'a different constant is different code');
});

test('a __LINE__ argument is masked: the same call on another line is the same code', () => {
  assert.equal(hashAt(42, 'return Log(__LINE__);', 42), hashAt(43, 'return Log(__LINE__);', 43));
});
