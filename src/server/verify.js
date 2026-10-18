// Verification of submitted attempts: static gate, sandboxed compile,
// byte comparison, regression check, and routing of the result.

import fs from 'node:fs';
import path from 'node:path';
import { lintSubmission } from '../shared/lint.js';
import { checkUnits } from '../shared/check.js';
import { reconcile } from '../shared/reconcile.js';
import { STATUS } from '../shared/compare.js';
import { listSources, isUnit } from '../shared/project.js';
import { now } from './db.js';
import { returnBatch, batchAttempts } from './batches.js';

const RANK = { [STATUS.EXACT]: 3, [STATUS.UNRESOLVED]: 2, [STATUS.MISMATCH]: 1, [STATUS.MISSING]: 0, [STATUS.NO_ADDRESS]: 0 };

export class Verifier {
  constructor({ store, config, repo, project, tasks, getPe, peers, log = console }) {
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
    this.store.run(`UPDATE batches SET state = 'queued' WHERE state = 'verifying'`);
    this.store.run(`UPDATE attempts SET state = 'queued' WHERE state = 'verifying'`);
    // Attempts from before batches existed become batches of one.
    for (const a of this.store.all(`SELECT * FROM attempts WHERE state = 'queued' AND batch_id IS NULL`)) {
      const b = this.store.run(
        `INSERT INTO batches (user_id, base_commit, files_json, notes, agent_meta, env_digest, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
        a.user_id, a.base_commit, a.files_json, a.notes, a.agent_meta, a.env_digest, a.created_at,
      );
      this.store.run('UPDATE attempts SET batch_id = ? WHERE id = ?', Number(b.lastInsertRowid), a.id);
    }
    this.timer = setInterval(() => this.pump(), 2000);
    this.pump();
  }

  stop() {
    clearInterval(this.timer);
  }

  pump() {
    const max = this.config.verifyConcurrency ?? 2;
    while (this.running < max) {
      const b = this.store.tx(() => {
        const row = this.store.get(`SELECT * FROM batches WHERE state = 'queued' ORDER BY id LIMIT 1`);
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
  async check(files, jobName, { allUnits = false, timeoutMs = null } = {}) {
    const changedHeaders = Object.keys(files).filter((f) => !isUnit(f));
    const units = new Set(Object.keys(files).filter(isUnit));
    const allProjectUnits = () => listSources(this.repo.dir, this.project, { unitsOnly: true });
    if (allUnits) for (const u of allProjectUnits()) units.add(u);
    else if (changedHeaders.length) {
      // Only units that include a changed header; all of them until a rebuild has recorded dependencies.
      const known = this.store.get('SELECT COUNT(*) AS n FROM unit_deps').n > 0;
      const ph = changedHeaders.map(() => '?').join(',');
      const dependents = known ? this.store.all(`SELECT DISTINCT unit FROM unit_deps WHERE header IN (${ph})`, ...changedHeaders).map((r) => r.unit) : allProjectUnits();
      for (const u of dependents) units.add(u);
    }

    const v = this.store.currentVersion();
    const symbols = this.store.symbolMap(v.id);
    const jobDir = path.join(this.jobsDir, jobName);
    try {
      const check = await checkUnits({
        repoDir: this.repo.dir,
        jobDir,
        project: this.project,
        units: [...units],
        overrides: files,
        symbols,
        nameIndex: this.store.nameIndex(),
        pe: this.getPe(),
        runners: this.config.runners,
        timeoutMs: timeoutMs ?? this.config.buildTimeoutMs ?? 300_000,
        // The macro-proof lint needs the /P pass: for submitted units; for every unit when a header
        // changed (a macro there expands everywhere); never for a rebuild of trusted main.
        lintUnits: allUnits && !Object.keys(files).length ? new Set() : changedHeaders.length ? null : new Set(Object.keys(files).filter(isUnit)),
      });
      const rec = reconcile(check, symbols);
      return { check, rec, symbols, changedHeaders, units: [...units] };
    } finally {
      if (!this.config.keepJobDirs) fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }

  /** Functions that match on main but would no longer match with this change. */
  regressions(check) {
    const results = new Map();
    for (const u of check.units) for (const f of u.functions) results.set(f.id, f);
    const compiledFiles = new Set(check.units.map((u) => u.file));
    const out = [];
    for (const row of this.store.all(`SELECT * FROM func_status WHERE status IN ('exact', 'match_unresolved') OR confirmed = 1`)) {
      if (!compiledFiles.has(row.file)) continue;
      const now_ = results.get(row.symbol_id);
      if (!now_ || RANK[now_.status] < RANK[row.status]) out.push({ id: row.symbol_id, file: row.file, was: row.status, now: now_?.status ?? 'removed' });
      // A peer-confirmed function whose compiled code changes was not seen by its reviewers.
      else if (row.confirmed && now_.status === STATUS.MISMATCH && Math.abs(now_.score - row.score) > 1e-4) {
        out.push({ id: row.symbol_id, file: row.file, was: 'peer-confirmed', now: `changed (score ${(row.score * 100).toFixed(1)}% -> ${(now_.score * 100).toFixed(1)}%)` });
      }
    }
    return out;
  }

  /**
   * Functions of the submitted files whose compiled code differs from main although they are not
   * part of the submission: a submission may only change the functions it holds the lease for.
   * Unknown on main (no fingerprint yet, e.g. before the first rebuild) is not counted.
   */
  changedOutside(check, files, targets) {
    const fileSet = new Set(Object.keys(files));
    const seen = new Map();
    for (const u of check.units) for (const f of u.functions) if (fileSet.has(f.file) && !targets.has(f.id) && f.codeHash) seen.set(f.id, f);
    const out = [];
    for (const [id, f] of seen) {
      const main = this.store.get('SELECT code_hash FROM func_status WHERE symbol_id = ?', id);
      if (!main) out.push({ id, file: f.file, why: 'new or newly annotated' });
      else if (main.code_hash && main.code_hash !== f.codeHash) out.push({ id, file: f.file, why: 'compiled code changed' });
    }
    return out;
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
        `INSERT OR IGNORE INTO peer_reviews (attempt_id, reviewer_id, verdict, reason, agent_meta, created_at)
         SELECT ?, reviewer_id, verdict, reason, agent_meta, created_at FROM peer_reviews WHERE attempt_id = ?`,
        attempt.id, p.id,
      );
      return true;
    }
    return false;
  }

  async verifyBatch(batch) {
    const attempts = batchAttempts(this.store, batch.id);
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
    });
    if (lintErrors.length) return finishAll('rejected', { summary: 'rejected by the static gate', lintErrors });
    if (!this.repo.isAncestor(batch.base_commit)) return finishAll('rejected', { summary: `base commit ${batch.base_commit} is not part of main; sync and resubmit` });
    const merged = this.repo.mergeOntoHead(batch.base_commit, submitted);
    if (merged.conflicts.length) return finishAll('needs_cleanup', { summary: 'your change conflicts with newer work on main; sync, merge and resubmit', conflicts: merged.conflicts });

    // Stages 1-3: one compile for the whole batch, then every function on its own.
    const { check, rec, changedHeaders } = await this.check(merged.files, `batch-${batch.id}`);
    const targets = new Set(attempts.map((a) => a.symbol_id));
    const outside = this.changedOutside(check, merged.files, targets);
    let failed = 0;
    for (const a of attempts) {
      const ev = this.evaluate({ check, rec, targetId: a.symbol_id, files: merged.files, changedHeaders, outside });
      ev.feedback.headCommit = this.repo.head();
      if (attempts.length > 1) ev.feedback.batch = { id: batch.id, functions: attempts.length };
      if (batch.env_digest && this.config.envDigest && batch.env_digest !== this.config.envDigest) {
        ev.feedback.warnings.push('your local toolchain differs from the pinned one; local results may not match the server');
      }
      if (ev.state === 'peer_review' && this.carryOver(a, ev.feedback.target)) {
        ev.state = 'in_review';
        ev.feedback.summary += '; the compiled code is unchanged since three peers confirmed it, so their verdicts carry over';
      }
      if (ev.state === 'needs_cleanup' || ev.state === 'rejected') failed++;
      this.finish(a, ev.state, ev.score, ev.feedback);
    }
    this.store.run(
      `UPDATE batches SET state = 'open', finished_at = ?, result_json = ? WHERE id = ?`,
      now(), JSON.stringify({ mergedFiles: merged.files, check: summarizeCheck(check), changedHeaders, outside }), batch.id,
    );
    if (failed) returnBatch(this.store, batch.id, `${failed} of ${attempts.length} functions need work; see each function's feedback`);
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

    const annErrors = check.annotationErrors.filter((e) => fileSet.has(e.file) && e.severity !== 'warning');
    const annWarnings = check.annotationErrors.filter((e) => fileSet.has(e.file) && e.severity === 'warning');
    for (const w of annWarnings) feedback.warnings.push(`${w.file}:${w.line} ${w.message}`);
    const failed = check.units.filter((u) => !u.compiled);
    const target = check.units.flatMap((u) => u.functions.map((f) => ({ ...f, file: u.file }))).find((f) => f.id === targetId);
    const regressions = this.regressions(check);

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
      feedback.summary = `not byte-identical (score ${(score * 100).toFixed(1)}%), sent to peer review: ${policy.peerReviews} other agents compare it with the original`;
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
