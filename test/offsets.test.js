import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offsetErrors } from '../src/shared/offsets.js';

const addresses = new Map([['fn_00001', 0x00ae97d0], ['fn_00002', 0x00ae9800], ['fn_00003', 0x00ae9900]]);
const addressOf = (id) => addresses.get(id) ?? null;
const lines = (errors) => errors.map((e) => e.line);

test('every FUNCTION line has its own OFFSET right above it, template stacks pair up', () => {
  const ok = `// OFFSET: 0x00AE97D0
// FUNCTION: fn_00001
void f() {}

template <class T>
// OFFSET: 0x00AE9800
// FUNCTION: fn_00002
// OFFSET: 0x00AE9900
// FUNCTION: fn_00003
void g() {}
`;
  assert.deepEqual(offsetErrors(ok, null, addressOf), []);
});

test('missing, stray, wrong and grouped OFFSET lines are rejected', () => {
  const src = `// FUNCTION: fn_00001
void a() {}

// OFFSET: 0x00AE97D0
void b() {}

// OFFSET: 0x00AE9900
// FUNCTION: fn_00002
void c() {}

// OFFSET: 0x00AE9800
// OFFSET: 0x00AE9900
// FUNCTION: fn_00002
// FUNCTION: fn_00003
void d() {}

// OFFSET: 0x00ae97d0
// FUNCTION: fn_00001
void e() {}
`;
  const errors = offsetErrors(src, null, addressOf);
  assert.deepEqual(lines(errors), [1, 4, 7, 11, 12, 14, 17, 17]);
  assert.match(errors[0].message, /needs "\/\/ OFFSET: 0x00AE97D0"/);
  assert.match(errors[1].message, /without its FUNCTION line/);
  assert.match(errors[2].message, /OFFSET 0x00AE9900 is not the address of fn_00002 \(0x00AE9800/);
  assert.match(errors[6].message, /upper-case/);
});

test('a blank line inside a block is rejected, before the block it is not', () => {
  assert.deepEqual(lines(offsetErrors('\n\n// OFFSET: 0x00AE97D0\n// FUNCTION: fn_00001\nvoid f() {}\n', null, addressOf)), []);
  assert.deepEqual(lines(offsetErrors('// OFFSET: 0x00AE97D0\n\n// FUNCTION: fn_00001\nvoid f() {}\n', null, addressOf)), [2]);
  assert.deepEqual(lines(offsetErrors('// OFFSET: 0x00AE97D0\n// FUNCTION: fn_00001\n\nvoid f() {}\n', null, addressOf)), [3]);
});

test('only blocks a submission adds or changes are checked', () => {
  const legacy = '// FUNCTION: fn_00001\nvoid a() {}\n';
  assert.deepEqual(offsetErrors(`${legacy}\nint x;\n`, legacy, addressOf), [], 'kept as it is on main');
  assert.equal(offsetErrors(`${legacy}\n// FUNCTION: fn_00002\nvoid b() {}\n`, legacy, addressOf).length, 1, 'a new block');
  assert.equal(offsetErrors(`${legacy}${legacy}`, legacy, addressOf).length, 1, 'a second copy is new');
  assert.equal(offsetErrors('// FUNCTION: fn_00001\nvoid renamed() {}\n', legacy, addressOf).length, 1, 'a block whose target changed');
});
