// Entry point: boot the app, wire the UI and register the offline service worker.
import { App } from './app.js';
import { UI } from './ui/ui.js';

export const VERSION = '1.0.0';

async function boot() {
  const el = {
    stage: document.getElementById('stage'),
    sky: document.getElementById('sky'),
    labels: document.getElementById('labels'),
    video: document.getElementById('camera'),
  };
  const app = new App(el);
  window.starSky = app; // handy for debugging and automated tests
  const ui = new UI(app);
  try {
    await app.init();
  } catch (err) {
    const fatal = document.getElementById('fatal');
    fatal.hidden = false;
    fatal.textContent = /WebGL/i.test(String(err))
      ? 'Star Sky needs WebGL, which this browser has turned off or does not support.'
      : `Star Sky could not start: ${err.message || err}`;
    console.error(err);
    return;
  }
  ui.start();
  document.getElementById('about-version').textContent = `Version ${VERSION}`;
}

// iOS Safari ignores user-scalable=no; stop page pinch-zoom so the gesture reaches the sky.
document.addEventListener('gesturestart', (e) => e.preventDefault());

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('service worker registration failed', err));
  });
}

boot();
