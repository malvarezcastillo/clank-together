import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unannotatedErrors } from '../src/shared/unannotated.js';

const lines = (errors) => errors.map((e) => e.line);

test('a definition needs FUNCTION, STUB or INLINED above it', () => {
  const src = `// OFFSET: 0x00AE97D0
// FUNCTION: fn_00001
void A::f() {
}

// INLINED
inline int g(int a) {
  return a;
}

// INLINED
template<class T>
T h(T a) {
  return a;
}

// OFFSET: 0x00AE9800
// FUNCTION: fn_00002
template<>
__declspec(noinline) Mode<int>::Mode() {
}

void A::lost(int a) {
}

__declspec(noinline) std::size_t A::alsoLost(std::span<const std::uint8_t> input) const {
  return 0;
}

A::A()
    : m_value(0) {
}
`;
  assert.deepEqual(lines(unannotatedErrors(src, null)), [23, 26, 30]);
});

test('declarations, calls, control flow and initializers are not definitions', () => {
  const src = `class A {
public:
  void f(int a);
  virtual bool g() const = 0;
};

void run() {
  if (ready()) {
    call(1, 2);
  }
  for (int i = 0; i < 3; ++i) {
  }
  auto fn = [](int a) {
    return a;
  };
  static_assert(sizeof(A) == 4);
}
`;
  assert.deepEqual(lines(unannotatedErrors(src, null)), [7]);
});

test('only definitions a submission adds or changes are checked', () => {
  const legacy = 'void A::old() {\n}\n';
  assert.deepEqual(unannotatedErrors(`${legacy}\nint x;\n`, legacy), [], 'kept as it is on main');
  assert.equal(unannotatedErrors(`${legacy}\nvoid A::added() {\n}\n`, legacy).length, 1, 'a new definition');
  const annotated = '// OFFSET: 0x00AE97D0\n// FUNCTION: fn_00001\nvoid A::f() {\n}\n';
  assert.equal(unannotatedErrors('void A::f() {\n}\n', annotated).length, 1, 'an annotation the submission removes');
});

test('a definition main has that is only renamed stays exempt; changing its signature does not', () => {
  const main = 'class A {\npublic:\n  virtual bool Slot00() {\n    return false;\n  }\n};\n';
  assert.deepEqual(unannotatedErrors(main.replace('Slot00', 'IsSupport'), main), [], 'renamed in place');
  assert.equal(unannotatedErrors(main.replace('bool Slot00()', 'int IsSupport(int x)'), main).length, 1, 'a different signature is a new definition');
  assert.equal(unannotatedErrors(`${main}class B {\n  virtual bool Other() {\n    return true;\n  }\n};\n`, main).length, 1, 'a second, new definition');
});

test('a FOLDED definition is an annotated definition', () => {
  const src = '// FOLDED: fn_18148\nbool ResourceName::operator<(const ResourceName& other) const {\n  return false;\n}\n';
  assert.deepEqual(unannotatedErrors(src, null), []);
});
