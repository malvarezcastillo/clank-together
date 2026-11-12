// Human review decisions and the serialized merge queue.

import { HttpError } from './http.js';
import { now } from './db.js';
import { hasRole } from './accounts.js';
import { STATUS, relocOnly, resolvedEffectiveHash, isCompilerGenerated } from '../shared/compare.js';
import { reconcile } from '../shared/reconcile.js';
import { returnBatch, batchAttempts, settleBatch, retireSentBack, LIVE_STATES, holdFor } from './batches.js';
import { withoutFunctions, functionRegions } from './split.js';
import { addUnitsToCompileCommands, isUnit } from '../shared/project.js';
import { RANK, bestResults, BIG_BATCH, BUILD_READY, BuildRetryError, deferBuild, clearBuildRetry, boundAddresses } from './verify.js';

// Small merges may compile together. Broad-header merges drain both lanes before starting,
// and maintenance commits share the same exclusion boundary.
const MERGE_SLOTS = 2;

export class Merger {
  constructor({ store, config, repo, project, tasks, verifier, getPe, peers, log = console }) {
    Object.assign(this, { store, config, repo, project, tasks, verifier, getPe, peers, log });
    this.running = 0;
    this.runningBig = 0;
    this.started = false;
    this.active = new Set(); // batch ids being merged (a split parent stays 'open' meanwhile)
  }

  get busy() {
    return this.running > 0;
  }

  start() {
    this.stopped = false;
    this.store.run(`UPDATE batches SET state = 'open' WHERE state = 'merging'`);
    this.store.run(`UPDATE tasks SET state = 'approved' WHERE state = 'merging'`);
    this.started = true;
    this.timer = setInterval(() => { try { this.pump(); } catch (e) { console.error(`merge pump: ${e.message}`); } }, 3000);
  }

  stop() {
    clearInterval(this.timer);
    this.started = false;
    this.stopped = true;
  }

  requiredApprovals(attempt) {
    const batch = attempt.batch_id ? this.store.get('SELECT result_json FROM batches WHERE id = ?', attempt.batch_id) : null;
    const result = batch?.result_json ? JSON.parse(batch.result_json) : {};
    const p = this.project.matchPolicy;
    return result.changedHeaders?.length ? p.approvalsWithHeaderChanges : p.approvals;
  }

  /** A human decision on one attempt (peer-confirmed, not byte-identical). */
  review(reviewer, attemptId, action, comment, options = {}) {
    if (!hasRole(reviewer, 'reviewer')) throw new HttpError(403, 'only reviewers can review');
    if (!['approve', 'request_changes', 'reject'].includes(action)) throw new HttpError(400, 'invalid action');
    return this.store.tx(() => this.reviewOne(reviewer, attemptId, action, comment, options));
  }

  /**
   * The same decision for the functions of a batch that wait for human review: the given
   * `attemptIds` (what the reviewer was shown), or all of them. Functions still in peer review are
   * only included with `skipPeerReview`, which maintainers may ask for explicitly.
   */
  reviewBatch(reviewer, batchId, action, comment, { attemptIds = null, skipPeerReview = false } = {}) {
    if (!hasRole(reviewer, 'reviewer')) throw new HttpError(403, 'only reviewers can review');
    if (!['approve', 'request_changes', 'reject'].includes(action)) throw new HttpError(400, 'invalid action');
    return this.store.tx(() => {
      const states = skipPeerReview ? `'in_review', 'peer_review'` : `'in_review'`;
      const wanted = attemptIds ? new Set(attemptIds) : null;
      const waiting = this.store.all(`SELECT id FROM attempts WHERE batch_id = ? AND state IN (${states})`, batchId).filter((w) => !wanted || wanted.has(w.id));
      if (!waiting.length) throw new HttpError(409, 'nothing in this batch waits for human review');
      const results = waiting.map((w) => ({ attemptId: w.id, ...this.reviewOne(reviewer, w.id, action, comment, { skipPeerReview }) }));
      return { batchId, results };
    });
  }

  reviewOne(reviewer, attemptId, action, comment, { skipPeerReview = false } = {}) {
    const attempt = this.store.get('SELECT * FROM attempts WHERE id = ?', attemptId);
    if (!attempt) throw new HttpError(404, 'no such attempt');
    // Maintainers may decide without waiting for the three peer verdicts, when they ask for it.
    const skipsPeers = attempt.state === 'peer_review' && skipPeerReview;
    if (skipsPeers && !hasRole(reviewer, 'maintainer')) throw new HttpError(403, 'only maintainers can decide before peer review is done');
    if (attempt.state !== 'in_review' && !skipsPeers) throw new HttpError(409, `attempt is ${attempt.state}`);
    if (attempt.user_id === reviewer.id && !hasRole(reviewer, 'admin')) throw new HttpError(403, 'you cannot review your own attempt');
    if (this.store.get('SELECT 1 FROM reviews WHERE attempt_id = ? AND reviewer_id = ?', attemptId, reviewer.id)) throw new HttpError(409, 'you already reviewed this attempt');

    this.store.run('INSERT INTO reviews (attempt_id, reviewer_id, action, comment, created_at) VALUES (?, ?, ?, ?, ?)', attemptId, reviewer.id, action, comment?.slice(0, 4000) ?? null, now());
    this.store.event('review', reviewer.id, { attempt: attemptId, action, ...(skipsPeers && { skippedPeerReview: true }) });
    if (skipsPeers) this.store.run('DELETE FROM peer_leases WHERE attempt_id = ?', attemptId);

    if (action === 'approve') {
      const approvals = this.store.get(`SELECT COUNT(*) AS n FROM reviews WHERE attempt_id = ? AND action = 'approve'`, attemptId).n;
      const needed = this.requiredApprovals(attempt) - approvals;
      if (hasRole(reviewer, 'maintainer') || needed <= 0) {
        this.store.run(`UPDATE attempts SET state = 'approved'${skipsPeers ? ', peer_skipped = 1' : ''} WHERE id = ?`, attemptId);
        this.store.run(`UPDATE tasks SET state = 'approved', updated_at = ? WHERE id = ?`, now(), attempt.task_id);
        return { state: 'approved' };
      }
      return { state: 'in_review', approvalsNeeded: needed };
    }
    const newState = action === 'reject' ? 'rejected' : 'needs_cleanup';
    this.store.run('UPDATE attempts SET state = ? WHERE id = ?', newState, attemptId);
    const hold = holdFor(this.store, attempt.task_id, attempt.user_id);
    this.store.run(`UPDATE tasks SET state = 'needs_cleanup', preferred_user = ?, preferred_until = ?, updated_at = ? WHERE id = ?`, hold.user, hold.until, now(), attempt.task_id);
    // Only this function goes back; the rest of its batch carries on.
    settleBatch(this.store, attempt.batch_id, `a reviewer asked for changes to ${attempt.task_id}`);
    return { state: newState };
  }

  /**
   * An admin's decision that a batch sent back only for lowering matching scores merges anyway:
   * the project prefers that source (e.g. no calling convention the original code did not need)
   * over closer bytes. Every function of the batch is accepted as it is, without peer review, and
   * the merge records the lower scores.
   */
  acceptRegressions(admin, batchId, comment) {
    if (!hasRole(admin, 'admin')) throw new HttpError(403, 'only admins can accept lower matching scores');
    return this.store.tx(() => {
      const batch = this.store.get('SELECT * FROM batches WHERE id = ?', batchId);
      if (!batch) throw new HttpError(404, 'no such batch');
      if (batch.state !== 'returned') throw new HttpError(409, `batch is ${batch.state}`);
      const attempts = batchAttempts(this.store, batchId);
      const blocking = attempts.filter((a) => {
        const fb = a.result_json ? JSON.parse(a.result_json).feedback ?? {} : {};
        return !['needs_cleanup', 'returned'].includes(a.state) || fb.compileErrors?.length || fb.annotationErrors?.length || fb.summary === 'compilation failed';
      });
      if (!attempts.length || blocking.length) throw new HttpError(409, `only a batch that compiled and came back for its scores can be accepted (${blocking.map((a) => a.symbol_id).join(', ') || 'empty'})`);
      for (const a of attempts) {
        this.store.run(`UPDATE attempts SET state = 'approved', regressions_accepted = 1, peer_skipped = 1 WHERE id = ?`, a.id);
        this.store.run(`UPDATE tasks SET state = 'approved', updated_at = ? WHERE id = ? AND state != 'done'`, now(), a.task_id);
        this.store.run('INSERT INTO reviews (attempt_id, reviewer_id, action, comment, created_at) VALUES (?, ?, ?, ?, ?)', a.id, admin.id, 'approve', comment?.slice(0, 4000) ?? null, now());
      }
      this.store.run(`UPDATE batches SET state = 'open', result_json = json_remove(COALESCE(result_json, '{}'), '$.returned', '$.mergeFailure') WHERE id = ?`, batchId);
      this.store.event('regressions_accepted', admin.id, { batch: batchId, attempts: attempts.map((a) => a.id) });
      return { batchId, accepted: attempts.map((a) => a.id) };
    });
  }

  /**
   * Accepted "no decompile" claims need no merge: the function is skipped (no task, not counted in
   * progress). Kept for later review when a peer objected, like code.
   */
  finishSkips() {
    const done = this.store.all(`SELECT a.*, t.symbol_id FROM attempts a JOIN tasks t ON t.id = a.task_id WHERE a.kind = 'skip' AND a.state = 'approved'`);
    if (!done.length) return;
    this.store.tx(() => {
      for (const a of done) {
        this.store.run(`UPDATE attempts SET state = 'merged' WHERE id = ?`, a.id);
        this.store.run(`UPDATE tasks SET state = 'skipped', lease_user = NULL, updated_at = ? WHERE id = ?`, now(), a.task_id);
        retireSentBack(this.store, a.task_id, `${a.symbol_id} was accepted as needing no decompilation; this attempt is no longer needed`);
        this.store.run('UPDATE symbols SET skip_reason = ? WHERE id = ?', a.skip_category, a.symbol_id);
        const objections = this.store.get(`SELECT COUNT(*) AS n FROM peer_reviews WHERE attempt_id = ? AND verdict = 'different'`, a.id).n;
        if (objections) this.store.run('INSERT INTO later_review (symbol_id, attempt_id, merged_commit, objections, created_at) VALUES (?, ?, NULL, ?, ?)', a.symbol_id, a.id, objections, now());
        this.store.event('skipped', a.user_id, { attempt: a.id, symbol: a.symbol_id, category: a.skip_category });
      }
    });
    this.log.info(`${done.length} function(s) accepted as needing no decompilation`);
  }

  /**
   * A batch that only merges as a whole (noSplit) can't once one of its functions has dropped out
   * after that was decided (sent back, withdrawn, superseded): it all goes back to its author
   * instead of holding its approved functions forever.
   */
  returnUnmergeable() {
    const stuck = this.store.all(
      `SELECT b.id, json_extract(b.result_json, '$.noSplit') AS reason FROM batches b WHERE b.state = 'open' AND json_extract(COALESCE(b.result_json, '{}'), '$.noSplit') IS NOT NULL
          AND EXISTS (SELECT 1 FROM attempts a WHERE a.batch_id = b.id AND a.state IN ('needs_cleanup', 'rejected', 'returned', 'withdrawn', 'superseded'))`,
    ).filter((b) => !this.active.has(b.id));
    if (!stuck.length) return;
    this.store.tx(() => {
      for (const b of stuck) returnBatch(this.store, b.id, `a function of this batch dropped out and the rest cannot be merged without it: ${b.reason}`);
    });
    this.log.info(`${stuck.length} batch(es) returned: a function dropped out and the rest cannot merge without it`);
  }

  // Imports and interrupted state transitions can leave an open batch with no work to merge.
  // Settle its envelope without changing task states, attempts, reviews or scores.
  settleInactive() {
    const ph = LIVE_STATES.map(() => '?').join(',');
    const batches = this.store.all(
      `SELECT b.id FROM batches b WHERE b.state = 'open' AND b.kind = 'code'
          AND EXISTS (SELECT 1 FROM attempts a WHERE a.batch_id = b.id AND a.state IN ('needs_cleanup', 'rejected', 'returned'))
          AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.batch_id = b.id AND a.state IN (${ph}))
          AND NOT EXISTS (SELECT 1 FROM batches child WHERE json_extract(child.result_json, '$.splitFrom') = b.id AND child.state IN ('open', 'merging'))`,
      ...LIVE_STATES,
    ).filter((b) => !this.active.has(b.id));
    this.store.tx(() => {
      for (const b of batches) {
        const reason = 'No attempts remain in verification, review or approval; inspect the individual results and resubmit corrected work.';
        settleBatch(this.store, b.id, reason);
        this.store.event('batch_settled', null, { batch: b.id, reason });
      }
    });
  }

  /** Starts merges while a lane is free; resolves when the merges it started are done. */
  async pump({ synchronized = false } = {}) {
    if (!this.stopped) {
      this.finishSkips();
      this.returnUnmergeable();
      this.settleInactive();
    }
    const started = [];
    // A successful idle sync grants one bounded merge cohort even if the web process queued
    // more submissions during fetch. Those newer submissions still need their own next sync.
    const admitted = () => !this.verifier.repositoryBlocked || (synchronized && !this.verifier.needsSync && !this.verifier.syncError);
    while (!this.stopped && admitted() && !this.verifier.runningMaintenance && !this.runningBig && this.running < MERGE_SLOTS) {
      const pick = this.next();
      if (!pick) break;
      // Maintenance also commits to main. Drain for an older synchronized maintenance batch
      // instead of letting a continuous stream of approved code keep it queued forever.
      const maintenance = this.store.get(`SELECT id FROM batches WHERE state = 'queued' AND kind = 'maintenance' AND ${BUILD_READY} AND (? = 0 OR id <= ?) ORDER BY id LIMIT 1`, now(), this.config.pushRemote ? 1 : 0, this.verifier.syncedThrough ?? 0);
      if (maintenance && maintenance.id < pick.batch.id) break;
      const big = (pick.batch.cost ?? 0) > BIG_BATCH;
      // Do not keep admitting newer small work ahead of an older broad-header merge.
      if (big && this.running) break;
      this.running++;
      if (big) this.runningBig++;
      this.active.add(pick.batch.id);
      started.push(
        (pick.whole ? this.merge(pick.batch) : this.mergeApprovedPart(pick.batch))
          .catch((e) => {
            this.log.error(`merge of batch ${pick.batch.id} failed: ${e.stack}`);
            try {
              this.repo.reset();
            } catch {}
            this.store.run(`UPDATE batches SET state = 'open' WHERE id = ?`, pick.batch.id);
            this.store.event('merge_error', null, { batch: pick.batch.id, error: e.message });
          })
          .finally(() => {
            this.running--;
            if (big) this.runningBig--;
            this.active.delete(pick.batch.id);
          }),
      );
    }
    await Promise.all(started);
  }

  // Compare the oldest whole and partial candidates instead of giving whole batches priority.
  next() {
    const skip = [...this.active];
    const notActive = (skip.length ? `AND b.id NOT IN (${skip.map(Number).join(',')})` : '') +
      ` AND COALESCE(json_extract(b.result_json, '$.buildRetry.retryAt'), 0) <= ${now()}
        AND NOT EXISTS (SELECT 1 FROM batches child WHERE json_extract(child.result_json, '$.splitFrom') = b.id AND child.state IN ('open', 'merging'))`;
    const whole = this.store.get(
      `SELECT b.* FROM batches b WHERE b.state = 'open' ${notActive}
          AND EXISTS (SELECT 1 FROM attempts a WHERE a.batch_id = b.id)
          AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.batch_id = b.id AND a.state != 'approved')
        ORDER BY b.id LIMIT 1`,
    );
    const partial = this.store.get(
      `SELECT b.* FROM batches b WHERE b.state = 'open' ${notActive} AND json_extract(COALESCE(b.result_json, '{}'), '$.noSplit') IS NULL
          AND EXISTS (SELECT 1 FROM attempts a WHERE a.batch_id = b.id AND a.state = 'approved')
          AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.batch_id = b.id AND a.state IN ('queued', 'verifying', 'merging'))
        ORDER BY b.id LIMIT 1`,
    );
    const pick = whole && (!partial || whole.id <= partial.id) ? { batch: whole, whole: true }
      : partial ? { batch: partial, whole: false } : null;
    if (pick && (pick.batch.cost ?? 0) <= BIG_BATCH) {
      const files = JSON.parse(pick.batch.files_json);
      const paths = Object.keys(files);
      const headers = paths.filter((file) => !isUnit(file));
      const units = new Set([...paths.filter(isUnit), ...(headers.length ? this.verifier.includersOf(headers, files) : [])]);
      pick.batch.cost = Math.max(pick.batch.cost ?? 0, units.size);
    }
    return pick;
  }

  /**
   * Moves the approved attempts of `parent` into a batch of their own and merges that. Functions
   * still in review, and ones that were sent back, are left out of it.
   */
  async mergeApprovedPart(parent) {
    const attempts = batchAttempts(this.store, parent.id);
    const approved = attempts.filter((a) => a.state === 'approved');
    const pending = attempts.filter((a) => a.state !== 'approved');
    const keepCode = !!JSON.parse(parent.result_json ?? '{}').splitKeepCode;
    const files = withoutFunctions(JSON.parse(parent.files_json), pending.map((a) => a.symbol_id), (f) => this.repo.show(parent.base_commit, f), { keepCode });
    if (!files) return this.noSplit(parent, 'the approved and pending functions share code that cannot be separated');
    const child = this.store.tx(() => {
      const r = this.store.run(
        `INSERT INTO batches (user_id, base_commit, files_json, notes, agent_meta, env_digest, state, result_json, created_at, finished_at, cost)
         SELECT user_id, base_commit, ?, notes, agent_meta, env_digest, 'open', json_set(COALESCE(result_json, '{}'), '$.splitFrom', id), created_at, finished_at, ? FROM batches WHERE id = ?`,
        JSON.stringify(files), parent.cost ?? 0, parent.id,
      );
      const id = Number(r.lastInsertRowid);
      for (const a of approved) this.store.run('UPDATE attempts SET batch_id = ? WHERE id = ?', id, a.id);
      return this.store.get('SELECT * FROM batches WHERE id = ?', id);
    });
    this.log.info(`batch ${parent.id}: merging its ${approved.length} approved functions as batch ${child.id}; ${pending.length} still in review${keepCode ? ' (their code kept, unannotated)' : ''}`);
    try {
      await this.merge(child, { parent, parentFiles: JSON.parse(parent.files_json), splitFiles: files });
    } catch (e) {
      try {
        this.repo.reset();
      } catch {}
      this.undoSplit(parent, child, approved, `merging the approved part failed: ${e.message}`);
      throw e;
    }
  }

  // The approved attempts go back to the batch they came from, which then merges as a whole.
  // One function of a merge fails on current main: it goes back to its author, the others wait
  // (approved) in their batch and merge on the next round, split from it.
  sendBackOne(batch, attempts, failed, feedback, split) {
    this.store.tx(() => {
      this.store.run(`UPDATE attempts SET state = 'needs_cleanup', result_json = json_set(COALESCE(result_json, '{}'), '$.feedback', json(?)) WHERE id = ?`, JSON.stringify(feedback), failed.id);
      const hold = holdFor(this.store, failed.task_id, failed.user_id);
      this.store.run(
        `UPDATE tasks SET state = 'needs_cleanup', preferred_user = ?, preferred_until = ?, updated_at = ? WHERE id = ?`,
        hold.user, hold.until, now(), failed.task_id,
      );
      const home = split ? split.parent.id : batch.id;
      for (const a of attempts) {
        if (a.id === failed.id) continue;
        this.store.run(`UPDATE attempts SET batch_id = ?, state = 'approved' WHERE id = ?`, home, a.id);
        this.store.run(`UPDATE tasks SET state = 'approved', updated_at = ? WHERE id = ?`, now(), a.task_id);
      }
      if (split) {
        this.store.run(`UPDATE attempts SET batch_id = ? WHERE id = ?`, home, failed.id);
        this.store.run(`UPDATE batches SET state = 'superseded' WHERE id = ?`, batch.id);
      }
      this.store.run(`UPDATE batches SET state = 'open', result_json = json_remove(COALESCE(result_json, '{}'), '$.noSplit') WHERE id = ?`, home);
    });
    this.log.info(`batch ${batch.id}: ${failed.symbol_id} no longer passes on current main (${feedback.summary}); sent back, the rest merges without it`);
  }

  undoSplit(parent, child, approved, reason) {
    this.store.tx(() => {
      for (const a of approved) {
        this.store.run(`UPDATE attempts SET batch_id = ?, state = 'approved' WHERE id = ?`, parent.id, a.id);
        this.store.run(`UPDATE tasks SET state = 'approved', updated_at = ? WHERE id = ?`, now(), a.task_id);
      }
      this.store.run(`UPDATE batches SET state = 'superseded' WHERE id = ?`, child.id);
    });
    this.noSplit(parent, reason);
  }

  noSplit(batch, reason) {
    // Putting the pending functions back as on main did not work: next round keeps their new code,
    // unannotated (split.js).
    if (!JSON.parse(this.store.get('SELECT result_json FROM batches WHERE id = ?', batch.id).result_json ?? '{}').splitKeepCode) {
      this.store.run(`UPDATE batches SET result_json = json_set(COALESCE(result_json, '{}'), '$.splitKeepCode', json('true')) WHERE id = ?`, batch.id);
      return this.log.info(`batch ${batch.id}: splitting failed (${reason}); next round keeps the pending functions' code without their annotations`);
    }
    this.store.run(`UPDATE batches SET result_json = json_set(COALESCE(result_json, '{}'), '$.noSplit', ?) WHERE id = ?`, reason, batch.id);
    // With a function sent back it can never merge as a whole, so it all goes back.
    if (this.store.get(`SELECT 1 FROM attempts WHERE batch_id = ? AND state IN ('needs_cleanup', 'rejected', 'returned', 'withdrawn', 'superseded')`, batch.id)) {
      returnBatch(this.store, batch.id, `a function of this batch was sent back and the rest cannot be merged without it: ${reason}`);
      return this.log.info(`batch ${batch.id} returned: ${reason}`);
    }
    this.log.info(`batch ${batch.id} waits to merge as a whole: ${reason}`);
  }

  async merge(batch, split = null) {
    clearBuildRetry(this.store, batch.id);
    if (!split) {
      const parentId = JSON.parse(batch.result_json ?? '{}').splitFrom;
      const parent = parentId && this.store.get('SELECT * FROM batches WHERE id = ?', parentId);
      if (parent) split = { parent, parentFiles: JSON.parse(parent.files_json), splitFiles: JSON.parse(batch.files_json) };
    }
    this.store.run(`UPDATE batches SET state = 'merging' WHERE id = ?`, batch.id);
    const attempts = batchAttempts(this.store, batch.id);
    for (const a of attempts) this.store.run(`UPDATE tasks SET state = 'merging', updated_at = ? WHERE id = ?`, now(), a.task_id);
    const author = this.store.get('SELECT name FROM users WHERE id = ?', batch.user_id).name;
    const files = JSON.parse(batch.files_json);

    const bounce = (summary, details) => {
      if (split) {
        // Changing functions that belong to no task of the batch fails the whole submission the
        // same way however its reviews end: only its author can fix that, so it goes back now.
        const parentIds = new Set(batchAttempts(this.store, split.parent.id).map((a) => a.symbol_id));
        const foreign = (details?.feedback?.changedOutside ?? []).filter((o) => !parentIds.has(o.id));
        if (foreign.length) {
          this.undoSplit(split.parent, batch, attempts, summary);
          returnBatch(this.store, split.parent.id, `${summary}; this cannot pass as a whole either: claim those functions or undo the changes, then resubmit`);
          this.log.info(`batch ${split.parent.id} returned: it changes functions outside the batch (${foreign.map((o) => o.id).join(', ')})`);
          return;
        }
        this.undoSplit(split.parent, batch, attempts, summary);
        return;
      }
      this.store.run(`UPDATE batches SET result_json = json_set(COALESCE(result_json, '{}'), '$.mergeFailure', json(?)) WHERE id = ?`, JSON.stringify({ summary, ...details }), batch.id);
      returnBatch(this.store, batch.id, summary);
      this.log.info(`merge of batch ${batch.id} bounced: ${summary}`);
    };
    const startHead = this.repo.head();
    const merged = this.repo.mergeOntoHead(batch.base_commit, files);
    if (merged.conflicts.length) return bounce('conflicts with newer work on main', { conflicts: merged.conflicts });
    const globalErrors = this.verifier.globalsGate(merged.files, startHead);
    if (globalErrors.length) return bounce('global variable rules (see globalErrors)', { globalErrors });

    // Re-verify on top of the current main: other merges may have landed since verification.
    // The code already passed the lint; units unchanged since verification keep its compile.
    const parentId = batch.result_json ? JSON.parse(batch.result_json).splitFrom : null;
    const verifiedBatch = (parentId && this.store.get('SELECT * FROM batches WHERE id = ?', parentId)) || batch;
    const { check, changedHeaders, cacheSnapshot, retryRequired, reused = 0, compiled } = await this.verifier.mergeCheck(batch, merged.files, verifiedBatch);
    const stillEligible = () => this.store.get('SELECT state FROM batches WHERE id = ?', batch.id)?.state === 'merging'
      && attempts.every((a) => this.store.get('SELECT state FROM attempts WHERE id = ?', a.id)?.state === 'approved');
    const obsolete = () => {
      this.store.run(`UPDATE batches SET state = 'open' WHERE id = ? AND state = 'merging'`, batch.id);
      for (const a of attempts) {
        if (this.store.get('SELECT state FROM attempts WHERE id = ?', a.id)?.state === 'approved') {
          this.store.run(`UPDATE tasks SET state = 'approved', updated_at = ? WHERE id = ? AND state = 'merging'`, now(), a.task_id);
        }
      }
      settleBatch(this.store, batch.id, 'its selected functions are no longer eligible to merge');
    };
    const retry = (reason = 'main changed while checking') => {
      if (!stillEligible()) return;
      this.store.run(`UPDATE batches SET state = 'open' WHERE id = ?`, batch.id);
      for (const a of attempts) this.store.run(`UPDATE tasks SET state = 'approved', updated_at = ? WHERE id = ?`, now(), a.task_id);
      this.log.info(`batch ${batch.id}: ${reason}; merging again`);
    };
    if (!stillEligible()) return obsolete();
    const attempted = compiled ?? check.units.length - reused;
    const completed = Math.max(0, check.units.filter((u) => u.compiled && !u.timedOut).length - reused);
    this.log.info(`batch ${batch.id}: merge check reused ${reused} unit(s), attempted ${attempted}, completed ${completed}`);
    if (check.units.some((u) => u.timedOut)) {
      deferBuild(this.store, batch.id, new BuildRetryError(check, 'merge'), { merge: true });
      return;
    }
    if (retryRequired) return retry('main changed before dependency coverage could be rechecked');
    // Another merge may have committed while this one compiled. If it touched anything this check
    // compiled against, the result is stale: back in line, and the next try recompiles that part.
    if (this.repo.head() !== startHead) {
      const changed = new Set(this.repo.git(['diff', '--name-only', startHead, 'HEAD']).split('\n').filter(Boolean));
      const touched = Object.keys(merged.files).some((f) => changed.has(f)) || check.units.some((u) => changed.has(u.file) || (u.includes ?? []).some((h) => changed.has(h)));
      if (touched) {
        return retry();
      }
    }
    const baselineHead = this.repo.head();
    try {
      if (check.units.every((u) => u.compiled)) await this.verifier.refreshBaselines(check, merged.files, `merge-${batch.id}`);
    } catch (e) {
      if (!(e instanceof BuildRetryError)) throw e;
      if (!stillEligible()) return obsolete();
      deferBuild(this.store, batch.id, e, { merge: true });
      return;
    }
    if (!stillEligible()) return obsolete();
    // refreshBaselines can yield and deliberately discards its result when main advances.
    // Never evaluate or commit against that discarded baseline, even for disjoint commits.
    if (this.repo.head() !== baselineHead) return retry();
    // Symbol corrections and target changes need not advance Git. Never commit cached analysis
    // against comparison inputs that changed while compilation or baseline checks were awaiting.
    if (cacheSnapshot && cacheSnapshot.context !== this.verifier.checkSnapshot(merged.files).context) return retry('comparison inputs changed while checking');
    // Unnamed symbols can be registered while compiling without changing compiler analysis.
    // Reconcile their current addresses before any regression/evaluation/commit decision.
    for (const u of check.units) for (const f of u.functions) if (f.comparisonStatus) { f.status = f.comparisonStatus; delete f.conflictedReferences; }
    const rec = reconcile(check, this.store.symbolMap(this.store.currentVersion().id));
    const targets = new Set(attempts.map((a) => a.symbol_id));
    // The batch a split part came from holds the other functions of these files (still in review,
    // their source put back as on main); shared changes in the file may change their compiled code.
    // That is not a change to functions someone else holds; their status is measured again.
    if (parentId) for (const a of batchAttempts(this.store, parentId)) targets.add(a.symbol_id);
    const outside = this.verifier.changedOutside(check, merged.files, targets, batch.user_id, this.verifier.ownUnitsOf(attempts));
    const confirmedIds = new Set();
    const results = [];
    const allowRegressions = attempts.some((a) => a.regressions_accepted);
    for (const a of attempts) {
      const ev = this.verifier.evaluate({ check, rec, targetId: a.symbol_id, files: merged.files, changedHeaders, outside, allowRegressions });
      // Byte-identical, or confirmed by peers and approved by a human; anything worse bounces.
      const identical = ev.state === 'approved' || ev.state === 'in_review';
      const peerConfirmed = ev.state === 'peer_review' && this.peers?.confirmed(a.id);
      if (!identical && !peerConfirmed) {
        // Code that builds but no longer passes (main changed beneath it): only this function goes
        // back to its author; the rest of the batch merges without it on the next round.
        // Changed functions someone else holds is about the whole submission, not this function:
        // sending back one at a time would drain the batch with the same reason every round.
        const builds = !ev.feedback.compileErrors?.length && ev.feedback.summary !== 'compilation failed';
        if (builds && attempts.length > 1 && !ev.feedback.changedOutside) return this.sendBackOne(batch, attempts, a, ev.feedback, split);
        return bounce(`re-verification on current main failed for ${a.symbol_id}: ${ev.feedback.summary}`, { feedback: ev.feedback });
      }
      if (peerConfirmed) confirmedIds.add(a.symbol_id);
      results.push({ id: a.symbol_id, name: ev.feedback.target?.demangled ?? null, status: ev.feedback.target?.status, peerConfirmed: !!peerConfirmed });
    }

    const reviewers = this.store.all(
      `SELECT DISTINCT u.name FROM reviews r JOIN users u ON u.id = r.reviewer_id JOIN attempts a ON a.id = r.attempt_id WHERE a.batch_id = ? AND r.action = 'approve'`,
      batch.id,
    ).map((r) => r.name);
    const peers = this.store.all(
      `SELECT DISTINCT u.name FROM peer_reviews p JOIN users u ON u.id = p.reviewer_id JOIN attempts a ON a.id = p.attempt_id WHERE a.batch_id = ? AND p.verdict = 'same'`,
      batch.id,
    ).map((r) => r.name);
    const identicalCount = results.filter((r) => !r.peerConfirmed).length;
    const head = this.repo.head();
    const change = (id) => this.codeChange(id, merged.files, head);
    // Code that was already on main and is only confirmed now (often ported before the migration)
    // is not a decompilation; the diff then shows only what else the batch changed.
    const verb = results.every((r) => change(r.id) === ' (already on main)') ? 'Confirm' : 'Decompile';
    const title =
      results.length === 1
        ? `${verb} ${results[0].id}${results[0].name ? ` (${results[0].name})` : ''}`
        : `${verb} ${results.length} functions in ${[...new Set(Object.keys(files))].slice(0, 2).join(', ')}${Object.keys(files).length > 2 ? ', ...' : ''}`;
    const lines = results.map((r) => `- ${r.id}${r.name ? ` ${r.name}` : ''}: ${r.peerConfirmed ? 'logic confirmed by peer review' : 'byte-identical'}${change(r.id)}`);
    const message =
      `${title}\n\nBatch #${batch.id} by ${author}: ${identicalCount} byte-identical, ${results.length - identicalCount} confirmed by peer review.\n\n${lines.join('\n')}\n` +
      (peers.length ? `\nPeer-reviewed-by: ${peers.join(', ')}` : '') +
      (reviewers.length ? `\nReviewed-by: ${reviewers.join(', ')}` : '') +
      (!reviewers.length && !confirmedIds.size ? '\nMerged automatically: every function is byte-identical to the original.' : '') +
      (!reviewers.length && confirmedIds.size ? `\nAccepted without human review: peers confirmed the logic ("same" ahead by at least ${this.peers?.margin ?? 3}, with ${Math.round((this.peers?.acceptShare ?? 0.7) * 100)}% of the votes).` : '') +
      '\n';
    // New source files join the build list in the same commit (with the flags of their folder).
    const listFile = this.project.compileCommands ?? null;
    const grown = listFile ? addUnitsToCompileCommands(this.project, this.repo.show(head, listFile), Object.keys(merged.files)) : null;
    const filesToCommit = grown ? { ...merged.files, [listFile]: grown.text } : merged.files;
    const commit = this.repo.commitFiles(filesToCommit, grown ? `${message}Adds to the build: ${grown.added.join(', ')}\n` : message, `${author} <${author.replace(/[^A-Za-z0-9_.-]/g, '_')}@users.clank-together.invalid>`);
    if (grown) this.project.compile.units = grown.units;

    this.store.tx(() => {
      this.applyCheckToDatabase(check, rec, commit, batch.user_id, { confirmedIds });
      for (const a of attempts) {
        this.store.run(`UPDATE attempts SET state = 'merged', merged_commit = ? WHERE id = ?`, commit, a.id);
        this.store.run(`UPDATE tasks SET state = 'done', lease_user = NULL, updated_at = ? WHERE id = ?`, now(), a.task_id);
        retireSentBack(this.store, a.task_id, `${a.symbol_id} was merged by batch ${batch.id} (${commit.slice(0, 10)}); this attempt is no longer needed`);
      }
      this.store.run(`UPDATE batches SET state = 'merged', merged_commit = ? WHERE id = ?`, commit, batch.id);
      this.store.run('DELETE FROM batch_checks WHERE batch_id = ?', batch.id);
      // Merged although a peer said "different": kept for a human to look at later.
      for (const a of attempts) {
        const objections = this.store.get(`SELECT COUNT(*) AS n FROM peer_reviews WHERE attempt_id = ? AND verdict = 'different'`, a.id).n;
        if (objections) {
          this.store.run('INSERT INTO later_review (symbol_id, attempt_id, merged_commit, objections, created_at) VALUES (?, ?, ?, ?, ?)', a.symbol_id, a.id, commit, objections, now());
        }
      }
      this.store.event('merged', batch.user_id, { batch: batch.id, functions: attempts.length, commit });
      this.supersedeCompetitors(attempts, batch.id, commit);
      if (split) {
        this.rebaseRemainder(split, merged.files, commit);
        settleBatch(this.store, split.parent.id, 'its approved functions merged; the others were sent back');
      }
    });
    this.afterCommit(commit);
    this.log.info(`merged batch ${batch.id} (${attempts.length} functions) as ${commit.slice(0, 10)}`);
  }

  /** What follows every commit to main: new tasks, the push to the mirror, listeners. */
  afterCommit(commit) {
    this.tasks.generate();
    this.store.recordMatch(commit);
    if (this.config.pushRemote) {
      try {
        this.repo.push(this.config.pushRemote);
      } catch (e) {
        this.log.error(`push to ${this.config.pushRemote} failed: ${e.message}`);
      }
    }
    this.store.setMeta('repository_project_head', commit);
    this.onMerged?.(commit);
  }

  /**
   * Other candidates of the functions that just merged (region claims let several agents submit
   * one function): they are superseded, and the rest of their batches goes on without them.
   */
  supersedeCompetitors(merged, batchId, commit) {
    const batches = new Set();
    for (const a of merged) {
      const losers = this.store.all(
        `SELECT id, batch_id FROM attempts WHERE task_id = ? AND id != ? AND state IN ('queued', 'verifying', 'peer_review', 'in_review', 'approved')`,
        a.task_id,
        a.id,
      );
      for (const l of losers) {
        const feedback = { summary: `another candidate for ${a.symbol_id} was accepted and merged first (batch ${batchId}, ${commit.slice(0, 10)}); this one is no longer needed` };
        this.store.run(`UPDATE attempts SET state = 'superseded', finished_at = ?, result_json = json_set(COALESCE(result_json, '{}'), '$.feedback', json_patch(COALESCE(json_extract(result_json, '$.feedback'), '{}'), json(?))) WHERE id = ?`, now(), JSON.stringify(feedback), l.id);
        this.store.run('DELETE FROM peer_leases WHERE attempt_id = ?', l.id);
        if (l.batch_id) batches.add(l.batch_id);
      }
    }
    for (const b of batches) settleBatch(this.store, b, 'its other functions were merged from competing submissions');
  }

  /**
   * What a merge changes about one function's source, for the commit message: an annotation on
   * code that was already there (an identical copy, or code marked INLINED) shows up in the diff
   * as one line, and a function that was already right as none.
   */
  codeChange(id, files, head) {
    const strip = (text) => text.split('\n').filter((l) => !/^\s*\/\/\s*(FUNCTION|STUB|INLINED)\b/.test(l)).join('\n');
    const body = (t, r) => t.split('\n').slice(r.start, r.end).join('\n');
    for (const [file, text] of Object.entries(files)) {
      const now = functionRegions(text)?.get(id);
      if (!now) continue;
      const before = this.repo.show(head, file);
      const old = before === null ? null : functionRegions(before)?.get(id);
      if (old && body(before, old) === body(text, now)) return ' (already on main)';
      // Same body as an existing definition, only annotated now.
      if (before !== null && strip(before).includes(strip(body(text, now)))) return ' (annotation added to existing code)';
      return '';
    }
    return '';
  }

  /**
   * After the approved part of a batch merged, the rest of the batch is based on that commit:
   * its files become the merged files plus the still-pending functions.
   */
  rebaseRemainder({ parent, parentFiles, splitFiles }, mergedFiles, commit) {
    const files = {};
    for (const [file, full] of Object.entries(parentFiles)) {
      const rebased = this.repo.merge3(mergedFiles[file], splitFiles[file], full);
      // A conflict here surfaces again when the rest merges, and goes back to its author then.
      if (rebased === null) return this.log.error(`batch ${parent.id}: could not rebase ${file} onto ${commit.slice(0, 10)}`);
      files[file] = rebased;
    }
    this.store.run('UPDATE batches SET files_json = ?, base_commit = ? WHERE id = ?', JSON.stringify(files), commit, parent.id);
  }

  /**
   * Records what a check on main learned: per-function status, decorated
   * names and new symbols for previously unknown references.
   */
  applyCheckToDatabase(check, rec, commit, userId, { confirmedIds = new Set() } = {}) {
    const v = this.store.currentVersion();
    const pe = this.getPe();
    for (const u of check.units) {
      if (u.compiled && u.includes) {
        this.store.run('DELETE FROM unit_deps WHERE unit = ?', u.file);
        for (const h of u.includes) this.store.run('INSERT OR IGNORE INTO unit_deps (unit, header) VALUES (?, ?)', u.file, h);
      }
      for (const [decorated, id] of Object.entries(u.bindings)) {
        // A renamed function or global keeps its ID: main's code now uses the new name.
        const owner = this.store.get('SELECT id FROM symbols WHERE decorated = ?', decorated)?.id;
        const old = this.store.get('SELECT decorated FROM symbols WHERE id = ?', id)?.decorated ?? null;
        if (old === decorated || (owner && owner !== id)) continue;
        this.store.run('UPDATE symbols SET decorated = ? WHERE id = ?', decorated, id);
        if (old) this.store.event('symbol_renamed', userId, { id, old, decorated, commit });
      }
    }
    const compiledUnits = new Set(check.units.filter((u) => u.compiled).map((u) => u.file));
    const addressOf = boundAddresses(check, this.store.symbolMap(v.id));
    for (const [id, { f, unit }] of bestResults(check)) {
      // A status measured in a unit this check did not compile is not lowered from a partial view.
      const old = this.store.get('SELECT status, file FROM func_status WHERE symbol_id = ?', id);
      if (old && !compiledUnits.has(old.file) && RANK[old.status] > RANK[f.status]) continue;
      this.store.run(
        `INSERT INTO func_status (symbol_id, file, status, score, commit_hash, updated_at, confirmed, code_hash, reloc_only, effective_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol_id) DO UPDATE SET file = excluded.file, status = excluded.status, score = excluded.score, commit_hash = excluded.commit_hash, updated_at = excluded.updated_at, code_hash = COALESCE(excluded.code_hash, func_status.code_hash), reloc_only = excluded.reloc_only, effective_hash = COALESCE(excluded.effective_hash, func_status.effective_hash),
           confirmed = CASE WHEN excluded.confirmed = 1 THEN 1 WHEN excluded.status IN ('exact', 'match_unresolved') THEN 0 WHEN func_status.status IN ('exact', 'match_unresolved') THEN 1 ELSE func_status.confirmed END`,
        f.id, unit, f.status, f.score, commit, now(), confirmedIds.has(f.id) ? 1 : 0, f.codeHash ?? null, relocOnly(f) ? 1 : 0, resolvedEffectiveHash(f, addressOf),
      );
      if (f.demangled) this.store.run('UPDATE symbols SET name = ? WHERE id = ? AND name IS NULL', f.demangled, f.id);
      this.store.run('UPDATE symbols SET unit = ? WHERE id = ? AND unit IS NULL', unit, f.id);
      if (f.status === STATUS.EXACT || f.status === STATUS.UNRESOLVED) {
        const finished = this.store.all(`SELECT id FROM tasks WHERE symbol_id = ? AND state IN ('open', 'needs_cleanup', 'hard')`, f.id);
        this.store.run(`UPDATE tasks SET state = 'done', updated_at = ? WHERE symbol_id = ? AND state IN ('open', 'needs_cleanup', 'hard')`, now(), f.id);
        for (const t of finished) retireSentBack(this.store, t.id, `${f.id} matches on main as of ${commit.slice(0, 10)}; this attempt is no longer needed`);
      }
    }
    this.clearRemovedStatuses(check, commit, userId);
    for (const l of rec.learned) this.store.run('UPDATE symbols SET decorated = ? WHERE id = ? AND decorated IS NULL', l.decorated, l.id);
    // Addresses in the current version found through matching code that references the symbol.
    for (const l of rec.learnedAddresses ?? []) {
      const taken = this.store.get('SELECT 1 FROM symbol_addresses WHERE version_id = ? AND addr = ?', v.id, l.addr);
      if (!taken) {
        this.store.run('INSERT OR IGNORE INTO symbol_addresses (symbol_id, version_id, addr) VALUES (?, ?, ?)', l.id, v.id, l.addr);
        this.store.event('address_learned', userId, { id: l.id, version: v.id, addr: l.addr });
      }
    }
    // EH handlers, unwind funclets and deleting destructors are made by the compiler from the
    // function that uses them: a symbol for one would be a task nobody can port.
    for (const u of rec.unknown.filter((x) => !isCompilerGenerated(x.decorated))) {
      const kind = u.decorated.startsWith('??_C@') ? 'string' : u.decorated.startsWith('??_7') ? 'vtable' : pe.isCode(u.addr) ? 'function' : 'global';
      const { symbol } = this.store.ensureSymbol({ kind, versionId: v.id, addr: u.addr, userId });
      this.store.run('UPDATE symbols SET decorated = ? WHERE id = ? AND decorated IS NULL', u.decorated, symbol.id);
    }
  }

  /**
   * A function main no longer has keeps no status. Candidates are functions recorded at a unit this
   * check compiled cleanly that the unit no longer emits, or at a file `commit` no longer has; one
   * goes only when no file at `commit` annotates it any more (an inline header copy now emitted
   * elsewhere, or code in an included .inl, stays). Its done task reopens: the work is no longer on
   * main. Skipped, held or waiting tasks keep their state.
   */
  clearRemovedStatuses(check, commit, userId) {
    const emitted = new Set(bestResults(check).keys());
    const candidates = new Set();
    for (const u of check.units) {
      if (!u.compiled || u.timedOut) continue;
      for (const r of this.store.all('SELECT symbol_id FROM func_status WHERE file = ?', u.file)) {
        if (!emitted.has(r.symbol_id)) candidates.add(r.symbol_id);
      }
    }
    let tracked;
    try {
      tracked = new Set(this.repo.trackedPaths(commit));
    } catch (e) {
      this.log.error?.(`clearing removed statuses at ${commit.slice(0, 10)}: ${e.message}`);
      return [];
    }
    for (const r of this.store.all('SELECT symbol_id, file FROM func_status')) {
      if (!tracked.has(r.file)) candidates.add(r.symbol_id);
    }
    if (!candidates.size) return [];
    const args = ['grep', '-h', '-o', '-E'];
    // No \b: not every regex library git links supports it, and a pattern that never matches would
    // read as "annotated nowhere".
    for (const id of candidates) args.push('-e', `(FUNCTION|STUB): ${id}([^0-9]|$)`);
    let annotated = '';
    try {
      annotated = this.repo.git([...args, commit, '--']);
    } catch (e) {
      // Exit 1 with no output is "no match"; anything else is a failure, and an unknown answer
      // must never read as "nothing annotated": keep every status.
      if (e.status !== 1 || `${e.stderr ?? ''}`.trim()) {
        this.log.error?.(`clearing removed statuses at ${commit.slice(0, 10)}: ${e.message}`);
        return [];
      }
    }
    const still = new Set(annotated.match(/fn_\d+/g) ?? []);
    const cleared = [];
    for (const id of candidates) {
      if (still.has(id)) continue;
      const old = this.store.get('SELECT file, status, score, confirmed FROM func_status WHERE symbol_id = ?', id);
      this.store.run('DELETE FROM func_status WHERE symbol_id = ?', id);
      const reopened = Number(this.store.run(`UPDATE tasks SET state = 'open', updated_at = ? WHERE symbol_id = ? AND state = 'done'`, now(), id).changes) > 0;
      this.store.event('status_cleared', userId, { id, commit, old, reopened });
      cleared.push(id);
    }
    return cleared;
  }
}
