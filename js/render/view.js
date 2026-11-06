// View state and the JS side of the sky projection. The GLSL in shaders.js
// implements exactly the same maths; labels and hit-testing use this file.
//
// Camera basis vectors (right, up, forward) are unit vectors in the local ENU
// frame. A direction v maps to camera coordinates c = (v.r, v.u, v.f) and to
// the screen with  p = c.xy * k / (a + c.z)  where a = 1 gives a stereographic
// projection (virtual sky) and a = 0 a perspective one (camera overlay).
import { DEG, clamp, cross, dot, mulVec, transpose } from '../astro/math.js';
import { refractEnu, refraction } from '../astro/coords.js';

export class View {
  constructor() {
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.fov = 70 * DEG; // across the shorter screen side
    this.projection = 'stereographic';
    this.right = [1, 0, 0];
    this.up = [0, 0, 1];
    this.forward = [0, 1, 0];
    this.eqToHor = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.horToEq = this.eqToHor;
    this.update();
  }

  get a() {
    return this.projection === 'stereographic' ? 1 : 0;
  }

  setSize(width, height, dpr) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = dpr;
    this.update();
  }

  setEquatorialToHorizontal(m) {
    this.eqToHor = m;
    this.horToEq = transpose(m);
  }

  /** Camera looking at azimuth `az` (from North through East) and altitude `alt`, horizon level. */
  setFromAltAz(az, alt) {
    const ca = Math.cos(alt), sa = Math.sin(alt), cz = Math.cos(az), sz = Math.sin(az);
    this.forward = [sz * ca, cz * ca, sa];
    this.right = [cz, -sz, 0];
    this.up = cross(this.right, this.forward);
  }

  setBasis(right, up, forward) {
    this.right = right;
    this.up = up;
    this.forward = forward;
  }

  /** Recompute projection constants after a change of size, FOV or projection. */
  update() {
    const half = this.fov / 2;
    const a = this.a;
    this.k = ((Math.min(this.width, this.height) / 2) * (a + Math.cos(half))) / Math.sin(half);
    const cornerAngle = this.angleAtRadius(Math.hypot(this.width, this.height) / 2);
    this.cullCos = Math.cos(Math.min(cornerAngle + 6 * DEG, a ? 170 * DEG : 88 * DEG));
  }

  /** Angle from the view centre of a point at screen radius r (CSS px). */
  angleAtRadius(r) {
    return this.a ? 2 * Math.atan(r / this.k) : Math.atan(r / this.k);
  }

  /** Screen pixels per radian at the view centre. */
  get pxPerRadian() {
    return this.k / (this.a + 1);
  }

  /** Apparent ENU direction (with refraction) of an equatorial-of-date unit vector. */
  eqToEnu(eq) {
    return refractEnu(mulVec(this.eqToHor, eq));
  }

  /** Inverse of eqToEnu (removes refraction iteratively). */
  enuToEq(enu) {
    const horiz = Math.hypot(enu[0], enu[1]);
    let v = enu;
    if (horiz > 1e-9) {
      const app = Math.atan2(enu[2], horiz);
      let alt = app;
      for (let i = 0; i < 4; i++) alt = app - refraction(alt);
      const k = Math.cos(alt) / horiz;
      v = [enu[0] * k, enu[1] * k, Math.sin(alt)];
    }
    return mulVec(this.horToEq, v);
  }

  /**
   * Project an ENU direction to CSS pixels. Writes { x, y, zc } into out and
   * returns true when the point is inside the culling cone (it may still be
   * slightly off-screen).
   */
  project(v, out) {
    const xc = v[0] * this.right[0] + v[1] * this.right[1] + v[2] * this.right[2];
    const yc = v[0] * this.up[0] + v[1] * this.up[1] + v[2] * this.up[2];
    const zc = v[0] * this.forward[0] + v[1] * this.forward[1] + v[2] * this.forward[2];
    out.zc = zc;
    out.cx = xc;
    out.cy = yc;
    if (zc < this.cullCos) return false;
    const s = this.k / (this.a + zc);
    out.x = this.width / 2 + xc * s;
    out.y = this.height / 2 - yc * s;
    return true;
  }

  isOnScreen(p, margin = 0) {
    return p.x >= -margin && p.y >= -margin && p.x <= this.width + margin && p.y <= this.height + margin;
  }

  /** Apparent ENU direction under a screen point (CSS px). */
  unproject(x, y) {
    const X = (x - this.width / 2) / this.k;
    const Y = (this.height / 2 - y) / this.k;
    let c;
    if (this.a) {
      const r2 = X * X + Y * Y;
      c = [(2 * X) / (1 + r2), (2 * Y) / (1 + r2), (1 - r2) / (1 + r2)];
    } else {
      const l = Math.hypot(X, Y, 1);
      c = [X / l, Y / l, 1 / l];
    }
    const r = this.right, u = this.up, f = this.forward;
    return [
      c[0] * r[0] + c[1] * u[0] + c[2] * f[0],
      c[0] * r[1] + c[1] * u[1] + c[2] * f[1],
      c[0] * r[2] + c[1] * u[2] + c[2] * f[2],
    ];
  }

  /** Altitude/azimuth (radians) of the view centre. */
  centerAltAz() {
    const f = this.forward;
    const az = Math.atan2(f[0], f[1]);
    return { az: az < 0 ? az + 2 * Math.PI : az, alt: Math.asin(clamp(f[2], -1, 1)) };
  }

  /** Screen-space unit direction (y down) from one ENU direction towards another nearby one. */
  screenDirection(from, to) {
    const a = {}, b = {};
    const d = dot(from, to);
    const t = [to[0] - d * from[0], to[1] - d * from[1], to[2] - d * from[2]];
    const l = Math.hypot(t[0], t[1], t[2]);
    if (l < 1e-9 || !this.project(from, a)) return null;
    const eps = 1e-3 / l;
    const n = [from[0] + t[0] * eps, from[1] + t[1] * eps, from[2] + t[2] * eps];
    if (!this.project(n, b)) return null;
    const dx = b.x - a.x, dy = b.y - a.y, dl = Math.hypot(dx, dy) || 1;
    return { x: dx / dl, y: dy / dl };
  }
}
