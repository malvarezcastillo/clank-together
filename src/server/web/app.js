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

$('copy-install').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('install-win').textContent);
    $('copy-install').textContent = 'Copied';
  } catch {
    $('copy-install').textContent = 'Select the line and copy it';
  }
});

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
  const { users, roles } = await api('/api/admin/users');
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
      ['User', 'Role', 'Status', 'Active tokens', 'Approved', ''],
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
        return [u.name, select, status(u.status), u.active_tokens, `${date(u.approved_at)}${u.approved_by ? ` by ${u.approved_by}` : ''}`, action];
      }),
    ),
  );
}

// --- review

async function loadQueue() {
  const q = await api('/api/review/queue');
  const body = $('queue-body');
  body.replaceChildren();
  if (!q.length) return body.append(el('p', 'Nothing waiting for review. Byte-identical work merges on its own; this queue only holds peer-confirmed functions.', 'muted'));
  // One block per batch: the functions three peers confirmed, approved together with one click.
  const batches = new Map();
  for (const a of q) {
    const key = a.batch_id ?? `a${a.id}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(a);
  }
  for (const [key, items] of batches) {
    const head = el('div', null, 'batch-head');
    head.append(el('strong', typeof key === 'number' ? `Batch #${key}` : `Attempt #${items[0].id}`), el('span', ` by ${items[0].author} · ${items.length} function${items.length > 1 ? 's' : ''} confirmed by peers`, 'muted'));
    if (typeof key === 'number') {
      head.append(
        button(
          'Approve batch',
          async () => {
            try {
              await api(`/api/batches/${key}/review`, { method: 'POST', body: JSON.stringify({ action: 'approve' }) });
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
    body.append(
      table(
        ['Attempt', 'Symbol', 'Name', 'Score', 'Approvals', ''],
        items.map((a) => [`#${a.id}`, a.symbol_id, a.name || '', `${(a.score * 100).toFixed(1)}%`, a.approvals, button(a.reviewed_by_me ? 'Reviewed' : 'Open', () => openAttempt(a.id))]),
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

  const files = $('attempt-files');
  files.replaceChildren();
  for (const [p, content] of Object.entries(a.mergedFiles || a.files)) {
    const d = el('details');
    d.append(el('summary', p));
    d.append(el('pre', content, 'code'));
    files.append(d);
  }
  $('attempt-notes').textContent = a.notes || '(none)';
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
    if (info.gitWeb) $('source-link').href = info.gitWeb;
    $('clone-cmd').textContent = `git clone ${info.git}`;
  })
  .catch(() => {});
loadProgress().catch((e) => ($('progress-body').textContent = e.message));
refresh();
