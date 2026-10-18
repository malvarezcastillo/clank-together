import { test } from 'node:test';
import assert from 'node:assert/strict';
import { className } from '../src/server/grouping.js';

test('className takes the part before the last top-level ::', () => {
  assert.equal(className('CGUnit_C::UpdateDisplayInfo'), 'CGUnit_C');
  assert.equal(className('Ns::Cls::Method'), 'Ns::Cls');
  assert.equal(className('TSHashTable<UncachableNode,HASHKEY_STRI>::TSHashTable<UncachableNode,HASHKEY_STRI>'), 'TSHashTable<UncachableNode,HASHKEY_STRI>');
  assert.equal(className('Foo<std::pair<int,int>>::Bar'), 'Foo<std::pair<int,int>>');
  assert.equal(className('FreeFunction'), null);
  assert.equal(className(null), null);
});
