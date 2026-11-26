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
import { isUnit, addUnitsToCompileCommands, removeUnitsFromCompileCommands, movedUnits, withMovedUnits } from '../shared/project.js';
import { bestResults, BuildRetryError, deferBuild, clearBuildRetry, boundAddresses } from './verify.js';
import { resolvedEffectiveHash, resolvedEffectiveParts, hashEffectiveParts } from '../shared/compare.js';
import { foldedErrors } from '../shared/folded.js';

/**
 * A unit's unbound file-local statics are named after its object (Dir/Unit.obj|kSecret): main's
 * function `f` of a moved unit, with those references read under the object path it has now.
 * @param {Map<string,string>} moves  new path -> old path
 */
export function withMovedObjects(f, moves) {
  const parts = f?.effectiveParts;
  if (!parts || !moves.size) return f;
  const objOf = (file) => file.replace(/\.[^./\\]+$/, '') + '.obj';
  const renamed = [...moves].map(([to, from]) => [`${objOf(from)}|`, `${objOf(to)}|`]);
  const rename = (s) => {
    for (const [a, b] of renamed) if (s.includes(a)) return s.split(a).join(b);
    return s;
  };
  const effective = parts.effective.map(rename);
  if (effective.every((s, i) => s === parts.effective[i])) return f;
  const unresolvedRefs = parts.unresolvedRefs.map((u) => ({ ...u, name: rename(u.name) }));
  const relocations = f.relocations?.map((r) => (typeof r.symbol === 'string' ? { ...r, symbol: rename(r.symbol) } : r));
  return { ...f, ...(relocations && { relocations }), effectiveHash: hashEffectiveParts({ bytesHash: parts.bytesHash, effective }), effectiveParts: { ...parts, effective, unresolvedRefs } };
}

/**
 * The identifier a linker name spells, without its linkage: `?Load@@YAXXZ` and `??$Load@H@@YAXXZ`
 * (C++), `_Load`, `_Load@4` and `@Load@4` (x86 C, stdcall, fastcall) are all `Load`.
 */
export function plainIdentifier(name) {
  const cpp = /^\?(?:\?\$)?([A-Za-z_]\w*)@/.exec(name);
  if (cpp) return cpp[1];
  const c = /^[_@]([A-Za-z_]\w*?)(?:@\d+)?$/.exec(name);
  return c ? c[1] : null;
}

export class Maintenance {
  constructor({ store, repo, project, verifier, merger, log = console }) {
    Object.assign(this, { store, repo, project, verifier, merger, log });
  }

  /** Queues a maintenance batch; it is verified and merged by run(). An admin may force it past the
   * score and changed-code gates (every other gate still runs); the merge records that it was forced. */
  submit(user, { baseCommit, files, notes = null, force = false }) {
    if (!hasRole(user, 'maintainer')) throw new HttpError(403, 'maintenance batches require the maintainer role');
    if (force && !hasRole(user, 'admin')) throw new HttpError(403, 'only admins can force a maintenance batch');
    if (!Object.keys(files).length) throw new HttpError(400, 'files must not be empty');
    const r = this.store.run(
      `INSERT INTO batches (user_id, token_id, base_commit, files_json, notes, state, kind, created_at, result_json) VALUES (?, ?, ?, ?, ?, 'queued', 'maintenance', ?, ?)`,
      user.id, user.tokenId ?? null, baseCommit, JSON.stringify(files), notes, now(), force ? JSON.stringify({ forced: true }) : null,
    );
    const batchId = Number(r.lastInsertRowid);
    this.store.event('maintenance_submit', user.id, { batch: batchId, files: Object.keys(files).length, ...(force && { forced: true }) });
    return { batchId, state: 'queued', ...(force && { forced: true }) };
  }

  /** Verifies and, when nothing compiled changes, merges one maintenance batch the pump took. */
  async run(batchId) {
    const batch = this.store.get(`SELECT * FROM batches WHERE id = ? AND kind = 'maintenance'`, batchId);
    if (!batch || batch.state !== 'verifying') return;
    clearBuildRetry(this.store, batch.id);
    try {
      const outcome = await this.verifyAndMerge(batch);
      if (this.cancelled(batch.id)) return { state: 'returned' };
      if (outcome.state === 'queued') {
        this.store.run(`UPDATE batches SET state = 'queued' WHERE id = ? AND state = 'verifying'`, batch.id);
        return outcome;
      }
      this.store.run(`UPDATE batches SET state = ?, finished_at = ?, result_json = ?, merged_commit = ? WHERE id = ? AND state = 'verifying'`, outcome.state, now(), JSON.stringify(outcome.result), outcome.commit ?? null, batch.id);
      return outcome;
    } catch (e) {
      if (e instanceof BuildRetryError) {
        deferBuild(this.store, batch.id, e);
        return { state: 'queued', result: { buildRetry: e.diagnostic } };
      }
      this.log.error(`maintenance batch ${batch.id}: ${e.stack}`);
      if (this.cancelled(batch.id)) return { state: 'returned' };
      this.store.run(`UPDATE batches SET state = 'returned', finished_at = ?, result_json = ? WHERE id = ? AND state = 'verifying'`, now(), JSON.stringify({ returned: 'internal error; a maintainer has been notified' }), batch.id);
      return { state: 'returned' };
    }
  }

  async verifyAndMerge(batch) {
    // The verifier pump synchronized the repository at the idle cohort boundary, before this
    // batch entered a lane. Never fetch here: another batch may already be compiling.
    const files = JSON.parse(batch.files_json);
    const back = (returned, details = {}) => ({ state: 'returned', result: { returned, ...details } });
    const sourceDir = this.project.sourceDirs[0];
    const lintErrors = lintSubmission(files, {
      allowedPaths: [`${sourceDir}/**`, ...this.project.headerGlobs],
      limits: this.project.lintLimits,
      allowedPragmas: this.project.allowedPragmas,
      baseSize: (f) => this.repo.size('HEAD', f),
      trackedPaths: this.repo.trackedPaths('HEAD'),
      allowDeletions: true,
      unitPrelude: this.project.unitPrelude,
      baseText: (f) => this.repo.show('HEAD', f),
    });
    if (lintErrors.length) return back('rejected by the static gate', { lintErrors });
    if (!this.repo.isAncestor(batch.base_commit)) return back(`base commit ${batch.base_commit} is not part of main; sync and resubmit`);
    const textErrors = this.verifier.freeTextGate(files, batch.base_commit);
    if (textErrors.length) return back('the submission adds comments or strings that are not allowed', { lintErrors: textErrors });
    const dropped = this.verifier.droppedAnnotations(files, batch.base_commit, [], batch.user_id);
    if (dropped.length) return back(`removes the annotation of ${dropped.join(', ')}: a maintenance batch keeps every function annotated`, { droppedAnnotations: dropped });
    const undefinedNames = this.verifier.undefinedGate(files, batch.base_commit);
    if (undefinedNames.length) return back(`declares functions that are defined nowhere: ${undefinedNames.join(', ')}`, { undefinedFunctions: undefinedNames });

    const startHead = this.repo.head();
    const merged = this.repo.mergeOntoHead(batch.base_commit, files);
    if (merged.conflicts.length) return back('conflicts with newer work on main; sync, merge and resubmit', { conflicts: merged.conflicts });
    const globalErrors = this.verifier.globalsGate(merged.files, startHead);
    if (globalErrors.length) return back('global variable rules (see globalErrors)', { globalErrors });

    // A moved unit (deleted here, added under another folder with the same file name) compiles with
    // the shape it had, not the one its new folder would infer: listed under its new path while this
    // batch is checked, and written to the build list with it on merge.
    const moves = movedUnits(this.project.compile?.units, merged.files);
    const listedBefore = this.project.compile?.units;
    const movedListing = moves.size ? withMovedUnits(listedBefore, moves) : null;
    if (moves.size) this.project.compile.units = movedListing;
    let checked;
    try {
      // Every unit the change can affect: the submitted ones, and every includer of a changed header.
      checked = await this.verifier.check(merged.files, `maintenance-${batch.id}`, { dependents: true });
    } finally {
      if (moves.size) this.project.compile.units = listedBefore;
    }
    const { check, rec, changedHeaders, cacheSnapshot } = checked;
    if (check.units.some((u) => u.timedOut)) throw new BuildRetryError(check, 'maintenance');
    const failed = check.units.filter((u) => !u.compiled);
    if (failed.length) return back('compilation failed', { compileErrors: failed.map((u) => ({ file: u.file, log: u.log })) });
    const fileSet = new Set(Object.keys(merged.files));
    const annErrors = [...check.annotationErrors.filter((e) => fileSet.has(e.file) && e.severity !== 'warning'), ...foldedErrors(check, fileSet)];
    if (annErrors.length) return back('annotation errors', { annotationErrors: annErrors });
    const lint = check.units.flatMap((u) => u.lintErrors);
    if (lint.length) return back('banned constructs found after preprocessing', { lintErrors: lint });
    await this.verifier.refreshBaselines(check, merged.files, `maintenance-${batch.id}`);
    const forced = JSON.parse(batch.result_json ?? '{}').forced === true;
    const staleCheck = () => {
      if (moves.size) this.project.compile.units = movedListing;
      try {
        return this.repo.head() !== startHead || this.verifier.inputsChanged(check, cacheSnapshot, merged.files);
      } finally {
        if (moves.size) this.project.compile.units = listedBefore;
      }
    };
    const requeue = () => ({ state: 'queued', result: { note: 'main or comparison inputs changed while verifying; checking again', ...(forced && { forced: true }) } });
    if (staleCheck()) return requeue();
    const regressions = this.verifier.regressions(check, merged.files, moves);
    if (regressions.length && !forced) return back(`breaks ${regressions.length} function(s) that matched before`, { regressions });
    const changed = await this.changedFunctions(check, merged.files, startHead, moves);
    if (staleCheck()) return requeue();
    if (changed.length && !forced) {
      return back(`changes the compiled code of ${changed.length} function(s): that is function work; submit those functions with their tasks`, { changedFunctions: changed.slice(0, 200) });
    }
    // Cancelled by its author while it compiled: nothing is committed.
    if (this.cancelled(batch.id)) return { state: 'returned', result: { returned: 'cancelled' } };

    // Commit like any merge; new units join the build list in the same commit.
    const author = this.store.get('SELECT name FROM users WHERE id = ?', batch.user_id).name;
    const listFile = this.project.compileCommands ?? null;
    const deletedUnits = Object.keys(merged.files).filter((f) => isUnit(f) && merged.files[f] === null);
    const shrunk = listFile && deletedUnits.length ? removeUnitsFromCompileCommands(this.project, this.repo.show(startHead, listFile), deletedUnits) : null;
    const movedShapes = new Map([...moves].map(([to, from]) => [to, listedBefore[from]]));
    const grown = listFile ? addUnitsToCompileCommands(this.project, shrunk?.text ?? this.repo.show(startHead, listFile), Object.keys(merged.files).filter((f) => isUnit(f) && merged.files[f] !== null), movedShapes) : null;
    const listed = grown ?? shrunk;
    const filesToCommit = listed ? { ...merged.files, [listFile]: listed.text } : merged.files;
    const summary = String(batch.notes ?? '').split('\n')[0].slice(0, 120) || `${Object.keys(files).length} file(s)`;
    const message =
      `Maintenance: ${summary}\n\nBatch #${batch.id} by ${author}: ${forced ? `forced by an admin (${regressions.length} lower score(s), ${changed.length} changed function(s))` : "no function's compiled code changes"}; checked with ${check.units.length} compiled unit(s)` +
      `${changedHeaders.length ? `, including every includer of ${changedHeaders.join(', ')}` : ''}.\n${grown ? `Adds to the build: ${grown.added.join(', ')}\n` : ''}` +
      `${Object.values(merged.files).some((c) => c === null) ? `Deletes: ${Object.keys(merged.files).filter((f) => merged.files[f] === null).join(', ')}\n` : ''}`;
    const commit = this.repo.commitFiles(filesToCommit, message, `${author} <${author.replace(/[^A-Za-z0-9_.-]/g, '_')}@users.clank-together.invalid>`);
    if (listed) this.project.compile.units = listed.units;
    for (const unit of deletedUnits) this.store.run('DELETE FROM unit_deps WHERE unit = ?', unit);
    // A moved unit takes what is recorded under its old path along: the functions that belong to it
    // (their tasks and regions follow symbols.unit) and file region claims.
    this.store.tx(() => {
      for (const [to, from] of moves) {
        this.store.run('UPDATE symbols SET unit = ? WHERE unit = ?', to, from);
        this.store.run(`UPDATE OR IGNORE region_claims SET key = ? WHERE kind = 'unit' AND key = ?`, to, from);
        this.store.run(`DELETE FROM region_claims WHERE kind = 'unit' AND key = ?`, from);
      }
      this.merger.applyCheckToDatabase(check, rec, commit, batch.user_id, { comparisonVersion: cacheSnapshot?.version });
    });
    if (moves.size) this.store.event('units_moved', batch.user_id, { batch: batch.id, moves: Object.fromEntries(moves) });
    if (forced) this.store.event('maintenance_forced', batch.user_id, { batch: batch.id, commit, regressions: regressions.map((r) => r.id), changed: changed.map((c) => c.id ?? c) });
    this.merger.afterCommit(commit);
    this.log.info(`merged maintenance batch ${batch.id} as ${commit.slice(0, 10)}${forced ? ' (forced)' : ''}`);
    return { state: 'merged', commit, result: { units: check.units.length, changedHeaders, ...(forced && { forced: true, regressions, changedFunctions: changed.slice(0, 200) }) } };
  }

  /** Whether the batch was cancelled (td cancel) while it was being verified. */
  cancelled(batchId) {
    return this.store.get('SELECT state FROM batches WHERE id = ?', batchId)?.state !== 'verifying';
  }

  /**
   * Functions whose code, once linked, differs from main's. Main's units that the change touches
   * are compiled as main has them, and every function is compared on where its references land
   * (effectiveHash): moving a global, renaming it, or reaching a member through its object's symbol
   * changes names, not code.
   */
  async changedFunctions(check, files, head, moves = new Map()) {
    // Main's version of every unit the change compiled; a moved unit is compared with its old path.
    const onMain = this.repo.showMany(head, [...new Set(check.units.map((u) => moves.get(u.file) ?? u.file))]);
    const touched = [...onMain].filter(([, text]) => text !== null).map(([f]) => f);
    const before = touched.length ? (await this.verifier.check({}, `maintenance-base-${head.slice(0, 10)}`, { onlyUnits: touched, lint: false })).check : { units: [] };
    if (before.units.some((u) => !u.compiled || u.timedOut)) throw new BuildRetryError(before, 'maintenance-baseline');
    const was = new Map([...bestResults(before)].map(([id, b]) => [id, b.f]));
    // A reference is compared by the address it reaches: a function the change renames is bound
    // under its new name here and its old one on main, which is the same code. Two kinds of names
    // have no binding: the function's own helpers (its __ehhandler$<name>, local statics, lambdas),
    // which count as reaching where the original points from that reference; and a declared-only
    // callee, placed at the function the database knows by that plain name, or by the address a
    // placeholder name (sub_6468C0) spells.
    const symbols = this.store.symbolMap(this.store.currentVersion().id);
    const addressNow = boundAddresses(check, symbols);
    const addressBefore = boundAddresses(before, symbols);
    const byName = new Map();
    const starts = new Set();
    for (const s of symbols.values()) {
      if (s.addr == null || s.kind !== 'function') continue;
      starts.add(s.addr);
      if (s.name && !byName.has(s.name)) byName.set(s.name, s.addr);
    }
    const plain = (name) => /^\?([A-Za-z_]\w*)@@/.exec(name)?.[1];
    const callee = (name) => {
      const p = plain(name);
      if (!p) return null;
      if (byName.has(p)) return byName.get(p);
      const placeholder = /^sub_([0-9A-F]{6,8})$/.exec(p);
      const at = placeholder ? Number.parseInt(placeholder[1], 16) : null;
      return at != null && starts.has(at) ? at : null;
    };
    const own = (f, name) => {
      if (!f.symbol || name === f.symbol) return false;
      // Compiler helpers spelled after the function itself: __ehhandler$<symbol> and
      // __unwindfunclet$<symbol>$N, and its local statics, lambdas and their std::function vtables,
      // whose names nest the function's symbol after a scope marker (`@?1??Name@Class@@...`).
      return name.includes(`$${f.symbol}`) || name.includes(`?${f.symbol}`);
    };
    const original = (f, name) => f.relocations?.find((r) => r.symbol === name && r.actual != null)?.actual ?? null;
    // A function-local static (a thread_local or static variable, its init guard `?$TSS0@`/`?$S1@`,
    // its dynamic-initializer and atexit thunks `??__J`/`??__F`) is named after the scope it is
    // declared in (`...@?1??Scope@@...`). Moving the declaration into another scope (a helper's body
    // into a lambda at the call site) renames it with the same code: it counts as reaching where the
    // original points from that reference, on main's side as on this one. Only data: a lambda or a
    // vtable renamed this way is other code and still compared by name.
    const localStatic = (name) => /^(?:\?\$S\d+@|\?\$TSS\d+@|\?\?__[JF])/.test(name) || /^\?[A-Za-z_]\w*@\?\d+\?\?.*@4.*A$/.test(name);
    const local = (f, name) => (localStatic(name) ? original(f, name) : null);
    const byDecorated = new Map();
    for (const s of symbols.values()) if (s.addr != null && s.decorated && !byDecorated.has(s.decorated)) byDecorated.set(s.decorated, s.addr);
    // A helper named after a renamed function is main's helper under the old spelling: it reaches
    // what the database places under that spelling, as it did on main.
    const helper = (f, old, name) => {
      if (!own(f, name)) return null;
      if (old && old.symbol !== f.symbol) {
        const at = byDecorated.get(name.split(f.symbol).join(old.symbol));
        if (at != null) return at;
      }
      return original(f, name);
    };
    // A moved unit's file-local statics are keyed by object path (Dir/Unit.obj|name, in the database
    // and in the bindings): until this merge renames them, they resolve under the old path.
    const objOf = (file) => file.replace(/\.[^./\\]+$/, '') + '.obj';
    const oldKey = new Map([...moves].map(([to, from]) => [`${objOf(to)}|`, `${objOf(from)}|`]));
    const byOldObject = (name) => {
      for (const [now, was] of oldKey) if (name.startsWith(now)) return addressBefore(was + name.slice(now.length)) ?? byDecorated.get(was + name.slice(now.length)) ?? null;
      return null;
    };
    const effective = (f, bound, old) => resolvedEffectiveHash(f, (name) => bound(name) ?? byOldObject(name) ?? helper(f, old, name) ?? local(f, name) ?? callee(name));
    // Neither side's name is known anywhere, yet both spell the same identifier and reach the same
    // place in the original: the same function under another linkage spelling (a declaration
    // moved out of an `extern "C"` block names `?_Traits_compare@...` instead of `__Traits_compare`).
    const respelled = (old, f) => {
      const was = resolvedEffectiveParts(old, (name) => addressBefore(name) ?? helper(old, null, name) ?? callee(name));
      const is = resolvedEffectiveParts(f, (name) => addressNow(name) ?? helper(f, old, name) ?? callee(name));
      if (!was || !is || was.bytesHash !== is.bytesHash || was.effective.length !== is.effective.length) return false;
      let renamed = 0;
      for (let i = 0; i < is.effective.length; i++) {
        if (was.effective[i] === is.effective[i]) continue;
        const a = was.unresolved.get(i), b = is.unresolved.get(i);
        if (a == null || b == null || plainIdentifier(a) == null || plainIdentifier(a) !== plainIdentifier(b)) return false;
        const at = Number(is.effective[i].split(':')[0]);
        const reaches = (fn, name) => fn.relocations?.find((r) => r.offset === at && r.symbol === name)?.actual ?? null;
        const target = reaches(old, a);
        if (target == null || target !== reaches(f, b)) return false;
        is.effective[i] = was.effective[i];
        renamed++;
      }
      return renamed > 0 && hashEffectiveParts(was) === hashEffectiveParts(is);
    };
    const out = [];
    for (const [id, { f, unit }] of bestResults(check)) {
      const old = withMovedObjects(was.get(id), moves);
      if (!old) {
        out.push({ id, file: unit, why: 'not compiled on main' });
        continue;
      }
      if (effective(old, addressBefore) !== effective(f, addressNow, old) && !respelled(old, f)) out.push({ id, file: unit, why: 'compiled code changed' });
    }
    return out;
  }
}
