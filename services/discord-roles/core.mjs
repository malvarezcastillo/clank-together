import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STATE_TTL_MS = 10 * 60_000;
const REFRESH_WINDOW_MS = 60 * 60_000;
const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_states (
    state_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS oauth_states_session ON oauth_states(session_hash);
  CREATE TABLE IF NOT EXISTS links (
    user_id INTEGER PRIMARY KEY, discord_id TEXT NOT NULL UNIQUE,
    access_token TEXT, refresh_token TEXT, expires_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'synced', 'relink_required', 'unlink_pending')),
    last_synced_at INTEGER, next_retry_at INTEGER NOT NULL, last_error TEXT,
    failures INTEGER NOT NULL DEFAULT 0, credits TEXT,
    unlink_requested INTEGER NOT NULL DEFAULT 0, metadata_cleared INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS cooldowns (key TEXT PRIMARY KEY, until_at INTEGER NOT NULL);
`;

function failure(status, code, extra = {}) {
  return Object.assign(new Error(code.replaceAll('_', ' ')), { status, code }, extra);
}

const digest = (value) => createHash('sha256').update(value).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');
const validToken = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export function createCore(config) {
  if (!Buffer.isBuffer(config.encryptionKey) || config.encryptionKey.length !== 32) {
    throw new Error('encryptionKey must contain exactly 32 bytes');
  }
  if (resolve(config.sourceDbPath) === resolve(config.databasePath)) throw new Error('Source and service databases must differ');
  if (existsSync(config.databasePath)) {
    const sourceFile = statSync(config.sourceDbPath, { bigint: true });
    const serviceFile = statSync(config.databasePath, { bigint: true });
    if (sourceFile.dev === serviceFile.dev && sourceFile.ino === serviceFile.ino) throw new Error('Source and service databases must differ');
  }
  const now = config.now ?? Date.now;
  const fetchRequest = config.fetch ?? globalThis.fetch;
  const apiBase = config.discordApiBase ?? 'https://discord.com/api/v10';
  const oauthBase = config.discordOauthBase ?? 'https://discord.com/api/oauth2';
  const sessionTtl = config.sessionTtlMs ?? 7 * 24 * 60 * 60_000;
  const syncInterval = config.syncIntervalMs ?? 60_000;
  const httpTimeout = config.httpTimeoutMs ?? 10_000;
  const key = Buffer.from(config.encryptionKey);
  // A normal read-only connection sees committed WAL entries; immutable=1 would not.
  const source = new DatabaseSync(config.sourceDbPath, { readOnly: true });
  let db;
  let sourceUser;
  let sourceIdentity;
  try {
    source.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');
    sourceUser = source.prepare(`
      SELECT u.id, u.name, u.status,
        CAST(COALESCE((SELECT SUM(amount) FROM credit_ledger WHERE user_id = u.id AND amount > 0
          AND reason IN ('identical', 'confirmed', 'skip', 'submitted', 'review')), 0) AS TEXT) AS credits
      FROM users u WHERE u.id = ?
    `);
    sourceIdentity = source.prepare('SELECT id, name, status FROM users WHERE name = ? COLLATE NOCASE');
    mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(config.databasePath);
    db.exec(SCHEMA);
  } catch (error) {
    source.close();
    db?.close();
    throw error;
  }
  const sql = new Map();
  const statement = (text) => {
    if (!sql.has(text)) sql.set(text, db.prepare(text));
    return sql.get(text);
  };
  const locks = new Map();
  let closing = false;
  let closed = false;

  function getSourceUser(userId) {
    const row = sourceUser.get(userId);
    return row ? { id: row.id, name: row.name, credits: row.credits, status: row.status } : null;
  }

  function requireActive(userId) {
    const user = getSourceUser(userId);
    if (!user || user.status !== 'active') throw failure(403, 'account_inactive');
    return user;
  }

  function encrypt(value, userId, discordId, kind) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`discord-roles:${userId}:${discordId}:${kind}`));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  }

  function decrypt(value, row, kind) {
    try {
      const [version, nonce, tag, encrypted, extra] = value.split('.');
      if (version !== 'v1' || !nonce || !tag || !encrypted || extra) throw new Error('Invalid envelope');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
      decipher.setAAD(Buffer.from(`discord-roles:${row.user_id}:${row.discord_id}:${kind}`));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      throw failure(409, 'token_decryption_failed', { relink: true });
    }
  }

  function cooldown(name) {
    return statement('SELECT until_at FROM cooldowns WHERE key = ?').get(name)?.until_at ?? 0;
  }

  function pause(name, until) {
    statement('INSERT INTO cooldowns (key, until_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET until_at = MAX(until_at, excluded.until_at)').run(name, until);
  }

  function retryDelay(response, body) {
    const values = [1000];
    for (const value of [body?.retry_after, response.headers.get('x-ratelimit-reset-after')]) {
      if (value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0) values.push(Number(value) * 1000);
    }
    const header = response.headers.get('retry-after');
    if (header !== null) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) values.push(seconds * 1000);
      else if (Number.isFinite(Date.parse(header))) values.push(Date.parse(header) - now());
    }
    return values.length === 1 ? 60_000 : Math.ceil(Math.max(...values));
  }

  async function request(url, options = {}, discord = true) {
    const until = discord ? cooldown('discord') : 0;
    if (until > now()) throw failure(429, 'discord_rate_limited', { retryAt: until });
    let response;
    let body;
    try {
      response = await fetchRequest(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(httpTimeout) });
      const text = await response.text();
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    } catch {
      throw failure(503, discord ? 'discord_unavailable' : 'clank_unavailable');
    }
    if (response.status === 429) {
      const retryAt = now() + retryDelay(response, body);
      if (discord) pause('discord', retryAt);
      throw failure(429, discord ? 'discord_rate_limited' : 'clank_rate_limited', { retryAt });
    }
    if (!response.ok) {
      if (discord && body?.error === 'invalid_grant') throw failure(401, 'discord_invalid_grant', { relink: true });
      if (response.status === 401 || response.status === 403) {
        throw failure(response.status, discord ? 'discord_unauthorized' : 'invalid_clank_token');
      }
      throw failure(502, discord ? 'discord_request_failed' : 'clank_request_failed');
    }
    return body;
  }

  async function verifyClankToken(token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token)) {
      throw failure(401, 'invalid_clank_token');
    }
    const me = await request(`${config.clankApiUrl.replace(/\/+$/, '')}/api/me`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    }, false);
    if (me?.via !== 'token' || typeof me.name !== 'string' || !me.name) throw failure(401, 'invalid_clank_token');
    // /api/me deliberately has no ID. Resolve its authenticated name against the mounted source.
    const user = sourceIdentity.get(me.name);
    if (!user || user.status !== 'active') throw failure(403, 'account_inactive');
    return { id: user.id, name: user.name };
  }

  function pruneSessions() {
    statement('DELETE FROM sessions WHERE expires_at <= ?').run(now());
    statement('DELETE FROM oauth_states WHERE expires_at <= ?').run(now());
  }

  function createSession(userId) {
    requireActive(userId);
    pruneSessions();
    const token = randomToken();
    statement('INSERT INTO sessions (token_hash, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)').run(digest(token), userId, randomToken(), now() + sessionTtl);
    return token;
  }

  function deleteSession(token) {
    if (validToken(token)) statement('DELETE FROM sessions WHERE token_hash = ?').run(digest(token));
  }

  function getSession(token) {
    if (!validToken(token)) return null;
    const row = statement('SELECT user_id, csrf, expires_at FROM sessions WHERE token_hash = ?').get(digest(token));
    if (!row) return null;
    if (row.expires_at <= now() || getSourceUser(row.user_id)?.status !== 'active') {
      deleteSession(token);
      return null;
    }
    return { userId: row.user_id, csrf: row.csrf };
  }

  function createState(token) {
    const session = getSession(token);
    if (!session) throw failure(401, 'session_required');
    pruneSessions();
    const state = randomToken();
    const hash = digest(token);
    statement('DELETE FROM oauth_states WHERE session_hash = ?').run(hash);
    statement('INSERT INTO oauth_states (state_hash, session_hash, user_id, expires_at) VALUES (?, ?, ?, ?)').run(digest(state), hash, session.userId, now() + STATE_TTL_MS);
    return state;
  }

  function consumeState(token, state) {
    if (!validToken(state)) return null;
    const session = getSession(token);
    if (!session) return null;
    return statement('DELETE FROM oauth_states WHERE state_hash = ? AND session_hash = ? AND user_id = ? AND expires_at > ? RETURNING user_id')
      .get(digest(state), digest(token), session.userId, now())?.user_id ?? null;
  }

  function getRow(userId) {
    return statement('SELECT * FROM links WHERE user_id = ?').get(userId);
  }

  function getLink(userId) {
    const row = getRow(userId);
    return row ? {
      discordId: row.discord_id, status: row.status, lastSyncedAt: row.last_synced_at,
      nextRetryAt: row.next_retry_at, lastError: row.last_error, credits: row.credits,
    } : null;
  }

  async function serialize(userId, work) {
    if (closing) throw failure(503, 'service_closing');
    const pending = (locks.get(userId) ?? Promise.resolve()).catch(() => {}).then(work);
    locks.set(userId, pending);
    try { return await pending; } finally { if (locks.get(userId) === pending) locks.delete(userId); }
  }

  function tokenData(body, previousRefresh = null, requireScope = false) {
    const scopes = typeof body?.scope === 'string' ? new Set(body.scope.split(/\s+/)) : null;
    if ((requireScope && !scopes) || (scopes && (!scopes.has('identify') || !scopes.has('role_connections.write')))) {
      throw failure(403, 'discord_scope_missing', { relink: true });
    }
    if (typeof body?.access_token !== 'string' || !body.access_token || String(body.token_type).toLowerCase() !== 'bearer'
      || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 365 * 24 * 3600) {
      throw failure(502, 'discord_invalid_token_response');
    }
    const refresh = body.refresh_token ?? previousRefresh;
    if (typeof refresh !== 'string' || !refresh) throw failure(502, 'discord_invalid_token_response');
    return { access: body.access_token, refresh, expiresAt: now() + Math.floor(body.expires_in * 1000) };
  }

  async function exchange(parameters) {
    return request(`${oauthBase}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: config.discordClientId, client_secret: config.discordClientSecret, ...parameters }),
    });
  }

  async function refresh(row) {
    const previous = decrypt(row.refresh_token, row, 'refresh');
    const tokens = tokenData(await exchange({ grant_type: 'refresh_token', refresh_token: previous }), previous);
    // Persist rotated credentials before any metadata request can fail or the process can restart.
    statement('UPDATE links SET access_token = ?, refresh_token = ?, expires_at = ? WHERE user_id = ?').run(
      encrypt(tokens.access, row.user_id, row.discord_id, 'access'), encrypt(tokens.refresh, row.user_id, row.discord_id, 'refresh'), tokens.expiresAt, row.user_id,
    );
    return tokens.access;
  }

  async function publish(row, credits, name) {
    const refreshed = row.expires_at <= now() + REFRESH_WINDOW_MS;
    let access = refreshed ? await refresh(row) : decrypt(row.access_token, row, 'access');
    const send = () => request(`${apiBase}/users/@me/applications/${config.discordClientId}/role-connection`, {
      method: 'PUT', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ platform_name: 'rodecomp.online', platform_username: name, metadata: { credits } }),
    });
    try { await send(); } catch (error) {
      if (error.code !== 'discord_unauthorized') throw error;
      if (refreshed) {
        error.relink = true;
        throw error;
      }
      // An unexpectedly invalid access token gets one refresh, never an unbounded retry loop.
      access = await refresh(getRow(row.user_id));
      try { await send(); } catch (retryError) {
        if (retryError.code === 'discord_unauthorized') retryError.relink = true;
        throw retryError;
      }
    }
  }

  function recordFailure(row, error) {
    const relink = error.relink === true;
    const failures = Math.min(row.failures + 1, 20);
    const nextRetry = Math.max(error.retryAt ?? 0, cooldown('discord'), now() + Math.min(3_600_000, 30_000 * 2 ** (failures - 1)));
    const code = typeof error.code === 'string' && /^(discord_|token_|source_)/.test(error.code) ? error.code : 'source_unavailable';
    statement(`UPDATE links SET status = ?, last_error = ?, failures = ?, next_retry_at = ?,
      access_token = CASE WHEN ? THEN NULL ELSE access_token END,
      refresh_token = CASE WHEN ? THEN NULL ELSE refresh_token END WHERE user_id = ?`).run(
      relink ? 'relink_required' : row.unlink_requested ? 'unlink_pending' : 'pending', code, failures, nextRetry, relink ? 1 : 0, relink ? 1 : 0, row.user_id,
    );
  }

  async function synchronize(userId) {
    const row = getRow(userId);
    if (!row || row.status === 'relink_required' || row.next_retry_at > now()) return getLink(userId);
    try {
      const user = getSourceUser(userId);
      if (row.unlink_requested) {
        if (!row.metadata_cleared) {
          await publish(row, '0', user?.name ?? null);
          statement('UPDATE links SET metadata_cleared = 1, credits = ?, last_synced_at = ? WHERE user_id = ?').run('0', now(), userId);
        }
        const current = getRow(userId);
        await request(`${oauthBase}/token/revoke`, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: config.discordClientId, client_secret: config.discordClientSecret,
            token: decrypt(current.refresh_token, current, 'refresh'), token_type_hint: 'refresh_token' }),
        });
        statement('DELETE FROM links WHERE user_id = ?').run(userId);
      } else {
        const credits = user?.status === 'active' ? user.credits : '0';
        await publish(row, credits, user?.name ?? null);
        statement("UPDATE links SET status = 'synced', last_synced_at = ?, next_retry_at = ?, last_error = NULL, failures = 0, credits = ? WHERE user_id = ?")
          .run(now(), now() + syncInterval, credits, userId);
      }
    } catch (error) {
      recordFailure(row, error);
    }
    return getLink(userId);
  }

  async function link(userId, code) {
    if (typeof code !== 'string' || !code || code.length > 4096) throw failure(400, 'invalid_oauth_code');
    return serialize(userId, async () => {
      requireActive(userId);
      const existing = getRow(userId);
      if (existing?.unlink_requested && existing.status !== 'relink_required') throw failure(409, 'unlink_in_progress');
      const retryAt = Math.max(cooldown(`oauth:${userId}`), cooldown('discord'),
        existing?.status === 'pending' && existing.failures > 0 ? existing.next_retry_at : 0);
      if (retryAt > now()) throw failure(429, 'discord_rate_limited', { retryAt });
      let tokens;
      let identity;
      try {
        tokens = tokenData(await exchange({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }), null, true);
        identity = await request(`${apiBase}/users/@me`, { headers: { authorization: `Bearer ${tokens.access}` } });
      } catch (error) {
        if (error.status >= 500 || error.status === 429) pause(`oauth:${userId}`, Math.max(error.retryAt ?? 0, now() + 30_000));
        throw error;
      }
      if (typeof identity?.id !== 'string' || !/^\d{1,20}$/.test(identity.id)) throw failure(502, 'discord_invalid_identity');
      requireActive(userId);
      if (existing && existing.discord_id !== identity.id) throw failure(409, 'unlink_previous_discord_first');
      const owner = statement('SELECT user_id FROM links WHERE discord_id = ?').get(identity.id);
      if (owner && owner.user_id !== userId) throw failure(409, 'discord_already_linked');
      try {
        statement(`INSERT INTO links (user_id, discord_id, access_token, refresh_token, expires_at, status, next_retry_at)
          VALUES (?, ?, ?, ?, ?, 'pending', ?)
          ON CONFLICT(user_id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
            expires_at = excluded.expires_at, status = 'pending', next_retry_at = excluded.next_retry_at,
            last_error = NULL, failures = 0, metadata_cleared = 0`).run(
          userId, identity.id, encrypt(tokens.access, userId, identity.id, 'access'), encrypt(tokens.refresh, userId, identity.id, 'refresh'), tokens.expiresAt, now(),
        );
      } catch (error) {
        if (error.errcode === 2067 || String(error.code).startsWith('SQLITE_CONSTRAINT')) throw failure(409, 'discord_already_linked');
        throw error;
      }
      return synchronize(userId);
    });
  }

  async function syncAll() {
    if (closing) return;
    const rows = statement("SELECT user_id FROM links WHERE status != 'relink_required' AND next_retry_at <= ? ORDER BY next_retry_at, user_id").all(now());
    for (const row of rows) {
      if (closing) break;
      await serialize(row.user_id, () => synchronize(row.user_id));
    }
  }

  async function unlink(userId) {
    return serialize(userId, async () => {
      const row = getRow(userId);
      if (!row) return null;
      if (row.status === 'relink_required') {
        // Revoked/undecryptable credentials cannot perform remote cleanup. Retain the reservation
        // until the user reauthorizes this same Discord account, rather than orphaning its metadata.
        throw failure(409, 'discord_relink_before_unlink');
      }
      if (!row.unlink_requested) {
        statement("UPDATE links SET unlink_requested = 1, status = 'unlink_pending', next_retry_at = ? WHERE user_id = ?")
          .run(row.failures > 0 ? Math.max(now(), row.next_retry_at) : now(), userId);
      }
      return synchronize(userId);
    });
  }

  async function close() {
    if (closed) return;
    closing = true;
    await Promise.allSettled([...locks.values()]);
    if (!closed) {
      closed = true;
      source.close();
      db.close();
      key.fill(0);
    }
  }

  return { verifyClankToken, getSourceUser, createSession, getSession, deleteSession, createState, consumeState, link, syncAll, getLink, unlink, close };
}
