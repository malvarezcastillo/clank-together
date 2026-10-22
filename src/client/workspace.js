// A contributor workspace is a git clone of the canonical repo with a `.td/`
// directory (ignored by git) holding the token, target exe, symbol snapshot,
// toolchain settings and the local Ghidra project.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PEImage } from '../shared/pe.js';
import { loadProject } from '../shared/project.js';

export class Workspace {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.tdDir = path.join(this.dir, '.td');
    this.configFile = path.join(this.tdDir, 'config.json');
    this.config = fs.existsSync(this.configFile) ? JSON.parse(fs.readFileSync(this.configFile, 'utf8')) : {};
    this._pe = null;
    this._symbols = null;
  }

  /** Finds the workspace containing `start` (walking up), or throws. */
  static find(start = process.cwd()) {
    let d = path.resolve(start);
    for (;;) {
      if (fs.existsSync(path.join(d, '.td', 'config.json'))) return new Workspace(d);
      const up = path.dirname(d);
      if (up === d) throw new Error('not inside a Clank Together workspace (run `td setup <server-url> <dir>` first)');
      d = up;
    }
  }

  save() {
    fs.mkdirSync(this.tdDir, { recursive: true });
    fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2) + '\n', { mode: 0o600 });
  }

  get project() {
    return loadProject(this.dir);
  }

  get targetFile() {
    return path.join(this.tdDir, 'target.exe');
  }

  get symbolsFile() {
    return path.join(this.tdDir, 'symbols.json');
  }

  get pe() {
    if (!this._pe) this._pe = new PEImage(fs.readFileSync(this.targetFile));
    return this._pe;
  }

  /** ID -> symbol, from the snapshot downloaded from the server. */
  get symbols() {
    if (this._symbols) return this._symbols;
    const snap = JSON.parse(fs.readFileSync(this.symbolsFile, 'utf8'));
    const cols = snap.columns;
    this._symbols = new Map(
      snap.symbols.map((row) => {
        const o = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
        o.library = !!o.library;
        return [o.id, o];
      }),
    );
    return this._symbols;
  }

  get nameIndex() {
    const m = new Map();
    for (const s of this.symbols.values()) if (s.decorated) m.set(s.decorated, s.id);
    return m;
  }

  findSymbol(query) {
    const q = String(query).trim();
    if (this.symbols.has(q)) return this.symbols.get(q);
    if (/^(0x)?[0-9a-f]+$/i.test(q)) {
      const a = Number.parseInt(q, 16);
      for (const s of this.symbols.values()) if (s.addr === a) return s;
      return null;
    }
    for (const s of this.symbols.values()) if (s.name === q || s.decorated === q) return s;
    return null;
  }

  git(...args) {
    return this.gitRaw(...args).trim();
  }

  gitRaw(...args) {
    return execFileSync('git', args, { cwd: this.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  head() {
    return this.git('rev-parse', 'HEAD');
  }

  /** Size in bytes of a file as HEAD has it, or null if HEAD does not have it. */
  size(file) {
    try {
      return Number(this.git('cat-file', '-s', `HEAD:${file}`));
    } catch {
      return null;
    }
  }

  /** Files changed relative to HEAD (modified, added, untracked). */
  changedFiles() {
    // Untrimmed: each porcelain line starts with a two-column status that may begin with a space.
    const out = this.gitRaw('status', '--porcelain', '--untracked-files=all');
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''))
      .filter((f) => !f.startsWith('.td/'));
  }
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
