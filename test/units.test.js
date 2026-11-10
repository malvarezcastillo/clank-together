import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferShape, addUnitsToCompileCommands, removeUnitsFromCompileCommands, movedUnits, withMovedUnits, unitSettings } from '../src/shared/project.js';

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

test('a moved unit keeps its own flags instead of its new folder\'s', () => {
  // WoW/D.cpp uses shape 0; moved into Engine/Gx (whose units use shape 1) it must stay 0.
  const units = { 'Engine/Gx/A.cpp': 1, 'Engine/Gx/B.cpp': 1, 'WoW/D.cpp': 0, 'WoW/E.cpp': 0, 'Tools/E.cpp': 1 };
  const files = {
    'WoW/D.cpp': null, 'Engine/Gx/D.cpp': 'int d;\n',                // a move
    'WoW/E.cpp': null, 'Engine/Gx/e.cpp': 'int e;\n', 'Tools/E.cpp': null, // two deleted units of that name: ambiguous
    'Engine/Gx/New.cpp': 'int n;\n',                               // a plain addition
    'Engine/Gx/A.cpp': 'int a2;\n',                                // an edit
  };
  const moves = movedUnits(units, files);
  assert.deepEqual([...moves], [['Engine/Gx/D.cpp', 'WoW/D.cpp']], 'one deleted and one added unit of the same name, nothing else');

  // While the batch is checked, the moved unit compiles with its old flags.
  const project = { compile: { shapes: [['/a'], ['/b']], units: withMovedUnits(units, moves) } };
  assert.deepEqual(unitSettings(project, 'Engine/Gx/D.cpp').cflags, ['/a']);
  assert.deepEqual(unitSettings(project, 'Engine/Gx/New.cpp').cflags, ['/b'], 'a new unit still takes its folder\'s');
  assert.equal(units['Engine/Gx/D.cpp'], undefined, 'the build list itself is not changed');

  // On merge it joins the build list with them.
  const text = JSON.stringify({ shapes: [['/a'], ['/b']], units }, null, 1);
  const shrunk = removeUnitsFromCompileCommands({ compile: { units } }, text, ['WoW/D.cpp', 'WoW/E.cpp', 'Tools/E.cpp']);
  const shapes = new Map([...moves].map(([to, from]) => [to, units[from]]));
  const grown = addUnitsToCompileCommands({ compile: { units } }, shrunk.text, ['Engine/Gx/D.cpp', 'Engine/Gx/e.cpp', 'Engine/Gx/New.cpp', 'Engine/Gx/A.cpp'], shapes);
  const listed = JSON.parse(grown.text).units;
  assert.equal(listed['Engine/Gx/D.cpp'], 0, 'moved: its old shape');
  assert.equal(listed['Engine/Gx/New.cpp'], 1, 'new: inferred');
  assert.equal(listed['Engine/Gx/e.cpp'], 1, 'ambiguous: inferred like a new unit');
  assert.equal(listed['WoW/D.cpp'], undefined);
});
