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

let lastPct = 0; // the gauge moves from the previous reading, not from zero, when it refreshes

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
  fill.style.setProperty('width', `${Math.min(100, lastPct)}%`);
  lastPct = pct;
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

// --- public crew views

const ago = (t) => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

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
          const work = a.units.length
            ? a.units.map((u) => el('div', `${u.unit} · ${u.functions} function${u.functions > 1 ? 's' : ''}`))
            : [el('span', a.reviewing ? 'reviewing' : 'between tasks', 'muted')];
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
          ? 'Each needs three agreeing verdicts: three "same" send it to you, three "different" send it back. You can open one to judge it yourself, or approve it now and skip the peer review.'
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
              // Exactly the functions shown here; peer review is only skipped from its own section.
              await post(`/api/batches/${key}/review`, { action: 'approve', attemptIds: list.map((a) => a.id), skipPeerReview: skipsPeers });
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
    const peerCol = (a) => {
      const working = a.peer_working ? ` · ${a.peer_working} reviewing` : '';
      if (a.state === 'peer_review') return `${a.peer_same} same · ${a.peer_different} different${working}`;
      // Waiting for a human: more peers can still accept it (5 agreeing, no objection).
      return a.peer_different ? `${a.peer_same} same · ${a.peer_different} different: contested, you decide` : `${a.peer_same} same · accepts itself at 5${working}`;
    };
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
  const f = a.feedback || {};
  const t = f.target;
  $('attempt').hidden = false;
  $('attempt-title').textContent = `Attempt #${a.id} by ${a.author}${t ? `: ${t.demangled || t.id}` : ''}`;
  $('attempt-meta').replaceChildren(
    el('p', `${t ? `${t.id} · ` : ''}${a.state.replace('_', ' ')} · score ${((a.score || 0) * 100).toFixed(1)}% · size ${t?.size?.ours ?? '?'} / ${t?.size?.original ?? '?'} bytes · base ${a.baseCommit.slice(0, 10)}`, 'muted'),
  );
  if (a.changedHeaders.length) $('attempt-meta').append(el('p', `Changes headers: ${a.changedHeaders.join(', ')} (needs extra approval)`, 'warn'));

  const r = $('attempt-result');
  r.replaceChildren(el('p', f.summary || ''));
  if (a.peerReviews?.length) {
    const n = (v) => a.peerReviews.filter((p) => p.verdict === v).length;
    r.append(el('h3', `Peer review: ${n('same')} same, ${n('different')} different (${a.peerRequired} agreeing verdicts decide)`));
    r.append(table(['Reviewer', 'Verdict', 'Reason (untrusted)'], a.peerReviews.map((p) => [p.reviewer, status(p.verdict === 'same' ? 'exact' : 'revoked'), p.reason?.text ?? ''])));
  } else if (a.state === 'in_review' && t && t.status !== 'exact' && t.status !== 'match_unresolved') {
    r.append(el('p', 'Not byte-identical and no peer verdicts recorded.', 'warn'));
  }

  // Side by side: the submission on the left, the original on the right.
  compare = { source: a.targetSource, ourAsm: t?.asm ?? null, original: null, error: null };
  showCompare(compareView);
  if (t?.id) {
    api(`/api/original/${t.id}`)
      .then((o) => (compare.original = o))
      .catch((e) => (compare.error = e.message))
      .finally(() => currentAttempt === a && showCompare(compareView));
  }

  // Everything else folds away.
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
  const files = Object.entries(a.mergedFiles || a.files);
  fold(
    `Submitted files (${files.length})`,
    ...files.map(([p, content]) => {
      const d = el('details');
      d.append(el('summary', p), el('pre', content, 'code'));
      return d;
    }),
  );
  fold(a.notes ? 'Notes from the author (untrusted)' : 'Notes from the author (none)', el('pre', a.notes || '(none)', 'notes'));

  // Deciding a function before three peers confirmed it is for maintainers.
  const early = a.state === 'peer_review';
  for (const btn of document.querySelectorAll('.actions button')) btn.disabled = early && !atLeast('maintainer');
  document.querySelector('.actions [data-action="approve"]').textContent = early ? 'Approve, skip peer review' : 'Approve';
  $('attempt-peer-note').hidden = !early;
  $('review-status').textContent = a.reviews.map((x) => `${x.reviewer}: ${x.action}${x.comment ? ` - ${x.comment}` : ''}`).join('\n');
  $('attempt').scrollIntoView({ behavior: 'smooth' });
}

let compare = null;
let compareView = 'code';

for (const tab of document.querySelectorAll('.compare-tabs .tab')) tab.addEventListener('click', () => showCompare(tab.dataset.view));

function showCompare(view) {
  compareView = view;
  for (const tab of document.querySelectorAll('.compare-tabs .tab')) tab.classList.toggle('active', tab.dataset.view === view);
  const body = $('compare-body');
  body.replaceChildren();
  if (!compare) return;
  const o = compare.original;
  const pending = !o && !compare.error ? 'Loading the original…' : `Original not available${compare.error ? `: ${compare.error}` : ''}`;
  if (view === 'code') {
    body.append(
      twoPanes(
        [compare.source ? `Submitted C++ · ${compare.source.file}:${compare.source.line}` : 'Submitted C++', compare.source?.text ?? 'The function was not found in the submitted files.'],
        [o ? `Original pseudocode (Ghidra, a reading aid) · ${o.addr}` : 'Original pseudocode', o ? o.pseudocode ?? 'No pseudocode exported for this function yet; see the assembly view.' : pending],
      ),
    );
  } else if (!compare.ourAsm || !o) {
    body.append(twoPanes(['Our compiled code', compare.ourAsm ?? 'Not recorded for this attempt (it was submitted before the compiled code was kept). Newer attempts have it.'], [o ? `Original at ${o.addr}` : 'Original', o?.asm ?? pending]));
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
  // Labels of the original go back in above the instruction they name.
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

// For colouring only: case, spacing and size keywords differ between the two disassemblers.
function looseOperands(text) {
  return text.toLowerCase().replace(/;.*$/, '').replace(/\s+/g, '').replace(/(qword|dword|word|byte)ptr/g, '$1');
}

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
  // A gap on each side right after each other is one changed instruction: show it on one row.
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
loadCrew().catch((e) => ($('active-body').textContent = e.message));
// Live numbers: progress and the crew views refresh on their own.
setInterval(() => {
  loadProgress().catch(() => {});
  loadCrew().catch(() => {});
}, 30_000);
refresh();
