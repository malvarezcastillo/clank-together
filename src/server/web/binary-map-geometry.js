// Spatial indexes for the function map. Coordinates stay in the original canvas layout
// while the viewer pans/zooms. No cell encodes evidence below function granularity.
const binaryGeometry = (() => {
  // Workflow is independent of similarity. An active revision takes precedence over its
  // baseline on main; a high score (or merely being done) is not peer confirmation.
  const workflowLabels = {
    identical: 'Byte-identical', confirmed: 'Peer-confirmed', skipped: 'Needs no source',
    flight: 'On its way to main', claimed: 'Claimed', returned: 'Sent back', open: 'Open',
    unresolved: 'Unresolved references', merged: 'On main',
  };
  function workflowKey(state, kind, confirmed) {
    if (kind === 'excluded' || state === 'skipped') return 'skipped';
    switch (state) {
      case 'queued': case 'verifying': case 'peer_review': case 'in_review': case 'approved': case 'merging': return 'flight';
      case 'leased': case 'claimed': return 'claimed';
      case 'hard': case 'needs_cleanup': return 'returned';
    }
    if (kind === 'exact') return 'identical';
    if (kind === 'unresolved') return 'unresolved';
    if (confirmed) return 'confirmed';
    return state === 'done' ? 'merged' : 'open';
  }

  function entries(rows, weight) {
    const result = [];
    for (const row of rows) {
      const area = weight === 'gain' && row.excluded ? 0 : row[weight];
      if (Number.isFinite(area) && area > 0) result.push({ row, area });
    }
    return result;
  }

  function visible(r, v) {
    return r.x < v.x + v.w && v.x < r.x + r.w && r.y < v.y + v.h && v.y < r.y + r.h;
  }

  function painter(ctx, colors) {
    const matrix = ctx.getTransform();
    const px = 1 / Math.abs(matrix.a), py = 1 / Math.abs(matrix.d);
    const palette = new Map();
    function fill(row, r) {
      if (colors.highlightGaps) {
        ctx.fillStyle = row.gain > 0 && !row.excluded ? colors.exact : colors.excluded;
        ctx.fillRect(r.x, r.y, r.w, r.h);
        return;
      }
      if (colors.byWorkflow) {
        ctx.fillStyle = colors[row.workflowKey];
        ctx.fillRect(r.x, r.y, r.w, r.h);
        return;
      }
      const kind = row.kind;
      const tone = Math.round((row.score ?? 0) * 100);
      const key = kind + tone;
      let color = palette.get(key);
      if (!color) {
        color = kind === 'exact' ? colors.exact : kind === 'reloc' ? colors.reloc
          : kind === 'unresolved' ? colors.unresolved : kind === 'excluded' ? colors.skipped
          : kind === 'unmeasured' ? colors.open : `hsl(${(360 - tone * 1.7) % 360}, 75%, 55%)`;
        palette.set(key, color);
      }
      ctx.fillStyle = color;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    function frame(r, color, thickness) {
      const dx = Math.min(r.w, thickness * px), dy = Math.min(r.h, thickness * py);
      ctx.fillStyle = color;
      ctx.fillRect(r.x, r.y, r.w, dy);
      ctx.fillRect(r.x, r.y + r.h - dy, r.w, dy);
      ctx.fillRect(r.x, r.y, dx, r.h);
      ctx.fillRect(r.x + r.w - dx, r.y, dx, r.h);
    }
    return { px, py, fill, frame };
  }

  // Recursively bisect an ordered sequence near its weighted median. An internal
  // rectangle is also a pruning node for both painting and pointer lookup.
  function partition(items, rect, leaf) {
    if (!items.length) return null;
    const prefix = [0];
    for (const item of items) prefix.push(prefix[prefix.length - 1] + item.area);
    function split(lo, hi, r) {
      if (hi - lo === 1) return leaf(items[lo], r);
      const target = (prefix[lo] + prefix[hi]) / 2;
      let a = lo + 1, b = hi - 1;
      while (a < b) {
        const m = Math.floor((a + b) / 2);
        if (prefix[m] < target) a = m + 1; else b = m;
      }
      if (a > lo + 1 && target - prefix[a - 1] < prefix[a] - target) a--;
      const fraction = (prefix[a] - prefix[lo]) / (prefix[hi] - prefix[lo]);
      const { x, y, w, h } = r, horizontal = w >= h;
      const d = fraction * (horizontal ? w : h);
      r.horizontal = horizontal;
      r.cut = horizontal ? x + d : y + d;
      r.left = split(lo, a, horizontal ? { x, y, w: d, h } : { x, y, w, h: d });
      r.right = split(a, hi, horizontal ? { x: x + d, y, w: w - d, h } : { x, y: y + d, w, h: h - d });
      return r;
    }
    return split(0, items.length, rect);
  }

  function source(rows, groups, width, height, weight) {
    const byId = new Map(), fileBounds = new Map(), boxes = [], owners = new Map();
    const bins = groups.map(({ node }) => ({ node, items: [], area: 0 }));
    for (const bin of bins) for (const row of bin.node.rows) owners.set(row, bin);
    const remainder = { items: [], area: 0 };
    for (const item of entries(rows, weight)) {
      const bin = owners.get(item.row) || remainder;
      bin.items.push(item);
      bin.area += item.area;
    }
    bins.push(remainder);
    const root = partition(bins.filter(bin => bin.area), { x: 0, y: 0, w: width, h: height }, (bin, r) => {
      if (bin.node) boxes.push({ node: bin.node, ...r });
      // Keep a file's functions together even when their original addresses interleave with
      // another file's. Size both levels by the same weight; no padding or synthetic cells.
      const files = new Map();
      for (const item of bin.items) {
        const unit = item.row.unit ?? null;
        let file = files.get(unit);
        if (!file) files.set(unit, file = { unit, items: [], area: 0 });
        file.items.push(item);
        file.area += item.area;
      }
      return partition([...files.values()], r, (file, fileRect) => {
        if (file.unit !== null) fileBounds.set(file.unit, fileRect);
        return partition(file.items, fileRect, (item, cell) => {
          cell.row = item.row;
          byId.set(item.row.id, cell);
          return cell;
        });
      });
    });
    function at(cell, x, y) {
      while (!cell.row) cell = (cell.horizontal ? x : y) < cell.cut ? cell.left : cell.right;
      return cell.row;
    }
    return {
      groups: boxes,
      hit: (x, y) => root && x >= 0 && y >= 0 && x < width && y < height ? at(root, x, y) : null,
      rectFor: id => byId.get(id) || null,
      fileRectFor: unit => fileBounds.get(unit) || null,
      paint(ctx, viewport, colors, selectedId) {
        const p = painter(ctx, colors);
        function draw(r) {
          if (!r || !visible(r, viewport)) return;
          if (r.row || (r.w <= p.px && r.h <= p.py)) {
            p.fill(r.row || at(r, r.x + r.w / 2, r.y + r.h / 2), r);
            if (r.w > 5 * p.px && r.h > 5 * p.py) p.frame(r, colors.border, 0.7);
          } else { draw(r.left); draw(r.right); }
        }
        draw(root);
        const selected = byId.get(selectedId);
        if (selected) p.frame(selected, colors.foreground, 2);
      },
    };
  }

  // A Hilbert quadrant carries its origin and two signed, orthogonal edge vectors.
  // Traversal and point lookup use the same child orientations, including at seams.
  function child(q, i) {
    const a = q.a / 2, b = q.b / 2, c = q.c / 2, d = q.d / 2;
    if (i === 0) return { x: q.x, y: q.y, a: c, b: d, c: a, d: b };
    if (i === 1) return { x: q.x + c, y: q.y + d, a, b, c, d };
    if (i === 2) return { x: q.x + a + c, y: q.y + b + d, a, b, c, d };
    return { x: q.x + 2 * a + c, y: q.y + 2 * b + d, a: -c, b: -d, c: -a, d: -b };
  }
  function box(q) {
    return { x: q.x + Math.min(0, q.a, q.c), y: q.y + Math.min(0, q.b, q.d),
      w: Math.abs(q.a + q.c), h: Math.abs(q.b + q.d) };
  }

  function address(rows, width, height, weight) {
    const list = entries(rows, weight), byId = new Map();
    const sum = list.reduce((acc, item) => acc + item.area, 0);
    // Reserve one discrete cell per positive row; distribute the rest by cumulative
    // weight. Extra precision keeps even fractional estimated gains inspectable.
    let capacity = 1;
    while (capacity < Math.max(sum, list.length * 4096) && capacity < 4 ** 25) capacity *= 4;
    let used = 0, end = 0;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      item.start = end;
      used += item.area;
      item.end = end = i + 1 + Math.round((used / sum) * (capacity - list.length));
      byId.set(item.row.id, item);
    }
    const root = { x: 0, y: 0, a: width, b: 0, c: 0, d: height };
    function lookup(index) {
      let a = 0, b = list.length - 1;
      while (a < b) {
        const m = Math.floor((a + b) / 2);
        if (index < list[m].end) b = m; else a = m + 1;
      }
      return list[a];
    }
    // Visit the maximal complete quadrants covering exactly one function interval.
    function visit(item, q, start, count, fn) {
      if (item.start <= start && start + count <= item.end) { fn(box(q)); return; }
      const step = count / 4;
      for (let i = 0; i < 4; i++) {
        const sub = start + i * step;
        if (sub < item.end && item.start < sub + step) visit(item, child(q, i), sub, step, fn);
      }
    }
    function rectFor(id) {
      const item = byId.get(id);
      if (!item) return null;
      if (!item.bounds) {
        let x = width, y = height, right = 0, bottom = 0;
        visit(item, root, 0, capacity, r => {
          if (!item.label || r.w > item.label.w) item.label = r;
          x = Math.min(x, r.x); y = Math.min(y, r.y);
          right = Math.max(right, r.x + r.w); bottom = Math.max(bottom, r.y + r.h);
        });
        item.bounds = { x, y, w: right - x, h: bottom - y };
      }
      return item.bounds;
    }
    return {
      groups: [], rectFor,
      labelRectFor(id) { return rectFor(id) && byId.get(id).label; },
      hit(x, y) {
        if (!list.length || x < 0 || x >= width || y < 0 || y >= height) return null;
        let q = root, start = 0, count = capacity;
        while (true) {
          const item = lookup(start);
          if (item.end >= start + count) return item.row;
          count /= 4;
          let found = false;
          for (let i = 0; i < 4; i++) {
            const next = child(q, i), r = box(next);
            if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) {
              q = next; start += i * count; found = true; break;
            }
          }
          if (!found) return null;
        }
      },
      paint(ctx, viewport, colors, selectedId) {
        if (!list.length) return;
        const p = painter(ctx, colors);
        function draw(q, start, count) {
          const r = box(q);
          if (!visible(r, viewport)) return;
          const item = lookup(start);
          if (start + count <= item.end) p.fill(item.row, r);
          else if (r.w <= p.px && r.h <= p.py) p.fill(lookup(start + Math.floor(count / 2)).row, r);
          else for (let i = 0; i < 4; i++) draw(child(q, i), start + i * count / 4, count / 4);
        }
        draw(root, 0, capacity);
        const selected = byId.get(selectedId);
        if (selected) visit(selected, root, 0, capacity, r => {
          if (visible(r, viewport)) { ctx.fillStyle = colors.foreground; ctx.fillRect(r.x, r.y, r.w, r.h); }
        });
      },
    };
  }
  return { source, address, workflowKey, workflowLabels };
})();
