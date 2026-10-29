// Regions: a source file (module) or a class, claimed and worked on as a whole.
//
// An agent lists the regions (what is open, done, in flight, and who already works there), looks
// at the candidates in its own checkout, and registers the one it takes. That leases every open
// function of the region to it in one step. A region may be claimed by several agents; each may
// then submit any function of it. Competing candidates of a function are verified and reviewed
// independently, and the first accepted one merges (merge.js supersedes the others), so two
// agents' work combines per function. A function already on main is submitted the same way, as a
// revision: reviewed like any candidate, and the task stays done whatever its outcome. A region
// whose functions are all on main can still be claimed for that.

import { HttpError } from './http.js';
import { now } from './db.js';
import { className, RUN_GAP } from './grouping.js';
import { CLAIMABLE } from './tasks.js';

const IN_FLIGHT = ['verifying', 'peer_review', 'in_review', 'approved', 'merging'];
const FINISHED = ['done', 'skipped'];
// Unplaced functions come as runs of neighbours in the binary, at most this many per region.
const RANGE_MAX = 80;

const RANGE_RE = /^0x([0-9a-f]+)-0x([0-9a-f]+)$/i;

/** The bounds of a range region key ("0x5baf30-0x5bb100", both inclusive), or null. */
export function parseRange(key) {
  const m = RANGE_RE.exec(String(key ?? '').trim());
  if (!m) return null;
  const lo = parseInt(m[1], 16);
  const hi = parseInt(m[2], 16);
  return lo <= hi ? [lo, hi] : null;
}

const rangeKey = (lo, hi) => `0x${lo.toString(16)}-0x${hi.toString(16)}`;

export class Regions {
  constructor({ store, config, repo, tasks }) {
    this.store = store;
    this.config = config;
    this.repo = repo;
    this.tasks = tasks;
  }

  get leaseMs() {
    return (this.config.leaseMinutes ?? 120) * 60_000;
  }

  /**
   * Every source file with functions still to do: counts per state and who holds it. Sorted for
   * picking: unclaimed and unblocked first, then the most open functions.
   */
  list({ limit = 100, user = null, free = false, prefix = null } = {}) {
    const versionId = this.store.currentVersion()?.id ?? '';
    const rows = this.store.all(
      `SELECT s.unit AS key, t.state, t.lease_user, COUNT(*) AS n, SUM(COALESCE(a.size, 0)) AS bytes
         FROM tasks t JOIN symbols s ON s.id = t.symbol_id
         LEFT JOIN symbol_addresses a ON a.symbol_id = s.id AND a.version_id = ?
        WHERE s.unit IS NOT NULL ${prefix ? 'AND s.unit LIKE ?' : ''}
        GROUP BY s.unit, t.state, t.lease_user`,
      versionId,
      ...(prefix ? [`${prefix}%`] : []),
    ).map((r) => ({ ...r, kind: 'unit' }));
    if (!prefix) rows.push(...this.rangeRows(versionId));
    const claims = new Map([...this.activeClaims('unit'), ...this.activeClaims('range')]);
    const byKey = new Map();
    for (const r of rows) {
      const g = byKey.get(r.key) ?? { kind: r.kind, key: r.key, functions: 0, bytes: 0, open: 0, openBytes: 0, done: 0, inFlight: 0, heldByOthers: 0, heldByYou: 0 };
      g.functions += r.n;
      g.bytes += r.bytes;
      if (CLAIMABLE.includes(r.state)) (g.open += r.n), (g.openBytes += r.bytes);
      else if (FINISHED.includes(r.state)) g.done += r.n;
      else if (IN_FLIGHT.includes(r.state)) g.inFlight += r.n;
      else if (r.state === 'leased') {
        if (user && r.lease_user === user.id) g.heldByYou += r.n;
        else g.heldByOthers += r.n;
      }
      byKey.set(r.key, g);
    }
    const out = [];
    for (const g of byKey.values()) {
      if (!g.open && !g.heldByOthers && !g.heldByYou) continue;
      const c = claims.get(g.key) ?? [];
      g.claimedBy = c.map((x) => x.name);
      g.claimedByYou = !!user && c.some((x) => x.user_id === user.id);
      // Blocked: someone else holds functions of it, or has some on their way to main (their
      // submission would conflict with a rewrite of the file).
      g.blocked = g.heldByOthers > 0 || g.inFlight > 0;
      g.free = !g.blocked && !g.claimedBy.length;
      if (free && !g.free) continue;
      out.push(g);
    }
    // A good region is one agent's batch: 5 to 80 open functions first, then bigger ones (share
    // them, or take them in parts), then the tiny ones.
    const size = (g) => (g.open >= 5 && g.open <= 80 ? 0 : g.open > 80 ? 1 : 2);
    out.sort((a, b) => Number(b.free) - Number(a.free) || a.claimedBy.length - b.claimedBy.length || size(a) - size(b) || b.open - a.open || a.key.localeCompare(b.key));
    return { total: out.length, regions: out.slice(0, Math.min(Math.max(1, limit | 0), 1000)) };
  }

  /**
   * Functions in no source file yet, as runs of neighbours in the binary (MSVC links a unit's
   * functions together): one row per run and task state, shaped like the unit rows of list().
   */
  rangeRows(versionId) {
    const fns = this.store.all(
      `SELECT t.state, t.lease_user, a.addr, COALESCE(a.size, 0) AS size
         FROM tasks t JOIN symbols s ON s.id = t.symbol_id
         JOIN symbol_addresses a ON a.symbol_id = s.id AND a.version_id = ?
        WHERE s.unit IS NULL AND s.kind = 'function' AND t.state NOT IN ('done', 'skipped')
        ORDER BY a.addr`,
      versionId,
    );
    const out = [];
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const key = rangeKey(run[0].addr, run[run.length - 1].addr);
      const groups = new Map();
      for (const f of run) {
        const k = `${f.state}\u0000${f.lease_user ?? ''}`;
        const g = groups.get(k) ?? { kind: 'range', key, state: f.state, lease_user: f.lease_user, n: 0, bytes: 0 };
        g.n++;
        g.bytes += f.size;
        groups.set(k, g);
      }
      out.push(...groups.values());
      run = [];
    };
    for (const f of fns) {
      if (run.length && (f.addr - run[run.length - 1].addr > RUN_GAP || run.length >= RANGE_MAX)) flush();
      run.push(f);
    }
    flush();
    return out;
  }

  activeClaims(kind) {
    const out = new Map();
    for (const r of this.store.all(
      `SELECT rc.user_id, rc.key, u.name FROM region_claims rc JOIN users u ON u.id = rc.user_id WHERE rc.kind = ? AND rc.expires_at > ?`,
      kind,
      now(),
    )) {
      if (!out.has(r.key)) out.set(r.key, []);
      out.get(r.key).push(r);
    }
    return out;
  }

  /** Task ids of a region, with their state and holder. */
  members(kind, key) {
    if (kind === 'unit') {
      return this.store.all(`SELECT t.id, t.state, t.lease_user, t.symbol_id, s.name FROM tasks t JOIN symbols s ON s.id = t.symbol_id WHERE s.unit = ? ORDER BY t.id`, key);
    }
    if (kind === 'range') {
      const bounds = parseRange(key);
      if (!bounds) return [];
      return this.store.all(
        `SELECT t.id, t.state, t.lease_user, t.symbol_id, s.name FROM tasks t JOIN symbols s ON s.id = t.symbol_id
           JOIN symbol_addresses a ON a.symbol_id = s.id AND a.version_id = ?
          WHERE s.unit IS NULL AND s.kind = 'function' AND a.addr BETWEEN ? AND ? ORDER BY a.addr`,
        this.store.currentVersion()?.id ?? '', bounds[0], bounds[1],
      );
    }
    const like = `${key.replace(/[%_]/g, (c) => `\\${c}`)}::%`;
    return this.store
      .all(`SELECT t.id, t.state, t.lease_user, t.symbol_id, s.name FROM tasks t JOIN symbols s ON s.id = t.symbol_id WHERE s.name LIKE ? ESCAPE '\\' ORDER BY t.id`, like)
      .filter((r) => className(r.name) === key);
  }

  /**
   * Registers a region for `user` and leases its open functions to them. Functions another agent
   * already holds stay theirs; the claim still lets this agent submit its own candidates for them.
   */
  claim(user, { kind = 'unit', key }) {
    if (!['unit', 'class', 'range'].includes(kind)) throw new HttpError(400, "kind must be 'unit', 'class' or 'range'");
    key = String(key ?? '').trim();
    if (!key || key.length > 300) throw new HttpError(400, 'key must name the source file (kind unit), the class (kind class) or the address range 0x<start>-0x<end> (kind range)');
    if (kind === 'range') {
      const bounds = parseRange(key);
      if (!bounds) throw new HttpError(400, 'a range key is 0x<start>-0x<end>, both inclusive');
      key = rangeKey(bounds[0], bounds[1]);
    }
    const q = this.quality?.of(user.id, user.tokenId ?? null);
    if (q?.level === 'paused') throw new HttpError(429, this.quality.constructor.advice(q), { retryAfterSeconds: 3600 });
    if (q?.level === 'limited') {
      const token = user.tokenId ?? null;
      const other = this.mine(user).filter((x) => !(x.kind === kind && x.key === key) && (x.token_id ?? null) === token);
      if (other.length) throw new HttpError(409, `${this.quality.constructor.advice(q)} Finish or release ${other[0].key} first.`);
    }
    return this.store.tx(() => {
      const members = this.members(kind, key);
      if (!members.length) throw new HttpError(404, `no functions in ${kind} ${key}`);
      const expires = now() + this.leaseMs;
      this.store.run(
        `INSERT INTO region_claims (user_id, token_id, kind, key, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, kind, key) DO UPDATE SET expires_at = excluded.expires_at, token_id = excluded.token_id`,
        user.id, user.tokenId ?? null, kind, key, now(), expires,
      );
      const held = this.tasks.leasesOf(user.id).length;
      let room = this.tasks.maxLeased - held;
      const head = this.repo.head();
      const leased = [];
      for (const m of members) {
        if (room <= 0) break;
        if (!CLAIMABLE.includes(m.state)) continue;
        const t = this.store.get('SELECT preferred_user, preferred_until FROM tasks WHERE id = ?', m.id);
        if (t.preferred_user && t.preferred_user !== user.id && t.preferred_until > now()) continue;
        this.store.run(`UPDATE tasks SET state = 'leased', lease_user = ?, lease_expires = ?, lease_base_commit = ?, updated_at = ? WHERE id = ?`, user.id, expires, head, now(), m.id);
        leased.push(m.id);
        room--;
      }
      const others = (this.activeClaims(kind).get(key) ?? []).filter((c) => c.user_id !== user.id).map((c) => c.name);
      this.store.event('region_claim', user.id, { kind, key, leased: leased.length, shared: others.length });
      return {
        region: { kind, key },
        leased,
        functions: members.map((m) => ({
          taskId: m.id,
          symbol: m.symbol_id,
          name: m.name,
          state: leased.includes(m.id) ? 'leased' : m.state,
          yours: leased.includes(m.id) || (m.state === 'leased' && m.lease_user === user.id),
          shared: m.state === 'leased' && m.lease_user !== user.id,
        })),
        alsoClaimedBy: others,
        leaseExpires: expires,
        allowedPaths: this.tasks.allowedPathsForTasks(members.slice(0, 500).map((m) => m.id)),
      };
    });
  }

  release(user, { kind = 'unit', key }) {
    if (kind === 'range') {
      const bounds = parseRange(key);
      if (bounds) key = rangeKey(bounds[0], bounds[1]);
    }
    return this.store.tx(() => {
      const r = this.store.run('DELETE FROM region_claims WHERE user_id = ? AND kind = ? AND key = ?', user.id, kind, key);
      let released = 0;
      const held = kind === 'range' ? this.heldInRange(user, key) : this.members(kind, key);
      for (const m of held) {
        if (m.state === 'leased' && m.lease_user === user.id) {
          this.tasks.reopen(m.id);
          released++;
        }
      }
      if (r.changes) this.store.event('region_release', user.id, { kind, key, released });
      return { released };
    });
  }

  /**
   * Functions of `user`'s regions they may submit without holding them: unfinished ones someone
   * else holds or has on its way, and ones already on main (revisions).
   */
  sharedTasks(user, own = new Set()) {
    const out = [];
    for (const r of this.mine(user)) {
      for (const m of this.members(r.kind, r.key)) {
        if (own.has(m.id) || m.state === 'skipped' || m.state === 'merging' || CLAIMABLE.includes(m.state)) continue;
        out.push({ taskId: m.id, symbol: m.symbol_id, state: m.state });
      }
    }
    return out;
  }

  /** The regions `user` holds. */
  mine(user) {
    return this.store.all('SELECT kind, key, token_id, created_at, expires_at FROM region_claims WHERE user_id = ? AND expires_at > ? ORDER BY created_at', user.id, now());
  }

  heartbeat(user) {
    return Number(this.store.run('UPDATE region_claims SET expires_at = ? WHERE user_id = ? AND expires_at > ?', now() + this.leaseMs, user.id, now()).changes);
  }

  /** Whether `user` holds a live region claim that covers this task's function. */
  covers(user, task) {
    const sym = this.store.get('SELECT unit, name FROM symbols WHERE id = ?', task.symbol_id);
    if (!sym) return false;
    const t = now();
    if (sym.unit && this.store.get(`SELECT 1 FROM region_claims WHERE user_id = ? AND kind = 'unit' AND key = ? AND expires_at > ?`, user.id, sym.unit, t)) return true;
    const cls = className(sym.name);
    if (cls && this.store.get(`SELECT 1 FROM region_claims WHERE user_id = ? AND kind = 'class' AND key = ? AND expires_at > ?`, user.id, cls, t)) return true;
    const addr = this.store.get('SELECT addr FROM symbol_addresses WHERE symbol_id = ? AND version_id = ?', task.symbol_id, this.store.currentVersion()?.id ?? '')?.addr;
    if (addr == null) return false;
    return this.store.all(`SELECT key FROM region_claims WHERE user_id = ? AND kind = 'range' AND expires_at > ?`, user.id, t)
      .some((c) => {
        const b = parseRange(c.key);
        return b && addr >= b[0] && addr <= b[1];
      });
  }

  /** Tasks `user` holds inside a range, placed into a file since the claim or not. */
  heldInRange(user, key) {
    const bounds = parseRange(key);
    if (!bounds) return [];
    return this.store.all(
      `SELECT t.id, t.state, t.lease_user FROM tasks t JOIN symbol_addresses a ON a.symbol_id = t.symbol_id AND a.version_id = ?
        WHERE t.lease_user = ? AND a.addr BETWEEN ? AND ?`,
      this.store.currentVersion()?.id ?? '', user.id, bounds[0], bounds[1],
    );
  }

  sweepExpired() {
    return Number(this.store.run('DELETE FROM region_claims WHERE expires_at < ?', now()).changes);
  }
}
