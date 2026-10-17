import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, hashToken } from '../src/server/db.js';
import { Accounts } from '../src/server/accounts.js';

test('old token-per-user databases are migrated and keep their tokens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-mig-'));
  const file = path.join(dir, 'td.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('contributor','reviewer','maintainer')),
    token_hash TEXT UNIQUE NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, user_id INTEGER, type TEXT NOT NULL, data TEXT);
    CREATE TABLE reviews (id INTEGER PRIMARY KEY, attempt_id INTEGER NOT NULL, reviewer_id INTEGER NOT NULL REFERENCES users(id), action TEXT NOT NULL, comment TEXT, created_at INTEGER NOT NULL);`);
  old.prepare('INSERT INTO users (name, role, token_hash, created_at) VALUES (?, ?, ?, 1)').run('admin', 'maintainer', hashToken('td_legacy'));
  old.prepare('INSERT INTO users (name, role, token_hash, disabled, created_at) VALUES (?, ?, ?, 1, 1)').run('gone', 'contributor', hashToken('td_gone'));
  old.close();

  const store = new Store(file);
  const accounts = new Accounts(store);
  assert.equal(accounts.userByApiToken('td_legacy').name, 'admin');
  assert.equal(accounts.userByApiToken('td_gone'), null);
  assert.equal(accounts.byName('gone').status, 'revoked');
  // Foreign keys from other tables still point at "users".
  const reviewsSql = store.get("SELECT sql FROM sqlite_master WHERE name = 'reviews'").sql;
  assert.match(reviewsSql, /REFERENCES users\(id\)/);
  assert.doesNotMatch(reviewsSql, /users_old/);
  store.run('INSERT INTO reviews (attempt_id, reviewer_id, action, created_at) VALUES (1, 1, ?, 1)', 'approve');
  store.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
