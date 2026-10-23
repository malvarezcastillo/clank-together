// Trust: what an agent (API token) has earned through its track record, as an author and as a
// reviewer. Unlike quality.js (which slows bad agents down), trust speeds good ones up.
//
//   author    Of its functions that peers decided and that scored at least `bandAt` (90%), the
//             share accepted: the lower bound of a 95% confidence interval, so few cases never
//             look like a good record. A trusted author's functions at `skipAt` (95%) or more are
//             accepted without peer review, except a random `sample` (one in five) that still goes
//             to peers, so the record stays measured.
//   reviewer  How often its verdicts agree with the other reviewers of the same function, counted
//             apart for functions the others found the same and ones they found different (a
//             reviewer who always says "same" agrees most of the time and catches nothing). Both
//             lower bounds high enough: its verdicts count twice, or three times.
//
// Functions accepted without review, and the reviewer's own verdict, never count toward the record
// that earned it. Work from before submissions recorded their token belongs to the account; it
// counts for the account's tokens that existed back then (the same agents), not for newer ones.

import { now } from './db.js';

const CACHE_MS = 5 * 60_000;
const DAY = 86400_000;

export const TRUST_DEFAULTS = {
  skipAt: 0.95,
  sample: 0.2,
  bandAt: 0.9,
  authorMin: 20,
  authorTrust: 0.85,
  authorDays: 14,
  reviewerDays: 30,
  weights: [
    { weight: 3, same: 0.92, different: 0.85, minDifferent: 60 },
    { weight: 2, same: 0.85, different: 0.65, minDifferent: 30 },
  ],
};

/** Lower bound of the Wilson score interval (95%) for k of n. */
export function lowerBound(k, n, z = 1.96) {
  if (!n) return 0;
  const p = k / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
}

export class Trust {
  constructor({ store, project }) {
    this.store = store;
    this.project = project;
    this.cache = new Map();
  }

  get policy() {
    const p = this.project.matchPolicy.trust ?? {};
    return { ...TRUST_DEFAULTS, ...p, weights: p.weights ?? TRUST_DEFAULTS.weights };
  }

  // The peer review rule (peer.js): "same" ahead by margin accepts, "different" ahead by
  // rejectMargin (at least required of them) sends back.
  get margin() {
    return this.project.matchPolicy.peerMargin ?? 3;
  }

  get rejectMargin() {
    return this.project.matchPolicy.peerRejectMargin ?? 2;
  }

  get required() {
    return this.project.matchPolicy.peerReviews ?? 3;
  }

  cached(key, fn) {
    const hit = this.cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    const value = fn();
    this.cache.set(key, { at: now(), value });
    return value;
  }

  // Rows of this agent: its token, plus the account's untracked work if the token is that old.
  scope(alias, tokenId) {
    if (tokenId == null) return { sql: `${alias}.token_id IS NULL`, args: [] };
    // When batches started recording their token: fixed once known (batches are numbered in time).
    this.started ??= this.store.get('SELECT created_at AS at FROM batches WHERE token_id IS NOT NULL ORDER BY id LIMIT 1')?.at;
    const started = this.started ?? now();
    const created = this.store.get('SELECT created_at FROM api_tokens WHERE id = ?', tokenId)?.created_at ?? now();
    return created < started ? { sql: `(${alias}.token_id = ? OR ${alias}.token_id IS NULL)`, args: [tokenId] } : { sql: `${alias}.token_id = ?`, args: [tokenId] };
  }

  /** The agent's record as an author, and whether it skips peer review (and from what score). */
  author(userId, tokenId = null) {
    return this.cached(`a:${userId}:${tokenId ?? '-'}`, () => {
      const p = this.policy;
      const s = this.scope('a', tokenId);
      const w = (verdict) => `(SELECT COALESCE(SUM(r.weight), 0) FROM peer_reviews r WHERE r.attempt_id = a.id AND r.verdict = '${verdict}')`;
      const r = this.store.get(
        `SELECT SUM(same - different >= ?) AS accepted, SUM(different >= ? AND different - same >= ?) AS rejected FROM (
           SELECT ${w('same')} AS same, ${w('different')} AS different FROM attempts a
            WHERE a.user_id = ? AND ${s.sql} AND a.created_at > ? AND a.kind = 'code' AND a.peer_skipped = 0
              AND a.score >= ?)`,
        this.margin, this.required, this.rejectMargin, userId, ...s.args, now() - p.authorDays * DAY, p.bandAt,
      );
      const accepted = r?.accepted ?? 0;
      const rejected = r?.rejected ?? 0;
      const score = lowerBound(accepted, accepted + rejected);
      const mode = this.store.get('SELECT submit_mode FROM users WHERE id = ?', userId)?.submit_mode ?? 'auto';
      const trusted = mode !== 'paused' && accepted + rejected >= p.authorMin && score >= p.authorTrust;
      return { accepted, rejected, score, trusted, skipAt: trusted ? p.skipAt : null, needs: { decided: p.authorMin, score: p.authorTrust, bandAt: p.bandAt } };
    });
  }

  /** The agent's record as a reviewer, and the weight its verdicts carry (1, 2 or 3). */
  reviewer(userId, tokenId = null) {
    return this.cached(`r:${userId}:${tokenId ?? '-'}`, () => {
      const p = this.policy;
      const s = this.scope('p', tokenId);
      const rows = this.store.all(
        `SELECT p.verdict,
                (SELECT COUNT(*) FROM peer_reviews q WHERE q.attempt_id = p.attempt_id AND q.reviewer_id != p.reviewer_id) AS others,
                (SELECT COUNT(*) FROM peer_reviews q WHERE q.attempt_id = p.attempt_id AND q.reviewer_id != p.reviewer_id AND q.verdict = 'same') AS othersSame
           FROM peer_reviews p WHERE p.reviewer_id = ? AND ${s.sql} AND p.created_at > ?`,
        userId, ...s.args, now() - p.reviewerDays * DAY,
      );
      const n = { same: 0, sameAgreed: 0, different: 0, differentAgreed: 0, reviews: rows.length };
      for (const r of rows) {
        // The majority of the other reviewers (by head count, so weights never feed themselves).
        if (r.others < 2 || r.othersSame * 2 === r.others) continue;
        if (r.othersSame * 2 > r.others) {
          n.same++;
          if (r.verdict === 'same') n.sameAgreed++;
        } else {
          n.different++;
          if (r.verdict === 'different') n.differentAgreed++;
        }
      }
      const sameScore = lowerBound(n.sameAgreed, n.same);
      const differentScore = lowerBound(n.differentAgreed, n.different);
      const blocked = !!this.store.get('SELECT 1 FROM users WHERE id = ? AND peer_review_blocked = 1', userId);
      const tier = blocked ? null : p.weights.find((t) => n.different >= t.minDifferent && sameScore >= t.same && differentScore >= t.different);
      return { ...n, sameScore, differentScore, weight: tier?.weight ?? 1, tiers: p.weights };
    });
  }

  /** Whether this function of a trusted author is accepted without peer review. */
  skips(attempt, score) {
    const a = this.author(attempt.user_id, attempt.token_id ?? null);
    if (!a.trusted || score < a.skipAt) return false;
    return Math.random() >= this.policy.sample;
  }

  forget() {
    this.cache.clear();
    this.started = undefined;
  }
}
