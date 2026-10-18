// How each peer reviewer judges, so a maintainer can see who to trust: how often they agree with
// the other reviewers of the same function and with the human decision, and how quickly they give
// verdicts in a row (rubber-stamping shows up as many verdicts seconds apart).

const QUICK_MS = 10_000;

export function reviewerStats(store) {
  const verdicts = store.all(
    `SELECT p.attempt_id, p.reviewer_id, p.verdict, p.created_at, u.name, u.peer_review_blocked AS blocked
       FROM peer_reviews p JOIN users u ON u.id = p.reviewer_id ORDER BY p.reviewer_id, p.created_at`,
  );
  // The human decision on an attempt: approved means the logic was right.
  const human = new Map(
    store.all(`SELECT attempt_id, action FROM reviews WHERE action IN ('approve', 'request_changes', 'reject') ORDER BY id`).map((r) => [r.attempt_id, r.action === 'approve' ? 'same' : 'different']),
  );
  const byAttempt = new Map();
  for (const v of verdicts) {
    if (!byAttempt.has(v.attempt_id)) byAttempt.set(v.attempt_id, []);
    byAttempt.get(v.attempt_id).push(v);
  }

  const stats = new Map();
  let last = null;
  for (const v of verdicts) {
    const s = stats.get(v.name) ?? { name: v.name, blocked: !!v.blocked, reviews: 0, same: 0, different: 0, peerCompared: 0, peerAgreed: 0, humanCompared: 0, humanAgreed: 0, quick: 0 };
    stats.set(v.name, s);
    s.reviews++;
    s[v.verdict]++;
    // The majority of the other reviewers of this function, when there is one.
    const others = byAttempt.get(v.attempt_id).filter((o) => o.reviewer_id !== v.reviewer_id);
    const sameOthers = others.filter((o) => o.verdict === 'same').length;
    if (others.length && sameOthers * 2 !== others.length) {
      s.peerCompared++;
      if ((sameOthers * 2 > others.length ? 'same' : 'different') === v.verdict) s.peerAgreed++;
    }
    const decided = human.get(v.attempt_id);
    if (decided) {
      s.humanCompared++;
      if (decided === v.verdict) s.humanAgreed++;
    }
    if (last && last.reviewer_id === v.reviewer_id && v.created_at - last.created_at < QUICK_MS) s.quick++;
    last = v;
  }
  return [...stats.values()].sort((a, b) => b.reviews - a.reviews);
}
