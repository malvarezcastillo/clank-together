// Game credits: play money for the arcade, earned with work that reached main and reviews that
// agreed with the outcome. They have no value outside the site.
//
// Earnings are derived from what the database already records (merged attempts, decided peer
// reviews, accepted "no decompile" claims), so nothing in the pipeline has to remember to pay: a
// sync every half minute books whatever is new, once per (user, reason, ref).

import crypto from 'node:crypto';
import { HttpError } from './http.js';
import { now } from './db.js';

export const AWARDS = {
  identical: 10, // a function merged byte-identical
  confirmed: 6, // a function merged after five peers confirmed its logic
  skip: 3, // an accepted "no decompile" claim
  submitted: 1, // a submitted function that compiled and went on (peer review or approved)
  review: 2, // a peer verdict that agreed with how the function was decided
};

const MAX_BET = 1000;
const BAILOUT = 25; // once a day for anyone below 5 credits

// Slots: reel symbols with weights out of 100, paying for three of a kind (and two gears).
const REEL = [
  { s: '⚙️', w: 30, three: 10 },
  { s: '🔩', w: 25, three: 15 },
  { s: '💾', w: 18, three: 25 },
  { s: '🐞', w: 15, three: 30 },
  { s: '👾', w: 8, three: 100 },
  { s: '7️⃣', w: 4, three: 500 },
];

export class Credits {
  constructor({ store }) {
    this.store = store;
  }

  balance(userId) {
    return this.store.get('SELECT COALESCE(SUM(amount), 0) AS n FROM credit_ledger WHERE user_id = ?', userId).n;
  }

  book(userId, amount, reason, ref) {
    return Number(this.store.run('INSERT OR IGNORE INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)', userId, amount, reason, ref, now()).changes);
  }

  /**
   * Books every earning that is not booked yet. Returns how many entries were added.
   * The scans read a snapshot outside the write transaction: they take about a second on a large
   * database and would otherwise hold the write lock that long every 30 s, starving the worker.
   * Booking is idempotent (INSERT OR IGNORE on the ledger's unique key), so an earning another
   * process books between the scan and the write is not booked twice.
   */
  sync() {
    const missing = (reason, refExpr) => `NOT EXISTS (SELECT 1 FROM credit_ledger l WHERE l.user_id = a.user_id AND l.reason = '${reason}' AND l.ref = ${refExpr})`;
    const entries = [];
    // Merged code: byte-identical or peer-confirmed.
    for (const r of this.store.all(
      `SELECT a.id, a.user_id, json_extract(a.result_json, '$.feedback.target.status') AS status FROM attempts a
        WHERE a.state = 'merged' AND a.kind = 'code' AND ${missing('identical', "'attempt:' || a.id")} AND ${missing('confirmed', "'attempt:' || a.id")}`,
    )) {
      const identical = r.status === 'exact' || r.status === 'match_unresolved';
      entries.push([r.user_id, identical ? AWARDS.identical : AWARDS.confirmed, identical ? 'identical' : 'confirmed', `attempt:${r.id}`]);
    }
    // Accepted "no decompile" claims.
    for (const r of this.store.all(`SELECT a.id, a.user_id FROM attempts a WHERE a.kind = 'skip' AND a.state IN ('merged', 'skipped', 'approved') AND ${missing('skip', "'attempt:' || a.id")}`)) {
      entries.push([r.user_id, AWARDS.skip, 'skip', `attempt:${r.id}`]);
    }
    // Submitted code that compiled and went on.
    for (const r of this.store.all(
      `SELECT a.id, a.user_id FROM attempts a WHERE a.kind = 'code' AND a.state IN ('peer_review', 'in_review', 'approved', 'merging', 'merged') AND ${missing('submitted', "'attempt:' || a.id")}`,
    )) {
      entries.push([r.user_id, AWARDS.submitted, 'submitted', `attempt:${r.id}`]);
    }
    // Reviews that agreed with the outcome: "same" on what merged, "different" on what peers sent back
    // (also once a later attempt finished the function and this one was retired as superseded).
    for (const r of this.store.all(
      `SELECT p.id, p.reviewer_id AS user_id FROM peer_reviews p JOIN attempts t ON t.id = p.attempt_id
        WHERE ((p.verdict = 'same' AND t.state IN ('merged', 'approved', 'merging')) OR (p.verdict = 'different' AND t.state IN ('needs_cleanup', 'hard', 'returned', 'superseded') AND
               (SELECT COALESCE(SUM(q.weight), 0) FROM peer_reviews q WHERE q.attempt_id = t.id AND q.verdict = 'different') >= 3))
          AND NOT EXISTS (SELECT 1 FROM credit_ledger l WHERE l.user_id = p.reviewer_id AND l.reason = 'review' AND l.ref = 'review:' || p.id)`,
    )) {
      entries.push([r.user_id, AWARDS.review, 'review', `review:${r.id}`]);
    }
    if (!entries.length) return 0;
    let n = 0;
    this.store.tx(() => {
      for (const e of entries) n += this.book(...e);
    });
    return n;
  }

  /** What the arcade shows a player: balance, recent entries, whether the daily bailout is open. */
  wallet(userId) {
    const balance = this.balance(userId);
    const earned = this.store.all(`SELECT reason, SUM(amount) AS n, COUNT(*) AS c FROM credit_ledger WHERE user_id = ? AND amount > 0 AND reason NOT LIKE 'game:%' GROUP BY reason`, userId);
    const recent = this.store.all('SELECT id, game, bet, payout, detail, created_at FROM game_rounds WHERE user_id = ? ORDER BY id DESC LIMIT 15', userId).map((r) => ({ ...r, detail: JSON.parse(r.detail ?? '{}') }));
    return { balance, earned: Object.fromEntries(earned.map((e) => [e.reason, { credits: e.n, times: e.c }])), recent, bailout: balance < 5 && !this.bailoutTaken(userId), awards: AWARDS, maxBet: MAX_BET };
  }

  bailoutTaken(userId) {
    return !!this.store.get(`SELECT 1 FROM credit_ledger WHERE user_id = ? AND reason = 'bailout' AND ref = ?`, userId, new Date().toISOString().slice(0, 10));
  }

  bailout(userId) {
    return this.store.tx(() => {
      if (this.balance(userId) >= 5) throw new HttpError(409, 'the bailout is for players below 5 credits');
      if (!this.book(userId, BAILOUT, 'bailout', new Date().toISOString().slice(0, 10))) throw new HttpError(409, 'already taken today; come back tomorrow (or merge a function)');
      return { balance: this.balance(userId), granted: BAILOUT };
    });
  }

  /** One round of a game. The outcome comes from the server's CSPRNG; the bet is booked first. */
  play(userId, game, params = {}) {
    const bet = Math.floor(Number(params.bet));
    if (!Number.isFinite(bet) || bet < 1 || bet > MAX_BET) throw new HttpError(400, `bet 1 to ${MAX_BET} credits`);
    const outcome = GAMES[game];
    if (!outcome) throw new HttpError(404, `no game ${game}; try ${Object.keys(GAMES).join(', ')}`);
    return this.store.tx(() => {
      if (this.balance(userId) < bet) throw new HttpError(409, 'not enough credits');
      const { payout, detail } = outcome(bet, params);
      const id = Number(this.store.run('INSERT INTO game_rounds (user_id, game, bet, payout, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)', userId, game, bet, payout, JSON.stringify(detail), now()).lastInsertRowid);
      this.book(userId, -bet, `game:${game}`, `round:${id}:bet`);
      if (payout) this.book(userId, payout, `game:${game}`, `round:${id}:win`);
      if (payout >= bet * 10 && payout >= 100) this.store.event('game_win', userId, { game, bet, payout });
      return { round: id, game, bet, payout, detail, balance: this.balance(userId) };
    });
  }

  leaderboard(limit = 15) {
    const rich = this.store.all(
      `SELECT u.name, SUM(l.amount) AS balance, SUM(CASE WHEN l.amount > 0 AND l.reason NOT LIKE 'game:%' AND l.reason != 'bailout' THEN l.amount ELSE 0 END) AS earned
         FROM credit_ledger l JOIN users u ON u.id = l.user_id WHERE u.status = 'active' GROUP BY u.id ORDER BY balance DESC LIMIT ?`,
      limit,
    );
    const wins = this.store.all(
      `SELECT u.name, r.game, r.bet, r.payout, r.created_at FROM game_rounds r JOIN users u ON u.id = r.user_id WHERE r.created_at > ? AND r.payout > r.bet ORDER BY r.payout DESC LIMIT 10`,
      now() - 86_400_000,
    );
    return { rich, wins };
  }
}

const roll = (n) => crypto.randomInt(n);

export const GAMES = {
  // Heads or tails at 1.95x.
  coinflip(bet, { side }) {
    if (side !== 'heads' && side !== 'tails') throw new HttpError(400, 'side: heads or tails');
    const result = roll(2) ? 'heads' : 'tails';
    return { payout: result === side ? Math.floor(bet * 1.95) : 0, detail: { side, result } };
  },
  // Roll 1-100; win when the roll is below the target. The payout follows the odds (3% edge).
  dice(bet, { under }) {
    const target = Math.floor(Number(under));
    if (!(target >= 3 && target <= 96)) throw new HttpError(400, 'under: a target from 3 to 96');
    const result = roll(100) + 1;
    const multiplier = Math.floor((97 / (target - 1)) * 100) / 100;
    return { payout: result < target ? Math.floor(bet * multiplier) : 0, detail: { under: target, result, multiplier } };
  },
  // Three reels; three of a kind pays per symbol, two gears on the first reels pay the bet back.
  slots(bet) {
    const total = REEL.reduce((t, x) => t + x.w, 0);
    const spin = () => {
      let r = roll(total);
      for (const x of REEL) if ((r -= x.w) < 0) return x;
      return REEL[0];
    };
    const reels = [spin(), spin(), spin()];
    let payout = 0;
    if (reels[0] === reels[1] && reels[1] === reels[2]) payout = bet * reels[0].three;
    else if (reels[0].s === '⚙️' && reels[1].s === '⚙️') payout = bet;
    return { payout, detail: { reels: reels.map((x) => x.s) } };
  },
};

export const SLOT_TABLE = REEL.map(({ s, three }) => ({ symbol: s, three }));
