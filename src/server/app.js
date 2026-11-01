// Coordinator server: wires storage, repo, tasks, verifier and merger to the HTTP API.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store, now } from './db.js';
import { Accounts, AccountError, hasRole, ROLES } from './accounts.js';
import { Repo, serveGit } from './git.js';
import { Tasks, untrusted } from './tasks.js';
import { Verifier } from './verify.js';
import { Merger } from './merge.js';
import { Maintenance } from './maintenance.js';
import { PeerReviews } from './peer.js';
import { Originals } from './original.js';
import { downloadsDir, installPs1, installSh, publishedBuilds } from './install.js';
import { ServerGhidra } from './ghidra.js';
import { functionRegions } from './split.js';
import { CheckQueue, WorkerUnavailable } from './checks.js';
import { withGuidance } from './guidance.js';
import { reviewerStats } from './reviewers.js';
import { inferUnits } from './grouping.js';
import { Router, HttpError, readJson, sendJson, RateLimiter } from './http.js';
import { Regions } from './regions.js';
import { Credits, SLOT_TABLE } from './credits.js';
import { Live } from './live.js';
import { Quality, LIMITS } from './quality.js';
import { Trust } from './trust.js';
import { PEImage } from '../shared/pe.js';
import { loadProject, loadToolchainLock } from '../shared/project.js';
import { DEFAULT_LIMITS, lintSubmission } from '../shared/lint.js';
import { hex } from '../shared/annotations.js';
import { GHIDRA_RELEASE } from '../shared/ghidra.js';

// TD_WEB_DIR points through the release symlink in production, so new pages are live without a restart.
const WEB_DIR = process.env.TD_WEB_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');

export const DEFAULT_CONFIG = {
  listen: { host: '127.0.0.1', port: 8080 },
  publicUrl: 'http://127.0.0.1:8080',
  leaseMinutes: 120,
  maxLeaseHours: 2, // a lease ends this long after it was taken, whatever the heartbeats; the sweeper releases older ones
  maxLeasedTasks: 50, // functions one account may hold; the sweeper releases any above it
  maxTasksPerSubmission: 500,
  maxLeasesPerUser: 3,
  verifyConcurrency: 3,
  remoteChecks: false, // checks compile on the contributor's machine (td toolchain install)
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
  // Web and worker share Git, not JS objects. Never read half of a working-tree FF.
  const projectHead = config.pushRemote ? store.getMeta('repository_project_head') ?? repo.head() : null;
  const readProjectFile = projectHead ? (file) => repo.showMany(projectHead, [file]).get(file) : undefined;
  const project = loadProject(repo.dir, readProjectFile);
  config.toolchainLock = loadToolchainLock(repo.dir, readProjectFile);
  config.envDigest = config.toolchainLock[project.toolchain]?.clSha256 ?? null;

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
  const regions = new Regions({ store, config, repo, tasks });
  tasks.regions = regions;
  const quality = new Quality({ store });
  tasks.quality = quality;
  regions.quality = quality;
  const trust = new Trust({ store, project });
  const peers = new PeerReviews({ store, project, trust });
  const verifier = new Verifier({ store, config, repo, project, tasks, getPe, peers, trust, log });
  verifier.regions = regions;
  verifier.projectHead = projectHead;
  const merger = new Merger({ store, config, repo, project, tasks, verifier, getPe, peers, log });
  const accounts = new Accounts(store);
  const originals = new Originals({ store });
  const ghidra = new ServerGhidra({ config, store, originals, log });
  merger.onMerged = (commit) => ghidra.scheduleRefresh(commit);
  const maintenance = new Maintenance({ store, repo, project, verifier, merger, log });
  verifier.maintenance = maintenance;
  const checks = new CheckQueue({ store, repo, verifier, config, log });
  verifier.merger = merger;
  verifier.checks = checks;
  const credits = new Credits({ store });
  return { config, store, repo, project, tasks, regions, quality, trust, credits, verifier, merger, maintenance, getPe, accounts, peers, originals, ghidra, checks };
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
      toolchainLock: config.pushRemote ? config.toolchainLock : loadToolchainLock(repo.dir),
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
    // A correction revision invalidates cached snapshots in every web process and version.
    const { body, etag } = cached(`symbols:${v.id}`, 60_000, () => {
      const rows = [...store.symbolMap(v.id).values()].map((s) => [s.id, s.kind, s.addr, s.size, s.name, s.decorated, s.library ? 1 : 0, s.unit]);
      const json = JSON.stringify({ version: v.id, columns: ['id', 'kind', 'addr', 'size', 'name', 'decorated', 'library', 'unit'], symbols: rows });
      return { body: json, etag: `"${crypto.createHash('sha1').update(json).digest('hex')}"` };
    }, store.getMeta('symbolCorrectionsRevision'));
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
  const cached = (key, ttl, compute, revision = null) => {
    const hit = shared.get(key);
    if (hit && hit.revision === revision && Date.now() - hit.at < ttl) return hit.value;
    const value = compute();
    shared.set(key, { at: Date.now(), value, revision });
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

  router.on('GET', '/api/progress', () => progressData());
  const progressData = () => cached('progress', 20_000, () => {
    // Functions accepted as needing no decompilation (thunks, runtime library, ...) do not count.
    const total = store.get(`SELECT COUNT(*) AS n, COALESCE(SUM(a.size), 0) AS bytes FROM symbols s JOIN symbol_addresses a ON a.symbol_id = s.id JOIN versions v ON v.id = a.version_id AND v.is_current = 1 WHERE s.kind = 'function' AND s.library = 0 AND s.skip_reason IS NULL`);
    const byStatus = store.all(`SELECT fs.status, COUNT(*) AS n, COALESCE(SUM(a.size), 0) AS bytes FROM func_status fs JOIN symbol_addresses a ON a.symbol_id = fs.symbol_id JOIN versions v ON v.id = a.version_id AND v.is_current = 1 GROUP BY fs.status`);
    const byTaskState = store.all('SELECT state, COUNT(*) AS n FROM tasks GROUP BY state');
    const contributors = store.all(`SELECT u.name, COUNT(*) AS merged FROM attempts a JOIN users u ON u.id = a.user_id WHERE a.state = 'merged' GROUP BY u.id ORDER BY merged DESC LIMIT 20`);
    const confirmed = store.get(`SELECT COUNT(*) AS n, COALESCE(SUM(a.size), 0) AS bytes FROM func_status fs JOIN symbol_addresses a ON a.symbol_id = fs.symbol_id JOIN versions v ON v.id = a.version_id AND v.is_current = 1 WHERE fs.confirmed = 1 AND fs.status NOT IN ('exact', 'match_unresolved')`);
    const peerQueue = store.get("SELECT COUNT(*) AS n FROM attempts WHERE state = 'peer_review'").n;
    // Functions merged into main per hour: the last hour, and the average over the last day.
    const mergedSince = (ms) => store.get(`SELECT COALESCE(SUM(json_extract(data, '$.functions')), 0) AS n FROM events WHERE type = 'merged' AND at > ?`, Date.now() - ms).n;
    // Bytes of the original those merges cover (the functions of each merged batch).
    const bytesSince = (ms) =>
      store.get(
        // The merged batches first, so the attempts are found by batch (an index), not by scanning.
        `WITH b AS MATERIALIZED (SELECT DISTINCT json_extract(data, '$.batch') AS id FROM events WHERE type = 'merged' AND at > ?)
         SELECT COALESCE(SUM(sa.size), 0) AS n FROM b JOIN attempts at ON at.batch_id = b.id AND at.state = 'merged'
           JOIN tasks t ON t.id = at.task_id JOIN symbol_addresses sa ON sa.symbol_id = t.symbol_id JOIN versions v ON v.id = sa.version_id AND v.is_current = 1`,
        Date.now() - ms,
      ).n;
    const merges = { lastHour: mergedSince(3600_000), perHourDay: mergedSince(24 * 3600_000) / 24, bytesLastHour: bytesSince(3600_000), bytesPerHourDay: bytesSince(24 * 3600_000) / 24 };
    return { functions: total.n, bytes: total.bytes, byStatus, confirmed, peerQueue, byTaskState, contributors, merges };
  });

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
    // Functions of claimed regions that another agent holds: this agent may submit its own
    // candidates for them (regions.js).
    const shared = ctx.regions.sharedTasks(user, new Set(leases));
    return {
      name: user.name,
      role: user.role,
      via: user.via,
      leases,
      leasedSymbols: leases.length ? store.all(`SELECT id AS taskId, symbol_id AS symbol FROM tasks WHERE lease_user = ? AND state = 'leased'`, user.id) : [],
      leasedAllowedPaths: leases.length ? tasks.allowedPathsForTasks(leases) : [],
      regions: ctx.regions.mine(user).map((r) => ({ kind: r.kind, key: r.key, expires: r.expires_at })),
      regionTasks: shared,
      quality: (() => {
        // An agent sees its own level; the owner on the website the worst of their agents.
        if (user.via !== 'token') {
          const rank = { ok: 0, limited: 1, paused: 2 };
          const all = ctx.store.all('SELECT id FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL', user.id).map((t) => ctx.quality.of(user.id, t.id));
          const worst = all.reduce((w, q) => (rank[q.level] > rank[w] ? q.level : w), 'ok');
          return { level: worst, agents: all.length, limitedAgents: all.filter((q) => q.level !== 'ok').length };
        }
        const q = ctx.quality.of(user.id, user.tokenId);
        return { level: q.level, reasons: q.reasons, ...(q.level !== 'ok' ? { note: Quality.advice(q) } : {}) };
      })(),
      regionAllowedPaths: shared.length ? tasks.allowedPathsForTasks(shared.slice(0, 500).map((t) => t.taskId)) : [],
    };
  });

  // Which units include these headers (to compile them all locally before submitting a header change).
  router.on('POST', '/api/includers', async ({ req }) => {
    auth(req);
    const body = await readJson(req, 64 * 1024);
    const headers = (Array.isArray(body.headers) ? body.headers : []).slice(0, 200).map(String);
    return { includers: Object.fromEntries(headers.map((h) => [h, ctx.verifier.includersOf([h])])) };
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
    // Counted over the last hour, not since the last claim: an agent that reviews a lot may claim
    // several times in a row.
    const per = config.reviewsPerClaim ?? 3;
    const since = Date.now() - 3600_000;
    const claims = store.get(`SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND type IN ('claim', 'claim_batch', 'region_claim') AND at > ?`, user.id, since).n;
    const done = store.get('SELECT COUNT(*) AS n FROM peer_reviews WHERE reviewer_id = ? AND created_at > ?', user.id, since).n;
    const need = Math.min(per, (claims + 1) * per - done);
    if (need <= 0) return;
    throw new HttpError(
      429,
      `The peer review queue is long (${waiting} functions waiting). Do ${need} more peer review${need > 1 ? 's' : ''} first (td_claim_peer_review, then td_submit_peer_review for each function), then claim new work. Keep working on and submitting what you already hold.`,
    );
  };

  router.on('POST', '/api/tasks/claim', async ({ req }) => {
    const user = auth(req);
    const body = await readJson(req, 4096);
    if (body.taskId) {
      // Single functions only to fix one that came back; new work is claimed by region.
      const t = tasks.get(intParam(body.taskId));
      if (!['needs_cleanup', 'hard'].includes(t.state)) throw new HttpError(409, 'claim new work by region: td_regions, then td_claim_region (a single function can only be claimed to fix one that came back)');
      const own = store.get('SELECT 1 FROM tasks WHERE id = ? AND preferred_user = ? AND preferred_until > ?', t.id, user.id, Date.now());
      if (!own) reviewFirst(user);
      return guided(tasks.context(tasks.claim(user, t.id)));
    }
    reviewFirst(user);
    // "The next work" is the best free region, as a whole.
    return guided(claimBestRegion(user));
  });

  const claimBestRegion = (user) => {
    const pick = ctx.regions.list({ user, free: true, limit: 1 }).regions[0] ?? ctx.regions.list({ user, limit: 1 }).regions[0];
    if (!pick) throw new HttpError(404, 'no open regions');
    const r = ctx.regions.claim(user, { kind: 'unit', key: pick.key });
    return { ...r, baseCommit: repo.head(), note: 'Claimed the best free region for you. Next time pick one yourself: td_regions, then td_claim_region.' };
  };

  // "No decompile": held functions claimed to need no source; peer reviewed like code.
  router.on('POST', '/api/tasks/no-decompile', async ({ req }) => {
    const user = auth(req);
    const body = await readJson(req, 128 * 1024);
    return guided(tasks.markNoDecompile(user, body.items));
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
    submitLimiter.ensure(user.id);
    const taskId = intParam(params.id);
    const body = await readJson(req);
    const r = submitBatch(user, [taskId], body);
    submitLimiter.record(user.id);
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
      confirm: Array.isArray(body.confirm) ? body.confirm.filter((x) => /^fn_\d+$/.test(String(x))) : [],
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
    // Retired: work is claimed by region. A file becomes its region; nothing else is handed out.
    if (body.start != null || body.end != null) throw new HttpError(410, 'address ranges are retired: claim a region (td_regions, then td_claim_region)');
    if (!body.unit) return guided(claimBestRegion(user));
    const claimed = ctx.regions.claim(user, { kind: 'unit', key: String(body.unit) });
    const ids = claimed.leased;
    if (!ids.length) return guided({ ...claimed, baseCommit: repo.head(), tasks: [], note: 'nothing open to lease in that file (it may be shared: you can still submit candidates for its functions)' });
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
      region: claimed.region,
      alsoClaimedBy: claimed.alsoClaimedBy,
      note: 'Write or fix every function, check, then submit them together (td submit). Context of one task: GET /api/tasks/<id>.',
    });
  });

  router.on('POST', '/api/batches', async ({ req }) => {
    const user = auth(req);
    submitLimiter.ensure(user.id);
    const body = await readJson(req, 8 * 1024 * 1024);
    const r = submitBatch(user, (body.taskIds ?? []).map((x) => intParam(x)), body);
    submitLimiter.record(user.id);
    return guided({ ...r, state: 'queued' });
  });

  // Structural source changes with no function tasks (maintenance.js): maintainers only. Verified
  // like any batch; merged only when no function's compiled code changes.
  router.on('POST', '/api/maintenance', async ({ req }) => {
    const user = auth(req, { role: 'maintainer' });
    const body = await readJson(req, 8 * 1024 * 1024);
    if (typeof body.baseCommit !== 'string' || !/^[0-9a-f]{40}$/.test(body.baseCommit)) throw new HttpError(400, 'baseCommit must be a full commit hash');
    if (!body.files || typeof body.files !== 'object' || Array.isArray(body.files)) throw new HttpError(400, 'files must be an object of path -> content');
    if (body.force === true && !hasRole(user, 'admin')) throw new HttpError(403, 'only admins can force a maintenance batch past lower scores or changed code');
    const r = ctx.maintenance.submit(user, { baseCommit: body.baseCommit, files: lf(body.files), notes: body.notes ? String(body.notes).slice(0, DEFAULT_LIMITS.maxNotesBytes) : null, force: body.force === true });
    if (runsWorker) ctx.verifier.pump();
    return guided(r);
  });

  // Every batch, newest first: the website's Batches page, so batches sent back at a gate are visible too.
  router.on('GET', '/api/batches', ({ req, query }) => {
    auth(req);
    const where = [];
    const args = [];
    const states = (query.get('state') ?? '').split(',').filter(Boolean);
    if (states.length) {
      where.push(`b.state IN (${states.map(() => '?').join(',')})`);
      args.push(...states);
    }
    const attemptStates = (query.get('attemptState') ?? '').split(',').filter(Boolean);
    if (attemptStates.length) {
      where.push(`EXISTS (SELECT 1 FROM attempts a WHERE a.batch_id = b.id AND a.state IN (${attemptStates.map(() => '?').join(',')}))`);
      args.push(...attemptStates);
    }
    if (query.get('author')) {
      where.push('u.name = ? COLLATE NOCASE');
      args.push(query.get('author'));
    }
    if (query.get('before')) {
      where.push('b.id < ?');
      args.push(intParam(query.get('before')));
    }
    const limit = Math.min(200, Math.max(1, intParam(query.get('limit') ?? '50')));
    const rows = store.all(
      `SELECT b.id, b.kind, b.state, b.created_at, b.finished_at, b.merged_commit, b.notes, b.result_json, u.name AS author
         FROM batches b JOIN users u ON u.id = b.user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY b.id DESC LIMIT ?`,
      ...args,
      limit,
    );
    const counts = new Map(rows.map((b) => [b.id, {}]));
    if (rows.length) {
      const ids = rows.map((b) => b.id);
      for (const c of store.all(`SELECT batch_id, state, COUNT(*) AS n FROM attempts WHERE batch_id IN (${ids.map(() => '?').join(',')}) GROUP BY batch_id, state`, ...ids)) {
        counts.get(c.batch_id)[c.state] = c.n;
      }
    }
    return rows.map((b) => {
      const result = b.result_json ? JSON.parse(b.result_json) : {};
      return {
        id: b.id,
        kind: b.kind,
        author: b.author,
        state: b.state,
        createdAt: b.created_at,
        finishedAt: b.finished_at,
        mergedCommit: b.merged_commit,
        notes: b.notes,
        returned: result.returned ?? null,
        mergeFailure: result.mergeFailure ?? null,
        functions: counts.get(b.id),
      };
    });
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
      kind: b.kind,
      author: b.author,
      state: b.state,
      ...(b.kind === 'maintenance' && { result: result }),
      baseCommit: b.base_commit,
      mergedCommit: b.merged_commit,
      notes: b.notes,
      createdAt: b.created_at,
      finishedAt: b.finished_at,
      files: Object.keys(JSON.parse(b.files_json)),
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

  // The caller's functions that came back and still need work: the latest attempt of each task,
  // sent back, gate-rejected or returned with its batch, while the task is not done. Grouped by batch.
  router.on('GET', '/api/me/returned', ({ req, query }) => {
    const user = auth(req);
    const since = query.get('since') ? intParam(query.get('since')) : 0;
    const limit = Math.min(500, Math.max(1, intParam(query.get('limit') ?? '200')));
    const rows = store.all(
      `SELECT a.id, a.batch_id, a.task_id, a.state, a.score, a.finished_at, a.result_json, t.symbol_id, t.state AS task_state, t.cleanup_cycles,
              s.name, s.unit, lu.name AS holder, b.result_json AS batch_result
         FROM attempts a JOIN tasks t ON t.id = a.task_id JOIN symbols s ON s.id = t.symbol_id
         LEFT JOIN users lu ON lu.id = t.lease_user AND t.state = 'leased'
         LEFT JOIN batches b ON b.id = a.batch_id
        WHERE a.user_id = ? AND a.state IN ('needs_cleanup', 'rejected', 'returned') AND COALESCE(a.finished_at, a.created_at) >= ?
          AND t.state IN ('open', 'leased', 'needs_cleanup', 'hard')
          AND NOT EXISTS (SELECT 1 FROM attempts n WHERE n.task_id = a.task_id AND n.id > a.id)
        ORDER BY a.batch_id DESC, a.id LIMIT ?`,
      user.id, since, limit,
    );
    const batches = new Map();
    for (const r of rows) {
      if (!batches.has(r.batch_id)) {
        const br = r.batch_result ? JSON.parse(r.batch_result) : {};
        batches.set(r.batch_id, { batchId: r.batch_id, returned: br.returned ?? null, functions: [] });
      }
      const res = r.result_json ? JSON.parse(r.result_json) : {};
      const fb = res.feedback ?? {};
      batches.get(r.batch_id).functions.push({
        attemptId: r.id,
        taskId: r.task_id,
        symbol: r.symbol_id,
        name: r.name,
        unit: r.unit,
        state: r.state,
        score: r.score,
        taskState: r.task_state,
        holder: r.holder ?? null,
        cleanupCycles: r.cleanup_cycles,
        finishedAt: r.finished_at,
        summary: fb.summary ?? res.returned ?? null,
        peerOutcome: res.peerOutcome ?? null,
        peerDifferent: peers.verdicts(r.id).filter((v) => v.verdict === 'different').map((v) => ({ reviewer: v.reviewer, reason: v.reason })),
        reviewerComments: store.all(`SELECT r.action, r.comment FROM reviews r WHERE r.attempt_id = ? AND r.action != 'approve'`, r.id).map((c) => ({ action: c.action, comment: untrusted(c.comment) })),
      });
    }
    return guided({ functions: rows.length, batches: [...batches.values()] });
  });

  router.on('POST', '/api/tasks/heartbeat-all', ({ req }) => {
    const user = auth(req);
    return { ...tasks.heartbeatAll(user), regions: ctx.regions.heartbeat(user) };
  });

  // --- the arcade: game credits (credits.js). Play money; humans play, from the website.

  router.on('GET', '/api/credits/me', ({ req }) => {
    const user = auth(req);
    return { ...ctx.credits.wallet(user.id), slots: SLOT_TABLE };
  });
  router.on('POST', '/api/credits/bailout', ({ req }) => {
    const user = auth(req, { session: true });
    return ctx.credits.bailout(user.id);
  });
  router.on('GET', '/api/credits/leaderboard', () => cached('credits-board', 20_000, () => ctx.credits.leaderboard()));
  const gameLimiter = new RateLimiter(600, 600_000);
  router.on('POST', '/api/games/:game', async ({ req, params }) => {
    const user = auth(req, { session: true });
    gameLimiter.check(user.id);
    const body = await readJson(req, 4096);
    return ctx.credits.play(user.id, String(params.game), body);
  });

  // --- the main page: a live feed of what happens, and a map of every function

  const FEED_TYPES = ['submit', 'merged', 'auto_accepted', 'region_claim', 'game_win', 'user_approved', 'no_decompile_claim', 'skip_accepted'];
  router.on('GET', '/api/feed', ({ query }) => {
    const after = Number(query.get('after') ?? 0) || 0;
    // The first view is cached; later polls ask for what came after (a primary key range).
    return after > 0 ? feedSince(after) : cached('feed', 5_000, () => feedSince(0));
  });
  const feedSince = (after) => {
    {
      const rows = store.all(
        `SELECT e.id, e.at, e.type, e.data, u.name FROM events e LEFT JOIN users u ON u.id = e.user_id
          WHERE e.id > ? AND e.type IN (${FEED_TYPES.map(() => '?').join(',')}) ORDER BY e.id DESC LIMIT 40`,
        after, ...FEED_TYPES,
      );
      // Only the fields a public feed needs, never notes or code.
      const pick = (type, d) => {
        if (type === 'submit') return { functions: d.tasks };
        if (type === 'merged') return { functions: d.functions, commit: String(d.commit ?? '').slice(0, 10) };
        if (type === 'region_claim') return { key: d.key, kind: d.kind, functions: d.leased, shared: d.shared };
        if (type === 'game_win') return { game: d.game, bet: d.bet, payout: d.payout };
        if (type === 'no_decompile_claim') return { functions: d.functions };
        if (type === 'auto_accepted') return {};
        return {};
      };
      return rows.map((r) => ({ id: r.id, at: r.at, type: r.type, user: r.name ?? null, ...pick(r.type, JSON.parse(r.data ?? '{}')) }));
    }
  };

  // Every function in address order, one letter each: d byte-identical, c peer-confirmed, s needs no
  // decompilation, f on its way to main, l claimed, b sent back, o open; plus its source file.
  const mapData = () =>
    cached('map', 15_000, () => {
      const v = store.currentVersion();
      if (!v) return { functions: 0, states: '', units: [], unitOf: [], ids: [] };
      const rows = store.all(
        `SELECT t.symbol_id, t.state, s.unit, a.size, fs.status, fs.confirmed FROM tasks t JOIN symbols s ON s.id = t.symbol_id
           JOIN symbol_addresses a ON a.symbol_id = s.id AND a.version_id = ?
           LEFT JOIN func_status fs ON fs.symbol_id = s.id ORDER BY a.addr`,
        v.id,
      );
      const code = (r) => {
        if (r.state === 'skipped') return 's';
        if (r.state === 'done') return r.status === 'exact' || r.status === 'match_unresolved' ? 'd' : 'c';
        if (['verifying', 'peer_review', 'in_review', 'approved', 'merging'].includes(r.state)) return 'f';
        if (r.state === 'leased') return 'l';
        if (r.state === 'needs_cleanup' || r.state === 'hard') return 'b';
        return 'o';
      };
      const units = [];
      const index = new Map();
      const unitOf = rows.map((r) => {
        const u = r.unit ?? '(not placed yet)';
        if (!index.has(u)) index.set(u, units.push(u) - 1);
        return index.get(u);
      });
      return { functions: rows.length, states: rows.map(code).join(''), units, unitOf, ids: rows.map((r) => r.symbol_id), sizes: rows.map((r) => r.size ?? 0) };
    });
  router.on('GET', '/api/map', () => {
    const m = mapData();
    return { functions: m.functions, states: m.states, units: m.units, unitOf: m.unitOf };
  });
  router.on('GET', '/api/map/:i', ({ params }) => {
    const m = mapData();
    const i = intParam(params.i);
    if (i < 0 || i >= m.functions) throw new HttpError(404, 'no such function');
    const s = store.get(
      `SELECT s.id, s.name, s.unit, t.state, u.name AS holder FROM symbols s JOIN tasks t ON t.symbol_id = s.id LEFT JOIN users u ON u.id = t.lease_user AND t.state = 'leased' WHERE s.id = ?`,
      m.ids[i],
    );
    return { index: i, symbol: s?.id, name: s?.name ?? null, unit: s?.unit ?? null, state: s?.state, holder: s?.holder ?? null, size: m.sizes[i] };
  });

  // --- regions: a source file or class, claimed and worked on as a whole (regions.js)

  router.on('GET', '/api/regions', ({ req, query }) => {
    const user = auth(req);
    return guided(ctx.regions.list({ user, limit: intParam(query.get('limit') ?? '50'), free: query.get('free') === '1', prefix: query.get('prefix') || null }));
  });

  router.on('GET', '/api/regions/mine', ({ req }) => {
    const user = auth(req);
    return guided({ regions: ctx.regions.mine(user) });
  });

  router.on('POST', '/api/regions/claim', async ({ req }) => {
    const user = auth(req);
    const body = await readJson(req, 4096);
    reviewFirst(user);
    const r = ctx.regions.claim(user, { kind: body.kind ?? 'unit', key: body.key });
    return guided({
      ...r,
      baseCommit: repo.head(),
      note: r.region.kind === 'range'
        ? groupNote(r.leased.length, { kind: 'range' })
        : !r.leased.length && r.functions.every((f) => f.state === 'done' || f.state === 'skipped')
        ? 'Every function of this region is on main. To improve merged code, edit it, check locally, and submit the rewritten functions by task id (td submit <taskId...> --files ...): each one is a revision, reviewed like new work; main and the task stay as they are if it is sent back.'
        : r.alsoClaimedBy.length
          ? `Also claimed by ${r.alsoClaimedBy.join(', ')}: you may submit any function of it; the first accepted candidate of each function merges. Prefer an unclaimed region (td_regions free) unless you mean to help here.`
          : 'Port every function of the region, compile and check locally, then submit them together (td submit --all).',
    });
  });

  router.on('POST', '/api/regions/release', async ({ req }) => {
    const user = auth(req);
    const body = await readJson(req, 4096);
    return ctx.regions.release(user, { kind: body.kind ?? 'unit', key: String(body.key ?? '') });
  });

  // --- the compiler for local checks: only for approved accounts (the Microsoft files are not for
  // the public). The maintainer puts it at <data>/toolchain/toolchain.tar.gz (td-server toolchain).

  const toolchainFile = () => path.join(config.dataDir, 'toolchain', 'toolchain.tar.gz');
  router.on('GET', '/api/toolchain', ({ req }) => {
    auth(req);
    const f = toolchainFile();
    if (!fs.existsSync(f)) return { available: false, note: 'no compiler package on this server yet; ask a maintainer' };
    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(f), 'toolchain.json'), 'utf8'));
    return { available: true, ...meta, toolchain: project.toolchain, compiler: project.compile?.compiler ?? null };
  });
  router.on('GET', '/api/toolchain/download', ({ req, res }) => {
    auth(req);
    const f = toolchainFile();
    if (!fs.existsSync(f)) throw new HttpError(404, 'no compiler package on this server yet');
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': fs.statSync(f).size, 'content-disposition': 'attachment; filename="toolchain.tar.gz"', 'cache-control': 'private, no-store' });
    fs.createReadStream(f).pipe(res);
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

  router.on('POST', '/api/attempts/:id/withdraw', ({ req, params }) => {
    const user = auth(req);
    return tasks.withdraw(user, intParam(params.id));
  });

  router.on('GET', '/api/attempts/:id', ({ req, params }) => {
    const user = auth(req);
    const a = store.get('SELECT a.*, u.name AS author FROM attempts a JOIN users u ON u.id = a.user_id WHERE a.id = ?', intParam(params.id));
    if (!a) throw new HttpError(404, 'no such attempt');
    const result = a.result_json ? JSON.parse(a.result_json) : null;
    const batch = a.batch_id ? store.get('SELECT result_json FROM batches WHERE id = ?', a.batch_id) : null;
    const batchResult = batch?.result_json ? JSON.parse(batch.result_json) : {};
    const symbol = store.get(
      `SELECT s.id, s.name, ad.addr, ad.size FROM tasks t JOIN symbols s ON s.id = t.symbol_id
         LEFT JOIN symbol_addresses ad ON ad.symbol_id = s.id AND ad.version_id = ? WHERE t.id = ?`,
      store.currentVersion().id, a.task_id,
    );
    const isReviewer = hasRole(user, 'reviewer');
    return {
      id: a.id,
      taskId: a.task_id,
      symbol: symbol ? { ...symbol, addr: symbol.addr === null ? null : '0x' + hex(symbol.addr) } : null,
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
      kind: a.kind,
      claim: a.kind === 'skip' ? { category: a.skip_category, reason: a.notes, noSourceExpected: true } : undefined,
      peerReviews: peers.verdicts(a.id),
      peerRequired: peers.needed(peers.counts(a.id).different), // "same" verdicts (by weight) that accept it as it stands
      targetSource: targetSource(result?.feedback?.target?.id ?? symbol?.id, batchResult.mergedFiles ?? store.attemptFiles(a)),
    };
  });

  router.on('POST', '/api/symbols', async ({ req }) => {
    const user = auth(req);
    symbolLimiter.check(user.id);
    const body = await readJson(req, 4096);
    const kind = String(body.kind ?? '');
    if (!['function', 'global', 'vtable', 'string'].includes(kind)) throw new HttpError(400, 'kind must be function, global, vtable or string');
    const addr = typeof body.addr === 'string' ? Number.parseInt(body.addr, 16) : Number(body.addr);
    if (!Number.isSafeInteger(addr) || addr <= 0) throw new HttpError(400, 'addr must be a hex string like "0x1400e5d50"');
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

  // Evidence-backed metadata corrections never change stable IDs or function match/review state.
  // Decorated names can be replaced or exchanged atomically when two mappings were reversed.
  // Retiring removes its address in the current version, so nothing resolves to it any more; its
  // ID stays reserved. Only symbols no file on main annotates may be retired: a maintenance batch
  // removes those annotations first.
  router.on('POST', '/api/admin/symbols/:id', async ({ req, params }) => {
    const user = auth(req, { role: 'maintainer' });
    const body = await readJson(req, 4096);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be an object');
    const allowed = ['reason', 'size', 'name', 'retire', 'decorated', 'swapDecoratedWith'];
    if (Object.keys(body).some((key) => !allowed.includes(key))) throw new HttpError(400, 'unknown symbol correction field');
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500) throw new HttpError(400, 'reason must be 1-500 characters: the evidence for the correction');
    const reason = body.reason.trim();
    const validDecorated = (value) => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[^\x21-\x7e]/.test(value);
    if (body.decorated !== undefined && !validDecorated(body.decorated)) throw new HttpError(400, 'decorated must be 1-2048 visible ASCII characters without whitespace');
    if (body.retire !== undefined && typeof body.retire !== 'boolean') throw new HttpError(400, 'retire must be a boolean');
    if (body.swapDecoratedWith !== undefined) {
      if (typeof body.swapDecoratedWith !== 'string' || !/^(fn|gl|vt|st)_[0-9]+$/.test(body.swapDecoratedWith) || body.swapDecoratedWith === params.id) throw new HttpError(400, 'swapDecoratedWith must be a different symbol ID');
      if (['size', 'name', 'retire', 'decorated'].some((key) => body[key] !== undefined)) throw new HttpError(400, 'swapDecoratedWith cannot be combined with other corrections');
    }
    const result = store.tx(() => {
      const sym = store.get('SELECT * FROM symbols WHERE id = ?', params.id);
      if (!sym) throw new HttpError(404, 'no such symbol');
      const assertUnique = (decorated, ownerId) => {
        const duplicate = store.get('SELECT id FROM symbols WHERE decorated = ? AND id != ? LIMIT 1', decorated, ownerId);
        if (duplicate) throw new HttpError(409, `decorated name is already mapped to ${duplicate.id}; use swapDecoratedWith to exchange two mappings`);
      };
      if (body.swapDecoratedWith !== undefined) {
        const other = store.get('SELECT * FROM symbols WHERE id = ?', body.swapDecoratedWith);
        if (!other) throw new HttpError(404, 'no such swap symbol');
        if (sym.kind !== other.kind) throw new HttpError(409, 'a swap requires symbols of the same kind');
        if (!validDecorated(sym.decorated) || !validDecorated(other.decorated) || sym.decorated === other.decorated) throw new HttpError(409, 'a swap requires two distinct existing decorated names');
        assertUnique(sym.decorated, sym.id);
        assertUnique(other.decorated, other.id);
        store.run('UPDATE symbols SET decorated = CASE id WHEN ? THEN ? ELSE ? END WHERE id IN (?, ?)', sym.id, other.decorated, sym.decorated, sym.id, other.id);
        for (const [from, to] of [[sym, other], [other, sym]]) {
          store.event('symbol_corrected', user.id, { id: from.id, decorated: to.decorated, old: { decorated: from.decorated }, new: { decorated: to.decorated }, swapDecoratedWith: to.id, reason });
        }
        store.setMeta('symbolCorrectionsRevision', Number(store.getMeta('symbolCorrectionsRevision') ?? 0) + 1);
        return { id: sym.id, decorated: other.decorated, swapped: { id: other.id, decorated: sym.decorated } };
      }
      const v = store.currentVersion();
      const changes = {};
      const old = {};
      if (body.size !== undefined) {
        const size = Number(body.size);
        if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, 'size must be a positive integer');
        const address = v && store.get('SELECT size FROM symbol_addresses WHERE symbol_id = ? AND version_id = ?', sym.id, v.id);
        if (!address) throw new HttpError(409, 'symbol has no address in the current version');
        old.size = address.size;
        store.run('UPDATE symbol_addresses SET size = ? WHERE symbol_id = ? AND version_id = ?', size, sym.id, v.id);
        changes.size = size;
      }
      if (body.name !== undefined) {
        const name = body.name === null ? null : String(body.name).slice(0, 200);
        old.name = sym.name;
        store.run('UPDATE symbols SET name = ? WHERE id = ?', name, sym.id);
        changes.name = name;
      }
      if (body.decorated !== undefined) {
        assertUnique(body.decorated, sym.id);
        old.decorated = sym.decorated;
        store.run('UPDATE symbols SET decorated = ? WHERE id = ?', body.decorated, sym.id);
        changes.decorated = body.decorated;
      }
      if (body.retire === true) {
        if (sym.kind !== 'global') throw new HttpError(400, 'only globals are retired this way');
        let annotated = '';
        try {
          annotated = repo.git(['grep', '-l', '-w', '-e', `GLOBAL: ${sym.id}`, 'HEAD', '--', '.']).trim();
        } catch {}
        if (annotated) throw new HttpError(409, `${sym.id} is still annotated on main (${annotated.split('\n').map((l) => l.replace(/^HEAD:/, '')).join(', ')}); remove those annotations with a maintenance batch first`);
        if (!v) throw new HttpError(409, 'no current version');
        old.retired = !store.get('SELECT 1 FROM symbol_addresses WHERE symbol_id = ? AND version_id = ?', sym.id, v.id);
        store.run('DELETE FROM symbol_addresses WHERE symbol_id = ? AND version_id = ?', sym.id, v.id);
        changes.retired = true;
      }
      if (!Object.keys(changes).length) throw new HttpError(400, 'nothing to change: give size, name, decorated, swapDecoratedWith or retire: true');
      store.event('symbol_corrected', user.id, { id: sym.id, ...changes, old, new: changes, reason });
      store.setMeta('symbolCorrectionsRevision', Number(store.getMeta('symbolCorrectionsRevision') ?? 0) + 1);
      return { id: sym.id, ...changes };
    });
    return result;
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
    const ghidra = GHIDRA_RELEASE.version === info.ghidra ? GHIDRA_RELEASE : { version: info.ghidra };
    return { ...info, release: ghidra, download: `${config.publicUrl}/api/ghidra-project/download` };
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
    // Checks run on the contributor's machine; the server compiles only submissions and merges.
    if (!config.remoteChecks) {
      throw new HttpError(410, 'the server no longer compiles checks: compile locally. Run "td toolchain install" once (downloads the compiler), then td_check works on your machine. Submit with td_submit when your region compiles and matches.');
    }
    checkLimiter.check(user.id);
    const body = await readJson(req);
    if (typeof body.baseCommit !== 'string' || !/^[0-9a-f]{40}$/.test(body.baseCommit)) throw new HttpError(400, 'baseCommit must be a full commit hash');
    if (!body.files || typeof body.files !== 'object' || Array.isArray(body.files)) throw new HttpError(400, 'files must be an object of path -> content');
    body.files = lf(body.files);
    const allowed = [...project.sourceDirs.map((d) => `${d}/**`)];
    const lintErrors = lintSubmission(body.files, { allowedPaths: allowed, limits: project.lintLimits, allowedPragmas: project.allowedPragmas, baseSize: (f) => repo.size('HEAD', f), trackedPaths: repo.trackedPaths('HEAD') });
    if (lintErrors.length) return { gate: 'rejected', lintErrors };
    if (!repo.isAncestor(body.baseCommit)) throw new HttpError(409, 'your base commit is not part of main; run td sync');
    const textErrors = ctx.verifier.freeTextGate(body.files, body.baseCommit);
    if (textErrors.length) return { gate: 'rejected', lintErrors: textErrors };
    const merged = repo.mergeOntoHead(body.baseCommit, body.files);
    if (merged.conflicts.length) return { gate: 'conflict', conflicts: merged.conflicts };
    // Started without waiting: the agent keeps working and fetches the result later.
    if (body.wait === false) {
      try {
        const checkId = ctx.checks.enqueue(user.id, merged.files, { detached: true });
        return guided({ checkId, state: 'queued', note: 'Compiling on the server. Do not wait: work on other functions or do peer reviews, then fetch the result with td_check_result (GET /api/checks/<id>).' });
      } catch (e) {
        throw new HttpError(503, e.message, e instanceof WorkerUnavailable ? { retryAfterSeconds: 120 } : undefined);
      }
    }
    const gone = new AbortController();
    res.on('close', () => res.writableFinished || gone.abort());
    try {
      return guided(await ctx.checks.run(user.id, merged.files, { signal: gone.signal }));
    } catch (e) {
      throw new HttpError(503, e.message, e instanceof WorkerUnavailable ? { retryAfterSeconds: 120 } : undefined);
    }
  });

  router.on('GET', '/api/checks/:id', ({ req, params }) => {
    const user = auth(req);
    const r = ctx.checks.result(user.id, intParam(params.id));
    if (!r) throw new HttpError(404, 'no such check of yours');
    return guided(r);
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
              (SELECT COALESCE(SUM(p.weight), 0) FROM peer_reviews p WHERE p.attempt_id = a.id AND p.verdict = 'same') AS peer_same,
              (SELECT COALESCE(SUM(p.weight), 0) FROM peer_reviews p WHERE p.attempt_id = a.id AND p.verdict = 'different') AS peer_different,
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
    const user = auth(req, { role: 'reviewer' });
    if (user.via !== 'session' && !hasRole(user, 'admin')) throw new HttpError(403, 'this action needs a password login in the browser; only admin API tokens can do it');
    const body = await readJson(req, 16 * 1024);
    const attemptIds = Array.isArray(body.attemptIds) ? body.attemptIds.map((x) => intParam(x)) : null;
    const r = merger.reviewBatch(user, intParam(params.id), String(body.action ?? ''), body.comment ? String(body.comment) : null, { attemptIds, skipPeerReview: body.skipPeerReview === true });
    if (runsWorker) setImmediate(() => merger.pump().catch(() => {}));
    return r;
  });

  // An admin merges a batch that came back only for lowering matching scores (merge.js).
  router.on('POST', '/api/admin/batches/:id/accept-regressions', async ({ req, params }) => {
    const user = auth(req, { role: 'admin' });
    const body = await readJson(req, 16 * 1024);
    const r = merger.acceptRegressions(user, intParam(params.id), body.comment ? String(body.comment) : null);
    if (runsWorker) setImmediate(() => merger.pump().catch(() => {}));
    return r;
  });

  // --- maintainers and admins (browser session only)

  router.on('POST', '/api/admin/tasks/:id', async ({ req, params }) => {
    const user = auth(req, { role: 'maintainer' });
    if (user.via !== 'session' && !hasRole(user, 'admin')) throw new HttpError(403, 'this action needs a password login in the browser; only admin API tokens can do it');
    const body = await readJson(req, 4096);
    const t = tasks.get(intParam(params.id));
    if (body.priority !== undefined) store.run('UPDATE tasks SET priority = ? WHERE id = ?', Number(body.priority) | 0, t.id);
    // A done function is reopened only with force: merged code that is wrong and must be redone.
    // Improving it does not need this; a region claim lets agents submit it as a revision. The
    // tasks_done_stays_done trigger lets a done task move to 'open' only.
    if (body.state === 'open' && t.state === 'done' && body.force === true) {
      store.run(`UPDATE tasks SET state = 'open', lease_user = NULL, lease_expires = NULL, updated_at = ? WHERE id = ?`, now(), t.id);
    } else if (body.state === 'open' && t.state !== 'done') tasks.reopen(t.id);
    return tasks.get(t.id);
  });

  // How the account's agents are doing: level, numbers, what broke, recent examples (quality.js).
  // An agent (token) sees its own numbers; the owner on the website sees every agent of the account.
  router.on('GET', '/api/me/quality', ({ req }) => {
    const user = auth(req);
    const withTrust = (d) => ({ ...d, trust: trustOf(user.id, d.tokenId ?? null) });
    if (user.via === 'token') return withTrust(ctx.quality.details(user.id, user.tokenId));
    const all = ctx.quality.account(user.id);
    return { ...all, tokens: all.tokens.map(withTrust) };
  });
  const trustOf = (userId, tokenId) => {
    const author = ctx.trust.author(userId, tokenId);
    const reviewer = ctx.trust.reviewer(userId, tokenId);
    return { author, reviewer, sample: ctx.trust.policy.sample };
  };
  // The owner's once-a-day fresh start for one agent (a person on the website, not the agent).
  router.on('POST', '/api/me/quality/reset', async ({ req }) => {
    const user = auth(req, { session: true });
    const body = await readJson(req, 1024);
    return ctx.quality.reset(user.id, body.tokenId == null ? null : intParam(body.tokenId));
  });

  router.on('GET', '/api/admin/authors', ({ req }) => {
    auth(req, { role: 'admin', session: true });
    const ids = new Map(store.all('SELECT id, user_id, label FROM api_tokens').map((t) => [`${t.user_id}:${t.label}`, t.id]));
    const names = new Map(store.all('SELECT id, name FROM users').map((u) => [u.name, u.id]));
    const authors = ctx.quality.authors().map((a) => {
      const userId = names.get(a.name);
      const tokenId = a.tokenId ?? (a.token ? ids.get(`${userId}:${a.token}`) ?? null : null);
      return { ...a, trust: trustOf(userId, tokenId) };
    });
    return { authors, limits: LIMITS };
  });
  router.on('GET', '/api/admin/registration', ({ req }) => {
    auth(req, { role: 'admin', session: true });
    return accounts.registrationSettings();
  });
  router.on('POST', '/api/admin/registration', async ({ req }) => {
    const admin = auth(req, { role: 'admin', session: true });
    const body = await readJson(req, 1024);
    return accountCall(() => accounts.setRegistrationSettings(body.autoApprove, admin.id));
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
    delete: (name, admin) => accounts.deleteUser(name, admin.id),
    // Submissions: auto (limited by recent quality), trusted (never limited) or paused.
    'submit-auto': (name) => setSubmitMode(name, 'auto'),
    'submit-trusted': (name) => setSubmitMode(name, 'trusted'),
    'submit-paused': (name) => setSubmitMode(name, 'paused'),
    'reset-password': (name, admin) => accounts.resetPassword(name, admin.id),
    // How much the account's peer verdicts weigh: set by an admin, or earned (trust.js).
    'review-weight-1': (name, admin) => peers.setReviewWeight(accounts.requireUser(name).id, 1, admin.id),
    'review-weight-2': (name, admin) => peers.setReviewWeight(accounts.requireUser(name).id, 2, admin.id),
    'review-weight-auto': (name, admin) => peers.setReviewWeight(accounts.requireUser(name).id, null, admin.id),
  };
  const setSubmitMode = (name, mode) => {
    const u = accounts.byName(name);
    if (!u) throw new HttpError(404, 'no such user');
    store.run('UPDATE users SET submit_mode = ? WHERE id = ?', mode, u.id);
    ctx.quality.forget(u.id);
    store.event('submit_mode', null, { name, mode });
    return { name, mode };
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
      if (ctx.runsWorker === false) ctx.verifier?.refreshPublishedProject();
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/discord') {
        res.writeHead(302, { location: 'https://discord.gg/5fDwn7tVNj', 'cache-control': 'no-store' });
        return res.end();
      }
      if (url.pathname.startsWith('/repo.git/')) {
        return serveGit(req, res, { projectRoot: config.dataDir, subPath: '/repo' + url.pathname.slice('/repo.git'.length), query: url.searchParams });
      }
      if (req.method === 'GET' && (url.pathname === '/install.ps1' || url.pathname === '/install.sh')) {
        const script = url.pathname.endsWith('.ps1') ? installPs1(config, project) : installSh(config, project);
        if (!script) throw new HttpError(503, 'the td binaries are not published on this server yet');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
        return res.end(script);
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/download/')) return serveDownload(url.pathname.slice(10), req, res);
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
      const m = router.match(req.method, url.pathname);
      if (!m) throw new HttpError(404, 'not found');
      const result = await m.handler({ req, res, params: m.params, query: url.searchParams });
      if (result !== undefined) sendJson(res, 200, withUpdateNote(req, result));
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) sendJson(res, e.status, { error: e.message, details: e.details });
      else {
        console.error(e);
        sendJson(res, 500, { error: 'internal error' });
      }
    }
  };
  const server = http.createServer(handler);
  // What the live socket pushes (live.js), from the same shared caches as the routes.
  const origin = new URL(config.publicUrl).origin;
  server.liveSources = {
    feed: feedSince,
    progress: progressData,
    map: mapData,
    userFromCookie: (req) => {
      const c = sessionCookie(req);
      return c ? accounts.userBySession(c) : null;
    },
    allowedOrigins: [origin, `http://${config.listen.host}:${config.listen.port}`],
    clientIp,
  };
  return server;
}

// Public downloads: td binaries (tools/build-td output) and Dockerfile.clank, published to <dataDir>/downloads.
const DOWNLOADS = new Set(['td-windows-x64.exe', 'td-linux-x64', 'td-linux-arm64', 'SHA256SUMS', 'Dockerfile.clank']);
let downloadsRoot = null;
// Agents read the guidance in work responses; one whose td is not the current build is told to
// update there (td from before builds were reported sends none). Read per request, so a new
// publish takes effect without a restart.
function withUpdateNote(req, result) {
  if (!result || typeof result !== 'object' || typeof result.guidance !== 'string' || !downloadsRoot) return result;
  const build = String(req.headers['x-td-build'] ?? '');
  if (build === 'dev') return result;
  let current;
  try {
    current = Object.values(publishedBuilds({ dataDir: path.dirname(downloadsRoot) }));
  } catch {
    return result;
  }
  if (!current.length || current.includes(build)) return result;
  return {
    ...result,
    guidance:
      result.guidance +
      ` UPDATE NEEDED: your td is not the current build (${build ? build.slice(0, 12) : 'it does not report one'}; current ${current.map((h) => h.slice(0, 12)).join(' / ')}).` +
      ' Tell the user to restart the AI app (td updates itself when it starts) or to run "td update" and reconnect.' +
      ' Older td lacks td_mark_no_decompile, td_place and bulk verdicts in td_submit_peer_review.',
  };
}

function serveDownload(name, req, res) {
  // Published names are overwritten on every release, including SHA256SUMS and gzip copies.
  res.setHeader('cache-control', 'no-store');
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
  if (req.method === 'HEAD') return res.end();
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
    // Functions the peer review rule decides as it stands now (it or the policy changed since).
    try {
      const s = ctx.peers.settleAll();
      if (s.approved || s.needs_cleanup) console.log(`peer review: ${s.approved} waiting functions accepted, ${s.needs_cleanup} sent back under the current rule`);
    } catch (e) {
      console.error(`settling peer reviews: ${e.message}`);
    }
    ctx.verifier.start();
    ctx.merger.start();
    ctx.checks.start();
    stops.push(() => ctx.verifier.stop(), () => ctx.merger.stop(), () => ctx.checks.stop());
    console.log(`clank together worker running (${role})`);
  }
  let server = null;
  if (role !== 'worker') {
    const sweeper = setInterval(() => { try { ctx.tasks.sweepExpired(); ctx.regions.sweepExpired(); } catch (e) { console.error(`lease sweep: ${e.message}`); } }, 60_000);
    const booker = setInterval(() => { try { ctx.credits.sync(); } catch (e) { console.error(`credits: ${e.message}`); } }, 30_000);
    stops.push(() => clearInterval(booker));
    stops.push(() => clearInterval(sweeper));
    server = createApp(ctx);
    const live = new Live({ store: ctx.store, credits: ctx.credits, ...server.liveSources });
    live.attach(server);
    stops.push(() => live.stop());
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
