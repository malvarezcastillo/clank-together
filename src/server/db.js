// SQLite storage (node:sqlite, no native dependencies).

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { formatSymbolId } from '../shared/annotations.js';

// Accounts. People register with a password and stay 'pending' until an admin
// approves them. Approved users create API tokens for their agents; the browser
// uses short-lived sessions. Both are stored as SHA-256 hashes only.
const USERS_TABLES = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('contributor','reviewer','maintainer','admin')),
  status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
  created_at INTEGER NOT NULL,
  approved_by INTEGER,
  approved_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

${USERS_TABLES}

-- Target executable versions. Exactly one is current; verification runs against it.
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,            -- e.g. "1.0"
  sha256 TEXT NOT NULL,
  file TEXT NOT NULL,             -- path on the server
  size INTEGER NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Stable symbols. The ID is what source annotations reference; it never changes.
CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,            -- fn_00001, gl_00001, vt_00001, st_00001
  kind TEXT NOT NULL CHECK (kind IN ('function','global','vtable','string')),
  name TEXT,                      -- human name, best known
  decorated TEXT,                 -- MSVC decorated name, learned when code is merged
  library INTEGER NOT NULL DEFAULT 0,
  unit TEXT,                      -- translation unit (repo path) this symbol belongs to
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS symbols_decorated ON symbols(decorated);

-- Where each symbol lives in each target version.
CREATE TABLE IF NOT EXISTS symbol_addresses (
  symbol_id TEXT NOT NULL REFERENCES symbols(id),
  version_id TEXT NOT NULL REFERENCES versions(id),
  addr INTEGER NOT NULL,
  size INTEGER,
  PRIMARY KEY (symbol_id, version_id),
  UNIQUE (version_id, addr)
);

CREATE TABLE IF NOT EXISTS id_counters (prefix TEXT PRIMARY KEY, next INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  symbol_id TEXT UNIQUE NOT NULL REFERENCES symbols(id),
  type TEXT NOT NULL DEFAULT 'function',
  state TEXT NOT NULL,            -- open, leased, verifying, needs_cleanup, in_review, approved, merging, done, hard
  priority INTEGER NOT NULL DEFAULT 0,
  difficulty INTEGER NOT NULL DEFAULT 0,
  lease_user INTEGER REFERENCES users(id),
  lease_expires INTEGER,
  lease_base_commit TEXT,
  best_score REAL NOT NULL DEFAULT 0,
  best_attempt INTEGER,
  cleanup_cycles INTEGER NOT NULL DEFAULT 0,
  preferred_user INTEGER,         -- holder of the last attempt gets first pick on re-claim
  preferred_until INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state, priority);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  base_commit TEXT NOT NULL,
  files_json TEXT NOT NULL,
  notes TEXT,
  agent_meta TEXT,
  env_digest TEXT,
  state TEXT NOT NULL,            -- queued, verifying, rejected, needs_cleanup, in_review, approved, merged, superseded
  score REAL,
  result_json TEXT,
  merged_commit TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS attempts_state ON attempts(state);
CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  reviewer_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('approve','request_changes','reject')),
  comment TEXT,
  created_at INTEGER NOT NULL
);

-- Match state of every function on main, used for regression checks and progress.
-- confirmed: merged after unanimous peer review although not byte-identical (logic judged the same).
CREATE TABLE IF NOT EXISTS func_status (
  symbol_id TEXT PRIMARY KEY REFERENCES symbols(id),
  file TEXT,
  status TEXT NOT NULL,
  score REAL NOT NULL,
  commit_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0
);

-- Peer review of attempts that are not byte-identical: other agents read the original's
-- assembly and pseudocode and the submitted code, and judge whether the logic is the same.
CREATE TABLE IF NOT EXISTS peer_reviews (
  id INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  reviewer_id INTEGER NOT NULL REFERENCES users(id),
  verdict TEXT NOT NULL CHECK (verdict IN ('same','different')),
  reason TEXT NOT NULL,
  agent_meta TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (attempt_id, reviewer_id)
);

CREATE TABLE IF NOT EXISTS peer_leases (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  reviewer_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, reviewer_id)
);

-- Which project headers each unit of main includes (from cl /showIncludes), so a header change
-- recompiles only the units that use it.
CREATE TABLE IF NOT EXISTS unit_deps (
  unit TEXT NOT NULL,
  header TEXT NOT NULL,
  PRIMARY KEY (unit, header)
);
CREATE INDEX IF NOT EXISTS unit_deps_header ON unit_deps(header);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  user_id INTEGER,
  type TEXT NOT NULL,
  data TEXT
);
`;

export const now = () => Date.now();
export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.migrateUsers();
    this.db.exec(SCHEMA);
    this.addColumn('func_status', 'confirmed', 'INTEGER NOT NULL DEFAULT 0');
  }

  /** Adds a column to a table created by an older schema. */
  addColumn(table, column, decl) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  /**
   * Converts the first users table (one token column per user) to accounts
   * with passwords, separate API tokens and sessions. Existing tokens keep working.
   */
  migrateUsers() {
    const row = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`).get();
    if (!row || row.sql.includes('password_hash')) return;
    this.db.exec('PRAGMA foreign_keys = OFF');
    // Keep other tables' REFERENCES users(id) pointing at "users", not "users_old".
    this.db.exec('PRAGMA legacy_alter_table = ON');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('ALTER TABLE users RENAME TO users_old');
      this.db.exec(USERS_TABLES);
      this.db.exec(`INSERT INTO users (id, name, role, status, created_at, approved_at)
                    SELECT id, name, role, CASE WHEN disabled = 1 THEN 'revoked' ELSE 'active' END, created_at, created_at FROM users_old`);
      this.db.exec(`INSERT INTO api_tokens (user_id, token_hash, label, created_at)
                    SELECT id, token_hash, 'initial token', created_at FROM users_old WHERE disabled = 0 AND token_hash IS NOT NULL`);
      this.db.exec('DROP TABLE users_old');
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.db.exec('PRAGMA legacy_alter_table = OFF');
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  get(sql, ...p) {
    return this.db.prepare(sql).get(...p);
  }
  all(sql, ...p) {
    return this.db.prepare(sql).all(...p);
  }
  run(sql, ...p) {
    return this.db.prepare(sql).run(...p);
  }

  event(type, userId, data) {
    this.run('INSERT INTO events (at, user_id, type, data) VALUES (?, ?, ?, ?)', now(), userId ?? null, type, data ? JSON.stringify(data) : null);
  }

  getMeta(key) {
    return this.get('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
  }
  setMeta(key, value) {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  }

  // --- versions and symbols

  currentVersion() {
    return this.get('SELECT * FROM versions WHERE is_current = 1') ?? null;
  }

  allocateId(prefix) {
    const row = this.get('SELECT next FROM id_counters WHERE prefix = ?', prefix);
    const n = row ? row.next : 1;
    this.run('INSERT INTO id_counters (prefix, next) VALUES (?, ?) ON CONFLICT(prefix) DO UPDATE SET next = excluded.next', prefix, n + 1);
    return formatSymbolId(prefix, n);
  }

  /** Creates a symbol at `addr` in `versionId`, or returns the existing one at that address. */
  ensureSymbol({ kind, versionId, addr, size = null, name = null, library = false, unit = null, userId = null }) {
    const existing = this.get('SELECT s.* FROM symbol_addresses a JOIN symbols s ON s.id = a.symbol_id WHERE a.version_id = ? AND a.addr = ?', versionId, addr);
    if (existing) return { symbol: existing, created: false };
    const prefix = { function: 'fn', global: 'gl', vtable: 'vt', string: 'st' }[kind];
    const id = this.allocateId(prefix);
    this.run('INSERT INTO symbols (id, kind, name, library, unit, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, kind, name, library ? 1 : 0, unit, userId, now());
    this.run('INSERT INTO symbol_addresses (symbol_id, version_id, addr, size) VALUES (?, ?, ?, ?)', id, versionId, addr, size);
    return { symbol: this.get('SELECT * FROM symbols WHERE id = ?', id), created: true };
  }

  /** ID -> {id, kind, name, decorated, library, unit, addr, size} for one version. */
  symbolMap(versionId) {
    const rows = this.all(
      `SELECT s.id, s.kind, s.name, s.decorated, s.library, s.unit, a.addr, a.size
         FROM symbols s LEFT JOIN symbol_addresses a ON a.symbol_id = s.id AND a.version_id = ?`,
      versionId,
    );
    return new Map(rows.map((r) => [r.id, { ...r, library: !!r.library }]));
  }

  nameIndex() {
    return new Map(this.all('SELECT decorated, id FROM symbols WHERE decorated IS NOT NULL').map((r) => [r.decorated, r.id]));
  }
}
