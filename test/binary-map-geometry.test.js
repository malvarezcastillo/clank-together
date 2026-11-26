import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

// Use the same standalone script as the browser without requiring a canvas or DOM.
const script = readFileSync(new URL('../src/server/web/binary-map-geometry.js', import.meta.url), 'utf8');
const geometry = runInNewContext(`${script}\nbinaryGeometry`);
const rows = [
  { id: 'a', addr: 0x100, weight: 2, gain: 0.25 },
  { id: 'b', addr: 0x200, weight: 1, gain: 1 },
  { id: 'c', addr: 0x400, weight: 1, gain: 0.8, excluded: true },
  { id: 'd', addr: 0x500, weight: 0, gain: 0 },
];
const group = { name: 'Placed', rows: rows.slice(0, 2) };

test('source atlas gives excluded code its original footprint, and zoom hit testing retains each function', () => {
  const map = geometry.source(rows, [{ node: group }], 400, 100, 'weight');
  for (const r of rows.slice(0, 3)) {
    const cell = map.rectFor(r.id);
    assert.ok(Math.abs(cell.w * cell.h - r.weight * 10000) < 1e-7);
    assert.equal(map.hit(cell.x + cell.w / 2, cell.y + cell.h / 2), r);
  }
  assert.equal(map.rectFor('d'), null);
  assert.equal(map.hit(400, 0), null);
  assert.equal(map.groups[0].node, group);
  assert.equal(map.groups[0].w * map.groups[0].h, 30000);
});

test('file hover encloses only the functions of the same full source path', () => {
  const a = 'render/shared.cpp', b = 'audio/shared.cpp';
  const fns = [a, b, a, null].map((unit, id) => ({ id, unit, weight: id + 1, gain: id === 0 ? 0 : 1 }));
  for (const weight of ['weight', 'gain']) {
    const map = geometry.source(fns, [{ node: { rows: fns } }], 180, 90, weight);
    for (const unit of [a, b]) {
      const rect = map.fileRectFor(unit);
      const members = fns.filter(f => f.unit === unit && f[weight] > 0);
      const fraction = members.reduce((n, f) => n + f[weight], 0) / fns.reduce((n, f) => n + f[weight], 0);
      assert.ok(Math.abs(rect.w * rect.h - 180 * 90 * fraction) < 1e-7);
      for (const f of members) {
        const cell = map.rectFor(f.id);
        assert.ok(cell.x >= rect.x && cell.y >= rect.y && cell.x + cell.w <= rect.x + rect.w + 1e-9 && cell.y + cell.h <= rect.y + rect.h + 1e-9);
      }
      for (const fx of [0.01, 0.5, 0.99]) for (const fy of [0.01, 0.5, 0.99]) {
        assert.equal(map.hit(rect.x + rect.w * fx, rect.y + rect.h * fy).unit, unit);
      }
    }
    assert.equal(map.fileRectFor(null), null);
    assert.equal(map.fileRectFor('absent.cpp'), null);
  }
});

test('packed-address atlas maps the full surface to real code, without a giant gap between addresses', () => {
  const map = geometry.address(rows, 128, 128, 'weight');
  const counts = new Map();
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const f = map.hit(x + 0.5, y + 0.5);
    assert.ok(f && rows.includes(f));
    counts.set(f.id, (counts.get(f.id) ?? 0) + 1);
    const box = map.rectFor(f.id);
    assert.ok(x + 0.5 >= box.x && x + 0.5 < box.x + box.w && y + 0.5 >= box.y && y + 0.5 < box.y + box.h);
  }
  for (const f of rows) assert.ok(Math.abs((counts.get(f.id) ?? 0) - f.weight * 4096) <= 1);
});

test('a label for a nonrectangular address interval never covers a neighboring function', () => {
  const irregular = [3, 5, 19, 7].map((weight, id) => ({ id, weight }));
  const map = geometry.address(irregular, 384, 256, 'weight');
  for (const row of irregular) {
    const r = map.labelRectFor(row.id);
    for (const fx of [0.01, 0.5, 0.99]) for (const fy of [0.01, 0.5, 0.99]) {
      assert.equal(map.hit(r.x + fx * r.w, r.y + fy * r.h), row);
    }
  }
});

test('remaining-work area suppresses excluded or zero weight without treating fractional estimates as zero', () => {
  const small = { ...rows[0], gain: 0.00001 };
  const subset = [small, ...rows.slice(1)];
  for (const map of [geometry.address(subset, 128, 96, 'gain'), geometry.source(subset, [], 128, 96, 'gain')]) {
    assert.ok(map.rectFor(small.id)?.w > 0);
    assert.ok(map.rectFor('b')?.w > 0);
    assert.equal(map.rectFor('c'), null);
    assert.equal(map.rectFor('d'), null);
    assert.equal(map.hit(-1, 10), null);
  }
});

test('workflow colors distinguish active revisions from their measured baseline and require confirmation evidence', () => {
  const key = geometry.workflowKey;
  assert.equal(key('queued', 'exact', 1), 'flight');
  assert.equal(key('claimed', 'unknown', 1), 'claimed');
  assert.equal(key('needs_cleanup', 'same', 0), 'returned');
  assert.equal(key('claimed', 'excluded', 1), 'skipped');
  assert.equal(key('done', 'same', 1), 'confirmed');
  assert.equal(key('done', 'same', 0), 'merged');
  assert.equal(key('done', 'exact', 1), 'identical');
  assert.equal(key('done', 'unresolved', 0), 'unresolved');
  assert.equal(key('open', 'unmeasured', 0), 'open');
});
