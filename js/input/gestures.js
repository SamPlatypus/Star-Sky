// Pointer-event gestures: one-finger drag, two-finger pinch, tap, mouse wheel.
// Velocity is tracked so the app can apply inertia after a fling.

const TAP_MOVE = 10;    // px
const TAP_TIME = 350;   // ms

export class Gestures {
  /**
   * handlers: { dragStart(), drag(dx, dy), dragEnd(vx, vy) [px/ms], pinchStart(), pinch(scale, cx, cy),
   *             pinchEnd(), tap(x, y), wheel(factor, x, y) }
   */
  constructor(el, handlers) {
    this.el = el;
    this.h = handlers;
    this.pointers = new Map();
    this.mode = null;
    this.samples = [];
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._move(e));
    el.addEventListener('pointerup', (e) => this._up(e));
    el.addEventListener('pointercancel', (e) => this._up(e, true));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = Math.exp((e.deltaY * (e.deltaMode === 1 ? 16 : 1)) / 600);
      this.h.wheel?.(factor, e.offsetX, e.offsetY);
    }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _pos(e) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const p = this._pos(e);
    this.pointers.set(e.pointerId, { ...p, x0: p.x, y0: p.y, t0: performance.now() });
    if (this.pointers.size === 1) {
      this.mode = 'pending';
      this.start = { ...p, t: performance.now() };
      this.samples = [{ x: p.x, y: p.y, t: performance.now() }];
    } else if (this.pointers.size === 2) {
      if (this.mode === 'drag') this.h.dragEnd?.(0, 0);
      this.mode = 'pinch';
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      this.h.pinchStart?.();
    }
  }

  _move(e) {
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) return;
    const p = this._pos(e);
    const dx = p.x - ptr.x, dy = p.y - ptr.y;
    ptr.x = p.x; ptr.y = p.y;
    if (this.mode === 'pending') {
      if (Math.hypot(p.x - this.start.x, p.y - this.start.y) > TAP_MOVE) {
        this.mode = 'drag';
        this.h.dragStart?.();
        this.h.drag?.(p.x - this.start.x, p.y - this.start.y);
      }
    } else if (this.mode === 'drag') {
      this.h.drag?.(dx, dy);
    } else if (this.mode === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      this.h.pinch?.(d / this.pinchDist, (a.x + b.x) / 2, (a.y + b.y) / 2);
      this.pinchDist = d;
    }
    const now = performance.now();
    this.samples.push({ x: p.x, y: p.y, t: now });
    while (this.samples.length > 2 && now - this.samples[0].t > 100) this.samples.shift();
  }

  _up(e, cancelled = false) {
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) return;
    this.pointers.delete(e.pointerId);
    const now = performance.now();
    if (this.mode === 'pending' && !cancelled && now - this.start.t < TAP_TIME) {
      this.h.tap?.(ptr.x, ptr.y);
      this.mode = null;
    } else if (this.mode === 'drag') {
      let vx = 0, vy = 0;
      const s0 = this.samples[0], s1 = this.samples[this.samples.length - 1];
      if (s0 && s1 && s1.t - s0.t > 10 && now - s1.t < 60) {
        vx = (s1.x - s0.x) / (s1.t - s0.t);
        vy = (s1.y - s0.y) / (s1.t - s0.t);
      }
      this.h.dragEnd?.(cancelled ? 0 : vx, cancelled ? 0 : vy);
      this.mode = null;
    } else if (this.mode === 'pinch') {
      if (this.pointers.size < 2) {
        this.h.pinchEnd?.();
        this.mode = this.pointers.size === 1 ? 'pinch-rest' : null;
      }
    } else if (this.pointers.size === 0) {
      this.mode = null;
    }
    if (this.pointers.size === 0) this.mode = null;
  }
}
