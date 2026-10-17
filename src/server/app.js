// Coordinator server: wires storage, repo, tasks, verifier and merger to the HTTP API.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store, now } from './db.js';
import { Accounts, AccountError, hasRole, ROLES } from './accounts.js';
import { Repo, serveGit } from './git.js';
import { Tasks } from './tasks.js';
import { Verifier } from './verify.js';
import { Merger } from './merge.js';
import { PeerReviews } from './peer.js';
import { Router, HttpError, readJson, sendJson, RateLimiter } from './http.js';
import { PEImage } from '../shared/pe.js';
import { loadProject, loadToolchainLock } from '../shared/project.js';
import { DEFAULT_LIMITS } from '../shared/lint.js';
import { hex } from '../shared/annotations.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');

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
  const verifier = new Verifier({ store, config, repo, project, tasks, getPe, log });
  const peers = new PeerReviews({ store, project });
  const merger = new Merger({ store, config, repo, project, tasks, verifier, getPe, peers, log });
  const accounts = new Accounts(store);
  return { config, store, repo, project, tasks, verifier, merger, getPe, accounts, peers };
}

export function createApp(ctx) {
  const { config, store, repo, project, tasks, merger, accounts, peers } = ctx;
  const router = new Router();
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
      version: v ? { id: v.id, sha256: v.sha256, size: v.size, download: config.distributeTarget ? `${config.publicUrl}/api/target/${encodeURIComponent(v.id)}` : null } : null,
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

  router.on('GET', '/api/symbols', ({ query }) => {
    const v = query.get('version') ? store.get('SELECT * FROM versions WHERE id = ?', query.get('version')) : store.currentVersion();
    if (!v) throw new HttpError(404, 'unknown version');
    const rows = [...store.symbolMap(v.id).values()].map((s) => [s.id, s.kind, s.addr, s.size, s.name, s.decorated, s.library ? 1 : 0, s.unit]);
    return { version: v.id, head: repo.head(), columns: ['id', 'kind', 'addr', 'size', 'name', 'decorated', 'library', 'unit'], symbols: rows };
  });

  router.on('GET', '/api/progress', () => {
    const total = store.get(`SELECT COUNT(*) AS n, COALESCE(SUM(a.size), 0) AS bytes FROM symbols s JOIN symbol_addresses a ON a.symbol_id = s.id JOIN versions v ON v.id = a.version_id AND v.is_current = 1 WHERE s.kind = 'function' AND s.library = 0`);
    const byStatus = store.all(`SELECT fs.status, COUNT(*) AS n, COALESCE(SUM(a.size), 0) AS bytes FROM func_status fs JOIN symbol_addresses a ON a.symbol_id = fs.symbol_id JOIN versions v ON v.id = a.version_id AND v.is_current = 1 GROUP BY fs.status`);
    const byTaskState = store.all('SELECT state, COUNT(*) AS n FROM tasks GROUP BY state');
    const contributors = store.all(`SELECT u.name, COUNT(*) AS merged FROM attempts a JOIN users u ON u.id = a.user_id WHERE a.state = 'merged' GROUP BY u.id ORDER BY merged DESC LIMIT 20`);
    const confirmed = store.get(`SELECT COUNT(*) AS n, COALESCE(SUM(a.size), 0) AS bytes FROM func_status fs JOIN symbol_addresses a ON a.symbol_id = fs.symbol_id JOIN versions v ON v.id = a.version_id AND v.is_current = 1 WHERE fs.confirmed = 1 AND fs.status NOT IN ('exact', 'match_unresolved')`);
    const peerQueue = store.get("SELECT COUNT(*) AS n FROM attempts WHERE state = 'peer_review'").n;
    return { functions: total.n, bytes: total.bytes, byStatus, confirmed, peerQueue, byTaskState, contributors };
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
    return { name: user.name, role: user.role, via: user.via, leases: tasks.leasesOf(user.id) };
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

  router.on('GET', '/api/tasks/:id', ({ req, params }) => {
    auth(req);
    return tasks.context(intParam(params.id));
  });

  router.on('POST', '/api/tasks/claim', async ({ req }) => {
    const user = auth(req);
    const body = await readJson(req, 4096);
    const id = tasks.claim(user, body.taskId ? intParam(body.taskId) : null);
    return tasks.context(id);
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
    const t = tasks.requireLease(user, taskId);
    if (typeof body.baseCommit !== 'string' || !/^[0-9a-f]{40}$/.test(body.baseCommit)) throw new HttpError(400, 'baseCommit must be a full commit hash');
    if (!body.files || typeof body.files !== 'object' || Array.isArray(body.files)) throw new HttpError(400, 'files must be an object of path -> content');
    const notes = body.notes ? String(body.notes).slice(0, DEFAULT_LIMITS.maxNotesBytes) : null;
    const meta = body.agentMeta ? JSON.stringify(body.agentMeta).slice(0, 1000) : null;
    const id = store.tx(() => {
      const r = store.run(
        `INSERT INTO attempts (task_id, user_id, base_commit, files_json, notes, agent_meta, env_digest, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        t.id, user.id, body.baseCommit, JSON.stringify(body.files), notes, meta, body.envDigest ? String(body.envDigest).slice(0, 200) : null, now(),
      );
      store.run(`UPDATE tasks SET state = 'verifying', lease_user = NULL, lease_expires = NULL, updated_at = ? WHERE id = ?`, now(), t.id);
      store.event('submit', user.id, { task: t.id, attempt: Number(r.lastInsertRowid) });
      return Number(r.lastInsertRowid);
    });
    ctx.verifier.pump();
    return { attemptId: id, state: 'queued' };
  });

  router.on('GET', '/api/attempts/:id', ({ req, params }) => {
    const user = auth(req);
    const a = store.get('SELECT a.*, u.name AS author FROM attempts a JOIN users u ON u.id = a.user_id WHERE a.id = ?', intParam(params.id));
    if (!a) throw new HttpError(404, 'no such attempt');
    const result = a.result_json ? JSON.parse(a.result_json) : null;
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
      mergeFailure: result?.mergeFailure ?? null,
      changedHeaders: result?.changedHeaders ?? [],
      files: JSON.parse(a.files_json),
      mergedFiles: isReviewer ? result?.mergedFiles ?? null : undefined,
      reviews: store.all('SELECT r.action, r.comment, r.created_at, u.name AS reviewer FROM reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.attempt_id = ?', a.id),
      peerReviews: peers.verdicts(a.id),
      peerRequired: peers.required,
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
      `SELECT a.id, a.task_id, a.score, a.created_at, a.finished_at, u.name AS author, t.symbol_id, s.name,
              (SELECT COUNT(*) FROM reviews r WHERE r.attempt_id = a.id AND r.action = 'approve') AS approvals,
              (SELECT COUNT(*) FROM reviews r WHERE r.attempt_id = a.id AND r.reviewer_id = ?) AS reviewed_by_me
         FROM attempts a JOIN users u ON u.id = a.user_id JOIN tasks t ON t.id = a.task_id JOIN symbols s ON s.id = t.symbol_id
        WHERE a.state = 'in_review' ORDER BY a.finished_at`,
      user.id,
    );
  });

  router.on('POST', '/api/attempts/:id/review', async ({ req, params }) => {
    const user = auth(req, { role: 'reviewer', session: true });
    const body = await readJson(req, 16 * 1024);
    const r = merger.review(user, intParam(params.id), String(body.action ?? ''), body.comment ? String(body.comment) : null);
    if (r.state === 'approved') setImmediate(() => merger.pump());
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
    return { roles: ROLES, users: accounts.listUsers(query.get('status') ?? undefined) };
  });

  const ADMIN_ACTIONS = {
    approve: (name, admin) => accounts.approve(name, admin.id),
    reject: (name, admin) => accounts.reject(name, admin.id),
    revoke: (name, admin) => accounts.revoke(name, admin.id),
    reinstate: (name, admin) => accounts.reinstate(name, admin.id),
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

export async function startServer(dataDir) {
  const ctx = openServer(dataDir);
  ctx.tasks.generate();
  ctx.verifier.start();
  ctx.merger.start();
  const sweeper = setInterval(() => ctx.tasks.sweepExpired(), 60_000);
  const server = createApp(ctx);
  await new Promise((r) => server.listen(ctx.config.listen.port, ctx.config.listen.host, r));
  console.log(`clank together coordinator listening on http://${ctx.config.listen.host}:${ctx.config.listen.port} (public url ${ctx.config.publicUrl})`);
  const shutdown = () => {
    clearInterval(sweeper);
    ctx.verifier.stop();
    ctx.merger.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { ctx, server };
}
