// Verification of submitted attempts: static gate, sandboxed compile,
// byte comparison, regression check, and routing of the result.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { lintAnnotations } from '../shared/annotations.js';
import { lintSubmission, movedFrom } from '../shared/lint.js';
import { freeTextErrorsAcross, executionCharset, encodedLiteralRules, VIRTUALIZED_RE } from '../shared/freetext.js';
import { offsetErrors } from '../shared/offsets.js';
import { unannotatedErrors } from '../shared/unannotated.js';
import { checkUnits } from '../shared/check.js';
import { reconcile } from '../shared/reconcile.js';
import { STATUS, sameOriginal, resolvedEffectiveHash } from '../shared/compare.js';
import { listSources, isUnit, unitSettings, loadProject, loadToolchainLock, scanAnnotations } from '../shared/project.js';
import { changedNames, unitsMentioning, virtualNames } from './affected.js';
import { undefinedDeclarations } from './undefined.js';
import { sourceIncluders } from './includers.js';
import { globalViolations } from './globals.js';
import { functionRegions } from './split.js';
import { className } from './grouping.js';
import { now } from './db.js';
import { returnBatch, batchAttempts, settleBatch, holdFor, AUTHOR_HOLD_MS } from './batches.js';
import { analyzeInWorkers } from './analyze.js';

// A batch whose verification compiles more units than this is big (it changes a widely used header).
export const BIG_BATCH = 20;

export const BUILD_READY = "COALESCE(json_extract(result_json, '$.buildRetry.retryAt'), 0) <= ?";

/**
 * batch_checks.check_json is stored gzipped: a broad header change makes it tens of megabytes of
 * JSON, and writing that uncompressed held the database write lock long enough to starve the
 * other process. Rows written before this are plain JSON text and still read.
 */
export const encodeCheck = (value) => gzipSync(JSON.stringify(value), { level: 6 });
export const decodeCheck = (stored) => JSON.parse(typeof stored === 'string' ? stored : gunzipSync(stored).toString('utf8'));

export class BuildRetryError extends Error {
  constructor(check, stage) {
    const failed = check.units.filter((u) => !u.compiled || u.timedOut);
    const kind = failed.some((u) => u.timedOut) ? 'timeout' : 'baseline_failed';
    super(`${stage}: ${kind}`);
    this.diagnostic = { kind, stage, retryAt: now() + 60_000, files: failed.map((u) => u.file),
      errors: failed.map((u) => ({ file: u.file, log: u.log })) };
  }
}

// The longest prologue a protector stub keeps before it jumps into the virtual machine.
const STUB_MAX = 96;

/**
 * The VIRTUALIZED marker in the annotation block of a function: `{ build, addr }`, or null.
 * The block is the run of comment lines right above the definition the FUNCTION line belongs to.
 */
export function virtualizedMarker(files, symbolId) {
  const fnRe = new RegExp(`^\\s*//\\s*FUNCTION\\s*:\\s*${symbolId}\\b`);
  for (const text of Object.values(files)) {
    const lines = String(text).split(/\r?\n/);
    const at = lines.findIndex((l) => fnRe.test(l));
    if (at < 0) continue;
    for (let i = at - 1; i >= 0 && /^\s*\/\//.test(lines[i]); i--) {
      const m = VIRTUALIZED_RE.exec(lines[i].trim());
      if (m) return { build: m[1], addr: m[2] };
    }
    for (let i = at + 1; i < lines.length && /^\s*\/\//.test(lines[i]); i++) {
      const m = VIRTUALIZED_RE.exec(lines[i].trim());
      if (m) return { build: m[1], addr: m[2] };
    }
    return null;
  }
  return null;
}

/**
 * Whether the original at `addr` is a protector stub: within its first STUB_MAX bytes a jmp rel32
 * (E9) leaves for a section whose bytes are not in the file (the virtual machine fills it at load).
 * The marker may only stand on functions whose real body the binary does not contain.
 */
export function isVirtualizedStub(pe, addr, size) {
  const len = Math.min(size || STUB_MAX, STUB_MAX);
  let bytes;
  try {
    bytes = pe.read(addr, len + 4);
  } catch {
    return false;
  }
  for (let i = 0; i < len; i++) {
    if (bytes[i] !== 0xe9) continue;
    const dest = addr + i + 5 + bytes.readInt32LE(i + 1);
    const s = pe.sectionForVa(dest);
    if (!s || s === pe.sectionForVa(addr)) continue;
    if (dest - pe.imageBase - s.rva >= s.rawSize) return true;
  }
  return false;
}

export function clearBuildRetry(store, batchId) {
  store.run(`UPDATE batches SET result_json = json_remove(COALESCE(result_json, '{}'), '$.buildRetry') WHERE id = ?`, batchId);
}

/**
 * Decorated name -> address, from the bindings of every unit a check compiled: a function the
 * submission renamed is found under its new name, before the database learns it on merge.
 */
export function boundAddresses(check, symbols) {
  const byName = new Map();
  for (const u of check.units) {
    for (const [name, id] of Object.entries(u.bindings ?? {})) {
      const addr = symbols.get(id)?.addr;
      if (addr != null && !byName.has(name)) byName.set(name, addr);
    }
    for (const f of u.functions) if (f.symbol && f.addr != null && !byName.has(f.symbol)) byName.set(f.symbol, f.addr);
  }
  return (name) => byName.get(name) ?? null;
}

export function deferBuild(store, batchId, error, { merge = false } = {}) {
  store.tx(() => {
    const from = merge ? 'merging' : 'verifying';
    const to = merge ? 'open' : 'queued';
    if (store.get('SELECT state FROM batches WHERE id = ?', batchId)?.state !== from) return;
    store.run(`UPDATE batches SET state = ?, result_json = json_set(COALESCE(result_json, '{}'), '$.buildRetry', json(?)) WHERE id = ?`, to, JSON.stringify(error.diagnostic), batchId);
    if (merge) {
      store.run(`UPDATE tasks SET state = 'approved', updated_at = ? WHERE state = 'merging' AND id IN (SELECT task_id FROM attempts WHERE batch_id = ? AND state = 'approved')`, now(), batchId);
    } else {
      store.run(`UPDATE attempts SET state = 'queued' WHERE batch_id = ? AND state = 'verifying'`, batchId);
    }
  });
}

export const RANK = { [STATUS.EXACT]: 3, [STATUS.UNRESOLVED]: 2, [STATUS.MISMATCH]: 1, [STATUS.MISSING]: 0, [STATUS.NO_ADDRESS]: 0 };

/**
 * One result per function: templates and inline functions are compiled in every unit that uses
 * them (and folded in the binary), so a function counts with its best compiled copy.
 */
export function bestResults(check) {
  const best = new Map();
  for (const u of check.units) {
    for (const f of u.functions) {
      const b = best.get(f.id);
      if (!b || RANK[f.status] > RANK[b.f.status] || (RANK[f.status] === RANK[b.f.status] && f.score > b.f.score)) best.set(f.id, { f, unit: u.file });
    }
  }
  return best;
}

export class Verifier {
  constructor({ store, config, repo, project, tasks, getPe, peers, trust = null, log = console }) {
    this.trust = trust;
    this.store = store;
    this.config = config;
    this.repo = repo;
    this.project = project;
    this.tasks = tasks;
    this.getPe = getPe;
    this.peers = peers;
    this.log = log;
    this.running = 0;
    this.runningMaintenance = 0;
    this.syncedThrough = 0;
    this.needsSync = !!config.pushRemote;
    this.jobsDir = path.join(config.dataDir, 'jobs');
  }

  start() {
    this.stopped = false;
    this.clearStaleJobs();
    this.needsSync = !!this.config.pushRemote;
    this.store.run(`UPDATE batches SET state = 'queued' WHERE state = 'verifying'`);
    this.store.run(`UPDATE attempts SET state = 'queued' WHERE state = 'verifying'`);
    // Queue order needs every batch's size (batches from before sizes were recorded).
    for (const b of this.store.all(`SELECT id, files_json FROM batches WHERE state = 'queued' AND cost IS NULL`)) {
      this.store.run('UPDATE batches SET cost = ? WHERE id = ?', this.tasks.compileCost(Object.keys(JSON.parse(b.files_json))), b.id);
    }
    // Attempts from before batches existed become batches of one.
    for (const a of this.store.all(`SELECT * FROM attempts WHERE state = 'queued' AND batch_id IS NULL`)) {
      const b = this.store.run(
        `INSERT INTO batches (user_id, base_commit, files_json, notes, agent_meta, env_digest, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
        a.user_id, a.base_commit, a.files_json, a.notes, a.agent_meta, a.env_digest, a.created_at,
      );
      this.store.run('UPDATE attempts SET batch_id = ? WHERE id = ?', Number(b.lastInsertRowid), a.id);
    }
    this.timer = setInterval(() => { try { this.pump(); } catch (e) { console.error(`verify pump: ${e.message}`); } }, 2000);
    this.pump();
  }

  stop() {
    clearInterval(this.timer);
    this.stopped = true; // finishing verifications must not start new ones
  }

  /**
   * Build folders left by a worker that stopped mid-check: `check` removes its folder in a
   * `finally`, which a killed process never reaches. Nothing compiles before `start`, so every
   * folder under `jobs/` here is stale. `keepJobDirs` keeps them for debugging, as `check` does.
   */
  clearStaleJobs() {
    if (this.config.keepJobDirs) return;
    let names;
    try {
      names = fs.readdirSync(this.jobsDir);
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const name of names) {
      try {
        fs.rmSync(path.join(this.jobsDir, name), { recursive: true, force: true });
      } catch (e) {
        this.log.error(`could not remove stale job folder ${name}: ${e.message}`);
      }
    }
    if (names.length) this.log.info(`removed ${names.length} stale job folder(s): ${names.join(', ')}`);
  }

  // New submissions drain active lanes once; queued members of the synchronized cohort do not.
  get syncPending() {
    return !!this.config.pushRemote && (this.needsSync || !!this.store.get(`SELECT 1 FROM batches WHERE state = 'queued' AND kind IN ('code', 'maintenance') AND id > ? LIMIT 1`, this.syncedThrough));
  }

  get repositoryBlocked() {
    return this.syncPending || !!this.syncError;
  }

  /** Read one immutable commit, including a newly selected compile-command path. */
  refreshProject(head = this.repo.head(), { invalidateChecks = true } = {}) {
    if (this.projectHead === head) return false;
    const readFile = (file) => this.repo.showMany(head, [file]).get(file);
    const project = loadProject(this.repo.dir, readFile);
    const lock = loadToolchainLock(this.repo.dir, readFile);
    const digest = lock[project.toolchain]?.clSha256 ?? null;
    const changed = JSON.stringify(project) !== JSON.stringify(this.project) || JSON.stringify(lock) !== JSON.stringify(this.config.toolchainLock);
    if (changed) {
      // Every component holds this same object; remove obsolete optional settings as well.
      for (const key of Object.keys(this.project)) delete this.project[key];
      Object.assign(this.project, project);
      this.config.envDigest = digest;
      this.config.toolchainLock = lock;
      this.baselineAt?.clear();
      this.trust?.forget();
      // Compile results from old flags, roots or policy cannot be reused by mergeCheck.
      if (invalidateChecks) this.store.run('DELETE FROM batch_checks');
    }
    this.projectHead = head;
    return changed;
  }

  refreshPublishedProject() {
    if (!this.config.pushRemote) return;
    const head = this.store.getMeta('repository_project_head');
    if (head) this.refreshProject(head, { invalidateChecks: false });
  }

  syncRepository() {
    if (!this.config.pushRemote) {
      this.syncError = null;
      this.needsSync = false;
      return;
    }
    if (this.running || this.merger?.busy || this.checks?.running) throw new Error('repository sync requires idle verification, merge and remote-check lanes');
    // The web process can enqueue work while fetch blocks this process. Only work present
    // before fetch belongs to this synchronization; later submissions may name a newer base.
    const syncedThrough = this.store.get(`SELECT COALESCE(MAX(id), 0) AS id FROM batches WHERE state = 'queued' AND kind IN ('code', 'maintenance')`).id;
    const result = this.repo.sync(this.config.pushRemote);
    if (result.state === 'merged') {
      // Publish the join now so the remote stops diverging from the server's history.
      this.repo.push(this.config.pushRemote);
      this.log.info(`repository diverged from ${result.remote} ${result.branch}; merged disjoint remote ${result.remoteHead} into ${result.before} as ${result.head}`);
      this.store.event('repository_auto_merge', null, { before: result.before, remote: result.remoteHead, head: result.head });
    }
    this.refreshProject();
    this.store.setMeta('repository_project_head', result.head);
    this.syncError = null;
    this.needsSync = false;
    this.syncedThrough = syncedThrough;
    this.store.run(`UPDATE batches SET result_json = json_remove(result_json, '$.repositorySync') WHERE state = 'queued' AND id <= ? AND json_extract(result_json, '$.repositorySync') IS NOT NULL`, syncedThrough);
    if (result.state === 'fast-forward') this.log.info(`repository fast-forwarded from ${result.before} to ${result.head} (${result.remote} ${result.branch})`);
    return result;
  }

  pump() {
    if (this.stopped) return;
    let synchronized = false;
    if (this.repositoryBlocked) {
      if (this.running || this.merger?.busy || this.checks?.running) return;
      try {
        this.syncRepository();
        synchronized = true;
      } catch (e) {
        if (this.syncError !== e.message) this.log.error(e.message);
        this.syncError = e.message;
        // Infrastructure failures leave submissions queued for a clean retry, with the actual
        // diagnostic visible in the batch result instead of a misleading bad-base rejection.
        this.store.run(`UPDATE batches SET result_json = json_set(COALESCE(result_json, '{}'), '$.repositorySync', json(?)) WHERE state = 'queued' AND kind IN ('code', 'maintenance')`, JSON.stringify({ error: e.message }));
        return;
      }
    }
    // Admit ready commits before filling verification slots, including immediately after sync.
    if (this.merger?.started) this.merger.pump({ synchronized }).catch((e) => this.log.error(`merge pump: ${e.stack}`));
    const max = this.config.verifyConcurrency ?? 3;
    while (this.running < max) {
      // Verification compiles only the submitted units, so every batch is small here; the units
      // that include a changed header are compiled in the merge's big lane.
      const b = this.store.tx(() => {
        // Fair between accounts: the oldest batch of whoever has the fewest batches verifying, so a
        // fast contributor with several batches waiting does not hold every slot.
        const row = this.store.get(
          `SELECT b.* FROM batches b WHERE b.state = 'queued'
            AND COALESCE(json_extract(b.result_json, '$.buildRetry.retryAt'), 0) <= ?
            AND (b.kind != 'maintenance' OR ?)
            AND (? OR b.kind NOT IN ('code', 'maintenance') OR b.id <= ?)
            ORDER BY (SELECT COUNT(*) FROM batches v WHERE v.user_id = b.user_id AND v.state = 'verifying'), b.id LIMIT 1`,
          now(),
          !this.runningMaintenance && !this.merger?.busy ? 1 : 0,
          this.config.pushRemote ? 0 : 1, this.syncedThrough,
        );
        if (row && row.kind === 'maintenance' && !this.maintenance) return null;
        if (row) {
          clearBuildRetry(this.store, row.id);
          this.store.run(`UPDATE batches SET state = 'verifying' WHERE id = ?`, row.id);
          this.store.run(`UPDATE attempts SET state = 'verifying' WHERE batch_id = ? AND state = 'queued'`, row.id);
        }
        return row;
      });
      if (!b) return;
      this.running++;
      if (b.kind === 'maintenance') this.runningMaintenance++;
      // A maintenance batch verifies and merges in one step (maintenance.js).
      const job = b.kind === 'maintenance' ? this.maintenance.run(b.id) : this.verifyBatch(b);
      job
        .catch((e) => {
          this.log.error(`batch ${b.id}: verifier crashed: ${e.stack}`);
          for (const a of batchAttempts(this.store, b.id)) {
            if (a.state === 'verifying') this.finish(a, 'needs_cleanup', 0, { summary: 'internal verifier error; a maintainer has been notified', internalError: true });
          }
          returnBatch(this.store, b.id, 'internal verifier error');
        })
        .finally(() => {
          this.running--;
          if (b.kind === 'maintenance') this.runningMaintenance--;
          this.pump();
        });
    }
  }

  /**
   * Units that include any of `headers`: what compiles recorded (unit_deps: the compiler's own
   * include list), plus what the sources say (includers.js), which also covers units no merge has
   * compiled yet. As `files` change them; a unit `files` deletes (null) includes nothing any more.
   */
  includersOf(headers, files = {}) {
    const out = new Set(sourceIncluders(this.repo, this.project, headers, files));
    for (const h of headers) for (const r of this.store.all('SELECT unit FROM unit_deps WHERE header = ?', h)) out.add(r.unit);
    for (const [f, text] of Object.entries(files)) if (text === null) out.delete(f);
    return [...out].sort();
  }

  /**
   * Compiles `files` (already merged onto HEAD) plus every unit they can affect
   * and compares against the current target version.
   */
  // dependents: false compiles only the submitted units, not every unit that includes a changed
  // header (remote checks: quick feedback; the submission's verification still checks them all).
  // lint: false skips the preprocessed-output lint (code that already passed it, e.g. on merge).
  // onlyUnits: compile exactly these units (a merge recompiling what changed since verification).
  // targets: the functions being judged; the units that emit them are compiled too (a header's inline
  // function exists only in units that use it; a Win32/ copy is compiled out of the x64 build).
  async check(files, jobName, { allUnits = false, timeoutMs = null, dependents = true, lint = true, onlyUnits = null, targets = null, cachedUnits = [], unitOrder = null } = {}) {
    const changedHeaders = Object.keys(files).filter((f) => !isUnit(f));
    const submittedUnits = Object.keys(files).filter((f) => isUnit(f) && files[f] !== null);
    const units = new Set(onlyUnits ?? submittedUnits);
    if (onlyUnits) dependents = false;
    const lintUnits = new Set(lint ? submittedUnits : []);
    const allProjectUnits = () => listSources(this.repo.dir, this.project, { unitsOnly: true });
    if (allUnits) for (const u of allProjectUnits()) units.add(u);
    else if (changedHeaders.length && !onlyUnits) {
      // Units that include a changed header, read from the sources (unit_deps only knows units a
      // merge compiled). Without dependents, a header-only change compiles one includer per header.
      const headerOnly = !units.size;
      for (const h of changedHeaders) {
        const deps = this.includersOf([h], files);
        if (dependents) for (const u of deps) units.add(u);
        else if (headerOnly && deps.length) units.add(deps[0]);
        // A header expands the same way in every unit that includes it: one of them shows what its
        // macros and inline code turn into, so the macro-proof lint needs only that one.
        if (lint && deps.length && !deps.some((u) => lintUnits.has(u))) {
          lintUnits.add(deps[0]);
          units.add(deps[0]);
        }
      }
    }

    if (targets?.length && !onlyUnits && !allUnits) {
      let unknown = 0;
      for (const id of targets) {
        const at = this.store.get('SELECT file FROM func_status WHERE symbol_id = ?', id)?.file;
        if (at && isUnit(at)) units.add(at);
        else unknown++;
      }
      // Never compiled before and defined in a changed header: the includers that mention its template
      // arguments or class are the ones that can instantiate it (every includer took up to an hour).
      if (unknown && !dependents && changedHeaders.length) {
        // The template arguments of the annotation (<CMapObj, HASHKEY_NONE>) are the sharp test: the
        // class (TSHashTable) is mentioned by many more units. The class only when there are none.
        const args = new Set();
        const classes = new Set();
        for (const id of targets) {
          for (const h of changedHeaders) {
            const m = new RegExp(`FUNCTION:\\s*${id}\\s*<([^>\\n]*)>`).exec(String(files[h] ?? ''));
            for (const n of m?.[1].match(/[A-Za-z_]\w{2,}/g) ?? []) args.add(n);
          }
          const cls = className(this.store.get('SELECT name FROM symbols WHERE id = ?', id)?.name);
          if (cls) classes.add(cls.replace(/<.*$/, '').split('::').pop());
        }
        const names = [...(args.size ? args : classes)];
        for (const h of changedHeaders) {
          const deps = this.includersOf([h], files);
          const hits = names.length ? unitsMentioning(this.repo, deps, names, files) ?? [] : [];
          for (const u of (hits.length ? hits : deps).slice(0, 16)) units.add(u);
        }
      }
    }

    const v = this.store.currentVersion();
    const symbols = this.store.symbolMap(v.id);
    const nameIndex = this.store.nameIndex();
    const scan = scanAnnotations(this.repo.dir, this.project, files);
    const cacheSnapshot = this.checkSnapshot(files, { version: v, symbols, nameIndex, scan });
    const jobDir = path.join(this.jobsDir, jobName);
    try {
      const check = await checkUnits({
        scan,
        repoDir: this.repo.dir,
        jobDir,
        project: this.project,
        units: [...units],
        overrides: files,
        symbols,
        nameIndex,
        pe: this.getPe(),
        runners: this.config.runners,
        timeoutMs: timeoutMs ?? this.config.buildTimeoutMs ?? 300_000,
        scaleTimeout: timeoutMs === null,
        // The macro-proof lint needs the /P pass: for submitted units; for every unit when a header
        // changed (a macro there expands everywhere); never for a rebuild of trusted main.
        lintUnits,
        cachedUnits, unitOrder: unitOrder ?? [...units],
        analyze: (args) => analyzeInWorkers({ symbols, nameIndex, ...args, peFile: v.file }),
      });
      // Reconciliation mutates statuses; retries must start with compiler analysis, not a prior
      // batch-wide upgrade whose supporting unit may have changed.
      for (const u of check.units) for (const f of u.functions) f.comparisonStatus = f.status;
      const rec = reconcile(check, symbols);
      return { check, rec, symbols, changedHeaders, units: [...units], cacheSnapshot };
    } finally {
      if (!this.config.keepJobDirs) fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }

  /**
   * Comments and strings a submission adds that could carry instructions to other agents: only
   * annotations and markers, and strings of the original executable, are allowed (freetext.js).
   * What the submitted files held on the base may move between them (a definition moving to its
   * owner keeps its provenance), but every such line counts once. A moved file (lint.js movedFrom)
   * is compared with the file it replaces.
   * With `offsetAnnotations`, the OFFSET lines of the annotation blocks it adds or changes must
   * match their IDs too (offsets.js), and every function definition it adds or changes must carry
   * FUNCTION/STUB or INLINED (unannotated.js).
   */
  freeTextGate(files, baseCommit) {
    const exe = this.getPe().buf;
    const inOriginal = (bytes) => exe.indexOf(bytes) !== -1;
    const baseFiles = Object.fromEntries(this.repo.showMany(baseCommit, Object.keys(files)));
    const charsetForFile = (file) => executionCharset(unitSettings(this.project, file).cflags);
    const errors = freeTextErrorsAcross(files, '', inOriginal, { baseFiles, charsetForFile, encoded: encodedLiteralRules(this.project.encodedLiterals) });
    for (const [to, from] of movedFrom(files, (f) => baseFiles[f] == null)) baseFiles[to] = baseFiles[from];
    if (this.project.offsetAnnotations !== true) return errors;
    const v = this.store.currentVersion();
    const addressOf = (id) => this.store.get('SELECT addr FROM symbol_addresses WHERE symbol_id = ? AND version_id = ?', id, v.id)?.addr ?? null;
    for (const [file, text] of Object.entries(files)) {
      if (typeof text !== 'string') continue;
      for (const e of offsetErrors(text, baseFiles[file] ?? null, addressOf)) errors.push({ file, ...e });
      for (const e of unannotatedErrors(text, baseFiles[file] ?? null)) errors.push({ file, ...e });
    }
    return errors;
  }

  /**
   * Annotations of functions of the current version that the submission removes although it does
   * not hold them (not in the batch, not leased, not in a claimed region). Removing a duplicate is
   * fine: the function stays annotated elsewhere on main, and so is removing a function accepted as
   * needing no decompilation (skip_reason set: dead code, compiler generated, ...).
   */
  droppedAnnotations(files, baseCommit, attempts, userId) {
    const ANN = /\/\/\s*(?:FUNCTION|STUB)\s*:\s*(fn_\d+)/g;
    const ids = (t) => new Set([...String(t ?? '').matchAll(ANN)].map((m) => m[1]));
    const before = new Set();
    const after = new Set();
    for (const [f, text] of Object.entries(files)) {
      for (const id of ids(this.repo.show(baseCommit, f))) before.add(id);
      for (const id of ids(text)) after.add(id);
    }
    const held = new Set(attempts.map((a) => a.symbol_id));
    const v = this.store.currentVersion();
    const out = [];
    for (const id of before) {
      if (after.has(id) || held.has(id)) continue;
      if (!this.store.get('SELECT 1 FROM symbol_addresses WHERE symbol_id = ? AND version_id = ?', id, v.id)) continue; // not in this build
      if (this.store.get('SELECT 1 FROM symbols WHERE id = ? AND skip_reason IS NOT NULL', id)) continue; // accepted as needing no source
      const t = this.store.get('SELECT * FROM tasks WHERE symbol_id = ?', id);
      if (t && ((t.state === 'leased' && t.lease_user === userId) || this.regions?.covers({ id: userId }, t))) continue;
      try {
        if (this.repo.git(['grep', '-l', '-w', '-e', `FUNCTION: ${id}`, 'HEAD', '--', '.', ...Object.keys(files).map((f) => `:(exclude)${f}`)]).trim()) continue;
      } catch {
        // not annotated anywhere else
      }
      out.push(id);
    }
    return out;
  }

  /** Functions the submission declares that nothing defines (undefined.js). */
  undefinedGate(files, baseCommit) {
    const submitted = Object.keys(files);
    // A function of the original: by name, or by its stable ID (agents name unnamed ones fn_01234).
    const known = (name) => !!this.store.get('SELECT 1 FROM symbols WHERE id = ? OR name = ? OR name LIKE ? LIMIT 1', name, name, `%::${name}`);
    const existsElsewhere = (name) => {
      try {
        return this.repo.git(['grep', '-l', '-w', '-F', '-e', name, 'HEAD', '--', '.', ...submitted.map((f) => `:(exclude)${f}`)]).trim().length > 0;
      } catch {
        return false; // git grep exits 1 when nothing matches
      }
    };
    const moved = movedFrom(files, (f) => this.repo.show(baseCommit, f) === null);
    return undefinedDeclarations(files, { before: (f) => this.repo.show(baseCommit, moved.get(f) ?? f), existsElsewhere, known });
  }

  /** Definitions come from the effective source tree, never from symbol metadata or pending work. */
  globalsGate(files, baseCommit) {
    if (this.project.globalRules !== true) return [];
    const head = this.repo.head();
    if (this.globalSourceHead !== head) {
      const paths = this.repo.git(['ls-tree', '-r', '--name-only', head]).trim().split('\n');
      const roots = [...this.project.sourceDirs, ...this.project.includeDirs];
      this.globalSources = Object.fromEntries(paths
        .filter((f) => /\.(c|cc|cpp|cxx|h|hpp|inl|inc)$/i.test(f) && roots.some((r) => f.startsWith(`${r.replace(/\/$/, '')}/`)))
        .map((f) => [f, fs.readFileSync(path.join(this.repo.dir, f), 'utf8')]));
      this.globalSourceHead = head;
    }
    const moved = movedFrom(files, (f) => this.repo.show(baseCommit, f) === null);
    return globalViolations(files, { before: (f) => this.repo.show(baseCommit, moved.get(f) ?? f), repository: this.globalSources });
  }

  /** Capture before compilation: comparison inputs are as important as source dependencies. */
  checkSnapshot(files, { version = this.store.currentVersion(), symbols = this.store.symbolMap(version.id), nameIndex = this.store.nameIndex(), scan = scanAnnotations(this.repo.dir, this.project, files) } = {}) {
    const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const paths = new Set(this.repo.git(['ls-tree', '-r', '--name-only', 'HEAD']).trim().split('\n').filter(Boolean));
    for (const [file, text] of Object.entries(files)) {
      if (text === null) paths.delete(file);
      else paths.add(file);
    }
    // Comparison resolves annotated IDs and decorated names only. Newly registered unnamed
    // symbols affect reconciliation (rerun against current metadata), not compiler analysis.
    const referenced = new Set(scan.annotations.map((a) => a.id).filter(Boolean));
    for (const id of nameIndex.values()) referenced.add(id);
    return {
      format: 2, head: this.repo.head(), overrides: { ...files },
      context: hash({ project: this.project, toolchain: this.config.toolchainLock,
        env: this.config.envDigest, runners: this.config.runners, version,
        symbols: [...symbols].filter(([id]) => referenced.has(id)), names: [...nameIndex],
        globals: scan.annotations.filter((a) => a.kind === 'GLOBAL'), paths: [...paths].sort() }),
      // Partial analysis cannot rediscover GLOBAL bindings emitted by a reused unit.
      globalBindings: scan.annotations.some((a) => a.kind === 'GLOBAL'),
      annotationErrors: [...scan.errors, ...lintAnnotations(scan.annotations, symbols)],
    };
  }

  // Store evidence only, never evaluation, ownership, regression or review approvals.
  rememberCheck(batchId, { check, rec, changedHeaders, cacheSnapshot }) {
    if (!cacheSnapshot || cacheSnapshot.format !== 2) return;
    const compact = {
      annotationErrors: check.annotationErrors,
      analysisNames: check.analysisNames,
      units: check.units.map((u) => ({ ...u, functions: u.functions.map(({ asm, diffRegions, ...f }) => f) })),
    };
    this.store.run('INSERT OR REPLACE INTO batch_checks (batch_id, head, check_json) VALUES (?, ?, ?)', batchId, cacheSnapshot.head,
      encodeCheck({ check: compact, rec, changedHeaders, cacheSnapshot }));
  }

  /** Prefer a child's expanded retry evidence; a parent's verification is only a fallback. */
  async mergeCheck(batch, files, fromBatch = batch) {
    const snapshot = this.checkSnapshot(files);
    let saved = null;
    for (const id of new Set([batch.id, fromBatch.id])) {
      const row = this.store.get('SELECT head, check_json FROM batch_checks WHERE batch_id = ?', id);
      if (!row) continue;
      try {
        const candidate = decodeCheck(row.check_json);
        const s = candidate.cacheSnapshot;
        if (s?.format === 2 && s.head === row.head && s.context === snapshot.context && s.overrides && candidate.check?.units) {
          saved = candidate;
          break;
        }
      } catch { /* Unknown/legacy provenance is a cache miss. */ }
    }
    const required = new Set((saved?.check.units ?? []).map((u) => u.file));
    for (const file of Object.keys(files).filter(isUnit)) required.add(file);
    // Verification may have compiled a template/inline emitter outside the submitted units.
    // Its old results are not reusable without provenance, but its coverage is still required.
    const verifiedUnits = JSON.parse(fromBatch.result_json ?? '{}').check;
    for (const u of Array.isArray(verifiedUnits) ? verifiedUnits : []) if (isUnit(u.file)) required.add(u.file);
    // Keep the existing coverage policy: narrow known header edits, never unknown headers.
    const virtuals = Object.keys(files).some((f) => !isUnit(f)) ? virtualNames(this.repo, files) : null;
    for (const h of Object.keys(files).filter((f) => !isUnit(f))) {
      const before = this.repo.show(snapshot.head, h);
      if (before === files[h]) continue;
      const deps = this.includersOf([h], files);
      const names = changedNames(before, files[h], { isVirtual: (n) => !virtuals || virtuals.has(n) });
      const narrowed = before === null || files[h] === null ? null : unitsMentioning(this.repo, deps, names, files);
      for (const u of narrowed && narrowed.length <= 300 ? narrowed : deps) required.add(u);
    }
    const changed = new Set();
    if (saved) {
      const old = saved.cacheSnapshot;
      try {
        if (old.head !== snapshot.head) {
          for (const f of this.repo.git(['diff', '--name-only', old.head, snapshot.head]).split('\n').filter(Boolean)) changed.add(f);
        }
        for (const f of new Set([...Object.keys(old.overrides), ...Object.keys(files)])) {
          if (old.overrides[f] !== files[f]) changed.add(f);
        }
      } catch { saved = null; }
    }
    const known = new Map((saved?.check.units ?? []).map((u) => [u.file, u]));
    let stale = [...required].filter((file) => {
      const u = known.get(file);
      return !u?.compiled || u.errors?.length || !Array.isArray(u.includes) || changed.has(file) || u.includes.some((h) => changed.has(h));
    });
    let result;
    if (!saved || stale.length) {
      let part = await this.check(files, `merge-${batch.id}`, { lint: false, onlyUnits: stale,
        cachedUnits: saved?.check.units ?? [], unitOrder: [...required] });
      let compiled = part.check.units.length;
      // New global bindings can change comparison of otherwise unchanged objects. Recheck the
      // whole required set rather than combining results analyzed against different name maps.
      if (saved && snapshot.globalBindings && part.check.units.every((u) => u.compiled && !u.timedOut) && JSON.stringify(part.check.analysisNames) !== JSON.stringify(saved.check.analysisNames)) {
        // Coverage was selected before the first await. A second build on newer main would
        // falsely certify that snapshot without discovering its newly added includers.
        if (this.repo.head() !== snapshot.head) return { ...part, retryRequired: true, reused: 0, compiled };
        stale = [...required];
        part = await this.check(files, `merge-${batch.id}`, { lint: false, onlyUnits: stale });
        compiled += part.check.units.length;
      }
      const replaced = new Set(stale);
      const reused = saved ? saved.check.units.filter((u) => !replaced.has(u.file)) : [];
      const byFile = new Map([...reused, ...part.check.units].map((u) => [u.file, u]));
      const order = part.check.analysisOrder ?? [...required];
      const check = { annotationErrors: part.check.annotationErrors, analysisNames: part.check.analysisNames, units: order.filter((file) => byFile.has(file)).map((file) => byFile.get(file)) };
      for (const u of check.units) for (const f of u.functions) if (f.comparisonStatus) { f.status = f.comparisonStatus; delete f.conflictedReferences; }
      result = { ...part, check, rec: reconcile(check, this.store.symbolMap(this.store.currentVersion().id)), reused: reused.length, compiled };
    } else {
      const check = { ...saved.check, annotationErrors: snapshot.annotationErrors };
      for (const u of check.units) for (const f of u.functions) if (f.comparisonStatus) { f.status = f.comparisonStatus; delete f.conflictedReferences; }
      result = { check, rec: reconcile(check, this.store.symbolMap(this.store.currentVersion().id)),
        changedHeaders: Object.keys(files).filter((f) => !isUnit(f)), cacheSnapshot: snapshot, reused: saved.check.units.length, compiled: 0 };
    }
    this.rememberCheck(batch.id, result);
    return result;
  }

  /**
   * A recorded status can be older than main: a header change merged later recompiles a unit only
   * where it mentions what changed (affected.js), so a unit's functions can build differently on
   * main than recorded. Before a check counts regressions, the units it would blame are compiled
   * as main has them (once per main commit) and their recorded status is brought up to date, so a
   * submission is compared with what main actually builds.
   */
  async refreshBaselines(check, files, jobName) {
    if (check.units.some((u) => !u.compiled || u.timedOut)) return 0;
    const found = this.regressions(check, files);
    if (!found.length) return 0;
    const head = this.repo.head();
    this.baselineAt ??= new Map();
    const units = [...new Set(found.map((r) => r.file))].filter((u) => isUnit(u) && this.baselineAt.get(u) !== head);
    if (!units.length) return 0;
    const { check: main } = await this.check({}, `baseline-${jobName}`, { onlyUnits: units, lint: false });
    if (main.units.some((u) => !u.compiled || u.timedOut)) throw new BuildRetryError(main, 'baseline');
    if (this.repo.head() !== head) return 0; // main moved meanwhile: the next check measures again
    const compiled = new Set(main.units.filter((u) => u.compiled).map((u) => u.file));
    const ids = new Set(found.map((r) => r.id));
    let changed = 0;
    for (const [id, { f, unit }] of bestResults(main)) {
      if (!ids.has(id) || !compiled.has(unit)) continue;
      const old = this.store.get('SELECT status, score, code_hash FROM func_status WHERE symbol_id = ?', id);
      if (!old || (old.status === f.status && Math.abs(old.score - f.score) <= 1e-4 && old.code_hash === (f.codeHash ?? old.code_hash))) continue;
      this.store.run(
        `UPDATE func_status SET file = ?, status = ?, score = ?, code_hash = COALESCE(?, code_hash), commit_hash = ?, updated_at = ?,
           confirmed = CASE WHEN ? IN ('exact', 'match_unresolved') THEN 0 WHEN status IN ('exact', 'match_unresolved') THEN 1 ELSE confirmed END WHERE symbol_id = ?`,
        unit, f.status, f.score, f.codeHash ?? null, head, now(), f.status, id,
      );
      this.store.event('baseline_refreshed', null, { id, was: old.status, wasScore: old.score, now: f.status, score: f.score, commit: head });
      this.log.info(`baseline of ${id} was stale (${old.status} ${(old.score * 100).toFixed(1)}%); main builds it as ${f.status} ${(f.score * 100).toFixed(1)}%`);
      changed++;
    }
    for (const u of compiled) this.baselineAt.set(u, head);
    return changed;
  }

  /** Functions that match on main but would no longer match with this change. `moves` (new path ->
   * old path) counts a moved unit's functions, still recorded under the old path, as compiled. */
  regressions(check, files = {}, moves = new Map()) {
    const results = new Map([...bestResults(check)].map(([id, b]) => [id, b.f]));
    const compiledFiles = new Set(check.units.flatMap((u) => (moves.has(u.file) ? [u.file, moves.get(u.file)] : [u.file])));
    const out = [];
    // An accepted "no decompile" claim retires the function: removing its old annotation is the fix.
    for (const row of this.store.all(`SELECT * FROM func_status WHERE (status IN ('exact', 'match_unresolved') OR confirmed = 1) AND symbol_id NOT IN (SELECT symbol_id FROM tasks WHERE state = 'skipped')`)) {
      if (!compiledFiles.has(row.file)) continue;
      const now_ = results.get(row.symbol_id);
      // Exact and match_unresolved are the same bytes: whether a referenced label resolves depends
      // on which other units this check compiled, not on the change.
      const rank = (s) => (s === STATUS.UNRESOLVED ? RANK[STATUS.EXACT] : RANK[s]);
      if (!now_ || rank(now_.status) < rank(row.status)) out.push({ id: row.symbol_id, file: row.file, was: row.status, now: now_?.status ?? 'removed' });
      // A peer-confirmed function whose compiled code moves away from the original was not seen by
      // its reviewers. Closer to it is fine (a header layout fix in another unit): it keeps its
      // confirmation, and the merge records the better score.
      else if (row.confirmed && now_.status === STATUS.MISMATCH && now_.score < row.score - 1e-4) {
        out.push({ id: row.symbol_id, file: row.file, was: 'peer-confirmed', now: `changed (score ${(row.score * 100).toFixed(1)}% -> ${(now_.score * 100).toFixed(1)}%)` });
      }
    }
    return this.withoutHeaderCopies(out, results, files);
  }

  // A template or inline function defined in a header is emitted by every unit that uses it, and
  // main keeps its best copy, recorded at one of those units. Editing that unit can drop or vary its
  // copy while the others stay as they were: no regression unless the header itself changed (and
  // then "removed" only when its annotation is gone from the header).
  withoutHeaderCopies(found, results, files) {
    if (!found.length) return found;
    const defined = new Map();
    for (const r of found) if (results.get(r.id)?.file) defined.set(r.id, results.get(r.id).file);
    const unknown = found.filter((r) => !defined.has(r.id)).map((r) => r.id);
    if (unknown.length) {
      try {
        const out = this.repo.git(['grep', '-o', '-w', '-F', ...unknown.flatMap((id) => ['-e', `FUNCTION: ${id}`]), 'HEAD', '--']);
        for (const line of out.split('\n')) {
          const m = /^HEAD:(.+?):FUNCTION: (\S+)$/.exec(line.trim());
          if (m && !defined.has(m[2])) defined.set(m[2], m[1]);
        }
      } catch (e) {
        // Exit 1: no annotation on main for any of them. Anything else: main unknown, judged strictly.
        if (e.status !== 1) return found;
      }
    }
    return found.filter((r) => {
      const file = defined.get(r.id);
      // Not annotated anywhere on main (an older merge removed it; its record is stale): the
      // submission cannot be what removes it.
      if (!file) return r.now !== 'removed';
      if (isUnit(file)) return true;
      if (typeof files[file] !== 'string') return false;
      return r.now !== 'removed' || !new RegExp(`FUNCTION: ${r.id}\\b`).test(files[file]);
    });
  }

  /**
   * Functions of the submitted files whose compiled code differs from main although they are not
   * part of the submission: a submission may only change the functions it holds the lease for.
   * Unknown on main (no fingerprint yet, e.g. before the first rebuild) is not counted.
   * Main's code is compared on where its references land (effectiveHash, resolved through the
   * names this check bound), so renaming a callee does not change its callers.
   */
  // With `userId`, in the tasks' own units (`ownUnits`), only functions someone else is working on
  // count (held by another account, or in another account's submission on its way to main), and
  // functions on main whose source the submission rewrote without listing them: those are
  // revisions and need their own review. Other neighbours there may change: their status is
  // measured again, and the regression check still protects whatever already matches.
  // In every other unit a refactor may only rename and move: any code change counts, unless the
  // function becomes byte-identical to the original (that proves it as merging it would).
  // With a changed header, units that only include it count too (a merge compiles them): a function
  // there whose code the header changed was never shown to a reviewer.
  changedOutside(check, files, targets, userId = null, ownUnits = null) {
    const fileSet = new Set(Object.keys(files));
    const headerChanged = Object.keys(files).some((f) => !isUnit(f));
    const addressOf = boundAddresses(check, this.store.symbolMap(this.store.currentVersion().id));
    const seen = new Map();
    for (const u of check.units) for (const f of u.functions) if ((fileSet.has(f.file) || headerChanged) && !targets.has(f.id) && f.codeHash) seen.set(f.id, f);
    const out = [];
    for (const [id, f] of seen) {
      const main = this.store.get('SELECT code_hash, effective_hash FROM func_status WHERE symbol_id = ?', id);
      if (!main) out.push({ id, file: f.file, why: 'new or newly annotated' });
      else if (main.effective_hash ? main.effective_hash !== resolvedEffectiveHash(f, addressOf) : main.code_hash && main.code_hash !== f.codeHash) out.push({ id, file: f.file, why: 'compiled code changed' });
    }
    if (userId == null) return out;
    const foreign = (o) => !fileSet.has(o.file) || (ownUnits && !ownUnits.has(o.file));
    return out.filter((o) => {
      if (foreign(o)) {
        if (this.workedOnByOthers(o.id, userId)) return true;
        const f = seen.get(o.id);
        if (f.status === STATUS.EXACT || f.status === STATUS.UNRESOLVED) return false;
        o.why = fileSet.has(o.file)
          ? 'in a unit outside this submission\'s tasks: a refactor there may rename and move, not change code; list it in taskIds to submit it as a revision'
          : 'a changed header changes its code, but its file is not in the submission: include the file and list it in taskIds so reviewers see it';
        return true;
      }
      return this.workedOnByOthers(o.id, userId) || this.unlistedRevision(o, files);
    });
  }

  /** The units of the batch's tasks (Tasks.ownUnitsForTasks), or null when unknown. */
  ownUnitsOf(attempts) {
    return this.tasks.ownUnitsForTasks ? this.tasks.ownUnitsForTasks(attempts.map((a) => a.task_id)) : null;
  }

  /** Whether a batch edits a unit none of its tasks belong to (a cross-unit refactor). */
  crossUnit(files, ownUnits) {
    return !!ownUnits && Object.keys(files).some((f) => isUnit(f) && !ownUnits.has(f));
  }

  /** A function on main whose source this submission rewrote, though it is not one of its tasks. */
  unlistedRevision(o, files) {
    const t = this.store.get('SELECT state FROM tasks WHERE symbol_id = ?', o.id);
    if (!t || !['done', 'skipped'].includes(t.state)) return false;
    if (this.unchangedFromBase(o.id, files, 'HEAD')) return false;
    o.why = 'already on main and rewritten: list it in taskIds to submit it as a revision';
    return true;
  }

  workedOnByOthers(symbolId, userId) {
    // A region this user claimed is shared work: changes to its functions are theirs to make too.
    if (this.regions) {
      const t = this.store.get('SELECT * FROM tasks WHERE symbol_id = ?', symbolId);
      if (t && this.regions.covers({ id: userId }, t)) return false;
    }
    return !!this.store.get(
      `SELECT 1 FROM tasks t WHERE t.symbol_id = ? AND (
         (t.state = 'leased' AND t.lease_user != ?)
         OR EXISTS (SELECT 1 FROM attempts a WHERE a.task_id = t.id AND a.user_id != ? AND a.state IN ('queued', 'verifying', 'peer_review', 'in_review', 'approved', 'merging')))`,
      symbolId, userId, userId,
    );
  }

  /**
   * Another function annotated on the same compiled body as `target`, accepted on main (byte-
   * identical or confirmed by peers) with this very compiled code, whose original is the same code
   * as the target's (sameOriginal). Its ID, or null.
   */
  acceptedTwin(check, target) {
    if (!target?.symbol || !target.addr || !target.codeHash) return null;
    const size = target.size?.original;
    const pe = this.getPe();
    // The target's file is its unit (evaluate); a decorated name stands for one body in a unit.
    for (const u of check.units.filter((x) => x.file === target.file)) {
      for (const f of u.functions) {
        if (f.id === target.id || f.symbol !== target.symbol || !f.addr || f.codeHash !== target.codeHash) continue;
        if (f.size?.original !== size) continue;
        const main = this.store.get('SELECT status, confirmed, code_hash FROM func_status WHERE symbol_id = ?', f.id);
        if (!main || main.code_hash !== f.codeHash) continue;
        if (!(main.status === STATUS.EXACT || main.status === STATUS.UNRESOLVED || main.confirmed)) continue;
        if (sameOriginal(pe, target.addr, f.addr, size)) return f.id;
      }
    }
    return null;
  }

  /**
   * Confirmed code keeps its peer verdicts or explicit review waiver when unchanged in a
   * resubmission (the batch came back because of another function).
   */
  carryOver(attempt, target) {
    if (!target?.codeHash) return false;
    const prev = this.store.all(`SELECT id, result_json, peer_skipped FROM attempts WHERE task_id = ? AND id != ? ORDER BY id DESC LIMIT 5`, attempt.task_id, attempt.id);
    for (const p of prev) {
      const hash = p.result_json ? JSON.parse(p.result_json).feedback?.target?.codeHash : null;
      if (hash !== target.codeHash || !this.peers?.confirmed(p.id)) continue;
      this.store.run(
        `INSERT OR IGNORE INTO peer_reviews (attempt_id, reviewer_id, token_id, verdict, weight, reason, agent_meta, created_at)
         SELECT ?, reviewer_id, token_id, verdict, weight, reason, agent_meta, created_at FROM peer_reviews WHERE attempt_id = ?`,
        attempt.id, p.id,
      );
      if (p.peer_skipped) {
        this.store.run('UPDATE attempts SET peer_skipped = 1 WHERE id = ?', attempt.id);
        this.store.event('review_waiver_carried', attempt.user_id, { attempt: attempt.id, from: p.id, codeHash: target.codeHash });
      }
      return true;
    }
    return false;
  }

  async verifyBatch(batch) {
    // Superseded while it waited (a competing candidate merged first): nothing to judge.
    const attempts = batchAttempts(this.store, batch.id).filter((a) => a.state === 'verifying' || a.state === 'queued');
    if (!attempts.length) {
      this.store.run(`UPDATE batches SET state = 'superseded', finished_at = ? WHERE id = ?`, now(), batch.id);
      return;
    }
    const submitted = JSON.parse(batch.files_json);
    const finishAll = (state, feedback) => {
      for (const a of attempts) this.finish(a, state, 0, feedback);
      this.store.run(`UPDATE batches SET state = 'returned', finished_at = ?, result_json = ? WHERE id = ?`, now(), JSON.stringify({ feedback }), batch.id);
    };

    // Stage 0: static gate.
    const lintErrors = lintSubmission(submitted, {
      allowedPaths: this.tasks.allowedPathsForTasks(attempts.map((a) => a.task_id)),
      limits: this.project.lintLimits,
      allowedPragmas: this.project.allowedPragmas,
      baseSize: (f) => this.repo.size('HEAD', f),
      trackedPaths: this.repo.trackedPaths('HEAD'),
      unitPrelude: this.project.unitPrelude,
      baseText: (f) => this.repo.show('HEAD', f),
    });
    if (lintErrors.length) return finishAll('rejected', { summary: 'rejected by the static gate', lintErrors });
    if (!this.repo.isAncestor(batch.base_commit)) return finishAll('rejected', { summary: `base commit ${batch.base_commit} is not part of main; sync and resubmit` });
    const textErrors = this.freeTextGate(submitted, batch.base_commit);
    if (textErrors.length) return finishAll('rejected', { summary: 'rejected: the submission adds comments or strings that are not allowed (see lintErrors)', lintErrors: textErrors });
    const dropped = this.droppedAnnotations(submitted, batch.base_commit, attempts, batch.user_id);
    if (dropped.length) {
      return finishAll('needs_cleanup', {
        summary: `removes the annotation of ${dropped.join(', ')}, which this submission does not hold: functions of the original lose their match that way. Keep the annotation (and the code), or claim the function too`,
        droppedAnnotations: dropped,
      });
    }
    const undefinedNames = this.undefinedGate(submitted, batch.base_commit);
    if (undefinedNames.length) {
      return finishAll('needs_cleanup', {
        summary: `declares functions that are defined nowhere: ${undefinedNames.join(', ')}. Main is linked as a whole: call the real function of the original (td_lookup_symbol; td_new_symbol for one not in the database yet) and port it too if it has no code yet, or write the logic inline`,
        undefinedFunctions: undefinedNames,
      });
    }
    const merged = this.repo.mergeOntoHead(batch.base_commit, submitted);
    if (merged.conflicts.length) return finishAll('needs_cleanup', { summary: 'your change conflicts with newer work on main; sync, merge and resubmit', conflicts: merged.conflicts });
    const globalErrors = this.globalsGate(merged.files, this.repo.head());
    if (globalErrors.length) return finishAll('needs_cleanup', { summary: 'global variable rules (see globalErrors)', globalErrors });

    // Stages 1-3: one compile for the whole batch, then every function on its own.
    // Verify fast: the submitted units (enough to judge and route every submitted function). The
    // units that only include a changed header are compiled when the batch merges.
    const { check, rec, changedHeaders, cacheSnapshot } = await this.check(merged.files, `batch-${batch.id}`, { dependents: false, targets: attempts.map((a) => a.symbol_id) });
    try {
      if (check.units.some((u) => u.timedOut)) throw new BuildRetryError(check, 'verification');
      if (check.units.every((u) => u.compiled)) await this.refreshBaselines(check, merged.files, `batch-${batch.id}`);
    } catch (e) {
      if (!(e instanceof BuildRetryError)) throw e;
      deferBuild(this.store, batch.id, e);
      return;
    }
    // Cancelled by its author while it compiled (td cancel): nothing to record.
    if (this.store.get('SELECT state FROM batches WHERE id = ?', batch.id)?.state !== 'verifying') return;
    clearBuildRetry(this.store, batch.id);
    const targets = new Set(attempts.map((a) => a.symbol_id));
    const ownUnits = this.ownUnitsOf(attempts);
    const outside = this.changedOutside(check, merged.files, targets, batch.user_id, ownUnits);
    // A refactor that edits other units merges whole: a renamed function without its callers
    // (or the reverse) would not link.
    if (this.crossUnit(submitted, ownUnits)) {
      this.store.run(`UPDATE batches SET result_json = json_set(COALESCE(result_json, '{}'), '$.noSplit', ?) WHERE id = ?`, 'cross-unit refactor: it merges as a whole', batch.id);
    }
    let failed = 0;
    let withdrawn = 0;
    for (const a of attempts) {
      const ev = this.evaluate({ check, rec, targetId: a.symbol_id, files: merged.files, changedHeaders, outside });
      // Held but not written: no annotation for it anywhere in the submission. Not a failure; it
      // goes back to the author's claim. Also when main has code for it (verification compiles the
      // unit a function lives in): that code is not this submission's, and reviewers shown the
      // submitted files would not find it.
      if (!Object.values(submitted).some((text) => new RegExp(`//\\s*(FUNCTION|STUB)\\s*:\\s*${a.symbol_id}\\b`).test(String(text)))) {
        this.withdraw(a);
        withdrawn++;
        continue;
      }
      // Code already on main, submitted again unchanged (same source, or the same compiled code as
      // main has) and not byte-identical: it does not move the function closer to the original, so
      // it is not new work and would only fill the peer review.
      if (ev.state === 'peer_review' && this.unchangedOnMain(a.symbol_id, submitted, batch.base_commit, ev.feedback.target)) {
        this.withdraw(a, 'not changed: this code is already on main and compiles to the same code; only submissions that change a function are accepted. Submit the functions you rewrote');
        withdrawn++;
        continue;
      }
      ev.feedback.headCommit = this.repo.head();
      if (attempts.length > 1) ev.feedback.batch = { id: batch.id, functions: attempts.length };
      if (batch.env_digest && this.config.envDigest && batch.env_digest !== this.config.envDigest) {
        ev.feedback.warnings.push('your local toolchain differs from the pinned one; local results may not match the server');
      }
      if (ev.state === 'peer_review' && this.carryOver(a, ev.feedback.target)) {
        // Their verdicts already accept it, so it goes on as approved (in_review would wait for a
        // human review, and the peer queue skips functions its rule has decided).
        ev.state = 'approved';
        ev.feedback.summary += '; the compiled code is unchanged since peers confirmed it, so their verdicts carry over and it is accepted';
      }
      // A trusted author's function that is close to the original: accepted without peer review
      // (but for a random sample that keeps the author's record measured; trust.js).
      if (ev.state === 'peer_review' && a.kind !== 'skip' && this.trust?.skips(a, ev.score)) {
        ev.state = 'approved';
        ev.feedback.summary = `not byte-identical (score ${(ev.score * 100).toFixed(1)}%), accepted without peer review: this agent's functions keep passing peer review (trust)`;
        ev.feedback.trusted = true;
        this.store.run('UPDATE attempts SET peer_skipped = 1 WHERE id = ?', a.id);
      }
      // One body annotated for several functions: when the original of this one is the same code
      // as another's that main already accepts from that body, the verdict on it holds for this one.
      const twin = ev.state === 'peer_review' && a.kind !== 'skip' ? this.acceptedTwin(check, ev.feedback.target) : null;
      if (twin) {
        ev.state = 'approved';
        ev.feedback.summary = `not byte-identical (score ${(ev.score * 100).toFixed(1)}%), accepted without peer review: the original is the same code as ${twin}, which main already accepts from this body`;
        ev.feedback.sameAs = twin;
        this.store.run('UPDATE attempts SET peer_skipped = 1 WHERE id = ?', a.id);
      }
      if (ev.state === 'needs_cleanup' || ev.state === 'rejected') failed++;
      this.finish(a, ev.state, ev.score, ev.feedback);
    }
    // mergedFiles only when the merge onto main changed the submission: otherwise readers fall back
    // to files_json (attemptFiles), and storing the same files twice doubled every large write.
    const mergedFiles = JSON.stringify(merged.files) === batch.files_json ? undefined : merged.files;
    this.store.run(
      `UPDATE batches SET state = 'open', finished_at = ?, result_json = json_patch(COALESCE(result_json, '{}'), ?) WHERE id = ?`,
      now(), JSON.stringify({ ...(mergedFiles && { mergedFiles }), check: summarizeCheck(check), changedHeaders, outside }), batch.id,
    );
    this.rememberCheck(batch.id, { check, rec, changedHeaders, cacheSnapshot });
    // Failing functions went back one by one (finish); the rest of the batch carries on and its
    // approved part merges without them. Only a batch with nothing left on its way is over.
    if (failed || withdrawn) settleBatch(this.store, batch.id, `${failed} of ${attempts.length} functions need work${withdrawn ? `, ${withdrawn} were not written` : ''}; see each function's feedback`);
  }

  /**
   * Whether a submitted function is no change to main: it compiles to the code main already has.
   * The same source text is not enough: a function's code also changes through the helpers it
   * inlines and the types it uses, which live outside its own definition.
   */
  unchangedOnMain(symbolId, files, baseCommit, target) {
    const main = this.store.get('SELECT code_hash FROM func_status WHERE symbol_id = ?', symbolId);
    if (target?.codeHash && main?.code_hash) return main.code_hash === target.codeHash;
    return this.unchangedFromBase(symbolId, files, baseCommit);
  }

  /** Whether the submitted definition of a function is exactly what the batch's base had. */
  unchangedFromBase(symbolId, files, baseCommit) {
    for (const [f, text] of Object.entries(files)) {
      const now = functionRegions(String(text))?.get(symbolId);
      if (!now) continue;
      const base = this.repo.show(baseCommit, f);
      const old = base === null ? null : functionRegions(base)?.get(symbolId);
      if (!old) return false;
      const body = (t, r) => t.split('\n').slice(r.start, r.end).join('\n');
      return body(base, old) === body(String(text), now);
    }
    return false;
  }

  // A function submitted without any code for it: back into its author's claim, as if not submitted.
  withdraw(attempt, summary = 'not written: no annotation for it in the submission; it stays in your claim') {
    const expires = now() + (this.config.leaseMinutes ?? 120) * 60_000;
    this.store.tx(() => {
      this.store.run(`UPDATE attempts SET state = 'withdrawn', finished_at = ?, result_json = ? WHERE id = ?`, now(), JSON.stringify({ feedback: { summary } }), attempt.id);
      if (attempt.competing) return; // the task is its holder's
      this.store.run(`UPDATE tasks SET state = 'leased', lease_user = ?, lease_expires = ?, lease_started = ?, updated_at = ? WHERE id = ?`, attempt.user_id, expires, now(), now(), attempt.task_id);
    });
  }

  /** Routes a check result: rejected, needs_cleanup or in_review. */
  evaluate({ check, rec, targetId, files, changedHeaders, outside = [], allowRegressions = false }) {
    const fileSet = new Set(Object.keys(files));
    const policy = this.project.matchPolicy;
    const feedback = { summary: '', warnings: [] };

    const cheat = check.units.flatMap((u) => u.lintErrors);
    if (cheat.length) {
      feedback.summary = 'rejected: banned constructs found after preprocessing';
      feedback.lintErrors = cheat;
      return { state: 'rejected', score: 0, feedback };
    }

    // A library function main already annotates in that file (folded with project code) is not
    // the submission's doing: only adding such an annotation is refused.
    const onMain = new Map();
    const mainHas = (e) => {
      if (!onMain.has(e.file)) onMain.set(e.file, this.repo.show('HEAD', e.file) ?? '');
      return new RegExp(`:\\s*${e.id}\\b`).test(onMain.get(e.file));
    };
    const annErrors = check.annotationErrors.filter((e) => fileSet.has(e.file) && e.severity !== 'warning' && !(e.rule === 'library' && mainHas(e)));
    const annWarnings = check.annotationErrors.filter((e) => fileSet.has(e.file) && e.severity === 'warning');
    for (const w of annWarnings) feedback.warnings.push(`${w.file}:${w.line} ${w.message}`);
    const failed = check.units.filter((u) => !u.compiled);
    const target = check.units.flatMap((u) => u.functions.map((f) => ({ ...f, file: u.file }))).find((f) => f.id === targetId);
    const regressions = failed.length || allowRegressions ? [] : this.regressions(check, files);

    feedback.target = target ?? null;
    feedback.annotationErrors = annErrors;
    feedback.compileErrors = failed.map((u) => ({ file: u.file, log: u.log, timedOut: !!u.timedOut }));
    feedback.regressions = regressions;
    // Only the submitted function's own references can bounce it; other ambiguities are warnings.
    const targetSyms = new Set((target?.relocations ?? []).map((r) => r.symbol));
    const wrongRefs = rec.conflicts.filter((c) => c.hard && targetSyms.has(c.symbol));
    feedback.referenceConflicts = rec.conflicts.filter((c) => targetSyms.has(c.symbol)).map((c) => c.message);
    if (target?.conflictedReferences?.length) feedback.warnings.push(`ambiguous references (several addresses seen for one name): ${target.conflictedReferences.join(', ')}`);
    feedback.unknownReferences = rec.unknown.map((u) => ({ symbol: u.decorated, addr: '0x' + u.addr.toString(16) }));
    feedback.otherFunctions = check.units
      .filter((u) => fileSet.has(u.file))
      .flatMap((u) => u.functions.filter((f) => f.id !== targetId).map((f) => ({ id: f.id, status: f.status, score: f.score })));
    const unannotated = check.units.filter((u) => fileSet.has(u.file)).flatMap((u) => u.unannotated);
    if (unannotated.length) feedback.warnings.push(`compiled functions without an annotation: ${unannotated.slice(0, 10).join(', ')}`);
    if (changedHeaders.length) feedback.warnings.push(`header changes (${changedHeaders.join(', ')}) need extra review`);

    const score = target?.score ?? 0;
    const virtual = target ? virtualizedMarker(files, targetId) : null;
    const targetAddr = typeof target?.addr === 'string' ? parseInt(target.addr, 16) : target?.addr;
    let state;
    if (failed.length) {
      feedback.summary = 'compilation failed';
      state = 'needs_cleanup';
    } else if (annErrors.length) {
      feedback.summary = 'annotation errors';
      state = 'needs_cleanup';
    } else if (!target) {
      feedback.summary = `no compiled function is annotated with // FUNCTION: ${targetId}`;
      state = 'needs_cleanup';
    } else if (target.deletingDestructor) {
      feedback.summary = `${targetId} is a scalar deleting destructor in the original (it frees the object when flags&1 and returns this, retn 4), compiler generated from the virtual destructor: do not annotate the destructor with it; claim it no-decompile (td_mark_no_decompile, category compiler_generated)`;
      state = 'needs_cleanup';
    } else if (regressions.length) {
      feedback.summary = `your change breaks ${regressions.length} function(s) that matched before`;
      state = 'needs_cleanup';
    } else if (outside.length) {
      feedback.summary = `the submission changes functions it does not hold: ${outside.map((o) => o.id).join(', ')}; claim them as well (td claim --unit) or undo those changes`;
      feedback.changedOutside = outside;
      state = 'needs_cleanup';
    } else if (wrongRefs.length) {
      feedback.summary = `references point at the wrong symbols: ${wrongRefs.map((c) => c.message).join('; ')}`;
      state = 'needs_cleanup';
    } else if (virtual && !(targetAddr && isVirtualizedStub(this.getPe(), targetAddr, target.size?.original))) {
      feedback.summary = `${targetId} carries // VIRTUALIZED but its original is ordinary code (no jump into a section whose bytes the file lacks): remove the marker and port the function`;
      state = 'needs_cleanup';
    } else if (virtual && (target.status === STATUS.MISMATCH || target.status === STATUS.UNRESOLVED)) {
      // The original is a protector stub, so neither the bytes nor peers reading them can judge the
      // body: it comes from the reference build in the marker, and a maintainer approves it.
      feedback.summary = `virtualized in the original (body from the ${virtual.build} build at ${virtual.addr}), sent to maintainer review: the target only has a protector stub, so it is not compared or peer reviewed`;
      feedback.virtualized = virtual;
      state = 'in_review';
    } else if (target.status === STATUS.EXACT || (target.status === STATUS.UNRESOLVED && policy.reviewAt === 'match_unresolved')) {
      // Byte-identical needs no human: approved directly, merged with its batch.
      const auto = policy.autoMergeIdentical !== false;
      feedback.summary = (target.status === STATUS.EXACT ? 'byte-identical' : 'byte-identical (some referenced data is not yet named)') + (auto ? ', approved automatically' : ', sent to human review');
      state = auto ? 'approved' : 'in_review';
    } else if (target.status === STATUS.MISMATCH || target.status === STATUS.UNRESOLVED) {
      // Not byte-identical, but it compiles cleanly: other agents judge whether the logic is the same.
      feedback.summary = `not byte-identical (score ${(score * 100).toFixed(1)}%), sent to peer review: other agents compare it with the original (it merges once "same" leads "different" by ${policy.peerMargin ?? 3} with ${Math.round((policy.peerAcceptShare ?? 0.7) * 100)}% of the votes; at least ${policy.peerReviews ?? 3} "different" leading by ${policy.peerRejectMargin ?? 2}, or ${policy.peerMaxReviewers ?? 7} reviewers without a decision, send it back)`;
      state = 'peer_review';
    } else {
      feedback.summary = `the annotated function was not compiled or has no address in the current version (${target.status})`;
      state = 'needs_cleanup';
    }
    return { state, score, feedback };
  }

  finish(attempt, state, score, feedback, extra = {}) {
    const task = this.tasks.get(attempt.task_id);
    this.store.tx(() => {
      this.store.run('UPDATE attempts SET state = ?, score = ?, result_json = ?, finished_at = ? WHERE id = ?', state, score, JSON.stringify({ feedback, ...extra }), now(), attempt.id);
      const onTheWay = ['in_review', 'peer_review', 'approved'].includes(state);
      let taskState = onTheWay ? state : 'needs_cleanup';
      const better = state !== 'rejected' && score > task.best_score;
      // A competing candidate records a better score, but the task stays as its holder has it.
      if (attempt.competing) {
        if (better) this.store.run('UPDATE tasks SET best_score = ?, best_attempt = ?, updated_at = ? WHERE id = ?', score, attempt.id, now(), task.id);
        this.store.event('verified', attempt.user_id, { attempt: attempt.id, state, score, competing: true });
        return;
      }
      const cycles = task.cleanup_cycles + (onTheWay ? 0 : 1);
      if (taskState === 'needs_cleanup' && cycles >= this.project.matchPolicy.maxCleanupCycles) taskState = 'hard';
      if (state === 'rejected' && !task.best_attempt) taskState = 'open';
      const hold = onTheWay ? { user: attempt.user_id, until: now() + AUTHOR_HOLD_MS } : holdFor(this.store, task.id, attempt.user_id);
      this.store.run(
        `UPDATE tasks SET state = ?, cleanup_cycles = ?, best_score = ?, best_attempt = ?, preferred_user = ?, preferred_until = ?, updated_at = ? WHERE id = ?`,
        taskState,
        cycles,
        better ? score : task.best_score,
        better ? attempt.id : task.best_attempt,
        hold.user,
        hold.until,
        now(),
        task.id,
      );
      this.store.event('verified', attempt.user_id, { attempt: attempt.id, state, score });
    });
    this.log.info(`attempt ${attempt.id} (task ${task.id}): ${state} ${(score * 100).toFixed(1)}% - ${feedback.summary}`);
  }
}

function summarizeCheck(check) {
  return check.units.map((u) => ({ file: u.file, compiled: u.compiled, timedOut: !!u.timedOut, functions: u.functions.map((f) => ({ id: f.id, status: f.status, score: f.score, symbol: f.symbol, demangled: f.demangled })), bindings: u.bindings }));
}
