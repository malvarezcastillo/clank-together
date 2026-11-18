import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, hashToken, now } from '../src/server/db.js';
import { Accounts } from '../src/server/accounts.js';
import { createApp, DEFAULT_CONFIG } from '../src/server/app.js';
import { Workspace } from '../src/client/workspace.js';
import { correctSymbol, refreshSymbols } from '../src/client/ops.js';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-symbol-corrections-'));
  const store = new Store(path.join(dir, 'td.sqlite'));
  const accounts = new Accounts(store);
  for (const [id, current] of [['current', 1], ['previous', 0]]) {
    store.run('INSERT INTO versions (id, sha256, file, size, is_current, created_at) VALUES (?, ?, ?, 1, ?, ?)', id, 'fixture', 'unused.exe', current, now());
  }
  const symbols = ['?First@@YAXXZ', '?Second@@YAXXZ', null].map((decorated, i) => {
    const { symbol } = store.ensureSymbol({ kind: 'function', versionId: 'current', addr: 0x401000 + i * 0x100, size: 16, name: `Function${i}`, unit: 'src/functions.cpp' });
    store.run('UPDATE symbols SET decorated = ? WHERE id = ?', decorated, symbol.id);
    store.run('INSERT INTO symbol_addresses (symbol_id, version_id, addr, size) VALUES (?, ?, ?, ?)', symbol.id, 'previous', 0x501000 + i * 0x100, 12);
    store.run("INSERT INTO func_status (symbol_id, file, status, score, commit_hash, updated_at, confirmed, code_hash) VALUES (?, 'src/functions.cpp', 'equivalent', 0.9, 'original-commit', 123, 1, 'original-code')", symbol.id);
    store.run("INSERT INTO tasks (symbol_id, state, updated_at) VALUES (?, 'done', 123)", symbol.id);
    return symbol.id;
  });
  const user = (role) => {
    const id = Number(store.run("INSERT INTO users (name, role, status, created_at) VALUES (?, ?, 'active', ?)", role, role, now()).lastInsertRowid);
    const token = accounts.createApiToken(id, 'test').token;
    const session = `tds_${role}`;
    store.run('INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)', id, hashToken(session), now(), now() + 60_000);
    return { id, token, cookie: `td_session=${session}` };
  };
  const maintainer = user('maintainer');
  const contributor = user('contributor');
  const config = { ...DEFAULT_CONFIG, dataDir: dir };
  const server = createApp({ store, accounts, config, project: {}, runsWorker: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (id, body, auth = { token: maintainer.token }) => {
    const res = await fetch(`${base}/api/admin/symbols/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth.token && { authorization: `Bearer ${auth.token}` }), ...(auth.cookie && { cookie: auth.cookie }), ...(auth.csrf && { 'x-td-csrf': '1' }) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const snapshot = async (version = 'current', etag) => {
    const res = await fetch(`${base}/api/symbols?version=${version}`, { headers: etag ? { 'if-none-match': etag } : {} });
    if (res.status === 304) return { status: 304 };
    const body = await res.json();
    return { status: res.status, etag: res.headers.get('etag'), symbols: new Map(body.symbols.map((row) => [row[0], Object.fromEntries(body.columns.map((c, i) => [c, row[i]]))])) };
  };
  const state = () => Object.fromEntries(['symbols', 'symbol_addresses', 'func_status', 'tasks'].map((table) => [table, store.all(`SELECT * FROM ${table} ORDER BY rowid`).map((row) => ({ ...row }))]));
  const events = () => store.all("SELECT user_id, type, data FROM events WHERE type = 'symbol_corrected' ORDER BY id").map((event) => ({ ...event, data: JSON.parse(event.data) }));
  return { store, symbols, maintainer, contributor, post, snapshot, state, events, base, dir };
}

test('decorated corrections require maintainer authorization and session CSRF', async (t) => {
  const f = await fixture(t);
  const before = f.state();
  const body = { decorated: '?Corrected@@YAXXZ', reason: 'Original export and disassembly identify this function.' };
  for (const [auth, status] of [[{}, 401], [{ token: 'td_invalid' }, 401], [{ token: f.contributor.token }, 403], [{ cookie: f.maintainer.cookie }, 403]]) {
    assert.equal((await f.post(f.symbols[0], body, auth)).status, status);
  }
  assert.deepEqual(f.state(), before);
  assert.deepEqual(f.events(), []);
  assert.equal((await f.post(f.symbols[0], body, { cookie: f.maintainer.cookie, csrf: true })).status, 200);
});

test('decorated corrections reject malformed values without coercion, truncation or partial writes', async (t) => {
  const f = await fixture(t);
  const before = f.state();
  for (const decorated of [0, true, {}, [], '', ' ', ' ?Name@@YAXXZ', '?Name@@YAXXZ ', 'bad\nname', 'bad\n', 'bad\r', 'bad\u0000name', 'bad\u007fname', 'caf\u00e9', 'x'.repeat(2049)]) {
    assert.equal((await f.post(f.symbols[0], { name: 'Must not persist', size: 99, decorated, reason: 'Evidence' })).status, 400, JSON.stringify(decorated));
  }
  for (const body of [null, [], 'wrong', { decorated: '?New@@YAXXZ' }, { decorated: '?New@@YAXXZ', reason: {} }, { decorated: '?New@@YAXXZ', reason: ' ' }, { decorated: '?New@@YAXXZ', reason: 'x'.repeat(501) }, { decorated: '?New@@YAXXZ', reason: 'Evidence', addr: 123 }]) {
    assert.equal((await f.post(f.symbols[0], body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(f.state(), before);
  assert.deepEqual(f.events(), []);
});

test('duplicate decorated names roll back every requested correction', async (t) => {
  const f = await fixture(t);
  const before = f.state();
  const result = await f.post(f.symbols[0], { decorated: '?Second@@YAXXZ', name: 'Must not persist', size: 99, reason: 'Evidence' });
  assert.equal(result.status, 409);
  assert.match(result.body.error, new RegExp(f.symbols[1]));
  assert.deepEqual(f.state(), before);
  assert.deepEqual(f.events(), []);
});

test('a wrong decorated name can be cleared, which frees it for its real owner', async (t) => {
  const f = await fixture(t);
  const cleared = await f.post(f.symbols[1], { decorated: null, reason: 'Invented name: the import table has no such export.' });
  assert.equal(cleared.status, 200);
  assert.equal(f.store.get('SELECT decorated FROM symbols WHERE id = ?', f.symbols[1]).decorated, null);
  assert.equal(f.events().at(-1).data.old.decorated, '?Second@@YAXXZ');
  const moved = await f.post(f.symbols[0], { decorated: '?Second@@YAXXZ', reason: 'Now unambiguous.' });
  assert.equal(moved.status, 200);
});

test('audited decorated corrections preserve identity and confirmation and invalidate every version snapshot', async (t) => {
  const f = await fixture(t);
  const before = f.state();
  const snapshots = await Promise.all(['current', 'previous'].map((v) => f.snapshot(v)));
  const reason = 'Original export and disassembly identify this function.';
  const result = await f.post(f.symbols[0], { decorated: '?Corrected@@YAXXZ', reason });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body, { id: f.symbols[0], decorated: '?Corrected@@YAXXZ' });
  const expected = structuredClone(before);
  expected.symbols[0].decorated = '?Corrected@@YAXXZ';
  assert.deepEqual(f.state(), expected);
  assert.deepEqual(f.events(), [{ user_id: f.maintainer.id, type: 'symbol_corrected', data: { id: f.symbols[0], decorated: '?Corrected@@YAXXZ', old: { decorated: '?First@@YAXXZ' }, new: { decorated: '?Corrected@@YAXXZ' }, reason } }]);
  for (const [i, version] of ['current', 'previous'].entries()) {
    const snapshot = await f.snapshot(version, snapshots[i].etag);
    assert.equal(snapshot.status, 200);
    assert.notEqual(snapshot.etag, snapshots[i].etag);
    assert.equal(snapshot.symbols.get(f.symbols[0]).decorated, '?Corrected@@YAXXZ');
    assert.equal((await f.snapshot(version, snapshot.etag)).status, 304);
  }
});

test('atomic decorated swaps audit both directions and preserve addresses and function state', async (t) => {
  const f = await fixture(t);
  const before = f.state();
  const cached = await f.snapshot();
  const reason = 'Original call targets show the two recovered names were reversed.';
  const result = await f.post(f.symbols[0], { swapDecoratedWith: f.symbols[1], reason });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body, { id: f.symbols[0], decorated: '?Second@@YAXXZ', swapped: { id: f.symbols[1], decorated: '?First@@YAXXZ' } });
  const expected = structuredClone(before);
  [expected.symbols[0].decorated, expected.symbols[1].decorated] = [expected.symbols[1].decorated, expected.symbols[0].decorated];
  assert.deepEqual(f.state(), expected);
  const events = f.events();
  assert.deepEqual(events.map((e) => [e.user_id, e.data.id, e.data.old.decorated, e.data.new.decorated, e.data.swapDecoratedWith, e.data.reason]), [
    [f.maintainer.id, f.symbols[0], '?First@@YAXXZ', '?Second@@YAXXZ', f.symbols[1], reason],
    [f.maintainer.id, f.symbols[1], '?Second@@YAXXZ', '?First@@YAXXZ', f.symbols[0], reason],
  ]);
  const fresh = await f.snapshot('current', cached.etag);
  assert.equal(fresh.status, 200);
  assert.deepEqual(f.symbols.slice(0, 2).map((id) => fresh.symbols.get(id).decorated), ['?Second@@YAXXZ', '?First@@YAXXZ']);
});

test('unsafe swaps reject missing, ambiguous or conflicting mappings transactionally', async (t) => {
  const f = await fixture(t);
  const before = f.state();
  for (const [body, status] of [
    [{ swapDecoratedWith: f.symbols[0] }, 400],
    [{ swapDecoratedWith: f.symbols[2] }, 409],
    [{ swapDecoratedWith: 'fn_99999' }, 404],
    [{ swapDecoratedWith: null }, 400],
    [{ swapDecoratedWith: 123 }, 400],
    [{ swapDecoratedWith: f.symbols[1], decorated: '?Other@@YAXXZ' }, 400],
    [{ swapDecoratedWith: f.symbols[1], name: 'Other' }, 400],
    [{ swapDecoratedWith: f.symbols[1], size: 99 }, 400],
    [{ swapDecoratedWith: f.symbols[1], retire: true }, 400],
  ]) {
    assert.equal((await f.post(f.symbols[0], { ...body, reason: 'Evidence' })).status, status, JSON.stringify(body));
  }
  assert.deepEqual(f.state(), before);
  f.store.run('UPDATE symbols SET decorated = ? WHERE id = ?', '?First@@YAXXZ', f.symbols[2]);
  const ambiguous = f.state();
  assert.equal((await f.post(f.symbols[0], { swapDecoratedWith: f.symbols[1], reason: 'Evidence' })).status, 409);
  assert.deepEqual(f.state(), ambiguous);
  assert.deepEqual(f.events(), []);
});

test('decorated swaps reject function-vtable exchanges without audit or state changes', async (t) => {
  const f = await fixture(t);
  const { symbol: vtable } = f.store.ensureSymbol({ kind: 'vtable', versionId: 'current', addr: 0x405000, size: 16, name: 'Widget vtable' });
  f.store.run('UPDATE symbols SET decorated = ? WHERE id = ?', '??_7Widget@@6B@', vtable.id);
  const before = f.state();
  const revision = f.store.getMeta('symbolCorrectionsRevision');
  const snapshot = await f.snapshot();
  const result = await f.post(f.symbols[0], { swapDecoratedWith: vtable.id, reason: 'Mistaken cross-kind correction' });
  assert.equal(result.status, 409);
  assert.deepEqual(f.state(), before);
  assert.deepEqual(f.events(), []);
  assert.equal(f.store.getMeta('symbolCorrectionsRevision'), revision);
  assert.equal((await f.snapshot('current', snapshot.etag)).status, 304);
});

test('competing corrections cannot bind one decorated name to two IDs', async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(f.symbols.slice(0, 2).map((id) => f.post(id, { decorated: '?Contested@@YAXXZ', reason: 'Evidence' })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const winner = results.find((r) => r.status === 200).body.id;
  assert.deepEqual(f.store.all('SELECT id FROM symbols WHERE decorated = ?', '?Contested@@YAXXZ').map((r) => r.id), [winner]);
  assert.deepEqual(f.events().map((e) => e.data.id), [winner]);
});

test('an audit insert failure rolls back both halves of a decorated swap', async (t) => {
  const f = await fixture(t);
  const before = f.state();
  f.store.db.exec(`CREATE TRIGGER fail_second_audit BEFORE INSERT ON events WHEN NEW.type = 'symbol_corrected' AND json_extract(NEW.data, '$.id') = '${f.symbols[1]}' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
  assert.equal((await f.post(f.symbols[0], { swapDecoratedWith: f.symbols[1], reason: 'Evidence' })).status, 500);
  assert.deepEqual(f.state(), before);
  assert.deepEqual(f.events(), []);
});

test('decorated correction cache invalidation reaches another web process database connection', async (t) => {
  const f = await fixture(t);
  const otherStore = new Store(path.join(f.dir, 'td.sqlite'));
  const otherServer = createApp({ store: otherStore, accounts: new Accounts(otherStore), config: { ...DEFAULT_CONFIG, dataDir: f.dir }, project: {}, runsWorker: false });
  await new Promise((resolve) => otherServer.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${otherServer.address().port}/api/symbols`;
    const cached = await fetch(url);
    const etag = cached.headers.get('etag');
    await cached.json();
    assert.equal((await f.post(f.symbols[0], { decorated: '?CrossProcess@@YAXXZ', reason: 'Evidence' })).status, 200);
    const changed = await fetch(url, { headers: { 'if-none-match': etag } });
    assert.equal(changed.status, 200);
    const snapshot = await changed.json();
    assert.equal(snapshot.symbols.find((row) => row[0] === f.symbols[0])[snapshot.columns.indexOf('decorated')], '?CrossProcess@@YAXXZ');
  } finally {
    await new Promise((resolve) => otherServer.close(resolve));
    otherStore.db.close();
  }
});

test('decorated names retain C linkage and maximum-length spellings exactly', async (t) => {
  const f = await fixture(t);
  for (const decorated of ['_Function@4', '@Function@4', 'Function', '?'.repeat(2048)]) {
    const result = await f.post(f.symbols[2], { decorated, reason: 'Original symbol spelling' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(f.store.get('SELECT decorated FROM symbols WHERE id = ?', f.symbols[2]).decorated, decorated);
  }
});

test('client corrections and swaps replace cached and persisted decorated-name lookups', async (t) => {
  const f = await fixture(t);
  const ws = new Workspace(path.join(f.dir, 'workspace'));
  ws.config = { server: f.base, token: f.maintainer.token };
  ws.save();
  await refreshSymbols(ws);
  assert.equal(ws.findSymbol('?First@@YAXXZ').id, f.symbols[0]);
  await correctSymbol(ws, f.symbols[0], { decorated: '?ClientCorrected@@YAXXZ', reason: 'Evidence' });
  assert.equal(ws.findSymbol('?First@@YAXXZ'), null);
  assert.equal(ws.nameIndex.get('?ClientCorrected@@YAXXZ'), f.symbols[0]);
  assert.equal(new Workspace(ws.dir).findSymbol('?ClientCorrected@@YAXXZ').id, f.symbols[0]);
  await correctSymbol(ws, f.symbols[0], { swapDecoratedWith: f.symbols[1], reason: 'Evidence' });
  assert.equal(ws.nameIndex.get('?ClientCorrected@@YAXXZ'), f.symbols[1]);
  assert.equal(ws.nameIndex.get('?Second@@YAXXZ'), f.symbols[0]);
  const persisted = fs.readFileSync(ws.symbolsFile, 'utf8');
  await assert.rejects(correctSymbol(ws, f.symbols[0], { decorated: '?ClientCorrected@@YAXXZ', reason: 'Evidence' }), (error) => error.status === 409);
  assert.equal(fs.readFileSync(ws.symbolsFile, 'utf8'), persisted);
  assert.equal(new Workspace(ws.dir).findSymbol('?ClientCorrected@@YAXXZ').id, f.symbols[1]);
});
