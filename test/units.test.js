import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferShape, addUnitsToCompileCommands } from '../src/shared/project.js';

test('new source files get the flags of their folder and join the build list', () => {
  const compile = { shapes: [['/a'], ['/b']], units: { 'Engine/Gx/A.cpp': 1, 'Engine/Gx/B.cpp': 1, 'Engine/Base/C.cpp': 0, 'WoW/D.cpp': 0 } };
  const project = { compile };
  assert.equal(inferShape(project, 'Engine/Gx/New.cpp'), 1, 'its folder');
  assert.equal(inferShape(project, 'Engine/Gx/Deep/New.cpp'), 1, 'the nearest folder with units');
  assert.equal(inferShape(project, 'Tools/X.cpp'), 0, 'the most common one');
  const text = JSON.stringify(compile, null, 1);
  const grown = addUnitsToCompileCommands(project, text, ['Engine/Gx/New.cpp', 'Engine/Gx/A.cpp', 'Engine/Gx/x.h', 'WoW/Win32/Old.cpp']);
  assert.deepEqual(grown.added, ['Engine/Gx/New.cpp'], 'headers, listed units and Win32 copies are left alone');
  const doc = JSON.parse(grown.text);
  assert.deepEqual(Object.keys(doc.units), ['Engine/Base/C.cpp', 'Engine/Gx/A.cpp', 'Engine/Gx/B.cpp', 'Engine/Gx/New.cpp', 'WoW/D.cpp']);
  assert.equal(doc.units['Engine/Gx/New.cpp'], 1);
  assert.equal(addUnitsToCompileCommands(project, text, ['Engine/Gx/A.cpp']), null);
});
