// Human review decisions and the serialized merge queue.

import { HttpError } from './http.js';
import { now } from './db.js';
import { hasRole } from './accounts.js';
import { STATUS } from '../shared/compare.js';
import { returnBatch, batchAttempts } from './batches.js';

export class Merger {
  constructor({ store, config, repo, project, tasks, verifier, getPe, peers, log = console }) {
    Object.assign(this, { store, config, repo, project, tasks, verifier, getPe, peers, log });
    this.busy = false;
  }

  start() {
    this.store.run(`UPDATE batches SET state = 'open' WHERE state = 'merging'`);
    this.store.run(`UPDATE tasks SET state = 'approved' WHERE state = 'merging'`);
    this.timer = setInterval(() => this.pump(), 3000);
  }

  stop() {
    clearInterval(this.timer);
  }

  requiredApprovals(attempt) {
    const batch = attempt.batch_id ? this.store.get('SELECT result_json FROM batches WHERE id = ?', attempt.batch_id) : null;
    const result = batch?.result_json ? JSON.parse(batch.result_json) : {};
    const p = this.project.matchPolicy;
    return result.changedHeaders?.length ? p.approvalsWithHeaderChanges : p.approvals;
  }

  /** A human decision on one attempt (peer-confirmed, not byte-identical). */
  review(reviewer, attemptId, action, comment) {
    if (!hasRole(reviewer, 'reviewer')) throw new HttpError(403, 'only reviewers can review');
    if (!['approve', 'request_changes', 'reject'].includes(action)) throw new HttpError(400, 'invalid action');
    return this.store.tx(() => this.reviewOne(reviewer, attemptId, action, comment));
  }

  /** The same decision for every attempt of a batch that waits for human review. */
  reviewBatch(reviewer, batchId, action, comment) {
    if (!hasRole(reviewer, 'reviewer')) throw new HttpError(403, 'only reviewers can review');
    if (!['approve', 'request_changes', 'reject'].includes(action)) throw new HttpError(400, 'invalid action');
    return this.store.tx(() => {
      const waiting = this.store.all(`SELECT id FROM attempts WHERE batch_id = ? AND state = 'in_review'`, batchId);
      if (!waiting.length) throw new HttpError(409, 'nothing in this batch waits for human review');
      const results = waiting.map((w) => ({ attemptId: w.id, ...this.reviewOne(reviewer, w.id, action, comment) }));
      return { batchId, results };
    });
  }

  reviewOne(reviewer, attemptId, action, comment) {
    const attempt = this.store.get('SELECT * FROM attempts WHERE id = ?', attemptId);
    if (!attempt) throw new HttpError(404, 'no such attempt');
    if (attempt.state !== 'in_review') throw new HttpError(409, `attempt is ${attempt.state}`);
    if (attempt.user_id === reviewer.id) throw new HttpError(403, 'you cannot review your own attempt');
    if (this.store.get('SELECT 1 FROM reviews WHERE attempt_id = ? AND reviewer_id = ?', attemptId, reviewer.id)) throw new HttpError(409, 'you already reviewed this attempt');

    this.store.run('INSERT INTO reviews (attempt_id, reviewer_id, action, comment, created_at) VALUES (?, ?, ?, ?, ?)', attemptId, reviewer.id, action, comment?.slice(0, 4000) ?? null, now());
    this.store.event('review', reviewer.id, { attempt: attemptId, action });

    if (action === 'approve') {
      const approvals = this.store.get(`SELECT COUNT(*) AS n FROM reviews WHERE attempt_id = ? AND action = 'approve'`, attemptId).n;
      const needed = this.requiredApprovals(attempt) - approvals;
      if (hasRole(reviewer, 'maintainer') || needed <= 0) {
        this.store.run(`UPDATE attempts SET state = 'approved' WHERE id = ?`, attemptId);
        this.store.run(`UPDATE tasks SET state = 'approved', updated_at = ? WHERE id = ?`, now(), attempt.task_id);
        return { state: 'approved' };
      }
      return { state: 'in_review', approvalsNeeded: needed };
    }
    const newState = action === 'reject' ? 'rejected' : 'needs_cleanup';
    this.store.run('UPDATE attempts SET state = ? WHERE id = ?', newState, attemptId);
    this.store.run(`UPDATE tasks SET state = 'needs_cleanup', preferred_user = ?, preferred_until = ?, updated_at = ? WHERE id = ?`, attempt.user_id, now() + 6 * 3600_000, now(), attempt.task_id);
    returnBatch(this.store, attempt.batch_id, `a reviewer asked for changes to ${attempt.task_id}`);
    return { state: newState };
  }

  /** Merges the oldest open batch whose attempts are all approved. */
  async pump() {
    if (this.busy) return;
    const batch = this.store.get(
      `SELECT b.* FROM batches b WHERE b.state = 'open'
          AND EXISTS (SELECT 1 FROM attempts a WHERE a.batch_id = b.id)
          AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.batch_id = b.id AND a.state != 'approved')
        ORDER BY b.id LIMIT 1`,
    );
    if (!batch) return;
    this.busy = true;
    try {
      await this.merge(batch);
    } catch (e) {
      this.log.error(`merge of batch ${batch.id} failed: ${e.stack}`);
      try {
        this.repo.reset();
      } catch {}
      this.store.run(`UPDATE batches SET state = 'open' WHERE id = ?`, batch.id);
      this.store.event('merge_error', null, { batch: batch.id, error: e.message });
    } finally {
      this.busy = false;
    }
  }

  async merge(batch) {
    this.store.run(`UPDATE batches SET state = 'merging' WHERE id = ?`, batch.id);
    const attempts = batchAttempts(this.store, batch.id);
    for (const a of attempts) this.store.run(`UPDATE tasks SET state = 'merging', updated_at = ? WHERE id = ?`, now(), a.task_id);
    const author = this.store.get('SELECT name FROM users WHERE id = ?', batch.user_id).name;
    const files = JSON.parse(batch.files_json);

    const bounce = (summary, details) => {
      this.store.run(`UPDATE batches SET result_json = json_set(COALESCE(result_json, '{}'), '$.mergeFailure', json(?)) WHERE id = ?`, JSON.stringify({ summary, ...details }), batch.id);
      returnBatch(this.store, batch.id, summary);
      this.log.info(`merge of batch ${batch.id} bounced: ${summary}`);
    };
    const merged = this.repo.mergeOntoHead(batch.base_commit, files);
    if (merged.conflicts.length) return bounce('conflicts with newer work on main', { conflicts: merged.conflicts });

    // Re-verify on top of the current main: other merges may have landed since verification.
    const { check, rec, changedHeaders } = await this.verifier.check(merged.files, `merge-${batch.id}`);
    const targets = new Set(attempts.map((a) => a.symbol_id));
    const outside = this.verifier.changedOutside(check, merged.files, targets);
    const confirmedIds = new Set();
    const results = [];
    for (const a of attempts) {
      const ev = this.verifier.evaluate({ check, rec, targetId: a.symbol_id, files: merged.files, changedHeaders, outside });
      // Byte-identical, or confirmed by peers and approved by a human; anything worse bounces.
      const identical = ev.state === 'approved' || ev.state === 'in_review';
      const peerConfirmed = ev.state === 'peer_review' && this.peers?.confirmed(a.id);
      if (!identical && !peerConfirmed) return bounce(`re-verification on current main failed for ${a.symbol_id}: ${ev.feedback.summary}`, { feedback: ev.feedback });
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
    const title =
      results.length === 1
        ? `Decompile ${results[0].id}${results[0].name ? ` (${results[0].name})` : ''}`
        : `Decompile ${results.length} functions in ${[...new Set(Object.keys(files))].slice(0, 2).join(', ')}${Object.keys(files).length > 2 ? ', ...' : ''}`;
    const lines = results.map((r) => `- ${r.id}${r.name ? ` ${r.name}` : ''}: ${r.peerConfirmed ? 'logic confirmed by peer review' : 'byte-identical'}`);
    const message =
      `${title}\n\nBatch #${batch.id} by ${author}: ${identicalCount} byte-identical, ${results.length - identicalCount} confirmed by peer review.\n\n${lines.join('\n')}\n` +
      (peers.length ? `\nPeer-reviewed-by: ${peers.join(', ')}` : '') +
      (reviewers.length ? `\nReviewed-by: ${reviewers.join(', ')}` : '') +
      (!reviewers.length && !confirmedIds.size ? '\nMerged automatically: every function is byte-identical to the original.' : '') +
      '\n';
    const commit = this.repo.commitFiles(merged.files, message, `${author} <${author.replace(/[^A-Za-z0-9_.-]/g, '_')}@users.clank-together.invalid>`);

    this.store.tx(() => {
      this.applyCheckToDatabase(check, rec, commit, batch.user_id, { confirmedIds });
      for (const a of attempts) {
        this.store.run(`UPDATE attempts SET state = 'merged', merged_commit = ? WHERE id = ?`, commit, a.id);
        this.store.run(`UPDATE tasks SET state = 'done', lease_user = NULL, updated_at = ? WHERE id = ?`, now(), a.task_id);
      }
      this.store.run(`UPDATE batches SET state = 'merged', merged_commit = ? WHERE id = ?`, commit, batch.id);
      this.store.event('merged', batch.user_id, { batch: batch.id, functions: attempts.length, commit });
    });
    this.tasks.generate();
    if (this.config.pushRemote) {
      try {
        this.repo.push(this.config.pushRemote);
      } catch (e) {
        this.log.error(`push to ${this.config.pushRemote} failed: ${e.message}`);
      }
    }
    this.onMerged?.(commit);
    this.log.info(`merged batch ${batch.id} (${attempts.length} functions) as ${commit.slice(0, 10)}`);
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
        this.store.run('UPDATE symbols SET decorated = ? WHERE id = ? AND decorated IS NULL', decorated, id);
      }
      for (const f of u.functions) {
        this.store.run(
          `INSERT INTO func_status (symbol_id, file, status, score, commit_hash, updated_at, confirmed, code_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(symbol_id) DO UPDATE SET file = excluded.file, status = excluded.status, score = excluded.score, commit_hash = excluded.commit_hash, updated_at = excluded.updated_at, code_hash = COALESCE(excluded.code_hash, func_status.code_hash),
             confirmed = CASE WHEN excluded.confirmed = 1 THEN 1 WHEN excluded.status IN ('exact', 'match_unresolved') THEN 0 ELSE func_status.confirmed END`,
          f.id, u.file, f.status, f.score, commit, now(), confirmedIds.has(f.id) ? 1 : 0, f.codeHash ?? null,
        );
        if (f.demangled) this.store.run('UPDATE symbols SET name = ? WHERE id = ? AND name IS NULL', f.demangled, f.id);
        this.store.run('UPDATE symbols SET unit = ? WHERE id = ? AND unit IS NULL', u.file, f.id);
        if (f.status === STATUS.EXACT || f.status === STATUS.UNRESOLVED) {
          this.store.run(`UPDATE tasks SET state = 'done', updated_at = ? WHERE symbol_id = ? AND state IN ('open', 'needs_cleanup', 'hard')`, now(), f.id);
        }
      }
    }
    for (const l of rec.learned) this.store.run('UPDATE symbols SET decorated = ? WHERE id = ? AND decorated IS NULL', l.decorated, l.id);
    // Addresses in the current version found through matching code that references the symbol.
    for (const l of rec.learnedAddresses ?? []) {
      const taken = this.store.get('SELECT 1 FROM symbol_addresses WHERE version_id = ? AND addr = ?', v.id, l.addr);
      if (!taken) {
        this.store.run('INSERT OR IGNORE INTO symbol_addresses (symbol_id, version_id, addr) VALUES (?, ?, ?)', l.id, v.id, l.addr);
        this.store.event('address_learned', userId, { id: l.id, version: v.id, addr: l.addr });
      }
    }
    for (const u of rec.unknown) {
      const kind = u.decorated.startsWith('??_C@') ? 'string' : u.decorated.startsWith('??_7') ? 'vtable' : pe.isCode(u.addr) ? 'function' : 'global';
      const { symbol } = this.store.ensureSymbol({ kind, versionId: v.id, addr: u.addr, userId });
      this.store.run('UPDATE symbols SET decorated = ? WHERE id = ? AND decorated IS NULL', u.decorated, symbol.id);
    }
  }
}
