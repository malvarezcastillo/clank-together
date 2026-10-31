import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, now } from '../src/server/db.js';
import { Tasks } from '../src/server/tasks.js';
import { misflaggedLibrary, clearLibrary } from '../src/server/library.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-library-'));
  const store = new Store(path.join(dir, 'td.sqlite'));
  t.after(() => {
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  store.run('INSERT INTO versions (id, sha256, file, size, is_current, created_at) VALUES (?, ?, ?, 1, 1, ?)', 'v', 'fixture', 'unused.exe', now());
  const fn = (addr, name, library, calls = [], unit = null) => {
    const { symbol } = store.ensureSymbol({ kind: 'function', versionId: 'v', addr, size: 16, name, library, unit });
    const asm = calls.map((c) => `  CALL 0x${c.toString(16).padStart(8, '0')} ; -> x`).join('\n');
    store.run('INSERT INTO original_code (version_id, addr, asm, c) VALUES (?, ?, ?, ?)', 'v', addr, asm, '');
    return symbol.id;
  };
  return { store, fn };
}

test('library-flagged functions reaching game code, directly or through each other, are game code; pure runtime stays library', (t) => {
  const { store, fn } = fixture(t);
  const game = fn(0x401000, 'Game', false, [], 'src/game.cpp');
  const crt = fn(0x402000, '_memcpy', true);
  const direct = fn(0x403000, '??0_Locinfo@std@@QAE@PBD@Z_1', true, [game, crt].map((id) => store.get('SELECT addr FROM symbol_addresses WHERE symbol_id = ?', id).addr));
  const indirect = fn(0x404000, '??0_Locinfo@std@@QAE@PBD@Z_2', true, [0x403000]);
  const pure = fn(0x405000, '_strlen', true, [0x402000]);
  fn(0x406000, '_WinMain@16', false, [], 'src/launcher.cpp');
  const startup = fn(0x407000, 'start', true, [0x406000]);
  const found = new Map(misflaggedLibrary(store, 'v').map((f) => [f.id, f.calls]));
  assert.ok(!found.has(startup), 'CRT startup calling WinMain stays library');
  assert.deepEqual([...found.keys()].sort(), [direct, indirect].sort());
  assert.deepEqual(found.get(direct), [game]);
  assert.deepEqual(found.get(indirect), [direct]);
  assert.ok(!found.has(pure) && !found.has(crt));
});

test('clearing a library flag drops the false name, logs the evidence, and the function becomes a task', (t) => {
  const { store, fn } = fixture(t);
  const id = fn(0x403000, '??0_Locinfo@std@@QAE@PBD@Z_1', true);
  const tasks = new Tasks({ store, config: {}, repo: null, project: {} });
  assert.equal(tasks.generate(), 0);
  assert.throws(() => clearLibrary(store, [id], { reason: ' ' }), /reason/);
  assert.equal(clearLibrary(store, [id], { reason: 'calls game code' }), 1);
  assert.equal(clearLibrary(store, [id], { reason: 'again' }), 0);
  assert.deepEqual({ ...store.get('SELECT library, name FROM symbols WHERE id = ?', id) }, { library: 0, name: 'sub_403000' });
  const ev = JSON.parse(store.get(`SELECT data FROM events WHERE type = 'symbol_corrected'`).data);
  assert.deepEqual([ev.old, ev.new, ev.reason], [{ library: true, name: '??0_Locinfo@std@@QAE@PBD@Z_1' }, { library: false, name: 'sub_403000' }, 'calls game code']);
  assert.equal(tasks.generate(), 1);
  assert.equal(store.get('SELECT state FROM tasks WHERE symbol_id = ?', id).state, 'open');
});
