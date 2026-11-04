// SQLite storage (node:sqlite, no native dependencies).

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { formatSymbolId } from '../shared/annotations.js';
import { relocOnly } from '../shared/compare.js';

// Accounts. Registrations stay 'pending' until approved unless auto-approval is on.
// Approved users create API tokens for their agents; the browser uses short-lived
// sessions. Both are stored as SHA-256 hashes only.
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

-- A batch is one submission: the files once, and one attempt per task (function) it covers.
-- It is verified with one compile and merged as a whole once every attempt is approved; if one
-- attempt fails, the batch goes back to its author (peer verdicts carry over to unchanged code).
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  base_commit TEXT NOT NULL,
  files_json TEXT NOT NULL,
  notes TEXT,
  agent_meta TEXT,
  env_digest TEXT,
  state TEXT NOT NULL,            -- queued, verifying, open, merging, merged, returned, superseded
  result_json TEXT,
  merged_commit TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS batches_state ON batches(state);

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

-- The original functions as text (Ghidra export): assembly with symbol names, and pseudocode.
CREATE TABLE IF NOT EXISTS original_code (
  version_id TEXT NOT NULL,
  addr INTEGER NOT NULL,
  asm TEXT,
  c TEXT,
  PRIMARY KEY (version_id, addr)
);

-- The check a batch was verified with, so its merge can reuse it when main did not change
-- anything the compiled units depend on.
CREATE TABLE IF NOT EXISTS batch_checks (
  batch_id INTEGER PRIMARY KEY REFERENCES batches(id),
  head TEXT NOT NULL,
  check_json TEXT NOT NULL
);

-- Functions that reached main although a peer reviewer said "different": kept for a human to look
-- at later (e.g. once everything is decompiled).
CREATE TABLE IF NOT EXISTS later_review (
  id INTEGER PRIMARY KEY,
  symbol_id TEXT NOT NULL REFERENCES symbols(id),
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  merged_commit TEXT,
  objections INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  cleared_by INTEGER REFERENCES users(id),
  cleared_at INTEGER
);

-- Remote checks, queued by the web process and run by the worker process.
CREATE TABLE IF NOT EXISTS check_jobs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  files_json TEXT NOT NULL,
  state TEXT NOT NULL,            -- queued, running, done, failed, abandoned
  result_json TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  user_id INTEGER,
  type TEXT NOT NULL,
  data TEXT
);

-- Whole-binary byte match after each commit to main: score is the size-weighted match of the
-- counted functions (sum of size x score over sum of size), exact the share of bytes in
-- byte-identical functions. One row per commit; the home page charts it.
CREATE TABLE IF NOT EXISTS match_history (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  commit_hash TEXT NOT NULL,
  score REAL NOT NULL,
  exact REAL NOT NULL,
  functions INTEGER NOT NULL,
  bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS match_history_at ON match_history(at);

-- A region (a source file or a class) an agent registered to work on as a whole. Several agents
-- may hold the same region; each may then submit any of its functions, and the first accepted
-- candidate of a function wins (the others are superseded).
CREATE TABLE IF NOT EXISTS region_claims (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('unit', 'class', 'range')),
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (user_id, kind, key)
);
CREATE INDEX IF NOT EXISTS region_claims_key ON region_claims(kind, key);

-- Game credits: earned for work that reached main and for reviews that agreed with the outcome,
-- spent and won in the games. Play money only. The balance is the sum.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,           -- merged, identical, review, game:<name>, grant
  ref TEXT,                       -- what it was for (attempt, review or round), once per reason
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, reason, ref)
);
CREATE INDEX IF NOT EXISTS credit_ledger_user ON credit_ledger(user_id);

CREATE TABLE IF NOT EXISTS game_rounds (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  game TEXT NOT NULL,
  bet INTEGER NOT NULL,
  payout INTEGER NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS game_rounds_at ON game_rounds(created_at);

-- A function on main stays done: a competing candidate that finishes later must not revive it.
CREATE TRIGGER IF NOT EXISTS tasks_done_stays_done BEFORE UPDATE OF state ON tasks
  WHEN OLD.state IN ('done', 'skipped') AND NEW.state NOT IN ('done', 'skipped', 'open')
  BEGIN SELECT RAISE(IGNORE); END;
`;

export const now = () => Date.now();
export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    // CLI commands (rebuild, ghidra refresh) write from a second process; wait for their locks.
    this.db.exec('PRAGMA busy_timeout = 15000');
    this.migrateUsers();
    this.db.exec(SCHEMA);
    this.addColumn('func_status', 'confirmed', 'INTEGER NOT NULL DEFAULT 0');
    // Fingerprint of main's compiled code per function (submissions may only change their own tasks).
    this.addColumn('func_status', 'code_hash', 'TEXT');
    // 1 when main's code is byte-identical and only references the original has no relocation for differ.
    this.addColumn('func_status', 'reloc_only', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumn('versions', 'label', 'TEXT');
    this.addColumn('check_jobs', 'files_hash', 'TEXT'); // a retry of the same check joins the queued one
    this.addColumn('batches', 'cost', 'INTEGER'); // units its verification compiles (queue order)
    // When the current holder took the task: heartbeats cannot extend a lease past maxLeaseHours from it.
    this.addColumn('tasks', 'lease_started', 'INTEGER');
    this.db.exec(`UPDATE tasks SET lease_started = ${Date.now()} WHERE state = 'leased' AND lease_started IS NULL`);
    this.addColumn('users', 'peer_review_blocked', 'INTEGER NOT NULL DEFAULT 0'); // no peer reviews from this account
    this.addColumn('users', 'submit_mode', "TEXT NOT NULL DEFAULT 'auto'"); // auto (quality.js) | trusted | paused
    this.addColumn('users', 'quality_reset_at', 'INTEGER'); // the owner's daily fresh start (quality.js)
    this.addColumn('users', 'review_weight', 'INTEGER'); // set by an admin: the weight of this account's verdicts (trust.js)
    // Which agent (API token) submitted or claimed what: quality is judged per agent.
    this.addColumn('attempts', 'token_id', 'INTEGER');
    this.addColumn('batches', 'token_id', 'INTEGER');
    this.addColumn('region_claims', 'token_id', 'INTEGER');
    this.migrateRegionKinds();
    this.addColumn('api_tokens', 'quality_reset_at', 'INTEGER');
    // Trust (trust.js): what a verdict counts (1-3, frozen when given), and functions of trusted
    // authors accepted without peer review.
    this.addColumn('peer_reviews', 'weight', 'INTEGER NOT NULL DEFAULT 1');
    this.addColumn('peer_reviews', 'token_id', 'INTEGER');
    this.addColumn('attempts', 'peer_skipped', 'INTEGER NOT NULL DEFAULT 0');
    // A maintainer accepted that this attempt lowers matching scores (cleaner source over closer bytes).
    this.addColumn('attempts', 'regressions_accepted', 'INTEGER NOT NULL DEFAULT 0');
    this.db.exec('CREATE INDEX IF NOT EXISTS attempts_user_time ON attempts(user_id, created_at)');
    // "No decompile" claims: an attempt that says a function needs no source (peer reviewed like code).
    this.addColumn('attempts', 'kind', "TEXT NOT NULL DEFAULT 'code'"); // code | skip
    this.addColumn('attempts', 'skip_category', 'TEXT');
    this.addColumn('symbols', 'skip_reason', 'TEXT'); // accepted: not ported, not counted in progress // human-readable name, e.g. "World of Warcraft 5.0.3 (build 15890, x64)"
    this.addColumn('attempts', 'batch_id', 'INTEGER REFERENCES batches(id)');
    // A candidate for a function another agent holds (region claims): it does not move the task.
    this.addColumn('attempts', 'competing', 'INTEGER NOT NULL DEFAULT 0');
    // A maintenance batch (maintenance.js): structural changes with no function tasks.
    this.addColumn('batches', 'kind', "TEXT NOT NULL DEFAULT 'code'");
    this.db.exec('CREATE INDEX IF NOT EXISTS events_type_at ON events(type, at)'); // merge rates, feed
    this.db.exec('CREATE INDEX IF NOT EXISTS attempts_batch ON attempts(batch_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS attempts_task_state ON attempts(task_id, state)'); // candidates on their way (improvable)
    this.db.exec('CREATE INDEX IF NOT EXISTS peer_reviews_reviewer ON peer_reviews(reviewer_id, created_at)'); // reviewer trust
    // Admin-set weight is capped at 2 (peer.js setReviewWeight); bring older settings and their waiting verdicts down.
    this.db.exec(`UPDATE peer_reviews SET weight = 2 WHERE weight > 2 AND reviewer_id IN (SELECT id FROM users WHERE review_weight > 2)
                    AND attempt_id IN (SELECT id FROM attempts WHERE state IN ('peer_review', 'in_review'))`);
    this.db.exec('UPDATE users SET review_weight = 2 WHERE review_weight > 2');
    this.retireFinishedSentBack();
    this.backfillRelocOnly();
    // Author holds were 6 hours; none may outlast 20 minutes after the function was sent back (batches.js AUTHOR_HOLD_MS).
    this.db.prepare('UPDATE tasks SET preferred_until = updated_at + ? WHERE preferred_until > updated_at + ? AND preferred_until > ?').run(20 * 60_000, 20 * 60_000, Date.now());
  }

  /**
   * Once: reloc_only for functions merged before it was recorded, from their latest merged attempt's
   * target result when that attempt still describes main's code (same code hash). Later merges
   * set it from their own check (merge.js applyCheckToDatabase).
   */
  backfillRelocOnly() {
    if (this.getMeta('migration_backfill_reloc_only')) return;
    const rows = this.db.prepare(
      `SELECT fs.symbol_id, fs.code_hash, json_extract(a.result_json, '$.feedback.target') AS target
         FROM func_status fs JOIN tasks t ON t.symbol_id = fs.symbol_id
         JOIN attempts a ON a.id = (SELECT MAX(x.id) FROM attempts x WHERE x.task_id = t.id AND x.state = 'merged' AND x.result_json IS NOT NULL)
        WHERE fs.status = 'mismatch'`,
    ).all();
    const flag = this.db.prepare('UPDATE func_status SET reloc_only = 1 WHERE symbol_id = ?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) {
        const target = r.target ? JSON.parse(r.target) : null;
        if (target && (!r.code_hash || target.codeHash === r.code_hash) && relocOnly(target)) flag.run(r.symbol_id);
      }
      this.setMeta('migration_backfill_reloc_only', Date.now());
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Once: attempts sent back before the merge path retired them (batches.js retireSentBack) still
   * said needs_cleanup or returned after their function was finished by another attempt.
   */
  retireFinishedSentBack() {
    if (this.getMeta('migration_retire_finished_sent_back')) return;
    const why = 'its function was finished by another attempt; this one is no longer needed';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `UPDATE attempts SET state = 'superseded', finished_at = COALESCE(finished_at, ?),
                  result_json = json_set(COALESCE(result_json, '{}'), '$.retired', state, '$.retiredBecause', ?)
            WHERE state IN ('needs_cleanup', 'returned') AND task_id IN (SELECT id FROM tasks WHERE state IN ('done', 'skipped'))`,
        )
        .run(Date.now(), why);
      this.setMeta('migration_retire_finished_sent_back', Date.now());
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Submitted files of an attempt (kept once per batch). */
  attemptFiles(attempt) {
    if (attempt.batch_id) {
      const b = this.get('SELECT files_json FROM batches WHERE id = ?', attempt.batch_id);
      if (b) return JSON.parse(b.files_json);
    }
    return JSON.parse(attempt.files_json || '{}');
  }

  /** Adds a column to a table created by an older schema. */
  addColumn(table, column, decl) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  /** Lets region claims name an address range of unplaced functions (kind 'range'). Keeps every claim. */
  migrateRegionKinds() {
    const row = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'region_claims'`).get();
    if (!row || row.sql.includes("'range'")) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('ALTER TABLE region_claims RENAME TO region_claims_old');
      this.db.exec('DROP INDEX IF EXISTS region_claims_key');
      this.db.exec(`CREATE TABLE region_claims (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL CHECK (kind IN ('unit', 'class', 'range')),
        key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        token_id INTEGER,
        UNIQUE (user_id, kind, key)
      )`);
      this.db.exec(`INSERT INTO region_claims (id, user_id, kind, key, created_at, expires_at, token_id)
                    SELECT id, user_id, kind, key, created_at, expires_at, token_id FROM region_claims_old`);
      this.db.exec('DROP TABLE region_claims_old');
      this.db.exec('CREATE INDEX IF NOT EXISTS region_claims_key ON region_claims(kind, key)');
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
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

  /** The whole binary's byte match right now, over the functions progress counts. */
  matchNow() {
    const v = this.currentVersion();
    if (!v) return null;
    const r = this.get(
      `SELECT COUNT(*) AS functions, COALESCE(SUM(a.size), 0) AS bytes,
              COALESCE(SUM(a.size * COALESCE(fs.score, 0)), 0) AS weighted,
              COALESCE(SUM(CASE WHEN fs.status IN ('exact', 'match_unresolved') THEN a.size ELSE 0 END), 0) AS exactBytes
         FROM symbols s JOIN symbol_addresses a ON a.symbol_id = s.id AND a.version_id = ?
         LEFT JOIN func_status fs ON fs.symbol_id = s.id
        WHERE s.kind = 'function' AND s.library = 0 AND s.skip_reason IS NULL`,
      v.id,
    );
    if (!r.bytes) return null;
    return { score: r.weighted / r.bytes, exact: r.exactBytes / r.bytes, functions: r.functions, bytes: r.bytes };
  }

  /** One point of the match history for a commit to main (never fatal to the commit). */
  recordMatch(commit, at = Date.now()) {
    try {
      const m = this.matchNow();
      if (!m) return;
      this.run('INSERT INTO match_history (at, commit_hash, score, exact, functions, bytes) VALUES (?, ?, ?, ?, ?, ?)', at, commit, m.score, m.exact, m.functions, m.bytes);
    } catch {
      // A missing point is better than a failed merge.
    }
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
