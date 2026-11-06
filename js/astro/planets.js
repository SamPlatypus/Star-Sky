// Low-precision planet positions, heliocentric ecliptic J2000 -> geocentric equatorial.
// Mercury, Venus, Earth, Mars, Neptune: JPL "Keplerian Elements for Approximate
// Positions of the Major Planets" (E. M. Standish, Table 1).
// Jupiter, Saturn, Uranus: P. Schlyter's mean elements plus the main mutual
// perturbations (great inequality etc.), which the plain Keplerian fit lacks.
// Measured against astronomy-engine over 1950-2100: < 2' for all planets except
// Mars and Saturn (< 3.5'); see test/astro.test.mjs.
import { DEG, ARCSEC, solveKepler, wrap360, sub, length, fromSpherical } from './math.js';
import { centuries } from './time.js';
import { eclipticToEquatorial, OBLIQUITY_J2000 } from './coords.js';

// a [AU], e, I [deg], L [deg], long. perihelion [deg], long. node [deg]; then rates per century.
const ELEMENTS = {
  mercury: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593,
    0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  venus: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255,
    0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
  earth: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0,
    0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0],
  mars: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
    0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  neptune: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574,
    0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
};

export const PLANETS = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];

// Schlyter elements (ecliptic and equinox of date), d = days since 2000 Jan 0.0:
// N, dN, i, di, w, dw, a, da, e, de, M, dM (degrees, AU).
const SCHLYTER = {
  jupiter: [100.4542, 2.76854e-5, 1.303, -1.557e-7, 273.8777, 1.64505e-5, 5.20256, 0, 0.048498, 4.469e-9, 19.895, 0.0830853001],
  saturn: [113.6634, 2.3898e-5, 2.4886, -1.081e-7, 339.3939, 2.97661e-5, 9.55475, 0, 0.055546, -9.499e-9, 316.967, 0.0334442282],
  uranus: [74.0005, 1.3978e-5, 0.7733, 1.9e-8, 96.6612, 3.0565e-5, 19.18171, -1.55e-8, 0.047318, 7.45e-9, 142.5905, 0.011725806],
};

function schlyterHeliocentric(name, jdTT) {
  const d = jdTT - 2451543.5;
  const p = SCHLYTER[name];
  const N = (p[0] + p[1] * d) * DEG, i = (p[2] + p[3] * d) * DEG, w = (p[4] + p[5] * d) * DEG;
  const a = p[6] + p[7] * d, e = p[8] + p[9] * d, M = wrap360(p[10] + p[11] * d) * DEG;
  const E = solveKepler(M, e);
  const xv = a * (Math.cos(E) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const v = Math.atan2(yv, xv), r = Math.hypot(xv, yv);
  const cN = Math.cos(N), sN = Math.sin(N), cvw = Math.cos(v + w), svw = Math.sin(v + w);
  const xh = cN * cvw - sN * svw * Math.cos(i);
  const yh = sN * cvw + cN * svw * Math.cos(i);
  const zh = svw * Math.sin(i);
  let lon = Math.atan2(yh, xh);
  let lat = Math.atan2(zh, Math.hypot(xh, yh));
  const Mj = (19.895 + 0.0830853001 * d) * DEG, Ms = (316.967 + 0.0334442282 * d) * DEG;
  const Mu = (142.5905 + 0.011725806 * d) * DEG;
  const s = Math.sin, c = Math.cos;
  let dl = 0, db = 0;
  if (name === 'jupiter') {
    dl = -0.332 * s(2 * Mj - 5 * Ms - 67.6 * DEG) - 0.056 * s(2 * Mj - 2 * Ms + 21 * DEG) +
      0.042 * s(3 * Mj - 5 * Ms + 21 * DEG) - 0.036 * s(Mj - 2 * Ms) + 0.022 * c(Mj - Ms) +
      0.023 * s(2 * Mj - 3 * Ms + 52 * DEG) - 0.016 * s(Mj - 5 * Ms - 69 * DEG);
  } else if (name === 'saturn') {
    dl = 0.812 * s(2 * Mj - 5 * Ms - 67.6 * DEG) - 0.229 * c(2 * Mj - 4 * Ms - 2 * DEG) +
      0.119 * s(Mj - 2 * Ms - 3 * DEG) + 0.046 * s(2 * Mj - 6 * Ms - 69 * DEG) + 0.014 * s(Mj - 3 * Ms + 32 * DEG);
    db = -0.02 * c(2 * Mj - 4 * Ms - 2 * DEG) + 0.018 * s(2 * Mj - 6 * Ms - 49 * DEG);
  } else {
    dl = 0.04 * s(Ms - 2 * Mu + 6 * DEG) + 0.035 * s(Ms - 3 * Mu + 33 * DEG) - 0.015 * s(Mj - Mu + 20 * DEG);
  }
  // Ecliptic of date -> J2000 (general precession in longitude; the ecliptic's own motion is negligible here).
  const T = centuries(jdTT);
  lon += dl * DEG - (5029.0966 * T + 1.11113 * T * T) * ARCSEC;
  lat += db * DEG;
  const v3 = fromSpherical(lon, lat);
  return [v3[0] * r, v3[1] * r, v3[2] * r];
}

/** Heliocentric ecliptic-J2000 rectangular position (AU). */
export function heliocentric(name, jdTT) {
  if (SCHLYTER[name]) return schlyterHeliocentric(name, jdTT);
  const el = ELEMENTS[name];
  const T = centuries(jdTT);
  const a = el[0] + el[6] * T;
  const e = el[1] + el[7] * T;
  const I = (el[2] + el[8] * T) * DEG;
  const L = el[3] + el[9] * T;
  const peri = el[4] + el[10] * T;
  const node = (el[5] + el[11] * T) * DEG;
  const w = peri * DEG - node;
  const M = wrap360(L - peri) * DEG;
  const E = solveKepler(M, e);
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(node), sO = Math.sin(node);
  const cI = Math.cos(I), sI = Math.sin(I);
  return [
    (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    sw * sI * xp + cw * sI * yp,
  ];
}

const LIGHT_DAYS_PER_AU = 0.0057755183;

/**
 * Geocentric position of a planet, corrected for light time.
 * Returns heliocentric and Earth vectors (ecliptic J2000, AU), the geocentric
 * equatorial-J2000 vector (AU), and distances r (Sun-planet), delta (Earth-planet), R (Sun-Earth).
 */
export function geocentricPlanet(name, jdTT) {
  const earth = heliocentric('earth', jdTT);
  let helio = heliocentric(name, jdTT);
  let geo = sub(helio, earth);
  for (let i = 0; i < 2; i++) {
    const tau = length(geo) * LIGHT_DAYS_PER_AU;
    helio = heliocentric(name, jdTT - tau);
    geo = sub(helio, earth);
  }
  return {
    helio, earth, geoEcl: geo,
    geoEq: eclipticToEquatorial(geo, OBLIQUITY_J2000),
    r: length(helio), delta: length(geo), R: length(earth),
  };
}

// Equatorial semidiameters at 1 AU (arcsec), Meeus table.
export const SEMIDIAMETER_1AU = {
  mercury: 3.36, venus: 8.41, mars: 4.68, jupiter: 98.44, saturn: 82.73, uranus: 35.02, neptune: 33.5,
};

/**
 * Visual magnitude (Meeus ch. 41, Astronomical Almanac formulae).
 * phaseDeg: Sun-planet-Earth angle. ringTilt: Saturnicentric latitude of Earth (radians).
 */
export function planetMagnitude(name, r, delta, phaseDeg, ringTilt = 0) {
  const base = 5 * Math.log10(r * delta);
  const i = phaseDeg;
  switch (name) {
    case 'mercury': return -0.42 + base + 0.038 * i - 0.000273 * i * i + 0.000002 * i * i * i;
    case 'venus': return -4.4 + base + 0.0009 * i + 0.000239 * i * i - 0.00000065 * i * i * i;
    case 'mars': return -1.52 + base + 0.016 * i;
    case 'jupiter': return -9.4 + base + 0.005 * i;
    case 'saturn': {
      const sB = Math.abs(Math.sin(ringTilt));
      return -8.88 + base - 2.6 * sB + 1.25 * sB * sB;
    }
    case 'uranus': return -7.19 + base;
    case 'neptune': return -6.87 + base;
    default: return 99;
  }
}

/** Tilt of Saturn's rings towards Earth (radians), Meeus ch. 45 (approximate). */
export function saturnRingTilt(geoEcl, jdTT) {
  const T = centuries(jdTT);
  const inc = (28.075216 - 0.012998 * T) * DEG;
  const node = (169.50847 + 1.394681 * T) * DEG;
  const lam = Math.atan2(geoEcl[1], geoEcl[0]);
  const bet = Math.atan2(geoEcl[2], Math.hypot(geoEcl[0], geoEcl[1]));
  return Math.asin(Math.sin(inc) * Math.cos(bet) * Math.sin(lam - node) - Math.cos(inc) * Math.sin(bet));
}
