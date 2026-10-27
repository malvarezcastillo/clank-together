import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const data = '/var/lib/docker/volumes/rodecomp_data/_data';
const repo = path.join(data, 'repo');
const payload = JSON.parse(fs.readFileSync(path.join(data, 'admin-bulk/payload.json'), 'utf8'));
const backup = JSON.parse(fs.readFileSync(path.join(data, 'bulk-import-backup-latest.json'), 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
if (git('rev-parse', 'HEAD') !== payload.baseCommit || backup.head !== payload.baseCommit) throw new Error('Remote base changed; import not applied');
if (git('status', '--porcelain')) throw new Error('Remote repository dirty; import not applied');
const db = new DatabaseSync(path.join(data, 'td.sqlite'));
db.exec('PRAGMA busy_timeout=15000; PRAGMA foreign_keys=ON');
if (db.prepare("SELECT count(*) n FROM check_jobs WHERE state IN ('queued','running')").get().n) throw new Error('Check still active');
if (db.prepare("SELECT count(*) n FROM batches WHERE state IN ('queued','verifying','merging')").get().n) throw new Error('Batch still active');
const annotationUnits = new Map();
for (const [id, locations] of Object.entries(payload.functions)) {
  const symbol = db.prepare('SELECT * FROM symbols WHERE id=?').get(id);
  if (!symbol || symbol.library) throw new Error(`Unexpected import symbol ${id}`);
  const candidates = locations.filter(location => /\.(c|cc|cpp|cxx)$/.test(location.file));
  const mapped = payload.moves[symbol.unit] ?? symbol.unit;
  const unit = candidates.find(location => location.file === mapped)?.file ?? candidates[0]?.file ?? mapped;
  if (unit) annotationUnits.set(id, unit);
}
const tracked = git('ls-files', '--', 'Source').split('\n').filter(Boolean);
const removed = tracked.filter(file => !payload.files[file]);
for (const file of removed) fs.unlinkSync(path.join(repo, file));
for (const [file, value] of Object.entries(payload.files)) {
  if (path.isAbsolute(file) || file.split('/').includes('..')) throw new Error(`Unsafe path ${file}`);
  if (crypto.createHash('sha256').update(value.text).digest('hex') !== value.sha256) throw new Error(`Payload checksum mismatch ${file}`);
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), value.text);
}
git('add', '-A', '--', 'Source', 'CODING_RULES.md', '.clang-format', 'CMakeLists.txt', 'data/compile.json', 'README.md');
git('-c', 'user.name=ragnarok-clanker', '-c', 'user.email=ragnarok-clanker@users.clank-together.invalid', 'commit', '-m', `${payload.message}\n\nAdministrative source import: native x86 compilation passed for 423 authored units. Source placement and submission states are migrated separately; this commit does not imply peer acceptance.\n\nPrevious head: ${payload.baseCommit}\nPayload SHA256: ${backup.payloadSha256}`);
const commit = git('rev-parse', 'HEAD');
const changes = { symbolsMoved: 0, symbolsPlacedFromAnnotations: 0, funcStatusPaths: 0, dependencyPaths: 0, regionPaths: 0 };
db.exec('BEGIN IMMEDIATE');
try {
  for (const [oldPath, newPath] of Object.entries(payload.moves)) {
    changes.symbolsMoved += Number(db.prepare('UPDATE symbols SET unit=? WHERE unit=?').run(newPath, oldPath).changes);
    changes.funcStatusPaths += Number(db.prepare('UPDATE func_status SET file=? WHERE file=?').run(newPath, oldPath).changes);
    changes.regionPaths += Number(db.prepare("UPDATE region_claims SET key=? WHERE kind='unit' AND key=?").run(newPath, oldPath).changes);
  }
  for (const [id, unit] of annotationUnits) changes.symbolsPlacedFromAnnotations += Number(db.prepare('UPDATE symbols SET unit=? WHERE id=? AND (unit IS NULL OR unit!=?)').run(unit, id, unit).changes);
  const dependencies = db.prepare('SELECT * FROM unit_deps').all();
  db.exec('DELETE FROM unit_deps');
  for (const dependency of dependencies) {
    const unit = payload.moves[dependency.unit] ?? dependency.unit;
    const header = payload.moves[dependency.header] ?? dependency.header;
    if (unit !== dependency.unit || header !== dependency.header) changes.dependencyPaths++;
    db.prepare('INSERT OR IGNORE INTO unit_deps(unit,header) VALUES(?,?)').run(unit, header);
  }
  db.prepare('INSERT INTO events(at,user_id,type,data) VALUES(?,?,?,?)').run(Date.now(), 1, 'admin_source_import', JSON.stringify({ commit, baseCommit: payload.baseCommit, sourceFiles: 791, moves: Object.keys(payload.moves).length, backup: backup.destination, changes }));
  db.prepare("INSERT INTO meta(key,value) VALUES('admin_source_import',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ commit, backup: backup.destination, at: Date.now(), state: 'installed_pending_verification' }));
  const bad = db.prepare('PRAGMA foreign_key_check').all();
  if (bad.length) throw new Error(`Foreign key check failed: ${JSON.stringify(bad)}`);
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}
const missing = Object.entries(payload.files).filter(([file, value]) => crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex') !== value.sha256);
if (missing.length) throw new Error('Installed file checksum mismatch');
const result = { commit, previous: payload.baseCommit, removedOldSourcePaths: removed.length, payloadFiles: Object.keys(payload.files).length, fileChecksumMismatches: missing.length, backup: backup.destination, changes, repositoryClean: !git('status', '--porcelain') };
fs.writeFileSync(path.join(data, 'admin-bulk/install-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
db.close();
