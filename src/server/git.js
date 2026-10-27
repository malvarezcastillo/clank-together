// Canonical repository handling: reads, three-way merges, commits, and
// read-only clone access through `git http-backend`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

export class Repo {
  constructor(dir) {
    this.dir = dir;
  }

  git(args, opts = {}) {
    try {
      return execFileSync('git', args, { cwd: this.dir, encoding: opts.encoding === undefined ? 'utf8' : opts.encoding, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], input: opts.input });
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
      this.git(['merge-base', '--is-ancestor', commit, 'HEAD']);
      return true;
    } catch {
      return false;
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

  isClean() {
    return this.git(['status', '--porcelain']).trim() === '';
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
          conflicts.push(file);
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
    // Nothing to commit (the code is already on main, e.g. a function resubmitted unchanged).
    if (!this.git(['status', '--porcelain', '--', ...Object.keys(files)]).trim()) return this.head();
    const name = process.env.TD_GIT_AUTHOR_NAME;
    const email = process.env.TD_GIT_AUTHOR_EMAIL;
    if (Boolean(name) !== Boolean(email)) throw new Error('set both TD_GIT_AUTHOR_NAME and TD_GIT_AUTHOR_EMAIL');
    const identity = name ? `${name} <${email}>` : author;
    this.git(['-c', `user.name=${name ?? 'Clank Together'}`, '-c', `user.email=${email ?? 'bot@clank-together.invalid'}`, 'commit', '-q', '--author', identity, '-F', '-'], { input: message });
    return this.head();
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
