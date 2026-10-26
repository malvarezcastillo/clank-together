// Verification of submitted attempts: static gate, sandboxed compile,
// byte comparison, regression check, and routing of the result.

import fs from 'node:fs';
import path from 'node:path';
import { lintSubmission } from '../shared/lint.js';
import { freeTextErrors } from '../shared/freetext.js';
import { checkUnits } from '../shared/check.js';
import { reconcile } from '../shared/reconcile.js';
import { STATUS, sameOriginal } from '../shared/compare.js';
import { listSources, isUnit } from '../shared/project.js';
import { changedNames, unitsMentioning } from './affected.js';
import { undefinedDeclarations } from './undefined.js';
import { functionRegions } from './split.js';
import { className } from './grouping.js';
import { now } from './db.js';
import { returnBatch, batchAttempts, settleBatch } from './batches.js';
import { analyzeInWorkers } from './analyze.js';

// A batch whose verification compiles more units than this is big (it changes a widely used header).
export const BIG_BATCH = 20;

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
    this.jobsDir = path.join(config.dataDir, 'jobs');
  }

  start() {
    this.stopped = false;
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

  pump() {
    if (this.stopped) return;
    const max = this.config.verifyConcurrency ?? 3;
    while (this.running < max) {
      // Verification compiles only the submitted units, so every batch is small here; the units
      // that include a changed header are compiled in the merge's big lane.
      const b = this.store.tx(() => {
        // Fair between accounts: the oldest batch of whoever has the fewest batches verifying, so a
        // fast contributor with several batches waiting does not hold every slot.
        const row = this.store.get(
          `SELECT b.* FROM batches b WHERE b.state = 'queued'
            ORDER BY (SELECT COUNT(*) FROM batches v WHERE v.user_id = b.user_id AND v.state = 'verifying'), b.id LIMIT 1`,
        );
        if (row) {
          this.store.run(`UPDATE batches SET state = 'verifying' WHERE id = ?`, row.id);
          this.store.run(`UPDATE attempts SET state = 'verifying' WHERE batch_id = ? AND state = 'queued'`, row.id);
        }
        return row;
      });
      if (!b) return;
      this.running++;
      this.verifyBatch(b)
        .catch((e) => {
          this.log.error(`batch ${b.id}: verifier crashed: ${e.stack}`);
          for (const a of batchAttempts(this.store, b.id)) {
            if (a.state === 'verifying') this.finish(a, 'needs_cleanup', 0, { summary: 'internal verifier error; a maintainer has been notified', internalError: true });
          }
          returnBatch(this.store, b.id, 'internal verifier error');
        })
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
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
  async check(files, jobName, { allUnits = false, timeoutMs = null, dependents = true, lint = true, onlyUnits = null, targets = null } = {}) {
    const changedHeaders = Object.keys(files).filter((f) => !isUnit(f));
    const submittedUnits = Object.keys(files).filter(isUnit);
    const units = new Set(onlyUnits ?? submittedUnits);
    if (onlyUnits) dependents = false;
    const lintUnits = new Set(lint ? submittedUnits : []);
    const allProjectUnits = () => listSources(this.repo.dir, this.project, { unitsOnly: true });
    if (allUnits) for (const u of allProjectUnits()) units.add(u);
    else if (changedHeaders.length && !onlyUnits) {
      // Units that include a changed header; all of them until a rebuild has recorded dependencies.
      // Without dependents, a header-only change compiles one includer per header.
      const known = this.store.get('SELECT COUNT(*) AS n FROM unit_deps').n > 0;
      const headerOnly = !units.size;
      for (const h of changedHeaders) {
        const deps = known ? this.store.all('SELECT unit FROM unit_deps WHERE header = ? ORDER BY unit', h).map((r) => r.unit) : allProjectUnits();
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
          const deps = this.store.all('SELECT unit FROM unit_deps WHERE header = ? ORDER BY unit', h).map((r) => r.unit);
          const hits = names.length ? unitsMentioning(this.repo, deps, names, files) ?? [] : [];
          for (const u of (hits.length ? hits : deps).slice(0, 16)) units.add(u);
        }
      }
    }

    const v = this.store.currentVersion();
    const symbols = this.store.symbolMap(v.id);
    const nameIndex = this.store.nameIndex();
    const jobDir = path.join(this.jobsDir, jobName);
    try {
      const check = await checkUnits({
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
        // The macro-proof lint needs the /P pass: for submitted units; for every unit when a header
        // changed (a macro there expands everywhere); never for a rebuild of trusted main.
        lintUnits,
        analyze: (args) => analyzeInWorkers({ ...args, symbols, nameIndex, peFile: v.file }),
      });
      const rec = reconcile(check, symbols);
      return { check, rec, symbols, changedHeaders, units: [...units] };
    } finally {
      if (!this.config.keepJobDirs) fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }

  /**
   * Comments and strings a submission adds that could carry instructions to other agents: only
   * annotations and markers, and strings of the original executable, are allowed (freetext.js).
   */
  freeTextGate(files, baseCommit) {
    const exe = this.getPe().buf;
    const inOriginal = (bytes) => exe.indexOf(bytes) !== -1;
    const errors = [];
    for (const [file, text] of Object.entries(files)) {
      if (typeof text !== 'string') continue;
      for (const e of freeTextErrors(text, this.repo.show(baseCommit, file), inOriginal)) errors.push({ file, ...e });
    }
    return errors;
  }

  /**
   * Annotations of functions of the current version that the submission removes although it does
   * not hold them (not in the batch, not leased, not in a claimed region). Removing a duplicate is
   * fine: the function stays annotated elsewhere on main.
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
    return undefinedDeclarations(files, { before: (f) => this.repo.show(baseCommit, f), existsElsewhere, known });
  }

  // What a merge needs from the verification's check (without listings and byte diffs).
  rememberCheck(batchId, { check, rec, changedHeaders }) {
    const compact = {
      annotationErrors: check.annotationErrors,
      units: check.units.map((u) => ({ ...u, functions: u.functions.map(({ asm, diffRegions, ...f }) => f) })),
    };
    this.store.run('INSERT OR REPLACE INTO batch_checks (batch_id, head, check_json) VALUES (?, ?, ?)', batchId, this.repo.head(), JSON.stringify({ check: compact, rec, changedHeaders }));
  }

  /**
   * The check a merge needs, reusing the verification's compile of every unit whose source and
   * included headers are unchanged since: only the other units are compiled again (often none, or
   * just the one file a split took functions out of). `fromBatch` is the verified batch (a split
   * part points at the batch it came from).
   */
  async mergeCheck(batch, files, fromBatch = batch) {
    const row = this.store.get('SELECT head, check_json FROM batch_checks WHERE batch_id = ?', fromBatch.id);
    const fresh = () => this.check(files, `merge-${batch.id}`, { lint: false });
    if (!row) return fresh();
    const verified = fromBatch.result_json ? JSON.parse(fromBatch.result_json).mergedFiles ?? {} : {};
    const saved = JSON.parse(row.check_json);
    // Files whose content differs from what was verified: changed on main, or by this merge.
    const changed = new Set(row.head === this.repo.head() ? [] : this.repo.git(['diff', '--name-only', row.head, 'HEAD']).split('\n').filter(Boolean));
    for (const f of new Set([...Object.keys(files), ...Object.keys(verified)])) if (files[f] !== verified[f]) changed.add(f);
    const stale = saved.check.units.filter((u) => changed.has(u.file) || (u.includes ?? []).some((h) => changed.has(h)) || !u.compiled);
    // A unit the merged files add that verification did not compile.
    const known = new Set(saved.check.units.map((u) => u.file));
    for (const f of Object.keys(files)) if (isUnit(f) && !known.has(f)) stale.push({ file: f });
    // Verification compiled only the submitted units. Before a header change reaches main, the
    // includers it can affect are compiled and checked for regressions: the ones that mention a
    // name it touched (affected.js); every includer when the change is too broad to narrow down.
    const head = this.repo.head();
    for (const h of Object.keys(files).filter((f) => !isUnit(f))) {
      const before = this.repo.show(head, h);
      if (before === files[h]) continue;
      const deps = this.store.all('SELECT unit FROM unit_deps WHERE header = ?', h).map((r) => r.unit);
      const narrowed = before === null ? null : unitsMentioning(this.repo, deps, changedNames(before, files[h]), files);
      const pick = narrowed && narrowed.length <= 300 ? narrowed : deps;
      if (pick !== deps) this.log.info(`batch ${batch.id}: ${h} changed; compiling ${pick.length} of its ${deps.length} includers (the ones that mention what changed)`);
      for (const u of pick) if (!known.has(u) && !stale.some((x) => x.file === u)) stale.push({ file: u });
    }
    if (!stale.length) return { ...saved, reused: saved.check.units.length, compiled: 0 };
    const part = await this.check(files, `merge-${batch.id}`, { lint: false, onlyUnits: stale.map((u) => u.file) });
    const staleFiles = new Set(stale.map((u) => u.file));
    const check = { annotationErrors: part.check.annotationErrors, units: [...saved.check.units.filter((u) => !staleFiles.has(u.file)), ...part.check.units] };
    const symbols = this.store.symbolMap(this.store.currentVersion().id);
    return { check, rec: reconcile(check, symbols), changedHeaders: saved.changedHeaders, reused: check.units.length - part.check.units.length, compiled: part.check.units.length };
  }

  /**
   * A recorded status can be older than main: a header change merged later recompiles a unit only
   * where it mentions what changed (affected.js), so a unit's functions can build differently on
   * main than recorded. Before a check counts regressions, the units it would blame are compiled
   * as main has them (once per main commit) and their recorded status is brought up to date, so a
   * submission is compared with what main actually builds.
   */
  async refreshBaselines(check, files, jobName) {
    const found = this.regressions(check, files);
    if (!found.length) return 0;
    const head = this.repo.head();
    this.baselineAt ??= new Map();
    const units = [...new Set(found.map((r) => r.file))].filter((u) => isUnit(u) && this.baselineAt.get(u) !== head);
    if (!units.length) return 0;
    const { check: main } = await this.check({}, `baseline-${jobName}`, { onlyUnits: units, lint: false });
    if (this.repo.head() !== head) return 0; // main moved meanwhile: the next check measures again
    const compiled = new Set(main.units.filter((u) => u.compiled).map((u) => u.file));
    const ids = new Set(found.map((r) => r.id));
    let changed = 0;
    for (const [id, { f, unit }] of bestResults(main)) {
      if (!ids.has(id) || !compiled.has(unit)) continue;
      const old = this.store.get('SELECT status, score, code_hash FROM func_status WHERE symbol_id = ?', id);
      if (!old || (old.status === f.status && Math.abs(old.score - f.score) <= 1e-4 && old.code_hash === (f.codeHash ?? old.code_hash))) continue;
      this.store.run(
        'UPDATE func_status SET file = ?, status = ?, score = ?, code_hash = COALESCE(?, code_hash), commit_hash = ?, updated_at = ? WHERE symbol_id = ?',
        unit, f.status, f.score, f.codeHash ?? null, head, now(), id,
      );
      this.store.event('baseline_refreshed', null, { id, was: old.status, wasScore: old.score, now: f.status, score: f.score, commit: head });
      this.log.info(`baseline of ${id} was stale (${old.status} ${(old.score * 100).toFixed(1)}%); main builds it as ${f.status} ${(f.score * 100).toFixed(1)}%`);
      changed++;
    }
    for (const u of compiled) this.baselineAt.set(u, head);
    return changed;
  }

  /** Functions that match on main but would no longer match with this change. */
  regressions(check, files = {}) {
    const results = new Map([...bestResults(check)].map(([id, b]) => [id, b.f]));
    const compiledFiles = new Set(check.units.map((u) => u.file));
    const out = [];
    for (const row of this.store.all(`SELECT * FROM func_status WHERE status IN ('exact', 'match_unresolved') OR confirmed = 1`)) {
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
   */
  // With `userId`, only functions someone else is working on count (held by another account, or in
  // another account's submission on its way to main), and functions on main whose source the
  // submission rewrote without listing them: those are revisions and need their own review.
  // Other neighbours may change: their status is measured again, and the regression check still
  // protects whatever already matches.
  changedOutside(check, files, targets, userId = null) {
    const fileSet = new Set(Object.keys(files));
    const seen = new Map();
    for (const u of check.units) for (const f of u.functions) if (fileSet.has(f.file) && !targets.has(f.id) && f.codeHash) seen.set(f.id, f);
    const out = [];
    for (const [id, f] of seen) {
      const main = this.store.get('SELECT code_hash FROM func_status WHERE symbol_id = ?', id);
      if (!main) out.push({ id, file: f.file, why: 'new or newly annotated' });
      else if (main.code_hash && main.code_hash !== f.codeHash) out.push({ id, file: f.file, why: 'compiled code changed' });
    }
    if (userId == null) return out;
    return out.filter((o) => this.workedOnByOthers(o.id, userId) || this.unlistedRevision(o, files));
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
   * A function that three peers already confirmed keeps that confirmation when its compiled code is
   * unchanged in a resubmission (the batch came back because of another function).
   */
  carryOver(attempt, target) {
    if (!target?.codeHash) return false;
    const prev = this.store.all(`SELECT id, result_json FROM attempts WHERE task_id = ? AND id != ? ORDER BY id DESC LIMIT 5`, attempt.task_id, attempt.id);
    for (const p of prev) {
      const hash = p.result_json ? JSON.parse(p.result_json).feedback?.target?.codeHash : null;
      if (hash !== target.codeHash || !this.peers?.confirmed(p.id)) continue;
      this.store.run(
        `INSERT OR IGNORE INTO peer_reviews (attempt_id, reviewer_id, token_id, verdict, weight, reason, agent_meta, created_at)
         SELECT ?, reviewer_id, token_id, verdict, weight, reason, agent_meta, created_at FROM peer_reviews WHERE attempt_id = ?`,
        attempt.id, p.id,
      );
      return true;
    }
    return false;
  }

  async verifyBatch(batch) {
    // Superseded while it waited (a competing candidate merged first): nothing to judge.
    const attempts = batchAttempts(this.store, batch.id).filter((a) => a.state === 'verifying' || a.state === 'queued');
    const confirm = new Set(JSON.parse(batch.result_json ?? '{}').confirm ?? []);
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

    // Stages 1-3: one compile for the whole batch, then every function on its own.
    // Verify fast: the submitted units (enough to judge and route every submitted function). The
    // units that only include a changed header are compiled when the batch merges.
    const { check, rec, changedHeaders } = await this.check(merged.files, `batch-${batch.id}`, { dependents: false, targets: attempts.map((a) => a.symbol_id) });
    await this.refreshBaselines(check, merged.files, `batch-${batch.id}`);
    const targets = new Set(attempts.map((a) => a.symbol_id));
    const outside = this.changedOutside(check, merged.files, targets, batch.user_id);
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
      // Code already on main, submitted again unchanged and not byte-identical: no new work, and it
      // would only fill the peer review. Existing code is reviewed only when the agent asks (confirm).
      if (ev.state === 'peer_review' && !confirm.has(a.symbol_id) && this.unchangedFromBase(a.symbol_id, submitted, batch.base_commit)) {
        this.withdraw(a, 'not changed: this code is already on main as it is; submit the functions you rewrote. To have existing code confirmed by peer review, list it in confirm (td_submit confirm: [...])');
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
    this.store.run(
      `UPDATE batches SET state = 'open', finished_at = ?, result_json = ? WHERE id = ?`,
      now(), JSON.stringify({ mergedFiles: merged.files, check: summarizeCheck(check), changedHeaders, outside }), batch.id,
    );
    this.rememberCheck(batch.id, { check, rec, changedHeaders });
    // Failing functions went back one by one (finish); the rest of the batch carries on and its
    // approved part merges without them. Only a batch with nothing left on its way is over.
    if (failed || withdrawn) settleBatch(this.store, batch.id, `${failed} of ${attempts.length} functions need work${withdrawn ? `, ${withdrawn} were not written` : ''}; see each function's feedback`);
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
      this.store.run(`UPDATE tasks SET state = 'leased', lease_user = ?, lease_expires = ?, updated_at = ? WHERE id = ?`, attempt.user_id, expires, now(), attempt.task_id);
    });
  }

  /** Routes a check result: rejected, needs_cleanup or in_review. */
  evaluate({ check, rec, targetId, files, changedHeaders, outside = [] }) {
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
    const regressions = this.regressions(check, files);

    feedback.target = target ?? null;
    feedback.annotationErrors = annErrors;
    feedback.compileErrors = failed.map((u) => ({ file: u.file, log: u.log }));
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
      this.store.run(
        `UPDATE tasks SET state = ?, cleanup_cycles = ?, best_score = ?, best_attempt = ?, preferred_user = ?, preferred_until = ?, updated_at = ? WHERE id = ?`,
        taskState,
        cycles,
        better ? score : task.best_score,
        better ? attempt.id : task.best_attempt,
        attempt.user_id,
        now() + 6 * 3600_000,
        now(),
        task.id,
      );
      this.store.event('verified', attempt.user_id, { attempt: attempt.id, state, score });
    });
    this.log.info(`attempt ${attempt.id} (task ${task.id}): ${state} ${(score * 100).toFixed(1)}% - ${feedback.summary}`);
  }
}

function summarizeCheck(check) {
  return check.units.map((u) => ({ file: u.file, compiled: u.compiled, functions: u.functions.map((f) => ({ id: f.id, status: f.status, score: f.score, symbol: f.symbol, demangled: f.demangled })), bindings: u.bindings }));
}
