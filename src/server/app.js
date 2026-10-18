// Coordinator server: wires storage, repo, tasks, verifier and merger to the HTTP API.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store, now } from './db.js';
import { Accounts, AccountError, hasRole, ROLES } from './accounts.js';
import { Repo, serveGit } from './git.js';
import { Tasks } from './tasks.js';
import { Verifier } from './verify.js';
import { Merger } from './merge.js';
import { PeerReviews } from './peer.js';
import { Originals } from './original.js';
import { downloadsDir, installPs1, installSh } from './install.js';
import { ServerGhidra } from './ghidra.js';
import { functionRegions } from './split.js';
import { CheckQueue, WorkerUnavailable } from './checks.js';
import { withGuidance } from './guidance.js';
import { reviewerStats } from './reviewers.js';
import { inferUnits } from './grouping.js';
import { Router, HttpError, readJson, sendJson, RateLimiter } from './http.js';
import { PEImage } from '../shared/pe.js';
import { loadProject, loadToolchainLock } from '../shared/project.js';
import { DEFAULT_LIMITS, lintSubmission } from '../shared/lint.js';
import { hex } from '../shared/annotations.js';

// TD_WEB_DIR points through the release symlink in production, so new pages are live without a restart.
const WEB_DIR = process.env.TD_WEB_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');

export const DEFAULT_CONFIG = {
  listen: { host: '127.0.0.1', port: 8080 },
  publicUrl: 'http://127.0.0.1:8080',
  leaseMinutes: 120,
  maxLeasesPerUser: 3,
  verifyConcurrency: 2,
  buildTimeoutMs: 300000,
  submitsPerHour: 30,
  runners: { msvc2010: { type: 'docker', image: 'togetherdecomp/msvc2010:1', memory: '1g', cpus: 1 } },
  allowUnsandboxedRunners: false,
  pushRemote: null,
  ghidraHome: null,
  ghidraRefreshMinutes: 30,
  distributeTarget: false,
  gitCloneUrl: null,
  gitWebUrl: null,
  keepJobDirs: false,
  trustProxy: false,
};

export function loadConfig(dataDir) {
  const file = path.join(dataDir, 'server.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return { ...DEFAULT_CONFIG, ...cfg, dataDir: path.resolve(dataDir) };
}

/** Opens all server components for a data directory (used by the server and the admin CLI). */
export function openServer(dataDir, { log = console } = {}) {
  const config = loadConfig(dataDir);
  const store = new Store(path.join(config.dataDir, 'td.sqlite'));
  const repo = new Repo(path.join(config.dataDir, 'repo'));
  const project = loadProject(repo.dir);
  config.envDigest = loadToolchainLock(repo.dir)[project.toolchain]?.clSha256 ?? null;

  let peCache = null;
  const getPe = () => {
    const v = store.currentVersion();
    if (!v) throw new Error('no current target version; run `td-server version add`');
    if (!peCache || peCache.id !== v.id) peCache = { id: v.id, pe: new PEImage(fs.readFileSync(v.file)) };
    return peCache.pe;
  };

  for (const [name, r] of Object.entries(config.runners)) {
    if (r.type !== 'docker' && !config.allowUnsandboxedRunners) {
      throw new Error(`runner "${name}" is of type ${r.type}; the server only runs untrusted code in docker unless allowUnsandboxedRunners is set`);
    }
  }

  const tasks = new Tasks({ store, config, repo, project });
  const peers = new PeerReviews({ store, project });
  const verifier = new Verifier({ store, config, repo, project, tasks, getPe, peers, log });
  const merger = new Merger({ store, config, repo, project, tasks, verifier, getPe, peers, log });
  const accounts = new Accounts(store);
  const originals = new Originals({ store });
  const ghidra = new ServerGhidra({ config, store, originals, log });
  merger.onMerged = (commit) => ghidra.scheduleRefresh(commit);
  const checks = new CheckQueue({ store, repo, verifier, config, log });
  return { config, store, repo, project, tasks, verifier, merger, getPe, accounts, peers, originals, ghidra, checks };
}

export function createApp(ctx) {
  const { config, store, repo, project, tasks, merger, accounts, peers } = ctx;
  const router = new Router();
  // In a separate web process the worker picks new work up from the database by itself.
  const runsWorker = ctx.runsWorker ?? true;
  downloadsRoot = downloadsDir(config);
  const submitLimiter = new RateLimiter(config.submitsPerHour, 3600_000);
  const symbolLimiter = new RateLimiter(120, 3600_000);
  const authFailLimiter = new RateLimiter(60, 600_000);
  const registerLimiter = new RateLimiter(5, 3600_000);
  const loginLimiter = new RateLimiter(20, 900_000);
  const secureCookie = config.publicUrl.startsWith('https://');

  const sessionCookie = (req) => /(?:^|;\s*)td_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? null;

  /**
   * Resolves the caller. Agents use `Authorization: Bearer td_...` API tokens;
   * the browser uses an HttpOnly session cookie. Both are looked up in the
   * database on every request, so revocation is immediate.
   *
   * @param {string} [opts.role]        minimum role
   * @param {boolean} [opts.session]    require a browser session (password login):
   *                                    API tokens cannot manage accounts, tokens or reviews
   */
  const auth = (req, { role, session = false } = {}) => {
    const bearer = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    let user = null;
    if (bearer) {
      user = accounts.userByApiToken(bearer);
    } else {
      const cookie = sessionCookie(req);
      user = cookie ? accounts.userBySession(cookie) : null;
      // Cookie-authenticated writes must carry a header that cross-site forms cannot set.
      if (user && req.method !== 'GET' && req.headers['x-td-csrf'] !== '1') throw new HttpError(403, 'missing CSRF header');
    }
    if (!user) {
      authFailLimiter.check(clientIp(req));
      throw new HttpError(401, 'not logged in, or the token/account was revoked');
    }
    if (session && user.via !== 'session') throw new HttpError(403, 'this action needs a password login in the browser; API tokens cannot do it');
    if (role && !hasRole(user, role)) throw new HttpError(403, `requires the ${role} role`);
    return user;
  };
  const accountCall = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AccountError) throw new HttpError(e.status, e.message);
      throw e;
    }
  };
  const clientIp = (req) => (config.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress);
  const intParam = (v) => {
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n)) throw new HttpError(400, 'invalid id');
    return n;
  };

  // --- public

  router.on('GET', '/api/info', () => {
    const v = store.currentVersion();
    return {
      project: project.name,
      head: repo.head(),
      // Clone from the git dashboard (Forgejo) when configured; /repo.git is the coordinator's own read-only fallback.
      git: config.gitCloneUrl ?? `${config.publicUrl}/repo.git`,
      gitWeb: config.gitWebUrl ?? null,
      version: v ? { id: v.id, label: v.label ?? v.id, sha256: v.sha256, size: v.size, download: config.distributeTarget ? `${config.publicUrl}/api/target/${encodeURIComponent(v.id)}` : null } : null,
      toolchain: project.toolchain,
      toolchainLock: loadToolchainLock(repo.dir),
      limits: { ...DEFAULT_LIMITS, ...project.lintLimits },
      matchPolicy: project.matchPolicy,
    };
  });

  // The target is only served when the project has the right to redistribute it.
  // Otherwise contributors bring their own copy, verified by SHA-256.
  // distributeTarget: false (contributors bring their own copy), "contributors" (approved
  // accounts only, API token or browser session) or true (anyone).
  router.on('GET', '/api/target/:version', ({ req, params, res }) => {
    if (!config.distributeTarget) throw new HttpError(404, 'this project does not distribute the target executable; use your own copy (td setup --exe)');
    if (config.distributeTarget !== true) auth(req);
    const v = store.get('SELECT * FROM versions WHERE id = ?', params.version);
    if (!v) throw new HttpError(404, 'unknown version');
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': v.size, 'content-disposition': `attachment; filename="target-${v.id}.exe"`, 'x-sha256': v.sha256 });
    fs.createReadStream(v.file).pipe(res);
    return undefined;
  });

  // The whole symbol table (over a megabyte): sent only when it changed since the client's copy.
  router.on('GET', '/api/symbols', ({ req, res, query }) => {
    const v = query.get('version') ? store.get('SELECT * FROM versions WHERE id = ?', query.get('version')) : store.currentVersion();
    if (!v) throw new HttpError(404, 'unknown version');
    // Building it takes a while; a minute-old table is fine for agents.
    const { body, etag } = cached(`symbols:${v.id}`, 60_000, () => {
      const rows = [...store.symbolMap(v.id).values()].map((s) => [s.id, s.kind, s.addr, s.size, s.name, s.decorated, s.library ? 1 : 0, s.unit]);
      const json = JSON.stringify({ version: v.id, columns: ['id', 'kind', 'addr', 'size', 'name', 'decorated', 'library', 'unit'], symbols: rows });
      return { body: json, etag: `"${crypto.createHash('sha1').update(json).digest('hex')}"` };
    });
    const headers = { etag, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return void res.end();
    }
    res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  });

  // Public: who is on the project and what their agents are doing right now. No token labels or
  // other account details; only names, roles and work.
  const ACTIVE_MS = 15 * 60_000;
  // Public numbers every open page polls: computed at most once per `ttl` and shared by everyone.
  const shared = new Map();
  const cached = (key, ttl, compute) => {
    const hit = shared.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = compute();
    shared.set(key, { at: Date.now(), value });
    return value;
  };

  router.on('GET', '/api/crew', () => cached('crew', 20_000, () => {
    const since = Date.now() - ACTIVE_MS;
    const users = store.all(
      `SELECT u.name, u.role, u.approved_at AS joined,
              (SELECT COUNT(*) FROM attempts a WHERE a.user_id = u.id AND a.state = 'merged') AS merged,
              (SELECT COUNT(*) FROM attempts a WHERE a.user_id = u.id) AS submitted,
              (SELECT COUNT(*) FROM peer_reviews p WHERE p.reviewer_id = u.id) AS peer_reviews,
              (SELECT MAX(last_used_at) FROM api_tokens t WHERE t.user_id = u.id) AS last_seen
         FROM users u WHERE u.status = 'active' ORDER BY merged DESC, peer_reviews DESC, u.approved_at`,
    );
    const agents = store.all(
      `SELECT u.id, u.name, COUNT(DISTINCT t.id) AS agents, MAX(t.last_used_at) AS last_seen
         FROM api_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.revoked_at IS NULL AND t.last_used_at > ? AND u.status = 'active' GROUP BY u.id ORDER BY last_seen DESC`,
      since,
    );
    const active = agents.map((a) => {
      const units = store.all(
        `SELECT s.unit, COUNT(*) AS functions FROM tasks t JOIN symbols s ON s.id = t.symbol_id
          WHERE t.state = 'leased' AND t.lease_user = ? GROUP BY s.unit ORDER BY functions DESC`,
        a.id,
      );
      const reviewing = store.get('SELECT COUNT(DISTINCT attempt_id) AS n FROM peer_leases WHERE reviewer_id = ? AND expires_at > ?', a.id, Date.now()).n;
      const waiting = store.get(`SELECT COUNT(*) AS n FROM attempts WHERE user_id = ? AND state IN ('queued', 'verifying')`, a.id).n;
      const today = store.get(`SELECT COUNT(*) AS n FROM attempts WHERE user_id = ? AND created_at > ?`, a.id, Date.now() - 24 * 3600_000).n;
      return { name: a.name, agents: a.agents, lastSeen: a.last_seen, units: units.map((u) => ({ unit: u.unit ?? '(no unit)', functions: u.functions })), reviewing, verifying: waiting, submittedToday: today };
    });
    return { activeMinutes: ACTIVE_MS / 60_000, users, active };
  }));

  router.on('GET', '/api/progress', () => cached('progress', 20_000, () => {
    const total = store.get(`SELECT COUNT(*) AS n, COALESCE(SUM(a.size), 0) AS bytes FROM symbols s JOIN symbol_addresses a ON a.symbol_id = s.id JOIN versions v ON v.id = a.version_id AND v.is_current = 1 WHERE s.kind = 'function' AND s.library = 0`);
    const byStatus = store.all(`SELECT fs.status, COUNT(*) AS n, COALESCE(SUM(a.size), 0) AS bytes FROM func_status fs JOIN symbol_addresses a ON a.symbol_id = fs.symbol_id JOIN versions v ON v.id = a.version_id AND v.is_current = 1 GROUP BY fs.status`);
    const byTaskState = store.all('SELECT state, COUNT(*) AS n FROM tasks GROUP BY state');
    const contributors = store.all(`SELECT u.name, COUNT(*) AS merged FROM attempts a JOIN users u ON u.id = a.user_id WHERE a.state = 'merged' GROUP BY u.id ORDER BY merged DESC LIMIT 20`);
    const confirmed = store.get(`SELECT COUNT(*) AS n, COALESCE(SUM(a.size), 0) AS bytes FROM func_status fs JOIN symbol_addresses a ON a.symbol_id = fs.symbol_id JOIN versions v ON v.id = a.version_id AND v.is_current = 1 WHERE fs.confirmed = 1 AND fs.status NOT IN ('exact', 'match_unresolved')`);
    const peerQueue = store.get("SELECT COUNT(*) AS n FROM attempts WHERE state = 'peer_review'").n;
    return { functions: total.n, bytes: total.bytes, byStatus, confirmed, peerQueue, byTaskState, contributors };
  }));

  // --- accounts

  router.on('POST', '/api/register', async ({ req }) => {
    registerLimiter.check(clientIp(req));
    const body = await readJson(req, 4096);
    return accountCall(() => accounts.register(body.name, body.password));
  });

  router.on('POST', '/api/login', async ({ req, res }) => {
    const body = await readJson(req, 4096);
    loginLimiter.check(clientIp(req));
    loginLimiter.check('user:' + String(body.name ?? '').toLowerCase());
    const r = await accountCall(() => accounts.login(body.name, body.password));
    res.setHeader('set-cookie', `td_session=${r.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${r.maxAgeSeconds}${secureCookie ? '; Secure' : ''}`);
    return r.user;
  });

  router.on('POST', '/api/logout', ({ req, res }) => {
    const cookie = sessionCookie(req);
    if (cookie) accounts.logout(cookie);
    res.setHeader('set-cookie', `td_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie ? '; Secure' : ''}`);
    return { ok: true };
  });

  router.on('GET', '/api/me', ({ req }) => {
    const user = auth(req);
    const leases = tasks.leasesOf(user.id);
    return { name: user.name, role: user.role, via: user.via, leases, leasedAllowedPaths: leases.length ? tasks.allowedPathsForTasks(leases) : [] };
  });

  router.on('POST', '/api/me/password', async ({ req }) => {
    const user = auth(req, { session: true });
    const body = await readJson(req, 4096);
    await accountCall(() => accounts.changePassword(user.id, body.current, body.password));
    return { ok: true, note: 'password changed; log in again' };
  });

  router.on('GET', '/api/me/tokens', ({ req }) => {
    const user = auth(req, { session: true });
    return accounts.listApiTokens(user.id);
  });

  router.on('POST', '/api/me/tokens', async ({ req }) => {
    const user = auth(req, { session: true });
    const body = await readJson(req, 4096);
    return accountCall(() => accounts.createApiToken(user.id, body.label));
  });

  router.on('POST', '/api/me/tokens/:id/revoke', async ({ req, params }) => {
    const user = auth(req, { session: true });
    await accountCall(() => accounts.revokeApiToken(user.id, intParam(params.id)));
    return { ok: true };
  });

  // --- contributors (API token or browser session)

  router.on('GET', '/api/tasks', ({ req, query }) => {
    auth(req);
    return tasks.list({ state: query.get('state') ?? undefined, unit: query.get('unit') ?? undefined, limit: intParam(query.get('limit') ?? '50'), offset: intParam(query.get('offset') ?? '0') });
  });

  // Work responses carry the project's current policy for agents (guidance.js).
  const guided = (r) => withGuidance(store, r, { peerReviewFirstAt: config.peerReviewFirstAt ?? 100 });

  router.on('GET', '/api/tasks/:id', ({ req, params }) => {
    auth(req);
    return guided(tasks.context(intParam(params.id)));
  });

  // While the peer review queue is long, new work costs a few reviews first: verdicts are what
  // keeps finished work moving to main. Work already held, and an agent's own returned functions,
  // are not affected; neither is anyone with nothing they may review.
  const reviewFirst = (user) => {
    const at = config.peerReviewFirstAt ?? 100;
    const waiting = store.get(`SELECT COUNT(*) AS n FROM attempts WHERE state = 'peer_review'`).n;
    if (waiting <= at) return;
    if (store.get('SELECT 1 FROM users WHERE id = ? AND peer_review_blocked = 1', user.id)) return;
    if (!peers.available(user, 1).length) return;
    const need = config.reviewsPerClaim ?? 3;
    const lastClaim = store.get(`SELECT MAX(at) AS t FROM events WHERE user_id = ? AND type IN ('claim', 'claim_batch')`, user.id).t ?? 0;
    const done = store.get('SELECT COUNT(*) AS n FROM peer_reviews WHERE reviewer_id = ? AND created_at > ?', user.id, lastClaim).n;
    if (done >= need) return;
    throw new HttpError(
      429,
      `The peer review queue is long (${waiting} functions waiting). Do ${need - done} more peer review${need - done > 1 ? 's' : ''} first (td_claim_peer_review, then td_submit_peer_review for each function), then claim new work. Keep working on and submitting what you already hold.`,
    );
  };

  router.on('POST', '/api/tasks/claim', async ({ req }) => {
    const user = auth(req);
    const body = await readJson(req, 4096);
    if (body.taskId) {
      // Taking back one's own returned function is not new work.
      const own = store.get('SELECT 1 FROM tasks WHERE id = ? AND preferred_user = ? AND preferred_until > ?', intParam(body.taskId), user.id, Date.now());
      if (!own) reviewFirst(user);
      return guided(tasks.context(tasks.claim(user, intParam(body.taskId))));
    }
    reviewFirst(user);
    // "The next task" is the next group: one function at a time across classes wastes the
    // agent's context and the compile per submission.
    const ids = tasks.claimNext(user, 50);
    const others = ids.slice(1).map((id) => {
      const t = tasks.get(id);
      return { task: id, symbol: t.symbol_id };
    });
    return guided({
      ...tasks.context(ids[0]),
      alsoClaimed: others,
      note: groupNote(ids.length, tasks.lastGroup),
    });
  });

  // Organize before porting: put held functions that are in no source file yet into files.
  router.on('POST', '/api/tasks/place', async ({ req }) => {
    const user = auth(req);
    const body = await readJson(req, 64 * 1024);
    return guided(tasks.place(user, body.assignments));
  });

  router.on('POST', '/api/tasks/:id/heartbeat', ({ req, params }) => {
    const user = auth(req);
    return { leaseExpires: tasks.heartbeat(user, intParam(params.id)) };
  });

  router.on('POST', '/api/tasks/:id/release', ({ req, params }) => {
    const user = auth(req);
    tasks.release(user, intParam(params.id));
    return { ok: true };
  });

  router.on('POST', '/api/tasks/:id/submit', async ({ req, params }) => {
    const user = auth(req);
    submitLimiter.check(user.id);
    const taskId = intParam(params.id);
    const body = await readJson(req);
    const r = submitBatch(user, [taskId], body);
    return guided({ attemptId: r.attempts[0].attemptId, batchId: r.batchId, state: 'queued' });
  });

  // The repository stores LF line endings; submissions from Windows workspaces may carry CRLF.
  const lf = (files) => Object.fromEntries(Object.entries(files).map(([f, c]) => [f, typeof c === 'string' ? c.replace(/\r\n/g, '\n') : c]));

  /** Validates a submission body and queues it as one batch for the given tasks. */
  const submitBatch = (user, taskIds, body) => {
    if (typeof body.baseCommit !== 'string' || !/^[0-9a-f]{40}$/.test(body.baseCommit)) throw new HttpError(400, 'baseCommit must be a full commit hash');
    if (!body.files || typeof body.files !== 'object' || Array.isArray(body.files)) throw new HttpError(400, 'files must be an object of path -> content');
    body.files = lf(body.files);
    const r = tasks.submitBatch(user, {
      taskIds,
      baseCommit: body.baseCommit,
      files: body.files,
      notes: body.notes ? String(body.notes).slice(0, DEFAULT_LIMITS.maxNotesBytes) : null,
      agentMeta: body.agentMeta ? JSON.stringify(body.agentMeta).slice(0, 1000) : null,
      envDigest: body.envDigest ? String(body.envDigest).slice(0, 200) : null,
    });
    if (runsWorker) ctx.verifier.pump();
    return r;
  };

  // What to do with a claimed group; unplaced functions are organized into files first.
  const groupNote = (n, group) => {
    if (!group || n < 1) return undefined;
    if (group.kind === 'range') {
      return `These ${n} neighbouring functions are in no source file yet. Organize first: read them (td_decompile, td_disassemble; strings, __FILE__ in asserts and call targets show where they come from), decide which source file each belongs to (an existing one, or a new .cpp named after its class or subsystem), give them names if you can tell (Class::Method), and record that with td_place. Then port them file by file and submit as one batch.`;
    }
    return `You hold ${n} tasks of one ${group.kind} (${group.key}). Work through all of them, then submit them together as one batch (td_submit with every taskId).`;
  };

  // Bulk work: claim every open function of a unit (source file) or an address range, submit the
  // file once. Verified with one compile; merged as a whole.
  router.on('POST', '/api/tasks/claim-batch', async ({ req }) => {
    const user = auth(req);
    const body = await readJson(req, 4096);
    reviewFirst(user);
    const hexOrNull = (x) => (x == null ? null : typeof x === 'string' ? Number.parseInt(x, 16) : Number(x));
    const ids = tasks.claimBatch(user, { unit: body.unit ? String(body.unit) : null, start: hexOrNull(body.start), end: hexOrNull(body.end), limit: body.limit ? Number(body.limit) : 50 });
    const v = store.currentVersion();
    const ph = ids.map(() => '?').join(',');
    const rows = store.all(
      `SELECT t.id AS task, s.id AS symbol, s.name, s.unit, a.addr, a.size, t.state, t.best_score FROM tasks t JOIN symbols s ON s.id = t.symbol_id
         LEFT JOIN symbol_addresses a ON a.symbol_id = s.id AND a.version_id = ? WHERE t.id IN (${ph}) ORDER BY a.addr`,
      v.id, ...ids,
    );
    return guided({
      tasks: rows.map((r) => ({ ...r, addr: r.addr != null ? '0x' + hex(r.addr) : null, annotation: `// FUNCTION: ${r.symbol}` })),
      allowedPaths: tasks.allowedPathsForTasks(ids),
      baseCommit: repo.head(),
      group: body.unit || body.start != null ? undefined : tasks.lastGroup && { kind: tasks.lastGroup.kind, key: tasks.lastGroup.key, note: groupNote(ids.length, tasks.lastGroup) },
      note: 'Write or fix every function, check, then submit them together (td submit --all). Context of one task: GET /api/tasks/<id>.',
    });
  });

  router.on('POST', '/api/batches', async ({ req }) => {
    const user = auth(req);
    submitLimiter.check(user.id);
    const body = await readJson(req, 8 * 1024 * 1024);
    const r = submitBatch(user, (body.taskIds ?? []).map((x) => intParam(x)), body);
    return guided({ ...r, state: 'queued' });
  });

  router.on('GET', '/api/batches/:id', ({ req, params }) => {
    auth(req);
    const b = store.get('SELECT b.*, u.name AS author FROM batches b JOIN users u ON u.id = b.user_id WHERE b.id = ?', intParam(params.id));
    if (!b) throw new HttpError(404, 'no such batch');
    const result = b.result_json ? JSON.parse(b.result_json) : {};
    const attempts = store.all(
      `SELECT a.id, a.task_id, t.symbol_id, s.name, a.state, a.score, a.result_json FROM attempts a JOIN tasks t ON t.id = a.task_id JOIN symbols s ON s.id = t.symbol_id WHERE a.batch_id = ? ORDER BY a.id`,
      b.id,
    );
    return guided({
      id: b.id,
      author: b.author,
      state: b.state,
      baseCommit: b.base_commit,
      mergedCommit: b.merged_commit,
      returned: result.returned ?? null,
      mergeFailure: result.mergeFailure ?? null,
      changedHeaders: result.changedHeaders ?? [],
      changedOutside: result.outside ?? [],
      functions: attempts.map((a) => {
        const fb = a.result_json ? JSON.parse(a.result_json).feedback : null;
        return { attemptId: a.id, taskId: a.task_id, symbol: a.symbol_id, name: a.name, state: a.state, score: a.score, summary: fb?.summary ?? null, status: fb?.target?.status ?? null };
      }),
    });
  });

  router.on('POST', '/api/tasks/heartbeat-all', ({ req }) => {
    const user = auth(req);
    return tasks.heartbeatAll(user);
  });

  // The submitted definition of one function (annotations through the closing brace).
  function targetSource(id, files) {
    if (!id || !files) return null;
    for (const [file, text] of Object.entries(files)) {
      const r = functionRegions(text)?.get(id);
      if (r) return { file, line: r.start + 1, text: text.split('\n').slice(r.start, r.end).join('\n') };
    }
    return null;
  }

  router.on('GET', '/api/attempts/:id', ({ req, params }) => {
    const user = auth(req);
    const a = store.get('SELECT a.*, u.name AS author FROM attempts a JOIN users u ON u.id = a.user_id WHERE a.id = ?', intParam(params.id));
    if (!a) throw new HttpError(404, 'no such attempt');
    const result = a.result_json ? JSON.parse(a.result_json) : null;
    const batch = a.batch_id ? store.get('SELECT result_json FROM batches WHERE id = ?', a.batch_id) : null;
    const batchResult = batch?.result_json ? JSON.parse(batch.result_json) : {};
    const isReviewer = hasRole(user, 'reviewer');
    return {
      id: a.id,
      taskId: a.task_id,
      author: a.author,
      state: a.state,
      score: a.score,
      baseCommit: a.base_commit,
      createdAt: a.created_at,
      finishedAt: a.finished_at,
      notes: a.notes,
      feedback: result?.feedback ?? null,
      batchId: a.batch_id,
      mergeFailure: batchResult.mergeFailure ?? result?.mergeFailure ?? null,
      changedHeaders: batchResult.changedHeaders ?? result?.changedHeaders ?? [],
      files: store.attemptFiles(a),
      mergedFiles: isReviewer ? batchResult.mergedFiles ?? result?.mergedFiles ?? null : undefined,
      reviews: store.all('SELECT r.action, r.comment, r.created_at, u.name AS reviewer FROM reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.attempt_id = ?', a.id),
      peerReviews: peers.verdicts(a.id),
      peerRequired: peers.required,
      targetSource: targetSource(result?.feedback?.target?.id, batchResult.mergedFiles ?? store.attemptFiles(a)),
    };
  });

  router.on('POST', '/api/symbols', async ({ req }) => {
    const user = auth(req);
    symbolLimiter.check(user.id);
    const body = await readJson(req, 4096);
    const kind = String(body.kind ?? '');
    if (!['function', 'global', 'vtable', 'string'].includes(kind)) throw new HttpError(400, 'kind must be function, global, vtable or string');
    const addr = typeof body.addr === 'string' ? Number.parseInt(body.addr, 16) : Number(body.addr);
    if (!Number.isInteger(addr) || addr <= 0 || addr > 0xffffffff) throw new HttpError(400, 'addr must be a hex string like "0x5f1c30"');
    const pe = ctx.getPe();
    if (!pe.sectionForVa(addr)) throw new HttpError(400, `0x${hex(addr)} is not inside the target image`);
    if (kind === 'function' && !pe.isCode(addr)) throw new HttpError(400, 'functions must be in an executable section');
    if (kind !== 'function' && pe.isCode(addr) && kind !== 'string') throw new HttpError(400, `${kind} symbols cannot be in a code section`);
    const name = body.name ? String(body.name).slice(0, 200) : null;
    const v = store.currentVersion();
    const r = store.tx(() => store.ensureSymbol({ kind, versionId: v.id, addr, name, userId: user.id }));
    if (r.created) {
      store.event('symbol_created', user.id, { id: r.symbol.id, addr });
      if (kind === 'function') tasks.generate();
    } else if (r.symbol.kind !== kind) {
      throw new HttpError(409, `0x${hex(addr)} is already ${r.symbol.id} (${r.symbol.kind})`);
    }
    return { id: r.symbol.id, kind: r.symbol.kind, created: r.created, annotation: `// ${{ function: 'FUNCTION', global: 'GLOBAL', vtable: 'VTABLE', string: 'STRING' }[kind]}: ${r.symbol.id}` };
  });

  // --- the original function (assembly, pseudocode) for contributors without a local Ghidra.
  // Derived from the exe, so approved accounts only, like the exe itself.
  router.on('GET', '/api/original/:symbol', async ({ req, params }) => {
    auth(req);
    return ctx.originals.get(params.symbol);
  });

  // --- the server's Ghidra project of the current version (td ghidra download). Derived from the
  // exe, so approved accounts only.
  router.on('GET', '/api/ghidra-project', ({ req }) => {
    auth(req);
    const info = ctx.ghidra.info();
    if (!info) throw new HttpError(404, 'no Ghidra project has been built on this server yet');
    return { ...info, download: `${config.publicUrl}/api/ghidra-project/download` };
  });

  router.on('GET', '/api/ghidra-project/download', ({ req, res }) => {
    auth(req);
    const file = ctx.ghidra.packagePath();
    if (!file || !fs.existsSync(file)) throw new HttpError(404, 'no Ghidra project has been built on this server yet');
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': fs.statSync(file).size, 'content-disposition': 'attachment; filename="ghidra-project.tar.gz"' });
    fs.createReadStream(file).pipe(res);
    return undefined;
  });

  // --- remote check: compile and compare in the server's sandbox without submitting
  // (contributors without a local MSVC toolchain). Same static gate as a submission.

  const checkLimiter = new RateLimiter(config.checksPerHour ?? 60, 3600_000);

  router.on('POST', '/api/check', async ({ req, res }) => {
    const user = auth(req);
    checkLimiter.check(user.id);
    const body = await readJson(req);
    if (typeof body.baseCommit !== 'string' || !/^[0-9a-f]{40}$/.test(body.baseCommit)) throw new HttpError(400, 'baseCommit must be a full commit hash');
    if (!body.files || typeof body.files !== 'object' || Array.isArray(body.files)) throw new HttpError(400, 'files must be an object of path -> content');
    body.files = lf(body.files);
    const allowed = [...project.sourceDirs.map((d) => `${d}/**`)];
    const lintErrors = lintSubmission(body.files, { allowedPaths: allowed, limits: project.lintLimits, allowedPragmas: project.allowedPragmas });
    if (lintErrors.length) return { gate: 'rejected', lintErrors };
    if (!repo.isAncestor(body.baseCommit)) throw new HttpError(409, 'your base commit is not part of main; run td sync');
    const textErrors = ctx.verifier.freeTextGate(body.files, body.baseCommit);
    if (textErrors.length) return { gate: 'rejected', lintErrors: textErrors };
    const merged = repo.mergeOntoHead(body.baseCommit, body.files);
    if (merged.conflicts.length) return { gate: 'conflict', conflicts: merged.conflicts };
    const gone = new AbortController();
    res.on('close', () => res.writableFinished || gone.abort());
    try {
      return guided(await ctx.checks.run(user.id, merged.files, { signal: gone.signal }));
    } catch (e) {
      throw new HttpError(503, e.message, e instanceof WorkerUnavailable ? { retryAfterSeconds: 120 } : undefined);
    }
  });

  // --- peer review (agents, API token or session)

  router.on('GET', '/api/peer-reviews', ({ req, query }) => {
    const user = auth(req);
    return peers.available(user, intParam(query.get('limit') ?? '20'));
  });

  router.on('POST', '/api/peer-reviews/claim', async ({ req }) => {
    const user = auth(req);
    const body = await readJson(req, 4096);
    return peers.claim(user, body.attemptId ? intParam(body.attemptId) : null);
  });

  router.on('GET', '/api/peer-reviews/:id', ({ req, params }) => {
    auth(req);
    return peers.context(intParam(params.id));
  });

  // A bulk review: all verdicts of a claimed group in one call.
  router.on('POST', '/api/peer-reviews/verdicts', async ({ req }) => {
    const user = auth(req);
    const body = await readJson(req, 512 * 1024);
    return { results: peers.submitMany(user, body.verdicts, body.agentMeta) };
  });

  router.on('POST', '/api/peer-reviews/:id/verdict', async ({ req, params }) => {
    const user = auth(req);
    const body = await readJson(req, 16 * 1024);
    return peers.submit(user, intParam(params.id), String(body.verdict ?? ''), body.reason, body.agentMeta);
  });

  router.on('POST', '/api/peer-reviews/:id/release', ({ req, params }) => {
    const user = auth(req);
    peers.release(user, intParam(params.id));
    return { ok: true };
  });

  // --- reviewers

  router.on('GET', '/api/review/queue', ({ req }) => {
    const user = auth(req, { role: 'reviewer', session: true });
    return store.all(
      `SELECT a.id, a.batch_id, a.task_id, a.state, a.score, a.created_at, a.finished_at, u.name AS author, t.symbol_id, s.name,
              (SELECT COUNT(*) FROM reviews r WHERE r.attempt_id = a.id AND r.action = 'approve') AS approvals,
              (SELECT COUNT(*) FROM reviews r WHERE r.attempt_id = a.id AND r.reviewer_id = ?) AS reviewed_by_me,
              (SELECT COUNT(*) FROM peer_reviews p WHERE p.attempt_id = a.id AND p.verdict = 'same') AS peer_same,
              (SELECT COUNT(*) FROM peer_reviews p WHERE p.attempt_id = a.id AND p.verdict = 'different') AS peer_different,
              (SELECT COUNT(*) FROM peer_leases l WHERE l.attempt_id = a.id AND l.expires_at > ?) AS peer_working
         FROM attempts a JOIN users u ON u.id = a.user_id JOIN tasks t ON t.id = a.task_id JOIN symbols s ON s.id = t.symbol_id
        WHERE a.state IN ('in_review', 'peer_review') ORDER BY a.state = 'peer_review', a.finished_at`,
      user.id,
      Date.now(),
    );
  });

  // Functions merged although a peer said "different", for a human to look at later.
  router.on('GET', '/api/review/later', ({ req }) => {
    auth(req, { role: 'reviewer', session: true });
    return store.all(
      `SELECT l.id, l.symbol_id, s.name, l.attempt_id, l.objections, l.merged_commit, l.created_at, u.name AS author
         FROM later_review l JOIN symbols s ON s.id = l.symbol_id JOIN attempts a ON a.id = l.attempt_id JOIN users u ON u.id = a.user_id
        WHERE l.cleared_at IS NULL ORDER BY l.id`,
    );
  });

  router.on('POST', '/api/review/later/:id/clear', ({ req, params }) => {
    const user = auth(req, { role: 'reviewer', session: true });
    const r = store.run('UPDATE later_review SET cleared_by = ?, cleared_at = ? WHERE id = ? AND cleared_at IS NULL', user.id, Date.now(), intParam(params.id));
    if (!r.changes) throw new HttpError(404, 'nothing to clear');
    return { ok: true };
  });

  router.on('POST', '/api/attempts/:id/review', async ({ req, params }) => {
    const user = auth(req, { role: 'reviewer', session: true });
    const body = await readJson(req, 16 * 1024);
    const r = merger.review(user, intParam(params.id), String(body.action ?? ''), body.comment ? String(body.comment) : null, { skipPeerReview: body.skipPeerReview === true });
    if (r.state === 'approved' && runsWorker) setImmediate(() => merger.pump().catch(() => {}));
    return r;
  });

  // One click for a whole batch: every function of it that waits for a human.
  router.on('POST', '/api/batches/:id/review', async ({ req, params }) => {
    const user = auth(req, { role: 'reviewer', session: true });
    const body = await readJson(req, 16 * 1024);
    const attemptIds = Array.isArray(body.attemptIds) ? body.attemptIds.map((x) => intParam(x)) : null;
    const r = merger.reviewBatch(user, intParam(params.id), String(body.action ?? ''), body.comment ? String(body.comment) : null, { attemptIds, skipPeerReview: body.skipPeerReview === true });
    if (runsWorker) setImmediate(() => merger.pump().catch(() => {}));
    return r;
  });

  // --- maintainers and admins (browser session only)

  router.on('POST', '/api/admin/tasks/:id', async ({ req, params }) => {
    auth(req, { role: 'maintainer', session: true });
    const body = await readJson(req, 4096);
    const t = tasks.get(intParam(params.id));
    if (body.priority !== undefined) store.run('UPDATE tasks SET priority = ? WHERE id = ?', Number(body.priority) | 0, t.id);
    if (body.state === 'open' && t.state !== 'done') tasks.reopen(t.id);
    return tasks.get(t.id);
  });

  router.on('GET', '/api/admin/users', ({ req, query }) => {
    auth(req, { role: 'admin', session: true });
    return { roles: ROLES, users: accounts.listUsers(query.get('status') ?? undefined), work: claimedWork(), reviewers: reviewerStats(store) };
  });

  // What each user currently holds, by name: leased tasks grouped by unit, peer reviews, submitted batches in flight.
  function claimedWork() {
    const work = {};
    const names = new Map(store.all('SELECT id, name FROM users').map((u) => [u.id, u.name]));
    const of = (id) => (work[names.get(id)] ??= { units: [], tasks: 0, expires: null, peerReviews: 0, batches: 0, lastTokenUse: null });
    for (const r of store.all(
      `SELECT t.lease_user AS user_id, s.unit, COUNT(*) AS n, MIN(t.lease_expires) AS expires
         FROM tasks t JOIN symbols s ON s.id = t.symbol_id
        WHERE t.state = 'leased' GROUP BY t.lease_user, s.unit ORDER BY n DESC`,
    )) {
      const w = of(r.user_id);
      w.units.push({ unit: r.unit ?? '(no unit)', tasks: r.n });
      w.tasks += r.n;
      w.expires = w.expires === null ? r.expires : Math.min(w.expires, r.expires);
    }
    for (const r of store.all(`SELECT reviewer_id, COUNT(DISTINCT attempt_id) AS n FROM peer_leases WHERE expires_at > ? GROUP BY reviewer_id`, Date.now()))
      of(r.reviewer_id).peerReviews = r.n;
    for (const r of store.all(`SELECT user_id, COUNT(*) AS n FROM batches WHERE state IN ('queued', 'verifying', 'open', 'merging') GROUP BY user_id`))
      of(r.user_id).batches = r.n;
    for (const r of store.all(`SELECT user_id, MAX(last_used_at) AS t FROM api_tokens GROUP BY user_id`)) if (r.t) of(r.user_id).lastTokenUse = r.t;
    return work;
  }

  const ADMIN_ACTIONS = {
    approve: (name, admin) => accounts.approve(name, admin.id),
    reject: (name, admin) => accounts.reject(name, admin.id),
    revoke: (name, admin) => accounts.revoke(name, admin.id),
    reinstate: (name, admin) => accounts.reinstate(name, admin.id),
    // Pause or allow an account's peer reviews (e.g. rubber-stamping); its existing verdicts stay.
    'block-reviews': (name, admin) => setReviewBlock(name, 1, admin),
    'allow-reviews': (name, admin) => setReviewBlock(name, 0, admin),
  };
  const setReviewBlock = (name, blocked, admin) => {
    const u = accounts.byName(name);
    if (!u) throw new HttpError(404, 'no such user');
    store.run('UPDATE users SET peer_review_blocked = ? WHERE id = ?', blocked, u.id);
    if (blocked) store.run('DELETE FROM peer_leases WHERE reviewer_id = ?', u.id);
    store.event(blocked ? 'reviews_blocked' : 'reviews_allowed', admin.id, { name });
    return { name, peerReviewsBlocked: !!blocked };
  };
  router.on('POST', '/api/admin/users/:name/:action', async ({ req, params }) => {
    const admin = auth(req, { role: 'admin', session: true });
    if (params.action === 'role') {
      const body = await readJson(req, 4096);
      return accountCall(() => accounts.setRole(params.name, String(body.role ?? ''), admin.id));
    }
    const fn = ADMIN_ACTIONS[params.action];
    if (!fn) throw new HttpError(404, 'unknown action');
    return accountCall(() => fn(params.name, admin));
  });

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/repo.git/')) {
        return serveGit(req, res, { projectRoot: config.dataDir, subPath: '/repo' + url.pathname.slice('/repo.git'.length), query: url.searchParams });
      }
      if (req.method === 'GET' && (url.pathname === '/install.ps1' || url.pathname === '/install.sh')) {
        const script = url.pathname.endsWith('.ps1') ? installPs1(config, project) : installSh(config, project);
        if (!script) throw new HttpError(503, 'the td binaries are not published on this server yet');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
        return res.end(script);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/download/')) return serveDownload(url.pathname.slice(10), req, res);
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
      const m = router.match(req.method, url.pathname);
      if (!m) throw new HttpError(404, 'not found');
      const result = await m.handler({ req, res, params: m.params, query: url.searchParams });
      if (result !== undefined) sendJson(res, 200, result);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) sendJson(res, e.status, { error: e.message, details: e.details });
      else {
        console.error(e);
        sendJson(res, 500, { error: 'internal error' });
      }
    }
  };
  return http.createServer(handler);
}

// Public downloads of the td binaries (tools/build-td output copied to <dataDir>/downloads).
const DOWNLOADS = new Set(['td-windows-x64.exe', 'td-linux-x64', 'SHA256SUMS']);
let downloadsRoot = null;
function serveDownload(name, req, res) {
  const file = DOWNLOADS.has(name) && downloadsRoot ? path.join(downloadsRoot, name) : null;
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  // A compressed copy (made when the binaries are published) for clients that accept gzip: td's
  // self-update and the Linux installer; about a third of the size.
  const gz = file + '.gz';
  const zipped = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) && fs.existsSync(gz) && fs.statSync(gz).mtimeMs >= fs.statSync(file).mtimeMs;
  const sent = zipped ? gz : file;
  res.writeHead(200, {
    'content-type': name === 'SHA256SUMS' ? 'text/plain' : 'application/octet-stream',
    'content-length': fs.statSync(sent).size,
    'content-disposition': `attachment; filename="${name}"`,
    'x-content-type-options': 'nosniff',
    vary: 'accept-encoding',
    ...(zipped ? { 'content-encoding': 'gzip' } : {}),
  });
  fs.createReadStream(sent).pipe(res);
}

const STATIC = { '/': 'index.html', '/review': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/favicon.svg': 'favicon.svg' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function serveStatic(pathname, res) {
  const file = STATIC[pathname];
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)],
    'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(path.join(WEB_DIR, file)).pipe(res);
}

/**
 * role "web": website, API and git; "worker": verification, merges, remote checks and the Ghidra
 * refresh; "all": both in one process. The two share only the database and the repository, so
 * either restarts without interrupting the other.
 */
export async function startServer(dataDir, { role = 'all' } = {}) {
  if (!['all', 'web', 'worker'].includes(role)) throw new Error(`unknown role ${role}; use web, worker or all`);
  const ctx = openServer(dataDir);
  ctx.runsWorker = role !== 'web';
  // deploy/update.sh keeps the releases running processes were started from.
  try {
    fs.writeFileSync(path.join(ctx.config.dataDir, `release-${role}.txt`), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..') + '\n');
  } catch {}
  const stops = [];
  if (role !== 'web') {
    ctx.tasks.generate();
    // Put unplaced functions where their neighbours or class already are; again every half hour.
    const place = () => {
      try {
        const n = inferUnits(ctx.store);
        if (n) console.log(`placed ${n} function(s) in the files of their neighbours or class`);
      } catch (e) {
        console.error(`placing functions: ${e.message}`);
      }
    };
    place();
    const placer = setInterval(place, 30 * 60_000);
    stops.push(() => clearInterval(placer));
    ctx.verifier.start();
    ctx.merger.start();
    ctx.checks.start();
    stops.push(() => ctx.verifier.stop(), () => ctx.merger.stop(), () => ctx.checks.stop());
    console.log(`clank together worker running (${role})`);
  }
  let server = null;
  if (role !== 'worker') {
    const sweeper = setInterval(() => { try { ctx.tasks.sweepExpired(); } catch (e) { console.error(`lease sweep: ${e.message}`); } }, 60_000);
    stops.push(() => clearInterval(sweeper));
    server = createApp(ctx);
    await new Promise((r) => server.listen(ctx.config.listen.port, ctx.config.listen.host, r));
    console.log(`clank together coordinator listening on http://${ctx.config.listen.host}:${ctx.config.listen.port} (public url ${ctx.config.publicUrl})`);
  }
  // The web side exits quickly: requests still open (an agent waiting on a remote check can wait
  // for minutes) are cut off after a moment; agents retry. The worker drains: it takes no new work
  // and exits once its running verifications, merges and checks are done, so nothing is redone.
  const busy = () => ctx.runsWorker && (ctx.verifier.running > 0 || ctx.merger.busy || ctx.checks.running > 0);
  const exitWhenIdle = () => (busy() ? setTimeout(exitWhenIdle, 1000) : process.exit(0));
  const shutdown = () => {
    for (const stop of stops) stop();
    if (busy()) console.log('stopping: finishing the running work first');
    if (!server) return exitWhenIdle();
    server.close();
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
      exitWhenIdle();
    }, 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { ctx, server };
}
