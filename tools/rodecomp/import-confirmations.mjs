import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const [data, input] = process.argv.slice(2);
const evidence = JSON.parse(fs.readFileSync(input, 'utf8'));
const db = new DatabaseSync(path.join(data, 'td.sqlite'));
const version = db.prepare('SELECT * FROM versions WHERE is_current=1').get();
if(version.sha256 !== evidence.targetSha256) throw new Error('Target identity mismatch');
const eligible = [], deferred = [];
for(const row of evidence.confirmations) {
  const source = fs.readFileSync(path.join(data, 'repo', row.file), 'utf8').replaceAll('\r\n','\n');
  if(crypto.createHash('sha256').update(source).digest('hex') !== row.sourceSha256) throw new Error(`Source changed: ${row.file}`);
  const current = db.prepare('SELECT * FROM func_status WHERE symbol_id=?').get(row.symbol_id);
  if(!current || !['exact','match_unresolved','mismatch'].includes(current.status)) { deferred.push(row.symbol_id); continue; }
  eligible.push(row);
}
db.exec('BEGIN IMMEDIATE');
try {
  for(const row of eligible) {
    db.prepare('UPDATE func_status SET confirmed=1 WHERE symbol_id=?').run(row.symbol_id);
    db.prepare("UPDATE tasks SET state='done',updated_at=? WHERE symbol_id=? AND state IN ('open','needs_cleanup','hard')").run(Date.now(),row.symbol_id);
  }
  db.prepare('INSERT INTO events(at,type,user_id,data) VALUES(?,?,NULL,?)').run(Date.now(),'historical_confirmations_imported',JSON.stringify({source:evidence.sourceDatabase,accepted:eligible.map(r=>r.symbol_id),deferred,method:'unchanged full source at historical confirmed commit; current compiler measurement retained'}));
  db.exec('COMMIT');
} catch(error) { db.exec('ROLLBACK'); throw error; }
console.log(JSON.stringify({imported:eligible.length,deferred:deferred.length,deferredIds:deferred}));
db.close();
