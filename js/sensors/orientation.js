// Device orientation tracking.
//
// Which events steer the view, in order of preference:
//   1. 'deviceorientationabsolute'  Android Chrome and Android WebView. alpha is
//                                   measured from magnetic north.
//   2. 'deviceorientation'          The fallback, used while no absolute reading
//                                   has arrived:
//        - flagged absolute (older WebViews, Firefox): used exactly like (1)
//        - with webkitCompassHeading (iOS): turned to the compass heading
//        - otherwise relative: tilt is right, but north is wherever the phone
//          happened to point, until the user sets it with Calibrate.
//
// alpha / beta / gamma become a rotation (W3C: Rz(alpha) Rx(beta) Ry(gamma) in an
// East-North-Up frame); the view looks out of the back of the phone with the top
// of the screen as "up". Magnetic declination and the user's calibration are
// applied on top as a turn about the vertical.
//
// start() only asks for permission where the platform has one and attaches the
// listeners. Nothing here gives up on a timer: whenever readings arrive, at once
// or minutes later, the view follows them.
import { DEG, RAD, wrapPi } from '../astro/math.js';

const ABSOLUTE_EVENT = 'deviceorientationabsolute';
const RELATIVE_EVENT = 'deviceorientation';
// Right after start, relative readings wait this long for the absolute stream to
// speak first, so the sky does not flash at an arbitrary heading. Listening goes on.
const ABSOLUTE_HEAD_START_MS = 300;

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
/** W3C DeviceOrientation: R = Rz(alpha) Rx(beta) Ry(gamma), angles in degrees. */
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

/**
 * Where the back of the phone points for W3C orientation angles (degrees):
 * azimuth clockwise from the alpha = 0 reference (north for absolute events)
 * and altitude above the horizon, both in degrees.
 */
export function viewDirection(alpha, beta, gamma) {
  const f = qRotate(quatFromEuler(alpha, beta, gamma), [0, 0, -1]);
  return {
    az: ((Math.atan2(f[0], f[1]) * RAD) + 360) % 360,
    alt: Math.asin(Math.max(-1, Math.min(1, f[2]))) * RAD,
  };
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

/**
 * Rotation for one orientation event, or null when it carries no usable angles.
 * A missing alpha is fatal for an absolute reading (it is the whole point of
 * one) but tolerable in the fallback stream, where tilt alone is still useful.
 */
function quatFromEvent(e, needAlpha) {
  const { alpha, beta, gamma } = e;
  if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return null;
  if (!Number.isFinite(alpha)) return needAlpha ? null : quatFromEuler(0, beta, gamma);
  return quatFromEuler(alpha, beta, gamma);
}

/** iOS compass heading in radians, or null when absent or flagged unreliable. */
function compassHeading(e) {
  const h = e.webkitCompassHeading;
  if (typeof h !== 'number' || !(h >= 0)) return null;
  const acc = e.webkitCompassAccuracy;
  if (typeof acc === 'number' && (acc < 0 || acc > 50)) return null;
  return h * DEG;
}

export function screenAngle() {
  const o = typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number'
    ? screen.orientation.angle
    : typeof window !== 'undefined' && typeof window.orientation === 'number' ? window.orientation : 0;
  return ((o % 360) + 360) % 360;
}

export class OrientationTracker {
  /**
   * env.target: the object the events arrive on (default: window).
   * env.now: clock in milliseconds (default: performance.now).
   * Both exist so the tracker can be tested without a browser.
   */
  constructor(env = {}) {
    this.win = env.target ?? (typeof window !== 'undefined' ? window : null);
    this.clock = env.now ?? (() => performance.now());
    this.active = false;
    this.source = 'none';        // readings in use: 'absolute' | 'relative' | 'none'
    this.headingSource = 'none'; // what fixes north: 'absolute' | 'compass' | 'none'
    this.absSupported = false;   // the browser knows the absolute event
    this.absSeen = false;        // the absolute stream has delivered real readings
    this.absMissing = false;     // the browser reported that it has no absolute sensor
    this.startTime = 0;
    this.raw = null;             // latest orientation, before declination and calibration
    this.target = null;          // latest orientation in the true-north frame
    this.smoothed = null;        // filtered orientation that gets drawn
    this.yaw = null;             // iOS: filtered turn from the relative frame to compass north
    this.yawTime = 0;
    this._declination = 0;       // degrees east
    this._calibration = 0;       // degrees, the user's heading correction
    this.onChange = null;
    this._onAbs = (e) => this._absolute(e);
    this._onRel = (e) => this._relative(e);
  }

  static isSupported(win = typeof window !== 'undefined' ? window : null) {
    return !!win && 'DeviceOrientationEvent' in win;
  }

  get declination() { return this._declination; }
  set declination(deg) { this._declination = Number.isFinite(deg) ? deg : 0; this._retarget(); }
  get calibration() { return this._calibration; }
  set calibration(deg) { this._calibration = Number.isFinite(deg) ? deg : 0; this._retarget(); }

  /** Readings have arrived since start(). */
  get hasData() { return this.target !== null; }
  /** The readings are tied to north (compass or absolute sensor) rather than to an arbitrary start. */
  get hasHeading() { return this.headingSource !== 'none'; }

  /**
   * Start listening. Call it from a tap: iOS only shows its motion prompt then.
   * Resolves as soon as the listeners are attached, without waiting for data,
   * to { ok: true } or { ok: false, reason: 'unsupported' | 'denied' | 'insecure' }.
   */
  async start() {
    const win = this.win;
    if (!OrientationTracker.isSupported(win)) return { ok: false, reason: 'unsupported' };
    if (this.active) return { ok: true };
    const DOE = win.DeviceOrientationEvent;
    if (typeof DOE.requestPermission === 'function') {
      // iOS 13+ and recent Chromium. Only a clear "denied" stops us; if the call
      // itself fails we still listen, since Android delivers events regardless.
      let state = 'unknown';
      try { state = await DOE.requestPermission(); } catch { /* keep going */ }
      if (state === 'denied') return { ok: false, reason: win.isSecureContext === false ? 'insecure' : 'denied' };
    }
    this.source = this.headingSource = 'none';
    this.raw = this.target = this.smoothed = this.yaw = null;
    this.absSeen = this.absMissing = false;
    this._listen();
    return { ok: true };
  }

  _listen() {
    if (this.active) return;
    this.active = true;
    this.startTime = this.clock();
    this.absSupported = `on${ABSOLUTE_EVENT}` in this.win;
    this.win.addEventListener(ABSOLUTE_EVENT, this._onAbs);
    this.win.addEventListener(RELATIVE_EVENT, this._onRel);
  }

  stop() {
    this.active = false;
    if (!this.win) return;
    this.win.removeEventListener(ABSOLUTE_EVENT, this._onAbs);
    this.win.removeEventListener(RELATIVE_EVENT, this._onRel);
  }

  /** Listen again after stop() without a new permission request (the app came back to the foreground). */
  resume() {
    if (this.active || !OrientationTracker.isSupported(this.win)) return;
    this.smoothed = null;
    this._listen();
  }

  /** Make the next step() jump straight to the latest reading instead of easing towards it. */
  snap() {
    this.smoothed = null;
  }

  /** True when the latest reading differs visibly from what was last drawn. */
  needsFrame() {
    if (!this.target || !this.smoothed) return true;
    return qAngle(this.smoothed, this.target) > 0.02 * DEG;
  }

  // 'deviceorientationabsolute': the preferred stream.
  _absolute(e) {
    const q = quatFromEvent(e, true);
    if (!q) {
      // Chrome sends a single all-null event when there is no absolute sensor
      // (no magnetometer): let the fallback stream take over.
      this.absSeen = false;
      this.absMissing = true;
      return;
    }
    this.absSeen = true;
    this._use(q, 'absolute', 'absolute');
  }

  // 'deviceorientation': the fallback stream.
  _relative(e) {
    if (this.absSeen) return; // the absolute stream owns the view
    const flaggedAbsolute = e.absolute === true;
    const q = quatFromEvent(e, flaggedAbsolute);
    if (!q) return;
    if (flaggedAbsolute) { this._use(q, 'absolute', 'absolute'); return; }
    const now = this.clock();
    if (this.absSupported && !this.absMissing && now - this.startTime < ABSOLUTE_HEAD_START_MS) return;
    const heading = compassHeading(e);
    if (heading !== null) this._compass(q, heading, now);
    if (this.yaw !== null) this._use(qMul(qAxis(0, 0, 1, this.yaw), q), 'relative', 'compass');
    else this._use(q, 'relative', 'none');
  }

  // iOS: webkitCompassHeading is the heading of the top edge when the phone lies
  // flat and of the back camera when it is held up. Trust it where that is
  // unambiguous: lying flat, or held up where both directions agree.
  _compass(qRel, heading, now) {
    const back = backHeading(qRel), top = topHeading(qRel);
    const flat = back.horiz < 0.3 && top.horiz > 0.9;
    const agree = back.horiz > 0.3 && top.horiz > 0.3 && Math.abs(wrapPi(back.h - top.h)) < 35 * DEG;
    const first = this.yaw === null && back.horiz > 0.3;
    if (!flat && !agree && !first) return;
    const measured = wrapPi((flat ? top.h : back.h) - heading);
    if (this.yaw === null) { this.yaw = measured; this.yawTime = now; return; }
    // Low-pass the compass: about 2.5 s, faster when far off (a disturbance has cleared).
    const dt = Math.min(1, Math.max(0, (now - this.yawTime) / 1000));
    this.yawTime = now;
    const err = wrapPi(measured - this.yaw);
    const tau = Math.abs(err) > 20 * DEG ? 0.6 : 2.5;
    this.yaw = wrapPi(this.yaw + err * (1 - Math.exp(-dt / tau)));
  }

  _use(q, source, headingSource) {
    // The first fix of north: jump there instead of swinging across the sky.
    if (headingSource !== 'none' && this.headingSource === 'none') this.smoothed = null;
    this.source = source;
    this.headingSource = headingSource;
    this.raw = q;
    this._retarget();
  }

  _retarget() {
    if (!this.raw) return;
    // Magnetic north to true north, then the user's correction. Without any
    // heading reference only the user's correction means something.
    const declination = this.headingSource === 'none' ? 0 : this._declination;
    const yaw = -(declination + this._calibration) * DEG;
    this.target = qMul(qAxis(0, 0, 1, yaw), this.raw);
    this.onChange?.();
  }

  /**
   * Advance the smoothing filter by dt seconds. Returns { q, moving } where
   * moving means the filtered value has not yet settled, or null before any data.
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
   * Camera basis in ENU for orientation q, accounting for how the screen is
   * rotated: right, up and forward (out of the back of the phone).
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

  /** Heading (degrees) of the view direction for orientation q, for "this is north". */
  headingOf(q) {
    const f = qRotate(q, [0, 0, -1]);
    return ((Math.atan2(f[0], f[1]) * RAD) + 360) % 360;
  }
}
