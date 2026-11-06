// Rear-camera video for the AR overlay. Never started without a user action,
// stopped whenever the overlay is turned off or the page is hidden.

export class CameraFeed {
  constructor(video) {
    this.video = video;
    this.stream = null;
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  /** Resolves to { ok: true } or { ok: false, reason: 'unsupported'|'denied'|'unavailable' }. */
  async start() {
    if (!CameraFeed.isSupported()) return { ok: false, reason: 'unsupported' };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      return { ok: false, reason: denied ? 'denied' : 'unavailable' };
    }
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    try {
      await this.video.play();
    } catch {
      this.stop();
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true };
  }

  stop() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
  }

  get running() {
    return !!this.stream;
  }

  /** Aspect ratio (width / height) of the video as displayed (after rotation). */
  get aspect() {
    const w = this.video.videoWidth, h = this.video.videoHeight;
    return w && h ? w / h : null;
  }
}
