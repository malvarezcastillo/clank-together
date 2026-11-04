import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lttb } from '../src/server/downsample.js';

test('lttb keeps the budget, both ends and a lone spike', () => {
  const pts = Array.from({ length: 5000 }, (_, i) => [i, 0.4 + i * 1e-5]);
  pts[2500] = [2500, 0.9];
  const out = lttb(pts, 200);
  assert.equal(out.length, 200);
  assert.deepEqual(out[0], pts[0]);
  assert.deepEqual(out[199], pts[4999]);
  assert.ok(out.some((p) => p[1] === 0.9), 'the spike survives');
  for (let i = 1; i < out.length; i++) assert.ok(out[i][0] > out[i - 1][0], 'x stays ordered');
});

test('lttb leaves short series alone', () => {
  const pts = [[1, 0.1], [2, 0.2], [3, 0.3]];
  assert.deepEqual(lttb(pts, 400), pts);
});
