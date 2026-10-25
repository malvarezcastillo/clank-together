import fs from 'node:fs';
import path from 'node:path';
import { openServer } from '/app/src/server/app.js';
import { bestResults } from '/app/src/server/verify.js';

const data = '/var/lib/docker/volumes/rodecomp_data/_data';
const ctx = openServer(data);
const store = ctx.store;
const payload = JSON.parse(fs.readFileSync(path.join(data, 'admin-bulk/payload.json'), 'utf8'));
const installed = JSON.parse(fs.readFileSync(path.join(data, 'admin-bulk/install-result.json'), 'utf8'));
const saved = JSON.parse(fs.readFileSync(path.join(data, 'admin-bulk/full-check.json'), 'utf8'));
const backup = JSON.parse(fs.readFileSync(path.join(data, 'bulk-import-backup-latest.json'), 'utf8'));
const before = JSON.parse(fs.readFileSync(path.join(backup.destination, 'before.json'), 'utf8'));
if (ctx.repo.head() !== installed.commit) throw new Error('Repository changed since verification');
if (saved.check.units.length !== 423 || saved.check.units.some(unit => !unit.compiled)) throw new Error('Imported source is not fully compiled');
if (saved.rec.conflicts.some(conflict => conflict.hard)) throw new Error('Hard symbol-reference conflicts remain');
const user = store.get("SELECT id FROM users WHERE name='ragnarok-clanker'");
if (!user) throw new Error('Import account not found');
const allIds = Object.keys(payload.functions);
const wanted = new Set(allIds);
const best = bestResults(saved.check);
const previousStatus = new Map(before.funcStatus.map(row => [row.symbol_id, row]));
const now = Date.now();
const note = `Administrative import of the exact current source snapshot at ${installed.commit}. Remote Clank compiler passed all 423 authored units. The source is installed by an owner-authorized repository migration; pending logic still requires independent review. No peer verdict or confirmation is fabricated.`;
const fileText = Object.fromEntries(Object.entries(payload.files).map(([file, value]) => [file, value.text]));
const pendingBefore = store.all("SELECT a.*,t.symbol_id FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE a.state IN ('queued','verifying','peer_review','in_review','approved','merging')");
const rows = [];
const superseded = [];
const counts = {};
const createdBatches = [];
store.db.exec('BEGIN IMMEDIATE');
try {
  for (const attempt of pendingBefore.filter(attempt => wanted.has(attempt.symbol_id))) {
    store.run("UPDATE attempts SET state='superseded',result_json=json_set(COALESCE(result_json,'{}'),'$.supersededBySourceImport',?),finished_at=? WHERE id=?", installed.commit, now, attempt.id);
    store.run('DELETE FROM peer_leases WHERE attempt_id=?', attempt.id);
    superseded.push(attempt.id);
  }
  const batchFor = new Map();
  for (const id of allIds) {
    const result = best.get(id);
    const locations = payload.functions[id];
    const symbol = store.get('SELECT * FROM symbols WHERE id=?', id);
    const task = store.get('SELECT * FROM tasks WHERE symbol_id=?', id);
    if (!task || !symbol || symbol.library) throw new Error(`Import tracking prerequisite missing for ${id}`);
    const unit = result?.unit ?? locations.find(location => location.file.endsWith('.cpp'))?.file ?? symbol.unit;
    const target = result?.f ? { ...result.f, file: unit } : null;
    const status = target?.status ?? 'missing';
    const score = target?.score ?? 0;
    let state;
    let summary;
    if (status === 'exact') {
      state = 'merged';
      summary = 'Administrative source import; remote compiler comparison is byte-identical. No peer confirmation claimed.';
    } else if (status === 'mismatch' || status === 'match_unresolved') {
      state = 'peer_review';
      summary = `Administrative source import; compiles, not byte-identical (score ${(score * 100).toFixed(1)}%). Awaiting independent peer review.`;
    } else {
      state = 'needs_cleanup';
      summary = 'Administrative source import registered; native C++ compiles, but this annotation did not resolve to an emitted function. No correctness or acceptance claimed.';
    }
    const groupKey = `${state}:${unit}`;
    let batchId = batchFor.get(groupKey);
    if (!batchId) {
      const batchFiles = {};
      for (const location of locations) batchFiles[location.file] = fileText[location.file];
      if (fileText[unit]) batchFiles[unit] = fileText[unit];
      const resultJson = { adminSourceImport: { commit: installed.commit, backup: backup.destination }, mergedFiles: batchFiles, changedHeaders: [], outside: [] };
      const inserted = store.run("INSERT INTO batches(user_id,token_id,base_commit,files_json,notes,agent_meta,env_digest,state,result_json,merged_commit,created_at,finished_at,cost) VALUES(?,NULL,?,?,?,?,?,?,?,?,?,?,?)", user.id, installed.commit, JSON.stringify(batchFiles), note, JSON.stringify({ source: 'owner-authorized-bulk-import', codeInstalled: true }), ctx.config.envDigest, state === 'merged' ? 'merged' : 'open', JSON.stringify(resultJson), state === 'merged' ? installed.commit : null, now, now, 1);
      batchId = Number(inserted.lastInsertRowid);
      batchFor.set(groupKey, batchId);
      createdBatches.push(batchId);
    } else {
      const row = store.get('SELECT files_json,result_json FROM batches WHERE id=?', batchId);
      const files = JSON.parse(row.files_json);
      for (const location of locations) files[location.file] = fileText[location.file];
      const results = JSON.parse(row.result_json);
      results.mergedFiles = files;
      store.run('UPDATE batches SET files_json=?,result_json=? WHERE id=?', JSON.stringify(files), JSON.stringify(results), batchId);
    }
    const feedback = {
      summary,
      target,
      annotationErrors: saved.check.annotationErrors.filter(error => error.severity !== 'warning' && error.file === unit),
      compileErrors: [],
      regressions: [],
      referenceConflicts: [],
      warnings: ['Source was installed by administrative import; peer approval has not been inferred from repository presence.'],
      annotationDiagnostics: saved.check.units.flatMap(compiled => compiled.errors).filter(error => String(error.message).startsWith(id + ':')),
      headCommit: installed.commit,
      importPreviousStatus: previousStatus.get(id)?.status ?? null
    };
    const attemptId = Number(store.run("INSERT INTO attempts(task_id,user_id,token_id,base_commit,files_json,notes,agent_meta,env_digest,state,score,result_json,merged_commit,created_at,finished_at,batch_id,competing,kind,peer_skipped) VALUES(?,?,NULL,?,'{}',?,?,?,?,?,?,?,?,?,?,0,'code',0)", task.id, user.id, installed.commit, note, JSON.stringify({ source: 'owner-authorized-bulk-import' }), ctx.config.envDigest, state, score, JSON.stringify({ feedback, adminSourceImport: { commit: installed.commit, backup: backup.destination } }), state === 'merged' ? installed.commit : null, now, now, batchId).lastInsertRowid);
    store.run("UPDATE tasks SET state='open',lease_user=NULL,lease_expires=NULL,lease_base_commit=NULL,updated_at=? WHERE id=?", now, task.id);
    store.run('UPDATE tasks SET state=?,best_score=?,best_attempt=?,preferred_user=?,preferred_until=NULL,updated_at=? WHERE id=?', state === 'merged' ? 'done' : state, score, attemptId, user.id, now, task.id);
    store.run('UPDATE symbols SET unit=? WHERE id=?', unit, id);
    store.run("INSERT INTO func_status(symbol_id,file,status,score,commit_hash,updated_at,confirmed,code_hash) VALUES(?,?,?,?,?,?,0,?) ON CONFLICT(symbol_id) DO UPDATE SET file=excluded.file,status=excluded.status,score=excluded.score,commit_hash=excluded.commit_hash,updated_at=excluded.updated_at,confirmed=0,code_hash=excluded.code_hash", id, unit, status, score, installed.commit, now, target?.codeHash ?? null);
    counts[state] = (counts[state] ?? 0) + 1;
    rows.push({ symbol: id, taskId: task.id, attemptId, batchId, unit, state, status, score });
  }
  for (const batchId of new Set(pendingBefore.filter(attempt => wanted.has(attempt.symbol_id)).map(attempt => attempt.batch_id).filter(Boolean))) {
    if (!store.get("SELECT 1 FROM attempts WHERE batch_id=? AND state IN ('queued','verifying','peer_review','in_review','approved','merging')", batchId)) {
      store.run("UPDATE batches SET state='superseded',result_json=json_set(COALESCE(result_json,'{}'),'$.supersededBySourceImport',?),finished_at=? WHERE id=?", installed.commit, now, batchId);
      store.run('DELETE FROM batch_checks WHERE batch_id=?', batchId);
    }
  }
  for (const unit of saved.check.units) {
    store.run('DELETE FROM unit_deps WHERE unit=?', unit.file);
    for (const header of unit.includes ?? []) store.run('INSERT OR IGNORE INTO unit_deps(unit,header) VALUES(?,?)', unit.file, header);
  }
  for (const batchId of createdBatches) {
    const batch = store.get('SELECT files_json,state FROM batches WHERE id=?', batchId);
    if (batch.state !== 'open') continue;
    const files = JSON.parse(batch.files_json);
    const selectedUnits = saved.check.units.filter(unit => Object.hasOwn(files, unit.file));
    const result = { check: { ...saved.check, units: selectedUnits }, rec: saved.rec, changedHeaders: [] };
    ctx.verifier.rememberCheck(batchId, result);
  }
  store.run('INSERT INTO events(at,user_id,type,data) VALUES(?,?,?,?)', now, user.id, 'admin_bulk_submitted', JSON.stringify({ commit: installed.commit, functions: rows.length, counts, superseded, batches: createdBatches }));
  store.run("INSERT INTO meta(key,value) VALUES('admin_source_import',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify({ commit: installed.commit, backup: backup.destination, state: 'registered', functions: rows.length, counts, at: now }));
  const missing = rows.filter(row => !store.get('SELECT 1 FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE a.id=? AND t.symbol_id=?', row.attemptId, row.symbol));
  if (missing.length) throw new Error('Submission coverage incomplete');
  if (store.all('PRAGMA foreign_key_check').length) throw new Error('Foreign key check failed');
  store.db.exec('COMMIT');
} catch (error) {
  store.db.exec('ROLLBACK');
  throw error;
}
const result = { commit: installed.commit, sourceFunctions: allIds.length, registered: rows.length, counts, supersededAttempts: superseded, createdBatches, rows, reviewsPreserved: store.get('SELECT count(*) n FROM peer_reviews').n === before.reviews, humanReviewsPreserved: store.get('SELECT count(*) n FROM reviews').n === before.humanReviews, databaseIntegrity: store.get('PRAGMA integrity_check').integrity_check };
fs.writeFileSync(path.join(data, 'admin-bulk/register-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, rows: undefined, createdBatches: createdBatches.length, supersededAttempts: superseded.length }, null, 2));
