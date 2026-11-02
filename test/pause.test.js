import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.js';
import { openServer, createApp, PAUSED_MESSAGE } from '../src/server/app.js';
import { Store, now } from '../src/server/db.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let dataDir, ctx, server, base;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-pause-'));
  fs.writeFileSync(path.join(dataDir, 'server.json'), JSON.stringify({ listen: { host: '127.0.0.1', port: 0 } }));
  const repoDir = path.join(dataDir, 'repo');
  fs.cpSync(path.join(ROOT, 'template'), repoDir, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: repoDir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  const store = new Store(path.join(dataDir, 'td.sqlite'));
  const exe = path.join(dataDir, 'target.exe');
  const pe = fixture().pe;
  fs.writeFileSync(exe, pe);
  store.run('INSERT INTO versions (id, sha256, file, size, is_current, created_at) VALUES (?, ?, ?, ?, 1, ?)', '1.0', crypto.createHash('sha256').update(pe).digest('hex'), exe, pe.length, now());
  store.db.close();
  ctx = openServer(dataDir, { log: { info() {}, error() {}, warn() {} } });
  server = createApp(ctx);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  ctx.config.publicUrl = base;
});

after(() => {
  server.close();
  ctx.store.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const PASSWORD = 'correct horse battery';
const call = async (method, p, body, { token, cookie } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) Object.assign(headers, { cookie, 'x-td-csrf': '1' });
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})), setCookie: r.headers.get('set-cookie') };
};
async function account(name, role) {
  await ctx.accounts.createUser(name, role, PASSWORD);
  return { token: ctx.accounts.createApiToken(ctx.accounts.byName(name).id, 'test').token };
}
async function session(name) {
  const r = await call('POST', '/api/login', { name, password: PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { cookie: r.setCookie.split(';')[0] };
}

test('an admin pause turns contributors away from claims and submissions, not from reviews; maintainers carry on', async () => {
  const contributor = await account('pausecontrib', 'contributor');
  const maintainer = await account('pausemaint', 'maintainer');
  await account('pauseadmin', 'admin');
  const admin = await session('pauseadmin');

  assert.deepEqual((await call('GET', '/api/pause')).body, { paused: false, message: PAUSED_MESSAGE }, 'off by default');
  assert.equal((await call('POST', '/api/admin/pause', { paused: true }, contributor)).status, 403, 'only admins switch it');
  const switched = await call('POST', '/api/admin/pause', { paused: true }, admin);
  assert.equal(switched.body.paused, true, JSON.stringify(switched));

  for (const [p, body] of [['/api/regions/claim', { kind: 'unit', key: 'src/x.cpp' }], ['/api/batches', { taskIds: [1], baseCommit: 'x', files: {} }], ['/api/tasks/claim', { taskId: 1 }], ['/api/check', { files: {} }]]) {
    const r = await call('POST', p, body, contributor);
    assert.equal(r.status, 503, `${p} refused while paused`);
    assert.equal(r.body.error, PAUSED_MESSAGE);
  }
  assert.notEqual((await call('POST', '/api/peer-reviews/claim', {}, contributor)).status, 503, 'peer reviews stay open');
  assert.notEqual((await call('GET', '/api/regions', null, contributor)).status, 503, 'reading stays open');
  assert.notEqual((await call('POST', '/api/regions/claim', { kind: 'unit', key: 'src/x.cpp' }, maintainer)).status, 503, 'maintainers are not paused');

  assert.equal((await call('POST', '/api/admin/pause', { paused: false }, admin)).body.paused, false);
  assert.notEqual((await call('POST', '/api/regions/claim', { kind: 'unit', key: 'src/x.cpp' }, contributor)).status, 503, 'open again once switched off');
});
