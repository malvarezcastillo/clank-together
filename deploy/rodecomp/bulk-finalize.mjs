import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openServer } from '/app/src/server/app.js';

const data = '/var/lib/docker/volumes/rodecomp_data/_data';
const ctx = openServer(data);
const store = ctx.store;
const payload = JSON.parse(fs.readFileSync(path.join(data, 'admin-bulk/payload.json'), 'utf8'));
const installed = JSON.parse(fs.readFileSync(path.join(data, 'admin-bulk/install-result.json'), 'utf8'));
const registered = JSON.parse(fs.readFileSync(path.join(data, 'admin-bulk/register-result.json'), 'utf8'));
if (ctx.repo.head() !== installed.commit) throw new Error('Import head changed');
const current = new Set(Object.keys(payload.functions));
const legacy = store.all("SELECT a.id,a.kind,a.batch_id,a.task_id,t.symbol_id FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE a.state IN ('queued','verifying','peer_review','in_review','approved','merging')").filter(attempt => attempt.kind === 'code' && !current.has(attempt.symbol_id));
const reason = 'Historical submission is preserved but is not a definition in the imported current source. Its old file snapshot could resurrect pre-refactor paths/interfaces. Rebase the missing definition onto the imported source before resubmitting; no review approval has been inferred.';
store.db.exec('BEGIN IMMEDIATE');
try {
  for (const attempt of legacy) {
    store.run("UPDATE attempts SET state='needs_cleanup',result_json=json_set(COALESCE(result_json,'{}'),'$.sourceMigration',json(?)),finished_at=? WHERE id=?", JSON.stringify({ commit: installed.commit, reason, originalHistoryPreserved: true }), Date.now(), attempt.id);
    store.run('DELETE FROM peer_leases WHERE attempt_id=?', attempt.id);
    store.run("UPDATE tasks SET state='needs_cleanup',lease_user=NULL,lease_expires=NULL,updated_at=? WHERE id=? AND state NOT IN ('done','skipped')", Date.now(), attempt.task_id);
  }
  for (const id of new Set(legacy.map(attempt => attempt.batch_id).filter(Boolean))) {
    const live = store.get("SELECT 1 FROM attempts WHERE batch_id=? AND state IN ('queued','verifying','peer_review','in_review','approved','merging')", id);
    if (!live) {
      store.run("UPDATE batches SET state='returned',result_json=json_set(COALESCE(result_json,'{}'),'$.sourceMigration',json(?)),finished_at=? WHERE id=?", JSON.stringify({ commit: installed.commit, reason, originalHistoryPreserved: true }), Date.now(), id);
      store.run('DELETE FROM batch_checks WHERE batch_id=?', id);
    }
  }
  store.run('INSERT INTO events(at,user_id,type,data) VALUES(?,?,?,?)', Date.now(), 1, 'admin_source_migration_legacy_quarantine', JSON.stringify({ commit: installed.commit, attempts: legacy, reason }));
  store.db.exec('COMMIT');
} catch (error) {
  store.db.exec('ROLLBACK');
  throw error;
}
const mismatches = [];
for (const [file, value] of Object.entries(payload.files)) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(ctx.repo.dir, file))).digest('hex');
  if (hash !== value.sha256) mismatches.push(file);
}
const incomplete = registered.rows.filter(row => !store.get('SELECT 1 FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE a.id=? AND t.symbol_id=?', row.attemptId, row.symbol));
const staleSymbols = store.all('SELECT id,unit FROM symbols WHERE unit IS NOT NULL').filter(row => Object.hasOwn(payload.moves, row.unit));
if (mismatches.length || incomplete.length || staleSymbols.length) throw new Error('Import consistency verification failed');
const integrity = store.get('PRAGMA integrity_check').integrity_check;
if (integrity !== 'ok' || store.all('PRAGMA foreign_key_check').length) throw new Error('Database integrity verification failed');
const summary = {
  commit: installed.commit,
  payloadFiles: Object.keys(payload.files).length,
  sourceFunctions: registered.rows.length,
  counts: registered.counts,
  legacyCodeNeedsRebase: legacy,
  legacySkipClaimsPreserved: store.get("SELECT count(*) n FROM attempts WHERE state='peer_review' AND kind='skip'").n,
  sourceHashMismatches: mismatches,
  missingSubmissionRecords: incomplete,
  staleSymbolUnitPaths: staleSymbols,
  databaseIntegrity: integrity,
  databaseForeignKeys: 'ok',
  repositoryClean: ctx.repo.isClean(),
  taskStates: store.all('SELECT state,count(*) n FROM tasks GROUP BY state'),
  attemptStates: store.all('SELECT state,count(*) n FROM attempts GROUP BY state')
};
fs.writeFileSync(path.join(data, 'admin-bulk/final-result.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, legacyCodeNeedsRebase: legacy.length }, null, 2));
