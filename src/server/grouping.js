// Work comes in coherent groups: a source file, a class, or a run of neighbouring functions in the
// binary (MSVC links each translation unit's functions together, so neighbours usually share a
// file). Functions nobody has written yet get the file their neighbours or their class live in,
// where the binary makes that clear, so agents know where to write them and claim them by file.

/** The class part of a demangled name ("Ns::Cls<T, U>::Method" -> "Ns::Cls<T, U>"), or null. */
export function className(name) {
  if (!name) return null;
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < name.length - 1; i++) {
    const c = name[i];
    if (c === '<' || c === '(') depth++;
    else if ((c === '>' || c === ')') && depth > 0) depth--;
    else if (c === ':' && name[i + 1] === ':' && depth === 0) cut = i;
  }
  return cut > 0 ? name.slice(0, cut) : null;
}

// How far apart two functions may be and still count as one run.
const RUN_GAP = 0x800;
const SANDWICH_SPAN = 0x10000;

/**
 * Assigns a unit to functions without one: when the nearest placed functions before and after it
 * in the binary are in the same unit (and close), or when the other methods of its class are all
 * in one unit. Returns the number of symbols placed.
 */
export function inferUnits(store) {
  const v = store.currentVersion();
  if (!v) return 0;
  const fns = store.all(
    `SELECT s.id, s.name, s.unit, a.addr FROM symbols s JOIN symbol_addresses a ON a.symbol_id = s.id AND a.version_id = ?
      WHERE s.kind = 'function' AND s.library = 0 ORDER BY a.addr`,
    v.id,
  );
  const assign = new Map();
  // Between two functions of the same unit.
  let prev = null;
  const pending = [];
  for (const f of fns) {
    if (!f.unit) {
      pending.push(f);
      continue;
    }
    if (prev && prev.unit === f.unit && f.addr - prev.addr <= SANDWICH_SPAN) for (const p of pending) assign.set(p.id, f.unit);
    pending.length = 0;
    prev = f;
  }
  // Methods of a class whose placed methods are all in one unit.
  const units = new Map();
  for (const f of fns) {
    const cls = f.unit && className(f.name);
    if (!cls) continue;
    if (!units.has(cls)) units.set(cls, new Set());
    units.get(cls).add(f.unit);
  }
  for (const f of fns) {
    if (f.unit || assign.has(f.id)) continue;
    const set = units.get(className(f.name));
    if (set?.size === 1) assign.set(f.id, [...set][0]);
  }
  store.tx(() => {
    for (const [id, unit] of assign) store.run('UPDATE symbols SET unit = ? WHERE id = ? AND unit IS NULL', unit, id);
  });
  return assign.size;
}

/**
 * The group of open tasks that belongs with `seed`: its unit, else its class, else the run of
 * unplaced functions around it in the binary. Returns task ids in address order and a description.
 */
export function groupFor(store, seed, { claimable, user, now, limit }) {
  const v = store.currentVersion();
  const s = store.get(
    `SELECT s.id, s.name, s.unit, a.addr FROM symbols s LEFT JOIN symbol_addresses a ON a.symbol_id = s.id AND a.version_id = ? WHERE s.id = ?`,
    v.id, seed.symbol_id,
  );
  const ph = claimable.map(() => '?').join(',');
  const base = `SELECT t.id, s.name, a.addr FROM tasks t JOIN symbols s ON s.id = t.symbol_id
                  JOIN symbol_addresses a ON a.symbol_id = s.id AND a.version_id = ?
                 WHERE t.state IN (${ph}) AND (t.preferred_user IS NULL OR t.preferred_user = ? OR t.preferred_until < ?)`;
  const args = [v.id, ...claimable, user.id, now];
  if (s.unit) {
    const rows = store.all(`${base} AND s.unit = ? ORDER BY a.addr LIMIT ?`, ...args, s.unit, limit);
    return { ids: rows.map((r) => r.id), kind: 'unit', key: s.unit };
  }
  const cls = className(s.name);
  if (cls) {
    const rows = store.all(`${base} AND s.unit IS NULL AND s.name LIKE ? ESCAPE '\\' ORDER BY a.addr`, ...args, cls.replace(/[\\%_]/g, (c) => '\\' + c) + '::%')
      .filter((r) => className(r.name) === cls)
      .slice(0, limit);
    if (rows.length) return { ids: rows.map((r) => r.id), kind: 'class', key: cls };
  }
  // Neighbours in the binary: a run with small gaps around the seed.
  const near = store.all(`${base} AND s.unit IS NULL AND a.addr BETWEEN ? AND ? ORDER BY a.addr`, ...args, s.addr - 0x8000, s.addr + 0x8000);
  const at = near.findIndex((r) => r.id === seed.id);
  let lo = at;
  let hi = at;
  while (lo > 0 && near[lo].addr - near[lo - 1].addr <= RUN_GAP && hi - lo + 1 < limit) lo--;
  while (hi < near.length - 1 && near[hi + 1].addr - near[hi].addr <= RUN_GAP && hi - lo + 1 < limit) hi++;
  const run = at < 0 ? [{ id: seed.id }] : near.slice(lo, hi + 1);
  return { ids: run.map((r) => r.id), kind: 'range', key: at < 0 ? null : `0x${near[lo].addr.toString(16)}-0x${near[hi].addr.toString(16)}` };
}
