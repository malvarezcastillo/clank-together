// Library flags come from Ghidra's Function ID matches at bootstrap. Function ID matches by code
// shape, so small game functions (constructors, window-manager helpers) collide with CRT and STL
// names and get flagged: they then have no task and annotating them is refused. Runtime library
// code does not call into the game, so a flagged function whose original calls game code (directly,
// or through another such function) is game code. The one exception is CRT startup (start,
// invoke_main), which calls the program's entry by design: a call to it is no evidence.
const ENTRY = /^(_?w?WinMain@16|_?w?main)$/;

const CALL = /\bCALL\s+0x([0-9a-f]{8})\b/gi;

/** Flagged functions of `versionId` whose original calls game code, with the game callees. */
export function misflaggedLibrary(store, versionId) {
  const fns = store.all(
    `SELECT s.id, s.name, s.library, s.skip_reason, a.addr FROM symbols s
       JOIN symbol_addresses a ON a.symbol_id = s.id AND a.version_id = ?
      WHERE s.kind = 'function'`,
    versionId,
  );
  const byAddr = new Map(fns.map((f) => [f.addr, f]));
  const asm = new Map(store.all('SELECT addr, asm FROM original_code WHERE version_id = ?', versionId).map((r) => [r.addr, r.asm]));
  const callees = new Map();
  for (const f of fns) {
    if (!f.library) continue;
    const out = new Set();
    for (const m of (asm.get(f.addr) ?? '').matchAll(CALL)) {
      const t = byAddr.get(parseInt(m[1], 16));
      if (t && t !== f) out.add(t);
    }
    callees.set(f.id, [...out]);
  }
  const game = new Map();
  const isGame = (t) => (!t.library && !t.skip_reason && !ENTRY.test(t.name ?? '')) || game.has(t.id);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, targets] of callees) {
      if (game.has(id)) continue;
      const calls = targets.filter(isGame);
      if (calls.length) {
        game.set(id, calls.map((t) => t.id));
        changed = true;
      }
    }
  }
  const names = new Map(fns.map((f) => [f.id, f.name]));
  return [...game].map(([id, calls]) => ({ id, name: names.get(id), calls }));
}

/**
 * Clears the library flag of `ids` and its Function ID name (the false match), giving the
 * function the usual unnamed `sub_<ADDR>` name, and records why. Tasks are created by the
 * caller's tasks.generate(); unit placement follows on the next inferUnits pass.
 */
export function clearLibrary(store, ids, { userId = null, reason }) {
  if (!reason?.trim()) throw new Error('a reason (the evidence) is required');
  const v = store.currentVersion();
  let n = 0;
  store.tx(() => {
    for (const id of ids) {
      const sym = store.get('SELECT id, kind, name, library FROM symbols WHERE id = ?', id);
      if (!sym) throw new Error(`no such symbol ${id}`);
      if (sym.kind !== 'function') throw new Error(`${id} is not a function`);
      if (!sym.library) continue;
      const at = v && store.get('SELECT addr FROM symbol_addresses WHERE symbol_id = ? AND version_id = ?', id, v.id);
      const name = at ? `sub_${at.addr.toString(16).toUpperCase()}` : null;
      store.run('UPDATE symbols SET library = 0, name = ? WHERE id = ?', name, id);
      store.event('symbol_corrected', userId, { id, library: false, name, old: { library: true, name: sym.name }, new: { library: false, name }, reason: reason.trim() });
      n++;
    }
    if (n) store.setMeta('symbolCorrectionsRevision', Number(store.getMeta('symbolCorrectionsRevision') ?? 0) + 1);
  });
  return n;
}
