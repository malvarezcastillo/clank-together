// Web UI. Auth is an HttpOnly session cookie set by /api/login; scripts never
// see it. All server data is inserted with textContent, never as HTML.
//
// One page with views per hash route (#/, #/guide, #/review, #/arcade, #/admin, #/account,
// #/login). Live numbers come over a WebSocket (/api/live); without one, they are polled slowly.

const $ = (id) => document.getElementById(id);
const ROLE_ORDER = ['contributor', 'reviewer', 'maintainer', 'admin'];
let me = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-td-csrf': '1' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { status: res.status });
  return body;
}
const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });
const atLeast = (role) => me && ROLE_ORDER.indexOf(me.role) >= ROLE_ORDER.indexOf(role);
const date = (t) => (t ? new Date(t).toLocaleString() : '');
const fmt = (n) => Number(n ?? 0).toLocaleString();

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined && text !== null) e.textContent = String(text);
  if (cls) e.className = cls;
  return e;
}

function button(label, onClick, cls) {
  const b = el('button', label, cls);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function table(headers, rows) {
  const t = el('table');
  const tr = el('tr');
  headers.forEach((h) => tr.append(el('th', h)));
  t.append(tr);
  rows.forEach((r) => {
    const row = el('tr');
    r.forEach((c) => {
      const td = el('td');
      if (c instanceof Node) td.append(c);
      else if (Array.isArray(c)) td.append(...c);
      else td.textContent = c ?? '';
      row.append(td);
    });
    t.append(row);
  });
  const wrap = el('div', null, 'table-wrap');
  wrap.append(t);
  return wrap;
}

const formData = (form) => Object.fromEntries(new FormData(form).entries());

const ago = (t) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function toast(text, { ms = 4500, icon = '' } = {}) {
  const t = el('div', `${icon ? icon + ' ' : ''}${text}`, 'toast');
  $('toasts').append(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 320);
  }, ms);
}

// A burst of little gears from a point on the screen (merges, wins).
function sparks(x, y, n = 14, glyphs = ['⚙️', '🔩', '✨']) {
  if (reducedMotion()) return;
  for (let i = 0; i < n; i++) {
    const s = el('span', glyphs[i % glyphs.length], 'spark');
    const a = Math.random() * Math.PI * 2;
    const d = 60 + Math.random() * 120;
    s.style.setProperty('left', `${x}px`);
    s.style.setProperty('top', `${y}px`);
    s.style.setProperty('--dx', `${Math.cos(a) * d}px`);
    s.style.setProperty('--dy', `${Math.sin(a) * d - 40}px`);
    s.style.setProperty('--rot', `${(Math.random() - 0.5) * 720}deg`);
    document.body.append(s);
    setTimeout(() => s.remove(), 1300);
  }
}

// Every command or message the reader has to paste gets its own copy button.
function addCopyButtons(root = document) {
  for (const code of root.querySelectorAll('code.cmd:not([data-copy])')) {
    code.dataset.copy = '1';
    const wrap = el('div', null, 'cmd-row');
    code.replaceWith(wrap);
    const btn = button('Copy', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Select and copy';
      }
      setTimeout(() => (btn.textContent = 'Copy'), 2000);
    }, 'copy');
    wrap.append(code, btn);
  }
}

/** A label with an info mark that explains it on hover, focus or tap. */
function withInfo(label, text) {
  const wrap = el('span');
  if (text) {
    const i = el('span', 'i', 'info');
    i.tabIndex = 0;
    i.setAttribute('role', 'note');
    i.setAttribute('aria-label', text);
    i.dataset.tip = text;
    wrap.append(i, ' ');
  }
  wrap.append(label);
  return wrap;
}

const status = (s) => el('span', s, `status ${s}`);

// What each task state means, for the info marks next to them.
const TASK_STATES = {
  open: 'Not started yet. Any agent can claim it (usually with its whole source file).',
  leased: 'An agent claimed it (alone or with its region) and is working on it. The claim expires if the agent goes quiet.',
  verifying: 'Submitted. The server is compiling it once to prove it builds and to compare it.',
  peer_review: 'Compiles but is not byte-identical. Other agents compare the logic with the original: it merges once "same" leads "different" by three (3:0, 4:1, 5:2); at least three "different" leading by two send it back.',
  in_review: 'From the earlier rule (three confirmations, then a human). It is accepted once "same" leads "different" by three.',
  approved: 'Accepted (byte-identical, or five peers confirmed it). Waiting to be merged into main.',
  merging: 'Being merged into main right now.',
  done: 'Merged into main.',
  needs_cleanup: 'Sent back: it did not compile, broke other functions, or reviewers found a difference. The author (then anyone) fixes it.',
  hard: 'Failed several times. Left for later or a stronger agent.',
  skipped: 'Needs no decompilation (compiler-generated, runtime library, ...), confirmed by peer review. Not counted in progress.',
};

// --- router

const VIEWS = { home: null, guide: null, login: null, account: 'contributor', review: 'reviewer', batches: 'contributor', pipeline: 'contributor', arcade: 'contributor', admin: 'admin' };
let currentView = null;

function route() {
  const name = (location.hash.replace(/^#\/?/, '').split('/')[0] || 'home').toLowerCase();
  let view = name in VIEWS ? name : 'home';
  if (VIEWS[view] && !atLeast(VIEWS[view])) view = me ? 'home' : 'login';
  if (view === 'login' && me) view = 'account';
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== view;
  for (const a of document.querySelectorAll('.mainnav a[data-route]')) a.classList.toggle('active', a.dataset.route === view);
  const first = currentView !== view;
  currentView = view;
  if (first) window.scrollTo({ top: 0 });
  const load = { home: loadHome, review: loadReview, batches: loadBatches, pipeline: loadWay, arcade: loadArcade, admin: loadAdmin, account: loadAccount }[view];
  if (load) load().catch((e) => toast(e.message));
  // Deep links: #/review/<attemptId>, #/batches/<batchId>
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (view === 'review' && parts[1]) openAttempt(Number(parts[1])).catch((e) => toast(e.message));
  if (view === 'batches') {
    if (parts[1]) openBatch(Number(parts[1])).catch((e) => toast(e.message));
    else $('batch-detail').hidden = true;
  }
}
window.addEventListener('hashchange', route);

// --- session

async function refresh() {
  try {
    me = await api('/api/me');
  } catch {
    me = null;
  }
  for (const a of document.querySelectorAll('.mainnav a[data-role]')) a.hidden = !atLeast(a.dataset.role);
  $('logout').hidden = !me;
  $('login-link').hidden = !!me;
  $('credits-badge').hidden = !me;
  if (me) {
    $('account-link').title = `${me.name} · ${me.role}`;
    // A dot on Account while the agents are limited or paused: the stats there say why.
    $('account-dot').hidden = !me.quality || me.quality.level === 'ok';
    $('account-dot').title = me.quality?.level === 'ok' ? '' : `${me.quality?.limitedAgents ?? 1} of your agents ${me.quality?.limitedAgents === 1 ? 'is' : 'are'} limited or paused`;
    api('/api/credits/me').then((w) => setCredits(w.balance, false)).catch(() => {});
  }
  connectLive(true);
  api('/api/pause').then(showPause).catch(() => {});
  route();
}

// While an admin has paused submissions, every page says so at the top.
function showPause(state) {
  const bar = $('pause-banner');
  bar.textContent = state.paused ? `🛠 ${state.message}` : '';
  bar.hidden = !state.paused;
}

let credits = null;
function setCredits(n, animate = true) {
  const before = credits;
  credits = n;
  $('credits-n').textContent = fmt(n);
  if ($('wallet-n')) $('wallet-n').textContent = fmt(n);
  if (animate && before !== null && n > before) {
    const b = $('credits-badge');
    b.classList.remove('bump');
    void b.offsetWidth;
    b.classList.add('bump');
    if (currentView !== 'arcade') toast(`+${fmt(n - before)} credits`, { icon: '🪙', ms: 2500 });
  }
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-msg').textContent = '';
  try {
    await post('/api/login', formData(e.target));
    e.target.reset();
    await refresh();
    location.hash = '#/';
  } catch (err) {
    $('login-msg').textContent = err.message;
  }
});

$('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const registration = await post('/api/register', formData(e.target));
    e.target.reset();
    $('register-msg').textContent = registration.status === 'active'
      ? 'Registered. Your account is approved; you can log in now.'
      : 'Registered. You can log in once an admin approves your account.';
  } catch (err) {
    $('register-msg').textContent = err.message;
  }
});

$('logout').addEventListener('click', async () => {
  await post('/api/logout').catch(() => {});
  me = null;
  credits = null;
  await refresh();
  location.hash = '#/';
});

// --- live updates

let socket = null;
let socketUp = false;
let retry = 1000;
const handlers = {
  hello: () => {},
  feed: (m) => addFeed(m.items, true),
  progress: (m) => renderProgress(m.data),
  board: (m) => applyWay(m.change),
  map: (m) => applyMapChanges(m.changes),
  'map-reload': () => loadMap(),
  credits: (m) => setCredits(m.balance),
};

function connectLive(reconnect = false) {
  if (!('WebSocket' in window)) return;
  if (socket && reconnect) {
    // A login or logout changes who the socket belongs to.
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  if (socket) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`);
  socket = ws;
  ws.onopen = () => {
    socketUp = true;
    retry = 1000;
  };
  ws.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      handlers[m.type]?.(m);
    } catch {}
  };
  ws.onclose = () => {
    socketUp = false;
    socket = null;
    setTimeout(() => connectLive(), retry);
    retry = Math.min(retry * 2, 60_000);
  };
}

// Without a socket (blocked by a proxy, or reconnecting), poll slowly while the page is visible.
setInterval(() => {
  if (socketUp || document.visibilityState !== 'visible') return;
  if (currentView === 'home') {
    loadProgress().catch(() => {});
    pollFeed().catch(() => {});
    loadMap().catch(() => {});
  }
  if (me) api('/api/credits/me').then((w) => setCredits(w.balance)).catch(() => {});
}, 30_000);

// The pipeline board moves every few seconds; without the socket it needs its own poll.
setInterval(() => {
  if (socketUp || document.visibilityState !== 'visible' || currentView !== 'pipeline') return;
  loadWay().catch(() => {});
}, 5_000);

// --- home

async function loadHome() {
  await Promise.all([loadProgress(), loadFeed(), loadMap(), loadCrew(), loadBoard()]);
}

async function loadProgress() {
  renderProgress(await api('/api/progress'));
}

// --- pipeline: the way to main (server: board.js)

const WAY_STAGES = [
  ['open', 'Open', 'Nobody holds it yet.'],
  ['leased', 'Leased', 'An agent is porting it.'],
  ['queued', 'Queued', 'Submitted; waiting for a verification lane.'],
  ['compiling', 'Compiling', 'The server is building its batch.'],
  ['review', 'Review', 'Compiled, not byte-identical: peers compare it with the original.'],
  ['merging', 'Merging', 'Approved; in or waiting for the merge lane.'],
];
const WAY_BACK = ['back', 'Back to author', 'Sent back: it did not compile, broke something, or reviewers found a difference.'];
const DOT_LIMIT = 150;
const BLOCKERS = {
  reserved: (b) => `reserved for its author until ${new Date(b.until).toLocaleTimeString()}`,
  hard: () => 'failed too often; left for a stronger agent',
  retry: (b) => `build retried at ${new Date(b.until).toLocaleTimeString()}`,
  maintenance: (b) => `waits for maintenance batch #${b.batch}`,
};
let way = null;
let wayFilter = '';

async function loadWay() {
  way = await api('/api/board');
  way.byTask = new Map(way.functions.map((f) => [f.task, f]));
  renderWay();
}

function applyWay(change) {
  if (!way || currentView !== 'pipeline') return;
  for (const t of change.remove) way.byTask.delete(t);
  for (const f of change.upsert) way.byTask.set(f.task, f);
  Object.assign(way, { at: change.at, counts: change.counts, folders: change.folders, overflow: change.overflow, builds: change.builds });
  renderWay(new Set(change.remove));
}

function wayMatches(f) {
  if (!wayFilter) return true;
  const q = wayFilter.toLowerCase();
  return [f.symbol, f.name, f.folder, f.who, f.batch ? `#${f.batch}` : ''].some((v) => v && String(v).toLowerCase().includes(q));
}

const wayAge = (since) => Math.min(1, Math.max(0, (Date.now() - since) / (6 * 3600_000)));

function wayDot(f) {
  const free = f.stage === 'back' && !f.blocker;
  const d = el('button', null, `way-dot ${f.stage}${f.blocker ? ' blocked' : ''}${free ? ' free' : ''}`);
  d.type = 'button';
  d.dataset.task = f.task;
  d.style.setProperty('--age', wayAge(f.since).toFixed(2));
  if (f.build) d.style.setProperty('--build', `${Math.round((f.build.done / f.build.total) * 100)}%`);
  d.setAttribute('aria-label', `${f.name ?? f.symbol}, ${f.stage}${f.who ? `, ${f.who}` : ''}`);
  return d;
}

function wayTip(f) {
  const lines = [[f.name ?? f.symbol, 'tip-title'], [`${f.symbol} · ${f.folder}`]];
  const stage = [...WAY_STAGES, WAY_BACK].find(([k]) => k === f.stage)?.[1] ?? f.stage;
  lines.push([`${stage} for ${ago(f.since).replace(' ago', '')}${f.who ? ` · ${f.who}` : ''}${f.batch ? ` · batch #${f.batch}` : ''}`]);
  if (f.build) lines.push([`compiled ${f.build.done} of ${f.build.total} units`]);
  if (f.votes) lines.push([`votes: ${f.votes.same} same · ${f.votes.different} different`]);
  if (f.why) lines.push([`came back: ${f.why}`, 'warn']);
  if (f.cycles) lines.push([`${f.cycles} time(s) back so far`]);
  if (f.blocker) lines.push([`⛔ ${BLOCKERS[f.blocker.kind]?.(f.blocker) ?? f.blocker.kind}`, 'warn']);
  return lines.map(([t, c]) => el('div', t, c));
}

// A column shows its functions one dot each while they fit, else one chip per batch (or holder),
// else counts per folder; open functions are always counted per folder.
function wayColumn([key, label, hint], fns, removed) {
  const col = el('section', null, `way-col ${key}`);
  const head = el('header', null, 'way-head');
  head.title = hint;
  head.append(el('span', label, 'way-label'), el('span', fmt(way.counts[key] ?? 0), 'way-n'));
  col.append(head);
  const body = el('div', null, 'way-body');
  const shown = fns.filter(wayMatches);
  if (key === 'open' || way.overflow.includes(key)) {
    const folders = Object.entries(way.folders[key] ?? {}).filter(([f]) => !wayFilter || f.toLowerCase().includes(wayFilter.toLowerCase())).sort((a, b) => b[1] - a[1]);
    for (const [folder, n] of folders.slice(0, 12)) body.append(wayChip(folder, n, (way.counts[key] || 1)));
    if (folders.length > 12) body.append(el('div', `+ ${folders.length - 12} more folders`, 'muted way-more'));
  } else if (shown.length <= DOT_LIMIT) {
    const dots = el('div', null, 'way-dots');
    for (const f of shown) dots.append(wayDot(f));
    body.append(dots);
  } else {
    const groups = new Map();
    for (const f of shown) {
      const k = key === 'leased' || key === 'back' ? f.who ?? '(nobody)' : f.batch ? `#${f.batch}` : '(no batch)';
      groups.set(k, (groups.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 20)) body.append(wayChip(k, n, shown.length));
  }
  if (!body.children.length) body.append(el('div', wayFilter ? 'no match' : '—', 'muted way-empty'));
  col.append(body);
  return col;
}

function wayChip(label, n, of) {
  const c = el('div', null, 'way-chip');
  c.style.setProperty('--share', `${Math.max(4, Math.round((n / of) * 100))}%`);
  c.append(el('span', label, 'way-chip-l'), el('span', fmt(n), 'way-chip-n'));
  return c;
}

// Dots keep their place between renders: each moved dot slides from where it was (FLIP), a new
// one pops in, and a function that left the board (merged) fades out where it last was.
function renderWay(removed = new Set()) {
  const host = $('way');
  const before = new Map([...host.querySelectorAll('.way-dot')].map((d) => [Number(d.dataset.task), d.getBoundingClientRect()]));
  const fns = [...way.byTask.values()].sort((a, b) => a.since - b.since || a.task - b.task);
  const byStage = (k) => fns.filter((f) => f.stage === k);

  const flow = el('div', null, 'way-flow');
  for (const s of WAY_STAGES) flow.append(wayColumn(s, byStage(s[0]), removed));
  const back = wayColumn(WAY_BACK, byStage('back'), removed);
  back.classList.add('way-back');
  host.replaceChildren(flow, back);

  const total = WAY_STAGES.reduce((n, [k]) => n + (way.counts[k] ?? 0), 0) + (way.counts.back ?? 0);
  $('way-summary').textContent = `${fmt(total)} functions on their way${way.builds.length ? '' : ' · compilers idle'}`;
  renderWayBuilds();

  const blocked = fns.filter((f) => f.blocker && wayMatches(f));
  const reasons = new Map();
  for (const f of blocked) {
    const k = f.blocker.kind === 'reserved' ? 'reserved' : BLOCKERS[f.blocker.kind]?.(f.blocker) ?? f.blocker.kind;
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }
  const free = fns.filter((f) => f.stage === 'back' && !f.blocker && wayMatches(f)).length;
  $('way-blocked').replaceChildren(
    ...[...reasons].map(([k, n]) => el('span', `⛔ ${n} ${k === 'reserved' ? 'reserved for their authors' : k}`, 'way-reason')),
    ...(free ? [el('span', `✋ ${free} back to author and free for anyone to claim`, 'way-reason free')] : []),
  );

  if (reducedMotion()) return;
  for (const d of host.querySelectorAll('.way-dot')) {
    const was = before.get(Number(d.dataset.task));
    const now = d.getBoundingClientRect();
    if (was) {
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (dx || dy) d.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 700, easing: 'cubic-bezier(.2,.8,.2,1)' });
    } else if (before.size) d.animate([{ opacity: 0, transform: 'scale(2)' }, { opacity: 1, transform: 'none' }], { duration: 500 });
  }
  for (const t of removed) {
    const was = before.get(t);
    if (!was) continue;
    const ghost = el('span', null, 'way-dot merging way-ghost');
    ghost.style.left = `${was.left + scrollX}px`;
    ghost.style.top = `${was.top + scrollY}px`;
    document.body.append(ghost);
    ghost.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(-24px) scale(1.6)', opacity: 0 }], { duration: 900, easing: 'ease-out' }).finished.then(() => ghost.remove());
  }
}

const BUILD_LANES = { verify: 'verifying', merge: 'merging', maintenance: 'maintenance', 'maintenance-base': 'main, for comparison', baseline: 'refreshing main scores', other: 'build' };

// One bar per build the server is running, moving from its previous reading.
function renderWayBuilds() {
  const host = $('way-builds');
  host.replaceChildren(...way.builds.map((b) => {
    const pct = b.total ? (b.done / b.total) * 100 : 0;
    const row = el('div', null, 'pbar');
    row.append(el('div', `${pct.toFixed(1)}%`, 'readout'));
    const right = el('div', null, 'pbar-body');
    const label = el('div', null, 'pbar-label');
    if (b.batch !== null) {
      const link = el('a', `#${b.batch}`);
      link.href = `#/batches/${b.batch}`;
      label.append(link, ` ${b.author ?? ''} · `);
    }
    label.append(BUILD_LANES[b.lane] ?? b.lane);
    const meter = el('div', null, 'meter');
    meter.setAttribute('role', 'progressbar');
    meter.setAttribute('aria-label', b.job);
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    meter.setAttribute('aria-valuenow', pct.toFixed(1));
    const fill = el('div', null, 'fill');
    const key = `way:${b.job}`;
    fill.style.setProperty('width', `${Math.min(100, lastBars[key] ?? 0)}%`);
    lastBars[key] = pct;
    meter.append(fill);
    setTimeout(() => fill.style.setProperty('width', `${Math.min(100, pct)}%`), 30);
    right.append(label, meter, el('div', `${fmt(b.done)} of ${fmt(b.total)} units compiled${b.startedAt ? ` · started ${ago(Date.parse(b.startedAt))}` : ''}`, 'pbar-detail'));
    row.append(right);
    return row;
  }));
}

$('way').addEventListener('mousemove', (e) => {
  const d = e.target.closest?.('.way-dot');
  const tip = $('way-tip');
  const f = d && way?.byTask.get(Number(d.dataset.task));
  if (!f) {
    tip.hidden = true;
    return;
  }
  tip.replaceChildren(...wayTip(f));
  tip.hidden = false;
  const r = $('way').closest('.plate').getBoundingClientRect();
  tip.style.left = `${Math.min(e.clientX - r.left + 14, r.width - 300)}px`;
  tip.style.top = `${e.clientY - r.top + 14}px`;
});
$('way').addEventListener('mouseleave', () => ($('way-tip').hidden = true));
$('way').addEventListener('click', (e) => {
  const f = way?.byTask.get(Number(e.target.closest?.('.way-dot')?.dataset.task));
  if (f?.batch) location.hash = `#/batches/${f.batch}`;
});
$('way-search').addEventListener('input', (e) => {
  wayFilter = e.target.value.trim();
  if (way) renderWay();
});

const lastBars = {}; // bars move from the previous reading, not from zero, when they refresh
let lastStats = {};
let lastProgress = null;

function renderProgress(p) {
  lastProgress = p;
  const body = $('progress-body');
  body.replaceChildren();
  body.className = '';
  // Done = merged into main: byte-identical, plus peer-confirmed (same logic, other bytes). The bars
  // show the total; the byte-identical part has its own colour.
  const identical = p.byStatus.filter((s) => s.status === 'exact' || s.status === 'match_unresolved').reduce((t, s) => ({ n: t.n + s.n, bytes: t.bytes + s.bytes }), { n: 0, bytes: 0 });
  const confirmed = { n: p.confirmed?.n ?? 0, bytes: p.confirmed?.bytes ?? 0 };
  if (!p.functions) {
    body.append(el('p', 'No target loaded yet. The machines are warming up.', 'muted'));
    return;
  }
  const pct = (a, b) => (b ? (a / b) * 100 : 0);
  const kb = (n) => `${(n / 1024).toLocaleString(undefined, { maximumFractionDigits: 0 })} KB`;
  const bars = el('div', null, 'progress-bars');
  const bar = (key, label, done, of, f) => {
    const total = done.identical + done.confirmed;
    const row = el('div', null, 'pbar');
    row.append(el('div', `${pct(total, of).toFixed(2)}%`, 'readout'));
    const right = el('div', null, 'pbar-body');
    right.append(el('div', `${label}: ${f(total)} of ${f(of)} done`, 'pbar-label'));
    const meter = el('div', null, 'meter');
    meter.setAttribute('role', 'progressbar');
    meter.setAttribute('aria-label', label);
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    meter.setAttribute('aria-valuenow', pct(total, of).toFixed(2));
    for (const [cls, w, title] of [
      ['identical', pct(done.identical, of), `byte-identical: ${f(done.identical)}`],
      ['confirmed', pct(done.confirmed, of), `confirmed by peer review: ${f(done.confirmed)}`],
    ]) {
      const seg = el('div', null, `fill ${cls}`);
      seg.title = title;
      seg.style.setProperty('width', `${Math.min(100, lastBars[key + cls] ?? 0)}%`);
      lastBars[key + cls] = w;
      meter.append(seg);
      setTimeout(() => seg.style.setProperty('width', `${Math.min(100, w)}%`), 30);
    }
    right.append(meter, el('div', `byte-identical ${f(done.identical)} (${pct(done.identical, of).toFixed(2)}%) · peer-confirmed ${f(done.confirmed)} (${pct(done.confirmed, of).toFixed(2)}%)`, 'pbar-detail'));
    row.append(right);
    bars.append(row);
  };
  // The pace: what landed on main in the last hour, and the average over the last day.
  if (p.merges) {
    const rate = el('div', null, 'rates');
    const r = (n, unit, avg) => {
      const box = el('div', null, 'rate');
      box.append(el('span', n, 'rate-n'), el('span', unit, 'rate-u'), el('span', avg, 'muted rate-avg'));
      return box;
    };
    rate.append(
      r(fmt(p.merges.lastHour), 'functions / h', `avg ${p.merges.perHourDay.toFixed(1)}/h over 24 h`),
      r(kb(p.merges.bytesLastHour ?? 0), 'of code / h', `avg ${kb(p.merges.bytesPerHourDay ?? 0)}/h over 24 h`),
    );
    bars.append(rate);
  }
  bar('fn', 'Functions', { identical: identical.n, confirmed: confirmed.n }, p.functions, fmt);
  bar('by', 'Code', { identical: identical.bytes, confirmed: confirmed.bytes }, p.bytes, kb);
  const legend = el('div', null, 'pbar-legend');
  legend.append(el('span', 'byte-identical', 'swatch identical'), el('span', 'confirmed by peer review', 'swatch confirmed'));
  bars.append(legend);
  body.append(bars);

  const states = Object.fromEntries(p.byTaskState.map((s) => [s.state, s.n]));
  const d = el('details', null, 'fold');
  d.append(el('summary', 'Every task state'), table(['Task state', 'Count'], p.byTaskState.map((s) => [withInfo(s.state, TASK_STATES[s.state]), fmt(s.n)])));
  body.append(d);

  // The tiles next to the headline.
  const tiles = [
    ['done', `${pct(identical.n + confirmed.n, p.functions).toFixed(2)}%`, 'of functions done'],
    ['hour', fmt(p.merges?.lastHour ?? 0), 'merged in the last hour'],
    ['flight', fmt((states.verifying ?? 0) + (states.peer_review ?? 0) + (states.approved ?? 0) + (states.merging ?? 0)), 'on their way to main'],
    ['review', fmt(p.peerQueue ?? 0), 'waiting for peer review'],
  ];
  const box = $('hero-stats');
  box.replaceChildren();
  for (const [key, n, label] of tiles) {
    const t = el('div', null, 'stat-tile');
    t.append(el('div', n, 'n'), el('div', label, 'l'));
    if (lastStats[key] !== undefined && lastStats[key] !== n) t.classList.add('tick');
    lastStats[key] = n;
    box.append(t);
  }
}

// Feed

let lastFeedId = 0;
const FEED = {
  submit: (e) => ['📤', `${e.user} submitted ${e.functions} function${e.functions === 1 ? '' : 's'}`],
  merged: (e) => ['✅', `${e.functions} function${e.functions === 1 ? '' : 's'} by ${e.user} landed on main`],
  auto_accepted: () => ['🗳️', 'five agents confirmed a function'],
  region_claim: (e) => ['📌', `${e.user} took ${shortPath(e.key)}${e.shared ? ' (shared)' : ''}`],
  game_win: (e) => ['🎰', `${e.user} won ${fmt(e.payout)} credits at ${e.game}!`],
  user_approved: () => ['👋', 'a new crew member joined'],
  no_decompile_claim: (e) => ['🧹', `${e.user} marked ${e.functions} function${e.functions === 1 ? '' : 's'} as needing no source`],
};
const shortPath = (p) => (p ? p.split('/').slice(-2).join('/') : '?');

async function loadFeed() {
  const items = await api('/api/feed');
  lastFeedId = 0;
  $('feed-list').replaceChildren();
  addFeed(items.slice().reverse(), false);
}

async function pollFeed() {
  const items = await api(`/api/feed?after=${lastFeedId}`);
  addFeed(items.slice().reverse(), true);
}

// Items come oldest first; the newest ends up on top.
function addFeed(items, live) {
  const list = $('feed-list');
  for (const e of items) {
    if (e.id <= lastFeedId) continue;
    lastFeedId = e.id;
    const f = FEED[e.type];
    if (!f) continue;
    const [icon, text] = f(e);
    const li = el('li', null, e.type);
    li.append(el('span', icon, 'ico'), el('span', text), el('span', ago(e.at), 'when'));
    li.dataset.at = e.at;
    if (live) li.classList.add('new');
    list.prepend(li);
    if (live && e.type === 'merged' && currentView === 'home') {
      const r = $('map-canvas').getBoundingClientRect();
      sparks(r.left + r.width / 2, r.top + 30, 10);
    }
    if (live && e.type === 'game_win' && me && e.user === me.name) sparks(window.innerWidth - 80, 40, 18, ['🪙', '✨', '🎉']);
  }
  while (list.children.length > 60) list.lastChild.remove();
}
setInterval(() => {
  for (const li of $('feed-list').children) li.lastChild.textContent = ago(Number(li.dataset.at));
}, 30_000);

// Map

const STATE_INFO = {
  d: ['byte-identical', '--st-d'],
  c: ['peer-confirmed', '--st-c'],
  s: ['needs no source', '--st-s'],
  f: ['on its way to main', '--st-f'],
  l: ['claimed', '--st-l'],
  b: ['sent back', '--st-b'],
  o: ['open', '--st-o'],
};
const map = { states: '', units: [], unitOf: [], cell: 4, cols: 1, colors: {}, highlight: null, pulses: new Map() };

async function loadMap() {
  const m = await api('/api/map');
  map.states = m.states;
  map.units = m.units;
  map.unitOf = m.unitOf;
  drawMap();
}

function mapColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const [k, [, v]] of Object.entries(STATE_INFO)) map.colors[k] = cs.getPropertyValue(v).trim();
}

function drawMap() {
  const canvas = $('map-canvas');
  const n = map.states.length;
  if (!n) return;
  mapColors();
  const width = canvas.parentElement.clientWidth;
  // Cells as big as fit into about 560 px of height, at least 3 px.
  const cell = Math.max(3, Math.min(14, Math.floor(Math.sqrt((width * 560) / n))));
  map.cell = cell;
  map.cols = Math.max(1, Math.floor(width / cell));
  const rows = Math.ceil(n / map.cols);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = map.cols * cell * dpr;
  canvas.height = rows * cell * dpr;
  canvas.style.setProperty('height', `${rows * cell}px`);
  canvas.style.setProperty('width', `${map.cols * cell}px`);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, map.cols * cell, rows * cell);
  for (let i = 0; i < n; i++) drawCell(g, i);
  renderLegend();
}

function drawCell(g, i, flash = 0) {
  const x = (i % map.cols) * map.cell;
  const y = Math.floor(i / map.cols) * map.cell;
  const gap = map.cell >= 5 ? 1 : 0;
  const dim = map.highlight && !map.highlight.has(map.unitOf[i]);
  g.globalAlpha = dim ? 0.18 : 1;
  g.fillStyle = map.colors[map.states[i]] || map.colors.o;
  g.fillRect(x, y, map.cell - gap, map.cell - gap);
  if (flash > 0) {
    g.globalAlpha = flash;
    g.fillStyle = '#ffffff';
    g.fillRect(x, y, map.cell - gap, map.cell - gap);
  }
  g.globalAlpha = 1;
}

function renderLegend() {
  const counts = {};
  for (const c of map.states) counts[c] = (counts[c] ?? 0) + 1;
  const box = $('map-legend');
  box.replaceChildren();
  for (const [k, [label, v]] of Object.entries(STATE_INFO)) {
    const s = el('span', label, 'sw');
    s.style.setProperty('--c', `var(${v})`);
    s.append(el('span', fmt(counts[k] ?? 0), 'n'));
    box.append(s);
  }
}

// Changed squares flash white and fade back to their new colour.
function applyMapChanges(changes) {
  if (!map.states) return;
  const arr = map.states.split('');
  for (const [i, c] of changes) {
    arr[i] = c;
    map.pulses.set(i, 1);
  }
  map.states = arr.join('');
  renderLegend();
  if (!pulsing) requestAnimationFrame(pulseFrame);
}
let pulsing = false;
function pulseFrame() {
  const g = $('map-canvas').getContext('2d');
  pulsing = map.pulses.size > 0;
  for (const [i, v] of map.pulses) {
    const next = v - 0.04;
    drawCell(g, i, reducedMotion() ? 0 : Math.max(0, next));
    if (next <= 0) map.pulses.delete(i);
    else map.pulses.set(i, next);
  }
  if (map.pulses.size) requestAnimationFrame(pulseFrame);
  else pulsing = false;
}

function mapIndexAt(ev) {
  const r = $('map-canvas').getBoundingClientRect();
  const col = Math.floor((ev.clientX - r.left) / map.cell);
  const row = Math.floor((ev.clientY - r.top) / map.cell);
  if (col < 0 || col >= map.cols) return -1;
  const i = row * map.cols + col;
  return i >= 0 && i < map.states.length ? i : -1;
}

let tipTimer = null;
$('map-canvas').addEventListener('mousemove', (ev) => {
  const i = mapIndexAt(ev);
  const tip = $('map-tip');
  if (i < 0) return (tip.hidden = true);
  const wrap = $('map-wrap').getBoundingClientRect();
  tip.hidden = false;
  tip.replaceChildren(el('div', map.units[map.unitOf[i]]), el('div', STATE_INFO[map.states[i]][0], 'muted'));
  const x = Math.min(ev.clientX - wrap.left + 14, wrap.width - 240);
  tip.style.setProperty('left', `${Math.max(4, x)}px`);
  tip.style.setProperty('top', `${ev.clientY - wrap.top + 14}px`);
  clearTimeout(tipTimer);
  tipTimer = setTimeout(async () => {
    try {
      const f = await api(`/api/map/${i}`);
      if (!tip.hidden) tip.prepend(el('div', `${f.symbol}${f.name ? ` ${f.name}` : ''}`));
    } catch {}
  }, 250);
});
$('map-canvas').addEventListener('mouseleave', () => ($('map-tip').hidden = true));
$('map-canvas').addEventListener('click', async (ev) => {
  const i = mapIndexAt(ev);
  if (i < 0) return;
  const f = await api(`/api/map/${i}`).catch(() => null);
  if (!f) return;
  const d = $('map-detail');
  d.hidden = false;
  d.replaceChildren(
    el('div', `${f.symbol}  ${f.name ?? '(unnamed)'}  ·  ${f.size ?? '?'} bytes`),
    el('div', `${f.unit ?? 'not placed in a source file yet'}  ·  ${f.state}${f.holder ? ` (claimed by ${f.holder})` : ''}`, 'muted'),
  );
  if (f.unit) d.append(button(`Highlight ${shortPath(f.unit)}`, () => { $('map-search').value = f.unit; highlight(f.unit); }));
});
function highlight(q) {
  q = q.trim().toLowerCase();
  if (!q) map.highlight = null;
  else map.highlight = new Set(map.units.map((u, i) => (u.toLowerCase().includes(q) ? i : -1)).filter((i) => i >= 0));
  drawMap();
}
$('map-search').addEventListener('input', (e) => highlight(e.target.value));
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => currentView === 'home' && drawMap(), 150);
});
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => drawMap());

// Crew and leaderboards

async function loadCrew() {
  const c = await api('/api/crew');
  const active = $('active-body');
  active.replaceChildren();
  active.classList.remove('muted');
  if (!c.active.length) {
    active.append(el('p', `No agent has checked in during the last ${c.activeMinutes} minutes.`, 'muted'));
  } else {
    active.append(
      table(
        ['User', 'Working on', 'Peer reviews', 'Being checked', 'Submitted (24 h)', 'Last seen'],
        c.active.map((a) => {
          // Counts only, never file names: the column stays narrow.
          const fns = a.units.reduce((t, u) => t + u.functions, 0);
          const work = fns
            ? el('span', `${fmt(fns)} function${fns > 1 ? 's' : ''} · ${a.units.length} file${a.units.length > 1 ? 's' : ''}`)
            : el('span', a.reviewing ? `reviewing ${a.reviewing}` : a.verifying ? 'waiting for the server' : 'between regions', 'muted');
          work.title = a.units.map((u) => `${u.unit} (${u.functions})`).join('\n');
          return [`${a.name}${a.agents > 1 ? ` (${a.agents} agents)` : ''}`, work, a.reviewing || '', a.verifying || '', a.submittedToday, ago(a.lastSeen)];
        }),
      ),
    );
  }
  $('users-count').textContent = `${c.users.length} approved`;
  $('users-body').replaceChildren(
    table(
      ['User', 'Role', 'Merged', 'Submitted', 'Peer reviews', 'Joined', 'Agent last seen'],
      c.users.map((u) => [u.name, u.role, u.merged, u.submitted, u.peer_reviews, u.joined ? new Date(u.joined).toLocaleDateString() : '', ago(u.last_seen)]),
    ),
  );
}

let board = 'merged';
for (const t of document.querySelectorAll('#board-tabs .tab')) {
  t.addEventListener('click', () => {
    board = t.dataset.board;
    for (const x of document.querySelectorAll('#board-tabs .tab')) x.classList.toggle('active', x === t);
    loadBoard().catch(() => {});
  });
}

async function loadBoard() {
  const body = $('board-body');
  body.classList.remove('muted');
  const medal = (i) => ['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`;
  if (board === 'merged') {
    const p = lastProgress ?? (await api('/api/progress'));
    body.replaceChildren(table(['', 'Crew', 'Merged'], p.contributors.slice(0, 15).map((c, i) => [medal(i), c.name, fmt(c.merged)])));
    return;
  }
  const b = await api('/api/credits/leaderboard');
  if (board === 'credits') body.replaceChildren(table(['', 'Player', 'Credits', 'Earned'], b.rich.map((r, i) => [medal(i), r.name, fmt(r.balance), fmt(r.earned)])));
  else body.replaceChildren(b.wins.length ? table(['Player', 'Game', 'Bet', 'Won'], b.wins.map((w) => [w.name, w.game, fmt(w.bet), fmt(w.payout)])) : el('p', 'No big wins today. Yet.', 'muted'));
}

// --- account

async function loadAccount() {
  const [tokens, wallet] = await Promise.all([api('/api/me/tokens'), api('/api/credits/me').catch(() => null)]);
  const sum = $('account-summary');
  sum.replaceChildren();
  const tile = (n, l) => {
    const t = el('div', null, 'stat-tile');
    t.append(el('div', n, 'n'), el('div', l, 'l'));
    return t;
  };
  sum.append(tile(me.name, me.role));
  if (wallet) sum.append(tile(fmt(wallet.balance), 'credits'));
  sum.append(tile(fmt(me.leases?.length ?? 0), 'functions held'));
  if (me.regions?.length) sum.append(tile(fmt(me.regions.length), `region${me.regions.length > 1 ? 's' : ''} claimed`));
  renderTokens(tokens);
  renderQuality(await api('/api/me/quality').catch(() => null));
}

// How each agent (API token) of the account is doing: level, what broke, recent examples, the
// daily reset per agent. Work from before agents were told apart is shown while it still counts.
function renderQuality(q) {
  const box = $('my-quality');
  box.replaceChildren();
  if (!q) return;
  if (!q.tokens.length) box.append(el('p', 'No agent tokens yet: create one below, and its stats show up here.', 'muted'));
  for (const t of q.tokens) box.append(agentCard(t));
  if (q.legacy) {
    const l = el('div', null, 'agent-card');
    l.append(el('div', 'Before agents were told apart (last 24 hours)', 'agent-title'), el('p', `${fmt(q.legacy.submitted)} functions submitted; ${q.legacy.peerDecided ? `${Math.round(q.legacy.peerRate * 100)}% of ${q.legacy.peerDecided} sent back by peers` : 'none reviewed'}; ${Math.round(q.legacy.brokenRate * 100)}% broken or refused.${q.legacy.level !== 'ok' ? ' This still counts for your agents until it ages out, or until you reset them.' : ''}`, 'hint'));
    box.append(l);
  }
  box.append(el('p', 'Each agent is judged on its own. Half of its functions sent back by peers (20+ reviewed) or 60% broken (50+ submitted) limits it; 70% sent back (30+) or 85% broken (80+) pauses it. Both lift by themselves as its last 24 hours get better.', 'hint'));
}

// Short form for tables: skips peer review / verdict weight.
function trustCell(t) {
  if (!t) return '-';
  const parts = [];
  if (t.author.trusted) parts.push(el('div', `skips review at ${Math.round(t.author.skipAt * 100)}%+`, 'status active'));
  if (t.reviewer.weight > 1) parts.push(el('div', `verdicts count ×${t.reviewer.weight}`, 'status active'));
  parts.push(el('div', `author ${Math.round(t.author.score * 100)}% · reviewer ${Math.round(t.reviewer.sameScore * 100)}/${Math.round(t.reviewer.differentScore * 100)}%`, 'hint'));
  return parts;
}

// What the agent has earned: skipping peer review as an author, more weight as a reviewer.
function trustBlock(t) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const box = el('div', null, 'trust');
  const au = t.author;
  const rv = t.reviewer;
  const authorLine = au.trusted
    ? `Trusted author: its functions scoring ${pct(au.skipAt)} or more are accepted without peer review (one in ${Math.round(1 / t.sample)} still goes to peers, to keep the record measured).`
    : `Not yet a trusted author. Of its functions scoring ${pct(au.needs.bandAt)}+ that peers decided (14 days), ${fmt(au.accepted)} were accepted and ${fmt(au.rejected)} sent back: ${pct(au.score)} at the least (needs ${pct(au.needs.score)} over ${au.needs.decided}+ functions).`;
  const tiers = rv.tiers.map((x) => `×${x.weight}: ${pct(x.same)} / ${pct(x.different)} over ${x.minDifferent}+ differences`).join(', ');
  const reviewerLine = `Reviewer: agrees with the other reviewers ${pct(rv.sameScore)} of the time when they found it the same (${fmt(rv.same)}), ${pct(rv.differentScore)} when they found a difference (${fmt(rv.different)}), at the least (30 days). ${rv.weight > 1 ? `Its verdicts count ×${rv.weight}.` : `Its verdicts count once (${tiers}).`}`;
  box.append(
    el('div', null, 'quality-head'),
    el('p', authorLine, au.trusted ? 'good' : 'hint'),
    el('p', reviewerLine, rv.weight > 1 ? 'good' : 'hint'),
  );
  box.firstChild.append(el('span', 'Trust', 'agent-subtitle'), ...(au.trusted ? [el('span', 'skips review', 'status active')] : []), ...(rv.weight > 1 ? [el('span', `reviews ×${rv.weight}`, 'status active')] : []));
  return box;
}

function agentCard(q) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const card = el('div', null, `agent-card ${q.level}`);
  const head = el('div', null, 'quality-head');
  head.append(el('span', q.label ?? 'agent', 'agent-title'), el('span', q.level === 'ok' ? 'all good' : q.level, `status ${q.level === 'ok' ? 'active' : q.level === 'limited' ? 'pending' : 'revoked'}`));
  if (q.resetAt && q.resetAt > Date.now() - 24 * 3600_000) head.append(el('span', `counting since your reset ${ago(q.resetAt)}`, 'hint'));
  card.append(head);
  if (q.reasons.length) card.append(el('p', q.reasons.join('; '), 'warn'));
  const prev = q.previous ?? {};
  const trend = (now_, before) => {
    if (before === null) return '';
    const d = now_ - before;
    if (Math.abs(d) < 0.02) return ' (same as the day before)';
    return ` (${d < 0 ? 'down' : 'up'} from ${pct(before)}: ${d < 0 ? 'better' : 'worse'})`;
  };
  card.append(
    table(['Last 24 hours', ''], [
      ['Functions submitted', fmt(q.submitted)],
      ['Merged', `${fmt(q.merged)} (${fmt(q.identical)} byte-identical)`],
      ['Sent back by peers', q.peerDecided ? `${pct(q.peerRate)} of ${fmt(q.peerDecided)} reviewed${trend(q.peerRate, prev.peerDecided ? prev.peerRate : null)}` : 'none reviewed yet'],
      ['Broken or refused', q.submitted ? `${pct(q.brokenRate)} of ${fmt(q.submitted)}${trend(q.brokenRate, prev.submitted ? prev.brokenRate : null)}` : '-'],
    ]),
  );
  if (q.trust) card.append(trustBlock(q.trust));
  if (q.kinds.length) card.append(el('p', `What broke: ${q.kinds.map((k) => `${fmt(k.functions)} ${k.label}`).join(' · ')}`, 'muted'));
  if (q.sentBack.length) {
    const d = el('details', null, 'fold');
    d.append(el('summary', `Latest functions peers sent back (${q.sentBack.length})`));
    for (const s of q.sentBack) {
      d.append(el('p', `${s.symbol} ${s.name ?? ''}`, 'mono'));
      for (const r of s.reasons) d.append(el('p', `· ${r?.text ?? ''}`, 'hint'));
    }
    card.append(d);
  }
  if (q.broken.length) {
    const d = el('details', null, 'fold');
    d.append(el('summary', `Latest broken submissions (${q.broken.length})`), ...q.broken.map((b) => el('p', `${b.symbol}: ${b.summary}`, 'hint')));
    card.append(d);
  }
  if (q.level !== 'ok') {
    const row = el('div', null, 'actions');
    const reset = button('Reset this agent', async () => {
      if (!confirm(`Start counting from now for "${q.label ?? 'this agent'}"? Only its work after this counts. If it keeps doing the same, it is limited again once its new work fills the same thresholds. One reset per agent per 24 hours.`)) return;
      try {
        await post('/api/me/quality/reset', { tokenId: q.tokenId });
        toast('Reset: counting from now. Fix what the agent does wrong before letting it go on.', { icon: '🔄' });
        renderQuality(await api('/api/me/quality'));
        refresh();
      } catch (e) {
        toast(e.message);
      }
    }, 'primary');
    reset.disabled = !q.canReset;
    row.append(reset);
    if (!q.canReset) row.append(el('span', q.mode === 'paused' ? ' A maintainer paused this account; ask them.' : ` Next reset possible ${q.nextResetAt ? new Date(q.nextResetAt).toLocaleString() : 'later'}.`, 'hint'));
    card.append(row);
  }
  return card;
}

function renderTokens(tokens) {
  const box = $('tokens');
  box.replaceChildren();
  const active = tokens.filter((t) => !t.revoked_at);
  if (!active.length) return box.append(el('p', 'No active tokens.', 'muted'));
  box.append(
    table(
      ['Label', 'Created', 'Last used', ''],
      active.map((t) => [
        t.label,
        date(t.created_at),
        date(t.last_used_at) || 'never',
        button(
          'Revoke',
          async () => {
            if (!confirm(`Revoke token "${t.label}"? Agents using it stop working immediately.`)) return;
            await post(`/api/me/tokens/${t.id}/revoke`);
            renderTokens(await api('/api/me/tokens'));
          },
          'danger',
        ),
      ]),
    ),
  );
}

$('token-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const t = await post('/api/me/tokens', formData(e.target));
    e.target.reset();
    $('new-token-value').textContent = t.token;
    $('install-win').textContent = `$env:TD_TOKEN='${t.token}'; irm ${location.origin}/install.ps1 | iex`;
    $('install-linux').textContent = `curl -fsSL ${location.origin}/install.sh | TD_TOKEN=${t.token} sh`;
    $('new-token').hidden = false;
    addCopyButtons($('new-token'));
    renderTokens(await api('/api/me/tokens'));
  } catch (err) {
    toast(err.message);
  }
});

$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await post('/api/me/password', formData(e.target));
    e.target.reset();
    await refresh();
    location.hash = '#/login';
    $('login-msg').textContent = 'Password changed. Log in with the new password.';
  } catch (err) {
    $('password-msg').textContent = err.message;
  }
});

// --- admin

async function adminAction(name, action, body) {
  $('admin-msg').textContent = '';
  try {
    const r = await post(`/api/admin/users/${encodeURIComponent(name)}/${action}`, body);
    await loadAdmin();
    return r;
  } catch (err) {
    $('admin-msg').textContent = err.message;
    return null;
  }
}
$('auto-approve').addEventListener('change', async (e) => {
  const toggle = e.target;
  const previous = !toggle.checked;
  toggle.disabled = true;
  $('registration-msg').textContent = '';
  try {
    const settings = await post('/api/admin/registration', { autoApprove: toggle.checked });
    toggle.checked = settings.autoApprove;
    $('registration-msg').textContent = settings.autoApprove
      ? 'Auto approval is on. New accounts can log in immediately.'
      : 'Auto approval is off. New accounts need manual approval.';
  } catch (err) {
    toggle.checked = previous;
    $('registration-msg').textContent = err.message;
  } finally {
    toggle.disabled = false;
  }
});
$('pause-submissions').addEventListener('change', async (e) => {
  const toggle = e.target;
  const previous = !toggle.checked;
  if (toggle.checked && !confirm('Pause submissions? Every account below maintainer is refused claims, submissions and checks until you switch it off. Peer reviews stay open.')) {
    toggle.checked = previous;
    return;
  }
  toggle.disabled = true;
  $('pause-msg').textContent = '';
  try {
    const state = await post('/api/admin/pause', { paused: toggle.checked });
    toggle.checked = state.paused;
    $('pause-msg').textContent = state.paused ? 'Submissions are paused.' : 'Submissions are open.';
    showPause(state);
  } catch (err) {
    toggle.checked = previous;
    $('pause-msg').textContent = err.message;
  } finally {
    toggle.disabled = false;
  }
});


let adminData = null;
async function loadAdmin() {
  const [users, authors, registration, pause] = await Promise.all([api('/api/admin/users'), api('/api/admin/authors').catch(() => ({ authors: [] })), api('/api/admin/registration'), api('/api/pause')]);
  adminData = users;
  $('auto-approve').checked = registration.autoApprove;
  $('pause-submissions').checked = pause.paused;
  $('pause-submissions').disabled = false;
  $('auto-approve').disabled = false;
  renderAdmin();
  renderAuthors(authors.authors);
}

function renderAuthors(authors) {
  const pct = (a) => `${Math.round(a * 100)}%`;
  const chip = (level) => el('span', level, `status ${level === 'ok' ? 'active' : level === 'limited' ? 'pending' : 'revoked'}`);
  $('authors').replaceChildren(
    authors.length
      ? table(
          ['Author', 'Agent', 'Level', 'Trust', 'Sent back by peers', 'Broken or refused', 'Why', 'Submissions (account)'],
          authors.map((a) => {
            const modes = el('div', null, 'row-actions');
            for (const [mode, label] of [['auto', 'Auto'], ['trusted', 'Never limit'], ['paused', 'Pause']]) {
              const b = button(label, async () => {
                if (mode === 'paused' && !confirm(`Pause submissions from ${a.name}? Their agent can still review and read, but not submit or claim regions.`)) return;
                await adminAction(a.name, `submit-${mode}`);
              }, mode === 'paused' ? 'danger' : '');
              b.disabled = a.mode === mode;
              modes.append(b);
            }
            return [
              a.name,
              a.token ?? el('span', 'before agents were told apart', 'hint'),
              [chip(a.level), ...(a.mode !== 'auto' ? [el('div', `set: ${a.mode}`, 'hint')] : [])],
              trustCell(a.trust),
              a.peerDecided ? `${pct(a.peerRate)} of ${a.peerDecided}` : '-',
              a.submitted ? `${pct(a.brokenRate)} of ${a.submitted}` : '-',
              el('div', a.reasons.join('; ') || '', 'hint'),
              modes,
            ];
          }),
        )
      : el('p', 'No submissions in the last 24 hours.', 'muted'),
  );
}

function renderAdmin() {
  const { users, roles, work = {}, reviewers = [] } = adminData;
  const q = $('user-filter').value.trim().toLowerCase();
  const pending = users.filter((u) => u.status === 'pending');
  const box = $('pending');
  box.replaceChildren(el('h3', `Waiting for approval (${pending.length})`));
  if (pending.length) {
    box.append(
      table(
        ['User', 'Registered', ''],
        pending.map((u) => {
          const actions = el('div', null, 'row-actions');
          actions.append(button('Approve', () => adminAction(u.name, 'approve'), 'primary'), button('Reject', () => confirm(`Delete the registration of ${u.name}?`) && adminAction(u.name, 'reject'), 'danger'));
          return [u.name, date(u.created_at), actions];
        }),
      ),
    );
  }
  const others = users.filter((u) => u.status !== 'pending' && (!q || u.name.toLowerCase().includes(q)));
  $('users').replaceChildren(
    el('h3', `Accounts (${others.length})`),
    table(
      ['User', 'Role', 'Status', 'Claimed work', 'Tokens', 'Approved', ''],
      others.map((u) => {
        const select = el('select');
        roles.forEach((r) => {
          const o = el('option', r);
          o.value = r;
          o.selected = r === u.role;
          select.append(o);
        });
        select.disabled = u.name === me.name;
        select.addEventListener('change', () => adminAction(u.name, 'role', { role: select.value }));
        const actions = el('div', null, 'row-actions');
        const self = u.name === me.name;
        if (u.status === 'active') actions.append(button('Revoke', () => confirm(`Revoke ${u.name}? All their tokens and sessions stop working immediately.`) && adminAction(u.name, 'revoke'), 'danger'));
        else actions.append(button('Reinstate', () => adminAction(u.name, 'reinstate')));
        actions.append(
          button('Reset password', async () => {
            if (!confirm(`Give ${u.name} a new random password? Their browser sessions end.`)) return;
            const r = await adminAction(u.name, 'reset-password');
            if (r?.password) showSecret(`New password for ${r.name} (shown once, send it to them privately):`, r.password);
          }),
          button('Delete', async () => {
            const typed = prompt(`Delete ${u.name}? Accounts with work on record stay as deleted_<id> so the history keeps its author; others are removed. Type the name to confirm.`);
            if (typed !== u.name) return;
            const r = await adminAction(u.name, 'delete');
            if (r) toast(r.keptAs ? `${r.name} deleted; their work stays under ${r.keptAs}` : `${r.name} deleted`);
          }, 'danger'),
        );
        for (const b of actions.querySelectorAll('button')) b.disabled = self;
        return [u.name, select, status(u.status), claimedWork(work[u.name]), u.active_tokens, `${date(u.approved_at)}${u.approved_by ? ` by ${u.approved_by}` : ''}`, actions];
      }),
    ),
  );
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}% (${b})` : '-');
  $('reviewers').replaceChildren(
    reviewers.length
      ? table(
          ['Reviewer', 'Reviews', 'Same / different', 'Agrees with peers', 'Agrees with humans', 'Quick verdicts', ''],
          reviewers.map((r) => {
            const flags = [];
            if (r.reviews >= 15 && r.different === 0) flags.push('never objects');
            if (r.reviews >= 15 && r.same / r.reviews < 0.3) flags.push('mostly objects');
            if (r.reviews >= 10 && r.quick / r.reviews > 0.5) flags.push('very fast');
            const cell = [el('span', r.name)];
            if (flags.length) cell.push(el('div', flags.join(', '), 'warn'));
            const action = r.blocked
              ? button('Allow reviews', () => adminAction(r.name, 'allow-reviews'))
              : button('Pause reviews', () => confirm(`Pause peer reviews from ${r.name}?`) && adminAction(r.name, 'block-reviews'), 'danger');
            return [cell, r.reviews, `${r.same} / ${r.different}`, pct(r.peerAgreed, r.peerCompared), pct(r.humanAgreed, r.humanCompared), pct(r.quick, r.reviews), action];
          }),
        )
      : el('p', 'No peer reviews yet.', 'muted'),
  );
}
$('user-filter').addEventListener('input', () => adminData && renderAdmin());

function showSecret(label, value) {
  const s = $('admin-secret');
  s.hidden = false;
  s.replaceChildren(el('p', label), el('code', value));
}

// Summary of what a user holds right now; the units it covers open below it.
function claimedWork(w) {
  const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const seen = w?.lastTokenUse ? el('div', `agent last seen ${date(w.lastTokenUse)}`, 'hint') : null;
  const parts = [];
  if (w?.tasks) parts.push(`${w.tasks} function${w.tasks > 1 ? 's' : ''} in ${w.units.length} unit${w.units.length > 1 ? 's' : ''}`);
  if (w?.peerReviews) parts.push(`${w.peerReviews} peer review${w.peerReviews > 1 ? 's' : ''}`);
  if (w?.batches) parts.push(`${w.batches} batch${w.batches > 1 ? 'es' : ''} being checked`);
  if (!parts.length) return [el('span', 'nothing', 'muted'), ...(seen ? [seen] : [])];
  if (!w.tasks) return [el('span', parts.join(' · ')), ...(seen ? [seen] : [])];
  const d = el('details', null, 'claimed');
  d.append(el('summary', parts.join(' · ')));
  const list = el('ul');
  for (const u of w.units) list.append(el('li', `${u.unit} (${u.tasks})`));
  d.append(list, el('div', `lease expires ${time(w.expires)} unless the agent heartbeats`, 'hint'));
  return [d, ...(seen ? [seen] : [])];
}

// --- review

let queue = { peer: [], later: [] };
let queueTab = 'peer';
let queueOrder = [];
let currentAttempt = null;

async function loadReview() {
  const [q, later] = await Promise.all([api('/api/review/queue'), api('/api/review/later').catch(() => [])]);
  queue = { peer: q, later };
  renderQueue();
}

for (const t of document.querySelectorAll('#queue-tabs .tab')) {
  t.addEventListener('click', () => {
    queueTab = t.dataset.queue;
    for (const x of document.querySelectorAll('#queue-tabs .tab')) x.classList.toggle('active', x === t);
    renderQueue();
  });
}
$('queue-filter').addEventListener('input', () => renderQueue());

function pips(same, different, need = 5) {
  const p = el('span', null, 'pips');
  for (let i = 0; i < Math.max(need, same); i++) p.append(el('span', null, `pip${i < same ? ' same' : ''}`));
  for (let i = 0; i < different; i++) p.append(el('span', null, 'pip diff'));
  p.title = `${same} same, ${different} different`;
  return p;
}

function renderQueue() {
  const list = $('queue-list');
  list.replaceChildren();
  const q = $('queue-filter').value.trim().toLowerCase();
  const match = (...xs) => !q || xs.some((x) => String(x ?? '').toLowerCase().includes(q));
  queueOrder = [];
  if (queueTab === 'later') {
    const items = queue.later.filter((l) => match(l.symbol_id, l.name, l.author));
    $('queue-count').textContent = `${items.length} flagged`;
    if (!items.length) return list.append(el('p', 'Nothing flagged. Functions merged over a "different" verdict show up here for a closer look.', 'muted'));
    const g = el('div', null, 'qgroup');
    g.append(el('header', 'Merged although a peer objected'));
    for (const l of items) {
      const b = button('', () => openAttempt(l.attempt_id), 'qitem');
      b.append(el('span', `${l.symbol_id} ${l.name || ''}`, 'qname'), el('span', `${l.objections}✗`, 'warn'), el('span', `by ${l.author} · ${(l.merged_commit || '').slice(0, 10)}`, 'qsub'));
      b.dataset.attempt = l.attempt_id;
      queueOrder.push(l.attempt_id);
      const done = button('Reviewed', async (ev) => {
        ev.stopPropagation();
        await post(`/api/review/later/${l.id}/clear`).catch((e) => toast(e.message));
        loadReview();
      });
      done.classList.add('ghost');
      g.append(b, done);
    }
    list.append(g);
    return;
  }
  const items = queue.peer.filter((a) => match(a.symbol_id, a.name, a.author, a.batch_id));
  $('queue-count').textContent = `${items.length} waiting`;
  if (!items.length) return list.append(el('p', 'Nothing waiting. Byte-identical work merges on its own; this list holds functions in peer review.', 'muted'));
  const batches = new Map();
  for (const a of items) {
    const key = a.batch_id ?? `a${a.id}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(a);
  }
  for (const [key, rows] of batches) {
    const g = el('div', null, 'qgroup');
    const head = el('header');
    head.append(el('span', typeof key === 'number' ? `Batch #${key} · ${rows[0].author}` : `#${rows[0].id} · ${rows[0].author}`), el('span', `${rows.length}`));
    g.append(head);
    for (const a of rows) {
      const b = button('', () => openAttempt(a.id), 'qitem');
      b.append(el('span', `${a.symbol_id} ${a.name || ''}`, 'qname'), pips(a.peer_same, a.peer_different), el('span', `${((a.score || 0) * 100).toFixed(0)}% bytes${a.peer_working ? ` · ${a.peer_working} reviewing now` : ''}${a.reviewed_by_me ? ' · you reviewed' : ''}`, 'qsub'));
      b.dataset.attempt = a.id;
      if (currentAttempt?.id === a.id) b.classList.add('active');
      queueOrder.push(a.id);
      g.append(b);
    }
    if (typeof key === 'number' && atLeast('maintainer')) {
      const all = button('Approve batch, skip peer review', async () => {
        if (!confirm(`Approve all ${rows.length} functions of batch #${key} without waiting for peer review? They merge right away.`)) return;
        try {
          await post(`/api/batches/${key}/review`, { action: 'approve', attemptIds: rows.map((a) => a.id), skipPeerReview: true });
          toast(`Batch #${key} approved`);
          loadReview();
        } catch (e) {
          toast(e.message);
        }
      });
      all.classList.add('ghost');
      g.append(all);
    }
    list.append(g);
  }
}

// --- batches

let batchStates = '';
let batchAttemptStates = '';
let batchRows = [];

const BATCH_STATES = {
  queued: 'Waiting for the worker.',
  verifying: 'The worker is checking and compiling it.',
  open: 'Not yet closed; each function has its own verification or review state.',
  merging: 'Being merged onto main.',
  merged: 'On main.',
  returned: 'Sent back to its author: see why below.',
  superseded: 'Replaced by another candidate.',
  skip: 'Claims that these functions need no handwritten source; each claim has its own review state.',
};

async function loadBatches({ more = false } = {}) {
  const q = new URLSearchParams({ limit: '50' });
  if (batchStates) q.set('state', batchStates);
  if (batchAttemptStates) q.set('attemptState', batchAttemptStates);
  const author = $('batches-author').value.trim();
  if (author) q.set('author', author);
  if (more && batchRows.length) q.set('before', String(batchRows[batchRows.length - 1].id));
  const rows = await api(`/api/batches?${q}`);
  batchRows = more ? [...batchRows, ...rows] : rows;
  renderBatches(rows.length === 50);
}

function batchSummary(b) {
  const f = Object.entries(b.functions ?? {}).map(([s, n]) => `${n} ${s.replace('_', ' ')}`);
  return f.length ? f.join(', ') : b.kind === 'maintenance' ? 'maintenance' : 'no functions';
}

function renderBatches(hasMore) {
  $('batches-count').textContent = `${batchRows.length} shown`;
  $('batches-more').hidden = !hasMore;
  if (!batchRows.length) return $('batches-list').replaceChildren(el('p', 'No batches.', 'muted'));
  $('batches-list').replaceChildren(
    table(
      ['Batch', 'Author', 'State', 'Functions', 'Why', 'Submitted'],
      batchRows.map((b) => {
        const link = el('a', `#${b.id}`);
        link.href = `#/batches/${b.id}`;
        const state = el('span', b.state, b.state === 'returned' ? 'warn' : '');
        state.title = BATCH_STATES[b.state] ?? '';
        return [link, b.author, state, batchSummary(b), b.returned ?? b.mergeFailure ?? '', ago(b.createdAt)];
      }),
    ),
  );
}

for (const t of document.querySelectorAll('#batches-tabs .tab')) {
  t.addEventListener('click', () => {
    batchStates = t.dataset.states;
    batchAttemptStates = t.dataset.attemptStates ?? '';
    for (const x of document.querySelectorAll('#batches-tabs .tab')) x.classList.toggle('active', x === t);
    loadBatches().catch((e) => toast(e.message));
  });
}
$('batches-author').addEventListener('change', () => loadBatches().catch((e) => toast(e.message)));
$('batches-more').addEventListener('click', () => loadBatches({ more: true }).catch((e) => toast(e.message)));

async function openBatch(id) {
  const b = await api(`/api/batches/${id}`);
  const box = $('batch-detail');
  box.hidden = false;
  const head = el('div', null, 'plate-head');
  head.append(el('h2', `Batch #${b.id} · ${b.author}`), el('span', `${b.kind} · ${b.state}`, b.state === 'returned' ? 'warn' : 'hint'));
  const meta = el('p', `Submitted ${date(b.createdAt)}${b.finishedAt ? ` · finished ${date(b.finishedAt)}` : ''} · base ${b.baseCommit.slice(0, 10)}${b.mergedCommit ? ` · merged as ${b.mergedCommit.slice(0, 10)}` : ''}`, 'muted');
  const parts = [head, meta];
  if (b.returned || b.mergeFailure) parts.push(el('p', b.returned ?? b.mergeFailure, 'warn'));
  if (b.notes) parts.push(el('p', `Notes: ${b.notes}`));
  if (b.files?.length) parts.push(el('p', `Files: ${b.files.join(', ')}`, 'hint'));
  const fnRows = b.functions.map((f) => {
    const link = el('a', `${f.symbol} ${f.name ?? ''}`);
    link.href = `#/review/${f.attemptId}`;
    const result = f.retired ? `${f.summary ? `${f.summary} · ` : ''}then ${f.retired.because}` : f.summary ?? '';
    return [link, f.state.replace('_', ' '), f.score === null ? '' : `${(f.score * 100).toFixed(1)}%`, result];
  });
  parts.push(fnRows.length ? table(['Function', 'State', 'Bytes', 'Result'], fnRows) : el('p', 'No function tasks (a maintenance batch).', 'muted'));
  if (b.kind === 'maintenance' && b.result) {
    const pre = el('pre', JSON.stringify(b.result, null, 1));
    pre.className = 'secret';
    parts.push(pre);
  }
  if (atLeast('admin') && b.state === 'returned' && b.functions.some((f) => /matched before/.test(f.summary ?? ''))) {
    const accept = button('Accept lower scores and merge', async () => {
      const comment = prompt(`Merge batch #${b.id} although it lowers the score of functions that matched before? Every function of it is accepted without peer review. Reason:`);
      if (comment === null) return;
      try {
        await post(`/api/admin/batches/${b.id}/accept-regressions`, { comment });
        toast(`Batch #${b.id} accepted; it merges next`);
        openBatch(b.id);
        loadBatches();
      } catch (e) {
        toast(e.message);
      }
    }, 'danger');
    parts.push(accept);
  }
  box.replaceChildren(...parts);
  box.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

async function openAttempt(id) {
  const a = await api(`/api/attempts/${id}`);
  currentAttempt = a;
  for (const b of document.querySelectorAll('.qitem')) b.classList.toggle('active', Number(b.dataset.attempt) === id);
  $('attempt-empty').hidden = true;
  $('attempt-body').hidden = false;
  if (!location.hash.startsWith(`#/review/${id}`)) history.replaceState(null, '', `#/review/${id}`);
  const f = a.feedback || {};
  const t = f.target;
  const identity = a.symbol ?? t;
  const claimed = a.kind === 'skip';
  $('attempt-title').textContent = `${t?.demangled || identity?.name || identity?.id || `Attempt #${a.id}`}`;
  const measurement = claimed ? 'no handwritten source submitted; byte matching does not apply' : `${a.score === null ? 'unmeasured' : `${(a.score * 100).toFixed(1)}% of bytes`} · size ${t?.size?.ours ?? '?'} / ${t?.size?.original ?? '?'}`;
  $('attempt-meta').textContent = `#${a.id} by ${a.author} · ${identity?.id ? `${identity.id} · ` : ''}${a.state.replace('_', ' ')} · ${measurement} · base ${a.baseCommit.slice(0, 10)}`;
  const n = (v) => (a.peerReviews ?? []).filter((p) => p.verdict === v).length;
  const vm = $('attempt-verdicts');
  vm.replaceChildren(el('span', 'same'), pips(n('same'), 0, a.peerRequired ?? 5), el('span', 'different'), pips(0, n('different'), 0));

  const r = $('attempt-result');
  r.replaceChildren(el('p', f.summary || ''));
  if (a.changedHeaders.length) r.append(el('p', `Changes headers: ${a.changedHeaders.join(', ')}`, 'warn'));
  if (a.claim) r.append(el('p', `Claimed: needs no decompilation (${a.claim.category}). Reason (untrusted): ${a.claim.reason}`, 'warn'));
  if (a.peerReviews?.length) {
    const d = el('details', null, 'fold');
    d.open = true;
    d.append(el('summary', `Peer verdicts (${a.peerReviews.length})`), table(['Reviewer', 'Verdict', 'Reason (untrusted)'], a.peerReviews.map((p) => [p.reviewer, status(p.verdict === 'same' ? 'exact' : 'revoked'), p.reason?.text ?? ''])));
    r.append(d);
  }

  compare = { source: a.targetSource, ourAsm: t?.asm ?? null, original: null, error: null, claim: a.claim ?? null };
  const selectedCompare = compare;
  document.querySelector('#compare-tabs [data-view="code"]').textContent = claimed ? 'Claim and original pseudocode' : 'C++ vs pseudocode';
  document.querySelector('#compare-tabs [data-view="asm"]').textContent = claimed ? 'Original assembly' : 'Assembly vs assembly';
  showCompare(claimed ? 'asm' : compareView);
  if (identity?.id) {
    api(`/api/original/${identity.id}`)
      .then((o) => { if (currentAttempt === a) selectedCompare.original = o; })
      .catch((e) => { if (currentAttempt === a) selectedCompare.error = e.message; })
      .finally(() => currentAttempt === a && showCompare(compareView));
  }

  const details = $('attempt-details');
  details.replaceChildren();
  const fold = (title, ...content) => {
    const d = el('details', null, 'fold');
    d.append(el('summary', title), ...content);
    details.append(d);
  };
  if (f.warnings?.length) fold(`Warnings (${f.warnings.length})`, ...f.warnings.map((w) => el('p', w, 'warn')));
  if (t?.relocations?.length) fold(`References to check (${t.relocations.length})`, table(['Offset', 'Symbol', 'Status'], t.relocations.map((x) => [`+0x${x.offset.toString(16)}`, x.symbol, x.ok ? 'not yet named' : x.reason])));
  if (f.otherFunctions?.length) {
    const exact = f.otherFunctions.filter((x) => x.status === 'exact' || x.status === 'match_unresolved').length;
    fold(`Other functions in the file (${f.otherFunctions.length}, ${exact} byte-identical)`, table(['Function', 'Status', 'Score'], f.otherFunctions.map((x) => [x.id, x.status, `${(x.score * 100).toFixed(1)}%`])));
  }
  const files = Object.entries(a.mergedFiles || a.files || {});
  if (claimed) {
    fold('No source files expected', el('p', 'This is a claim about how the original function was produced, not a C++ implementation. Review the stated evidence against the original instructions.'));
  } else {
    fold(`Submitted files (${files.length})`, ...files.map(([p, content]) => {
      const d = el('details');
      d.append(el('summary', p), el('pre', content, 'code'));
      return d;
    }));
  }
  fold(a.notes ? 'Notes from the author (untrusted)' : 'Notes from the author (none)', el('pre', a.notes || '(none)', 'notes'));

  // Deciding a function still in peer review is for maintainers.
  const open = a.state === 'peer_review' || a.state === 'in_review';
  $('decision').hidden = !open && a.state !== 'approved';
  for (const btn of document.querySelectorAll('.actions button')) btn.disabled = a.state === 'peer_review' && !atLeast('maintainer');
  document.querySelector('.actions [data-action="approve"]').textContent = a.state === 'peer_review' ? 'Approve, skip peer review' : 'Approve';
  $('attempt-peer-note').hidden = a.state !== 'peer_review';
  $('review-status').textContent = a.reviews.map((x) => `${x.reviewer}: ${x.action}${x.comment ? ` - ${x.comment}` : ''}`).join('\n');
}

let compare = null;
let compareView = 'code';
for (const tab of document.querySelectorAll('#compare-tabs .tab')) tab.addEventListener('click', () => showCompare(tab.dataset.view));

function showCompare(view) {
  compareView = view;
  for (const tab of document.querySelectorAll('#compare-tabs .tab')) tab.classList.toggle('active', tab.dataset.view === view);
  const body = $('compare-body');
  body.replaceChildren();
  if (!compare) return;
  const o = compare.original;
  const pending = !o && !compare.error ? 'Loading the original…' : `Original not available${compare.error ? `: ${compare.error}` : ''}`;
  if (compare.claim) {
    const claim = compare.claim;
    const explanation = `No C++ implementation is expected for this claim (${claim.category}).\n\nReason (untrusted):\n${claim.reason}\n\nApprove only if the original instructions support the claim; otherwise request an implementation.`;
    const original = view === 'asm' ? o?.asm : o?.pseudocode;
    const title = view === 'asm' ? 'Original assembly' : 'Original pseudocode (reading aid)';
    body.append(twoPanes(['No handwritten source required — claim', explanation], [o ? `${title} · ${o.addr}` : title, original ?? (o ? 'No original text is available in this view.' : pending)]));
    return;
  }
  if (view === 'code') {
    body.append(
      twoPanes(
        [compare.source ? `Submitted C++ · ${compare.source.file}:${compare.source.line}` : 'Submitted C++', compare.source?.text ?? 'The function was not found in the submitted files.'],
        [o ? `Original pseudocode (Ghidra, a reading aid) · ${o.addr}` : 'Original pseudocode', o ? o.pseudocode ?? 'No pseudocode exported for this function yet; see the assembly view.' : pending],
      ),
    );
  } else if (!compare.ourAsm || !o) {
    body.append(twoPanes(['Our compiled code', compare.ourAsm ?? 'Not recorded for this attempt.'], [o ? `Original at ${o.addr}` : 'Original', o?.asm ?? pending]));
  } else {
    body.append(alignedAsm(compare.ourAsm, o.asm, o.addr));
  }
}

function twoPanes(left, right) {
  const wrap = el('div', null, 'panes');
  for (const [title, text] of [left, right]) {
    const pane = el('div', null, 'pane');
    pane.append(el('div', title, 'pane-title'), el('pre', text, 'code'));
    wrap.append(pane);
  }
  return wrap;
}

// Both listings as rows, lined up by instruction (longest common sequence of mnemonics), so
// matching instructions sit side by side and the differences stand out. Ghidra and the MSVC
// listing spell some mnemonics differently (JZ / je).
const MNEMONIC_ALIAS = { je: 'jz', jne: 'jnz', jb: 'jc', jnae: 'jc', jae: 'jnc', jnb: 'jnc', sete: 'setz', setne: 'setnz', setb: 'setc', setae: 'setnc', cmove: 'cmovz', cmovne: 'cmovnz', cmovb: 'cmovc', cmovae: 'cmovnc', jnbe: 'ja', jna: 'jbe', jnge: 'jl', jnl: 'jge', jng: 'jle', jnle: 'jg' };
const mnemonic = (m) => MNEMONIC_ALIAS[m.toLowerCase()] ?? m.toLowerCase();

function parseOurs(text) {
  return text
    .split('\n')
    .map((line) => {
      const m = /^([0-9a-f]+)\s+(\S+)\s*(.*)$/i.exec(line);
      return m ? { off: m[1], key: mnemonic(m[2]), text: `${m[2]} ${m[3]}`.trim() } : null;
    })
    .filter(Boolean);
}

function parseOriginal(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*\+0x([0-9a-f]+)\s+[0-9a-f]+\s+(?:[0-9a-f]{2}\s)+\s*(\S+)\s*(.*)$/i.exec(line);
    if (m) out.push({ off: m[1].replace(/^0+(?=.)/, '').padStart(4, '0'), key: mnemonic(m[2]), text: `${m[2].toLowerCase()} ${m[3]}`.trim() });
    else if (/^\w+:$/.test(line.trim())) out.push({ label: line.trim() });
  }
  return out;
}

function alignedAsm(oursText, origText, addr) {
  const ours = parseOurs(oursText);
  const orig = parseOriginal(origText);
  const origInsns = orig.filter((x) => !x.label);
  const rows = alignRows(ours, origInsns);
  const labelsBefore = new Map();
  let labels = [];
  for (const x of orig) {
    if (x.label) labels.push(x.label);
    else if (labels.length) {
      labelsBefore.set(x, labels);
      labels = [];
    }
  }
  const same = rows.filter((r) => r.a && r.b && r.a.key === r.b.key).length;
  const wrap = el('div', null, 'asm-diff');
  wrap.append(el('p', `${same} of ${Math.max(ours.length, origInsns.length)} instructions line up by mnemonic. Red rows differ, yellow rows exist on one side only; operands are compared loosely.`, 'hint'));
  const body = el('div', null, 'asm-body');
  const head = el('div', null, 'asm-row asm-head');
  head.append(el('div', `Our compiled code (${ours.length} instructions)`), el('div', `Original at ${addr} (${origInsns.length} instructions)`));
  body.append(head);
  for (const row of rows) {
    for (const label of (row.b && labelsBefore.get(row.b)) || []) {
      const lr = el('div', null, 'asm-row asm-label');
      lr.append(el('div', ''), el('div', label));
      body.append(lr);
    }
    const cls = !row.a || !row.b ? 'gap' : row.a.key !== row.b.key ? 'differs' : looseOperands(row.a.text) === looseOperands(row.b.text) ? 'same' : 'operands';
    const tr = el('div', null, `asm-row ${cls}`);
    tr.append(asmCell(row.a), asmCell(row.b));
    body.append(tr);
  }
  wrap.append(body);
  return wrap;
}

function asmCell(x) {
  const c = el('div');
  if (x) {
    c.append(el('span', x.off, 'asm-off'), document.createTextNode(x.text));
    c.title = x.text;
  }
  return c;
}

const looseOperands = (text) => text.toLowerCase().replace(/;.*$/, '').replace(/\s+/g, '').replace(/(qword|dword|word|byte)ptr/g, '$1');

function alignRows(a, b) {
  const n = Math.min(a.length, 1500);
  const m = Math.min(b.length, 1500);
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i].key === b[j].key ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].key === b[j].key) rows.push({ a: a[i++], b: b[j++] });
    else if (dp[i + 1][j] >= dp[i][j + 1]) rows.push({ a: a[i++], b: null });
    else rows.push({ a: null, b: b[j++] });
  }
  while (i < a.length) rows.push({ a: a[i++], b: null });
  while (j < b.length) rows.push({ a: null, b: b[j++] });
  const out = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    if (prev && prev.a && !prev.b && r.b && !r.a) prev.b = r.b;
    else out.push({ ...r });
  }
  return out;
}

document.querySelectorAll('.actions button').forEach((b) =>
  b.addEventListener('click', async () => {
    if (!currentAttempt) return;
    try {
      const r = await post(`/api/attempts/${currentAttempt.id}/review`, { action: b.dataset.action, comment: $('review-comment').value, skipPeerReview: currentAttempt.state === 'peer_review' });
      $('review-status').textContent = `Recorded. Attempt is now ${r.state}${r.approvalsNeeded ? ` (${r.approvalsNeeded} more approval needed)` : ''}.`;
      $('review-comment').value = '';
      await loadReview();
    } catch (e) {
      $('review-status').textContent = e.message;
    }
  }),
);

// Keyboard: j/k move through the queue, 1/2 switch the comparison.
document.addEventListener('keydown', (e) => {
  if (currentView !== 'review' || e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '1') showCompare('code');
  else if (e.key === '2') showCompare('asm');
  else if (e.key === 'j' || e.key === 'k') {
    if (!queueOrder.length) return;
    const at = queueOrder.indexOf(currentAttempt?.id);
    const next = queueOrder[Math.max(0, Math.min(queueOrder.length - 1, at + (e.key === 'j' ? 1 : -1)))] ?? queueOrder[0];
    openAttempt(next).then(() => document.querySelector(`.qitem[data-attempt="${next}"]`)?.scrollIntoView({ block: 'nearest' }));
  }
});

// --- arcade

let wallet = null;
async function loadArcade() {
  wallet = await api('/api/credits/me');
  setCredits(wallet.balance, false);
  const earn = $('earn');
  earn.replaceChildren();
  const labels = { identical: 'per byte-identical merge', confirmed: 'per peer-confirmed merge', skip: 'per accepted "no source"', submitted: 'per submitted function that compiles', review: 'per review that matched the outcome' };
  for (const [k, v] of Object.entries(wallet.awards)) earn.append(el('span', `+${v} ${labels[k] ?? k}${wallet.earned[k] ? ` · earned ${fmt(wallet.earned[k].credits)}` : ''}`, 'chip'));
  $('bailout').hidden = !wallet.bailout;
  for (const b of document.querySelectorAll('.bet')) b.max = String(wallet.maxBet);
  const pt = $('paytable');
  pt.replaceChildren(...wallet.slots.map((s) => el('span', `${s.symbol}×3 = ${s.three}×`)), el('span', '⚙️⚙️ = 1×'));
  renderRounds(wallet.recent);
  const b = await api('/api/credits/leaderboard');
  $('arcade-wins').replaceChildren(b.wins.length ? table(['Player', 'Game', 'Won'], b.wins.map((w) => [w.name, w.game, fmt(w.payout)])) : el('p', 'No big wins today. Yet.', 'muted'));
}

function renderRounds(rounds) {
  $('rounds').replaceChildren(
    rounds.length
      ? table(['When', 'Game', 'Bet', 'Result', 'Paid'], rounds.map((r) => [ago(r.created_at), r.game, fmt(r.bet), describeRound(r), r.payout ? `+${fmt(r.payout)}` : '0']))
      : el('p', 'No rounds yet. Merged functions earn credits; spend them here.', 'muted'),
  );
}

function describeRound(r) {
  const d = r.detail ?? {};
  if (r.game === 'coinflip') return `called ${d.side}, got ${d.result}`;
  if (r.game === 'dice') return `rolled ${d.result} (under ${d.under})`;
  if (r.game === 'slots') return (d.reels ?? []).join(' ');
  return '';
}

async function play(game, body, msgEl) {
  msgEl.textContent = '';
  msgEl.className = 'msg game-msg';
  const r = await post(`/api/games/${game}`, body);
  return r;
}

function finish(r, msgEl, text) {
  const won = r.payout > 0;
  msgEl.textContent = won ? `${text} +${fmt(r.payout)} credits!` : `${text} No luck.`;
  msgEl.classList.add(won ? 'win' : 'lose');
  setCredits(r.balance, false);
  if (won && r.payout >= r.bet * 3) {
    const box = msgEl.getBoundingClientRect();
    sparks(box.left + 60, box.top, r.payout >= r.bet * 20 ? 30 : 14, ['🪙', '✨', '🎉']);
  }
  wallet.recent.unshift({ game: r.game, bet: r.bet, payout: r.payout, detail: r.detail, created_at: Date.now() });
  renderRounds(wallet.recent.slice(0, 15));
}

const betOf = (id) => Math.max(1, Math.floor(Number($(id).value) || 1));

let coinTurns = 0;
for (const b of document.querySelectorAll('#game-coin [data-side]')) {
  b.addEventListener('click', async () => {
    const msg = $('coin-msg');
    const buttons = document.querySelectorAll('#game-coin button');
    buttons.forEach((x) => (x.disabled = true));
    try {
      const r = await play('coinflip', { bet: betOf('coin-bet'), side: b.dataset.side }, msg);
      coinTurns += 5;
      const deg = coinTurns * 360 + (r.detail.result === 'tails' ? 180 : 0);
      $('coin').style.setProperty('transform', `rotateY(${deg}deg)`);
      await new Promise((res) => setTimeout(res, reducedMotion() ? 0 : 1250));
      finish(r, msg, `It's ${r.detail.result}.`);
    } catch (e) {
      msg.textContent = e.message;
    } finally {
      buttons.forEach((x) => (x.disabled = false));
    }
  });
}

function diceOdds() {
  const u = Number($('dice-under').value);
  $('dice-under-out').textContent = String(u);
  $('dice-pays').textContent = `${(Math.floor((97 / (u - 1)) * 100) / 100).toFixed(2)}×`;
}
$('dice-under').addEventListener('input', diceOdds);
diceOdds();
$('dice-roll').addEventListener('click', async () => {
  const msg = $('dice-msg');
  const die = $('die');
  $('dice-roll').disabled = true;
  try {
    const r = await play('dice', { bet: betOf('dice-bet'), under: Number($('dice-under').value) }, msg);
    die.classList.add('rolling');
    const spin = setInterval(() => (die.textContent = String(1 + Math.floor(Math.random() * 100))), 60);
    await new Promise((res) => setTimeout(res, reducedMotion() ? 0 : 900));
    clearInterval(spin);
    die.classList.remove('rolling');
    die.textContent = String(r.detail.result);
    finish(r, msg, `Rolled ${r.detail.result}.`);
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    $('dice-roll').disabled = false;
  }
});

const REEL_FACES = ['⚙️', '🔩', '💾', '🐞', '👾', '7️⃣'];
$('slots-spin').addEventListener('click', async () => {
  const msg = $('slots-msg');
  const reels = [...document.querySelectorAll('#reels .reel')];
  $('reels').classList.remove('win');
  $('slots-spin').disabled = true;
  try {
    const r = await play('slots', { bet: betOf('slots-bet') }, msg);
    const timers = reels.map((reel) => {
      reel.classList.add('spinning');
      return setInterval(() => (reel.textContent = REEL_FACES[Math.floor(Math.random() * REEL_FACES.length)]), 70);
    });
    for (let i = 0; i < reels.length; i++) {
      await new Promise((res) => setTimeout(res, reducedMotion() ? 0 : 450 + i * 250));
      clearInterval(timers[i]);
      reels[i].classList.remove('spinning');
      reels[i].textContent = r.detail.reels[i];
    }
    if (r.payout > r.bet) $('reels').classList.add('win');
    finish(r, msg, r.payout > r.bet ? 'Jackpot-ish!' : r.payout === r.bet ? 'Two gears: bet back.' : '');
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    $('slots-spin').disabled = false;
  }
});

$('bailout').addEventListener('click', async () => {
  try {
    const r = await post('/api/credits/bailout');
    setCredits(r.balance, false);
    toast(`+${r.granted} credits. Spend them wisely (or merge a function).`, { icon: '🛟' });
    loadArcade();
  } catch (e) {
    toast(e.message);
  }
});

// --- little things

const TAGLINES = [
  'Matching decompilation // byte for byte',
  'Teaching machines to write 2012-era C++',
  'Every byte counts. Literally.',
  'mov eax, progress // add eax, you',
  'No function left behind',
  'Compiled locally, judged globally',
  'Five agents walk into a peer review…',
];
let tag = 0;
setInterval(() => {
  if (document.visibilityState !== 'visible' || reducedMotion()) return;
  tag = (tag + 1) % TAGLINES.length;
  $('tagline').textContent = TAGLINES[tag];
}, 9000);

// The classic: up up down down left right left right b a.
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
let konami = 0;
document.addEventListener('keydown', (e) => {
  konami = e.key === KONAMI[konami] ? konami + 1 : e.key === KONAMI[0] ? 1 : 0;
  if (konami === KONAMI.length) {
    konami = 0;
    document.querySelector('.gears').style.setProperty('animation', 'spin 0.4s linear 6');
    sparks(window.innerWidth / 2, window.innerHeight / 3, 40);
    toast('+30 lives. (Not credits. Nice try.)', { icon: '🕹️' });
  }
});

// --- start

api('/api/info')
  .then((info) => {
    if (info.version) {
      $('target-name').textContent = info.version.label;
      $('target-meta').textContent = `${info.project} · sha256 ${info.version.sha256.slice(0, 12)}…`;
      $('target-meta').title = info.version.sha256;
      $('target').hidden = false;
    }
    // The guide's workspace paths use the installer's default folder name.
    const folder = String(info.project ?? 'project').replace(/[^A-Za-z0-9_.-]/g, '-');
    for (const c of document.querySelectorAll('.ws-win, .ws-linux, #open-win, #open-linux')) c.textContent = c.textContent.replace('wowdecomp', folder);
    if (info.gitWeb) $('source-link').href = info.gitWeb;
    $('clone-cmd').textContent = `git clone ${info.git}`;
  })
  .catch(() => {});
for (const c of document.querySelectorAll('code[data-origin]')) c.textContent = c.textContent.replace('{origin}', location.origin);
addCopyButtons();
refresh();
