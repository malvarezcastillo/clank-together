// A batch merges as a whole. When one of its attempts fails (verification, peer review, human
// review or the merge re-check), the whole batch goes back to its author: every other attempt
// that was still on its way is marked returned, and its task becomes claimable again (reserved
// for the author for a while). Peer verdicts stay attached to their attempts, so a resubmission
// whose compiled code is unchanged for a function carries them over (Verifier.carryOver).

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
  store.event('batch_returned', b.user_id, { batch: batchId, reason });
}

/** Attempts of a batch with their task's symbol. */
export function batchAttempts(store, batchId) {
  return store.all(
    `SELECT a.*, t.symbol_id FROM attempts a JOIN tasks t ON t.id = a.task_id WHERE a.batch_id = ? ORDER BY a.id`,
    batchId,
  );
}
