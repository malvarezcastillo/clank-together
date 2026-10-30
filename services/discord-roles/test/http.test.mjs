import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../app.mjs';
import { loadConfig } from '../config.mjs';

const ENV = {
  PUBLIC_URL: 'https://roles.example', DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'private-client-secret',
  TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32), SOURCE_DB_PATH: './source/td.sqlite', STATE_DB_PATH: './state/roles.sqlite',
};
const config = loadConfig(ENV);
const SESSION = '__Host-clank_roles_session';
const LOGIN = '__Host-clank_roles_login';
const STATE = '__Host-clank_roles_state';

async function fixture(t) {
  const sessions = new Map();
  const states = new Map();
  const calls = { tokens: [], links: [], syncs: 0, unlinks: [] };
  const user = { id: 7, name: '<script>alert("name")</script>', credits: '10001', status: 'active' };
  let link = null;
  const core = {
    verifyClankToken: async (token) => { calls.tokens.push(token); if (token !== 'valid-clank-token') throw Object.assign(new Error(`SECRET ${token}`), { status: 401 }); return { id: user.id, name: user.name }; },
    getSourceUser: (id) => id === user.id ? user : null,
    createSession: (id) => { const raw = randomBytes(32).toString('base64url'); sessions.set(raw, { userId: id, csrf: randomBytes(32).toString('base64url') }); return raw; },
    getSession: (raw) => sessions.get(raw) || null,
    deleteSession: (raw) => { sessions.delete(raw); for (const [state, owner] of states) if (owner === raw) states.delete(state); },
    createState: (raw) => { const value = randomBytes(32).toString('base64url'); states.set(value, raw); return value; },
    consumeState: (raw, value) => { if (states.get(value) !== raw) return null; states.delete(value); return sessions.get(raw)?.userId ?? null; },
    link: async (id, code) => { calls.links.push([id, code]); link = { discordId: '222222222222222222', status: 'synced', lastSyncedAt: 1700000000000, nextRetryAt: null, lastError: null, credits: user.credits }; },
    syncAll: async () => { calls.syncs++; },
    getLink: () => link,
    unlink: async (id) => { calls.unlinks.push(id); link = null; },
  };
  const server = createApp(config, core);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();
  async function request(path = '/', options = {}) {
    const headers = { ...(jar.size ? { Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {}), ...options.headers };
    const response = await fetch(base + path, { ...options, headers, redirect: 'manual' });
    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(';');
      const index = pair.indexOf('=');
      if (/Max-Age=0(?:;|$)/.test(value)) jar.delete(pair.slice(0, index));
      else jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }
  async function post(path, data, headers = {}) {
    return request(path, { method: 'POST', headers: { Origin: config.publicUrl, 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(data) });
  }
  async function login() {
    await request();
    const response = await post('/api/login', { csrf: jar.get(LOGIN), token: 'valid-clank-token' });
    assert.equal(response.status, 303);
    return sessions.get(jar.get(SESSION)).csrf;
  }
  return { core, calls, user, sessions, states, jar, request, post, login };
}

test('configuration requires real OAuth credentials and a 32-byte encryption key', () => {
  assert.equal(config.redirectUri, 'https://roles.example/api/discord/callback');
  assert.equal(config.syncIntervalMs, 60000);
  assert.equal(config.encryptionKey.length, 32);
  for (const key of ['PUBLIC_URL', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'SOURCE_DB_PATH']) {
    assert.throws(() => loadConfig({ ...ENV, [key]: '' }), new RegExp(key));
  }
  for (const value of ['http://roles.example', 'https://roles.example/path', 'https://user:pass@roles.example', 'https://roles.example/?q=x']) assert.throws(() => loadConfig({ ...ENV, PUBLIC_URL: value }));
  assert.throws(() => loadConfig({ ...ENV, DISCORD_REDIRECT_URI: 'https://other.example/callback' }));
  assert.throws(() => loadConfig({ ...ENV, TOKEN_ENCRYPTION_KEY: 'x'.repeat(32) }));
  assert.throws(() => loadConfig({ ...ENV, SOURCE_DB_PATH: './same.sqlite', STATE_DB_PATH: './same.sqlite' }));
  assert.throws(() => loadConfig({ ...ENV, SYNC_INTERVAL_SECONDS: 'NaN' }));
  assert.deepEqual(loadConfig({ ...ENV, TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') }).encryptionKey, Buffer.alloc(32, 7));
});

test('login form uses secure host-only cookies and strict security headers', async (t) => {
  const f = await fixture(t);
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /__Host-clank_roles_login=.*Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await response.text();
  assert.match(html, /type="password"/);
  assert.match(html, /name="csrf"/);
  assert.doesNotMatch(html, /private-client-secret/);
});

test('token login rejects missing or foreign Origin, absent CSRF, duplicates and oversized body', async (t) => {
  const f = await fixture(t);
  await f.request();
  const csrf = f.jar.get(LOGIN);
  for (const origin of ['', 'https://evil.example', 'https://roles.example.evil.test', 'null']) {
    assert.equal((await f.post('/api/login', { csrf, token: 'valid-clank-token' }, { Origin: origin })).status, 403);
  }
  const missingOrigin = await f.request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, token: 'valid-clank-token' }) });
  assert.equal(missingOrigin.status, 403);
  assert.equal((await f.post('/api/login', { token: 'valid-clank-token' })).status, 403);
  assert.equal((await f.post('/api/login', { csrf: 'wrong', token: 'valid-clank-token' })).status, 403);
  assert.equal((await f.post('/api/login', { csrf, token: 'valid-clank-token' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.request('/api/login', { method: 'POST', headers: { Origin: config.publicUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `csrf=${csrf}&csrf=${csrf}&token=valid-clank-token` })).status, 400);
  assert.equal((await f.post('/api/login', { csrf, token: 'x'.repeat(9000) })).status, 413);
  assert.deepEqual(f.calls.tokens, []);
});

test('successful login rotates sessions, keeps tokens out of HTML and escapes account names', async (t) => {
  const f = await fixture(t);
  const old = f.core.createSession(7);
  f.jar.set(SESSION, old);
  f.jar.set(LOGIN, randomBytes(32).toString('base64url'));
  const response = await f.post('/api/login', { csrf: f.jar.get(LOGIN), token: 'valid-clank-token' });
  assert.equal(response.status, 303);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  assert.equal(f.sessions.has(old), false);
  assert.notEqual(f.jar.get(SESSION), old);
  assert.equal(f.jar.has(LOGIN), false);
  const account = await f.request();
  const html = await account.text();
  assert.match(html, /&lt;script&gt;alert\(&quot;name&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|valid-clank-token|private-client-secret/);
  const info = await (await f.request('/api/account')).json();
  assert.equal(info.user.credits, '10001');
  assert.ok(info.csrf);
});

test('upstream exception text and submitted tokens never leak in errors', async (t) => {
  const f = await fixture(t);
  await f.request();
  const response = await f.post('/api/login', { csrf: f.jar.get(LOGIN), token: 'sensitive-token' });
  assert.equal(response.status, 401);
  assert.doesNotMatch(await response.text(), /sensitive-token|SECRET|stack/);
});

test('Discord verification GET entry works before login without starting OAuth', async (t) => {
  const f = await fixture(t);
  const entry = await f.request('/api/discord/link');
  assert.equal(entry.status, 302);
  assert.equal(entry.headers.get('location'), '/');
  assert.equal(f.sessions.size, 0);
  assert.equal(f.states.size, 0);
  assert.equal(f.jar.has(STATE), false);
  assert.deepEqual(f.calls.links, []);
});

test('OAuth requires POST with CSRF and returns only identify and role_connections.write', async (t) => {
  const f = await fixture(t);
  const csrf = await f.login();
  const entry = await f.request('/api/discord/link');
  assert.equal(entry.status, 302);
  assert.equal(entry.headers.get('location'), '/');
  assert.equal(f.states.size, 0);
  assert.equal(f.jar.has(STATE), false);
  assert.equal((await f.post('/api/discord/link', { csrf: 'wrong' })).status, 403);
  const response = await f.post('/api/discord/link', { csrf });
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.origin, 'https://discord.com');
  assert.equal(location.searchParams.get('scope'), 'identify role_connections.write');
  assert.equal(location.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(location.searchParams.get('state'), f.jar.get(STATE));
  assert.match(response.headers.get('set-cookie'), /Max-Age=600/);
});

test('OAuth callback state is cookie-bound, session-bound and consumed once', async (t) => {
  const f = await fixture(t);
  const csrf = await f.login();
  await f.post('/api/discord/link', { csrf });
  const state = f.jar.get(STATE);
  const originalSession = f.jar.get(SESSION);
  f.jar.set(SESSION, f.core.createSession(7));
  assert.equal((await f.request(`/api/discord/callback?state=${state}&code=bad-session`)).status, 400);
  assert.equal(f.calls.links.length, 0);
  f.jar.set(SESSION, originalSession);
  f.jar.set(STATE, 'x'.repeat(43));
  assert.equal((await f.request(`/api/discord/callback?state=${state}&code=bad-cookie`)).status, 400);
  f.jar.set(STATE, state);
  assert.equal((await f.request(`/api/discord/callback?state=${state}&code=one-use-code`)).status, 303);
  assert.equal(f.jar.has(STATE), false);
  assert.deepEqual(f.calls.links, [[7, 'one-use-code']]);
  f.jar.set(STATE, state);
  assert.equal((await f.request(`/api/discord/callback?state=${state}&code=replay`)).status, 400);
  assert.equal(f.calls.links.length, 1);
});

test('denied OAuth consumes state without exposing Discord error descriptions', async (t) => {
  const f = await fixture(t);
  const csrf = await f.login();
  await f.post('/api/discord/link', { csrf });
  const state = f.jar.get(STATE);
  const response = await f.request(`/api/discord/callback?state=${state}&error=access_denied&error_description=SECRET`);
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /SECRET|access_denied/);
  assert.equal(f.states.has(state), false);
});

test('account sync, unlink and logout enforce session and CSRF', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/account')).status, 401);
  for (const path of ['/api/discord/sync', '/api/discord/unlink', '/api/logout']) assert.equal((await f.post(path, { csrf: 'unknown' })).status, 401);
  const csrf = await f.login();
  for (const path of ['/api/discord/sync', '/api/discord/unlink', '/api/logout']) {
    assert.equal((await f.request(path)).status, 405);
    assert.equal((await f.post(path, { csrf: 'wrong' })).status, 403);
  }
  assert.equal((await f.post('/api/discord/sync', { csrf })).status, 303);
  assert.equal(f.calls.syncs, 1);
  assert.equal((await f.post('/api/discord/unlink', { csrf })).status, 303);
  assert.deepEqual(f.calls.unlinks, [7]);
  assert.equal((await f.post('/api/logout', { csrf })).status, 303);
  assert.equal(f.sessions.size, 0);
  assert.equal(f.jar.has(SESSION), false);
});

test('readiness probes source reads and inactive users cannot act', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.request('/healthz')).json(), { ready: true });
  const csrf = await f.login();
  f.user.status = 'disabled';
  assert.equal((await f.post('/api/discord/link', { csrf })).status, 401);
  assert.equal((await f.request('/api/account')).status, 401);
  f.core.getSourceUser = () => { throw new Error('secret-database-path'); };
  const response = await f.request('/healthz');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ready: false });
});

test('pending unlink is shown honestly and never offers an immediate reconnect', async (t) => {
  const f = await fixture(t);
  await f.login();
  f.core.getLink = () => ({ discordId: '222222222222222222', status: 'unlink_pending', lastSyncedAt: null });
  const html = await (await f.request()).text();
  assert.match(html, /Disconnect pending/);
  assert.doesNotMatch(html, /action="\/api\/discord\/link"/);
});
