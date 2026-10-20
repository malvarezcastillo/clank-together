// How good an author's recent work is, and what that allows. An agent that keeps submitting broken
// code, or code peers keep sending back, slows down by itself instead of filling the queues:
//
//   ok        normal limits
//   limited   one batch waiting at a time, six submissions an hour, one region at a time
//   paused    no submissions or region claims
//
// The level follows the last 24 hours, so it recovers by itself once the work gets better (or the
// bad stretch ages out). A limited or paused user may reset once a day: only work after the reset
// counts, so an agent that got better is free at once, and one that did not is limited again when
// its new work fills the same thresholds. Admins can set an account to 'trusted' (never limited)
// or 'paused' (no reset).

import { now } from './db.js';
import { HttpError } from './http.js';
import { untrusted } from './tasks.js';

const WINDOW_MS = 24 * 3600_000;
const RESET_EVERY_MS = 24 * 3600_000;
const CACHE_MS = 2 * 60_000;

// Feedback summaries of submissions that broke something or were refused, by kind.
const KINDS = [
  ['compile', 'did not compile', ['compilation failed']],
  ['regression', 'broke functions that matched before', ['your change breaks %']],
  ['comments', 'comments or strings that are not allowed', ['rejected: the submission adds comments%']],
  ['gate', 'refused by the static gate', ['rejected by the static gate%', 'rejected: banned%']],
  ['undefined', 'declared functions that exist nowhere', ['declares functions that are defined nowhere%']],
  ['annotations', 'removed or broke annotations', ['removes the annotation of%', 'annotation errors']],
  ['stale', 'not synced with main', ['base commit % is not part of main%']],
];
const BROKEN = KINDS.flatMap(([, , patterns]) => patterns);

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

  // Counts over [since, until).
  numbers(userId, since, until = now() + 1) {
    const brokenSql = BROKEN.map(() => "json_extract(a.result_json, '$.feedback.summary') LIKE ?").join(' OR ');
    const r = this.store.get(
      `SELECT COUNT(*) AS submitted,
              SUM(CASE WHEN ${brokenSql} THEN 1 ELSE 0 END) AS broken,
              SUM(a.state = 'merged') AS merged,
              SUM(a.state = 'merged' AND json_extract(a.result_json, '$.feedback.target.status') IN ('exact', 'match_unresolved')) AS identical,
              SUM((SELECT COUNT(*) FROM peer_reviews p WHERE p.attempt_id = a.id AND p.verdict = 'different') >= 3) AS peerRejected,
              SUM((SELECT COUNT(*) FROM peer_reviews p WHERE p.attempt_id = a.id) >= 3) AS peerDecided
         FROM attempts a
        WHERE a.user_id = ? AND a.created_at >= ? AND a.created_at < ? AND a.kind = 'code' AND a.state NOT IN ('withdrawn', 'superseded', 'queued', 'verifying')`,
      ...BROKEN,
      userId,
      since,
      until,
    );
    const submitted = r?.submitted ?? 0;
    const decided = r?.peerDecided ?? 0;
    return {
      submitted,
      broken: r?.broken ?? 0,
      merged: r?.merged ?? 0,
      identical: r?.identical ?? 0,
      peerDecided: decided,
      peerRejected: r?.peerRejected ?? 0,
      peerRate: decided ? (r.peerRejected ?? 0) / decided : 0,
      brokenRate: submitted ? (r.broken ?? 0) / submitted : 0,
    };
  }

  compute(userId) {
    const u = this.store.get('SELECT submit_mode, quality_reset_at FROM users WHERE id = ?', userId);
    const mode = u?.submit_mode ?? 'auto';
    const resetAt = u?.quality_reset_at ?? null;
    const since = Math.max(now() - WINDOW_MS, resetAt ?? 0);
    const n = this.numbers(userId, since);
    const reasons = [];
    let level = 'ok';
    const raise = (to, why) => {
      if (to === 'paused' || level === 'ok') level = to;
      reasons.push(why);
    };
    const peer = `${Math.round(n.peerRate * 100)}% of your reviewed functions were sent back by peers (${n.peerRejected} of ${n.peerDecided})`;
    const broke = `${Math.round(n.brokenRate * 100)}% of your submitted functions did not compile, broke other functions or were refused (${n.broken} of ${n.submitted})`;
    if (n.peerDecided >= 30 && n.peerRate >= 0.7) raise('paused', peer);
    else if (n.peerDecided >= 20 && n.peerRate >= 0.5) raise('limited', peer);
    if (n.submitted >= 80 && n.brokenRate >= 0.85) raise('paused', broke);
    else if (n.submitted >= 50 && n.brokenRate >= 0.6) raise('limited', broke);
    if (mode === 'trusted') level = 'ok';
    if (mode === 'paused') {
      level = 'paused';
      reasons.unshift('a maintainer paused submissions from this account');
    }
    const nextReset = resetAt ? resetAt + RESET_EVERY_MS : 0;
    const canReset = level !== 'ok' && mode === 'auto' && now() >= nextReset;
    return { level, mode, reasons, ...n, since, resetAt, canReset, nextResetAt: canReset || level === 'ok' ? null : nextReset || null, windowHours: 24 };
  }

  forget(userId) {
    this.cache.delete(userId);
  }

  /** A fresh start for a limited or paused author: only work after now counts. Once a day. */
  reset(userId) {
    const q = this.compute(userId);
    if (q.mode === 'paused') throw new HttpError(403, 'a maintainer paused this account; ask them');
    if (q.level === 'ok') throw new HttpError(409, 'nothing to reset: this account is not limited');
    if (!q.canReset) throw new HttpError(429, `one reset per 24 hours; the next is possible at ${new Date(q.nextResetAt).toISOString()}`, { retryAfterSeconds: Math.ceil((q.nextResetAt - now()) / 1000) });
    this.store.run('UPDATE users SET quality_reset_at = ? WHERE id = ?', now(), userId);
    this.store.event('quality_reset', userId, { was: q.level, peerRate: q.peerRate, brokenRate: q.brokenRate });
    this.forget(userId);
    return this.details(userId);
  }

  /** Everything an author (or their agent) needs to see how the work is going and what to fix. */
  details(userId) {
    const q = this.of(userId);
    const previous = this.numbers(userId, q.since - WINDOW_MS, q.since);
    const kinds = KINDS.map(([key, label, patterns]) => {
      const n = this.store.get(
        `SELECT COUNT(*) AS n FROM attempts a WHERE a.user_id = ? AND a.created_at >= ? AND a.kind = 'code' AND (${patterns.map(() => "json_extract(a.result_json, '$.feedback.summary') LIKE ?").join(' OR ')})`,
        userId, q.since, ...patterns,
      ).n;
      return { kind: key, label, functions: n };
    }).filter((k) => k.functions);
    const sentBack = this.store.all(
      `SELECT a.id, t.symbol_id, s.name, a.created_at FROM attempts a JOIN tasks t ON t.id = a.task_id JOIN symbols s ON s.id = t.symbol_id
        WHERE a.user_id = ? AND a.created_at >= ? AND (SELECT COUNT(*) FROM peer_reviews p WHERE p.attempt_id = a.id AND p.verdict = 'different') >= 3
        ORDER BY a.id DESC LIMIT 5`,
      userId, q.since,
    ).map((r) => ({
      attemptId: r.id,
      symbol: r.symbol_id,
      name: r.name,
      reasons: this.store.all(`SELECT reason FROM peer_reviews WHERE attempt_id = ? AND verdict = 'different' ORDER BY id LIMIT 3`, r.id).map((x) => untrusted(x.reason)),
    }));
    const broken = this.store.all(
      `SELECT a.id, t.symbol_id, json_extract(a.result_json, '$.feedback.summary') AS summary FROM attempts a JOIN tasks t ON t.id = a.task_id
        WHERE a.user_id = ? AND a.created_at >= ? AND a.kind = 'code' AND (${BROKEN.map(() => "json_extract(a.result_json, '$.feedback.summary') LIKE ?").join(' OR ')})
        ORDER BY a.id DESC LIMIT 5`,
      userId, q.since, ...BROKEN,
    ).map((r) => ({ attemptId: r.id, symbol: r.symbol_id, summary: String(r.summary).slice(0, 300) }));
    return { ...q, previous, kinds, sentBack, broken, ...(q.level !== 'ok' ? { note: Quality.advice(q) } : {}), thresholds: { limited: 'half sent back by peers (20+ reviewed) or 60% broken (50+ submitted)', paused: '70% sent back (30+ reviewed) or 85% broken (80+ submitted)' } };
  }

  /** What an agent is told when its level limits it. */
  static advice(q) {
    const what = q.level === 'paused' ? 'Submissions and region claims are paused for this account' : 'This account is limited to one batch waiting at a time, six submissions an hour and one region';
    const reset = q.canReset ? ' The account owner can reset this once a day on the website (Account page).' : '';
    return `${what}: ${q.reasons.join('; ')}. It lifts by itself as your recent work gets better (last 24 hours).${reset} Port each function faithfully from the disassembly, td_check it until it compiles and matches structurally, and submit only what you checked.`;
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
