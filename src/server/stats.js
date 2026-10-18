// Pipeline productivity over a time window: how much submitted work reaches main and where the rest
// goes. `td-server stats --hours N` prints it; docs/productivity.md records the readings and what
// was changed in between, so reviews compare like with like.

export function productivity(store, hours = 24) {
  const since = Date.now() - hours * 3600_000;
  const q = (sql, ...a) => store.get(sql, ...a);
  const v = store.currentVersion();
  const submitted = q(`SELECT COUNT(*) AS n FROM attempts WHERE kind = 'code' AND created_at > ?`, since).n;
  const byState = Object.fromEntries(store.all(`SELECT state, COUNT(*) AS n FROM attempts WHERE kind = 'code' AND created_at > ? GROUP BY state`, since).map((r) => [r.state, r.n]));
  const merged = byState.merged ?? 0;
  const mergedIdentical = q(
    `SELECT COUNT(*) AS n FROM attempts WHERE kind = 'code' AND state = 'merged' AND created_at > ? AND json_extract(result_json, '$.feedback.target.status') IN ('exact', 'match_unresolved')`,
    since,
  ).n;
  const reasons = {};
  for (const r of store.all(`SELECT json_extract(result_json, '$.feedback.summary') AS s FROM attempts WHERE kind = 'code' AND created_at > ? AND state IN ('needs_cleanup', 'returned', 'rejected')`, since)) {
    const k = String(r.s ?? 'unknown').replace(/fn_\d+/g, 'fn_#').replace(/\d+(\.\d+)?%?/g, '#').replace(/(fn_#(, )?)+/g, 'fn_# ').slice(0, 70);
    reasons[k] = (reasons[k] ?? 0) + 1;
  }
  const verdicts = q('SELECT COUNT(*) AS n FROM peer_reviews WHERE created_at > ?', since).n;
  const decided = q(
    `SELECT COUNT(DISTINCT a.id) AS n FROM attempts a WHERE a.state IN ('in_review', 'approved', 'merged', 'needs_cleanup')
        AND EXISTS (SELECT 1 FROM peer_reviews p WHERE p.attempt_id = a.id AND p.created_at > ?)`,
    since,
  ).n;
  const total = q(
    `SELECT COUNT(*) AS n, COALESCE(SUM(a.size), 0) AS bytes FROM symbols s JOIN symbol_addresses a ON a.symbol_id = s.id AND a.version_id = ? WHERE s.kind = 'function' AND s.library = 0 AND s.skip_reason IS NULL`,
    v.id,
  );
  const done = q(
    `SELECT COUNT(*) AS n, COALESCE(SUM(a.size), 0) AS bytes FROM func_status f JOIN symbol_addresses a ON a.symbol_id = f.symbol_id AND a.version_id = ? WHERE f.status IN ('exact', 'match_unresolved')`,
    v.id,
  );
  return {
    hours,
    contributors: q('SELECT COUNT(DISTINCT user_id) AS n FROM attempts WHERE created_at > ?', since).n,
    submitted,
    merged,
    mergedIdentical,
    mergedPeerConfirmed: merged - mergedIdentical,
    mergedShare: submitted ? merged / submitted : 0,
    mergedPerHour: merged / hours,
    byState,
    topReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8),
    peer: { verdicts, decided, verdictsPerDecision: decided ? verdicts / decided : null, waiting: q(`SELECT COUNT(*) AS n FROM attempts WHERE state = 'peer_review'`).n },
    progress: { functions: done.n, functionsTotal: total.n, bytes: done.bytes, bytesTotal: total.bytes },
  };
}

export function formatProductivity(p) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    `window: last ${p.hours} h, ${p.contributors} contributors`,
    `submitted functions: ${p.submitted}; merged: ${p.merged} (${pct(p.mergedShare)}; ${p.mergedIdentical} byte-identical, ${p.mergedPeerConfirmed} peer-confirmed); ${p.mergedPerHour.toFixed(1)} merged/h`,
    `attempt states: ${Object.entries(p.byState).map(([k, n]) => `${k}=${n}`).join(' ')}`,
    `peer review: ${p.peer.verdicts} verdicts, ${p.peer.decided} functions decided, ${p.peer.verdictsPerDecision?.toFixed(1) ?? '-'} verdicts/decision, ${p.peer.waiting} waiting`,
    `progress: ${p.progress.functions}/${p.progress.functionsTotal} functions (${pct(p.progress.functions / p.progress.functionsTotal)}), ${p.progress.bytes}/${p.progress.bytesTotal} bytes (${pct(p.progress.bytes / p.progress.bytesTotal)})`,
    'top reasons work came back:',
    ...p.topReasons.map(([k, n]) => `  ${String(n).padStart(6)}  ${k}`),
  ];
  return lines.join('\n');
}
