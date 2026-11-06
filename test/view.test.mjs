// Projection, sensor-orientation maths and other pure helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEG, RAD, angleBetween, normalize, fromSpherical, mulVec } from '../js/astro/math.js';
import { equatorialToHorizontalMatrix, refractEnu } from '../js/astro/coords.js';
import { View } from '../js/render/view.js';
import { quatFromEuler, qRotate } from '../js/sensors/orientation.js';
import { describeSpectrum, formatRA, formatDec, compassPoint } from '../js/ui/format.js';
import { renderServiceWorker } from '../tools/build-sw.mjs';

function makeView(projection, fovDeg, az, alt) {
  const v = new View();
  v.setSize(412, 860, 2);
  v.projection = projection;
  v.fov = fovDeg * DEG;
  v.setFromAltAz(az * DEG, alt * DEG);
  v.update();
  return v;
}

test('project / unproject round-trip for both projections', () => {
  for (const projection of ['stereographic', 'perspective']) {
    for (const [az, alt] of [[0, 0], [123, 45], [250, -30], [10, 89], [300, -89]]) {
      const v = makeView(projection, projection === 'perspective' ? 60 : 100, az, alt);
      for (const [x, y] of [[206, 430], [10, 10], [400, 850], [100, 600]]) {
        const d = v.unproject(x, y);
        const p = {};
        assert.ok(v.project(d, p), `${projection} ${az}/${alt} ${x},${y} culled`);
        assert.ok(Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6, `${projection} ${p.x},${p.y} vs ${x},${y}`);
      }
    }
  }
});

test('field of view spans the shorter screen side', () => {
  for (const projection of ['stereographic', 'perspective']) {
    const v = makeView(projection, 70, 180, 20);
    const left = v.unproject(0, 430), right = v.unproject(412, 430);
    assert.ok(Math.abs(angleBetween(left, right) * RAD - 70) < 1e-6);
  }
});

test('view orientation: azimuth from north through east, screen-up toward zenith', () => {
  const v = makeView('stereographic', 60, 90, 0); // looking east
  const p = {};
  assert.ok(v.project([Math.cos(20 * DEG), 0, Math.sin(20 * DEG)], p)); // 20 deg above the east point
  assert.ok(Math.abs(p.x - 206) < 1e-6 && p.y < 430);
  v.project(normalize([1, 0.1, 0]), p); // a bit north of east -> to the left when facing east
  assert.ok(p.x < 206);
});

test('equatorial <-> ENU conversion inverts, including refraction', () => {
  const v = new View();
  v.setEquatorialToHorizontal(equatorialToHorizontalMatrix(1.234, 51.5 * DEG));
  for (let ra = 0; ra < 360; ra += 37) {
    for (const dec of [-80, -30, 0, 20, 60, 89]) {
      const eq = fromSpherical(ra * DEG, dec * DEG);
      const back = v.enuToEq(v.eqToEnu(eq));
      assert.ok(angleBetween(eq, back) * RAD * 3600 < 0.5, `ra ${ra} dec ${dec}`);
    }
  }
  // Refraction lifts objects at the horizon by roughly half a degree.
  const lifted = refractEnu([0, 1, 0]);
  assert.ok(Math.asin(lifted[2]) * RAD > 0.45 && Math.asin(lifted[2]) * RAD < 0.55);
});

test('W3C device orientation: upright phone facing north looks at the north horizon', () => {
  const q = quatFromEuler(0, 90, 0);
  const back = qRotate(q, [0, 0, -1]);
  const top = qRotate(q, [0, 1, 0]);
  assert.ok(angleBetween(back, [0, 1, 0]) < 1e-9);
  assert.ok(angleBetween(top, [0, 0, 1]) < 1e-9);
  // alpha rotates counter-clockwise seen from above: alpha = 90 faces west.
  const west = qRotate(quatFromEuler(90, 90, 0), [0, 0, -1]);
  assert.ok(angleBetween(west, [-1, 0, 0]) < 1e-9);
  // Matches the rotation matrix given in the W3C specification.
  const [a, b, g] = [30 * DEG, 50 * DEG, -20 * DEG];
  const R = [
    Math.cos(a) * Math.cos(g) - Math.sin(a) * Math.sin(b) * Math.sin(g), -Math.cos(b) * Math.sin(a), Math.cos(g) * Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.sin(g),
    Math.cos(g) * Math.sin(a) + Math.cos(a) * Math.sin(b) * Math.sin(g), Math.cos(a) * Math.cos(b), Math.sin(a) * Math.sin(g) - Math.cos(a) * Math.cos(g) * Math.sin(b),
    -Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g),
  ];
  const q2 = quatFromEuler(30, 50, -20);
  for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    assert.ok(angleBetween(qRotate(q2, v), mulVec(R, v)) < 1e-9);
  }
});

test('formatting helpers', () => {
  assert.equal(describeSpectrum('M1Ia'), 'Red supergiant');
  assert.equal(describeSpectrum('A1V'), 'White main-sequence star');
  assert.equal(describeSpectrum('K0III'), 'Orange giant');
  assert.equal(formatRA(6 * 15 * DEG + 45 / 60 * 15 * DEG), '6h 45m');
  assert.equal(formatDec(-16.716 * DEG), '−16° 43′');
  assert.equal(compassPoint(225 * DEG), 'SW');
});

test('sw.js is up to date with the app files (run `npm run build:sw`)', () => {
  const current = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.equal(current, renderServiceWorker());
});
