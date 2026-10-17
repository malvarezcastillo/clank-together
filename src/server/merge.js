// Human review decisions and the serialized merge queue.

import { HttpError } from './http.js';
import { now } from './db.js';
import { hasRole } from './accounts.js';
import { STATUS } from '../shared/compare.js';

export class Merger {
  constructor({ store, config, repo, project, tasks, verifier, getPe, peers, log = console }) {
    Object.assign(this, { store, config, repo, project, tasks, verifier, getPe, peers, log });
    this.busy = false;
  }

  start() {
    this.store.run(`UPDATE tasks SET state = 'approved' WHERE state = 'merging'`);
    this.timer = setInterval(() => this.pump(), 3000);
  }

  stop() {
    clearInterval(this.timer);
  }

  requiredApprovals(attempt) {
    const result = attempt.result_json ? JSON.parse(attempt.result_json) : {};
    const p = this.project.matchPolicy;
    return result.changedHeaders?.length ? p.approvalsWithHeaderChanges : p.approvals;
  }

  review(reviewer, attemptId, action, comment) {
    if (!hasRole(reviewer, 'reviewer')) throw new HttpError(403, 'only reviewers can review');
    if (!['approve', 'request_changes', 'reject'].includes(action)) throw new HttpError(400, 'invalid action');
    return this.store.tx(() => {
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
      return { state: newState };
    });
  }

  async pump() {
    if (this.busy) return;
    const task = this.store.get(`SELECT * FROM tasks WHERE state = 'approved' ORDER BY updated_at LIMIT 1`);
    if (!task) return;
    this.busy = true;
    try {
      await this.merge(task);
    } catch (e) {
      this.log.error(`merge of task ${task.id} failed: ${e.stack}`);
      try {
        this.repo.reset();
      } catch {}
      this.store.run(`UPDATE tasks SET state = 'in_review', updated_at = ? WHERE id = ?`, now(), task.id);
      this.store.event('merge_error', null, { task: task.id, error: e.message });
    } finally {
      this.busy = false;
    }
  }

  async merge(task) {
    this.store.run(`UPDATE tasks SET state = 'merging', updated_at = ? WHERE id = ?`, now(), task.id);
    const attempt = this.store.get(`SELECT * FROM attempts WHERE task_id = ? AND state = 'approved' ORDER BY id DESC LIMIT 1`, task.id);
    const author = this.store.get('SELECT name FROM users WHERE id = ?', attempt.user_id).name;
    const files = JSON.parse(attempt.files_json);

    const merged = this.repo.mergeOntoHead(attempt.base_commit, files);
    const bounce = (summary, details) => {
      this.store.run(`UPDATE attempts SET state = 'needs_cleanup', result_json = json_set(COALESCE(result_json, '{}'), '$.mergeFailure', json(?)) WHERE id = ?`, JSON.stringify({ summary, ...details }), attempt.id);
      this.store.run(`UPDATE tasks SET state = 'needs_cleanup', preferred_user = ?, preferred_until = ?, updated_at = ? WHERE id = ?`, attempt.user_id, now() + 6 * 3600_000, now(), task.id);
      this.log.info(`merge of task ${task.id} bounced: ${summary}`);
    };
    if (merged.conflicts.length) return bounce('conflicts with newer work on main', { conflicts: merged.conflicts });

    // Re-verify on top of the current main: other merges may have landed since review.
    const { check, rec } = await this.verifier.check(merged.files, `merge-${attempt.id}`);
    const evaln = this.verifier.evaluate({ check, rec, targetId: task.symbol_id, files: merged.files, changedHeaders: Object.keys(merged.files).filter((f) => !/\.(c|cpp|cc|cxx)$/i.test(f)) });
    // Not byte-identical is fine if other agents confirmed the logic; anything worse bounces.
    const peerConfirmed = evaln.state === 'peer_review' && this.peers?.confirmed(attempt.id);
    if (evaln.state !== 'in_review' && !peerConfirmed) return bounce(`re-verification on current main failed: ${evaln.feedback.summary}`, { feedback: evaln.feedback });

    const reviewers = this.store.all(`SELECT u.name FROM reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.attempt_id = ? AND r.action = 'approve'`, attempt.id).map((r) => r.name);
    const target = evaln.feedback.target;
    const message = `Decompile ${task.symbol_id}${target?.demangled ? ` (${target.demangled})` : ''}\n\nAttempt #${attempt.id} by ${author}, status ${target?.status}.\nReviewed-by: ${reviewers.join(', ')}\n`;
    const commit = this.repo.commitFiles(merged.files, message, `${author} <${author.replace(/[^A-Za-z0-9_.-]/g, '_')}@users.clank-together.invalid>`);

    this.store.tx(() => {
      this.applyCheckToDatabase(check, rec, commit, attempt.user_id, { confirmedId: peerConfirmed ? task.symbol_id : null });
      this.store.run(`UPDATE attempts SET state = 'merged', merged_commit = ? WHERE id = ?`, commit, attempt.id);
      this.store.run(`UPDATE tasks SET state = 'done', lease_user = NULL, updated_at = ? WHERE id = ?`, now(), task.id);
      this.store.event('merged', attempt.user_id, { task: task.id, attempt: attempt.id, commit });
    });
    this.tasks.generate();
    if (this.config.pushRemote) {
      try {
        this.repo.push(this.config.pushRemote);
      } catch (e) {
        this.log.error(`push to ${this.config.pushRemote} failed: ${e.message}`);
      }
    }
    this.log.info(`merged task ${task.id} as ${commit.slice(0, 10)}`);
  }

  /**
   * Records what a check on main learned: per-function status, decorated
   * names and new symbols for previously unknown references.
   */
  applyCheckToDatabase(check, rec, commit, userId, { confirmedId = null } = {}) {
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
          `INSERT INTO func_status (symbol_id, file, status, score, commit_hash, updated_at, confirmed) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(symbol_id) DO UPDATE SET file = excluded.file, status = excluded.status, score = excluded.score, commit_hash = excluded.commit_hash, updated_at = excluded.updated_at,
             confirmed = CASE WHEN excluded.confirmed = 1 THEN 1 WHEN excluded.status IN ('exact', 'match_unresolved') THEN 0 ELSE func_status.confirmed END`,
          f.id, u.file, f.status, f.score, commit, now(), f.id === confirmedId ? 1 : 0,
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
