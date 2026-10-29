// Offline, fail-closed maintenance for one unreferenced declaration-only header.
// The operator stops and drains the worker first and keeps all Git writers stopped.
import fs from 'node:fs';
import path from 'node:path';
import { loadProject } from '../shared/project.js';
import { scanVariables } from './globals.js';

const HEADER = /\.(h|hpp|inl)$/i;
const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const normalized = (file) => file.replace(/\\/g, '/').toLowerCase();
const basename = (file) => normalized(file).split('/').at(-1);

function safePath(file) {
  return typeof file === 'string' && file.length > 0 && !/[\\:\x00-\x1f\x7f]/.test(file) &&
    file.split('/').every((part) => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

function assertDrained({ checks, store, verifier, merger }, workerStopped) {
  if (workerStopped !== true) throw new Error('stop and drain the worker, then pass --worker-stopped; keep all Git writers stopped until this command exits');
  if (checks.workerAlive() || verifier.running || merger.busy || checks.running ||
      store.get("SELECT 1 FROM batches WHERE state IN ('verifying', 'merging') LIMIT 1") ||
      store.get("SELECT 1 FROM attempts WHERE state IN ('verifying', 'merging') LIMIT 1") ||
      store.get("SELECT 1 FROM tasks WHERE state = 'merging' LIMIT 1") ||
      store.get("SELECT 1 FROM check_jobs WHERE state = 'running' LIMIT 1")) {
    throw new Error('worker is active or not drained; stop it gracefully and wait at least 30 seconds after its last heartbeat');
  }
}

function assertDeclarationOnly(text) {
  // Also reject malformed/unattached provenance: it must never disappear merely because the
  // annotation parser cannot attach it to a declaration. SIZE/OFFSET are layout, not provenance.
  if (/\b(?:FUNCTION|STUB|GLOBAL|VTABLE|STRING|LIBRARY|IMPL|DATA|PROVENANCE)\s*:|\b(?:FUNCTION|STUB|GLOBAL|VTABLE|STRING|LIBRARY)\s+(?:(?:fn|gl|vt|st)_\d+|0x[0-9a-f]+)|\bINLINED\b/i.test(text)) {
    throw new Error('header contains implementation or data provenance annotations');
  }
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').replace(/\\\r?\n/g, '');
  for (const line of code.split('\n')) {
    if (!/^\s*#/.test(line)) continue;
    if (!/^\s*#\s*(?:if(?:n?def)?\b|elif\b|else\b|endif\b|include\b|pragma\s+once\s*$|define\s+[A-Za-z_]\w*\s*$)/.test(line)) {
      throw new Error('header is not declaration-only (unsupported directive or value/function-like macro)');
    }
  }
  const declarations = code.replace(/^\s*#[^\n]*/gm, '');
  if (/(?:\?\?<|\?\?>|<%|%>)/.test(declarations)) throw new Error('header is not declaration-only (alternate brace tokens)');
  // Conservative by design: no initializers, aliases using '=', or defaulted implementations.
  if (declarations.includes('=') || scanVariables(text).some((v) => v.definition)) {
    throw new Error('header is not declaration-only (initializer or storage definition)');
  }
  let start = 0;
  const scopes = [];
  for (let i = 0; i < declarations.length; i++) {
    const c = declarations[i];
    if (c === '{') {
      const prefix = declarations.slice(start, i).trim();
      if (!/^(?:(?:typedef\s+)?(?:class|struct|union|enum)\b[^()=;{}]*|namespace(?:\s+[A-Za-z_]\w*(?:::\w+)*)?|extern\s+"C(?:\+\+)?")$/.test(prefix)) {
        throw new Error('header is not declaration-only (function body or unsupported scope)');
      }
      scopes.push(/^(?:typedef\s+)?(?:class|struct|union|enum)\b/.test(prefix));
      start = i + 1;
    } else if (c === '}') {
      if (!scopes.length) throw new Error('header has unbalanced declaration scopes');
      if (scopes.pop() && !/^\s*;/.test(declarations.slice(i + 1))) {
        throw new Error('header is not declaration-only (declarator after a type definition)');
      }
      start = i + 1;
    } else if (c === ';') start = i + 1;
  }
  if (scopes.length) throw new Error('header has unbalanced declaration scopes');
}

function assertUnreferenced(repo, store, project, head, file) {
  const name = basename(file);
  const same = (value) => normalized(value) === normalized(file) || basename(value) === name;
  if (Object.keys(project.compile?.units ?? {}).some(same) || store.all('SELECT unit FROM symbols WHERE unit IS NOT NULL').some((r) => same(r.unit)) ||
      store.all('SELECT file FROM func_status WHERE file IS NOT NULL').some((r) => same(r.file))) {
    throw new Error('header is registered as a translation unit or function owner');
  }
  const deps = store.all('SELECT unit, header FROM unit_deps').filter((r) => same(r.header) || same(r.unit));
  if (deps.length) throw new Error(`header has stored unit_deps references: ${deps.slice(0, 10).map((r) => `${r.unit} -> ${r.header}`).join(', ')}`);
  // Scan every tracked blob, not just known source extensions: build lists, forced includes,
  // scripts and configuration files also count. Removing NULs covers UTF-16 project files.
  const files = repo.git(['ls-tree', '-r', '--name-only', '-z', head]).split('\0').filter((f) => f && f !== file);
  for (let i = 0; i < files.length; i += 64) {
    for (const [source, text] of repo.showMany(head, files.slice(i, i + 64))) {
      if (text === null) throw new Error(`cannot read tracked file ${source}`);
      const folded = text.replace(/\0/g, '').replace(/\\\r?\n/g, '').toLowerCase();
      if (folded.includes(name) || folded.includes(normalized(file))) throw new Error(`header is referenced by ${source} (full path or basename)`);
    }
  }
}

/** Local administrator command only; no HTTP deletion endpoint or recursive deletion. */
export function deleteOrphanHeader(ctx, { admin, file, reason, expectedHead, expectedBlob, backupDir, workerStopped }) {
  const { repo, store, config, accounts, merger } = ctx;
  const user = accounts.requireUser(admin);
  if (user.role !== 'admin' || user.status !== 'active') throw new Error('an active admin identity is required');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500 || /[\x00-\x1f\x7f]/.test(reason)) throw new Error('a single-line --reason of 1..500 characters is required');
  if (!HASH.test(expectedHead ?? '') || !HASH.test(expectedBlob ?? '')) throw new Error('--expected-head and --expected-blob must be full Git object hashes');
  if (!safePath(file) || !HEADER.test(file)) throw new Error('path must be a canonical repository-relative .h, .hpp or .inl header without traversal');
  if (typeof backupDir !== 'string' || !backupDir) throw new Error('--backup-dir must name an existing directory outside the repository');
  const external = fs.realpathSync(backupDir);
  const root = fs.realpathSync(repo.dir);
  const relative = path.relative(root, external);
  if (!fs.statSync(external).isDirectory() || !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('backup directory must be outside the repository');
  }
  assertDrained(ctx, workerStopped);
  const lock = path.join(config.dataDir, 'orphan-header.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  let backup;
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, admin: user.name, file, expectedHead }) + '\n');
    assertDrained(ctx, workerStopped);
    const assertHead = () => {
      if (repo.head() !== expectedHead) throw new Error('HEAD changed; inspect the new snapshot and supply fresh expected hashes');
      if (!repo.isClean()) throw new Error('dirty repository; preserve unrelated edits and retry with a clean tree');
    };
    assertHead();
    const project = loadProject(repo.dir, (f) => repo.showMany(expectedHead, [f]).get(f));
    const roots = [...project.sourceDirs, ...project.includeDirs, ...project.headerGlobs.map((g) => g.split(/[?*[]/, 1)[0].replace(/\/$/, ''))];
    if (!roots.some((r) => safePath(r) && file.startsWith(`${r}/`))) throw new Error('header is outside configured source/header roots');
    const entry = repo.git(['ls-tree', '-z', expectedHead, '--', `:(literal)${file}`]);
    const match = /^(100644|100755) blob ([a-f0-9]+)\t([^\0]+)\0$/.exec(entry);
    if (!match || match[3] !== file) throw new Error('header must be a tracked regular file (not a symlink, directory or untracked file)');
    if (match[2] !== expectedBlob) throw new Error('header blob changed; inspect it and supply a fresh --expected-blob');
    let absolute = root;
    for (const part of file.split('/')) {
      absolute = path.join(absolute, part);
      if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error('symlink paths are forbidden');
    }
    if (!fs.statSync(absolute).isFile()) throw new Error('header must be a regular file');
    const bytes = fs.readFileSync(absolute);
    if (repo.git(['hash-object', `--path=${file}`, '--stdin'], { input: bytes }).trim() !== expectedBlob) throw new Error('header bytes differ from the expected blob');
    assertDeclarationOnly(bytes.toString('utf8'));
    assertUnreferenced(repo, store, project, expectedHead, file);
    assertHead();
    backup = fs.mkdtempSync(path.join(external, 'td-orphan-header-'));
    const details = { file, reason, expectedHead, expectedBlob, backup: path.join(backup, path.basename(file)) };
    fs.writeFileSync(details.backup, bytes, { flag: 'wx', mode: 0o600, flush: true });
    fs.writeFileSync(path.join(backup, 'deletion.json'), JSON.stringify({ ...details, admin: user.name, userId: user.id }, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
    store.event('orphan_header_delete_started', user.id, details);
    // A fresh stopped-worker/HEAD check belongs in the audited failure region too.
    let commit;
    try {
      assertDrained(ctx, workerStopped);
      assertHead();
      commit = repo.deleteFile(file, bytes, expectedHead, expectedBlob,
        `Maintenance: delete orphan header ${file}\n\nAdmin: ${user.name}\nReason: ${reason}\nExpected HEAD: ${expectedHead}\nDeleted blob: ${expectedBlob}\nExternal backup: ${details.backup}\n`,
        `${user.name} <${user.name.replace(/[^A-Za-z0-9_.-]/g, '_')}@users.clank-together.invalid>`);
    } catch (error) {
      store.event('orphan_header_delete_failed', user.id, { ...details, error: error.message });
      throw error;
    }
    store.event('orphan_header_deleted', user.id, { ...details, commit });
    // No direct progress/task/status rewrites: use the ordinary publication path.
    merger.afterCommit(commit);
    return { ...details, commit, admin: user.name };
  } catch (error) {
    if (backup) error.message += `; external backup retained at ${backup}`;
    throw error;
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
