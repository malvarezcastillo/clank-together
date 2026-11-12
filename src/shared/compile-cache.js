// Cache of compiler outputs (.obj, .cod, .i and the compiler log): a unit compiled from the same
// inputs is not compiled again. Contributors share one per machine (every workspace and worktree);
// the server keeps one in its data directory for verification, merge and baseline builds.
//
// Lookup works like ccache's direct mode. The manifest key covers the compiler identity (a local
// executable's stat, or the container image ID), the flags (with the job directory replaced by a
// placeholder), the unit's environment, the text of the unit and its prelude, and the list of
// every file path in the tree (so a header that appears earlier on the include path, or that a
// `__has_include` probe now finds, is a miss). Each manifest lists the outputs it has seen with the
// content hash of every project header the unit included then (from /showIncludes); an entry is a
// hit when all of those headers still hash the same. Compiler and SDK headers are covered by the
// compiler identity: a toolchain never changes in place.
//
// Outputs keep the paths of the job directory that produced them: the .obj debug info, the
// listing and the /P output name sources by absolute path. The analysis matches those by suffix
// (repo-relative path), so they compare the same from any job directory; the log is rewritten,
// because projectIncludes reads it by the current job directory's prefix.
//
// Contributors: TD_COMPILE_CACHE=off disables it; TD_COMPILE_CACHE=<dir> moves it.
// TD_COMPILE_CACHE_MB caps its size (default 20000); the least recently used outputs go first.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION = 2;
const MAX_ENTRIES_PER_MANIFEST = 8;
const PRUNE_EVERY_MS = 60 * 60_000;

export function cacheDir() {
  const v = process.env.TD_COMPILE_CACHE;
  if (v === 'off' || v === '0') return null;
  return v || path.join(os.homedir(), '.clank', 'cache', 'compile');
}

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    // Windows refuses to replace a file another process has open; the other copy is as good.
    if (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY') throw e;
  }
}

/** Identity of a compiler executable: path, size and mtime (toolchain dirs are content-named). */
const compilerIds = new Map();
export function compilerId(runner) {
  const k = `${runner.type}\0${runner.clPath}\0${runner.wine ?? ''}`;
  if (!compilerIds.has(k)) {
    let st = null;
    try {
      st = fs.statSync(runner.clPath);
    } catch {}
    compilerIds.set(k, `${k}\0${st?.size ?? '-'}\0${st?.mtimeMs ?? '-'}`);
  }
  return compilerIds.get(k);
}

/**
 * Hash of the sorted paths of every file under `dirs` of `jobDir`. Part of the key: a header added
 * where an include resolves before the one a unit used (or a `__has_include` probe that now finds
 * a file) changes the compile without changing any file the unit read.
 */
export function treeListHash(jobDir, dirs) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else out.push(r);
    }
  };
  for (const d of [...new Set(dirs)].sort()) walk(path.join(jobDir, d), d);
  return sha(out.sort().join('\n'));
}

/**
 * One cache for one compileUnits call. File hashes are memoized for the call: a header shared by
 * hundreds of units is read once. `capMb`: size cap for pruning (default TD_COMPILE_CACHE_MB or
 * 20000).
 */
export class CompileCache {
  constructor({ dir = cacheDir(), jobDir, capMb = null }) {
    this.dir = dir;
    this.jobDir = path.resolve(jobDir);
    this.hashes = new Map();
    this.capMb = capMb;
  }

  get enabled() {
    return !!this.dir;
  }

  /** Content hash of a job-relative file, or null when it does not exist. */
  fileHash(rel) {
    if (this.hashes.has(rel)) return this.hashes.get(rel);
    let h = null;
    try {
      h = sha(fs.readFileSync(path.join(this.jobDir, rel)));
    } catch {}
    this.hashes.set(rel, h);
    return h;
  }

  /**
   * @param {object} p
   * @param {object} p.runner
   * @param {string[]} p.args       compile arguments (before the output paths are appended)
   * @param {string} p.root         how the job directory appears in args (replaced by a placeholder)
   * @param {object} p.env          the unit's own environment (filled)
   * @param {string} p.file         the unit, job-relative
   * @param {string|null} p.prelude its forced-include prelude, job-relative
   * @param {object} p.context      everything else that decides the compile: the compiler identity
   *                                (a local executable's stat, a container image ID) and the tree's
   *                                file list (treeListHash)
   */
  manifestKey({ runner, args, root, env, file, prelude, context }) {
    const norm = (s) => s.split(root).join('${JOB}');
    return sha(JSON.stringify([
      VERSION,
      context,
      runner.env ?? {},
      env,
      args.map(norm),
      file,
      this.fileHash(file),
      prelude,
      prelude ? this.fileHash(prelude) : null,
    ]));
  }

  manifestFile(key) {
    return path.join(this.dir, 'manifests', key.slice(0, 2), `${key}.json`);
  }

  readManifest(key) {
    try {
      const m = JSON.parse(fs.readFileSync(this.manifestFile(key), 'utf8'));
      return Array.isArray(m) ? m : [];
    } catch {
      return [];
    }
  }

  /**
   * The cached outputs for this unit, copied to `outBase` + .obj/.cod/.i, or null on a miss.
   * `wantPre`: the /P output is needed too. Returns {log} (rewritten to this job directory).
   */
  restore(key, outBase, { wantPre, root }) {
    if (!this.enabled) return null;
    for (const entry of this.readManifest(key)) {
      if (wantPre && !entry.pre) continue;
      if (!Object.entries(entry.deps).every(([rel, h]) => this.fileHash(rel) === h)) continue;
      const dir = path.join(this.dir, 'objects', entry.out.slice(0, 2), entry.out);
      try {
        const now = new Date();
        fs.utimesSync(dir, now, now); // LRU mark for pruning
        for (const ext of ['.obj', '.cod', ...(wantPre ? ['.i'] : [])]) fs.copyFileSync(path.join(dir, `out${ext}`), outBase + ext);
        const log = fs.readFileSync(path.join(dir, 'out.log'), 'utf8').split('${JOB}').join(root);
        return { log };
      } catch {
        // Pruned or half-written by another process: try the next entry, then compile.
        for (const ext of ['.obj', '.cod', '.i']) fs.rmSync(outBase + ext, { force: true });
      }
    }
    return null;
  }

  /**
   * Stores a successful compile. `includes`: project headers it included (job-relative), from
   * /showIncludes. `log` is stored with the job directory replaced by a placeholder.
   */
  store(key, outBase, { includes, log, hasPre, root }) {
    if (!this.enabled) return;
    try {
      const deps = {};
      for (const rel of includes) {
        const h = this.fileHash(rel);
        if (h === null) return; // a header vanished during the compile: nothing reliable to store
        deps[rel] = h;
      }
      const parts = { obj: fs.readFileSync(outBase + '.obj'), cod: fs.readFileSync(outBase + '.cod'), pre: hasPre ? fs.readFileSync(outBase + '.i') : null };
      const storedLog = log.split(root).join('${JOB}');
      const out = sha(Buffer.concat([parts.obj, parts.cod, parts.pre ?? Buffer.alloc(0), Buffer.from(storedLog)]));
      const dir = path.join(this.dir, 'objects', out.slice(0, 2), out);
      if (!fs.existsSync(path.join(dir, 'out.log'))) {
        writeAtomic(path.join(dir, 'out.obj'), parts.obj);
        writeAtomic(path.join(dir, 'out.cod'), parts.cod);
        if (parts.pre) writeAtomic(path.join(dir, 'out.i'), parts.pre);
        writeAtomic(path.join(dir, 'out.log'), storedLog); // written last: marks the entry complete
      }
      const entries = this.readManifest(key).filter((e) => e.out !== out && !(JSON.stringify(e.deps) === JSON.stringify(deps) && (!hasPre || e.pre)));
      entries.unshift({ out, deps, pre: !!parts.pre });
      writeAtomic(this.manifestFile(key), JSON.stringify(entries.slice(0, MAX_ENTRIES_PER_MANIFEST)));
    } catch {
      // A full disk or a racing writer must not fail the check: the compile itself succeeded.
    }
  }

  /** Drops least recently used outputs above the size cap; runs at most hourly per machine. */
  prune() {
    if (!this.enabled) return;
    const stamp = path.join(this.dir, 'pruned');
    try {
      if (Date.now() - fs.statSync(stamp).mtimeMs < PRUNE_EVERY_MS) return;
    } catch {}
    try {
      writeAtomic(stamp, String(Date.now()));
      const capMb = this.capMb ?? Number.parseInt(process.env.TD_COMPILE_CACHE_MB ?? '', 10);
      const cap = (capMb > 0 ? capMb : 20_000) * 1048576;
      const root = path.join(this.dir, 'objects');
      const all = [];
      let total = 0;
      for (const a of fs.existsSync(root) ? fs.readdirSync(root) : []) {
        for (const b of fs.readdirSync(path.join(root, a))) {
          const dir = path.join(root, a, b);
          let size = 0;
          for (const f of fs.readdirSync(dir)) size += fs.statSync(path.join(dir, f)).size;
          all.push({ dir, size, used: fs.statSync(dir).mtimeMs });
          total += size;
        }
      }
      all.sort((x, y) => x.used - y.used);
      for (const e of all) {
        if (total <= cap) break;
        fs.rmSync(e.dir, { recursive: true, force: true });
        total -= e.size;
      }
    } catch {}
  }
}
