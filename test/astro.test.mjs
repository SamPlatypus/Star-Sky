// Accuracy tests for the astronomy core. Reference values come from worked
// examples in Meeus, "Astronomical Algorithms" (2nd ed.), the official WMM2025
// test values, and astronomy-engine (a high-precision VSOP87/ELP library used
// here only as a test oracle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import * as A from 'astronomy-engine';

import { DEG, RAD, angleBetween, normalize, mulVec, fromSpherical } from '../js/astro/math.js';
import { gmst, ttFromUt, julianDay } from '../js/astro/time.js';
import { precessionMatrix, raDecFromVector, refraction, equatorialToHorizontalMatrix, altAz } from '../js/astro/coords.js';
import { sunPosition } from '../js/astro/sun.js';
import { moonPosition } from '../js/astro/moon.js';
import { geocentricPlanet, PLANETS } from '../js/astro/planets.js';
import { solarSystem, bodyDirection } from '../js/astro/ephemeris.js';
import { riseSetTransit, H0 } from '../js/astro/riseset.js';
import { magneticDeclination } from '../js/astro/geomag.js';
import { StarCatalog, Constellations } from '../js/catalog.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const arcmin = (rad) => (rad * RAD) * 60;

test('GMST matches Meeus example 12.a', () => {
  const hours = (gmst(2446895.5) * RAD) / 15;
  assert.ok(Math.abs(hours - (13 + 10 / 60 + 46.3668 / 3600)) < 1e-6);
});

test('Moon matches Meeus example 47.a', () => {
  const m = moonPosition(2448724.5);
  assert.ok(Math.abs(m.lon * RAD - 133.162655) < 2e-6);
  assert.ok(Math.abs(m.lat * RAD - -3.229126) < 2e-6);
  assert.ok(Math.abs(m.dist - 368409.7) < 0.1);
});

test('Sun matches Meeus example 25.a', () => {
  const s = sunPosition(2448908.5);
  // Meeus' apparent longitude 199.90895 includes nutation (-0.00478 sin Omega), which we omit.
  const omega = (125.04 - 1934.136 * -0.072183436) * DEG;
  assert.ok(Math.abs(s.lon * RAD - 0.00478 * Math.sin(omega) - 199.90895) < 2e-4);
  assert.ok(Math.abs(s.dist - 0.99766) < 1e-5);
});

test('precession matches Meeus example 21.b (theta Persei)', () => {
  const v = mulVec(precessionMatrix(2462088.69), fromSpherical(41.054063 * DEG, 49.22775 * DEG));
  const { ra, dec } = raDecFromVector(v);
  assert.ok(Math.abs(ra * RAD - 41.547214) < 1e-5);
  assert.ok(Math.abs(dec * RAD - 49.348483) < 1e-5);
});

function sampleDates(from, to, step = 0.173) {
  const out = [];
  for (let y = from; y <= to; y += step) out.push(new Date(Date.UTC(Math.floor(y), 0, 1) + (y % 1) * 365.25 * 864e5));
  return out;
}

const BODY = {
  mercury: A.Body.Mercury, venus: A.Body.Venus, mars: A.Body.Mars, jupiter: A.Body.Jupiter,
  saturn: A.Body.Saturn, uranus: A.Body.Uranus, neptune: A.Body.Neptune,
};

test('planet positions stay within a few arcminutes of astronomy-engine (1950-2100)', () => {
  const limits = { mercury: 1.5, venus: 2, mars: 3.5, jupiter: 2.5, saturn: 3.5, uranus: 2.5, neptune: 2 };
  for (const p of PLANETS) {
    let worst = 0;
    for (const date of sampleDates(1950, 2100)) {
      const t = A.MakeTime(date);
      const mine = normalize(geocentricPlanet(p, t.tt + 2451545).geoEq);
      const ref = A.GeoVector(BODY[p], t, false);
      worst = Math.max(worst, arcmin(angleBetween(mine, normalize([ref.x, ref.y, ref.z]))));
    }
    assert.ok(worst < limits[p], `${p}: worst ${worst.toFixed(2)}'`);
  }
});

test('Sun and Moon stay within an arcminute of astronomy-engine', () => {
  let worstSun = 0, worstMoon = 0;
  for (const date of sampleDates(1990, 2060, 0.0731)) {
    const t = A.MakeTime(date);
    const jdTT = t.tt + 2451545;
    const P = precessionMatrix(jdTT);
    const s = A.GeoVector(A.Body.Sun, t, true);
    worstSun = Math.max(worstSun, arcmin(angleBetween(sunPosition(jdTT).eq, normalize(mulVec(P, [s.x, s.y, s.z])))));
    const m = A.GeoMoon(t);
    worstMoon = Math.max(worstMoon, arcmin(angleBetween(moonPosition(jdTT).eq, normalize(mulVec(P, [m.x, m.y, m.z])))));
  }
  assert.ok(worstSun < 1, `sun ${worstSun}`);
  assert.ok(worstMoon < 0.5, `moon ${worstMoon}`);
});

test('topocentric Moon altitude agrees with astronomy-engine', () => {
  const observer = { lat: 51.48 * DEG, lon: -0.0 * DEG, height: 0 };
  for (const date of sampleDates(2024, 2028, 0.05)) {
    const jd = julianDay(date);
    const bodies = solarSystem(jd, observer);
    const M = equatorialToHorizontalMatrix(gmst(jd) + observer.lon, observer.lat);
    const mine = altAz(mulVec(M, bodies.moon.eq));
    const hor = A.Horizon(A.MakeTime(date), new A.Observer(51.48, 0, 0),
      ...(() => { const e = A.Equator(A.Body.Moon, A.MakeTime(date), new A.Observer(51.48, 0, 0), true, true); return [e.ra, e.dec]; })(), null);
    assert.ok(Math.abs(mine.alt * RAD - hor.altitude) < 0.05, `${date.toISOString()} ${mine.alt * RAD} vs ${hor.altitude}`);
  }
});

test('rise and set times agree with astronomy-engine within 2 minutes', () => {
  const sites = [[51.48, 0], [-33.87, 151.21], [40.71, -74.01], [64.15, -21.94]];
  const cases = [['sun', A.Body.Sun, H0.sun], ['moon', A.Body.Moon, H0.moon], ['jupiter', A.Body.Jupiter, H0.star]];
  for (const [lat, lon] of sites) {
    const observer = { lat: lat * DEG, lon: lon * DEG, height: 0 };
    const obs = new A.Observer(lat, lon, 0);
    for (const date of [new Date('2026-03-20T00:00Z'), new Date('2026-06-21T00:00Z'), new Date('2026-11-06T12:00Z')]) {
      const jd0 = julianDay(date);
      for (const [id, body, h0] of cases) {
        const mine = riseSetTransit((jd) => bodyDirection(id, jd, observer), jd0, observer, h0, 24);
        for (const [key, dir] of [['rise', +1], ['set', -1]]) {
          const ref = A.SearchRiseSet(body, obs, dir, A.MakeTime(date), 1);
          if (!ref || mine[key] === null) {
            assert.equal(mine[key] === null, !ref, `${id} ${key} presence at ${lat},${lon} ${date.toISOString()}`);
            continue;
          }
          const diffMin = Math.abs(mine[key] - (ref.ut + 2451545)) * 1440;
          assert.ok(diffMin < 2, `${id} ${key} at ${lat},${lon} ${date.toISOString()}: ${diffMin.toFixed(2)} min`);
        }
      }
    }
  }
});

test('refraction is continuous and keeps altitude monotonic', () => {
  let prev = -Infinity;
  for (let h = -10; h <= 90; h += 0.01) {
    const app = h + refraction(h * DEG) * RAD;
    assert.ok(app > prev, `not monotonic at ${h}`);
    prev = app;
  }
  assert.ok(Math.abs(refraction(0) * RAD * 60 - 29) < 1.5); // ~29' (Saemundsson, true alt 0)
});

test('WMM2025 declination reproduces the official test values', () => {
  const model = json('../data/wmm.json');
  const path = new URL('../tools/raw/WMM2025_TestValues.txt', import.meta.url);
  const cases = existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim().split(/\s+/).map(Number))
    : [[2025, 28, 89, -121, -99.77], [2025, 65, 43, 93, 0.5], [2025, 51, -33, 109, -5.49], [2025.5, 63, 26, 81, 0.51]];
  for (const f of cases) {
    const D = magneticDeclination(model, f[2], f[3], f[1], f[0]);
    assert.ok(Math.abs(D - f[4]) < 0.011, `${f.slice(0, 4)}: ${D} vs ${f[4]}`);
  }
});

test('catalogue: brightest stars, names, designations and constellation lookup', () => {
  const stars = new StarCatalog(json('../data/stars.json'));
  const cons = new Constellations(json('../data/constellations.json'));
  const jd = ttFromUt(julianDay(new Date('2026-11-06T00:00Z')));
  stars.updateEpoch(jd);
  cons.updateEpoch(jd);
  assert.ok(stars.count > 8000);
  assert.equal(stars.names.get(0), 'Sirius');
  assert.equal(stars.designation(0, cons), 'α CMa');
  assert.equal(stars.designation(0, cons, true), 'α Canis Majoris');
  assert.ok(stars.countBrighterThan(1.0) >= 15 && stars.countBrighterThan(1.0) <= 16);
  const byName = (n) => [...stars.names.entries()].find(([, v]) => v === n)[0];
  const conOf = (i) => cons.abbr[cons.constellationAt(stars.vector(i))];
  assert.equal(conOf(byName('Betelgeuse')), 'Ori');
  assert.equal(conOf(byName('Polaris')), 'UMi');
  assert.equal(conOf(byName('Acrux')), 'Cru');
  assert.equal(conOf(byName('Vega')), 'Lyr');
  // Every star with a Bayer/Flamsteed designation should fall in its own constellation
  // (allowing a few that sit right on a boundary).
  let mismatch = 0, total = 0;
  for (const [i, b] of stars.bayer) { total++; if (cons.constellationAt(stars.vector(i)) !== b.con) mismatch++; }
  assert.ok(mismatch / total < 0.01, `${mismatch} of ${total}`);
});
