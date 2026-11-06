// 2D canvas overlay: names, cardinal points, selection marker and the
// "this way" pointer to an off-screen target. Uses a coarse occupancy grid to
// avoid overlapping labels.

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const PALETTES = {
  normal: {
    planet: '#f1d9a8', sun: '#ffe7a3', moon: '#e9e9e3', star: '#a8bdd4', con: 'rgba(122,150,182,0.9)',
    cardinal: '#c3ced9', north: '#ff7a6b', selected: '#ffd27a', dim: 0.45, horizon: '#c3ced9',
  },
  night: {
    planet: '#e0402e', sun: '#ff5a40', moon: '#e04a36', star: '#b0281c', con: 'rgba(150,30,20,0.95)',
    cardinal: '#c4301f', north: '#ff4a30', selected: '#ff6040', dim: 0.5, horizon: '#c4301f',
  },
};

const CELL = 4;

export class LabelLayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.widthCache = new Map();
    this.grid = null;
  }

  resize(cssWidth, cssHeight, dpr) {
    const w = Math.round(cssWidth * dpr), h = Math.round(cssHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.dpr = w / cssWidth;
    this.cols = Math.ceil(cssWidth / CELL) + 1;
    this.rows = Math.ceil(cssHeight / CELL) + 1;
    this.grid = new Uint8Array(this.cols * this.rows);
  }

  _measure(text, font) {
    const key = font + '|' + text;
    let w = this.widthCache.get(key);
    if (w === undefined) {
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      if (this.widthCache.size > 2000) this.widthCache.clear();
      this.widthCache.set(key, w);
    }
    return w;
  }

  _free(x0, y0, x1, y1) {
    if (x0 < 2 || y0 < 2 || x1 > this.cssWidth - 2 || y1 > this.cssHeight - 2) return false;
    const c0 = Math.max(0, Math.floor(x0 / CELL)), c1 = Math.min(this.cols - 1, Math.floor(x1 / CELL));
    const r0 = Math.max(0, Math.floor(y0 / CELL)), r1 = Math.min(this.rows - 1, Math.floor(y1 / CELL));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (this.grid[r * this.cols + c]) return false;
    return true;
  }

  _occupy(x0, y0, x1, y1) {
    const c0 = Math.max(0, Math.floor(x0 / CELL)), c1 = Math.min(this.cols - 1, Math.floor(x1 / CELL));
    const r0 = Math.max(0, Math.floor(y0 / CELL)), r1 = Math.min(this.rows - 1, Math.floor(y1 / CELL));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.grid[r * this.cols + c] = 1;
  }

  /**
   * items: [{ x, y, text, kind, r (object radius px), alpha, force, center }]
   * kinds: planet | sun | moon | star | con | cardinal | north
   * extras: { selection: { x, y, r, onScreen, angle, text }, night }
   */
  draw(items, extras) {
    const ctx = this.ctx, pal = extras.night ? PALETTES.night : PALETTES.normal;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    this.grid.fill(0);
    ctx.textBaseline = 'middle';

    // Reserve space around the points of forced labels first (planets etc.).
    for (const it of items) if (it.force && it.r) this._occupy(it.x - it.r, it.y - it.r, it.x + it.r, it.y + it.r);

    const sorted = items.slice().sort((a, b) => (b.force ? 1 : 0) - (a.force ? 1 : 0) || (b.priority || 0) - (a.priority || 0));
    for (const it of sorted) {
      const big = it.kind === 'planet' || it.kind === 'sun' || it.kind === 'moon';
      const size = it.kind === 'con' ? 10.5 : it.kind === 'cardinal' || it.kind === 'north' ? (it.major ? 15 : 11.5) : big ? 13 : 11.5;
      const weight = it.kind === 'con' ? 500 : big || it.kind === 'north' || it.major ? 600 : 400;
      const font = `${weight} ${size}px ${FONT}`;
      const text = it.kind === 'con' ? it.text.toUpperCase() : it.text;
      const spacing = it.kind === 'con' ? 1.5 : 0;
      const w = this._measure(text, font) + spacing * text.length;
      const h = size + 2;
      let x, y = it.y, align;
      const gap = (it.r || 2) + 4;
      const candidates = it.center || it.kind === 'con' || it.kind === 'cardinal' || it.kind === 'north'
        ? [[it.x - w / 2, it.y]]
        : [[it.x + gap, it.y], [it.x - gap - w, it.y], [it.x - w / 2, it.y - gap - h / 2], [it.x - w / 2, it.y + gap + h / 2]];
      let placed = null;
      for (const [cx, cy] of candidates) {
        if (this._free(cx - 2, cy - h / 2, cx + w + 2, cy + h / 2)) { placed = [cx, cy]; break; }
      }
      if (!placed && it.force) {
        // Forced labels (planets, cardinal points) still appear; keep them on screen.
        const [cx, cy] = candidates[0];
        placed = [Math.min(Math.max(cx, 4), this.cssWidth - w - 4), cy];
      }
      if (!placed) continue;
      [x, y] = placed;
      align = 'left';
      this._occupy(x - 2, y - h / 2, x + w + 2, y + h / 2);
      ctx.font = font;
      ctx.textAlign = align;
      ctx.globalAlpha = it.alpha ?? 1;
      ctx.fillStyle = pal[it.kind] || pal.star;
      if (spacing) try { ctx.letterSpacing = `${spacing}px`; } catch { /* unsupported */ }
      if (extras.outline || big) {
        // Dark halo keeps labels legible over the daylight sky, glows and the camera image.
        ctx.strokeStyle = 'rgba(0,0,0,0.65)';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.strokeText(text, x, y);
      }
      ctx.fillText(text, x, y);
      if (spacing) try { ctx.letterSpacing = '0px'; } catch { /* unsupported */ }
    }
    ctx.globalAlpha = 1;

    const sel = extras.selection;
    if (sel) this._drawSelection(sel, pal);
  }

  _drawSelection(sel, pal) {
    const ctx = this.ctx;
    ctx.strokeStyle = pal.selected;
    ctx.fillStyle = pal.selected;
    ctx.lineWidth = 1.5;
    if (sel.onScreen) {
      const r = Math.max(sel.r + 6, 12);
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const a0 = (i * Math.PI) / 2 + 0.35, a1 = ((i + 1) * Math.PI) / 2 - 0.35;
        ctx.moveTo(sel.x + r * Math.cos(a0), sel.y + r * Math.sin(a0));
        ctx.arc(sel.x, sel.y, r, a0, a1);
      }
      ctx.stroke();
      return;
    }
    // Off-screen: arrow at the screen edge pointing towards the object.
    const w = this.cssWidth, h = this.cssHeight, m = 34;
    const cx = w / 2, cy = h / 2;
    const dx = Math.cos(sel.angle), dy = Math.sin(sel.angle);
    const tx = dx !== 0 ? ((dx > 0 ? w - m : m) - cx) / dx : Infinity;
    const ty = dy !== 0 ? ((dy > 0 ? h - m - 70 : m + 40) - cy) / dy : Infinity;
    const t = Math.min(Math.abs(tx), Math.abs(ty));
    const ax = cx + dx * t, ay = cy + dy * t;
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(sel.angle);
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(-8, -10);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-8, 10);
    ctx.closePath();
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.font = `600 12px ${FONT}`;
    ctx.textAlign = dx > 0.3 ? 'right' : dx < -0.3 ? 'left' : 'center';
    ctx.textBaseline = 'middle';
    const lx = ax - dx * 26, ly = ay - dy * 26;
    ctx.fillText(sel.text, lx, ly);
  }
}
