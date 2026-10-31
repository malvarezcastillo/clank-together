// Canonical repository handling: reads, three-way merges, commits, and
// read-only clone access through `git http-backend`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { plainDeclaration, FORWARD } from './affected.js';

const MARK = 31; // conflict-marker width that ordinary source never contains
const HEADER = /\.(h|hh|hpp|hxx|inl)$/i;

// A header line that adding next to another side's additions cannot change layout or codegen of:
// blank, comment, plain non-virtual function declaration or forward declaration.
function harmlessHeaderLine(line) {
  const t = line.trim();
  return !t || t.startsWith('//') || !!plainDeclaration(t, null) || FORWARD.test(t);
}

/**
 * `git merge-file --diff3` output where every conflict is two independent insertions at the same
 * place (empty base): both kept, main's first. Null when any hunk edits shared lines, or, for a
 * header, when an added line could affect a layout (fields, virtuals, bodies, nested types...).
 * The result still goes through the normal compile, regression and ownership checks.
 */
export function unionAdditions(conflicted, file) {
  const lt = '<'.repeat(MARK), bar = '|'.repeat(MARK), eq = '='.repeat(MARK), gt = '>'.repeat(MARK);
  const out = [];
  let state = null; // null | 'ours' | 'base' | 'theirs'
  let ours = [], base = [], theirs = [];
  for (const line of conflicted.split('\n')) {
    if (state === null && line.startsWith(lt)) { state = 'ours'; ours = []; base = []; theirs = []; continue; }
    if (state === 'ours' && line.startsWith(bar)) { state = 'base'; continue; }
    if (state === 'base' && line === eq) { state = 'theirs'; continue; }
    if (state === 'theirs' && line.startsWith(gt)) {
      if (base.some((l) => l.trim())) return null;
      if (HEADER.test(file) && ![...ours, ...theirs].every(harmlessHeaderLine)) return null;
      // Both sides often add the same lines (one agent resubmitting work main already has).
      // Header additions here are single-line declarations: keep main's copy once. In source,
      // a shared top-level line (definition head, annotation) means the same definition twice;
      // dropping lines inside bodies is unsafe, so that stays a conflict.
      const have = new Set(ours.map((l) => l.trim()).filter(Boolean));
      if (HEADER.test(file)) {
        out.push(...ours, ...theirs.filter((l) => !l.trim() || !have.has(l.trim())));
      } else {
        const top = (l) => /^[^\s{}#]/.test(l);
        const ourTop = new Set(ours.filter(top).map((l) => l.trim()));
        if (theirs.some((l) => top(l) && ourTop.has(l.trim()))) return null;
        out.push(...ours, ...theirs);
      }
      state = null;
      continue;
    }
    if (state === 'ours') ours.push(line);
    else if (state === 'base') base.push(line);
    else if (state === 'theirs') theirs.push(line);
    else out.push(line);
  }
  return state === null ? out.join('\n') : null;
}

export class Repo {
  constructor(dir) {
    this.dir = dir;
  }

  git(args, opts = {}) {
    try {
      // The canonical tree lives on a case-sensitive filesystem; a repo created elsewhere (or a
      // stray config) can carry core.ignorecase=true, which makes `git add Md5.cpp` resolve to an
      // already tracked MD5.cpp and silently drop the new file from the commit.
      return execFileSync('git', ['-c', 'core.ignorecase=false', ...args], { cwd: this.dir, encoding: opts.encoding === undefined ? 'utf8' : opts.encoding, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], input: opts.input, timeout: opts.timeout, env: opts.env });
    } catch (e) {
      // git's own explanation, not just "Command failed".
      const why = `${e.stderr ?? ''}${e.stdout ?? ''}`.trim();
      if (why) e.message = `git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''} failed: ${why.slice(0, 2000)}`;
      throw e;
    }
  }

  head() {
    return this.git(['rev-parse', 'HEAD']).trim();
  }

  isAncestor(commit) {
    try {
      return this.ancestorOf(commit, 'HEAD');
    } catch {
      return false; // a submitted base may not exist locally
    }
  }

  ancestorOf(commit, descendant) {
    try {
      this.git(['merge-base', '--is-ancestor', commit, descendant]);
      return true;
    } catch (e) {
      if (e.status === 1) return false;
      throw e;
    }
  }

  /** File content at a commit, or null if it does not exist there. */
  show(commit, file) {
    try {
      return this.git(['show', `${commit}:${file}`]);
    } catch {
      return null;
    }
  }

  /** Reads a committed source snapshot with one Git process, not one process per file. */
  showMany(commit, files) {
    const result = new Map();
    if (!files.length) return result;
    const data = this.git(['cat-file', '--batch'], { input: files.map((f) => `${commit}:${f}\n`).join(''), encoding: null });
    let offset = 0;
    for (const file of files) {
      const end = data.indexOf(10, offset);
      if (end < 0) throw new Error('incomplete git cat-file response');
      const header = data.toString('utf8', offset, end);
      offset = end + 1;
      if (header.endsWith(' missing')) {
        result.set(file, null);
        continue;
      }
      const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
      if (!match) throw new Error(`expected source blob for ${file}`);
      const size = Number(match[1]);
      if (offset + size >= data.length || data[offset + size] !== 10) throw new Error('incomplete git source blob');
      result.set(file, data.toString('utf8', offset, offset + size));
      offset += size + 1;
    }
    return result;
  }

  /** Size in bytes of a file at a commit, or null if it does not exist there. */
  size(commit, file) {
    try {
      return Number(this.git(['cat-file', '-s', `${commit}:${file}`]).trim());
    } catch {
      return null;
    }
  }

  /** Every file path tracked at a commit. */
  trackedPaths(commit) {
    return this.git(['ls-tree', '-r', '--name-only', '-z', commit]).split('\0').filter(Boolean);
  }

  isClean() {
    return this.git(['status', '--porcelain']).trim() === '';
  }

  /** Fetches the branch we push, without discarding local commits or working-tree edits. */
  sync(remote) {
    const local = this.head();
    let branch;
    try {
      branch = this.git(['symbolic-ref', '--quiet', 'HEAD']).trim();
    } catch (e) {
      throw new Error(`repository sync refused at local HEAD ${local}: no checked-out branch; check out the branch to synchronize`, { cause: e });
    }
    const target = `${remote} ${branch}`;
    try {
      // Explicit refspec: never trust a stale tracking ref or fetch a differently named upstream.
      this.git(['fetch', '--no-tags', '--', remote, branch], { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
      const upstream = this.git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']).trim();
      const result = { remote, branch, before: local, head: local, remoteHead: upstream };
      if (!this.isClean()) {
        throw new Error(`dirty server working tree at local HEAD ${local}, remote ${upstream}; preserve and commit or move the edits before retrying; no working-tree files were changed`);
      }
      if (local === upstream) return { ...result, state: 'current' };
      if (this.ancestorOf(upstream, local)) return { ...result, state: 'ahead' };
      if (!this.ancestorOf(local, upstream)) {
        throw new Error(`diverged: local HEAD ${local}, remote ${upstream}; a maintainer must reconcile these histories explicitly and retry; no reset, rebase or merge was performed`);
      }
      // --no-overwrite-ignore also preserves ignored local files that become tracked upstream.
      this.git(['-c', 'merge.autoStash=false', 'merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', upstream]);
      return { ...result, state: 'fast-forward', head: this.head() };
    } catch (e) {
      throw new Error(`repository sync from ${target} failed (local HEAD ${local}): ${e.message}`, { cause: e });
    }
  }

  /**
   * Three-way merges submitted files (written against `base`) onto HEAD.
   * @returns {{files: Record<string,string>, conflicts: string[]}}
   */
  mergeOntoHead(base, files) {
    const head = this.head();
    const out = {};
    const conflicts = [];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'td-merge-'));
    try {
      for (const [file, theirs] of Object.entries(files)) {
        const baseText = this.show(base, file);
        const headText = this.show(head, file);
        if (baseText === headText || headText === null) {
          out[file] = theirs;
          continue;
        }
        if (baseText === null) {
          // Both sides created the file independently.
          conflicts.push(file);
          continue;
        }
        const [b, h, t] = ['base', 'head', 'theirs'].map((n) => path.join(tmp, n));
        fs.writeFileSync(b, baseText);
        fs.writeFileSync(h, headText);
        fs.writeFileSync(t, theirs);
        try {
          out[file] = execFileSync('git', ['merge-file', '-p', h, b, t], { encoding: 'utf8' });
        } catch {
          let marked = null;
          try {
            execFileSync('git', ['merge-file', '-p', '--diff3', `--marker-size=${MARK}`, h, b, t], { encoding: 'utf8' });
          } catch (e) {
            if (e.status > 0) marked = e.stdout;
          }
          const union = marked === null ? null : unionAdditions(marked, file);
          if (union === null) conflicts.push(file);
          else out[file] = union;
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return { files: out, conflicts };
  }

  /** Three-way merge of texts: the change from base to theirs applied to ours, or null on a conflict. */
  merge3(ours, base, theirs) {
    if (base === theirs) return ours;
    if (base === ours) return theirs;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'td-merge-'));
    try {
      const [b, o, t] = ['base', 'ours', 'theirs'].map((n) => path.join(tmp, n));
      fs.writeFileSync(b, base);
      fs.writeFileSync(o, ours);
      fs.writeFileSync(t, theirs);
      return execFileSync('git', ['merge-file', '-p', o, b, t], { encoding: 'utf8' });
    } catch {
      return null;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  commitFiles(files, message, author) {
    for (const [file, content] of Object.entries(files)) {
      const abs = path.join(this.dir, file);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    this.git(['add', '--', ...Object.keys(files)]);
    this.assertStaged(files);
    // Nothing to commit (the code is already on main, e.g. a function resubmitted unchanged).
    if (!this.git(['status', '--porcelain', '--', ...Object.keys(files)]).trim()) return this.head();
    const name = process.env.TD_GIT_AUTHOR_NAME;
    const email = process.env.TD_GIT_AUTHOR_EMAIL;
    if (Boolean(name) !== Boolean(email)) throw new Error('set both TD_GIT_AUTHOR_NAME and TD_GIT_AUTHOR_EMAIL');
    const identity = name ? `${name} <${email}>` : author;
    this.git(['-c', `user.name=${name ?? 'Clank Together'}`, '-c', `user.email=${email ?? 'bot@clank-together.invalid'}`, 'commit', '-q', '--author', identity, '-F', '-'], { input: message });
    return this.head();
  }

  /** Delete exactly one validated file. A private index and CAS protect unrelated edits/HEAD. */
  deleteFile(file, bytes, expectedHead, expectedBlob, message, author) {
    const name = process.env.TD_GIT_AUTHOR_NAME;
    const email = process.env.TD_GIT_AUTHOR_EMAIL;
    if (Boolean(name) !== Boolean(email)) throw new Error('set both TD_GIT_AUTHOR_NAME and TD_GIT_AUTHOR_EMAIL');
    const identity = /^(.+) <([^<>]+)>$/.exec(name ? `${name} <${email}>` : author);
    if (!identity) throw new Error('invalid Git author identity');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'td-delete-'));
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, 'index'), GIT_AUTHOR_NAME: identity[1], GIT_AUTHOR_EMAIL: identity[2], GIT_COMMITTER_NAME: name ?? 'Clank Together', GIT_COMMITTER_EMAIL: email ?? 'bot@clank-together.invalid' };
    const absolute = path.join(this.dir, file);
    const literal = `:(literal)${file}`;
    const mode = this.git(['ls-files', '--stage', '--', literal]).split(' ')[0];
    let removed = false;
    let staged = false;
    let committed = false;
    try {
      this.git(['read-tree', expectedHead], { env });
      this.git(['update-index', '--force-remove', '--', file], { env });
      const tree = this.git(['write-tree'], { env }).trim();
      const commit = this.git(['commit-tree', tree, '-p', expectedHead, '-F', '-'], { env, input: message }).trim();
      if (this.head() !== expectedHead) throw new Error('HEAD changed before deletion');
      if (!this.isClean() || !fs.readFileSync(absolute).equals(bytes)) throw new Error('repository changed before deletion; preserving edits');
      fs.unlinkSync(absolute);
      removed = true;
      this.git(['update-index', '--force-remove', '--', file]);
      staged = true;
      // Unlike `git commit`, this cannot accidentally commit on top of a concurrent new HEAD.
      this.git(['update-ref', '-m', 'maintenance: delete orphan header', 'HEAD', commit, expectedHead]);
      committed = true;
      return commit;
    } catch (error) {
      if (!committed) {
        // Only undo our own missing path/index entry; never reset/clean the repository or
        // overwrite a file/index entry another writer created despite the offline contract.
        if (removed && !fs.existsSync(absolute)) fs.writeFileSync(absolute, bytes, { flag: 'wx', mode: mode === '100755' ? 0o755 : 0o644 });
        if (staged && !this.git(['ls-files', '--stage', '--', literal]).trim()) {
          this.git(['update-index', '--add', '--cacheinfo', `${mode},${expectedBlob},${file}`]);
        }
      }
      throw error;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Every written file must be in the index under exactly its own path and content. A path that
   * the index resolves to a differently cased entry (or that is ignored) would otherwise vanish
   * from the commit while the merge reports success.
   */
  assertStaged(files) {
    const paths = Object.keys(files);
    const staged = new Map();
    for (const line of this.git(['ls-files', '-s', '-z', '--', ...paths]).split('\0').filter(Boolean)) {
      const tab = line.indexOf('\t');
      staged.set(line.slice(tab + 1), line.slice(0, tab).split(' ')[1]);
    }
    const expected = this.git(['hash-object', '--stdin-paths'], { input: paths.join('\n') + '\n' }).trim().split('\n');
    const missing = paths.filter((p, i) => staged.get(p) !== expected[i]);
    if (missing.length) {
      this.git(['reset', '-q', '--', ...paths]);
      throw new Error(`files did not reach the index under their own path (case collision or ignore rule?): ${missing.join(', ')}`);
    }
  }

  /** Discards uncommitted changes (after a failed merge attempt). */
  reset() {
    this.git(['reset', '-q', '--hard', 'HEAD']);
    this.git(['clean', '-qfd']);
  }

  push(remote) {
    this.git(['push', '-q', remote, 'HEAD']);
  }
}

/**
 * Serves read-only smart-HTTP clones of `repoDir` under `/git/repo`.
 * Pushes are refused here and in the repo config.
 */
export function serveGit(req, res, { projectRoot, subPath, query }) {
  const allowed = subPath === '/repo/info/refs' ? query.get('service') === 'git-upload-pack' : subPath === '/repo/git-upload-pack' || subPath === '/repo/HEAD';
  if (!allowed) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('read-only repository\n');
    return;
  }
  const env = {
    PATH: process.env.PATH,
    GIT_PROJECT_ROOT: projectRoot,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: subPath,
    REQUEST_METHOD: req.method,
    QUERY_STRING: query.toString(),
    CONTENT_TYPE: req.headers['content-type'] ?? '',
    REMOTE_ADDR: req.socket.remoteAddress ?? '',
    HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
    GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
  };
  if (req.headers['content-length']) env.CONTENT_LENGTH = req.headers['content-length'];
  const child = spawn('git', ['http-backend'], { env });
  req.pipe(child.stdin);

  let headerBuf = Buffer.alloc(0);
  let headersDone = false;
  child.stdout.on('data', (chunk) => {
    if (headersDone) return void res.write(chunk);
    headerBuf = Buffer.concat([headerBuf, chunk]);
    const idx = headerBuf.indexOf('\r\n\r\n');
    if (idx < 0) return;
    headersDone = true;
    let status = 200;
    const headers = {};
    for (const line of headerBuf.subarray(0, idx).toString().split('\r\n')) {
      const c = line.indexOf(':');
      if (c < 0) continue;
      const k = line.slice(0, c).trim();
      const v = line.slice(c + 1).trim();
      if (k.toLowerCase() === 'status') status = parseInt(v, 10);
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    res.write(headerBuf.subarray(idx + 4));
  });
  child.stdout.on('end', () => res.end());
  child.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}
