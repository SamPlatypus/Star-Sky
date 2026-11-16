#!/usr/bin/env node
// End-to-end smoke test in headless Chromium (Playwright). Serves the repo,
// then checks rendering, JS/GPU projection agreement, picking, search, red-light
// mode, simulated motion sensors (absolute, relative and compass streams), the
// camera backdrop on its own and together with motion, permission denials, and
// offline start-up from the service worker cache.
//   node test/e2e/smoke.mjs [--shots dir]
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
if (shots) await mkdir(shots, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(root, path));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
// Recent Chromium gates DeviceOrientationEvent.requestPermission() on these (granted by default on phones).
const SENSORS = ['accelerometer', 'gyroscope', 'magnetometer'];
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['ok', name]); console.log(`ok - ${name}`); }
  catch (err) { results.push(['FAIL', name, err]); console.log(`not ok - ${name}\n  ${String(err.stack || err).split('\n').slice(0, 4).join('\n  ')}`); }
}

async function newPage(browser, opts = {}, init = null) {
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 860 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    timezoneId: 'Europe/London', serviceWorkers: 'allow', ...opts,
  });
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('starsky.settings.v1')) localStorage.setItem('starsky.settings.v1', JSON.stringify({ onboarded: true }));
  });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.goto(base);
  await page.waitForFunction(() => window.starSky && window.starSky.sky, null, { timeout: 15000 });
  return { ctx, page };
}

const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };

// Feed synthetic orientation events at 60 Hz. `abs` and `rel` are [alpha, beta, gamma]
// for the 'deviceorientationabsolute' and 'deviceorientation' streams; null skips a stream.
async function feed(page, { abs = null, rel = null }, ms = 600) {
  await page.evaluate(async ({ abs, rel, ms }) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (rel) window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: rel[0], beta: rel[1], gamma: rel[2], absolute: false }));
      if (abs) window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha: abs[0], beta: abs[1], gamma: abs[2], absolute: true }));
      await new Promise((r) => setTimeout(r, 16));
    }
  }, { abs, rel, ms });
}
// Both streams with the same angles, as an Android phone reports them.
const orient = (page, alpha, beta, gamma, ms = 600) => feed(page, { abs: [alpha, beta, gamma], rel: [alpha, beta, gamma] }, ms);

// What the app is showing: view heading and altitude in degrees, plus mode flags.
const state = (page) => page.evaluate(async () => {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // let pending changes be drawn
  const a = window.starSky, c = a.view.centerAltAz();
  return {
    az: c.az * 180 / Math.PI, alt: c.alt * 180 / Math.PI, mode: a.mode, driving: a.sensorDriving, camera: a.cameraOn,
    starting: a.cameraStarting, dec: a.tracker.declination, cal: a.settings.calibration, proj: a.view.projection,
    manualAz: a.az * 180 / Math.PI, source: a.tracker.source, heading: a.tracker.headingSource,
  };
});
const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
async function drag(page, dx, dy = 0) {
  await page.mouse.move(200, 400);
  await page.mouse.down();
  await page.mouse.move(200 + dx, 400 + dy, { steps: 6 });
  await page.mouse.up();
}
const pressed = (page, sel) => page.getAttribute(sel, 'aria-pressed');

const browser = await chromium.launch({ args: GL_ARGS });

await check('app boots without errors and draws the sky', async () => {
  const { ctx, page } = await newPage(browser);
  await page.evaluate(() => {
    const a = window.starSky;
    a.setTime(new Date('2026-12-15T23:00:00Z'));
    a.az = 180 * Math.PI / 180; a.alt = 30 * Math.PI / 180; a.fov = 90 * Math.PI / 180;
    a.requestFrame();
  });
  await page.waitForTimeout(300);
  await shot(page, '01-virtual-sky');
  assert.deepEqual(page.errors.filter((e) => !/service ?worker/i.test(e)), []);
  const counts = await page.evaluate(() => ({ stars: window.starSky.stars.count, mode: window.starSky.mode }));
  assert.ok(counts.stars > 8000);
  assert.equal(counts.mode, 'manual');
  await ctx.close();
});

await check('GPU star positions match the JS projection used for labels and taps', async () => {
  const { ctx, page } = await newPage(browser);
  const res = await page.evaluate(() => {
    const a = window.starSky;
    a.setTime(new Date('2026-12-15T23:00:00Z'));
    a.set('showConLines', false);
    const out = [];
    for (const name of ['Sirius', 'Betelgeuse', 'Rigel', 'Aldebaran']) {
      const i = [...a.stars.names.entries()].find(([, n]) => n === name)[0];
      const enu = a.view.eqToEnu(a.stars.vector(i));
      a.az = Math.atan2(enu[0], enu[1]) + 0.2; a.alt = Math.asin(enu[2]) + 0.1; a.fov = 0.9;
      a.view.setFromAltAz(a.az, a.alt); a.applyProjection();
      const p = {}; a.view.project(enu, p);
      a.draw();
      const at = a.renderer.readPixel(p.x, p.y);
      const off = a.renderer.readPixel(p.x + 12, p.y + 12);
      out.push({ name, at, off });
    }
    return out;
  });
  for (const r of res) {
    assert.ok(r.at[0] + r.at[1] + r.at[2] > 300, `${r.name} not drawn at projected spot: ${r.at}`);
    assert.ok(r.off[0] + r.off[1] + r.off[2] < 150, `${r.name} unexpected brightness off-target: ${r.off}`);
  }
  await ctx.close();
});

await check('tapping a star opens its info card; Find centres a planet', async () => {
  const { ctx, page } = await newPage(browser);
  const pos = await page.evaluate(() => {
    const a = window.starSky;
    a.setTime(new Date('2026-12-15T23:00:00Z'));
    const i = [...a.stars.names.entries()].find(([, n]) => n === 'Betelgeuse')[0];
    const enu = a.view.eqToEnu(a.stars.vector(i));
    a.az = Math.atan2(enu[0], enu[1]); a.alt = Math.asin(enu[2]); a.fov = 1.2;
    a.view.setFromAltAz(a.az, a.alt); a.applyProjection();
    const p = {}; a.view.project(enu, p);
    a.requestFrame();
    return { x: p.x + 3, y: p.y - 2 };
  });
  await page.waitForTimeout(200);
  await page.touchscreen.tap(pos.x, pos.y);
  await page.waitForSelector('#info:not([hidden])');
  assert.equal(await page.textContent('#info-title'), 'Betelgeuse');
  assert.match(await page.textContent('#info-sub'), /Orion/);
  assert.match(await page.textContent('#info-rows'), /Rises|Sets|horizon/);
  await shot(page, '02-info-card');
  await page.click('#btn-search');
  await page.fill('#search-input', 'jupi');
  await page.click('#search-results button');
  await page.waitForTimeout(900);
  assert.equal(await page.textContent('#info-title'), 'Jupiter');
  const spot = await page.evaluate(() => {
    const a = window.starSky; const p = {};
    a.view.project(a.view.eqToEnu(a.sky.bodies.jupiter.eq), p);
    const card = document.getElementById('info').getBoundingClientRect();
    return { dx: Math.abs(p.x - a.view.width / 2), y: p.y, cardTop: card.top };
  });
  assert.ok(spot.dx < 3, `Jupiter ${spot.dx}px off-centre`);
  assert.ok(spot.y < spot.cardTop - 20, `Jupiter at y=${spot.y} hidden by the card (top ${spot.cardTop})`);
  await shot(page, '03-find-jupiter');
  await ctx.close();
});

await check('device location (GPS) sets the observer and names the nearest city', async () => {
  const { ctx, page } = await newPage(browser, { permissions: ['geolocation'], geolocation: { latitude: 48.86, longitude: 2.35 } });
  await page.click('#btn-when');
  await page.click('#loc-gps');
  await page.waitForFunction(() => window.starSky.settings.location.source === 'gps');
  const loc = await page.evaluate(() => window.starSky.settings.location);
  assert.equal(loc.lat, 48.86);
  assert.match(loc.name, /Paris/);
  assert.match(await page.textContent('#when-place'), /Paris/);
  await ctx.close();
});

await check('recovers from a lost WebGL context', async () => {
  const { ctx, page } = await newPage(browser);
  const ok = await page.evaluate(async () => {
    const a = window.starSky;
    const ext = a.renderer.gl.getExtension('WEBGL_lose_context');
    ext.loseContext();
    await new Promise((r) => setTimeout(r, 200));
    ext.restoreContext();
    await new Promise((r) => setTimeout(r, 400));
    a.setTime(new Date('2026-12-15T23:00:00Z'));
    const i = [...a.stars.names.entries()].find(([, n]) => n === 'Sirius')[0];
    const enu = a.view.eqToEnu(a.stars.vector(i));
    a.az = Math.atan2(enu[0], enu[1]); a.alt = Math.asin(enu[2]); a.fov = 0.5;
    a.view.setFromAltAz(a.az, a.alt); a.applyProjection();
    const p = {}; a.view.project(enu, p);
    a.draw();
    const px = a.renderer.readPixel(p.x, p.y);
    return { lost: a.renderer.lost, bright: px[0] + px[1] + px[2] };
  });
  assert.equal(ok.lost, false);
  assert.ok(ok.bright > 300, `Sirius not drawn after restore (${ok.bright})`);
  assert.deepEqual(page.errors.filter((e) => !/service ?worker/i.test(e)), []);
  await ctx.close();
});

await check('red-light mode turns the interface and sky red', async () => {
  const { ctx, page } = await newPage(browser);
  await page.click('#btn-night');
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains('night')));
  const px = await page.evaluate(() => {
    const a = window.starSky; a.setTime(new Date('2026-12-15T12:00:00Z'));
    a.az = Math.PI; a.alt = 0.6; a.view.setFromAltAz(a.az, a.alt); a.applyProjection(); a.draw();
    return a.renderer.readPixel(a.view.width / 2, 40);
  });
  assert.ok(px[0] > 0 && px[1] === 0 && px[2] === 0, `not pure red: ${px}`);
  await shot(page, '04-red-light');
  await ctx.close();
});

await check('motion mode follows the absolute orientation stream (with declination)', async () => {
  const { ctx, page } = await newPage(browser, { permissions: SENSORS });
  await page.click('#btn-motion');
  await page.waitForFunction(() => window.starSky.mode === 'sensor');
  await orient(page, 0, 90, 0, 700); // upright, back of phone facing magnetic north
  let v = await state(page);
  assert.equal(v.source, 'absolute');
  assert.ok(angleDiff(v.az, v.dec) < 0.5, `heading ${v.az} vs declination ${v.dec}`);
  assert.ok(Math.abs(v.alt) < 0.5, `altitude ${v.alt}`);
  await orient(page, 90, 135, 0, 800); // turned to face west, tilted 45 deg up
  v = await state(page);
  assert.ok(angleDiff(v.az, 270 + v.dec) < 1, `west heading ${v.az}`);
  assert.ok(Math.abs(v.alt - 45) < 1, `altitude ${v.alt}`);
  await shot(page, '05-motion');
  // Calibration: "this is north" while facing west makes the view report north, at once.
  await page.evaluate(() => window.starSky.startCalibration());
  await page.click('#calib-north');
  await page.waitForTimeout(500);
  v = await state(page);
  assert.ok(angleDiff(v.az, 0) < 1, `calibrated heading ${v.az}`);
  await page.click('#calib-done');
  // Dragging the sky hands the view over and carries on from the same direction:
  // from north at 45 deg, a drag to the right and down turns the view west and up.
  await drag(page, 14, 0); // a brush of the screen (or the first finger of a pinch) changes nothing
  v = await state(page);
  assert.equal(v.mode, 'sensor');
  assert.ok(angleDiff(v.az, 0) < 1 && Math.abs(v.alt - 45) < 1, 'a small touch moved the view');
  await drag(page, 120, 40);
  v = await state(page);
  assert.equal(v.mode, 'manual');
  assert.equal(await pressed(page, '#btn-motion'), 'false');
  assert.match(await page.textContent('#toast'), /Motion off/);
  assert.ok(v.manualAz > 300 && v.manualAz < 355, `continued from azimuth ${v.manualAz}`);
  assert.ok(v.alt > 46 && v.alt < 70, `continued from altitude ${v.alt}`);
  await ctx.close();
});

await check('absolute readings win over relative ones; relative is only the fallback', async () => {
  const { ctx, page } = await newPage(browser, { permissions: SENSORS });
  await page.click('#btn-motion');
  await page.waitForFunction(() => window.starSky.mode === 'sensor');
  // The relative stream has an arbitrary yaw (alpha 123); the absolute one says north.
  await feed(page, { rel: [123, 90, 0], abs: [0, 90, 0] }, 700);
  let v = await state(page);
  assert.equal(v.source, 'absolute');
  assert.ok(angleDiff(v.az, v.dec) < 0.5, `followed the wrong stream: ${v.az}`);
  // Relative readings alone no longer move the view once absolute ones have arrived.
  await feed(page, { rel: [200, 90, 0] }, 400);
  v = await state(page);
  assert.ok(angleDiff(v.az, v.dec) < 0.5, `relative stream moved the view: ${v.az}`);
  await ctx.close();

  // A device with no absolute sensor: only relative readings ever arrive.
  const second = await newPage(browser, { permissions: SENSORS });
  await second.page.click('#btn-motion');
  await second.page.waitForFunction(() => window.starSky.mode === 'sensor');
  await feed(second.page, { rel: [40, 120, 0] }, 1200);
  v = await state(second.page);
  assert.equal(v.source, 'relative');
  assert.equal(v.driving, true);
  assert.ok(angleDiff(v.az, 320) < 0.5 && Math.abs(v.alt - 30) < 0.5, `fallback view ${v.az}, ${v.alt}`);
  await feed(second.page, { rel: [40, 120, 0] }, 2200);
  assert.match(await second.page.textContent('#toast'), /Calibrate/);
  await second.ctx.close();
});

await check('iOS-style compass heading (relative events + webkitCompassHeading) sets true north', async () => {
  const { ctx, page } = await newPage(browser, { permissions: SENSORS });
  // Arbitrary relative yaw (alpha 37); the compass says the camera faces 200 deg magnetic.
  const compass = (ms) => page.evaluate(async (ms) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const e = new DeviceOrientationEvent('deviceorientation', { alpha: 37, beta: 60, gamma: 0, absolute: false });
      Object.defineProperty(e, 'webkitCompassHeading', { value: 200 });
      Object.defineProperty(e, 'webkitCompassAccuracy', { value: 10 });
      window.dispatchEvent(e);
      await new Promise((r) => setTimeout(r, 16));
    }
  }, ms);
  await page.click('#btn-motion');
  await page.waitForFunction(() => window.starSky.mode === 'sensor');
  await compass(1200);
  const v = await state(page);
  assert.equal(v.heading, 'compass');
  assert.ok(angleDiff(v.az, 200 + v.dec) < 0.5, `heading ${v.az}`);
  assert.ok(Math.abs(v.alt + 30) < 0.5, `altitude ${v.alt}`);
  await ctx.close();
});

await check('motion stays on without data (no timeout); drag still pans; late readings take over', async () => {
  const { ctx, page } = await newPage(browser, { permissions: SENSORS });
  await page.click('#btn-motion');
  await page.waitForFunction(() => window.starSky.mode === 'sensor');
  await page.waitForTimeout(3400); // well past the old 1.5 s abort
  let v = await state(page);
  assert.equal(v.mode, 'sensor');
  assert.equal(v.driving, false);
  assert.equal(await pressed(page, '#btn-motion'), 'true');
  assert.match(await page.textContent('#toast'), /No motion data/);
  // Manual drag works while waiting, and does not switch motion off.
  const before = v.manualAz;
  await drag(page, 80);
  v = await state(page);
  assert.ok(angleDiff(v.manualAz, before) > 3, `drag did not pan: ${before} -> ${v.manualAz}`);
  assert.ok(angleDiff(v.az, v.manualAz) < 0.01, 'the view shows the dragged direction');
  assert.equal(v.mode, 'sensor');
  // Readings finally arrive: the sensors take the view.
  await orient(page, 0, 110, 0, 500);
  v = await state(page);
  assert.equal(v.driving, true);
  assert.ok(angleDiff(v.az, v.dec) < 0.5 && Math.abs(v.alt - 20) < 0.5, `late data not followed: ${v.az}, ${v.alt}`);
  await ctx.close();
});

await check('motion can be toggled repeatedly without breaking manual drag', async () => {
  const { ctx, page } = await newPage(browser, { permissions: SENSORS });
  for (let round = 0; round < 3; round++) {
    await page.click('#btn-motion');
    await page.waitForFunction(() => window.starSky.mode === 'sensor');
    await orient(page, 90, 120, 0, 500); // west, 30 deg up
    let v = await state(page);
    assert.equal(v.driving, true, `round ${round}: sensors not steering`);
    assert.ok(angleDiff(v.az, 270 + v.dec) < 1, `round ${round}: heading ${v.az}`);
    await page.click('#btn-motion');
    v = await state(page);
    assert.equal(v.mode, 'manual');
    assert.equal(await pressed(page, '#btn-motion'), 'false');
    // The manual view continues from where the phone pointed...
    assert.ok(angleDiff(v.manualAz, 270 + v.dec) < 1 && Math.abs(v.alt - 30) < 1, `round ${round}: handed over at ${v.manualAz}, ${v.alt}`);
    // ...stray sensor events no longer move it...
    await orient(page, 0, 90, 0, 200);
    v = await state(page);
    assert.ok(angleDiff(v.az, 270 + v.dec) < 1, `round ${round}: sensors still steering after switch-off`);
    // ...and dragging pans it.
    await drag(page, 70, -30);
    const after = await state(page);
    assert.ok(angleDiff(after.manualAz, v.manualAz) > 3, `round ${round}: horizontal drag did nothing`);
    assert.ok(after.alt < v.alt - 1, `round ${round}: vertical drag did nothing`);
    assert.ok(angleDiff(after.az, after.manualAz) < 0.01);
    await page.waitForTimeout(700); // let the fling settle
  }
  assert.deepEqual(page.errors.filter((e) => !/service ?worker/i.test(e)), []);
  await ctx.close();
});

await check('pinch zoom while the sensors steer keeps motion on', async () => {
  const { ctx, page } = await newPage(browser, { permissions: SENSORS });
  await page.click('#btn-motion');
  await page.waitForFunction(() => window.starSky.mode === 'sensor');
  await orient(page, 0, 110, 0, 400);
  const fovBefore = await page.evaluate(() => window.starSky.fov);
  // Two fingers that do not land at the same instant: the first drifts a little before the second arrives.
  await page.evaluate(() => {
    const stage = document.getElementById('stage');
    const ev = (type, id, x, y) => stage.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
    ev('pointerdown', 11, 150, 400);
    ev('pointermove', 11, 150, 388);
    ev('pointerdown', 12, 260, 400);
    for (let i = 1; i <= 8; i++) { ev('pointermove', 11, 150 - 6 * i, 388); ev('pointermove', 12, 260 + 6 * i, 400); }
    ev('pointerup', 11, 102, 388);
    ev('pointerup', 12, 308, 400);
  });
  const v = await state(page);
  assert.equal(v.mode, 'sensor', 'a pinch switched motion off');
  assert.equal(v.driving, true);
  const fovAfter = await page.evaluate(() => window.starSky.fov);
  assert.ok(fovAfter < fovBefore * 0.8, `pinch did not zoom: ${fovBefore} -> ${fovAfter}`);
  assert.ok(angleDiff(v.az, v.dec) < 0.5 && Math.abs(v.alt - 20) < 0.5, 'the sensors should still be steering');
  await ctx.close();
});

await check('declined motion permission falls back to drag mode', async () => {
  // An explicit refusal, as iOS or a blocked Chrome site setting reports it.
  const { ctx, page } = await newPage(browser, {}, () => {
    window.DeviceOrientationEvent.requestPermission = async () => 'denied';
  });
  await page.click('#btn-motion');
  await page.waitForTimeout(400);
  assert.equal((await state(page)).mode, 'manual');
  assert.equal(await pressed(page, '#btn-motion'), 'false');
  assert.match(await page.textContent('#toast'), /declined/);
  const before = (await state(page)).manualAz;
  await drag(page, 80);
  assert.ok(angleDiff((await state(page)).manualAz, before) > 3, 'drag works after a declined permission');
  await ctx.close();
});

await check('an unanswered motion permission request does not stop the tracker from listening', async () => {
  // No sensor permission granted: headless Chromium answers "prompt", neither yes nor no.
  const { ctx, page } = await newPage(browser);
  await page.click('#btn-motion');
  await page.waitForFunction(() => window.starSky.mode === 'sensor', null, { timeout: 3000 });
  await orient(page, 270, 90, 0, 500);
  const v = await state(page);
  assert.equal(v.driving, true);
  assert.ok(angleDiff(v.az, 90 + v.dec) < 0.5, `heading ${v.az}`);
  await ctx.close();
});

await browser.close();

// Records every getUserMedia request and its outcome in window.__gum.
const recordGetUserMedia = () => {
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;
  const real = md.getUserMedia.bind(md);
  window.__gum = [];
  window.__realGetUserMedia = real;
  md.getUserMedia = async (constraints) => {
    const entry = { video: JSON.parse(JSON.stringify(constraints.video)), audio: constraints.audio };
    window.__gum.push(entry);
    try { const stream = await real(constraints); entry.result = 'ok'; return stream; }
    catch (err) { entry.result = err.name; throw err; }
  };
};
const videoState = (page) => page.evaluate(() => {
  const v = document.getElementById('camera');
  return {
    live: !!v.srcObject && v.srcObject.getVideoTracks().some((t) => t.readyState === 'live'),
    paused: v.paused, ready: v.readyState, width: v.videoWidth, inline: v.hasAttribute('playsinline'), muted: v.muted,
    shown: getComputedStyle(v).display !== 'none', behind: v.compareDocumentPosition(document.getElementById('sky')) === Node.DOCUMENT_POSITION_FOLLOWING,
  };
});

// Camera backdrop with Chromium's fake camera (permission granted).
const camBrowser = await chromium.launch({ args: [...GL_ARGS, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });

await check('camera opens the rear camera inline without any motion sensors', async () => {
  // No sensor permission and no orientation events: the camera must not care.
  const { ctx, page } = await newPage(camBrowser, { permissions: ['camera'] }, recordGetUserMedia);
  await page.click('#btn-camera');
  await page.waitForFunction(() => window.starSky.cameraOn, null, { timeout: 5000 });
  await page.waitForFunction(() => document.getElementById('camera').videoWidth > 0, null, { timeout: 5000 });
  let v = await state(page);
  assert.equal(v.mode, 'manual', 'the camera must not switch motion on');
  assert.equal(v.proj, 'perspective');
  assert.equal(await pressed(page, '#btn-camera'), 'true');
  assert.equal(await pressed(page, '#btn-motion'), 'false');
  assert.match(await page.textContent('#toast'), /Tap Motion/);
  const vid = await videoState(page);
  assert.ok(vid.live && !vid.paused && vid.ready >= 2, `video not playing: ${JSON.stringify(vid)}`);
  assert.ok(vid.inline && vid.muted && vid.shown && vid.behind, `video not inline behind the sky: ${JSON.stringify(vid)}`);
  // The rear camera is asked for first; the fake camera has no facing mode, so the looser request is used.
  const gum = await page.evaluate(() => window.__gum);
  assert.deepEqual(gum[0].video.facingMode, { exact: 'environment' });
  assert.equal(gum[0].audio, false);
  assert.equal(gum.at(-1).result, 'ok');
  assert.ok(gum.length <= 3);
  const corner = await page.evaluate(() => { const a = window.starSky; a.draw(); return a.renderer.readPixel(5, 5); });
  assert.equal(corner[3], 0, 'sky background should be transparent over the video');
  await shot(page, '06-camera');
  // Manual drag still pans the sky over the camera picture.
  const before = v.manualAz;
  await drag(page, 80);
  v = await state(page);
  assert.ok(angleDiff(v.manualAz, before) > 3, 'drag did not pan with the camera on');
  assert.equal(v.cal, 0, 'a manual pan must not touch the calibration');
  await page.click('#btn-camera');
  v = await state(page);
  assert.equal(v.camera, false);
  assert.equal(v.proj, 'stereographic');
  assert.equal((await videoState(page)).live, false, 'camera not released');
  assert.deepEqual(page.errors.filter((e) => !/service ?worker/i.test(e)), []);
  await ctx.close();
});

await check('camera and motion are independent switches', async () => {
  const { ctx, page } = await newPage(camBrowser, { permissions: ['camera', ...SENSORS] });
  await page.click('#btn-camera');
  await page.waitForFunction(() => window.starSky.cameraOn, null, { timeout: 5000 });
  await page.click('#btn-motion');
  await page.waitForFunction(() => window.starSky.mode === 'sensor');
  await orient(page, 0, 100, 0, 500);
  let v = await state(page);
  assert.ok(v.camera && v.driving, 'camera and motion should both be on');
  assert.ok(angleDiff(v.az, v.dec) < 0.5 && Math.abs(v.alt - 10) < 0.5);
  // With both on, a sideways drag lines the overlay up instead of leaving motion mode.
  await drag(page, 90);
  v = await state(page);
  assert.equal(v.mode, 'sensor');
  assert.ok(Math.abs(v.cal) > 1, `calibration unchanged: ${v.cal}`);
  await page.evaluate(() => window.starSky.set('calibration', 0));
  // Motion off: the camera stays, and the sky can be dragged.
  await page.click('#btn-motion');
  v = await state(page);
  assert.equal(v.mode, 'manual');
  assert.equal(v.camera, true, 'switching motion off must not stop the camera');
  assert.equal((await videoState(page)).live, true);
  const before = v.manualAz;
  await drag(page, 80);
  v = await state(page);
  assert.ok(angleDiff(v.manualAz, before) > 3 && v.cal === 0, 'drag should pan, not calibrate, with motion off');
  // Motion on again, then camera off: motion stays.
  await page.click('#btn-motion');
  await page.waitForFunction(() => window.starSky.mode === 'sensor');
  await orient(page, 90, 100, 0, 500);
  await page.click('#btn-camera');
  v = await state(page);
  assert.equal(v.camera, false);
  assert.equal(v.mode, 'sensor', 'switching the camera off must not stop motion');
  assert.equal(v.proj, 'stereographic');
  await orient(page, 180, 100, 0, 500);
  v = await state(page);
  assert.ok(angleDiff(v.az, 180 + v.dec) < 1, `motion no longer steering: ${v.az}`);
  await ctx.close();
});

await check('camera copes with refused playback, a lost track and backgrounding', async () => {
  const { ctx, page } = await newPage(camBrowser, { permissions: ['camera'] }, () => {
    // A WebView that refuses script-started playback.
    window.__playCalls = 0;
    const realPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function play() {
      window.__playCalls++;
      if (window.__refusePlay) return Promise.reject(new DOMException('gesture required', 'NotAllowedError'));
      return realPlay.call(this);
    };
    window.__refusePlay = true;
  });
  await page.click('#btn-camera');
  await page.waitForFunction(() => window.starSky.cameraOn, null, { timeout: 5000 });
  assert.equal((await videoState(page)).live, true, 'a refused play() must not abort the camera');
  // Playback held until the user touches the page: the next touch starts it.
  await page.evaluate(() => { document.getElementById('camera').pause(); window.__refusePlay = false; });
  assert.equal((await videoState(page)).paused, true);
  await page.mouse.move(200, 300); await page.mouse.down(); await page.mouse.up();
  await page.waitForFunction(() => !document.getElementById('camera').paused, null, { timeout: 3000 });
  // Hidden: the camera is released. Visible again: it comes back by itself.
  const setHidden = (hidden) => page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await setHidden(true);
  assert.equal((await videoState(page)).live, false, 'camera kept running in the background');
  await setHidden(false);
  await page.waitForFunction(() => {
    const v = document.getElementById('camera');
    return window.starSky.cameraOn && v.srcObject && v.srcObject.getVideoTracks()[0].readyState === 'live';
  }, null, { timeout: 5000 });
  // The system takes the camera away (another app, revoked permission).
  await page.evaluate(() => document.getElementById('camera').srcObject.getVideoTracks()[0].dispatchEvent(new Event('ended')));
  const v = await state(page);
  assert.equal(v.camera, false);
  assert.equal(v.proj, 'stereographic');
  assert.match(await page.textContent('#toast'), /virtual sky/);
  assert.deepEqual(page.errors.filter((e) => !/service ?worker/i.test(e)), []);
  await ctx.close();
});

await check('a camera request left hanging can be cancelled and retried', async () => {
  const { ctx, page } = await newPage(camBrowser, { permissions: ['camera'] }, () => {
    // A host that never answers the permission request, until told to.
    const md = navigator.mediaDevices;
    if (!md) return;
    const real = md.getUserMedia.bind(md);
    window.__hang = true;
    window.__release = [];
    md.getUserMedia = (c) => (window.__hang
      ? new Promise((resolve, reject) => { window.__release.push(() => real(c).then(resolve, reject)); })
      : real(c));
  });
  await page.click('#btn-camera');
  await page.waitForTimeout(300);
  let v = await state(page);
  assert.equal(v.starting, true);
  assert.equal(v.camera, false);
  assert.equal(await page.getAttribute('#btn-camera', 'aria-busy'), 'true');
  await page.click('#btn-camera'); // cancel
  v = await state(page);
  assert.equal(v.starting, false);
  assert.equal(await page.getAttribute('#btn-camera', 'aria-busy'), 'false');
  // The old request is answered late: its stream must be dropped, not shown.
  const late = await page.evaluate(async () => {
    window.__hang = false;
    for (const go of window.__release) go();
    await new Promise((r) => setTimeout(r, 1200));
    return { on: window.starSky.cameraOn, attached: !!document.getElementById('camera').srcObject };
  });
  assert.deepEqual(late, { on: false, attached: false });
  // And the button still works.
  await page.click('#btn-camera');
  await page.waitForFunction(() => window.starSky.cameraOn, null, { timeout: 5000 });
  await ctx.close();
});
await camBrowser.close();

// The same fake camera, with every permission request refused (a real NotAllowedError).
const denyBrowser = await chromium.launch({ args: [...GL_ARGS, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream=deny'] });
await check('denied camera permission keeps the virtual sky and leaves motion alone', async () => {
  const { ctx, page } = await newPage(denyBrowser, { permissions: SENSORS }, recordGetUserMedia);
  await page.click('#btn-motion');
  await page.waitForFunction(() => window.starSky.mode === 'sensor');
  await orient(page, 0, 100, 0, 400);
  await page.click('#btn-camera');
  await page.waitForFunction(() => /virtual sky/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
  assert.match(await page.textContent('#toast'), /denied/);
  let v = await state(page);
  assert.equal(v.camera, false);
  assert.equal(v.starting, false);
  assert.equal(v.proj, 'stereographic');
  assert.equal(v.mode, 'sensor', 'a refused camera must not switch motion off');
  assert.equal(await pressed(page, '#btn-camera'), 'false');
  const gum = await page.evaluate(() => window.__gum);
  assert.equal(gum.at(-1).result, 'NotAllowedError');
  assert.equal(gum.filter((g) => g.result === 'NotAllowedError').length, 1, 'must not ask again after a refusal');
  const corner = await page.evaluate(() => { const a = window.starSky; a.draw(); return a.renderer.readPixel(5, 5); });
  assert.equal(corner[3], 255, 'the virtual sky should still be drawn');
  // Motion still steers, and the button can be tried again later.
  await orient(page, 90, 100, 0, 500);
  v = await state(page);
  assert.ok(angleDiff(v.az, 270 + v.dec) < 1);
  await shot(page, '07-camera-denied');
  await ctx.close();
});

await check('no camera API (page not on HTTPS) is reported, not fatal', async () => {
  const { ctx, page } = await newPage(denyBrowser, {}, () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, get: () => undefined });
    Object.defineProperty(window, 'isSecureContext', { configurable: true, get: () => false });
  });
  await page.click('#btn-camera');
  await page.waitForFunction(() => /virtual sky/.test(document.getElementById('toast').textContent), null, { timeout: 3000 });
  assert.match(await page.textContent('#toast'), /HTTPS/);
  const v = await state(page);
  assert.equal(v.camera, false);
  assert.equal(v.starting, false);
  assert.deepEqual(page.errors.filter((e) => !/service ?worker/i.test(e)), []);
  await ctx.close();
});

await check('works offline after the first visit (service worker cache)', async () => {
  const { ctx, page } = await newPage(denyBrowser);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10000 });
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.starSky && window.starSky.sky, null, { timeout: 15000 });
  const ok = await page.evaluate(() => window.starSky.stars.count > 8000 && !!window.starSky.sky.bodies.moon);
  assert.ok(ok);
  await shot(page, '08-offline');
  await ctx.close();
});
await denyBrowser.close();
server.close();

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
