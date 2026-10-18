// Web UI. Auth is an HttpOnly session cookie set by /api/login; scripts never
// see it. All server data is inserted with textContent, never as HTML.

const $ = (id) => document.getElementById(id);
const ROLE_ORDER = ['contributor', 'reviewer', 'maintainer', 'admin'];
let me = null;
let currentAttempt = null;

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

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// --- public

async function loadProgress() {
  const p = await api('/api/progress');
  const body = $('progress-body');
  body.replaceChildren();
  body.className = '';
  const exact = p.byStatus.find((s) => s.status === 'exact') || { n: 0, bytes: 0 };
  const pct = p.bytes ? (exact.bytes / p.bytes) * 100 : 0;

  const gauge = el('div', null, 'gauge');
  gauge.append(el('div', `${pct.toFixed(2).padStart(6, '0')}%`, 'readout'));
  const meter = el('div', null, 'meter');
  meter.setAttribute('role', 'progressbar');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  meter.setAttribute('aria-valuenow', pct.toFixed(2));
  const fill = el('div', null, 'fill');
  meter.append(fill);
  gauge.append(meter);
  const conf = p.confirmed?.n ?? 0;
  gauge.append(el('p', p.functions ? `${exact.n} of ${p.functions} functions match byte for byte${conf ? `, ${conf} more confirmed by peer review` : ''}${p.peerQueue ? ` · ${p.peerQueue} waiting for peer review` : ''}.` : 'No target loaded yet. The machines are warming up.', 'gauge-caption'));
  body.append(gauge);
  requestAnimationFrame(() => fill.style.setProperty('width', `${Math.min(100, pct)}%`));

  const stats = el('div', null, 'stats');
  if (p.byTaskState.length) stats.append(table(['Task state', 'Count'], p.byTaskState.map((s) => [s.state, s.n])));
  if (p.contributors.length) stats.append(table(['Top crew', 'Merged'], p.contributors.map((c) => [c.name, c.merged])));
  if (stats.children.length) body.append(stats);
}

function status(s) {
  return el('span', s, `status ${s}`);
}

// --- session

async function refresh() {
  try {
    me = await api('/api/me');
  } catch {
    me = null;
  }
  $('auth').hidden = !!me;
  $('nav').hidden = !me;
  $('account').hidden = !me;
  $('queue').hidden = !atLeast('reviewer');
  $('admin').hidden = !atLeast('admin');
  if (!me) {
    $('attempt').hidden = true;
    return;
  }
  $('whoami').textContent = `${me.name} (${me.role})`;
  await loadTokens();
  if (atLeast('reviewer')) await loadQueue();
  if (atLeast('admin')) await loadUsers();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-msg').textContent = '';
  try {
    await post('/api/login', formData(e.target));
    e.target.reset();
    await refresh();
  } catch (err) {
    $('login-msg').textContent = err.message;
  }
});

$('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await post('/api/register', formData(e.target));
    e.target.reset();
    $('register-msg').textContent = 'Registered. You can log in once an admin approves your account.';
  } catch (err) {
    $('register-msg').textContent = err.message;
  }
});

$('logout').addEventListener('click', async () => {
  await post('/api/logout').catch(() => {});
  await refresh();
});

// --- account

async function loadTokens() {
  const tokens = await api('/api/me/tokens');
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
            await loadTokens();
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
    const origin = location.origin;
    $('install-win').textContent = `$env:TD_TOKEN='${t.token}'; irm ${origin}/install.ps1 | iex`;
    $('install-linux').textContent = `curl -fsSL ${origin}/install.sh | TD_TOKEN=${t.token} sh`;
    $('new-token').hidden = false;
    await loadTokens();
  } catch (err) {
    alert(err.message);
  }
});

// Every command or message the reader has to paste gets its own copy button.
for (const code of document.querySelectorAll('code.cmd')) {
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

// Links to the guide open it before scrolling there.
for (const a of document.querySelectorAll('a[href="#guide"]')) a.addEventListener('click', () => ($('guide').open = true));
if (location.hash === '#guide') $('guide').open = true;

$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await post('/api/me/password', formData(e.target));
    e.target.reset();
    await refresh();
    $('login-msg').textContent = 'Password changed. Log in with the new password.';
  } catch (err) {
    $('password-msg').textContent = err.message;
  }
});

// --- admin

async function adminAction(name, action, body) {
  $('admin-msg').textContent = '';
  try {
    await post(`/api/admin/users/${encodeURIComponent(name)}/${action}`, body);
  } catch (err) {
    $('admin-msg').textContent = err.message;
  }
  await loadUsers();
}

async function loadUsers() {
  const { users, roles, work = {} } = await api('/api/admin/users');
  const box = $('users');
  box.replaceChildren();
  const pending = users.filter((u) => u.status === 'pending');
  box.append(el('h3', `Waiting for approval (${pending.length})`));
  if (pending.length) {
    box.append(
      table(
        ['User', 'Registered', ''],
        pending.map((u) => [
          u.name,
          date(u.created_at),
          [
            button('Approve', () => adminAction(u.name, 'approve'), 'primary'),
            button('Reject', () => confirm(`Delete the registration of ${u.name}?`) && adminAction(u.name, 'reject'), 'danger'),
          ],
        ]),
      ),
    );
  }
  const others = users.filter((u) => u.status !== 'pending');
  box.append(el('h3', 'Accounts'));
  box.append(
    table(
      ['User', 'Role', 'Status', 'Claimed work', 'Active tokens', 'Approved', ''],
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
        const action =
          u.status === 'active'
            ? button('Revoke', () => confirm(`Revoke ${u.name}? All their tokens and sessions stop working immediately.`) && adminAction(u.name, 'revoke'), 'danger')
            : button('Reinstate', () => adminAction(u.name, 'reinstate'));
        if (u.name === me.name) action.disabled = true;
        return [u.name, select, status(u.status), claimedWork(work[u.name]), u.active_tokens, `${date(u.approved_at)}${u.approved_by ? ` by ${u.approved_by}` : ''}`, action];
      }),
    ),
  );
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

async function loadQueue() {
  const q = await api('/api/review/queue');
  const body = $('queue-body');
  body.replaceChildren();
  if (!q.length) return body.append(el('p', 'Nothing waiting for review. Byte-identical work merges on its own; this queue holds functions in peer review and the ones peers confirmed.', 'muted'));
  const canSkipPeers = atLeast('maintainer');
  const ready = q.filter((a) => a.state === 'in_review');
  const inPeer = q.filter((a) => a.state === 'peer_review');
  if (ready.length) {
    body.append(el('h3', `Confirmed by peers, waiting for you (${ready.length})`));
    queueBatches(body, ready, false);
  }
  if (inPeer.length) {
    body.append(el('h3', `In peer review (${inPeer.length})`));
    body.append(
      el(
        'p',
        canSkipPeers
          ? 'Three agents still have to confirm these. You can open one to judge it yourself, or approve it now and skip the peer review.'
          : 'Three agents still have to confirm these before you can approve them. Maintainers can decide them right away.',
        'muted',
      ),
    );
    queueBatches(body, inPeer, canSkipPeers);
  }
}

// One block per batch, approved together with one click.
function queueBatches(body, items, skipsPeers) {
  const batches = new Map();
  for (const a of items) {
    const key = a.batch_id ?? `a${a.id}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(a);
  }
  for (const [key, list] of batches) {
    const head = el('div', null, 'batch-head');
    head.append(el('strong', typeof key === 'number' ? `Batch #${key}` : `Attempt #${list[0].id}`), el('span', ` by ${list[0].author} · ${list.length} function${list.length > 1 ? 's' : ''}`, 'muted'));
    const decidable = !list.some((a) => a.state === 'peer_review') || skipsPeers;
    if (typeof key === 'number' && decidable) {
      const label = skipsPeers ? 'Approve all, skip peer review' : 'Approve batch';
      head.append(
        button(
          label,
          async () => {
            if (skipsPeers && !confirm(`Approve all ${list.length} functions of batch #${key} without waiting for peer review? They merge right away.`)) return;
            try {
              await post(`/api/batches/${key}/review`, { action: 'approve' });
              await loadQueue();
            } catch (e) {
              alert(e.message);
            }
          },
          'primary',
        ),
      );
    }
    body.append(head);
    const peerCol = (a) => (a.state === 'peer_review' ? `${a.peer_same} of 3 confirmed${a.peer_working ? `, ${a.peer_working} reviewing` : ''}` : 'confirmed');
    body.append(
      table(
        ['Attempt', 'Symbol', 'Name', 'Score', 'Peers', 'Approvals', ''],
        list.map((a) => [`#${a.id}`, a.symbol_id, a.name || '', `${(a.score * 100).toFixed(1)}%`, peerCol(a), a.approvals, button(a.reviewed_by_me ? 'Reviewed' : 'Open', () => openAttempt(a.id))]),
      ),
    );
  }
}

async function openAttempt(id) {
  const a = await api(`/api/attempts/${id}`);
  currentAttempt = a;
  $('attempt').hidden = false;
  $('attempt-title').textContent = `Attempt #${a.id} (task ${a.taskId}) by ${a.author}`;
  $('attempt-meta').replaceChildren(el('p', `State ${a.state}, score ${((a.score || 0) * 100).toFixed(1)}%, base ${a.baseCommit.slice(0, 10)}`));
  if (a.changedHeaders.length) $('attempt-meta').append(el('p', `Changes headers: ${a.changedHeaders.join(', ')} (needs extra approval)`, 'warn'));

  const r = $('attempt-result');
  r.replaceChildren();
  const f = a.feedback || {};
  r.append(el('p', f.summary || ''));
  if (f.target) {
    r.append(el('p', `${f.target.id} ${f.target.demangled || ''}: ${f.target.status}, size ${f.target.size?.ours} / ${f.target.size?.original ?? '?'}`));
    if (f.target.relocations?.length) r.append(table(['Offset', 'Symbol', 'Status'], f.target.relocations.map((x) => [`+0x${x.offset.toString(16)}`, x.symbol, x.ok ? 'not yet named' : x.reason])));
  }
  (f.warnings || []).forEach((w) => r.append(el('p', w, 'warn')));
  if (a.peerReviews?.length) {
    r.append(el('h3', `Peer review (${a.peerReviews.filter((p) => p.verdict === 'same').length} of ${a.peerRequired} confirmed the logic)`));
    r.append(table(['Reviewer', 'Verdict', 'Reason (untrusted)'], a.peerReviews.map((p) => [p.reviewer, status(p.verdict === 'same' ? 'exact' : 'revoked'), p.reason?.text ?? ''])));
  } else if (a.state === 'in_review' && f.target && f.target.status !== 'exact' && f.target.status !== 'match_unresolved') {
    r.append(el('p', 'Not byte-identical and no peer verdicts recorded.', 'warn'));
  }
  if (f.otherFunctions?.length) r.append(table(['Other functions in file', 'Status', 'Score'], f.otherFunctions.map((x) => [x.id, x.status, `${(x.score * 100).toFixed(1)}%`])));

  // The original next to the submission, so a human can judge it like the peers do.
  const orig = $('attempt-original');
  orig.replaceChildren();
  if (f.target?.id) {
    api(`/api/original/${f.target.id}`)
      .then((o) => {
        if (o.pseudocode) {
          const d = el('details');
          d.open = true;
          d.append(el('summary', `Original pseudocode (${o.source}, a reading aid)`), el('pre', o.pseudocode, 'code'));
          orig.append(d);
        }
        const d = el('details');
        d.append(el('summary', `Original disassembly at ${o.addr}`), el('pre', o.asm, 'code'));
        orig.append(d);
      })
      .catch((e) => orig.append(el('p', `Original not available: ${e.message}`, 'muted')));
  }

  const files = $('attempt-files');
  files.replaceChildren();
  for (const [p, content] of Object.entries(a.mergedFiles || a.files)) {
    const d = el('details');
    d.append(el('summary', p));
    d.append(el('pre', content, 'code'));
    files.append(d);
  }
  $('attempt-notes').textContent = a.notes || '(none)';
  // Deciding a function before three peers confirmed it is for maintainers.
  const early = a.state === 'peer_review';
  for (const btn of document.querySelectorAll('.actions button')) btn.disabled = early && !atLeast('maintainer');
  document.querySelector('.actions [data-action="approve"]').textContent = early ? 'Approve, skip peer review' : 'Approve';
  $('attempt-peer-note').hidden = !early;
  $('review-status').textContent = a.reviews.map((x) => `${x.reviewer}: ${x.action}${x.comment ? ` - ${x.comment}` : ''}`).join('\n');
  $('attempt').scrollIntoView({ behavior: 'smooth' });
}

document.querySelectorAll('.actions button').forEach((b) =>
  b.addEventListener('click', async () => {
    if (!currentAttempt) return;
    try {
      const r = await post(`/api/attempts/${currentAttempt.id}/review`, { action: b.dataset.action, comment: $('review-comment').value });
      $('review-status').textContent = `Recorded. Attempt is now ${r.state}${r.approvalsNeeded ? ` (${r.approvalsNeeded} more approval needed)` : ''}.`;
      $('review-comment').value = '';
      await loadQueue();
    } catch (e) {
      $('review-status').textContent = e.message;
    }
  }),
);

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
    for (const c of document.querySelectorAll('.ws-win, .ws-linux, #open-win, #open-linux'))
      c.textContent = c.textContent.replace('wowdecomp', folder);
    if (info.gitWeb) $('source-link').href = info.gitWeb;
    $('clone-cmd').textContent = `git clone ${info.git}`;
  })
  .catch(() => {});
loadProgress().catch((e) => ($('progress-body').textContent = e.message));
refresh();
