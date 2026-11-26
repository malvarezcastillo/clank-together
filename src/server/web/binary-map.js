// The atlas camera and selection are local UI state, separate from the public map URL.
const binaryMap = (() => {
  const MAX_ZOOM = 2 ** 22;
  const ZOOM_STEP = 1.5;
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const theme = window.matchMedia('(prefers-color-scheme: light)');
  const paletteDefaults = {
    exact: '#f5b301', unresolved: '#b8a064', work: '#64707d', reloc: '#968579', excluded: '#353b43',
    identical: '#f5b301', confirmed: '#3b8fd4', skipped: '#5b6470', flight: '#b46cf0',
    claimed: '#3fbf8f', returned: '#e2554a', open: '#2a2f36', merged: '#8d96a1',
    background: '#121418', border: '#121418', foreground: '#e4e6e9', muted: '#9aa1aa',
  };
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const nameOf = row => row.name || row.id;
  const address = n => Number.isFinite(n) ? `0x${n.toString(16)}` : 'Address unknown';
  const hasArea = (row, weight) => Number.isFinite(row[weight]) && row[weight] > 0 && (weight !== 'gain' || !row.excluded);

  let canvas, ctx, tooltip, outline, zoomIn, zoomOut, fitButton, zoomLevel, position, observer, resolution;
  let options, geometry, colors, first, last, selected, indexes;
  let active = false, width = 0, height = 0, dpr = 0, scale = 1, x = 0, y = 0;
  let frame = 0, needsPaint = false, pointer, press, lastTap, hoverTarget;
  let outlinedRect = null;
  const groupHeaders = [];

  function bind() {
    canvas = document.getElementById('binary-canvas');
    ctx = canvas.getContext('2d', { alpha: false });
    tooltip = document.getElementById('binary-tooltip');
    outline = document.getElementById('binary-file-outline');
    zoomIn = document.getElementById('binary-zoom-in');
    zoomOut = document.getElementById('binary-zoom-out');
    fitButton = document.getElementById('binary-fit');
    zoomLevel = document.getElementById('binary-zoom-level');
    position = document.getElementById('binary-map-position');
    observer = new ResizeObserver(resize);
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'application');
    tooltip.setAttribute('aria-hidden', 'true');
    zoomIn.addEventListener('click', () => zoom(1));
    zoomOut.addEventListener('click', () => zoom(-1));
    fitButton.addEventListener('click', fit);
    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointercancel', cancelPress);
    canvas.addEventListener('lostpointercapture', cancelPress);
    canvas.addEventListener('pointerleave', clearHover);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('keydown', keyDown);
  }

  function readColors() {
    const style = getComputedStyle(canvas);
    colors = {};
    for (const [key, fallback] of Object.entries(paletteDefaults)) {
      colors[key] = style.getPropertyValue(`--binary-${key}`).trim() || fallback;
    }
    colors.highlightGaps = Boolean(options.highlightGaps);
    colors.byWorkflow = Boolean(options.byWorkflow);
    schedule(true);
  }

  function show(next) {
    if (!canvas) bind();
    const reset = !options || next.scope !== options.scope || next.version !== options.version || next.filter !== options.filter ||
      next.layout !== options.layout || next.weight !== options.weight;
    const changed = reset || next.rows !== options.rows;
    if (changed || (next.layout === 'source' && next.groups !== options.groups)) geometry = null;
    if (next.byWorkflow !== options?.byWorkflow) hoverTarget = null;
    options = next;
    if (changed) {
      const previousId = reset ? null : selected?.id;
      if (reset) { scale = 1; x = y = 0; }
      first = last = selected = null;
      indexes = new Map();
      for (const [i, row] of next.rows.entries()) {
        indexes.set(row.id, i);
        if (row.id === previousId) selected = row;
        if (hasArea(row, next.weight)) {
          first ??= row;
          last = row;
        }
      }
      clearHover();
      cancelPress();
      const layout = next.layout === 'source' ? 'Source-grouped function map' : 'Function atlas in original address order';
      const sizing = next.weight === 'gain' ? 'estimated remaining work' : 'original size';
      canvas.setAttribute('aria-label', `${layout}, sized by ${sizing}`);
      if (!first) { scale = 1; x = y = 0; }
      next.onSelect(selected);
    }
    if (!active) {
      active = true;
      observer.observe(canvas);
      window.addEventListener('resize', resize);
      theme.addEventListener('change', readColors);
    }
    resize();
    readColors();
  }

  function hide() {
    if (!active) return;
    active = false;
    observer.disconnect();
    window.removeEventListener('resize', resize);
    theme.removeEventListener('change', readColors);
    resolution?.removeEventListener('change', resize);
    resolution = null;
    cancelAnimationFrame(frame);
    frame = 0;
    cancelPress();
    clearHover();
  }

  function resize() {
    if (!active) return;
    const nextDpr = window.devicePixelRatio || 1;
    if (!resolution || nextDpr !== dpr) {
      resolution?.removeEventListener('change', resize);
      resolution = window.matchMedia(`(resolution: ${nextDpr}dppx)`);
      resolution.addEventListener('change', resize);
      dpr = nextDpr;
    }
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    if (width !== bounds.width || height !== bounds.height) {
      x = width ? x * bounds.width / width : 0;
      y = height ? y * bounds.height / height : 0;
      width = bounds.width;
      height = bounds.height;
      geometry = null;
    }
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    if (!geometry && first) geometry = options.layout === 'source'
      ? binaryGeometry.source(options.rows, options.groups, width, height, options.weight)
      : binaryGeometry.address(options.rows, width, height, options.weight);
    schedule(true);
  }

  function schedule(repaint = false) {
    if (!active) return;
    needsPaint ||= repaint;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (needsPaint) {
        needsPaint = false;
        paint();
      }
      if (pointer) renderHover();
    });
  }

  function emptyMessage() {
    if (!options.rows.length) return 'No functions match these filters.';
    if (options.weight === 'gain') return 'No known positive remaining work. Switch to Original size or browse the function list.';
    return 'No functions with a known positive original size. Browse the function list instead.';
  }

  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function paint() {
    const message = first ? '' : emptyMessage();
    zoomIn.disabled = !first || scale >= MAX_ZOOM;
    zoomOut.disabled = fitButton.disabled = scale === 1;
    setText(zoomLevel, `${number.format(scale)}×`);
    setText(position, message || (selected ? `${address(selected.addr)} · ${geometry?.rectFor(selected.id) ? 'Selected' : 'No area in this weighting'}`
      : scale > 1 ? 'Drag to pan · Fit map to see the whole view'
      : first === last ? address(first.addr) : `${address(first.addr)} – ${address(last.addr)}`));
    if (!ctx || !width || !height) return;

    const px = canvas.width / width, py = canvas.height / height;
    ctx.setTransform(px, 0, 0, py, 0, 0);
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);
    groupHeaders.length = 0;
    outlinedRect = null; // Geometry or the camera may have changed under a stationary pointer.
    if (!geometry) {
      ctx.font = '14px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillStyle = colors.muted;
      ctx.fillText(message, width / 2, height / 2, Math.max(1, width - 24));
      return;
    }

    ctx.setTransform(px * scale, 0, 0, py * scale, -x * px * scale, -y * py * scale);
    geometry.paint(ctx, { x, y, w: width / scale, h: height / scale }, colors, selected?.id);
    ctx.setTransform(px, 0, 0, py, 0, 0);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    drawLabels();
  }

  function labelText(text, width) {
    if (ctx.measureText(text).width <= width) return text;
    let low = 0, high = text.length;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (ctx.measureText(`${text.slice(0, mid)}…`).width <= width) low = mid;
      else high = mid - 1;
    }
    return `${text.slice(0, low)}…`;
  }

  function drawLabels() {
    ctx.font = '600 12px system-ui, sans-serif';
    for (const r of geometry.groups) {
      const left = (r.x - x) * scale + 3, top = (r.y - y) * scale + 3;
      const available = Math.min(r.w * scale - 6, width - left - 3, 194);
      if (left < 0 || top < 0 || top + 21 > height || available < 48 || r.h * scale < 42) continue;
      const text = labelText(`${r.node.name} ›`, available - 12);
      const w = Math.ceil(ctx.measureText(text).width) + 12;
      ctx.fillStyle = colors.background;
      ctx.fillRect(left, top, w, 19);
      ctx.fillStyle = colors.foreground;
      ctx.fillText(text, left + 6, top + 9.5);
      groupHeaders.push({ node: r.node, rect: r, left, top, w, h: 19 });
    }
    if (scale === 1) return;

    // Probe a bounded screen-space grid, not all functions, even on the full binary.
    // A Hilbert label fits inside one owned quadrant, not the interval's bounding box.
    const seen = new Set();
    let count = 0;
    ctx.font = '11px ui-monospace, monospace';
    function drawRow(row) {
      if (!row || seen.has(row.id)) return;
      seen.add(row.id);
      const r = geometry.labelRectFor ? geometry.labelRectFor(row.id) : geometry.rectFor(row.id);
      if (!r) return;
      const left = Math.max(0, (r.x - x) * scale), top = Math.max(0, (r.y - y) * scale);
      const right = Math.min(width, (r.x + r.w - x) * scale), bottom = Math.min(height, (r.y + r.h - y) * scale);
      const available = Math.min(right - left - 8, 215);
      if (available < 44 || bottom - top < 25) return;
      const text = labelText(nameOf(row), available - 10);
      const w = Math.ceil(ctx.measureText(text).width) + 10;
      const lx = (left + right - w) / 2, ly = (top + bottom - 17) / 2;
      if (groupHeaders.some(g => lx < g.left + g.w && g.left < lx + w && ly < g.top + g.h && g.top < ly + 17)) return;
      ctx.fillStyle = colors.background;
      ctx.fillRect(lx, ly, w, 17);
      ctx.fillStyle = colors.foreground;
      ctx.fillText(text, lx + 5, ly + 8.5);
      count++;
    }
    drawRow(selected);
    const dx = Math.max(48, width / 20), dy = Math.max(25, height / 20);
    for (let sy = dy / 2; sy < height && count < 48; sy += dy) {
      for (let sx = dx / 2; sx < width && count < 48; sx += dx) drawRow(hit(sx, sy));
    }
  }

  function camera(nextScale, left, top) {
    scale = nextScale;
    x = clamp(left, 0, width - width / scale);
    y = clamp(top, 0, height - height / scale);
    schedule(true);
  }

  function zoomAt(factor, sx, sy) {
    if (!active || !geometry) return false;
    const next = clamp(scale * factor, 1, MAX_ZOOM);
    if (next === scale) return false;
    camera(next, x + sx / scale - sx / next, y + sy / scale - sy / next);
    return true;
  }

  function zoom(delta) {
    clearHover();
    zoomAt(ZOOM_STEP ** delta, width / 2, height / 2);
  }

  function fit() {
    clearHover();
    camera(1, 0, 0);
  }

  function select(row) {
    if (selected === row) return;
    selected = row;
    schedule(true);
    options.onSelect(row);
  }

  function focusRow(row) {
    if (!active || !row || !indexes.has(row.id)) return;
    row = options.rows[indexes.get(row.id)];
    clearHover();
    const r = geometry?.rectFor(row.id);
    if (r) {
      // Fill most of the view, but keep needle-thin treemap cells thick enough to inspect.
      let next = 0.72 * Math.min(width / r.w, height / r.h);
      if (options.layout === 'source') next = Math.max(next, Math.min(80, width / 3) / r.w, Math.min(30, height / 3) / r.h);
      next = clamp(next, 1, MAX_ZOOM);
      camera(next, r.x + (r.w - width / next) / 2, r.y + (r.h - height / next) / 2);
    }
    select(row);
  }

  function point(event) {
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  function hit(sx, sy) {
    return geometry?.hit(x + sx / scale, y + sy / scale) ?? null;
  }

  function headerAt(sx, sy) {
    return !needsPaint && groupHeaders.find(g => sx >= g.left && sx < g.left + g.w && sy >= g.top && sy < g.top + g.h);
  }

  function outlineSourceRect(r) {
    if (!r) {
      if (outline) outline.hidden = true;
      outlinedRect = null;
      return;
    }
    if (r === outlinedRect) return;
    outlinedRect = r;
    // Allow the stroke to run off screen, rather than drawing a false file edge at the
    // viewport boundary. Cap offscreen coordinates so deep zoom never exceeds CSS limits.
    const left = Math.max(-4, (r.x - x) * scale), top = Math.max(-4, (r.y - y) * scale);
    const right = Math.min(width + 4, (r.x + r.w - x) * scale), bottom = Math.min(height + 4, (r.y + r.h - y) * scale);
    Object.assign(outline.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
    outline.hidden = false;
  }

  function clearHover() {
    pointer = hoverTarget = null;
    outlineSourceRect(null);
    if (tooltip) tooltip.hidden = true;
    if (canvas && !press) canvas.style.cursor = '';
  }

  function renderHover() {
    const { x: sx, y: sy } = point(pointer);
    const header = headerAt(sx, sy), row = header ? null : hit(sx, sy);
    const target = header?.node ?? row;
    if (!target) return clearHover();
    outlineSourceRect(options.layout === 'source' ? header?.rect ?? geometry.fileRectFor(row?.unit) : null);
    if (hoverTarget !== target) {
      hoverTarget = target;
      tooltip.textContent = row
        ? `${nameOf(row)}\n${options.layout === 'source' ? `${row.unit ?? 'No source file assigned'}\n` : ''}${address(row.addr)} · ${Number.isFinite(row.size) && row.size >= 0 ? `${number.format(row.size)} B original` : 'Original size unknown'}\n${options.describe(row)}`
        : `Open ${header.node.path}`;
    }
    canvas.style.cursor = header ? 'pointer' : scale > 1 ? 'grab' : 'crosshair';
    tooltip.hidden = false;
    const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
    const left = sx + w + 16 <= width ? sx + 12 : sx - w - 12;
    const top = sy + h + 20 <= height ? sy + 16 : sy - h - 12;
    tooltip.style.left = `${clamp(left, 4, width - w - 4)}px`;
    tooltip.style.top = `${clamp(top, 4, height - h - 4)}px`;
  }

  function pointerDown(event) {
    if (!active || !geometry || !event.isPrimary || event.button !== 0) return;
    canvas.focus({ preventScroll: true });
    clearHover();
    press = { id: event.pointerId, ...point(event), left: x, top: y, dragged: false };
    canvas.setPointerCapture(event.pointerId);
  }

  function pointerMove(event) {
    if (!active || !event.isPrimary) return;
    if (!press) {
      if (event.pointerType !== 'touch') {
        pointer = event;
        schedule();
      }
      return;
    }
    if (event.pointerId !== press.id) return;
    const p = point(event), dx = p.x - press.x, dy = p.y - press.y;
    press.dragged ||= Math.hypot(dx, dy) > (event.pointerType === 'touch' ? 8 : 4);
    if (press.dragged && scale > 1) {
      canvas.style.cursor = 'grabbing';
      camera(scale, press.left - dx / scale, press.top - dy / scale);
    }
  }

  function cancelPress(event) {
    if (event && event.pointerId !== press?.id) return;
    const id = press?.id;
    press = lastTap = null;
    if (id != null && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    clearHover();
  }

  function pointerUp(event) {
    if (event.pointerId !== press?.id) return;
    const start = press;
    press = null;
    const p = point(event);
    if (start.dragged || Math.hypot(p.x - start.x, p.y - start.y) > (event.pointerType === 'touch' ? 8 : 4) ||
      p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) return cancelPress();
    const header = headerAt(p.x, p.y);
    if (header) {
      lastTap = null;
      options.drill(header.node);
      return;
    }
    const row = hit(p.x, p.y);
    if (row && lastTap?.row === row && lastTap.type === event.pointerType && event.timeStamp - lastTap.time <= 400 &&
      Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 16) {
      lastTap = null;
      focusRow(row);
    } else {
      lastTap = row ? { ...p, row, time: event.timeStamp, type: event.pointerType } : null;
      select(row);
    }
  }

  function wheel(event) {
    if (press) return;
    const { x: sx, y: sy } = point(event);
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
    const factor = Math.exp(clamp(-event.deltaY * unit * 0.003, -2, 2));
    if (zoomAt(factor, sx, sy)) {
      event.preventDefault();
      clearHover();
    }
  }

  function stepSelection(direction) {
    const { rows, weight } = options;
    let i = selected ? indexes.get(selected.id) : direction > 0 ? -1 : rows.length;
    for (i += direction; i >= 0 && i < rows.length; i += direction) {
      const row = rows[i];
      if (!hasArea(row, weight)) continue;
      const r = geometry?.labelRectFor?.(row.id) ?? geometry?.rectFor(row.id);
      if (r && scale > 1) {
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        if (cx < x || cx >= x + width / scale || cy < y || cy >= y + height / scale) {
          camera(scale, cx - width / (2 * scale), cy - height / (2 * scale));
        }
      }
      select(row);
      break;
    }
  }

  function keyDown(event) {
    if (!active || event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case 'ArrowLeft': case 'ArrowUp': clearHover(); stepSelection(-1); break;
      case 'ArrowRight': case 'ArrowDown': clearHover(); stepSelection(1); break;
      case '+': case '=': zoom(1); break;
      case '−': case '-': zoom(-1); break;
      case 'Enter': if (selected) options.navigate(selected); break;
      case 'Escape': select(null); fit(); break;
      default: return;
    }
    event.preventDefault();
  }

  return { show, hide, resize, zoom, fit, focusRow };
})();
