#!/usr/bin/env node
// End-to-end smoke test in headless Chromium (Playwright). Serves the repo,
// then checks rendering, JS/GPU projection agreement, picking, search, red-light
// mode, simulated motion sensors, camera overlay + denial fallback and offline
// start-up from the service worker cache.
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

async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 860 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    timezoneId: 'Europe/London', serviceWorkers: 'allow', ...opts,
  });
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('starsky.settings.v1')) localStorage.setItem('starsky.settings.v1', JSON.stringify({ onboarded: true }));
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.goto(base);
  await page.waitForFunction(() => window.starSky && window.starSky.sky, null, { timeout: 15000 });
  return { ctx, page };
}

const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };

// Feed synthetic orientation events (both relative and absolute streams).
async function orient(page, alpha, beta, gamma, ms = 600) {
  await page.evaluate(async ({ alpha, beta, gamma, ms }) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha, beta, gamma, absolute: false }));
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha, beta, gamma, absolute: true }));
      await new Promise((r) => setTimeout(r, 16));
    }
  }, { alpha, beta, gamma, ms });
}

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

await check('motion mode follows simulated device orientation (with declination)', async () => {
  const { ctx, page } = await newPage(browser, { permissions: SENSORS });
  await page.click('#btn-motion');
  await orient(page, 0, 90, 0, 900); // upright, back of phone facing magnetic north
  await page.waitForFunction(() => window.starSky.mode === 'sensor');
  await orient(page, 0, 90, 0, 600);
  let v = await page.evaluate(() => ({ az: window.starSky.heading, alt: window.starSky.view.centerAltAz().alt * 180 / Math.PI, dec: window.starSky.tracker.declination }));
  const azErr = ((v.az - v.dec + 540) % 360) - 180;
  assert.ok(Math.abs(azErr) < 0.5, `heading ${v.az} vs declination ${v.dec}`);
  assert.ok(Math.abs(v.alt) < 0.5, `altitude ${v.alt}`);
  await orient(page, 90, 135, 0, 800); // turned to face west, tilted 45 deg up
  v = await page.evaluate(() => ({ az: window.starSky.heading, alt: window.starSky.view.centerAltAz().alt * 180 / Math.PI, dec: window.starSky.tracker.declination }));
  assert.ok(Math.abs(((v.az - (270 + v.dec) + 540) % 360) - 180) < 1, `west heading ${v.az}`);
  assert.ok(Math.abs(v.alt - 45) < 1, `altitude ${v.alt}`);
  await shot(page, '05-motion');
  // Calibration: "this is north" while facing west makes the view report north.
  await page.evaluate(() => window.starSky.startCalibration());
  await page.click('#calib-north');
  await orient(page, 90, 135, 0, 800);
  v = await page.evaluate(() => window.starSky.heading);
  assert.ok(Math.abs(((v + 540) % 360) - 180) < 1, `calibrated heading ${v}`);
  await page.click('#calib-done');
  // Dragging the sky leaves motion mode.
  await page.mouse.move(200, 400); await page.mouse.down(); await page.mouse.move(260, 420, { steps: 5 }); await page.mouse.up();
  assert.equal(await page.evaluate(() => window.starSky.mode), 'manual');
  await ctx.close();
});

await check('iOS-style compass heading (relative events + webkitCompassHeading) sets true north', async () => {
  const { ctx, page } = await newPage(browser, { permissions: SENSORS });
  // Arbitrary relative yaw (alpha 37); the compass says the camera faces 200 deg magnetic.
  const feed = (ms) => page.evaluate(async (ms) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const e = new DeviceOrientationEvent('deviceorientation', { alpha: 37, beta: 60, gamma: 0, absolute: false });
      Object.defineProperty(e, 'webkitCompassHeading', { value: 200 });
      Object.defineProperty(e, 'webkitCompassAccuracy', { value: 10 });
      window.dispatchEvent(e);
      await new Promise((r) => setTimeout(r, 16));
    }
  }, ms);
  const feeding = feed(1500);
  await page.click('#btn-motion');
  await feeding;
  await page.waitForFunction(() => window.starSky.mode === 'sensor');
  await feed(500);
  const v = await page.evaluate(() => ({ az: window.starSky.heading, alt: window.starSky.view.centerAltAz().alt * 180 / Math.PI,
    dec: window.starSky.tracker.declination, src: window.starSky.tracker.headingSource }));
  assert.equal(v.src, 'compass');
  assert.ok(Math.abs(((v.az - (200 + v.dec) + 540) % 360) - 180) < 0.5, `heading ${v.az}`);
  assert.ok(Math.abs(v.alt + 30) < 0.5, `altitude ${v.alt}`);
  await ctx.close();
});

await check('motion button without sensor data falls back to drag mode', async () => {
  const { ctx, page } = await newPage(browser, { permissions: SENSORS });
  await page.click('#btn-motion');
  await page.waitForTimeout(1900);
  assert.equal(await page.evaluate(() => window.starSky.mode), 'manual');
  assert.match(await page.textContent('#toast'), /not available/);
  await ctx.close();
});

await check('declined motion permission falls back to drag mode', async () => {
  const { ctx, page } = await newPage(browser);
  await page.click('#btn-motion');
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.starSky.mode), 'manual');
  assert.match(await page.textContent('#toast'), /declined/);
  await ctx.close();
});

await browser.close();

// Camera overlay with Chromium's fake camera.
const camBrowser = await chromium.launch({ args: [...GL_ARGS, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
await check('camera overlay shows live video under a transparent perspective sky', async () => {
  const { ctx, page } = await newPage(camBrowser, { permissions: ['camera', ...SENSORS] });
  const feeding = orient(page, 0, 100, 0, 3500);
  await page.click('#btn-camera');
  await feeding;
  await page.waitForFunction(() => window.starSky.cameraOn, null, { timeout: 5000 });
  const st = await page.evaluate(() => ({
    proj: window.starSky.view.projection, ready: document.getElementById('camera').readyState,
    cls: document.documentElement.classList.contains('camera'),
    corner: (() => { const a = window.starSky; a.draw(); return a.renderer.readPixel(5, 5); })(),
  }));
  assert.equal(st.proj, 'perspective');
  assert.ok(st.cls);
  assert.ok(st.ready >= 2, `video readyState ${st.ready}`);
  assert.equal(st.corner[3], 0, 'sky background should be transparent over the video');
  await shot(page, '06-camera');
  await page.click('#btn-camera');
  assert.equal(await page.evaluate(() => window.starSky.cameraOn), false);
  await ctx.close();
});
await camBrowser.close();

const denyBrowser = await chromium.launch({ args: [...GL_ARGS, '--use-fake-device-for-media-stream'] });
await check('denied camera permission falls back to the virtual sky', async () => {
  const { ctx, page } = await newPage(denyBrowser, { permissions: SENSORS });
  const feeding = orient(page, 0, 100, 0, 2500);
  await page.click('#btn-camera');
  await feeding;
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => ({ cam: window.starSky.cameraOn, proj: window.starSky.view.projection, mode: window.starSky.mode }));
  assert.equal(st.cam, false);
  assert.equal(st.proj, 'stereographic');
  assert.match(await page.textContent('#toast'), /virtual sky/);
  await shot(page, '07-camera-denied');
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
