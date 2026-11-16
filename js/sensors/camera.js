// Rear-camera video behind the sky, for Android Chrome and installed PWAs,
// Android WebViews (APK wrappers) and iOS Safari. It does not depend on the
// motion sensors. It is started only by a tap and released when it is switched
// off or the app is hidden.

// Tried in order until one works. A phone's rear camera reports facingMode
// "environment". The looser requests cover WebViews and devices that do not
// label their cameras, and computers with a single webcam.
const SIZE = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
const REQUESTS = [
  { facingMode: { exact: 'environment' }, ...SIZE },
  { facingMode: { ideal: 'environment' }, ...SIZE },
  true,
];

/** Why a getUserMedia call failed, from the error it rejected with. */
function failureReason(err) {
  const name = (err && err.name) || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'notfound';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError' || name === 'TypeError') return 'constraints';
  return 'unavailable';
}

function stopTracks(stream) {
  for (const t of stream.getTracks()) {
    try { t.stop(); } catch { /* already stopped */ }
  }
}

export class CameraFeed {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.generation = 0; // bumped by every start() and stop(); outdated requests discard their stream
    this.onEnded = null; // called when the system takes the camera away
    video.addEventListener('loadedmetadata', () => this.ensurePlaying());
  }

  /** 'ok', 'insecure' (the page is not on HTTPS, so the browser hides the camera) or 'unsupported'. */
  static support() {
    if (typeof navigator === 'undefined') return 'unsupported';
    if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') return 'ok';
    return typeof window !== 'undefined' && window.isSecureContext === false ? 'insecure' : 'unsupported';
  }

  static isSupported() {
    return CameraFeed.support() === 'ok';
  }

  /**
   * Ask for the rear camera and show it in the background video element.
   * getUserMedia is called synchronously, so calling this from a tap handler
   * keeps the request inside the user gesture.
   * Resolves to { ok: true, facing } or { ok: false, reason } with reason one of
   * 'denied' | 'insecure' | 'unsupported' | 'notfound' | 'busy' | 'unavailable' | 'cancelled'.
   */
  async start() {
    const support = CameraFeed.support();
    if (support !== 'ok') return { ok: false, reason: support };
    const generation = ++this.generation;
    let reason = 'unavailable';
    for (const video of REQUESTS) {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
      } catch (err) {
        if (generation !== this.generation) return { ok: false, reason: 'cancelled' };
        reason = failureReason(err);
        if (reason === 'denied') break; // asking again would only bring the prompt back
        continue;
      }
      if (generation !== this.generation) {
        stopTracks(stream); // switched off, or asked again, while the prompt was open
        return { ok: false, reason: 'cancelled' };
      }
      this._attach(stream);
      return { ok: true, facing: this.facing };
    }
    return { ok: false, reason: reason === 'constraints' ? 'notfound' : reason };
  }

  _attach(stream) {
    const v = this.video;
    if (this.stream && this.stream !== stream) stopTracks(this.stream);
    this.stream = stream;
    // Inline, muted and autoplaying: the combination that mobile browsers and
    // WebViews let start without another tap, and that keeps iOS from opening
    // its full-screen player.
    v.muted = true;
    v.defaultMuted = true;
    v.autoplay = true;
    v.playsInline = true;
    v.controls = false;
    for (const attr of ['muted', 'autoplay', 'playsinline', 'webkit-playsinline']) v.setAttribute(attr, '');
    v.srcObject = stream;
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => { if (this.stream === stream) this.onEnded?.(); });
    }
    this.ensurePlaying();
  }

  /**
   * Start playback if it is not running. A refusal is not an error: the element
   * also autoplays, and the app calls this again on the next touch.
   */
  ensurePlaying() {
    const v = this.video;
    if (!this.stream || !v.paused) return;
    try {
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* some old WebViews throw instead of rejecting */ }
  }

  stop() {
    this.generation++;
    const stream = this.stream;
    this.stream = null;
    if (stream) stopTracks(stream);
    try { this.video.pause(); } catch { /* nothing to pause */ }
    this.video.srcObject = null;
  }

  get running() {
    return !!this.stream;
  }

  /** 'environment' (rear), 'user' (front) or null when the device does not say. */
  get facing() {
    const track = this.stream && this.stream.getVideoTracks()[0];
    const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : null;
    return (settings && settings.facingMode) || null;
  }

  /** Aspect ratio (width / height) of the video as displayed (after rotation). */
  get aspect() {
    const w = this.video.videoWidth, h = this.video.videoHeight;
    return w && h ? w / h : null;
  }
}
