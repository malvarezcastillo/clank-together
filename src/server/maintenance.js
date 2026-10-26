// Maintenance batches: structural changes to the source that belong to no function task (moving
// a global to its owner, fixing annotations or provenance on data, adding a header). Only
// maintainers submit them. They go through the same gates as function work (static gate, free
// text, dropped annotations, undefined declarations, a compile of every unit the change can
// affect) and merge only when no function's compiled code changes: a change to compiled code is
// function work and needs its task. The merge records what it compiled, like any other merge.

import { HttpError } from './http.js';
import { now } from './db.js';
import { hasRole } from './accounts.js';
import { lintSubmission } from '../shared/lint.js';
import { isUnit, addUnitsToCompileCommands } from '../shared/project.js';
import { bestResults } from './verify.js';

export class Maintenance {
  constructor({ store, repo, project, verifier, merger, log = console }) {
    Object.assign(this, { store, repo, project, verifier, merger, log });
  }

  /** Queues a maintenance batch; it is verified and merged by run(). */
  submit(user, { baseCommit, files, notes = null }) {
    if (!hasRole(user, 'maintainer')) throw new HttpError(403, 'maintenance batches require the maintainer role');
    if (!Object.keys(files).length) throw new HttpError(400, 'files must not be empty');
    const r = this.store.run(
      `INSERT INTO batches (user_id, token_id, base_commit, files_json, notes, state, kind, created_at) VALUES (?, ?, ?, ?, ?, 'queued', 'maintenance', ?)`,
      user.id, user.tokenId ?? null, baseCommit, JSON.stringify(files), notes, now(),
    );
    const batchId = Number(r.lastInsertRowid);
    this.store.event('maintenance_submit', user.id, { batch: batchId, files: Object.keys(files).length });
    return { batchId, state: 'queued' };
  }

  /** Verifies and, when nothing compiled changes, merges one maintenance batch the pump took. */
  async run(batchId) {
    const batch = this.store.get(`SELECT * FROM batches WHERE id = ? AND kind = 'maintenance'`, batchId);
    if (!batch || batch.state !== 'verifying') return;
    try {
      const outcome = await this.verifyAndMerge(batch);
      if (outcome.state === 'queued') {
        this.store.run(`UPDATE batches SET state = 'queued' WHERE id = ?`, batch.id);
        return outcome;
      }
      this.store.run(`UPDATE batches SET state = ?, finished_at = ?, result_json = ?, merged_commit = ? WHERE id = ?`, outcome.state, now(), JSON.stringify(outcome.result), outcome.commit ?? null, batch.id);
      return outcome;
    } catch (e) {
      this.log.error(`maintenance batch ${batch.id}: ${e.stack}`);
      this.store.run(`UPDATE batches SET state = 'returned', finished_at = ?, result_json = ? WHERE id = ?`, now(), JSON.stringify({ returned: 'internal error; a maintainer has been notified' }), batch.id);
      return { state: 'returned' };
    }
  }

  async verifyAndMerge(batch) {
    const files = JSON.parse(batch.files_json);
    const back = (returned, details = {}) => ({ state: 'returned', result: { returned, ...details } });
    const sourceDir = this.project.sourceDirs[0];
    const lintErrors = lintSubmission(files, {
      allowedPaths: [`${sourceDir}/**`, ...this.project.headerGlobs],
      limits: this.project.lintLimits,
      allowedPragmas: this.project.allowedPragmas,
      baseSize: (f) => this.repo.size('HEAD', f),
    });
    if (lintErrors.length) return back('rejected by the static gate', { lintErrors });
    if (!this.repo.isAncestor(batch.base_commit)) return back(`base commit ${batch.base_commit} is not part of main; sync and resubmit`);
    const textErrors = this.verifier.freeTextGate(files, batch.base_commit);
    if (textErrors.length) return back('the submission adds comments or strings that are not allowed', { lintErrors: textErrors });
    const dropped = this.verifier.droppedAnnotations(files, batch.base_commit, [], batch.user_id);
    if (dropped.length) return back(`removes the annotation of ${dropped.join(', ')}: a maintenance batch keeps every function annotated`, { droppedAnnotations: dropped });
    const undefinedNames = this.verifier.undefinedGate(files, batch.base_commit);
    if (undefinedNames.length) return back(`declares functions that are defined nowhere: ${undefinedNames.join(', ')}`, { undefinedFunctions: undefinedNames });
    const gateErrors = this.verifier.globalsGate?.(files, batch.base_commit) ?? [];
    if (gateErrors.length) return back('global variable rules (see globalErrors)', { globalErrors: gateErrors });

    const startHead = this.repo.head();
    const merged = this.repo.mergeOntoHead(batch.base_commit, files);
    if (merged.conflicts.length) return back('conflicts with newer work on main; sync, merge and resubmit', { conflicts: merged.conflicts });

    // Every unit the change can affect: the submitted ones, and every includer of a changed header.
    const { check, rec, changedHeaders } = await this.verifier.check(merged.files, `maintenance-${batch.id}`, { dependents: true });
    const failed = check.units.filter((u) => !u.compiled);
    if (failed.length) return back('compilation failed', { compileErrors: failed.map((u) => ({ file: u.file, log: u.log })) });
    const fileSet = new Set(Object.keys(merged.files));
    const annErrors = check.annotationErrors.filter((e) => fileSet.has(e.file) && e.severity !== 'warning');
    if (annErrors.length) return back('annotation errors', { annotationErrors: annErrors });
    const lint = check.units.flatMap((u) => u.lintErrors);
    if (lint.length) return back('banned constructs found after preprocessing', { lintErrors: lint });
    await this.verifier.refreshBaselines(check, merged.files, `maintenance-${batch.id}`);
    const regressions = this.verifier.regressions(check, merged.files);
    if (regressions.length) return back(`breaks ${regressions.length} function(s) that matched before`, { regressions });
    const changed = this.changedFunctions(check);
    if (changed.length) {
      return back(`changes the compiled code of ${changed.length} function(s): that is function work; submit those functions with their tasks`, { changedFunctions: changed.slice(0, 200) });
    }

    // Another merge committed while this one compiled: check again on the new main.
    if (this.repo.head() !== startHead) return { state: 'queued', result: { note: 'main moved while verifying; checking again' } };

    // Commit like any merge; new units join the build list in the same commit.
    const author = this.store.get('SELECT name FROM users WHERE id = ?', batch.user_id).name;
    const listFile = this.project.compileCommands ?? null;
    const grown = listFile ? addUnitsToCompileCommands(this.project, this.repo.show(startHead, listFile), Object.keys(merged.files).filter(isUnit)) : null;
    const filesToCommit = grown ? { ...merged.files, [listFile]: grown.text } : merged.files;
    const summary = String(batch.notes ?? '').split('\n')[0].slice(0, 120) || `${Object.keys(files).length} file(s)`;
    const message =
      `Maintenance: ${summary}\n\nBatch #${batch.id} by ${author}: no function's compiled code changes; checked with ${check.units.length} compiled unit(s)` +
      `${changedHeaders.length ? `, including every includer of ${changedHeaders.join(', ')}` : ''}.\n${grown ? `Adds to the build: ${grown.added.join(', ')}\n` : ''}`;
    const commit = this.repo.commitFiles(filesToCommit, message, `${author} <${author.replace(/[^A-Za-z0-9_.-]/g, '_')}@users.clank-together.invalid>`);
    if (grown) this.project.compile.units = grown.units;
    this.store.tx(() => this.merger.applyCheckToDatabase(check, rec, commit, batch.user_id));
    this.merger.afterCommit(commit);
    this.log.info(`merged maintenance batch ${batch.id} as ${commit.slice(0, 10)}`);
    return { state: 'merged', commit, result: { units: check.units.length, changedHeaders } };
  }

  /** Functions whose compiled code differs from what main recorded for them. */
  changedFunctions(check) {
    const out = [];
    for (const [id, { f, unit }] of bestResults(check)) {
      const main = this.store.get('SELECT code_hash, status, score FROM func_status WHERE symbol_id = ?', id);
      if (!main) {
        if (f.codeHash) out.push({ id, file: unit, why: 'not compiled on main before' });
        continue;
      }
      if (main.code_hash && f.codeHash && main.code_hash !== f.codeHash) out.push({ id, file: unit, why: 'compiled code changed' });
    }
    return out;
  }
}
