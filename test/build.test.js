import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectIncludes, fillPlaceholders } from '../src/shared/build.js';

test('project headers are read from /showIncludes, compiler headers are left out', () => {
  const log = [
    '== WoW/Source/Foo.cpp',
    'Note: including file: Z:\\job\\WoW\\Source\\Foo.h',
    'Note: including file:  Z:\\opt\\toolchain\\vs2010sp1\\VC\\include\\windows.h',
    'Note: including file:   Z:\\job\\Engine\\Source\\Base\\Bar.inl',
    'Note: including file:   z:\\job\\Engine\\Source\\Base\\Bar.inl',
  ].join('\r\n');
  assert.deepEqual(projectIncludes(log, '/tmp/td-job').sort(), ['Engine/Source/Base/Bar.inl', 'WoW/Source/Foo.h']);
});

test('placeholders', () => {
  assert.equal(fillPlaceholders('/I${SRC}\\ThirdParty /FI${TC}\\compat\\x.h', { src: 'Z:\\job', tc: 'Z:\\opt\\toolchain' }), '/IZ:\\job\\ThirdParty /FIZ:\\opt\\toolchain\\compat\\x.h');
});
