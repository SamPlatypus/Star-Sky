// Device orientation tracking.
//
// Sources (whatever the browser offers):
//   * relative orientation  - 'deviceorientation' (gyro based, smooth, arbitrary yaw)
//   * absolute orientation  - 'deviceorientationabsolute' (Android: magnetic north)
//   * compass heading       - webkitCompassHeading on iOS 'deviceorientation' events
//
// The smooth relative stream drives the view; the yaw offset that turns it into
// a true-north frame is estimated from the noisier absolute readings with a slow
// low-pass filter (a complementary filter on heading). Magnetic declination and
// the user's manual calibration are applied on top.
import { DEG, RAD, wrapPi } from '../astro/math.js';

// ---- quaternion helpers ([w, x, y, z]); q rotates device-frame vectors into the ENU frame.
function qMul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
const qAxis = (ax, ay, az, ang) => { const s = Math.sin(ang / 2); return [Math.cos(ang / 2), ax * s, ay * s, az * s]; };
/** W3C DeviceOrientation: R = Rz(alpha) Rx(beta) Ry(gamma). */
export function quatFromEuler(alpha, beta, gamma) {
  return qMul(qMul(qAxis(0, 0, 1, alpha * DEG), qAxis(1, 0, 0, beta * DEG)), qAxis(0, 1, 0, gamma * DEG));
}
function qNormalize(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
function qSlerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) { d = -d; bb = [-b[0], -b[1], -b[2], -b[3]]; }
  if (d > 0.9995) return qNormalize(a.map((x, i) => x + (bb[i] - x) * t));
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((x, i) => x * wa + bb[i] * wb);
}
function qAngle(a, b) {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, d));
}
/** Rotate vector v by quaternion q. */
export function qRotate(q, v) {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}
/** Heading (radians, clockwise from north) of the device's back (-z axis) for orientation q. */
function backHeading(q) {
  const f = qRotate(q, [0, 0, -1]);
  return { h: Math.atan2(f[0], f[1]), horiz: Math.hypot(f[0], f[1]) };
}
function topHeading(q) {
  const f = qRotate(q, [0, 1, 0]);
  return { h: Math.atan2(f[0], f[1]), horiz: Math.hypot(f[0], f[1]) };
}
/** Yaw (rotation about up, radians, counter-clockwise) that maps q_from onto q_to's heading. */
function yawBetween(qFrom, qTo) {
  const a = backHeading(qFrom), b = backHeading(qTo);
  if (a.horiz > 0.35 && b.horiz > 0.35) return wrapPi(a.h - b.h);
  const c = topHeading(qFrom), d = topHeading(qTo);
  return wrapPi(c.h - d.h);
}

export function screenAngle() {
  const o = typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number'
    ? screen.orientation.angle
    : typeof window !== 'undefined' && typeof window.orientation === 'number' ? window.orientation : 0;
  return ((o % 360) + 360) % 360;
}

export class OrientationTracker {
  constructor() {
    this.active = false;
    this.qRel = null;        // latest relative orientation
    this.qAbs = null;        // latest absolute (magnetic) orientation, Android
    this.yaw = null;         // filtered yaw offset rel -> magnetic north (radians)
    this.yawTime = 0;
    this.lastEventTime = 0;
    this.headingSource = 'none'; // 'absolute' | 'compass' | 'none'
    this.declination = 0;    // degrees east
    this.calibration = 0;    // degrees, user's manual heading correction
    this.smoothed = null;
    this.target = null;
    this.onChange = null;
    this._onRel = (e) => this._relative(e);
    this._onAbs = (e) => this._absolute(e);
  }

  static isSupported() {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  /** Must be called from a user gesture on iOS. Resolves to { ok, reason }. */
  async start() {
    if (!OrientationTracker.isSupported()) return { ok: false, reason: 'unsupported' };
    const DOE = window.DeviceOrientationEvent;
    if (typeof DOE.requestPermission === 'function') {
      try {
        const res = await DOE.requestPermission();
        if (res !== 'granted') return { ok: false, reason: 'denied' };
      } catch {
        return { ok: false, reason: 'denied' };
      }
    }
    this.active = true;
    this.qRel = this.qAbs = this.yaw = this.smoothed = this.target = null;
    this.headingSource = 'none';
    window.addEventListener('deviceorientation', this._onRel);
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', this._onAbs);
    // Wait briefly for the first event so callers can fall back if the device has no sensors.
    const ok = await new Promise((resolve) => {
      const t0 = performance.now();
      const check = () => {
        if (this.target) resolve(true);
        else if (performance.now() - t0 > 1500) resolve(false);
        else setTimeout(check, 50);
      };
      check();
    });
    if (!ok) { this.stop(); return { ok: false, reason: 'no-data' }; }
    return { ok: true };
  }

  stop() {
    this.active = false;
    window.removeEventListener('deviceorientation', this._onRel);
    window.removeEventListener('deviceorientationabsolute', this._onAbs);
  }

  /** Re-attach listeners after the page was hidden (permission was already granted). */
  resume() {
    if (this.active) return;
    this.active = true;
    this.smoothed = null;
    window.addEventListener('deviceorientation', this._onRel);
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', this._onAbs);
  }

  /** True when the latest reading differs visibly from what was last drawn. */
  needsFrame() {
    if (!this.target || !this.smoothed) return true;
    return qAngle(this.smoothed, this.target) > 0.02 * DEG;
  }

  _relative(e) {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    const q = quatFromEuler(e.alpha, e.beta, e.gamma);
    if (e.absolute === true && !('ondeviceorientationabsolute' in window)) {
      // Some browsers deliver absolute data on the plain event.
      this._absoluteQuat(q, performance.now());
    }
    this.qRel = q;
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      const acc = typeof e.webkitCompassAccuracy === 'number' ? e.webkitCompassAccuracy : 0;
      if (acc >= 0 && acc <= 50) this._compass(q, e.webkitCompassHeading * DEG);
    }
    this._emit();
  }

  _absolute(e) {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    this._absoluteQuat(quatFromEuler(e.alpha, e.beta, e.gamma), performance.now());
    if (!this.qRel) this._emit();
  }

  _absoluteQuat(q, now) {
    this.qAbs = q;
    this.headingSource = 'absolute';
    if (this.qRel) this._feedYaw(yawBetween(this.qRel, q), now, 1);
  }

  // iOS: webkitCompassHeading is the heading of the top edge when the phone lies
  // flat and of the back camera when it is held up. Trust it where that is
  // unambiguous: lying flat, or held up where both directions agree.
  _compass(qRel, heading) {
    const back = backHeading(qRel), top = topHeading(qRel);
    const flat = back.horiz < 0.3 && top.horiz > 0.9;
    const agree = back.horiz > 0.3 && top.horiz > 0.3 && Math.abs(wrapPi(back.h - top.h)) < 35 * DEG;
    const first = this.yaw === null && back.horiz > 0.3;
    if (!flat && !agree && !first) return;
    this.headingSource = 'compass';
    const relHeading = flat ? top.h : back.h;
    this._feedYaw(wrapPi(relHeading - heading), performance.now(), 1);
  }

  _feedYaw(measured, now, weight) {
    if (this.yaw === null) { this.yaw = measured; this.yawTime = now; return; }
    const dt = Math.min(1, Math.max(0, (now - this.yawTime) / 1000));
    this.yawTime = now;
    // Time constant ~2.5 s, faster when far off (e.g. after a magnetic disturbance clears).
    const err = wrapPi(measured - this.yaw);
    const tau = Math.abs(err) > 20 * DEG ? 0.6 : 2.5;
    this.yaw = wrapPi(this.yaw + err * (1 - Math.exp(-dt / tau)) * weight);
  }

  _emit() {
    this.lastEventTime = performance.now();
    let q = this.qRel || this.qAbs;
    if (!q) return;
    let yaw = 0;
    if (this.qRel && this.yaw !== null) yaw = this.yaw;
    else if (!this.qRel) yaw = 0; // absolute stream used directly
    // magnetic -> true north, then the user's correction (both as heading, clockwise).
    yaw -= (this.declination + this.calibration) * DEG;
    q = qMul(qAxis(0, 0, 1, yaw), q);
    this.target = q;
    this.onChange?.();
  }

  get hasHeading() {
    return this.headingSource !== 'none' || !this.qRel;
  }

  /**
   * Advance the smoothing filter by dt seconds. Returns { q, moving } where
   * moving means the filtered value has not yet settled.
   */
  step(dt, fast = false) {
    if (!this.target) return null;
    if (!this.smoothed) this.smoothed = this.target;
    const ang = qAngle(this.smoothed, this.target);
    // Adaptive: light smoothing for small jitter, quick catch-up for real motion.
    const base = fast ? 0.035 : 0.07;
    const tau = ang > 4 * DEG ? base * 0.5 : ang < 0.15 * DEG ? base * 2.5 : base;
    const t = 1 - Math.exp(-Math.max(dt, 0.001) / tau);
    this.smoothed = qSlerp(this.smoothed, this.target, t);
    return { q: this.smoothed, moving: ang > 0.02 * DEG };
  }

  /**
   * Camera basis in ENU for the current (smoothed) orientation, accounting for
   * the screen rotation: right, up and forward (out of the back of the phone).
   */
  basis(q) {
    const th = screenAngle() * DEG;
    const c = Math.cos(th), s = Math.sin(th);
    return {
      right: qRotate(q, [c, -s, 0]),
      up: qRotate(q, [s, c, 0]),
      forward: qRotate(q, [0, 0, -1]),
    };
  }

  /** Current heading (degrees) of the view direction, for "set north" calibration. */
  headingOf(q) {
    const f = qRotate(q, [0, 0, -1]);
    return ((Math.atan2(f[0], f[1]) * RAD) + 360) % 360;
  }
}
