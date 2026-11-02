// When verification or the merge re-check fails, the whole batch goes back to its author: every
// attempt that was still on its way is marked returned, and its task becomes claimable again
// (reserved for the author for a while). Peer verdicts stay attached to their attempts, so a
// resubmission whose compiled code is unchanged for a function carries them over
// (Verifier.carryOver). A peer or human verdict against one function sends back only that
// function; the rest of the batch goes on, and its approved part merges without it (merge.js).

import { now } from './db.js';

export function returnBatch(store, batchId, reason) {
  if (!batchId) return;
  const b = store.get('SELECT * FROM batches WHERE id = ?', batchId);
  if (!b || ['merged', 'returned', 'superseded'].includes(b.state)) return;
  const pending = store.all(`SELECT * FROM attempts WHERE batch_id = ? AND state IN ('queued', 'verifying', 'in_review', 'peer_review', 'approved')`, batchId);
  for (const a of pending) {
    store.run(`UPDATE attempts SET state = 'returned', result_json = json_set(COALESCE(result_json, '{}'), '$.returned', ?) WHERE id = ?`, reason, a.id);
    store.run('DELETE FROM peer_leases WHERE attempt_id = ?', a.id);
    store.run(
      `UPDATE tasks SET state = 'needs_cleanup', preferred_user = ?, preferred_until = ?, updated_at = ? WHERE id = ? AND state IN ('verifying', 'in_review', 'peer_review', 'approved', 'merging')`,
      a.user_id, now() + 6 * 3600_000, now(), a.task_id,
    );
  }
  store.run(`UPDATE batches SET state = 'returned', result_json = json_set(COALESCE(result_json, '{}'), '$.returned', ?) WHERE id = ?`, reason, batchId);
  dropMergeData(store, batchId);
  store.event('batch_returned', b.user_id, { batch: batchId, reason });
}

// What only a merge needs (the verification's compile, the merged files): a returned batch never
// merges, and with a header change it can be hundreds of megabytes.
export function dropMergeData(store, batchId) {
  store.run('DELETE FROM batch_checks WHERE batch_id = ?', batchId);
  store.run(`UPDATE batches SET result_json = json_remove(result_json, '$.check', '$.mergedFiles') WHERE id = ? AND json_valid(result_json)`, batchId);
}

// Attempts still on their way to main; the others were sent back or rejected.
export const LIVE_STATES = ['queued', 'verifying', 'peer_review', 'in_review', 'approved', 'merging'];

/** Ends a batch whose functions were all sent back or rejected. */
export function settleBatch(store, batchId, reason) {
  if (!batchId) return;
  const ph = LIVE_STATES.map(() => '?').join(',');
  if (store.get(`SELECT 1 FROM attempts WHERE batch_id = ? AND state IN (${ph})`, batchId, ...LIVE_STATES)) return;
  const r = store.run(`UPDATE batches SET state = 'returned', result_json = json_set(COALESCE(result_json, '{}'), '$.returned', ?) WHERE id = ? AND state = 'open'`, reason, batchId);
  if (r.changes) dropMergeData(store, batchId);
}

/**
 * Older attempts that were sent back stop asking for work once their function is finished
 * (merged, matched on main or accepted as needing no source): they become superseded, keeping their
 * feedback, reasons and peer verdicts. `$.retired` keeps the state they came back in (quality and
 * statistics still count them as such) and `$.retiredBecause` says what finished the function.
 */
export function retireSentBack(store, taskId, why) {
  store.run(
    `UPDATE attempts SET state = 'superseded', finished_at = COALESCE(finished_at, ?),
            result_json = json_set(COALESCE(result_json, '{}'), '$.retired', state, '$.retiredBecause', ?)
      WHERE task_id = ? AND state IN ('needs_cleanup', 'returned')
        AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = attempts.task_id AND t.state IN ('done', 'skipped'))`,
    now(), why, taskId,
  );
}

/** SQL for attempt `alias`: superseded only because its function was later finished by another attempt. */
export const RETIRED = (alias) => `json_extract(${alias}.result_json, '$.retired') IS NOT NULL`;

/** Attempts of a batch with their task's symbol. */
export function batchAttempts(store, batchId) {
  return store.all(
    `SELECT a.*, t.symbol_id FROM attempts a JOIN tasks t ON t.id = a.task_id WHERE a.batch_id = ? ORDER BY a.id`,
    batchId,
  );
}
