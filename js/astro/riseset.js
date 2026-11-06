// Generic rise / set / transit search on an altitude function.
import { DEG } from './math.js';
import { localSiderealTime } from './time.js';
import { equatorialToHorizontalMatrix } from './coords.js';

/** Standard altitudes of the centre at rise/set (radians): refraction, plus semidiameter for Sun/Moon. */
export const H0 = { star: -0.5667 * DEG, sun: -0.8333 * DEG, moon: -0.8333 * DEG };

/** True (geometric) altitude of an equatorial-of-date direction for an observer at jdUT. */
export function altitudeOf(eq, jdUT, observer) {
  const M = equatorialToHorizontalMatrix(localSiderealTime(jdUT, observer.lon), observer.lat);
  return Math.asin(Math.max(-1, Math.min(1, M[6] * eq[0] + M[7] * eq[1] + M[8] * eq[2])));
}

function bisect(f, a, fa, b) {
  for (let i = 0; i < 40 && b - a > 2 / 86400; i++) {
    const m = (a + b) / 2, fm = f(m);
    if ((fm > 0) === (fa > 0)) { a = m; fa = fm; } else { b = m; }
  }
  return (a + b) / 2;
}

function maximise(f, a, b) {
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a), fc = f(c), fd = f(d);
  for (let i = 0; i < 40 && b - a > 5 / 86400; i++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  return (a + b) / 2;
}

/**
 * Next rise, set and transit after jdStart within `hours`.
 * dirAt(jdUT) -> equatorial-of-date unit vector of the object.
 * Returns { rise, set, transit, transitAlt, state } where times are UT Julian
 * dates (or null) and state is 'up' / 'down' when no crossing happens.
 */
export function riseSetTransit(dirAt, jdStart, observer, h0 = H0.star, hours = 24) {
  const alt = (jd) => altitudeOf(dirAt(jd), jd, observer);
  const f = (jd) => alt(jd) - h0;
  const step = 10 / 1440;
  const n = Math.ceil(hours / 24 / step);
  let rise = null, set = null, transit = null, transitAlt = null;
  let t0 = jdStart, f0 = f(t0), prevF = null, prevT = null, allUp = f0 > 0, allDown = f0 <= 0;
  for (let i = 1; i <= n; i++) {
    const t1 = jdStart + i * step, f1 = f(t1);
    if (f1 > 0) allDown = false; else allUp = false;
    if (rise === null && f0 <= 0 && f1 > 0) rise = bisect(f, t0, f0, t1);
    if (set === null && f0 > 0 && f1 <= 0) set = bisect(f, t0, f0, t1);
    if (transit === null && prevF !== null && f0 >= prevF && f0 >= f1 && f0 > -Math.PI / 2 + 1e-6) {
      transit = maximise(alt, prevT, t1);
      transitAlt = alt(transit);
    }
    prevF = f0; prevT = t0; t0 = t1; f0 = f1;
  }
  return { rise, set, transit, transitAlt, state: allUp ? 'up' : allDown ? 'down' : null };
}
