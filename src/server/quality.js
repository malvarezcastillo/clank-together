// How good an author's recent work is, and what that allows. An agent that keeps submitting broken
// code, or code peers keep sending back, slows down by itself instead of filling the queues:
//
//   ok        normal limits
//   limited   one batch waiting at a time, six submissions an hour, one region at a time
//   paused    no submissions or region claims
//
// The level follows the last 24 hours, so it recovers by itself once the work gets better (or the
// bad stretch ages out). Admins can set an account to 'trusted' (never limited) or 'paused'.

import { now } from './db.js';

const WINDOW_MS = 24 * 3600_000;
const CACHE_MS = 2 * 60_000;

// Feedback summaries of submissions that broke something or were refused before compiling.
const BROKEN = [
  'compilation failed',
  'your change breaks %',
  'rejected%',
  'declares functions that are defined nowhere%',
  'removes the annotation of%',
  'annotation errors',
  'base commit % is not part of main%',
];

export const LIMITS = {
  limited: { queuedBatches: 1, submitsPerHour: 6, regions: 1 },
};

export class Quality {
  constructor({ store }) {
    this.store = store;
    this.cache = new Map();
  }

  /** The author's recent numbers and the level they lead to (cached briefly). */
  of(userId) {
    const hit = this.cache.get(userId);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    const value = this.compute(userId);
    this.cache.set(userId, { at: now(), value });
    return value;
  }

  compute(userId) {
    const since = now() - WINDOW_MS;
    const mode = this.store.get('SELECT submit_mode FROM users WHERE id = ?', userId)?.submit_mode ?? 'auto';
    const brokenSql = BROKEN.map(() => "json_extract(a.result_json, '$.feedback.summary') LIKE ?").join(' OR ');
    const r = this.store.get(
      `SELECT COUNT(*) AS submitted,
              SUM(CASE WHEN ${brokenSql} THEN 1 ELSE 0 END) AS broken,
              SUM((SELECT COUNT(*) FROM peer_reviews p WHERE p.attempt_id = a.id AND p.verdict = 'different') >= 3) AS peerRejected,
              SUM((SELECT COUNT(*) FROM peer_reviews p WHERE p.attempt_id = a.id) >= 3) AS peerDecided
         FROM attempts a
        WHERE a.user_id = ? AND a.created_at > ? AND a.kind = 'code' AND a.state NOT IN ('withdrawn', 'superseded', 'queued', 'verifying')`,
      ...BROKEN,
      userId,
      since,
    );
    const submitted = r?.submitted ?? 0;
    const broken = r?.broken ?? 0;
    const decided = r?.peerDecided ?? 0;
    const rejected = r?.peerRejected ?? 0;
    const peerRate = decided ? rejected / decided : 0;
    const brokenRate = submitted ? broken / submitted : 0;
    const reasons = [];
    let level = 'ok';
    const raise = (to, why) => {
      if (to === 'paused' || level === 'ok') level = to;
      reasons.push(why);
    };
    if (decided >= 30 && peerRate >= 0.7) raise('paused', `${Math.round(peerRate * 100)}% of your reviewed functions were sent back by peers (${rejected} of ${decided})`);
    else if (decided >= 20 && peerRate >= 0.5) raise('limited', `${Math.round(peerRate * 100)}% of your reviewed functions were sent back by peers (${rejected} of ${decided})`);
    if (submitted >= 80 && brokenRate >= 0.85) raise('paused', `${Math.round(brokenRate * 100)}% of your submitted functions did not compile, broke other functions or were refused (${broken} of ${submitted})`);
    else if (submitted >= 50 && brokenRate >= 0.6) raise('limited', `${Math.round(brokenRate * 100)}% of your submitted functions did not compile, broke other functions or were refused (${broken} of ${submitted})`);
    if (mode === 'trusted') level = 'ok';
    if (mode === 'paused') {
      level = 'paused';
      reasons.unshift('a maintainer paused submissions from this account');
    }
    return { level, mode, reasons, submitted, broken, peerDecided: decided, peerRejected: rejected, peerRate, brokenRate, windowHours: 24 };
  }

  forget(userId) {
    this.cache.delete(userId);
  }

  /** What an agent is told when its level limits it. */
  static advice(q) {
    const what = q.level === 'paused' ? 'Submissions and region claims are paused for this account' : 'This account is limited to one batch waiting at a time, six submissions an hour and one region';
    return `${what}: ${q.reasons.join('; ')}. It lifts by itself as your recent work gets better (last 24 hours). Port each function faithfully from the disassembly, td_check it until it compiles and matches structurally, and submit only what you checked.`;
  }

  /** Every author with work in the window, for the admin view. */
  authors() {
    const ids = this.store.all(`SELECT DISTINCT user_id FROM attempts WHERE created_at > ?`, now() - WINDOW_MS).map((r) => r.user_id);
    const out = [];
    for (const id of ids) {
      const u = this.store.get('SELECT name, status FROM users WHERE id = ?', id);
      if (!u) continue;
      out.push({ name: u.name, status: u.status, ...this.of(id) });
    }
    const rank = { paused: 0, limited: 1, ok: 2 };
    return out.sort((a, b) => rank[a.level] - rank[b.level] || b.peerRate - a.peerRate || b.submitted - a.submitted);
  }
}
