import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Repo } from '../src/server/git.js';

// Real git repository: `base` is the submitter's base commit, main moves on, the submission merges.
function fixture(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-union-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  const commit = (f) => {
    for (const [file, text] of Object.entries(f)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c');
    return git('rev-parse', 'HEAD');
  };
  const base = commit(files);
  return { repo: new Repo(dir), base, commit };
}

const cpp = 'int a() { return 1; }\n\nint b() { return 2; }\n';
const hdr = 'struct vec;\nclass CMode {\npublic:\n  int m_x;\n  void A();\n};\n';

test('independent additions at the same place keep both sides, main first', (t) => {
  const f = fixture(t, { 'src/a.cpp': cpp, 'src/m.h': hdr });
  f.commit({ 'src/a.cpp': cpp + '\nint main_fn() { return 3; }\n', 'src/m.h': hdr.replace('  void A();\n', '  void A();\n  void FromMain();\n') });
  const merged = f.repo.mergeOntoHead(f.base, {
    'src/a.cpp': cpp + '\nint theirs_fn() { return 4; }\n',
    'src/m.h': hdr.replace('  void A();\n', '  void A();\n  int Theirs(const vec* v) const;\n').replace('struct vec;\n', 'struct vec;\nstruct item;\n'),
  });
  assert.deepEqual(merged.conflicts, []);
  assert.equal(merged.files['src/a.cpp'], cpp + '\nint main_fn() { return 3; }\n\nint theirs_fn() { return 4; }\n');
  assert.match(merged.files['src/m.h'], /void FromMain\(\);\n  int Theirs\(const vec\* v\) const;\n/);
  assert.ok(!merged.files['src/m.h'].includes('<<<<<<<'));
});

test('edits to shared lines, and layout-affecting header additions, still conflict', (t) => {
  const f = fixture(t, { 'src/a.cpp': cpp, 'src/m.h': hdr });
  f.commit({ 'src/a.cpp': cpp.replace('return 1;', 'return 10;'), 'src/m.h': hdr.replace('  int m_x;\n', '  int m_x;\n  int m_main;\n') });
  const edit = f.repo.mergeOntoHead(f.base, { 'src/a.cpp': cpp.replace('return 1;', 'return 11;') });
  assert.deepEqual(edit.conflicts, ['src/a.cpp'], 'both sides edited the same existing line');
  for (const added of ['  int m_theirs;', '  virtual void V();', '  void Inline() { m_x++; }', '  struct Nested { int y; };']) {
    const r = f.repo.mergeOntoHead(f.base, { 'src/m.h': hdr.replace('  int m_x;\n', `  int m_x;\n${added}\n`) });
    assert.deepEqual(r.conflicts, ['src/m.h'], `${added.trim()} next to a new field stays a conflict`);
  }
});

test('non-conflicting merges and both-created files keep their existing behaviour', (t) => {
  const f = fixture(t, { 'src/a.cpp': cpp });
  f.commit({ 'src/a.cpp': 'int z() { return 0; }\n\n' + cpp, 'src/new.cpp': 'int main_new;\n' });
  const r = f.repo.mergeOntoHead(f.base, { 'src/a.cpp': cpp + '\nint c() { return 5; }\n', 'src/new.cpp': 'int theirs_new;\n' });
  assert.equal(r.files['src/a.cpp'], 'int z() { return 0; }\n\n' + cpp + '\nint c() { return 5; }\n');
  assert.deepEqual(r.conflicts, ['src/new.cpp']);
});

test('insertions both sides made identically are kept once, not duplicated', (t) => {
  const f = fixture(t, { 'src/m.h': hdr });
  const both = hdr.replace('  void A();\n', '  void A();\n  void Shared();\n');
  f.commit({ 'src/m.h': both.replace('  void Shared();\n', '  void Shared();\n  void MainOnly();\n') });
  const r = f.repo.mergeOntoHead(f.base, { 'src/m.h': both.replace('  void Shared();\n', '  void Shared();\n  void TheirsOnly();\n') });
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.files['src/m.h'].match(/void Shared\(\);/g).length, 1, 'shared declaration appears once');
  assert.match(r.files['src/m.h'], /MainOnly[\s\S]*TheirsOnly/);
});

test('source insertions repeating a definition stay a conflict instead of duplicating it', (t) => {
  const f = fixture(t, { 'src/a.cpp': cpp });
  const fn = '\n// FUNCTION: fn_00009\nint dup() {\n  return 9;\n}\n';
  f.commit({ 'src/a.cpp': cpp + fn + '\nint main_fn() { return 3; }\n' });
  const r = f.repo.mergeOntoHead(f.base, { 'src/a.cpp': cpp + '\nint theirs_fn() { return 4; }\n' + fn });
  assert.deepEqual(r.conflicts, ['src/a.cpp']);
});
