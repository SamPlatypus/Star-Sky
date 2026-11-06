// Application controller: owns the view, the sky state for the current time
// and place, input handling, sensor / camera modes and the render loop.
// Rendering happens only on demand (input, sensor motion, clock ticks).
import { DEG, RAD, clamp, wrapPi } from './astro/math.js';
import { julianDay, ttFromUt, localSiderealTime, decimalYear } from './astro/time.js';
import { equatorialToHorizontalMatrix, meanObliquity, altAz, raDecFromVector } from './astro/coords.js';
import { solarSystem, bodyDirection, BODIES, BODY_IDS } from './astro/ephemeris.js';
import { riseSetTransit, H0 } from './astro/riseset.js';
import { magneticDeclination } from './astro/geomag.js';
import { loadCatalogs } from './catalog.js';
import { View } from './render/view.js';
import { SkyRenderer, buildLines, latitudeCircle, meridian, eclipticPolyline } from './render/renderer.js';
import { LabelLayer } from './render/labels.js';
import { Gestures } from './input/gestures.js';
import { OrientationTracker } from './sensors/orientation.js';
import { CameraFeed } from './sensors/camera.js';

const STORAGE_KEY = 'starsky.settings.v1';
const SIDEREAL_RATE = 360 / 86164.1; // deg per second

export const DEFAULTS = {
  magLimit: 5.5,
  showConLines: true,
  showConNames: true,
  showStarNames: true,
  showAltAzGrid: false,
  showEqGrid: false,
  showEcliptic: false,
  daylight: true,
  belowHorizon: true,
  night: false,
  keepAwake: false,
  location: null, // { lat, lon (degrees), name, source: 'gps' | 'city' | 'manual' | 'timezone' }
  calibration: 0, // degrees added to the sensor heading
  cameraFov: 66, // degrees across the camera's long side
  view: { az: 180, alt: 25, fov: 90 },
  onboarded: false,
};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (s && typeof s === 'object') return { ...DEFAULTS, ...s, view: { ...DEFAULTS.view, ...(s.view || {}) } };
  } catch { /* storage unavailable */ }
  return { ...DEFAULTS, view: { ...DEFAULTS.view } };
}

// Line colours [r, g, b, a] for normal and red-light modes.
const LINE_COLORS = {
  normal: {
    cons: [0.42, 0.56, 0.74, 0.55], selcon: [0.95, 0.78, 0.45, 0.85], altaz: [0.38, 0.62, 0.48, 0.32],
    eqgrid: [0.42, 0.52, 0.8, 0.3], ecliptic: [0.85, 0.66, 0.32, 0.5], horizon: [0.62, 0.7, 0.78, 0.75],
  },
  night: {
    cons: [0.55, 0.06, 0.04, 0.6], selcon: [0.95, 0.15, 0.08, 0.9], altaz: [0.45, 0.05, 0.03, 0.4],
    eqgrid: [0.45, 0.05, 0.03, 0.35], ecliptic: [0.6, 0.08, 0.04, 0.5], horizon: [0.7, 0.1, 0.06, 0.8],
  },
};

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export class App {
  constructor(el) {
    this.el = el; // { stage, sky, labels, video }
    this.listeners = {};
    this.settings = loadSettings();
    this.timeOffset = 0;
    this.mode = 'manual'; // 'manual' | 'sensor'
    this.cameraOn = false;
    this.calibrating = false;
    this.selection = null;
    this.az = this.settings.view.az * DEG;
    this.alt = this.settings.view.alt * DEG;
    this.fov = this.settings.view.fov * DEG;
    this.view = new View();
    this.anim = null;
    this.inertia = null;
    this.frameRequested = false;
    this.lastFrame = 0;
    this.riseSetCache = new Map();
  }

  on(name, fn) { (this.listeners[name] ||= []).push(fn); }
  emit(name, payload) { for (const fn of this.listeners[name] || []) fn(payload); }
  toast(msg) { this.emit('toast', msg); }

  saveSettings() {
    clearTimeout(this.saveTimer);
    this.settings.view = { az: this.az * RAD, alt: this.alt * RAD, fov: this.fov * RAD };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings)); } catch { /* ignore */ }
  }

  /** Persist a little later (coalesces bursts such as drags and pinches). */
  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveSettings(), 600);
  }

  async init() {
    this.renderer = new SkyRenderer(this.el.sky);
    this.renderer.onRestore = () => { this.buildGeometry(); this.requestFrame(); };
    this.labels = new LabelLayer(this.el.labels);
    this.tracker = new OrientationTracker();
    this.tracker.calibration = this.settings.calibration;
    this.tracker.onChange = () => {
      if (this.mode === 'sensor' && this.tracker.needsFrame()) this.requestFrame();
    };
    this.camera = new CameraFeed(this.el.video);

    const [{ stars, cons }, wmm] = await Promise.all([
      loadCatalogs('./data/'),
      fetch('./data/wmm.json').then((r) => r.json()).catch(() => null),
    ]);
    this.stars = stars;
    this.cons = cons;
    this.wmm = wmm;
    if (!this.settings.location) await this.guessLocation();
    this.applyLocation();
    this.buildSearchIndex();

    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));
    this.gestures = new Gestures(this.el.stage, {
      dragStart: () => this.onDragStart(),
      drag: (dx, dy) => this.onDrag(dx, dy),
      dragEnd: (vx, vy) => this.onDragEnd(vx, vy),
      pinch: (s) => this.onPinch(s),
      pinchEnd: () => this.saveSettings(),
      tap: (x, y) => this.onTap(x, y),
      wheel: (f) => this.zoomBy(1 / f),
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('visibilitychange', () => this.onVisibility());

    this.updateSky();
    this.buildGeometry();
    this.scheduleTick();
    this.requestFrame();
    this.emit('ready');
  }

  // ------------------------------------------------------------------ location & time
  get observer() {
    const l = this.settings.location;
    return { lat: l.lat * DEG, lon: l.lon * DEG, height: 0 };
  }

  async loadPlaces() {
    if (!this.places) {
      try { this.places = await fetch('./data/places.json').then((r) => r.json()); } catch { this.places = { cities: [], tz: {} }; }
    }
    return this.places;
  }

  async guessLocation() {
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* ignore */ }
    const places = await this.loadPlaces();
    const hit = places.tz[tz];
    if (hit) {
      const name = tz.split('/').pop().replace(/_/g, ' ');
      this.settings.location = { lat: hit[0], lon: hit[1], name, source: 'timezone' };
    } else {
      const lon = clamp(-new Date().getTimezoneOffset() / 4, -180, 180);
      this.settings.location = { lat: 40, lon, name: 'Approximate location', source: 'timezone' };
    }
  }

  applyLocation() {
    const l = this.settings.location;
    if (this.wmm) {
      try {
        this.tracker.declination = magneticDeclination(this.wmm, l.lat, l.lon, 0, decimalYear(julianDay(Date.now())));
      } catch { this.tracker.declination = 0; }
    }
    this.riseSetCache.clear();
  }

  setLocation(loc) {
    this.settings.location = loc;
    this.applyLocation();
    this.saveSettings();
    this.updateSky();
    this.emit('location', loc);
  }

  useDeviceLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { resolve({ ok: false, reason: 'unsupported' }); return; }
      navigator.geolocation.getCurrentPosition(async (pos) => {
        const lat = pos.coords.latitude, lon = pos.coords.longitude;
        const near = await this.nearestCity(lat, lon);
        this.setLocation({ lat: +lat.toFixed(4), lon: +lon.toFixed(4), name: near ? `Near ${near}` : 'My location', source: 'gps' });
        resolve({ ok: true });
      }, (err) => resolve({ ok: false, reason: err.code === 1 ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: false, timeout: 20000, maximumAge: 6 * 3600 * 1000 });
    });
  }

  async nearestCity(lat, lon) {
    const { cities } = await this.loadPlaces();
    let best = null, bestD = 0.5; // radians (~30 deg) - beyond that a name is not helpful
    const c1 = Math.cos(lat * DEG);
    for (const [name, , la, lo] of cities) {
      const d = Math.hypot((la - lat) * DEG, wrapPi((lo - lon) * DEG) * c1);
      if (d < bestD) { bestD = d; best = name; }
    }
    return bestD < 1.5 * DEG ? best : null;
  }

  get now() { return new Date(Date.now() + this.timeOffset); }
  get isLive() { return this.timeOffset === 0; }

  setTimeOffset(ms) {
    this.timeOffset = Math.abs(ms) < 1000 ? 0 : ms;
    this.updateSky();
    this.scheduleTick();
  }
  stepTime(ms) { this.setTimeOffset(this.timeOffset + ms); }
  setTime(date) { this.setTimeOffset(date.getTime() - Date.now()); }

  updateSky() {
    const date = this.now;
    const jdUT = julianDay(date);
    const jdTT = ttFromUt(jdUT);
    if (this.epochJd === undefined || Math.abs(jdTT - this.epochJd) > 180) this.setEpoch(jdTT);
    const obs = this.observer;
    const lst = localSiderealTime(jdUT, obs.lon);
    const eqToHor = equatorialToHorizontalMatrix(lst, obs.lat);
    this.view.setEquatorialToHorizontal(eqToHor);
    const bodies = solarSystem(jdUT, obs);
    const sunEnu = this.view.eqToEnu(bodies.sun.eq);
    this.sky = { date, jdUT, jdTT, lst, eqToHor, bodies, sunEnu, sunAlt: Math.asin(clamp(sunEnu[2], -1, 1)) };
    this.emit('time', date);
    if (this.selection) this.emit('select', this.describe(this.selection));
    this.requestFrame();
  }

  setEpoch(jdTT) {
    this.epochJd = jdTT;
    this.stars.updateEpoch(jdTT);
    this.cons.updateEpoch(jdTT);
    this.eps = meanObliquity(jdTT);
    if (this.renderer) this.buildGeometry();
  }

  buildGeometry() {
    if (!this.stars?.epochJd) return;
    const r = this.renderer;
    r.setStars(this.stars);
    const polys = [];
    for (const [, a, b] of this.cons.segments()) polys.push([this.stars.vector(a), this.stars.vector(b)]);
    r.setLines('cons', buildLines(polys));
    const eq = [];
    for (let d = -75; d <= 75; d += 15) eq.push(latitudeCircle(d * DEG));
    for (let h = 0; h < 24; h++) eq.push(meridian(h * 15 * DEG, -75 * DEG, 75 * DEG));
    r.setLines('eqgrid', buildLines(eq));
    r.setLines('ecliptic', buildLines([eclipticPolyline(this.eps)]));
    const hor = [];
    for (let a = -75; a <= 75; a += 15) if (a !== 0) hor.push(latitudeCircle(a * DEG));
    for (let z = 0; z < 360; z += 15) hor.push(meridian(z * DEG, -75 * DEG, 75 * DEG));
    r.setLines('altaz', buildLines(hor));
    r.setLines('horizon', buildLines([latitudeCircle(0, 1.5 * DEG)]));
    this.updateSelectedConstellation();
  }

  scheduleTick() {
    clearTimeout(this.tickTimer);
    if (document.hidden) return;
    const degPerPx = RAD / this.view.pxPerRadian;
    let ms = clamp(((0.5 * degPerPx) / SIDEREAL_RATE) * 1000, 1000, 30000);
    const toMinute = 60000 - ((Date.now() + this.timeOffset) % 60000) + 20;
    ms = Math.min(ms, toMinute);
    this.tickTimer = setTimeout(() => { this.updateSky(); this.scheduleTick(); }, ms);
  }

  // ------------------------------------------------------------------ settings
  set(key, value) {
    this.settings[key] = value;
    if (key === 'calibration') this.tracker.calibration = value;
    if (key === 'night') document.documentElement.classList.toggle('night', !!value);
    if (key === 'keepAwake') this.updateWakeLock();
    this.scheduleSave();
    this.emit('settings', this.settings);
    this.requestFrame();
  }

  // ------------------------------------------------------------------ modes
  async toggleMotion() {
    if (this.mode === 'sensor') {
      if (this.cameraOn) this.stopCamera();
      this.stopSensors();
      return;
    }
    await this.startSensors();
  }

  async startSensors() {
    const res = await this.tracker.start();
    if (!res.ok) {
      this.toast(res.reason === 'denied'
        ? 'Motion access was declined. Drag to look around.'
        : 'Motion sensors are not available here. Drag to look around.');
      this.emit('mode');
      return false;
    }
    this.mode = 'sensor';
    this.anim = this.inertia = null;
    clearTimeout(this.headingTimer);
    this.headingTimer = setTimeout(() => {
      if (this.mode === 'sensor' && !this.tracker.hasHeading && !this.settings.calibration) {
        this.toast('No compass reading — use Calibrate to set north.');
      }
    }, 2000);
    this.emit('mode');
    this.requestFrame();
    return true;
  }

  stopSensors() {
    this.tracker.stop();
    if (this.mode === 'sensor') {
      const c = this.view.centerAltAz();
      this.az = c.az;
      this.alt = clamp(c.alt, -Math.PI / 2, Math.PI / 2);
    }
    this.mode = 'manual';
    this.calibrating = false;
    this.emit('mode');
    this.requestFrame();
  }

  async toggleCamera() {
    if (this.cameraOn) { this.stopCamera(); return; }
    if (this.mode !== 'sensor') {
      const ok = await this.startSensors();
      if (!ok) { this.toast('The camera view needs motion sensors — showing the virtual sky.'); return; }
    }
    const res = await this.camera.start();
    if (!res.ok) {
      this.toast(res.reason === 'denied'
        ? 'Camera permission denied — showing the virtual sky.'
        : 'Camera unavailable — showing the virtual sky.');
      this.emit('mode');
      return;
    }
    this.cameraOn = true;
    for (const t of this.camera.stream.getVideoTracks()) {
      t.addEventListener('ended', () => {
        if (this.cameraOn) { this.stopCamera(); this.toast('Camera stopped — showing the virtual sky.'); }
      });
    }
    document.documentElement.classList.add('camera');
    this.el.video.addEventListener('loadedmetadata', () => this.requestFrame(), { once: true });
    if (!this.settings.cameraHintShown) {
      this.toast('Drag sideways to line the sky up with the view; pinch to match the camera’s zoom.');
      this.settings.cameraHintShown = true;
      this.scheduleSave();
    }
    this.emit('mode');
    this.requestFrame();
  }

  stopCamera() {
    this.camera.stop();
    this.cameraOn = false;
    document.documentElement.classList.remove('camera');
    this.emit('mode');
    this.requestFrame();
  }

  startCalibration() {
    this.calibrating = true;
    this.emit('mode');
  }
  endCalibration() {
    this.calibrating = false;
    this.saveSettings();
    this.emit('mode');
  }
  /** Treat the direction the phone points at as true north. */
  setNorthHere() {
    const q = this.tracker.smoothed;
    if (!q) return false;
    const heading = this.tracker.headingOf(q);
    this.set('calibration', ((this.settings.calibration - heading + 540) % 360) - 180);
    return true;
  }
  /** Current heading of the view centre in degrees (true north). */
  get heading() {
    return this.view.centerAltAz().az * RAD;
  }

  // ------------------------------------------------------------------ input
  onDragStart() {
    this.anim = this.inertia = null;
  }

  onDrag(dx, dy) {
    const radPerPx = 1 / this.view.pxPerRadian;
    if (this.mode === 'sensor' && (this.calibrating || this.cameraOn)) {
      this.set('calibration', this.settings.calibration - dx * radPerPx * RAD);
      return;
    }
    if (this.mode === 'sensor') this.stopSensors();
    const f = 1 / Math.max(Math.cos(this.alt), 0.5);
    this.az = (this.az - dx * radPerPx * f + 2 * Math.PI) % (2 * Math.PI);
    this.alt = clamp(this.alt + dy * radPerPx, -Math.PI / 2, Math.PI / 2);
    this.requestFrame();
  }

  onDragEnd(vx, vy) {
    if (this.mode !== 'manual') return;
    const radPerPx = 1 / this.view.pxPerRadian;
    const speed = Math.hypot(vx, vy);
    if (speed > 0.25) {
      const f = 1 / Math.max(Math.cos(this.alt), 0.5);
      this.inertia = { vaz: -vx * 1000 * radPerPx * f, valt: vy * 1000 * radPerPx };
      this.requestFrame();
    }
    this.scheduleSave();
  }

  onPinch(scale) {
    if (this.cameraOn) {
      this.set('cameraFov', clamp(this.settings.cameraFov / scale, 30, 110));
      return;
    }
    this.zoomBy(scale);
  }

  zoomBy(scale) {
    if (this.cameraOn) return;
    this.anim = null;
    this.fov = clamp(this.fov / scale, 2 * DEG, 120 * DEG);
    this.scheduleTick();
    this.requestFrame();
    this.scheduleSave();
  }

  onKey(e) {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const step = this.fov / 12;
    const keys = {
      ArrowLeft: () => { this.az -= step; }, ArrowRight: () => { this.az += step; },
      ArrowUp: () => { this.alt = clamp(this.alt + step, -Math.PI / 2, Math.PI / 2); },
      ArrowDown: () => { this.alt = clamp(this.alt - step, -Math.PI / 2, Math.PI / 2); },
      '+': () => this.zoomBy(1.25), '=': () => this.zoomBy(1.25), '-': () => this.zoomBy(0.8),
    };
    const fn = keys[e.key];
    if (!fn) return;
    if (this.mode === 'sensor' && e.key.startsWith('Arrow')) this.stopSensors();
    fn();
    this.az = (this.az + 2 * Math.PI) % (2 * Math.PI);
    e.preventDefault();
    this.requestFrame();
  }

  onTap(x, y) {
    if (this.calibrating) return;
    const hit = this.pick(x, y);
    if (hit) this.select(hit);
    else this.clearSelection();
  }

  onVisibility() {
    if (document.hidden) {
      clearTimeout(this.tickTimer);
      if (this.mode === 'sensor') this.tracker.stop();
      if (this.cameraOn) this.camera.stop();
      this.releaseWakeLock();
      this.saveSettings();
    } else {
      if (this.mode === 'sensor') this.tracker.resume();
      if (this.cameraOn) {
        this.camera.start().then((r) => { if (!r.ok) this.stopCamera(); });
      }
      this.updateSky();
      this.scheduleTick();
      this.updateWakeLock();
    }
  }

  async updateWakeLock() {
    if (!this.settings.keepAwake || document.hidden) { this.releaseWakeLock(); return; }
    if (this.wakeLock || !navigator.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
    } catch { this.wakeLock = null; }
  }
  releaseWakeLock() {
    if (this.wakeLock) { this.wakeLock.release().catch(() => {}); this.wakeLock = null; }
  }

  resize() {
    const rect = this.el.stage.getBoundingClientRect();
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    const dpr = window.devicePixelRatio || 1;
    // The sky is soft by nature: 1.5x device pixels is plenty and saves GPU fill
    // (battery) on high-density phones. Text stays sharper at up to 2x.
    this.renderer.resize(w, h, Math.min(dpr, 1.5));
    this.labels.resize(w, h, Math.min(dpr, 2));
    this.view.setSize(w, h, dpr);
    this.requestFrame();
  }

  // ------------------------------------------------------------------ rendering
  requestFrame() {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame((t) => this.frame(t));
  }

  frame(t) {
    this.frameRequested = false;
    if (!this.sky) return;
    const dt = this.lastFrame ? Math.min(0.1, (t - this.lastFrame) / 1000) : 1 / 60;
    this.lastFrame = t;
    let again = false;
    if (this.mode === 'sensor') {
      const s = this.tracker.step(dt, this.cameraOn);
      if (s) {
        const b = this.tracker.basis(s.q);
        this.view.setBasis(b.right, b.up, b.forward);
        again = s.moving;
      }
    } else {
      again = this.stepManual(dt, t);
      this.view.setFromAltAz(this.az, this.alt);
    }
    this.applyProjection();
    this.draw();
    this.emit('frame');
    if (again) this.requestFrame();
    else this.lastFrame = 0;
  }

  stepManual(dt, t) {
    if (this.anim) {
      const a = this.anim;
      const p = clamp((t - a.t0) / a.duration, 0, 1);
      const e = easeInOut(p);
      this.az = (a.az0 + wrapPi(a.az1 - a.az0) * e + 2 * Math.PI) % (2 * Math.PI);
      this.alt = a.alt0 + (a.alt1 - a.alt0) * e;
      this.fov = a.fov0 + (a.fov1 - a.fov0) * e;
      if (p >= 1) { this.anim = null; this.saveSettings(); this.scheduleTick(); }
      return p < 1;
    }
    if (this.inertia) {
      const it = this.inertia;
      this.az = (this.az + it.vaz * dt + 2 * Math.PI) % (2 * Math.PI);
      this.alt = clamp(this.alt + it.valt * dt, -Math.PI / 2, Math.PI / 2);
      const decay = Math.exp(-dt * 4.5);
      it.vaz *= decay;
      it.valt *= decay;
      if (Math.hypot(it.vaz, it.valt) < 0.004) { this.inertia = null; this.saveSettings(); }
      return !!this.inertia;
    }
    return false;
  }

  applyProjection() {
    const v = this.view;
    if (this.cameraOn) {
      v.projection = 'perspective';
      const W = v.width, H = v.height;
      const va = this.camera.aspect || W / H;
      const scale = Math.max(W / va, H); // CSS px per video unit (video = va x 1)
      const focal = ((Math.max(va, 1) / 2) / Math.tan((this.settings.cameraFov * DEG) / 2)) * scale;
      v.fov = 2 * Math.atan(Math.min(W, H) / 2 / focal);
    } else {
      v.projection = 'stereographic';
      v.fov = this.fov;
    }
    v.update();
  }

  /** Effective limiting magnitude and star brightness for the current sky. */
  starParams() {
    const s = this.settings;
    const day = this.dayFactor();
    const zoomBonus = clamp(Math.log2((60 * DEG) / this.view.fov) * 0.6, 0, 1.5);
    let lim = Math.min(s.magLimit + zoomBonus, 6.5);
    lim -= day * Math.max(0, lim - 1.5);
    if (this.cameraOn) lim = Math.min(lim, s.magLimit);
    return { lim, day, brightness: 1 - 0.7 * day };
  }

  dayFactor() {
    if (!this.settings.daylight || this.cameraOn) return 0;
    const h = this.sky.sunAlt * RAD;
    return Math.pow(clamp((h + 9) / 15, 0, 1), 1.6);
  }

  draw() {
    const v = this.view, s = this.settings, sky = this.sky;
    const pal = s.night ? LINE_COLORS.night : LINE_COLORS.normal;
    const { lim, day, brightness } = this.starParams();
    const cam = this.cameraOn;
    const below = s.belowHorizon ? 1 : 0;
    const boost = (c, k) => [c[0], c[1], c[2], Math.min(1, c[3] * k)];
    const lineK = cam ? 1.5 : 1;
    const lines = [];
    if (s.showAltAzGrid) lines.push({ name: 'altaz', frame: 'hor', color: boost(pal.altaz, lineK), width: 1, belowDim: below * 0.6 });
    if (s.showEqGrid) lines.push({ name: 'eqgrid', frame: 'eq', color: boost(pal.eqgrid, lineK), width: 1, belowDim: below * 0.6 });
    if (s.showEcliptic) lines.push({ name: 'ecliptic', frame: 'eq', color: boost(pal.ecliptic, lineK), width: 1.2, belowDim: below * 0.6 });
    if (s.showConLines) lines.push({ name: 'cons', frame: 'eq', color: boost(pal.cons, lineK * (1 - 0.5 * day)), width: 1.2, belowDim: below * 0.45 });
    if (this.selection?.type === 'con' && this.renderer.batches.selcon) {
      lines.push({ name: 'selcon', frame: 'eq', color: pal.selcon, width: 1.8, belowDim: below * 0.6 + (1 - below) * 0.2 });
    }
    lines.push({ name: 'horizon', frame: 'hor', color: pal.horizon, width: cam ? 1.6 : 1.3, belowDim: 1 });

    const starRadius = 0.62 * clamp(Math.pow((60 * DEG) / v.fov, 0.22), 0.85, 1.7);
    const bodies = this.bodyQuads(starRadius, lim, day, below);
    this.renderer.draw({
      view: v,
      background: !cam,
      ground: true,
      sunDir: sky.sunEnu,
      day,
      twilight: s.daylight && !cam ? 0.55 * Math.exp(-(((sky.sunAlt * RAD + 5) / 6) ** 2)) : 0,
      night: s.night,
      eqToHor: sky.eqToHor,
      lines,
      stars: {
        count: this.stars.countBrighterThan(lim + 0.35),
        magLimit: lim, sizeScale: starRadius, maxRadius: 5.5, belowDim: below * (cam ? 0.5 : 0.4), brightness,
      },
      bodies,
    });
    this.labels.draw(this.labelItems(lim, day, below), {
      night: s.night, outline: cam || day > 0.25, selection: this.selectionMarker(),
    });
  }

  /** Screen-space quads for the Sun, Moon and planets. */
  bodyQuads(starRadius, lim, day, below) {
    const v = this.view, sky = this.sky, out = [];
    const p = {};
    this.bodyScreen = {};
    const sunEnu = sky.sunEnu;
    const order = ['sun', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'moon'];
    for (const id of order) {
      const b = sky.bodies[id];
      if ((id === 'uranus' || id === 'neptune') && b.mag > lim + 0.3) continue;
      const enu = v.eqToEnu(b.eq);
      if (!v.project(enu, p)) continue;
      const isBelow = enu[2] < 0;
      if (isBelow && !below) continue;
      const angR = (b.diameter / 2) * v.pxPerRadian;
      let radius, glow, kind = 0, alpha = 1;
      const extra = {};
      if (id === 'sun') {
        radius = Math.max(angR, 7.5); glow = 3.2; kind = 2;
      } else if (id === 'moon') {
        radius = Math.max(angR, 8.5); glow = 1.7; kind = 1;
        extra.limb = v.screenDirection(enu, sunEnu);
        extra.cosPhase = Math.cos(b.phaseAngle);
        const pole = v.eqToEnu([0, -Math.sin(this.eps), Math.cos(this.eps)]);
        extra.north = v.screenDirection(enu, pole);
      } else {
        const rm = Math.min(starRadius * Math.pow(10, -0.12 * (b.mag - 6)), 6.5);
        radius = Math.max(angR, rm * 0.85, 1.6);
        glow = 2.4;
        if (b.mag > 1 && day > 0) alpha *= 1 - 0.7 * day;
      }
      if (isBelow) alpha *= 0.55;
      this.bodyScreen[id] = { x: p.x, y: p.y, r: radius, below: isBelow };
      out.push({ x: p.x, y: p.y, radius, glow, kind, alpha, color: BODIES[id].color, ...extra });
    }
    return out;
  }

  labelItems(lim, day, below) {
    const v = this.view, s = this.settings, items = [], p = {};
    const fovDeg = v.fov * RAD;
    // Solar system
    for (const [id, sp] of Object.entries(this.bodyScreen || {})) {
      if (!v.isOnScreen(sp, 40)) continue;
      items.push({ x: sp.x, y: sp.y, r: sp.r, text: BODIES[id].name, kind: id === 'sun' || id === 'moon' ? id : 'planet', alpha: sp.below ? 0.6 : 1, force: true, priority: 100 });
    }
    // Star names
    if (s.showStarNames) {
      const nameLim = Math.min(lim, clamp(1.1 + Math.log2(90 / fovDeg) * 1.1, 1.1, 5));
      const n = this.stars.countBrighterThan(nameLim);
      for (let i = 0; i < n; i++) {
        let text = this.stars.names.get(i);
        if (!text) {
          if (fovDeg > 25 || !this.stars.bayer.has(i)) continue;
          text = this.stars.designation(i, this.cons);
        }
        const enu = v.eqToEnu(this.stars.vector(i));
        if (enu[2] < 0 && !below) continue;
        if (!v.project(enu, p) || !v.isOnScreen(p, 20)) continue;
        const m = this.stars.mag[i];
        items.push({ x: p.x, y: p.y, r: 3, text, kind: 'star', alpha: (enu[2] < 0 ? 0.5 : 0.9) * (1 - 0.4 * day), priority: 50 - m });
      }
    }
    // Constellation names
    if (s.showConNames) {
      const maxRank = fovDeg > 100 ? 1 : fovDeg > 60 ? 2 : 3;
      for (const l of this.cons.labels) {
        if (this.cons.rank[l.con] > maxRank) continue;
        const enu = v.eqToEnu(l.vec);
        if (enu[2] < 0 && !below) continue;
        if (!v.project(enu, p) || !v.isOnScreen(p, 0)) continue;
        items.push({ x: p.x, y: p.y, text: this.cons.name[l.con], kind: 'con', center: true, alpha: (enu[2] < 0 ? 0.55 : 1) * (1 - 0.5 * day), priority: 10 - this.cons.rank[l.con] });
      }
    }
    // Cardinal points on the horizon
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    for (let i = 0; i < 8; i++) {
      const az = i * 45 * DEG;
      if (!v.project([Math.sin(az), Math.cos(az), 0], p) || !v.isOnScreen(p, 0)) continue;
      items.push({ x: p.x, y: p.y - 12, text: names[i], kind: i === 0 ? 'north' : 'cardinal', major: i % 2 === 0, center: true, force: true, priority: 90 });
    }
    return items;
  }

  // ------------------------------------------------------------------ selection
  objectEnu(item) {
    if (item.type === 'star') return this.view.eqToEnu(this.stars.vector(item.index));
    if (item.type === 'body') return this.view.eqToEnu(this.sky.bodies[item.id].eq);
    if (item.type === 'con') {
      const l = this.cons.labels.find((x) => x.con === item.index);
      return this.view.eqToEnu(l.vec);
    }
    return null;
  }

  objectName(item) {
    if (item.type === 'star') return this.stars.displayName(item.index, this.cons);
    if (item.type === 'body') return BODIES[item.id].name;
    return this.cons.name[item.index];
  }

  selectionMarker() {
    const sel = this.selection;
    if (!sel) return null;
    const p = {};
    const inCone = this.view.project(this.objectEnu(sel), p);
    const onScreen = inCone && this.view.isOnScreen(p, -10);
    const text = this.objectName(sel);
    if (!onScreen) return { onScreen: false, angle: Math.atan2(-p.cy, p.cx), text };
    if (sel.type === 'con') return null; // highlighted lines mark it
    const r = sel.type === 'body' ? (this.bodyScreen?.[sel.id]?.r ?? 6) : 4;
    return { x: p.x, y: p.y, r, onScreen: true, text };
  }

  /**
   * Object under a tap. Bright objects get a generous touch radius, faint stars
   * a small one, so tapping dark sky reports the constellation instead.
   */
  pick(x, y) {
    const v = this.view, p = {};
    let best = null, bestScore = 1;
    for (const [id, sp] of Object.entries(this.bodyScreen || {})) {
      const radius = Math.max(32, sp.r + 14);
      const score = Math.hypot(sp.x - x, sp.y - y) / radius - 0.3; // prefer the Moon and planets
      if (score < bestScore) { bestScore = score; best = { type: 'body', id }; }
    }
    const { lim } = this.starParams();
    const n = this.stars.countBrighterThan(lim);
    const below = this.settings.belowHorizon;
    for (let i = 0; i < n; i++) {
      const m = this.stars.mag[i];
      const radius = m < 1.5 ? 30 : m < 3 ? 24 : m < 4.5 ? 17 : 12;
      const enu = v.eqToEnu(this.stars.vector(i));
      if (enu[2] < 0 && !below) continue;
      if (!v.project(enu, p)) continue;
      const dx = p.x - x, dy = p.y - y;
      if (Math.abs(dx) > radius || Math.abs(dy) > radius) continue;
      const score = Math.hypot(dx, dy) / radius - 0.04 * (lim - m);
      if (score < bestScore) { bestScore = score; best = { type: 'star', index: i }; }
    }
    if (best) return best;
    // Empty sky: report the constellation under the finger.
    const eq = v.enuToEq(v.unproject(x, y));
    return { type: 'con', index: this.cons.constellationAt(eq) };
  }

  select(item) {
    this.selection = item;
    this.updateSelectedConstellation();
    this.emit('select', this.describe(item));
    this.requestFrame();
  }

  clearSelection() {
    if (!this.selection) return;
    this.selection = null;
    this.emit('select', null);
    this.requestFrame();
  }

  updateSelectedConstellation() {
    const sel = this.selection;
    if (!sel || sel.type !== 'con' || !this.renderer) return;
    const polys = [];
    for (const [con, a, b] of this.cons.segments()) if (con === sel.index) polys.push([this.stars.vector(a), this.stars.vector(b)]);
    if (polys.length) this.renderer.setLines('selcon', buildLines(polys));
    else delete this.renderer.batches.selcon;
  }

  /** Point the view at an object (manual mode) or guide the user to it (sensor mode). */
  centerOn(item) {
    this.select(item);
    if (this.mode === 'sensor') return;
    const enu = this.objectEnu(item);
    const { az, alt } = altAz(enu);
    const fov1 = item.type === 'con' ? Math.max(this.fov, 60 * DEG) : this.fov;
    // Aim a little low so the object ends up above the info card (about 30% from the top).
    const k = (Math.min(this.view.width, this.view.height) / 2) * (1 + Math.cos(fov1 / 2)) / Math.sin(fov1 / 2);
    const lift = 2 * Math.atan((0.2 * this.view.height) / k);
    this.inertia = null;
    this.anim = {
      t0: performance.now(), duration: 700,
      az0: this.az, alt0: this.alt, fov0: this.fov,
      az1: az, alt1: clamp(alt - lift, -Math.PI / 2, Math.PI / 2), fov1,
    };
    this.requestFrame();
  }

  riseSet(item) {
    const bucket = Math.floor(this.sky.jdUT * 144); // 10-minute buckets
    const key = `${item.type}:${item.id ?? item.index}:${bucket}`;
    if (this.riseSetCache.has(key)) return this.riseSetCache.get(key);
    const obs = this.observer;
    let dirAt, h0 = H0.star;
    if (item.type === 'body') {
      dirAt = (jd) => bodyDirection(item.id, jd, obs);
      h0 = item.id === 'sun' ? H0.sun : item.id === 'moon' ? H0.moon : H0.star;
    } else {
      const eq = item.type === 'star' ? this.stars.vector(item.index) : this.cons.labels.find((x) => x.con === item.index).vec;
      dirAt = () => eq;
    }
    const res = riseSetTransit(dirAt, this.sky.jdUT, obs, h0, 24);
    if (this.riseSetCache.size > 50) this.riseSetCache.clear();
    this.riseSetCache.set(key, res);
    return res;
  }

  /** Data for the info card. */
  describe(item) {
    const sky = this.sky;
    const enu = this.objectEnu(item);
    const { az, alt } = altAz(enu);
    const info = { item, name: this.objectName(item), alt, az, below: enu[2] < 0 };
    if (item.type === 'body') {
      const b = sky.bodies[item.id];
      Object.assign(info, {
        kind: BODIES[item.id].kind, mag: b.mag, distKm: b.distKm, phase: b.phase, phaseName: b.phaseName,
        diameter: b.diameter, radec: raDecFromVector(b.eq), con: this.cons.constellationAt(b.eq),
        riseSet: this.riseSet(item),
      });
    } else if (item.type === 'star') {
      const i = item.index;
      const eq = this.stars.vector(i);
      Object.assign(info, {
        kind: 'star', mag: this.stars.mag[i], designation: this.stars.designation(i, this.cons, true),
        hr: this.stars.hr[i], sp: this.stars.sp[i], radec: raDecFromVector(eq),
        con: this.cons.constellationAt(eq), hasName: this.stars.names.has(i), riseSet: this.riseSet(item),
      });
    } else {
      const c = item.index;
      const brightest = this.brightestStarIn(c);
      Object.assign(info, {
        kind: 'constellation', meaning: this.cons.meaning[c], gen: this.cons.gen[c], abbr: this.cons.abbr[c],
        brightest: brightest >= 0 ? this.stars.displayName(brightest, this.cons) : null,
        riseSet: this.riseSet(item),
      });
    }
    return info;
  }

  brightestStarIn(con) {
    this.brightestCache ||= new Map();
    if (!this.brightestCache.has(con)) {
      let found = -1;
      for (let i = 0; i < this.stars.count && found < 0; i++) {
        const own = this.stars.constellationIndex(i);
        if (own === con || (own < 0 && this.cons.constellationAt(this.stars.vector(i)) === con)) found = i;
      }
      this.brightestCache.set(con, found);
    }
    return this.brightestCache.get(con);
  }

  // ------------------------------------------------------------------ search
  buildSearchIndex() {
    const idx = [];
    for (const id of BODY_IDS) idx.push({ item: { type: 'body', id }, name: BODIES[id].name, sub: BODIES[id].kind === 'planet' ? 'Planet' : id === 'sun' ? 'Star' : 'Moon', rank: 0 });
    for (const [i, name] of this.stars.names) {
      idx.push({ item: { type: 'star', index: i }, name, sub: `Star · ${this.stars.designation(i, this.cons)}`, alt: this.stars.designation(i, this.cons, true), rank: 1 + this.stars.mag[i] / 10 });
    }
    for (let c = 0; c < this.cons.abbr.length; c++) {
      idx.push({ item: { type: 'con', index: c }, name: this.cons.name[c], sub: `Constellation · ${this.cons.meaning[c]}`, alt: this.cons.meaning[c], rank: 0.5 + this.cons.rank[c] / 10 });
    }
    const norm = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (const e of idx) e.key = norm(e.name) + '|' + norm(e.alt || '');
    this.searchIndex = idx;
    this.normalizeQuery = norm;
  }

  search(query) {
    const q = this.normalizeQuery(query.trim());
    if (!q) return this.searchIndex.filter((e) => e.item.type === 'body');
    const res = [];
    for (const e of this.searchIndex) {
      const pos = e.key.indexOf(q);
      if (pos < 0) continue;
      const wordStart = pos === 0 || /[\s|(-]/.test(e.key[pos - 1]);
      res.push({ e, score: (pos === 0 ? 0 : wordStart ? 1 : 2) + e.rank });
    }
    res.sort((a, b) => a.score - b.score);
    return res.slice(0, 30).map((r) => r.e);
  }

  /** Altitude of an item right now (for search result hints). */
  altitudeOf(item) {
    const enu = this.objectEnu(item);
    return enu ? Math.asin(clamp(enu[2], -1, 1)) : 0;
  }
}
