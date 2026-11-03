// The way to main, function by function: every unfinished function in the stage it is in now, for
// the pipeline board. One snapshot is computed per tick and shared by every viewer; the live socket
// sends only what changed. A function leaves the board once it is merged (done) or skipped.
//
// Stages, left to right:
//   open       nobody holds it                leased     an agent holds it (region claim or fix)
//   queued     submitted, waiting for a lane  compiling  the verifier is building its batch
//   review     waiting for peer/human votes   merging    approved; in or waiting for the merge lane
//   back       sent back to its author (needs_cleanup), or failed too often (hard)
//
// Open functions go out as counts per folder only, and any other column over ROW_CAP as well, so
// the snapshot stays small however many functions the project has.
//
// Maintenance batches carry no function tasks, so they are listed apart (`maintenance`): every
// one that is queued or verifying, oldest first, which is the order the verifier runs them in.

export const STAGES = ['open', 'leased', 'queued', 'compiling', 'review', 'merging', 'back'];
export const ROW_CAP = 2000;

const TASK_STAGE = {
  open: 'open',
  leased: 'leased',
  verifying: 'queued',
  peer_review: 'review',
  in_review: 'review',
  approved: 'merging',
  merging: 'merging',
  needs_cleanup: 'back',
  hard: 'back',
};
const LIVE = Object.keys(TASK_STAGE);

/** The first two folders of a unit (Source/UI/Chat/X.cpp -> Source/UI): the board's grouping key. */
export function folderOf(unit) {
  if (!unit) return '(unplaced)';
  const dirs = unit.split('/').slice(0, -1);
  return dirs.length ? dirs.slice(0, 2).join('/') : unit;
}

/** A submitted task is queued until the verifier picks up its batch. */
export function stageOf(row) {
  const stage = TASK_STAGE[row.state] ?? null;
  return stage === 'queued' && row.batch_state === 'verifying' ? 'compiling' : stage;
}

/** Why a function does not move on, from what the database knows. Null when nothing holds it. */
export function blockerOf(row, ctx) {
  if (row.stage === 'back') {
    if (row.state === 'hard') return { kind: 'hard' };
    if (row.preferred_until > ctx.now) return { kind: 'reserved', until: row.preferred_until };
    return null;
  }
  if (row.stage === 'queued') {
    if (row.build_retry_at > ctx.now) return { kind: 'retry', until: row.build_retry_at };
    if (ctx.maintenance && row.batch_id !== ctx.maintenance) return { kind: 'maintenance', batch: ctx.maintenance };
  }
  return null;
}

/** Maintenance batches still on their way to main, oldest first. */
export function maintenanceOf(store, progress) {
  return store.all(
    `SELECT b.id, b.state, b.created_at, b.files_json, b.notes, u.name AS author
       FROM batches b LEFT JOIN users u ON u.id = b.user_id
      WHERE b.kind = 'maintenance' AND b.state IN ('queued', 'verifying')
      ORDER BY b.id`,
  ).map((b) => {
    const build = progress.get(b.id);
    return {
      batch: b.id,
      state: b.state,
      since: b.created_at,
      who: b.author ?? null,
      files: Object.keys(JSON.parse(b.files_json || '{}')).length,
      title: (b.notes ?? '').split('\n')[0].slice(0, 160) || null,
      build: build ? { done: build.done, total: build.total } : null,
    };
  });
}

/** The board, for signed-in viewers. `builds` is compileProgress() of the job folders. */
export function snapshot(store, { builds = [], now = Date.now(), cap = ROW_CAP } = {}) {
  builds = builds.filter((b) => b.active && b.lane !== 'check');
  const ph = LIVE.map(() => '?').join(',');
  const rows = store.all(
    `SELECT t.id AS task, t.symbol_id AS symbol, t.state, t.updated_at, t.preferred_until, t.cleanup_cycles,
            s.name, s.unit, lu.name AS holder,
            a.created_at AS submitted_at, json_extract(a.result_json, '$.feedback.summary') AS summary,
            b.id AS batch_id, b.state AS batch_state, au.name AS author,
            json_extract(b.result_json, '$.buildRetry.retryAt') AS build_retry_at,
            (SELECT COALESCE(SUM(CASE WHEN p.verdict = 'same' THEN p.weight END), 0) FROM peer_reviews p WHERE p.attempt_id = a.id) AS same,
            (SELECT COALESCE(SUM(CASE WHEN p.verdict = 'different' THEN p.weight END), 0) FROM peer_reviews p WHERE p.attempt_id = a.id) AS different
       FROM tasks t JOIN symbols s ON s.id = t.symbol_id
       LEFT JOIN users lu ON lu.id = t.lease_user
       LEFT JOIN attempts a ON a.id = (SELECT MAX(x.id) FROM attempts x WHERE x.task_id = t.id)
       LEFT JOIN batches b ON b.id = a.batch_id
       LEFT JOIN users au ON au.id = a.user_id
      WHERE t.state IN (${ph})`,
    ...LIVE,
  );
  const maintenance = store.get(`SELECT id FROM batches WHERE kind = 'maintenance' AND state = 'verifying' ORDER BY id LIMIT 1`)?.id ?? null;
  const ctx = { now, maintenance };
  const progress = new Map(builds.filter((b) => b.batch !== null && ['verify', 'merge', 'maintenance'].includes(b.lane)).map((b) => [b.batch, b]));

  const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  const folders = Object.fromEntries(STAGES.map((s) => [s, {}]));
  const byStage = Object.fromEntries(STAGES.map((s) => [s, []]));
  for (const r of rows) {
    const stage = stageOf(r);
    if (!stage) continue;
    r.stage = stage;
    counts[stage]++;
    const folder = folderOf(r.unit);
    folders[stage][folder] = (folders[stage][folder] ?? 0) + 1;
    if (stage === 'open') continue;
    const submitted = stage !== 'leased' && stage !== 'back';
    const build = submitted && r.batch_id ? progress.get(r.batch_id) : null;
    byStage[stage].push({
      task: r.task,
      symbol: r.symbol,
      name: r.name ?? null,
      folder,
      stage,
      since: submitted ? r.submitted_at ?? r.updated_at : r.updated_at,
      batch: submitted ? r.batch_id ?? null : null,
      who: (stage === 'leased' ? r.holder : r.author) ?? null,
      votes: stage === 'review' ? { same: r.same, different: r.different } : null,
      build: build ? { done: build.done, total: build.total } : null,
      why: stage === 'back' ? r.summary ?? null : null,
      cycles: r.cleanup_cycles,
      blocker: blockerOf(r, ctx),
    });
  }

  const overflow = STAGES.filter((s) => s === 'open' || byStage[s].length > cap);
  const functions = STAGES.filter((s) => !overflow.includes(s))
    .flatMap((s) => byStage[s])
    .sort((a, b) => a.since - b.since || a.task - b.task);
  return {
    at: now,
    counts,
    folders,
    overflow,
    functions,
    maintenance: maintenanceOf(store, progress),
    builds: builds.map((b) => ({
      job: b.job, lane: b.lane, batch: b.batch, done: b.done, total: b.total, startedAt: b.startedAt,
      author: b.batch === null ? null : store.get('SELECT u.name FROM batches x JOIN users u ON u.id = x.user_id WHERE x.id = ?', b.batch)?.name ?? null,
    })),
  };
}

/**
 * What changed between two snapshots: functions that appeared, moved or changed (`upsert`), those
 * that left the board (`remove`: merged, skipped or released back to open), and the small parts
 * sent whole. Null when nothing changed.
 */
export function diff(before, after) {
  const old = new Map((before?.functions ?? []).map((f) => [f.task, JSON.stringify(f)]));
  const upsert = [];
  const seen = new Set();
  for (const f of after.functions) {
    seen.add(f.task);
    if (old.get(f.task) !== JSON.stringify(f)) upsert.push(f);
  }
  const remove = [...old.keys()].filter((t) => !seen.has(t));
  const same = (k) => JSON.stringify(before?.[k]) === JSON.stringify(after[k]);
  if (!upsert.length && !remove.length && ['counts', 'folders', 'builds', 'overflow', 'maintenance'].every(same)) return null;
  return { at: after.at, upsert, remove, counts: after.counts, folders: after.folders, overflow: after.overflow, maintenance: after.maintenance, builds: after.builds };
}
