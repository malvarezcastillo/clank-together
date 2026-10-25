const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const root = '/var/lib/docker/volumes/rodecomp_data/_data';
const repo = path.join(root, 'repo');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = path.join(root, 'admin-backups', `readable-source-${stamp}`);
fs.mkdirSync(destination, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
if (git('status', '--porcelain')) throw new Error('Canonical repository is dirty; no import performed');
const db = new DatabaseSync(path.join(root, 'td.sqlite'));
db.exec('PRAGMA busy_timeout=15000');
const running = db.prepare("SELECT COUNT(*) n FROM check_jobs WHERE state IN ('queued','running')").get().n;
const verifying = db.prepare("SELECT COUNT(*) n FROM batches WHERE state IN ('queued','verifying','merging')").get().n;
if (running || verifying) throw new Error('Live verification/merge jobs exist; no import performed');
const before = {
  stamp,
  head: git('rev-parse', 'HEAD'),
  tasks: db.prepare('SELECT state,count(*) n FROM tasks GROUP BY state').all(),
  attempts: db.prepare('SELECT state,kind,count(*) n FROM attempts GROUP BY state,kind').all(),
  batchCounts: db.prepare('SELECT state,count(*) n FROM batches GROUP BY state').all(),
  schemas: db.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','trigger')").all(),
  funcStatus: db.prepare('SELECT * FROM func_status').all(),
  symbols: db.prepare('SELECT id,unit,decorated,name,library FROM symbols').all(),
  tasksFull: db.prepare('SELECT * FROM tasks').all(),
  reviews: db.prepare('SELECT count(*) n FROM peer_reviews').get().n,
  humanReviews: db.prepare('SELECT count(*) n FROM reviews').get().n
};
db.prepare('VACUUM INTO ?').run(path.join(destination, 'td.sqlite'));
execFileSync('git', ['bundle', 'create', path.join(destination, 'repo.bundle'), '--all'], { cwd: repo });
execFileSync('tar', ['-czf', path.join(destination, 'repo.tar.gz'), '-C', root, 'repo']);
fs.copyFileSync(path.join(root, 'server.json'), path.join(destination, 'server.json'));
fs.copyFileSync('/tmp/bulk-import-payload.json', path.join(destination, 'payload.json'));
fs.writeFileSync(path.join(destination, 'before.json'), JSON.stringify(before, null, 2));
const integrity = new DatabaseSync(path.join(destination, 'td.sqlite'), { readOnly: true });
if (integrity.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup database integrity failed');
integrity.close();
const result = { destination, head: before.head, reviews: before.reviews, humanReviews: before.humanReviews, payloadSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(destination, 'payload.json'))).digest('hex'), backupIntegrity: 'ok' };
fs.writeFileSync(path.join(root, 'bulk-import-backup-latest.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
db.close();
