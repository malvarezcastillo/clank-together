// Accounts, passwords, browser sessions and API tokens.
//
//   register -> pending (or active with auto-approval) --admin approves--> active --admin revokes--> revoked
//
// Only active users can do anything. Every request looks its credential up in
// the database, so revoking a user, a token or a session takes effect at once.
// API tokens (for agents) never expire; browser sessions do.

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { now } from './db.js';

const scrypt = promisify(crypto.scrypt);

// Roles in increasing order of privilege; each role includes the ones before it.
export const ROLES = ['contributor', 'reviewer', 'maintainer', 'admin'];

export function hasRole(user, minRole) {
  return ROLES.indexOf(user.role) >= ROLES.indexOf(minRole);
}

export class AccountError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const NAME_RE = /^[A-Za-z0-9_.-]{2,32}$/;
const SESSION_MS = 7 * 24 * 3600_000;
const MAX_TOKENS_PER_USER = 10;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (prefix) => prefix + crypto.randomBytes(32).toString('base64url');

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = (stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(key, expected);
}

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 12) throw new AccountError(400, 'password must be at least 12 characters');
  if (pw.length > 200) throw new AccountError(400, 'password is too long');
}

function checkName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new AccountError(400, 'username must be 2-32 characters of A-Z a-z 0-9 _ . -');
}

// Used when a login names a user that does not exist, so timing does not reveal it.
let dummyHash = null;

export class Accounts {
  constructor(store) {
    this.store = store;
  }

  registrationSettings() {
    return { autoApprove: this.store.getMeta('auto_approve_accounts') === 'true' };
  }

  setRegistrationSettings(autoApprove, adminId) {
    if (typeof autoApprove !== 'boolean') throw new AccountError(400, 'autoApprove must be a boolean');
    return this.store.tx(() => {
      this.store.setMeta('auto_approve_accounts', autoApprove);
      this.store.event('registration_settings', adminId, { autoApprove });
      return this.registrationSettings();
    });
  }

  // --- self service

  async register(name, password) {
    checkName(name);
    checkPassword(password);
    if (this.byName(name)) throw new AccountError(409, 'username is taken');
    const hash = await hashPassword(password);
    return this.store.tx(() => {
      const { autoApprove } = this.registrationSettings();
      const status = autoApprove ? 'active' : 'pending';
      const createdAt = now();
      this.store.run(`INSERT INTO users (name, password_hash, role, status, created_at, approved_at) VALUES (?, ?, 'contributor', ?, ?, ?)`, name, hash, status, createdAt, autoApprove ? createdAt : null);
      this.store.event('register', null, { name });
      if (autoApprove) this.store.event('user_approved', null, { name, automatic: true });
      return { name, status };
    });
  }

  async login(name, password) {
    const u = typeof name === 'string' ? this.store.get('SELECT * FROM users WHERE name = ?', name) : null;
    dummyHash ??= await hashPassword(crypto.randomBytes(16).toString('hex'));
    const ok = await verifyPassword(String(password ?? ''), u?.password_hash ?? dummyHash);
    if (!u || !ok) throw new AccountError(401, 'wrong username or password');
    if (u.status === 'pending') throw new AccountError(403, 'your account is waiting for approval by an admin');
    if (u.status !== 'active') throw new AccountError(403, 'your account has been revoked');
    const token = randomToken('tds_');
    this.store.run('INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)', u.id, sha256(token), now(), now() + SESSION_MS);
    this.store.run('DELETE FROM sessions WHERE expires_at < ?', now());
    this.store.event('login', u.id);
    return { token, maxAgeSeconds: SESSION_MS / 1000, user: this.publicUser(u) };
  }

  logout(sessionToken) {
    this.store.run('DELETE FROM sessions WHERE token_hash = ?', sha256(sessionToken));
  }

  async changePassword(userId, current, next) {
    const u = this.store.get('SELECT * FROM users WHERE id = ?', userId);
    if (!(await verifyPassword(String(current ?? ''), u.password_hash))) throw new AccountError(403, 'current password is wrong');
    checkPassword(next);
    this.store.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(next), userId);
    // Log out everywhere; API tokens are unaffected.
    this.store.run('DELETE FROM sessions WHERE user_id = ?', userId);
  }

  // --- credential checks (every request)

  userBySession(token) {
    if (typeof token !== 'string' || !token.startsWith('tds_')) return null;
    const u = this.store.get(
      `SELECT u.id, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`,
      sha256(token),
      now(),
    );
    return u ? { ...u, via: 'session' } : null;
  }

  userByApiToken(token) {
    if (typeof token !== 'string' || !token.startsWith('td_')) return null;
    const row = this.store.get(
      `SELECT u.id, u.name, u.role, t.id AS token_id, t.last_used_at FROM api_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL AND u.status = 'active'`,
      sha256(token),
    );
    if (!row) return null;
    if (!row.last_used_at || now() - row.last_used_at > 60_000) this.store.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), row.token_id);
    return { id: row.id, name: row.name, role: row.role, tokenId: row.token_id, via: 'token' };
  }

  // --- API tokens

  createApiToken(userId, label) {
    const clean = String(label ?? '').trim().slice(0, 60) || 'agent';
    const active = this.store.get('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL', userId).n;
    if (active >= MAX_TOKENS_PER_USER) throw new AccountError(409, `you already have ${MAX_TOKENS_PER_USER} active tokens; revoke one first`);
    const token = randomToken('td_');
    const r = this.store.run('INSERT INTO api_tokens (user_id, token_hash, label, created_at) VALUES (?, ?, ?, ?)', userId, sha256(token), clean, now());
    this.store.event('token_created', userId, { token: Number(r.lastInsertRowid), label: clean });
    return { id: Number(r.lastInsertRowid), label: clean, token };
  }

  listApiTokens(userId) {
    return this.store.all('SELECT id, label, created_at, last_used_at, revoked_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC', userId);
  }

  revokeApiToken(userId, tokenId) {
    const r = this.store.run('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', now(), tokenId, userId);
    if (!Number(r.changes)) throw new AccountError(404, 'no such active token');
    this.store.event('token_revoked', userId, { token: tokenId });
  }

  // --- administration

  byName(name) {
    return this.store.get('SELECT * FROM users WHERE name = ?', name) ?? null;
  }

  requireUser(name) {
    const u = this.byName(name);
    if (!u) throw new AccountError(404, `no user "${name}"`);
    return u;
  }

  publicUser(u) {
    return { name: u.name, role: u.role, status: u.status };
  }

  listUsers(status) {
    return this.store.all(
      `SELECT u.name, u.role, u.status, u.created_at, u.approved_at, u.revoked_at, a.name AS approved_by,
              (SELECT COUNT(*) FROM api_tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL) AS active_tokens
         FROM users u LEFT JOIN users a ON a.id = u.approved_by
        ${status ? 'WHERE u.status = ?' : ''} ORDER BY u.status = 'pending' DESC, u.id`,
      ...(status ? [status] : []),
    );
  }

  /** Creates an active account directly (server CLI bootstrap). */
  async createUser(name, role, password) {
    checkName(name);
    checkPassword(password);
    if (!ROLES.includes(role)) throw new AccountError(400, `role must be one of ${ROLES.join(', ')}`);
    if (this.byName(name)) throw new AccountError(409, `user "${name}" already exists`);
    this.store.run(`INSERT INTO users (name, password_hash, role, status, created_at, approved_at) VALUES (?, ?, ?, 'active', ?, ?)`, name, await hashPassword(password), role, now(), now());
    return { name, role, status: 'active' };
  }

  async setPassword(name, password) {
    const u = this.requireUser(name);
    checkPassword(password);
    this.store.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), u.id);
    this.store.run('DELETE FROM sessions WHERE user_id = ?', u.id);
  }

  approve(name, adminId) {
    const u = this.requireUser(name);
    if (u.status !== 'pending') throw new AccountError(409, `${name} is ${u.status}, not pending`);
    this.store.run(`UPDATE users SET status = 'active', approved_by = ?, approved_at = ? WHERE id = ?`, adminId, now(), u.id);
    this.store.event('user_approved', adminId, { name });
    return this.publicUser({ ...u, status: 'active' });
  }

  /** Deletes a pending registration. */
  reject(name, adminId) {
    const u = this.requireUser(name);
    if (u.status !== 'pending') throw new AccountError(409, `${name} is ${u.status}; revoke active accounts instead`);
    this.store.run('DELETE FROM users WHERE id = ?', u.id);
    this.store.event('user_rejected', adminId, { name });
    return { name, rejected: true };
  }

  /** Locks the account: all API tokens and sessions stop working, leases are released. */
  revoke(name, adminId) {
    return this.store.tx(() => {
      const u = this.requireUser(name);
      if (u.role === 'admin' && u.status === 'active' && this.activeAdmins() <= 1) throw new AccountError(409, 'refusing to revoke the last active admin');
      this.store.run(`UPDATE users SET status = 'revoked', revoked_at = ? WHERE id = ?`, now(), u.id);
      this.store.run('UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now(), u.id);
      this.store.run('DELETE FROM sessions WHERE user_id = ?', u.id);
      const released = this.store.run(
        `UPDATE tasks SET state = CASE WHEN best_attempt IS NULL THEN 'open' ELSE 'needs_cleanup' END,
                lease_user = NULL, lease_expires = NULL, updated_at = ? WHERE lease_user = ? AND state = 'leased'`,
        now(),
        u.id,
      ).changes;
      this.store.event('user_revoked', adminId, { name });
      return { name, status: 'revoked', releasedLeases: Number(released) };
    });
  }

  /** Re-enables a revoked account. Its old tokens stay revoked; the user creates new ones. */
  reinstate(name, adminId) {
    const u = this.requireUser(name);
    if (u.status !== 'revoked') throw new AccountError(409, `${name} is ${u.status}`);
    this.store.run(`UPDATE users SET status = 'active', revoked_at = NULL WHERE id = ?`, u.id);
    this.store.event('user_reinstated', adminId, { name });
    return this.publicUser({ ...u, status: 'active' });
  }

  setRole(name, role, adminId) {
    if (!ROLES.includes(role)) throw new AccountError(400, `role must be one of ${ROLES.join(', ')}`);
    return this.store.tx(() => {
      const u = this.requireUser(name);
      if (u.role === 'admin' && role !== 'admin' && u.status === 'active' && this.activeAdmins() <= 1) throw new AccountError(409, 'refusing to demote the last active admin');
      this.store.run('UPDATE users SET role = ? WHERE id = ?', role, u.id);
      this.store.event('user_role', adminId, { name, role });
      return { name, role };
    });
  }

  /** Renames an account. Sessions and tokens belong to the account, so they keep working. */
  rename(name, newName, adminId) {
    checkName(newName);
    return this.store.tx(() => {
      const u = this.requireUser(name);
      const taken = this.store.get('SELECT id FROM users WHERE name = ?', newName); // COLLATE NOCASE
      if (taken && taken.id !== u.id) throw new AccountError(409, `the name ${newName} is taken`);
      this.store.run('UPDATE users SET name = ? WHERE id = ?', newName, u.id);
      this.store.event('user_renamed', adminId, { from: u.name, to: newName });
      return { from: u.name, to: newName };
    });
  }

  /**
   * Deletes an account. One with work on record (submissions, reviews, symbols) stays as
   * "deleted_<id>" so the history keeps its author; one without is removed. Either way it can no
   * longer log in and its claims are released.
   */
  deleteUser(name, adminId) {
    return this.store.tx(() => {
      const u = this.requireUser(name);
      if (u.role === 'admin' && u.status === 'active' && this.activeAdmins() <= 1) throw new AccountError(409, 'refusing to delete the last active admin');
      if (u.id === adminId) throw new AccountError(409, 'you cannot delete your own account here');
      const has = (sql) => !!this.store.get(sql, u.id);
      const work =
        has('SELECT 1 FROM attempts WHERE user_id = ? LIMIT 1') ||
        has('SELECT 1 FROM batches WHERE user_id = ? LIMIT 1') ||
        has('SELECT 1 FROM peer_reviews WHERE reviewer_id = ? LIMIT 1') ||
        has('SELECT 1 FROM reviews WHERE reviewer_id = ? LIMIT 1') ||
        has('SELECT 1 FROM symbols WHERE created_by = ? LIMIT 1');
      this.store.run(
        `UPDATE tasks SET state = CASE WHEN best_attempt IS NULL THEN 'open' ELSE 'needs_cleanup' END, lease_user = NULL, lease_expires = NULL, updated_at = ? WHERE lease_user = ? AND state = 'leased'`,
        now(), u.id,
      );
      for (const t of ['sessions', 'api_tokens', 'region_claims']) this.store.run(`DELETE FROM ${t} WHERE user_id = ?`, u.id);
      this.store.run('DELETE FROM peer_leases WHERE reviewer_id = ?', u.id);
      if (work) {
        const newName = `deleted_${u.id}`;
        this.store.run(`UPDATE users SET name = ?, status = 'revoked', password_hash = NULL, revoked_at = ? WHERE id = ?`, newName, now(), u.id);
        this.store.event('user_deleted', adminId, { name: u.name, kept: newName });
        return { name: u.name, deleted: true, keptAs: newName };
      }
      for (const t of ['credit_ledger', 'game_rounds']) this.store.run(`DELETE FROM ${t} WHERE user_id = ?`, u.id);
      this.store.run('UPDATE events SET user_id = NULL WHERE user_id = ?', u.id);
      this.store.run('UPDATE users SET approved_by = NULL WHERE approved_by = ?', u.id);
      this.store.run('DELETE FROM users WHERE id = ?', u.id);
      this.store.event('user_deleted', adminId, { name: u.name });
      return { name: u.name, deleted: true, keptAs: null };
    });
  }

  /** A new random password for an account (shown once to the admin); its sessions end. */
  async resetPassword(name, adminId) {
    const pw = crypto.randomBytes(12).toString('base64url');
    await this.setPassword(name, pw);
    this.store.event('password_reset', adminId, { name });
    return { name, password: pw };
  }

  activeAdmins() {
    return this.store.get(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'`).n;
  }
}
