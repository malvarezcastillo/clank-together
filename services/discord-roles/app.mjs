import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION = '__Host-clank_roles_session';
const LOGIN = '__Host-clank_roles_login';
const STATE = '__Host-clank_roles_state';
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const TIER_ROWS = [
  ['Angeling', '10000'],
  ['Deviling', '5000'],
  ['Metaling', '400'],
  ['Poring', '50'],
];

class HttpError extends Error {
  constructor(status) { super('Request failed'); this.status = status; }
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function equal(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookie(req, name) {
  const matches = String(req.headers.cookie || '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return TOKEN.test(value) ? value : null;
}

function setCookie(res, name, value, maxAge) {
  const existing = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...existing, `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`]);
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function page(res, status, title, content) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Clank linked roles</title><link rel="stylesheet" href="/style.css"></head><body><main><header><p class="eyebrow">RODECOMP.ONLINE</p><h1>Clank linked roles</h1><p>Turn your lifetime contributions into a Discord role.</p></header>${content}<footer>This standalone service never changes your Clank account or arcade balance.</footer></main></body></html>`);
}

function hiddenCsrf(csrf) {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
}

function action(path, csrf, label, extraClass = '') {
  return `<form method="post" action="${path}">${hiddenCsrf(csrf)}<button class="${extraClass}" type="submit">${label}</button></form>`;
}

function linkStatus(link) {
  if (!link) return 'Not connected';
  return ({ synced: 'Connected', pending: 'Waiting for synchronization', relink_required: 'Discord authorization expired — reconnect', unlink_pending: 'Disconnect pending — retrying Discord cleanup' })[link.status] || 'Waiting for synchronization';
}

function renderAccount(res, user, session, link) {
  const status = linkStatus(link);
  const lastSync = link?.lastSyncedAt ? new Date(link.lastSyncedAt).toISOString() : 'Not yet';
  const connectionActions = link?.status === 'unlink_pending'
    ? '<p>Discord is temporarily unavailable. Cleanup will retry automatically; your credentials are retained only until cleanup finishes.</p>'
    : `${action('/api/discord/link', session.csrf, link ? 'Reconnect Discord' : 'Connect Discord')}${link ? action('/api/discord/unlink', session.csrf, 'Disconnect Discord', 'secondary') : ''}`;
  page(res, 200, 'Account', `<section aria-labelledby="account-title"><h2 id="account-title">${escapeHtml(user.name)}</h2><dl><dt>Lifetime contribution credits</dt><dd class="credits">${escapeHtml(user.credits)}</dd><dt>Discord connection</dt><dd>${escapeHtml(status)}</dd>${link ? `<dt>Discord account ID</dt><dd>${escapeHtml(link.discordId)}</dd><dt>Last synchronized</dt><dd>${escapeHtml(lastSync)}</dd>` : ''}</dl><div class="actions">${connectionActions}${link ? action('/api/discord/sync', session.csrf, 'Sync now', 'secondary') : ''}</div></section><section aria-labelledby="roles-title"><h2 id="roles-title">Role requirements</h2><table><caption>Lifetime contribution credits, not your spendable balance</caption><thead><tr><th scope="col">Role</th><th scope="col">Credits required</th></tr></thead><tbody>${TIER_ROWS.map(([name, minimum]) => `<tr><th scope="row">${name}</th><td>${minimum}+</td></tr>`).join('')}</tbody></table><p>After connecting, open your Discord server’s <strong>Linked Roles</strong> menu and claim an eligible role. Lower tiers remain eligible too; this service does not automatically award or remove tiers to make them exclusive.</p></section><div class="actions">${action('/api/logout', session.csrf, 'Log out', 'secondary')}</div>`);
}

const STYLE = `:root{color-scheme:dark;font:17px/1.6 system-ui,sans-serif;background:#131722;color:#eef2f8}*{box-sizing:border-box}body{margin:0}main{max-width:780px;margin:auto;padding:3rem 1.25rem}header{margin-bottom:2rem}h1{font-size:2.3rem;line-height:1.2;margin:.4rem 0}h2{font-size:1.35rem;margin-top:0}.eyebrow{letter-spacing:.15em;color:#b7c7ff;font-weight:700}section{background:#1d2433;border:1px solid #45516a;border-radius:14px;padding:1.5rem;margin:1.25rem 0}p{margin:.7rem 0}a{color:#b7c7ff}label{display:block;font-weight:650}input{display:block;width:100%;margin:.5rem 0;padding:.8rem;background:#101522;color:inherit;border:1px solid #7d8aa6;border-radius:7px;font:inherit}button{padding:.7rem 1.1rem;background:#bdcaff;color:#16213a;border:1px solid transparent;border-radius:7px;font:inherit;font-weight:700;cursor:pointer}button.secondary{background:transparent;color:#dbe3ff;border-color:#7d8aa6}:focus-visible{outline:3px solid #f1c40f;outline-offset:4px}.actions{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1.25rem}.actions p{width:100%}.actions form{margin:0}dt{color:#c2ccdf}dd{margin:0 0 1rem;overflow-wrap:anywhere}.credits{font-size:2rem;font-weight:700;color:#f1c40f}table{width:100%;border-collapse:collapse;text-align:left}caption{text-align:left;color:#c2ccdf;padding-bottom:.75rem}th,td{padding:.65rem;border-bottom:1px solid #45516a}footer{font-size:.85rem;color:#c2ccdf;margin-top:2rem}.hint{font-size:.9rem;color:#c2ccdf}.error{border-left:4px solid #ff9292}@media(max-width:450px){main{padding:1.5rem 1rem}section{padding:1rem}h1{font-size:1.9rem}.actions{display:block}.actions form{margin:.65rem 0}}`;

async function readForm(req) {
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') throw new HttpError(415);
  const text = await new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > 8192) { failed = true; chunks.length = 0; reject(new HttpError(413)); }
      else chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', () => reject(new HttpError(400)));
  });
  const form = new URLSearchParams(text);
  for (const key of new Set(form.keys())) if (form.getAll(key).length !== 1) throw new HttpError(400);
  return form;
}

export function createApp(config, core) {
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; form-action 'self' https://discord.com; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, config.publicUrl);
      if (url.origin !== config.publicUrl || !req.url.startsWith('/')) throw new HttpError(400);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/healthz') {
        try { core.getSourceUser(0); json(res, 200, { ready: true }); }
        catch { json(res, 503, { ready: false }); }
        return;
      }
      if (req.method === 'GET' && path === '/style.css') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }); res.end(STYLE); return;
      }
      if (!['GET', 'POST'].includes(req.method)) throw new HttpError(405);
      if (req.method === 'GET' && path === '/api/discord/link') {
        res.writeHead(302, { Location: '/' }); res.end(); return;
      }
      const rawSession = cookie(req, SESSION);
      const session = rawSession ? core.getSession(rawSession) : null;
      if (req.method === 'GET' && path === '/') {
        if (session) {
          const user = core.getSourceUser(session.userId);
          if (!user || user.status !== 'active') {
            core.deleteSession(rawSession); setCookie(res, SESSION, '', 0); throw new HttpError(401);
          }
          renderAccount(res, user, session, core.getLink(session.userId));
        } else {
          const csrf = cookie(req, LOGIN) || randomBytes(32).toString('base64url');
          setCookie(res, LOGIN, csrf, 600);
          page(res, 200, 'Connect your account', `<section aria-labelledby="login-title"><h2 id="login-title">Verify your Clank account</h2><p>Use a Clank API token once to prove ownership. It is sent only to Clank’s existing account endpoint and is never stored here.</p><form method="post" action="/api/login">${hiddenCsrf(csrf)}<label for="token">Clank API token</label><input id="token" name="token" type="password" required maxlength="4096" autocomplete="off" spellcheck="false" aria-describedby="token-help"><p id="token-help" class="hint">Create a token in your Clank account settings. You can revoke it there after verification.</p><button type="submit">Verify account</button></form></section>`);
        }
        return;
      }
      if (req.method === 'GET' && path === '/api/discord/callback') {
        const state = url.searchParams.get('state');
        const stateCookie = cookie(req, STATE);
        setCookie(res, STATE, '', 0);
        if (!session || url.searchParams.getAll('state').length !== 1 || !state || !equal(stateCookie, state)) throw new HttpError(400);
        const userId = core.consumeState(rawSession, state);
        if (userId == null || userId !== session.userId) throw new HttpError(400);
        if (url.searchParams.has('error')) throw new HttpError(400);
        const code = url.searchParams.get('code');
        if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) throw new HttpError(400);
        await core.link(userId, code);
        redirect(res, '/'); return;
      }
      if (req.method === 'GET' && path === '/api/account') {
        if (!session) throw new HttpError(401);
        const user = core.getSourceUser(session.userId);
        if (!user || user.status !== 'active') throw new HttpError(401);
        json(res, 200, { user: { id: user.id, name: user.name, credits: user.credits }, link: core.getLink(session.userId), csrf: session.csrf }); return;
      }
      const postRoutes = ['/api/login', '/api/logout', '/api/discord/link', '/api/discord/sync', '/api/discord/unlink'];
      if (!postRoutes.includes(path)) throw new HttpError(404);
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new HttpError(405); }
      if (req.headers.origin !== config.publicUrl || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403);
      const form = await readForm(req);
      if (path === '/api/login') {
        const csrf = cookie(req, LOGIN);
        if (!csrf || !equal(csrf, form.get('csrf'))) throw new HttpError(403);
        const token = form.get('token');
        if (!token || token.length > 4096 || /[\x00-\x20\x7f]/.test(token)) throw new HttpError(400);
        const user = await core.verifyClankToken(token);
        if (rawSession) core.deleteSession(rawSession);
        setCookie(res, SESSION, core.createSession(user.id), Math.floor(config.sessionTtlMs / 1000));
        setCookie(res, LOGIN, '', 0);
        setCookie(res, STATE, '', 0);
        redirect(res, '/'); return;
      }
      if (!session) throw new HttpError(401);
      if (!equal(session.csrf, form.get('csrf'))) throw new HttpError(403);
      if (path === '/api/logout') {
        core.deleteSession(rawSession);
        setCookie(res, SESSION, '', 0); setCookie(res, STATE, '', 0); setCookie(res, LOGIN, '', 0);
        redirect(res, '/'); return;
      }
      const user = core.getSourceUser(session.userId);
      if (!user || user.status !== 'active') throw new HttpError(401);
      if (path === '/api/discord/link') {
        const state = core.createState(rawSession);
        setCookie(res, STATE, state, 600);
        const authorize = new URL('https://discord.com/oauth2/authorize');
        authorize.search = new URLSearchParams({ client_id: config.discordClientId, redirect_uri: config.redirectUri, response_type: 'code', scope: 'identify role_connections.write', state }).toString();
        redirect(res, authorize.href); return;
      }
      if (path === '/api/discord/sync') await core.syncAll();
      else if (path === '/api/discord/unlink') await core.unlink(session.userId);
      redirect(res, '/');
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const allowed = [400, 401, 403, 404, 405, 409, 413, 415, 429, 502, 503];
      const status = allowed.includes(error?.status) ? error.status : 500;
      const message = error?.code === 'discord_relink_before_unlink'
        ? 'Reconnect the same Discord account before disconnecting so its linked-role metadata can be cleared.'
        : ({ 400: 'Invalid or expired request. Start again from your account page.', 401: 'Account verification is required, or your Clank account is no longer active.', 403: 'Request verification failed. Reload the page and try again.', 404: 'Page not found.', 405: 'This action requires a POST request.', 409: 'This account is already connected elsewhere. Disconnect the existing connection first.', 413: 'Request is too large.', 415: 'Submit this action using the form on your account page.', 429: 'Too many requests. Please wait before trying again.', 502: 'An external service is temporarily unavailable. Please try again later.', 503: 'The service is temporarily unavailable. Please try again later.', 500: 'The request could not be completed. Please try again later.' })[status];
      if (req.url?.startsWith('/api/account') || req.headers.accept?.includes('application/json')) json(res, status, { error: message });
      else page(res, status, 'Request unsuccessful', `<section class="error" role="alert"><h2>Request unsuccessful</h2><p>${message}</p><a href="/">Return to your account</a></section>`);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}
