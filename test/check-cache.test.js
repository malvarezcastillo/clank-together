import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkUnits } from '../src/shared/check.js';
import { PEImage } from '../src/shared/pe.js';
import { fixture, FN_ADDR, CALLEE_ADDR, GLOBAL_ADDR } from './helpers.js';

test('fresh and cached mixed-toolchain checks preserve GLOBAL relocation binding precedence', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-global-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoDir = path.join(root, 'repo');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  const binary = fixture();
  fs.writeFileSync(path.join(repoDir, 'src/a.cpp'), binary.source.replace('player.h', 'unused.h'));
  fs.writeFileSync(path.join(repoDir, 'src/b.cpp'), '// GLOBAL: gl_00002\nextern int g_val;\n');
  fs.writeFileSync(path.join(repoDir, 'src/c.cpp'), '// GLOBAL: gl_00001\nextern int g_val;\n');
  const writer = path.join(root, 'compiler.cjs');
  fs.writeFileSync(writer, `const fs=require('node:fs');
const a=process.argv.slice(2);const out=a.find(x=>x.startsWith('/Fo')).slice(3);const cod=a.find(x=>x.startsWith('/Fa')).slice(3);const file=a.at(-1);
fs.writeFileSync(out,Buffer.from(${JSON.stringify(binary.obj.toString('base64'))},'base64'));
fs.writeFileSync(cod,file.endsWith('a.cpp')?${JSON.stringify(binary.listing.replaceAll('player.cpp', 'a.cpp'))}:${JSON.stringify('EXTRN\t?g_val@@3HA:DWORD\t; g_val\n')});
`);
  const project = { sourceDirs: ['src'], includeDirs: [], toolchain: 'one', cflags: [writer, '/c'], fileOverrides: [{ glob: 'src/b.cpp', toolchain: 'two' }] };
  const runner = { type: 'native', clPath: process.execPath };
  const symbols = new Map([
    ['fn_00001', { id: 'fn_00001', kind: 'function', addr: FN_ADDR, size: 15 }],
    ['fn_00002', { id: 'fn_00002', kind: 'function', addr: CALLEE_ADDR, size: 1, decorated: '?Callee@@YAXXZ' }],
    ['gl_00001', { id: 'gl_00001', kind: 'global', addr: GLOBAL_ADDR, size: 4 }],
    ['gl_00002', { id: 'gl_00002', kind: 'global', addr: GLOBAL_ADDR + 4, size: 4 }],
  ]);
  const options = { repoDir, project, symbols, nameIndex: new Map([['?Callee@@YAXXZ', 'fn_00002']]), pe: new PEImage(binary.pe), runners: { one: runner, two: runner }, lintUnits: new Set() };
  const fresh = await checkUnits({ ...options, jobDir: path.join(root, 'fresh'), units: ['src/a.cpp', 'src/b.cpp', 'src/c.cpp'] });
  const target = (check) => check.units.find((u) => u.file === 'src/a.cpp').functions.find((f) => f.id === 'fn_00001');
  assert.equal(target(fresh).status, 'exact', 'toolchain-one c binding wins before toolchain-two b binding');
  const wrong = await checkUnits({ ...options, jobDir: path.join(root, 'wrong'), units: ['src/a.cpp', 'src/b.cpp'] });
  assert.equal(target(wrong).status, 'mismatch', 'the competing GLOBAL binding changes the relocation decision');
  assert.equal(target(wrong).relocations.find((r) => r.symbol === '?g_val@@3HA').id, 'gl_00002');
  const partial = await checkUnits({ ...options, jobDir: path.join(root, 'partial'), units: ['src/a.cpp'], cachedUnits: fresh.units, unitOrder: fresh.units.map((u) => u.file) });
  assert.deepEqual(target(partial), target(fresh), 'partial analysis retains the same relocation target and match decision');
});
