import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { linkSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCore } from './core.mjs';

const TOKEN_SCOPE = 'identify role_connections.write';
const DAY = 86_400_000;
const hash = (text) => createHash('sha256').update(text).digest('hex');

async function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'discord-roles-core-'));
  const sourcePath = join(directory, 'source.sqlite');
  const databasePath = join(directory, 'state.sqlite');
  const source = new DatabaseSync(sourcePath);
  source.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL COLLATE NOCASE, status TEXT NOT NULL);
    CREATE TABLE credit_ledger (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, amount INTEGER NOT NULL,
      reason TEXT NOT NULL, ref TEXT, created_at INTEGER NOT NULL);
    INSERT INTO users VALUES (1, 'Alice', 'active'), (2, 'Bob', 'active'), (3, 'Pending', 'pending');
  `);
  let time = 1_900_000_000_000;
  const requests = [];
  const controls = {
    me: { status: 200, body: { name: 'aLiCe', via: 'token' } },
    metadata: null,
    refresh: null,
    exchange: null,
    revoke: null,
  };
  const tokenUsers = new Map();
  let refreshNumber = 0;
  let inspector;
  const response = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const entry = { method: req.method, path: req.url, authorization: req.headers.authorization, body };
      requests.push(entry);
      if (req.url === '/api/me') {
        const reply = typeof controls.me === 'function' ? await controls.me(entry) : controls.me;
        if (reply) response(res, reply.status, reply.body, reply.headers);
        return;
      }
      if (req.url === '/oauth2/token') {
        const form = new URLSearchParams(body);
        const isRefresh = form.get('grant_type') === 'refresh_token';
        const custom = isRefresh ? controls.refresh : controls.exchange;
        if (custom) {
          const reply = await custom(entry, form);
          if (reply) response(res, reply.status, reply.body, reply.headers);
          return;
        }
        const discordId = isRefresh ? form.get('refresh_token').split(':')[1] : form.get('code').split(':')[0];
        const suffix = isRefresh ? `r${++refreshNumber}` : form.get('code');
        const access = `access:${discordId}:${suffix}`;
        tokenUsers.set(access, discordId);
        response(res, 200, { access_token: access, refresh_token: `refresh:${discordId}:${suffix}`,
          token_type: 'Bearer', expires_in: 7200, scope: TOKEN_SCOPE });
        return;
      }
      if (req.url === '/api/v10/users/@me') {
        response(res, 200, { id: tokenUsers.get(req.headers.authorization?.slice(7)) });
        return;
      }
      if (req.url === '/api/v10/users/@me/applications/123456/role-connection') {
        if (controls.metadata) {
          const reply = await controls.metadata(entry, inspector);
          if (reply) response(res, reply.status, reply.body, reply.headers);
        } else response(res, 200, JSON.parse(body));
        return;
      }
      if (req.url === '/oauth2/token/revoke') {
        if (controls.revoke) {
          const reply = await controls.revoke(entry);
          if (reply) response(res, reply.status, reply.body, reply.headers);
        } else response(res, 200);
        return;
      }
      response(res, 404, {});
    } catch {
      response(res, 500, { error: 'fake_handler_failure' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = {
    sourceDbPath: sourcePath, databasePath, clankApiUrl: origin,
    discordClientId: '123456', discordClientSecret: 'test-client-secret',
    redirectUri: 'https://roles.example/api/discord/callback', encryptionKey: randomBytes(32),
    sessionTtlMs: 7 * DAY, syncIntervalMs: 60_000, httpTimeoutMs: 2000,
    discordApiBase: `${origin}/api/v10`, discordOauthBase: `${origin}/oauth2`, now: () => time,
    ...overrides,
  };
  let core = createCore(config);
  inspector = new DatabaseSync(databasePath);
  const context = {
    get core() { return core; }, source, inspector, config, controls, requests, tokenUsers,
    advance(ms) { time += ms; },
    get time() { return time; },
    async restart() { await core.close(); core = createCore(config); },
    award(userId, amount, reason) {
      source.prepare('INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, ?, ?, ?)').run(userId, amount, reason, time);
    },
    row(userId = 1) { return inspector.prepare('SELECT * FROM links WHERE user_id = ?').get(userId); },
    metadata() { return requests.filter((request) => request.method === 'PUT'); },
    refreshes() { return requests.filter((request) => request.path === '/oauth2/token' && new URLSearchParams(request.body).get('grant_type') === 'refresh_token'); },
  };
  t.after(async () => {
    await core.close();
    inspector.close();
    source.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  return context;
}

test('source reads committed WAL earnings, not game balance, grants, bailouts or negative entries', async (t) => {
  const f = await fixture(t);
  for (const [amount, reason] of [[10, 'identical'], [6, 'confirmed'], [3, 'skip'], [1, 'submitted'], [2, 'review'],
    [500, 'grant'], [5, 'bailout'], [5000, 'game:slots'], [-19, 'game:slots'], [-2, 'review'], [99, 'merged']]) {
    f.award(1, amount, reason);
  }
  assert.deepEqual(f.core.getSourceUser(1), { id: 1, name: 'Alice', credits: '22', status: 'active' });
  assert.equal(f.core.getSourceUser(999), null);
  f.award(1, 10, 'identical');
  assert.equal(f.core.getSourceUser(1).credits, '32');
  f.source.prepare('INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, ?, ?, ?)')
    .run(2, 9007199254740993n, 'identical', f.time);
  assert.equal(f.core.getSourceUser(2).credits, '9007199254740993');
  assert.equal(f.source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length, 2);
});

test('one-time Clank bearer verification maps the existing name-only /api/me and never persists its token', async (t) => {
  const f = await fixture(t);
  const token = 'td_unique_secret_never_persist';
  assert.deepEqual(await f.core.verifyClankToken(token), { id: 1, name: 'Alice' });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, '/api/me');
  assert.equal(f.requests[0].authorization, `Bearer ${token}`);
  for (const table of ['sessions', 'oauth_states', 'links', 'cooldowns']) {
    assert.equal(JSON.stringify(f.inspector.prepare(`SELECT * FROM ${table}`).all()).includes(token), false);
  }
  f.controls.me = { status: 200, body: { name: 'Alice', via: 'session' } };
  await assert.rejects(f.core.verifyClankToken(token), { code: 'invalid_clank_token' });
  f.controls.me = { status: 200, body: { name: 'Missing', via: 'token' } };
  await assert.rejects(f.core.verifyClankToken(token), { code: 'account_inactive' });
  f.controls.me = { status: 200, body: { name: 'Pending', via: 'token' } };
  await assert.rejects(f.core.verifyClankToken(token), { code: 'account_inactive' });
  f.controls.me = { status: 401, body: { error: token } };
  await assert.rejects(f.core.verifyClankToken(token), (error) => error.code === 'invalid_clank_token' && !error.message.includes(token));
  const count = f.requests.length;
  await assert.rejects(f.core.verifyClankToken('bad\r\nheader'), { code: 'invalid_clank_token' });
  assert.equal(f.requests.length, count);
});

test('sessions store hashes and independent CSRF, expire and immediately reject inactive source users', async (t) => {
  const f = await fixture(t);
  const token = f.core.createSession(1);
  const session = f.core.getSession(token);
  const stored = f.inspector.prepare('SELECT * FROM sessions').get();
  assert.equal(stored.token_hash, hash(token));
  assert.notEqual(stored.token_hash, token);
  assert.equal(session.userId, 1);
  assert.match(session.csrf, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(session.csrf, token);
  assert.equal(f.core.getSession('bad'), null);
  assert.throws(() => f.core.createSession(3), { code: 'account_inactive' });
  const state = f.core.createState(token);
  f.source.prepare("UPDATE users SET status = 'revoked' WHERE id = 1").run();
  assert.equal(f.core.getSession(token), null);
  assert.equal(f.core.consumeState(token, state), null);
  assert.equal(f.inspector.prepare('SELECT COUNT(*) AS n FROM oauth_states').get().n, 0);
  const second = f.core.createSession(2);
  f.advance(7 * DAY);
  assert.equal(f.core.getSession(second), null);
});

test('OAuth state is random, hashed, one-use, session-bound, replacement-bound and valid for ten minutes', async (t) => {
  const f = await fixture(t);
  const a = f.core.createSession(1);
  const anotherA = f.core.createSession(1);
  const b = f.core.createSession(2);
  const state = f.core.createState(a);
  const row = f.inspector.prepare('SELECT * FROM oauth_states').get();
  assert.equal(row.state_hash, hash(state));
  assert.equal(row.session_hash, hash(a));
  assert.equal(row.expires_at, f.time + 600_000);
  assert.equal(f.core.consumeState(b, state), null);
  assert.equal(f.core.consumeState(anotherA, state), null);
  assert.equal(f.core.consumeState(a, state), 1);
  assert.equal(f.core.consumeState(a, state), null);
  const replaced = f.core.createState(a);
  const latest = f.core.createState(a);
  assert.equal(f.core.consumeState(a, replaced), null);
  f.advance(600_000);
  assert.equal(f.core.consumeState(a, latest), null);
  const loggedOut = f.core.createState(a);
  f.core.deleteSession(a);
  assert.equal(f.core.consumeState(a, loggedOut), null);
});

test('link saves authenticated encrypted credentials before initial metadata sync and exposes only safe status', async (t) => {
  const f = await fixture(t);
  f.award(1, 50, 'identical');
  let persistedBeforePublish;
  f.controls.metadata = async () => {
    persistedBeforePublish = f.row();
    return { status: 200, body: {} };
  };
  const result = await f.core.link(1, '111:first');
  assert.equal(persistedBeforePublish.status, 'pending');
  assert.match(persistedBeforePublish.access_token, /^v1\./);
  assert.match(persistedBeforePublish.refresh_token, /^v1\./);
  assert.equal(persistedBeforePublish.access_token.includes('access:111'), false);
  assert.equal(persistedBeforePublish.refresh_token.includes('refresh:111'), false);
  assert.deepEqual(result, { discordId: '111', status: 'synced', lastSyncedAt: f.time,
    nextRetryAt: f.time + 60_000, lastError: null, credits: '50' });
  assert.deepEqual(JSON.parse(f.metadata()[0].body), {
    platform_name: 'rodecomp.online', platform_username: 'Alice', metadata: { credits: '50' },
  });
  const tokenRequest = new URLSearchParams(f.requests.find((entry) => entry.path === '/oauth2/token').body);
  assert.equal(tokenRequest.get('redirect_uri'), f.config.redirectUri);
  assert.equal(tokenRequest.get('client_id'), '123456');
  assert.equal(tokenRequest.get('client_secret'), 'test-client-secret');
  assert.equal(JSON.stringify(result).includes('access'), false);
});

test('initial sync failure keeps encrypted tokens pending and retries after durable backoff across restart', async (t) => {
  const f = await fixture(t);
  f.controls.metadata = async () => ({ status: 503, body: { secret: 'must-not-be-stored' } });
  const result = await f.core.link(1, '111:first');
  assert.equal(result.status, 'pending');
  assert.equal(result.lastError, 'discord_request_failed');
  assert.ok(f.row().refresh_token);
  const count = f.requests.length;
  await f.restart();
  await f.core.syncAll();
  await assert.rejects(f.core.link(1, '111:repeated'), { code: 'discord_rate_limited' });
  assert.equal(f.requests.length, count);
  f.controls.metadata = null;
  f.advance(result.nextRetryAt - f.time);
  await f.core.syncAll();
  assert.equal(f.core.getLink(1).status, 'synced');
  assert.equal(f.row().failures, 0);
});

test('Discord ID ownership cannot be stolen or silently switched, even under concurrent callbacks', async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.core.link(1, '111:a'), f.core.link(2, '111:b')]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'discord_already_linked');
  const owner = f.row(1) ? 1 : 2;
  const other = owner === 1 ? 2 : 1;
  assert.equal(f.core.getLink(other), null);
  const encrypted = f.row(owner).access_token;
  await assert.rejects(f.core.link(owner, '222:c'), { code: 'unlink_previous_discord_first' });
  assert.equal(f.row(owner).discord_id, '111');
  assert.equal(f.row(owner).access_token, encrypted);
});

test('missing required OAuth scope is rejected without storing a link', async (t) => {
  const f = await fixture(t);
  f.controls.exchange = async () => ({ status: 200, body: {
    access_token: 'access', refresh_token: 'refresh', expires_in: 7200, token_type: 'Bearer', scope: 'identify',
  } });
  await assert.rejects(f.core.link(1, '111:first'), { code: 'discord_scope_missing' });
  assert.equal(f.core.getLink(1), null);
  assert.equal(f.metadata().length, 0);
});

test('refresh starts within one hour, rotates encrypted credentials before PUT and serializes concurrent sync', async (t) => {
  const f = await fixture(t);
  await f.core.link(1, '111:first');
  const old = f.row();
  f.advance(3_600_000);
  let refreshedBeforePut;
  f.controls.metadata = async () => {
    refreshedBeforePut = f.row();
    return { status: 503, body: {} };
  };
  await Promise.all([f.core.syncAll(), f.core.syncAll(), f.core.syncAll()]);
  assert.equal(f.refreshes().length, 1);
  assert.notEqual(refreshedBeforePut.access_token, old.access_token);
  assert.notEqual(refreshedBeforePut.refresh_token, old.refresh_token);
  assert.equal(refreshedBeforePut.expires_at, f.time + 7_200_000);
  assert.equal(f.core.getLink(1).status, 'pending');
  assert.equal(f.metadata().length, 2);
  await f.restart();
  f.advance(f.core.getLink(1).nextRetryAt - f.time);
  f.controls.metadata = null;
  await f.core.syncAll();
  assert.equal(f.refreshes().length, 1);
  assert.equal(f.metadata().at(-1).authorization, 'Bearer access:111:r1');
  assert.equal(f.core.getLink(1).status, 'synced');
});

test('unexpected access rejection refreshes once and a revoked refresh requires relinking without retry storm', async (t) => {
  const f = await fixture(t);
  await f.core.link(1, '111:first');
  f.advance(60_000);
  let attempts = 0;
  f.controls.metadata = async () => ({ status: ++attempts === 1 ? 401 : 200, body: {} });
  await f.core.syncAll();
  assert.equal(f.refreshes().length, 1);
  assert.equal(attempts, 2);
  assert.equal(f.core.getLink(1).status, 'synced');
  f.advance(3_600_000);
  f.controls.refresh = async () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'secret-context' } });
  await f.core.syncAll();
  assert.equal(f.core.getLink(1).status, 'relink_required');
  assert.equal(f.core.getLink(1).lastError, 'discord_invalid_grant');
  assert.equal(f.row().access_token, null);
  assert.equal(f.row().refresh_token, null);
  const count = f.requests.length;
  f.advance(DAY);
  await f.core.syncAll();
  assert.equal(f.requests.length, count);
  f.controls.refresh = null;
  f.controls.metadata = null;
  await f.core.link(1, '111:relink');
  assert.equal(f.core.getLink(1).status, 'synced');
});

test('rate limits persist Retry-After and global cooldown across restart and all users', async (t) => {
  const f = await fixture(t);
  f.controls.metadata = async () => ({ status: 429, body: { retry_after: 120, global: true }, headers: { 'retry-after': '180' } });
  const result = await f.core.link(1, '111:first');
  assert.equal(result.status, 'pending');
  assert.equal(result.nextRetryAt, f.time + 180_000);
  const count = f.requests.length;
  await f.restart();
  await f.core.syncAll();
  await assert.rejects(f.core.link(2, '222:first'), { code: 'discord_rate_limited' });
  assert.equal(f.requests.length, count);
  f.advance(179_999);
  await f.core.syncAll();
  assert.equal(f.requests.length, count);
  f.advance(1);
  f.controls.metadata = null;
  await f.core.syncAll();
  assert.equal(f.core.getLink(1).status, 'synced');
  await f.core.link(2, '222:first');
  assert.equal(f.core.getLink(2).status, 'synced');
});

test('HTTP timeout on an actual stalled local response leaves a retryable link, not a hung sync', async (t) => {
  const f = await fixture(t, { httpTimeoutMs: 250 });
  f.controls.metadata = async () => null;
  const result = await f.core.link(1, '111:first');
  assert.equal(result.status, 'pending');
  assert.equal(result.lastError, 'discord_unavailable');
  assert.ok(result.nextRetryAt > f.time);
  assert.ok(f.row().access_token);
});

test('encryption binds ciphertext to user and token kind; transplanted credentials never reach Discord', async (t) => {
  const f = await fixture(t);
  await f.core.link(1, '111:first');
  await f.core.link(2, '222:first');
  f.inspector.prepare('UPDATE links SET access_token = ? WHERE user_id = 1').run(f.row(2).access_token);
  f.advance(60_000);
  const before = f.metadata().length;
  await f.core.syncAll();
  assert.equal(f.core.getLink(1).status, 'relink_required');
  assert.equal(f.core.getLink(1).lastError, 'token_decryption_failed');
  assert.equal(f.metadata().length, before + 1);
  assert.equal(f.metadata().at(-1).authorization, 'Bearer access:222:222:first');
  const bob = f.row(2);
  f.inspector.prepare('UPDATE links SET access_token = ? WHERE user_id = 2').run(bob.refresh_token);
  f.advance(60_000);
  await f.core.syncAll();
  assert.equal(f.core.getLink(2).lastError, 'token_decryption_failed');
});

test('inactive or deleted source accounts publish zero and lose sessions instead of retaining positive metadata', async (t) => {
  const f = await fixture(t);
  f.award(1, 10000, 'identical');
  const session = f.core.createSession(1);
  await f.core.link(1, '111:first');
  f.source.prepare("UPDATE users SET status = 'revoked' WHERE id = 1").run();
  f.advance(60_000);
  await f.core.syncAll();
  assert.equal(JSON.parse(f.metadata().at(-1).body).metadata.credits, '0');
  assert.equal(f.core.getSession(session), null);
  await assert.rejects(f.core.link(1, '111:again'), { code: 'account_inactive' });
  f.source.prepare('DELETE FROM users WHERE id = 1').run();
  f.advance(60_000);
  await f.core.syncAll();
  assert.equal(JSON.parse(f.metadata().at(-1).body).metadata.credits, '0');
  assert.equal(JSON.parse(f.metadata().at(-1).body).platform_username, null);
});

test('unlink publishes zero before revoking and deleting credentials', async (t) => {
  const f = await fixture(t);
  f.award(1, 400, 'review');
  await f.core.link(1, '111:first');
  const before = f.requests.length;
  assert.equal(await f.core.unlink(1), null);
  const requests = f.requests.slice(before);
  assert.deepEqual(requests.map((request) => request.path), [
    '/api/v10/users/@me/applications/123456/role-connection', '/oauth2/token/revoke',
  ]);
  assert.equal(JSON.parse(requests[0].body).metadata.credits, '0');
  assert.equal(new URLSearchParams(requests[1].body).get('token_type_hint'), 'refresh_token');
  assert.equal(f.row(), undefined);
  await f.core.link(2, '111:now-free');
  assert.equal(f.core.getLink(2).discordId, '111');
});

test('failed unlink is persisted and retried without republishing cleared metadata or bypassing backoff', async (t) => {
  const f = await fixture(t);
  await f.core.link(1, '111:first');
  f.controls.revoke = async () => ({ status: 503, body: {} });
  const status = await f.core.unlink(1);
  assert.equal(status.status, 'unlink_pending');
  assert.equal(f.row().metadata_cleared, 1);
  assert.equal(status.credits, '0');
  const count = f.requests.length;
  await f.core.unlink(1);
  assert.equal(f.requests.length, count);
  await assert.rejects(f.core.link(1, '111:cannot-replace'), { code: 'unlink_in_progress' });
  await f.restart();
  f.controls.revoke = null;
  f.advance(status.nextRetryAt - f.time);
  await f.core.syncAll();
  assert.equal(f.core.getLink(1), null);
  assert.equal(f.requests.length, count + 1);
});

test('malformed refresh does not replace saved credentials and scopes cannot silently disappear', async (t) => {
  const f = await fixture(t);
  await f.core.link(1, '111:first');
  const old = f.row();
  f.advance(3_600_000);
  f.controls.refresh = async () => ({ status: 200, body: { access_token: 'new', token_type: 'Bearer', expires_in: -1 } });
  await f.core.syncAll();
  assert.equal(f.core.getLink(1).status, 'pending');
  assert.equal(f.row().refresh_token, old.refresh_token);
  assert.equal(f.row().access_token, old.access_token);
  f.advance(f.core.getLink(1).nextRetryAt - f.time);
  f.controls.refresh = async () => ({ status: 200, body: { access_token: 'new', refresh_token: 'new-refresh',
    token_type: 'Bearer', expires_in: 7200, scope: 'identify' } });
  await f.core.syncAll();
  assert.equal(f.core.getLink(1).status, 'relink_required');
  assert.equal(f.core.getLink(1).lastError, 'discord_scope_missing');
});

test('authorization outages preserve a per-user cooldown across restart before any link exists', async (t) => {
  const f = await fixture(t);
  f.controls.exchange = async () => ({ status: 503, body: { error: 'unavailable' } });
  await assert.rejects(f.core.link(1, '111:first'), { code: 'discord_request_failed' });
  assert.equal(f.core.getLink(1), null);
  const count = f.requests.length;
  await f.restart();
  await assert.rejects(f.core.link(1, '111:retry'), { code: 'discord_rate_limited' });
  assert.equal(f.requests.length, count);
  f.advance(30_000);
  f.controls.exchange = null;
  await f.core.link(1, '111:later');
  assert.equal(f.core.getLink(1).status, 'synced');
});

test('a failed cleanup that needs reauthorization resumes zeroing instead of restoring positive credits', async (t) => {
  const f = await fixture(t);
  f.award(1, 10000, 'identical');
  await f.core.link(1, '111:first');
  f.controls.metadata = async () => ({ status: 403, body: {} });
  const failed = await f.core.unlink(1);
  assert.equal(failed.status, 'relink_required');
  assert.equal(f.row().unlink_requested, 1);
  await assert.rejects(f.core.unlink(1), { code: 'discord_relink_before_unlink' });
  f.controls.metadata = null;
  assert.equal(await f.core.link(1, '111:finish-cleanup'), null);
  assert.equal(JSON.parse(f.metadata().at(-1).body).metadata.credits, '0');
  assert.equal(f.row(), undefined);
});

test('source query failure preserves pending state without publishing guessed zero', async (t) => {
  const f = await fixture(t);
  await f.core.link(1, '111:first');
  const count = f.metadata().length;
  f.source.exec('DROP TABLE credit_ledger');
  f.advance(60_000);
  await f.core.syncAll();
  assert.equal(f.core.getLink(1).status, 'pending');
  assert.equal(f.core.getLink(1).lastError, 'source_unavailable');
  assert.equal(f.metadata().length, count);
});

test('freshly rotated but rejected access tokens do not cause a second refresh in one sync', async (t) => {
  const f = await fixture(t);
  await f.core.link(1, '111:first');
  f.advance(3_600_000);
  f.controls.metadata = async () => ({ status: 401, body: {} });
  await f.core.syncAll();
  assert.equal(f.refreshes().length, 1);
  assert.equal(f.core.getLink(1).status, 'relink_required');
});

test('source and service database paths cannot alias even through a hard link', async (t) => {
  const f = await fixture(t);
  assert.throws(() => createCore({ ...f.config, databasePath: f.config.sourceDbPath }), /must differ/);
  const alias = join(f.config.databasePath, '..', 'source-alias.sqlite');
  linkSync(f.config.sourceDbPath, alias);
  assert.throws(() => createCore({ ...f.config, databasePath: alias }), /must differ/);
});

test('Clank credential verification does not follow redirects or forward its bearer token', async (t) => {
  const f = await fixture(t);
  f.controls.me = { status: 302, body: {}, headers: { location: '/unexpected-token-recipient' } };
  await assert.rejects(f.core.verifyClankToken('td_redirect_secret'), { code: 'clank_unavailable' });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, '/api/me');
});

test('a refresh response can preserve its existing refresh token and omitted unchanged scope', async (t) => {
  const f = await fixture(t);
  await f.core.link(1, '111:first');
  f.advance(3_600_000);
  f.controls.refresh = async () => ({ status: 200, body: {
    access_token: 'replacement-access', token_type: 'Bearer', expires_in: 7200,
  } });
  await f.core.syncAll();
  assert.equal(f.core.getLink(1).status, 'synced');
  assert.equal(f.metadata().at(-1).authorization, 'Bearer replacement-access');
  f.advance(3_600_000);
  f.controls.refresh = null;
  await f.core.syncAll();
  const refreshRequest = new URLSearchParams(f.refreshes().at(-1).body);
  assert.equal(refreshRequest.get('refresh_token'), 'refresh:111:111:first');
  assert.equal(f.core.getLink(1).status, 'synced');
});
