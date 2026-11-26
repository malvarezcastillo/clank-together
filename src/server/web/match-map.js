// Loaded before app.js; DOM helpers and controls are used only after both scripts initialize.
const matchMap = (() => {
  const labels = {
    exact: 'Exact', unresolved: 'Unresolved references', reloc: 'Relocation-only',
    same: 'Equal-size differences', size: 'Size mismatch', unknown: 'Details not recorded',
    unmeasured: 'Unmeasured', excluded: 'Not counted toward progress',
  };
  const buckets = Object.keys(labels);
  const needsWork = ['same', 'size', 'unknown', 'unmeasured'];
  const progressParts = [['exact', 'Exact', ['exact']], ['unresolved', 'Unresolved references', ['unresolved']],
    ['work', 'Needs work', needsWork], ['reloc', 'Relocation-only', ['reloc']]];
  const pageSize = { chart: 8, files: 12, strip: 16, work: 12 };
  const pages = { chart: 0, files: 0, strip: 0, work: 0 };
  const virtual = 'Unplaced symbols';
  const address = (n) => `0x${n.toString(16)}`;
  const bytes = (n) => `${fmt(Math.round(n))} B`;
  const humanBytes = (n) => n < 1024 ? bytes(n) : n < 1024 ** 2 ? `${+(n / 1024).toFixed(1)} KiB` : `${+(n / 1024 ** 2).toFixed(2)} MiB`;
  const percent = (n) => `${(n * 100).toFixed(1)}%`;
  const flow = (s) => s === 'claimed' || s === 'leased' ? 'claimed'
    : s === 'needs_cleanup' || s === 'hard' ? 'returned'
    : s && !['open', 'done', 'skipped'].includes(s) ? 'active' : '';
  const empty = (text) => el('p', text, 'muted');
  const positive = (n) => Number.isFinite(n) && n > 0 ? n : 0;
  const estimatedBytes = (n) => n > 0 && n < 1 ? '<1 B' : `~${bytes(n)}`;
  const evidence = (n) => Number.isFinite(n) && n >= 0;
  const byGain = (a, b) => b.gain - a.gain || a.order - b.order;
  const byPath = (a, b) => a.node.path.localeCompare(b.node.path);
  let data, root, byId, nodes, scope, selected, view;
  let bucket = '', query = '', area = 'size', mode = 'tree', bound = false;

  function rowFrom(tuple, order) {
    const [id, name, addr, size, unit, workflow, status, score, relocOnly, ourSize, differingBytes, failingReferences, excluded, measuredAt, confirmed] = tuple;
    const weight = positive(size);
    const similarity = evidence(score) && score <= 1 ? score : null;
    const kind = excluded ? 'excluded' : status === 'exact' ? 'exact' : status === 'match_unresolved' ? 'unresolved'
      : relocOnly ? 'reloc' : !status || status === 'missing' || status === 'no_address' ? 'unmeasured'
      : evidence(size) && evidence(ourSize) && size !== ourSize ? 'size'
      : evidence(size) && size === ourSize && evidence(differingBytes) ? 'same' : 'unknown';
    // A failed reference has the verifier's four-byte weight but isn't an observed byte diff.
    const gain = kind === 'unmeasured' ? weight : kind === 'same' ? Math.min(weight, differingBytes + (failingReferences ?? 0) * 4)
      : (kind === 'size' || kind === 'unknown') && similarity !== null ? weight * (1 - similarity) : 0;
    const measured = kind === 'unmeasured' || kind === 'excluded' ? null : similarity;
    const workflowKey = binaryGeometry.workflowKey(workflow, kind, confirmed);
    return { id, name, addr, size, unit, workflow, status, score: similarity, relocOnly, ourSize, differingBytes,
      failingReferences, excluded, measuredAt, order, weight, gain, measured, kind, workflowKey, flow: flow(workflow) };
  }

  function node(path, name, parent) {
    const entry = { path, name, parent, children: new Map(), rows: [], totals: aggregate() };
    nodes.set(path, entry);
    return entry;
  }

  function setData(payload) {
    const previousPath = scope?.path;
    const previousId = selected?.id;
    data = payload;
    nodes = new Map();
    byId = new Map();
    root = node('', 'Whole binary', null);
    for (const [order, tuple] of payload.rows.entries()) {
      const row = rowFrom(tuple, order);
      const start = Math.floor(row.addr / 65536) * 65536;
      const parts = row.unit ? row.unit.split('/').filter(Boolean) : [virtual, `${address(start)}–${address(start + 65535)}`];
      // Keep the logical address tree distinct even if a source folder has the same label.
      let parent = root;
      parent.rows.push(row);
      add(parent.totals, row);
      for (const [i, name] of parts.entries()) {
        const segment = !row.unit && i === 0 ? `@${virtual}` : name;
        let child = parent.children.get(segment);
        if (!child) {
          child = node(parent.path ? `${parent.path}/${segment}` : segment, name, parent);
          parent.children.set(segment, child);
        }
        parent = child;
        parent.rows.push(row);
        add(parent.totals, row);
      }
      row.node = parent;
      row.search = [row.id, row.name, row.unit, parent.path, address(row.addr), String(row.addr)].filter(Boolean).join('\n').toLowerCase();
      byId.set(row.id, row);
    }
    scope = nodes.get(previousPath) ?? null;
    selected = byId.get(previousId) ?? null;
    view = null;
  }

  function href(entry, row, panel = 'tree') {
    const path = entry.path ? '/' + entry.path.split('/').map(encodeURIComponent).join('/') : '';
    const params = new URLSearchParams();
    if (panel !== 'tree') params.set('view', panel);
    if ((panel === 'tree' || panel === 'address') && area === 'gap') params.set('area', 'gap');
    if (bucket) params.set('status', bucket);
    if (query && entry === scope) params.set('q', $('map-search').value.trim());
    if (row) params.set('symbol', row.id);
    return '#/map' + path + (params.size ? `?${params}` : '');
  }

  function link(entry, text, row) {
    const a = el('a', text);
    const panel = row || ['tree', 'address', 'coverage', 'browse'].includes(mode) ? mode : 'tree';
    a.href = href(entry, row, panel);
    if (row) a.title = nameOf(row);
    return a;
  }

  function bind() {
    if (bound) return;
    bound = true;
    query = $('map-search').value.trim().toLowerCase();
    area = $('map-area').value;
    const toggle = $('binary-by-match');
    try { toggle.checked = localStorage.getItem('atlas-color-mode') !== 'workflow'; } catch {}
    toggle.addEventListener('change', () => {
      try { localStorage.setItem('atlas-color-mode', toggle.checked ? 'match' : 'workflow'); } catch {}
      $('binary-highlight').setAttribute('aria-pressed', 'false');
      if (scope) showAtlas(getView(), mode);
    });
    $('map-search').addEventListener('input', (e) => {
      query = e.target.value.trim().toLowerCase();
      if (scope) history.replaceState(null, '', href(scope, null, mode));
      resetPages();
      if (scope) renderResults();
    });
    $('map-area').addEventListener('change', (e) => {
      area = e.target.value;
      if (scope) history.replaceState(null, '', href(scope, null, mode));
      pages.files = 0;
      if (scope) renderPanel(getView());
    });
    $('map-filter').addEventListener('change', (e) => filterBy(e.target.value));
    $('binary-highlight').addEventListener('click', () => {
      if (!scope) return;
      $('binary-by-match').checked = true;
      const b = $('binary-highlight');
      b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
      showAtlas(getView(), mode);
    });
    for (const control of $('map-modes').children) {
      control.addEventListener('click', () => {
        if (!scope) return;
        const searched = Boolean(query);
        if (searched) $('map-search').value = query = '';
        const next = href(scope, null, control.dataset.mode);
        if (location.hash !== next) location.hash = next;
        else if (searched) renderResults();
      });
    }
  }

  function resetPages() {
    pages.chart = pages.files = pages.strip = pages.work = 0;
  }

  function aggregate() {
    return { count: 0, originalBytes: 0, weight: 0, gain: 0, matched: 0, noSize: 0,
      observed: 0, estimated: 0, uncovered: 0,
      counts: Object.fromEntries(buckets.map((k) => [k, 0])), sizes: Object.fromEntries(buckets.map((k) => [k, 0])),
      flows: { active: 0, claimed: 0, returned: 0 } };
  }

  function add(stats, row) {
    stats.count++;
    stats.counts[row.kind]++;
    stats.originalBytes += row.weight;
    stats.sizes[row.kind] += row.weight;
    if (row.flow) stats.flows[row.flow]++;
    if (row.excluded) return;
    stats.weight += row.weight;
    stats.gain += row.gain;
    if (row.kind === 'same') {
      stats.observed += row.differingBytes;
      stats.estimated += row.gain - row.differingBytes;
    } else if (row.kind === 'unmeasured') stats.uncovered += row.gain;
    else stats.estimated += row.gain;
    if (!evidence(row.size)) stats.noSize++;
    if (row.measured !== null) {
      stats.matched += row.weight * row.measured;
    }
  }

  function getView() {
    if (view && view.scope === scope && view.query === query && view.bucket === bucket) return view;
    const terms = query.split(/\s+/).filter(Boolean);
    const children = new Map(), rows = [], workflowCounts = Object.create(null);
    for (const row of scope.rows) {
      if (!terms.every((term) => row.search.includes(term))) continue;
      if (bucket && (bucket === 'work' ? !needsWork.includes(row.kind) : row.kind !== bucket)) continue;
      rows.push(row);
      workflowCounts[row.workflowKey] = (workflowCounts[row.workflowKey] ?? 0) + 1;
      for (let entry = row.node; entry !== scope; entry = entry.parent) {
        let item = children.get(entry);
        if (!item) children.set(entry, item = { node: entry, ...aggregate() });
        add(item, row);
      }
    }
    const work = rows.filter((row) => needsWork.includes(row.kind)).sort(byGain);
    const worst = work.filter((row) => row.gain > 0 && row.flow !== 'claimed' && row.flow !== 'active');
    const rank = (key) => {
      const groups = [];
      for (const child of scope.children.values()) {
        const stats = children.get(child);
        if (stats) groups.push({ node: child, stats, area: stats[key] });
      }
      groups.sort(byArea);
      return { groups, tiles: mapTiles(groups, children, key) };
    };
    return view = { scope, query, bucket, rows, work, worst, workflowCounts, size: rank('weight'), gap: rank('gain'), allCode: rank('originalBytes') };
  }

  const byArea = (a, b) => b.area - a.area || byPath(a, b);

  function mapTiles(groups, statsByNode, key) {
    const tiles = groups.filter((item) => item.area > 0);
    const total = tiles.reduce((sum, item) => sum + item.area, 0);
    // A root like Source/ owns nearly all the bytes. Expose its children rather than drawing
    // one enormous rectangle. Only expand when the children's weights partition the parent.
    while (tiles.length && tiles[0].area > total * 0.7) {
      const dominant = tiles[0];
      const children = [];
      for (const child of dominant.node.children.values()) {
        const stats = statsByNode.get(child);
        if (stats?.[key] > 0) children.push({ node: child, stats, area: stats[key] });
      }
      if (!children.length || Math.abs(children.reduce((sum, child) => sum + child.area, 0) - dominant.area) > 1e-4) break;
      tiles.splice(0, 1, ...children);
      tiles.sort(byArea);
    }
    return tiles;
  }


  function filterBy(kind) {
    bucket = kind;
    $('map-filter').value = bucket;
    resetPages();
    if (!scope) return;
    history.replaceState(null, '', href(scope, null, mode));
    for (const b of $('map-progress-breakdown').querySelectorAll('button[data-bucket]')) b.setAttribute('aria-pressed', String(b.dataset.bucket === bucket));
    renderResults();
  }

  function mark(node, kind) {
    node.dataset.bucket = kind;
    return node;
  }

  function drawProgress(totals) {
    const metrics = $('map-metrics');
    const metric = (label, value, hint, cls = '') => {
      const item = el('div', null, `match-metric ${cls}`);
      const amount = el('dd', value);
      item.append(el('dt', label), amount);
      if (hint) amount.append(el('small', hint));
      return item;
    };
    metrics.replaceChildren(
      metric('Byte-exact', totals.weight ? percent(totals.sizes.exact / totals.weight) : '—', `${humanBytes(totals.sizes.exact)} of ${humanBytes(totals.weight)} in exact functions`, 'match-metric-primary'),
      metric('Remaining work', totals.weight ? `${totals.estimated > 0 ? '≈' : ''}${humanBytes(totals.gain)}` : '—', totals.estimated > 0 ? 'Includes estimated gaps' : 'Bytes left to match'),
      metric('Weighted similarity', totals.weight ? percent(totals.matched / totals.weight) : '—', 'Includes partial matches'),
    );
    $('map-progress-counts').textContent = [
      `${bytes(totals.observed)} observed differing`, `${estimatedBytes(totals.estimated)} estimated gap`, `${bytes(totals.uncovered)} unmeasured`,
      totals.noSize && `${fmt(totals.noSize)} functions without an original size`, totals.counts.excluded && `${fmt(totals.counts.excluded)} functions not counted toward progress`,
    ].filter(Boolean).join(' · ');

    const bar = el('div', null, 'match-bar');
    bar.setAttribute('aria-hidden', 'true');
    const legend = el('div', null, 'match-legend');
    for (const [kind, label, members] of progressParts) {
      const size = members.reduce((sum, key) => sum + totals.sizes[key], 0);
      if (size <= 0) continue;
      const segment = mark(el('span', null, 'match-segment'), kind);
      segment.style.flex = `${size} 1 0px`;
      bar.append(segment);
      const b = mark(button(label, () => filterBy(bucket === kind ? '' : kind), 'match-key'), kind);
      b.title = `${label}: ${bytes(size)}`;
      b.setAttribute('aria-label', b.title);
      b.setAttribute('aria-pressed', String(bucket === kind));
      legend.append(b);
    }
    const box = $('map-progress-breakdown');
    box.replaceChildren(...(bar.childElementCount ? [bar, legend] : [empty('No bytes of known size count toward progress here.')]));
  }

  function drawScope(totals) {
    const trail = [];
    for (let entry = scope; entry; entry = entry.parent) trail.unshift(entry);
    const crumbs = $('map-crumbs');
    const list = el('ol');
    crumbs.hidden = scope === root && !selected;
    for (const entry of trail) {
      const item = el('li');
      if (entry === scope && !selected) {
        const current = el('span', entry === root ? 'Byte map' : entry.name);
        current.setAttribute('aria-current', 'page');
        item.append(current);
      } else {
        const a = link(entry, entry === root ? 'Byte map' : entry.name);
        if (entry === scope) a.href = href(scope, null, mode);
        item.append(a);
      }
      list.append(item);
    }
    if (selected) {
      const item = el('li');
      const current = el('span', selected.id);
      current.setAttribute('aria-current', 'page');
      item.append(current);
      list.append(item);
    }
    crumbs.replaceChildren(list);
    $('map-panel-title').textContent = scope === root ? 'Binary atlas' : scope.name;
    $('map-summary').textContent = `${fmt(totals.count)} functions · ${humanBytes(totals.originalBytes)} of known function code${data.version ? ` · ${data.version}` : ''}`;
  }

  function paginate(box, key, items, draw) {
    const size = pageSize[key];
    const totalPages = Math.max(1, Math.ceil(items.length / size));
    const page = pages[key] = Math.min(pages[key], totalPages - 1);
    draw(items.slice(page * size, (page + 1) * size));
    if (totalPages < 2) return;
    const nav = el('div', null, 'match-pages');
    const shift = (delta) => {
      pages[key] += delta;
      refresh();
      const controls = box.querySelectorAll('.match-pages button:not(:disabled)');
      controls[delta > 0 ? controls.length - 1 : 0]?.focus();
    };
    const prev = button('Previous page', () => shift(-1));
    const next = button('Next page', () => shift(1));
    prev.disabled = page === 0;
    next.disabled = page === totalPages - 1;
    nav.append(prev, el('span', ` ${fmt(page * size + 1)}–${fmt(Math.min(items.length, (page + 1) * size))} of ${fmt(items.length)} `), next);
    box.append(nav);
  }


  function drawChildren(view, panel) {
    const spatial = panel === 'tree' || panel === 'address';
    const tree = $('map-tree'), ranked = $('map-ranked'), files = $('map-files');
    tree.hidden = !spatial;
    ranked.hidden = spatial;
    $('map-area-control').hidden = !spatial;
    $('binary-highlight').hidden = !spatial;
    $('map-locations').hidden = !scope.children.size;
    const { groups } = area === 'gap' ? view.gap : view.allCode;
    if (spatial) {
      $('map-folder-title').textContent = panel === 'address' ? 'Code in address order' : 'Functions by source location';
      $('map-tree-caption').textContent = panel === 'address'
        ? 'Functions are packed in original address order along a Hilbert curve. Address gaps are omitted.'
        : 'One cell per known-size function, grouped by source. Group labels open folders and files.';
      showAtlas(view, panel);
    } else {
      binaryMap.hide();
      drawRankedChart(ranked, view, panel === 'coverage');
    }
    files.replaceChildren();
    if (!groups.length) return;
    const amountLabel = area === 'gap' ? 'Remaining work' : 'Original code size';
    paginate(files, 'files', groups, (visible) => {
      const list = listing(['Location', 'Exact share', amountLabel], 'match-folder-list');
      for (const { node: entry, stats, area: amount } of visible) {
        const a = link(entry, null);
        const location = entry.children.size ? 'Folder' : entry.path.startsWith('@') ? 'Address range' : 'File';
        const count = stats.count - stats.counts.excluded;
        const activity = stats.flows.active ? `${fmt(stats.flows.active)} in flight` : stats.flows.claimed ? `${fmt(stats.flows.claimed)} claimed` : stats.flows.returned ? `${fmt(stats.flows.returned)} returned` : '';
        a.className = 'match-row-link';
        a.append(el('strong', entry.name), el('small', [location, count ? `${fmt(count)} functions` : labels.excluded, activity].filter(Boolean).join(' · ')));
        const exact = stats.weight > 0 ? stats.sizes.exact / stats.weight : null;
        const meter = el('div', null, 'match-exact');
        if (exact != null) {
          const track = el('span', null, 'match-track');
          const fill = el('span');
          fill.style.width = `${exact * 100}%`;
          track.append(fill);
          meter.append(track);
        }
        meter.append(el('span', exact == null ? '—' : percent(exact)));
        const amountCell = el('span', area === 'gap' && stats.estimated > 0 ? `≈${humanBytes(amount)}` : humanBytes(amount), 'match-amount');
        amountCell.title = bytes(amount);
        appendChevron(a);
        appendListRow(list, [a, meter, amountCell]);
      }
      files.append(list);
    });
  }

  // Every bar begins at zero. In work mode the scale is the largest gap in the entire
  // filtered location (not just this page); in coverage mode it is always 100%.
  function drawRankedChart(box, view, coverage) {
    const leaf = !scope.children.size;
    const items = leaf ? view.rows.filter(r => !r.excluded && r.weight > 0).map(row => ({ row, name: nameOf(row), size: row.weight,
      exact: row.kind === 'exact' ? row.weight : 0, gain: row.gain, estimate: ['size', 'unknown'].includes(row.kind) && row.gain > 0 }))
      : view.size.tiles.map(({ node, stats }) => ({ node, name: node.name, size: stats.weight, exact: stats.sizes.exact, gain: stats.gain, estimate: stats.estimated > 0 }));
    const visible = coverage ? items : items.filter(item => item.gain > 0);
    visible.sort((a, b) => (coverage ? a.exact / a.size - b.exact / b.size : b.gain - a.gain) || b.size - a.size || a.name.localeCompare(b.name));
    const title = $('map-folder-title'), caption = $('map-tree-caption');
    title.textContent = coverage ? 'How much is byte-exact?' : 'Where is the remaining work?';
    if (leaf) title.textContent = coverage ? 'Byte-exact functions' : 'Functions with the largest gaps';
    box.replaceChildren();
    if (!visible.length) {
      caption.textContent = '';
      box.append(empty(bucket ? 'No matching results for this status.' : coverage ? 'No functions with known original sizes here.' : 'No known source-fixable byte gap here.'));
      if (!coverage) box.append(linkToMode('Explore exact coverage', 'coverage'));
      return;
    }
    const max = coverage ? 1 : visible[0].gain;
    const total = coverage ? 0 : visible.reduce((sum, item) => sum + item.gain, 0);
    caption.textContent = coverage ? 'Gold shows the share of original bytes in exact functions. Lowest coverage first.'
      : `${visible[0].name} accounts for ${percent(visible[0].gain / total)} of the ${bucket ? 'filtered ' : ''}remaining work. ${leaf ? 'Select a function to compare.' : 'Select a location to explore.'}`;
    const axis = el('div', null, 'match-rank-axis');
    axis.setAttribute('aria-hidden', 'true');
    const scale = el('span', null, 'match-rank-scale');
    scale.append(el('span', '0'), el('span', coverage ? '100%' : humanBytes(max)));
    axis.append(el('span', leaf ? 'Function' : 'Location'), scale, el('span', coverage ? 'Exact share' : 'Bytes left'));
    box.append(axis);
    paginate(box, 'chart', visible, page => {
      const list = el('ol', null, 'match-rank');
      list.start = pages.chart * pageSize.chart + 1;
      for (const item of page) {
        const fraction = coverage ? item.exact / item.size : item.gain / max;
        const a = link(item.node ?? scope, null, item.row);
        const name = el('span', null, 'match-rank-name');
        const context = item.row ? `${item.row.id} · ${address(item.row.addr)}` : `${item.node.children.size ? 'Folder' : item.node.path.startsWith('@') ? 'Address range' : 'File'} · ${humanBytes(item.size)} original`;
        name.append(el('strong', item.name), el('small', context));
        const track = el('span', null, 'match-rank-track');
        track.setAttribute('aria-hidden', 'true');
        const bar = el('span');
        bar.style.width = `${fraction * 100}%`;
        track.append(bar);
        const value = coverage ? percent(fraction) : `${item.estimate ? '≈' : ''}${humanBytes(item.gain)}`;
        const amount = el('span', value, 'match-rank-value');
        a.className = 'match-rank-link';
        a.title = `${item.node?.path ?? item.name}: ${coverage ? `${bytes(item.exact)} of ${bytes(item.size)} exact` : `${value} remaining`}`;
        a.append(name, track, amount);
        appendChevron(a);
        const li = el('li');
        li.append(a);
        list.append(li);
      }
      box.append(list);
    });
  }

  function linkToMode(text, panel) {
    const a = el('a', text);
    a.href = href(scope, null, panel);
    return a;
  }

  function showAtlas(view, panel) {
    const rows = view.rows;
    const byWorkflow = !$('binary-by-match').checked;
    const highlightGaps = !byWorkflow && currentView !== 'home' && $('binary-highlight').getAttribute('aria-pressed') === 'true';
    $('binary-highlight-key').hidden = !highlightGaps;
    $('binary-match-key').hidden = byWorkflow || highlightGaps;
    const workflowLegend = $('binary-workflow-key');
    workflowLegend.hidden = !byWorkflow;
    if (byWorkflow) {
      workflowLegend.replaceChildren(...Object.entries(binaryGeometry.workflowLabels).filter(([key]) =>
        view.workflowCounts[key] || (key !== 'merged' && key !== 'unresolved')).map(([key, label]) => {
        const chip = el('span', null);
        chip.style.setProperty('--swatch', `var(--binary-${key})`);
        chip.append(label, el('small', fmt(view.workflowCounts[key] ?? 0)));
        return chip;
      }));
    }
    $('binary-color-caption').textContent = byWorkflow ? 'Colors show workflow status' : highlightGaps ? 'Colors highlight remaining work' : 'Colors show the measured match on main';
    binaryMap.show({ rows, scope: scope.path, version: data.version, filter: bucket, groups: (area === 'gap' ? view.gap : view.allCode).tiles,
      layout: panel === 'address' ? 'address' : 'source', weight: area === 'gap' ? 'gain' : 'weight',
      byWorkflow, highlightGaps, describe: row => `${binaryGeometry.workflowLabels[row.workflowKey]} · ${reason(row)}`, onSelect: inspectCell,
      navigate: row => { location.hash = href(scope, row, mode); },
      drill: entry => { location.hash = href(entry, null, mode); },
    });
    const hotspots = $('binary-hotspot-list');
    hotspots.replaceChildren();
    for (const row of view.work.slice(0, 3)) {
      if (row.gain <= 0) break;
      const b = button(null, () => binaryMap.focusRow(row), 'binary-hotspot');
      b.title = `${nameOf(row)} · ${row.unit ?? 'Unplaced'} · ${reason(row)}`;
      b.append(el('strong', nameOf(row)), el('small', `${gainLabel(row)} remaining · ${address(row.addr)}`));
      hotspots.append(b);
    }
    if (!hotspots.childElementCount) hotspots.append(empty('No known source-fixable gaps in this view.'));
  }

  function inspectCell(row) {
    const box = $('binary-selection');
    box.replaceChildren();
    if (!row) {
      box.append(el('h4', 'Function inspector'), el('p', 'Select a cell on the map to see its address, match evidence and source file.'));
      return;
    }
    const compare = link(scope, 'Compare on main →', row);
    const actions = el('div', null, 'binary-inspect-actions');
    actions.append(button('Zoom to function', () => binaryMap.focusRow(row)), compare);
    const file = row.node === scope ? el('span', row.unit ?? row.node.name) : link(row.node, row.unit ?? row.node.name);
    box.append(el('h4', nameOf(row)), el('p', `${row.id} · ${address(row.addr)} · ${row.size == null ? 'size unknown' : bytes(row.size)}`),
      el('p', `${binaryGeometry.workflowLabels[row.workflowKey]} · ${reason(row)}`), el('p', `Remaining work: ${gainLabel(row)}`), file, actions);
  }

  function listing(headers, cls) {
    const grid = el('div', null, `match-list ${cls}`);
    grid.setAttribute('role', 'table');
    const head = el('div', null, 'match-list-row match-list-head');
    head.setAttribute('role', 'row');
    for (const label of headers) {
      const cell = el('div', label);
      cell.setAttribute('role', 'columnheader');
      head.append(cell);
    }
    grid.append(head);
    return grid;
  }

  function appendListRow(list, cells) {
    const row = el('div', null, 'match-list-row');
    row.setAttribute('role', 'row');
    for (const content of cells) {
      const cell = el('div');
      cell.setAttribute('role', 'cell');
      cell.append(content);
      row.append(cell);
    }
    list.append(row);
  }

  function reason(row) {
    const details = [labels[row.kind]];
    if (row.kind === 'unmeasured' && row.status === 'missing') details.push('compiler emitted no function');
    if (row.kind === 'size') details.push(`${bytes(row.size)} original → ${bytes(row.ourSize)} compiled`);
    if (row.kind === 'same') details.push(`${fmt(row.differingBytes)} differing ${row.differingBytes === 1 ? 'byte' : 'bytes'}`);
    if (row.failingReferences > 0) details.push(`${fmt(row.failingReferences)} failing ${row.failingReferences === 1 ? 'reference' : 'references'}`);
    if (row.score !== null && ['size', 'unknown'].includes(row.kind)) details.push(`${percent(row.score)} reported similarity`);
    return details.join(' · ');
  }


  function appendChevron(a) {
    const arrow = el('span', '›', 'match-chevron');
    arrow.setAttribute('aria-hidden', 'true');
    a.append(arrow);
  }
  function gainLabel(row) {
    if (!row.weight || row.excluded || row.kind === 'reloc') return '—';
    if (row.kind === 'same' || row.kind === 'unmeasured') return humanBytes(row.gain);
    if (row.kind === 'exact' || row.kind === 'unresolved') return '0 B';
    if (row.score == null) return '—';
    return row.gain > 0 && row.gain < 1 ? '<1 B' : `≈${humanBytes(row.gain)}`;
  }

  const nameOf = (row) => row.name || row.id;

  function drawFunctions(rows, ranked) {
    const box = $(ranked ? 'map-work' : 'map-strip');
    box.replaceChildren();
    if (!rows.length) return box.append(empty(ranked ? 'No remaining work matches this view.' : 'No functions match this view.'));
    paginate(box, ranked ? 'work' : 'strip', rows, (visible) => {
      if (!ranked && !scope.children.size && !query) drawAddressStrip(box, visible);
      const list = listing(['Function', 'Match on main', ranked ? 'Remaining work' : 'Original size'], 'match-function-list');
      for (const row of visible) {
        const title = link(scope, null, row);
        title.className = 'match-row-link';
        title.append(el('strong', nameOf(row)), el('small', `${row.id} · ${address(row.addr)}`));
        appendChevron(title);
        const identity = el('div', null, 'match-identity');
        identity.append(title);
        if (row.node !== scope) {
          const location = link(row.node, row.node.name);
          location.className = 'match-location';
          location.title = row.unit ?? row.node.name;
          identity.append(location);
        }
        const evidenceCell = el('div', null, 'match-evidence');
        const hasScore = row.score != null && needsWork.includes(row.kind) && row.kind !== 'unmeasured';
        const badge = mark(el('span', hasScore ? percent(row.score) : labels[row.kind], 'match-status'), row.kind);
        badge.title = reason(row);
        evidenceCell.append(badge);
        if (hasScore) evidenceCell.append(el('small', row.kind === 'same' || row.kind === 'size' ? reason(row) : labels[row.kind]));
        if (row.flow) evidenceCell.append(el('small', { active: 'In flight', claimed: 'Claimed', returned: 'Returned' }[row.flow]));
        const amount = el('span', ranked ? gainLabel(row) : evidence(row.size) ? humanBytes(row.size) : '—', 'match-amount');
        if (ranked && row.gain) amount.title = `${bytes(row.gain)} · ${reason(row)}`;
        else if (evidence(row.size)) amount.title = bytes(row.size);
        appendListRow(list, [identity, evidenceCell, amount]);
      }
      box.append(list);
    });
  }

  function drawAddressStrip(box, rows) {
    const total = rows.reduce((sum, row) => sum + row.weight, 0);
    if (!total) return;
    box.append(el('p', `${address(rows[0].addr)} – ${address(rows.at(-1).addr)}`, 'match-address-range'));
    const bar = el('div', null, 'match-bar match-address-strip');
    bar.setAttribute('aria-label', 'Functions sized by original bytes; larger targets are in the list below');
    for (const row of rows) {
      if (!row.weight) continue;
      const segment = mark(link(scope, null, row), row.kind);
      segment.className = 'match-segment';
      segment.title = `${nameOf(row)} · ${bytes(row.size)} · ${reason(row)}`;
      segment.setAttribute('aria-label', segment.title);
      segment.tabIndex = -1;
      segment.style.flex = `${row.weight} 1 0px`;
      bar.append(segment);
    }
    box.append(bar);
  }

  const shownMode = () => query ? 'functions' : mode;

  function renderPanel(view) {
    const panel = shownMode();
    const chart = ['browse', 'coverage', 'tree', 'address'].includes(panel);
    if (!chart) binaryMap.hide();
    $('map-overview').hidden = !chart;
    $('map-work-panel').hidden = panel !== 'work';
    $('map-function-panel').hidden = panel !== 'functions';
    for (const b of $('map-modes').children) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === panel));
    }
    const links = [];
    if (panel !== 'browse') links.push(linkToMode('Rank gaps by location', 'browse'));
    if (panel !== 'coverage') links.push(linkToMode('Compare exact coverage', 'coverage'));
    if (panel !== 'work') links.push(linkToMode('Function worklist', 'work'));
    if (panel !== 'functions') links.push(linkToMode('Functions in address order', 'functions'));
    $('map-inspect-links').replaceChildren(...links);
    if (chart) drawChildren(view, panel);
    else if (panel === 'work') drawFunctions(view.work, true);
    else {
      $('map-function-title').textContent = query ? 'Search results' : 'Functions';
      $('map-function-note').textContent = `${fmt(view.rows.length)} ${view.rows.length === 1 ? 'function' : 'functions'} · original address order`;
      drawFunctions(view.rows, false);
    }
  }

  function renderResults() {
    const current = getView();
    for (const b of document.querySelectorAll('[data-view="map"] [data-move]')) {
      b.disabled = !moveTarget(b.dataset.move);
      if (b.dataset.move === 'worst') b.title = 'Next available function by estimated remaining work';
    }
    if (!selected) renderPanel(current);
  }

  function refresh() {
    if (!scope) return;
    drawScope(scope.totals);
    if (selected) {
      binaryMap.hide();
      $('map-compare-back').href = href(scope, null, mode);
      $('map-compare-back').textContent = `← Back to ${query ? 'search results' : mode === 'address' ? 'address atlas' : mode === 'tree' ? 'source treemap' : mode === 'browse' ? 'remaining work' : mode === 'coverage' ? 'exact coverage' : mode === 'work' ? 'worklist' : 'functions'}`;
      const measurement = selected.score == null || selected.kind === 'unmeasured' ? 'Not measured' : `${percent(selected.score)} similarity`;
      const summary = $('map-public-finding');
      summary.replaceChildren(el('strong', measurement), el('span', reason(selected)), el('span', `Remaining work: ${gainLabel(selected)}`));
      if (scope !== selected.node) summary.append(link(selected.node, `Explore ${selected.node.name}`));
    } else {
      $('map-progress').hidden = $('map-workspace').hidden = $('map-method').hidden = false;
      drawProgress(scope.totals);
    }
    renderResults();
  }

  function enterHome() {
    bind();
    $('binary-by-match').checked = true;
  }

  function showHome() {
    bind();
    scope = root;
    selected = null;
    mode = 'tree';
    area = 'size';
    bucket = query = '';
    showAtlas(getView(), mode);
  }

  function show(hash) {
    bind();
    if (!data) {
      $('map-summary').textContent = 'Loading byte map…';
      return null;
    }
    const split = hash.indexOf('?');
    const path = (split === -1 ? hash : hash.slice(0, split)).slice('#/map'.length);
    const params = new URLSearchParams(split === -1 ? '' : hash.slice(split + 1));
    let entry;
    try {
      entry = nodes.get(path.split('/').filter(Boolean).map(decodeURIComponent).join('/'));
    } catch {
      // Malformed percent escape: treat this as an unknown path.
    }
    if (!entry) {
      binaryMap.hide();
      scope = null;
      selected = null;
      $('map-crumbs').hidden = false;
      $('map-crumbs').replaceChildren(link(root, 'Byte map'));
      $('map-panel-title').textContent = 'Location not found';
      $('map-summary').textContent = 'This folder or file is not in the current map.';
      $('map-progress').hidden = $('map-workspace').hidden = $('map-method').hidden = true;
      return null;
    }
    const requestedMode = params.get('view');
    const panel = ['browse', 'work', 'functions', 'coverage', 'address'].includes(requestedMode) ? requestedMode : 'tree';
    area = params.get('area') === 'gap' ? 'gap' : 'size';
    $('map-area').value = area;
    const status = params.get('status') || '';
    const nextBucket = status === 'work' || buckets.includes(status) ? status : '';
    const text = params.get('q') ?? '';
    const nextQuery = text.trim().toLowerCase();
    if (scope !== entry || mode !== panel || bucket !== nextBucket || query !== nextQuery) resetPages();
    if (scope !== entry) $('map-locations').open = false;
    $('map-search').value = text;
    $('map-filter').value = bucket = nextBucket;
    query = nextQuery;
    scope = entry;
    mode = panel;
    selected = byId.get(params.get('symbol')) ?? null;
    if (selected && scope !== root && selected.node !== scope && !selected.node.path.startsWith(`${scope.path}/`)) selected = null;
    if (params.has('symbol') && !selected) {
      refresh();
      $('map-summary').append(' | Symbol not found in this scope.');
    } else refresh();
    return selected;
  }

  function moveTarget(kind) {
    if (!scope) return null;
    const { rows, worst } = getView();
    let target;
    if (kind === 'worst') {
      const index = worst.indexOf(selected);
      target = worst[index + 1] ?? worst[0];
    } else if (kind === 'next' || kind === 'previous') {
      if (!selected) target = kind === 'next' ? rows[0] : rows.at(-1);
      else {
        // The selected function can be outside the active search or byte filter.
        let lo = 0, hi = rows.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          const order = rows[mid].order;
          if (order < selected.order || (kind === 'next' && order === selected.order)) lo = mid + 1;
          else hi = mid;
        }
        target = rows[kind === 'next' ? lo : lo - 1];
      }
    }
    return target === selected ? null : target;
  }

  function move(kind) {
    const target = moveTarget(kind);
    if (!target) return null;
    location.hash = href(scope, target, mode);
    return target;
  }

  function resize() {
    if (scope && !selected && ['tree', 'address'].includes(shownMode())) binaryMap.resize();
  }

  function resetSearch() {
    if (!query) return false;
    $('map-search').value = query = '';
    resetPages();
    if (scope) {
      history.replaceState(null, '', href(scope, null, mode));
      renderResults();
    }
    return true;
  }

  return { setData, show, enterHome, showHome, resize, move, resetSearch };
})();
