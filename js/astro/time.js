// Time scales: Julian dates, Delta T and sidereal time.
import { DEG, wrap2pi } from './math.js';

export const J2000 = 2451545.0;
const UNIX_EPOCH_JD = 2440587.5;

/** Julian date (UTC) of a JS Date or epoch milliseconds. */
export function julianDay(date) {
  const ms = typeof date === 'number' ? date : date.getTime();
  return ms / 86400000 + UNIX_EPOCH_JD;
}
export function dateFromJulian(jd) {
  return new Date((jd - UNIX_EPOCH_JD) * 86400000);
}
export const decimalYear = (jd) => 2000 + (jd - J2000) / 365.25;

// Delta T = TT - UT in seconds. Observed values 1972-2025 (rounded), smoothly
// joined to the Morrison & Stephenson long-term parabola outside that range.
const DT_TABLE = [
  [1972, 42.2], [1980, 50.5], [1990, 56.9], [2000, 63.8], [2005, 64.7],
  [2010, 66.1], [2015, 67.6], [2017, 68.6], [2020, 69.4], [2026, 69.2],
];
const longTerm = (y) => { const u = (y - 1820) / 100; return -20 + 32 * u * u; };
export function deltaT(year) {
  const first = DT_TABLE[0], last = DT_TABLE[DT_TABLE.length - 1];
  if (year <= first[0]) {
    if (year < 1900) return longTerm(year);
    const t = (year - 1900) / (first[0] - 1900); // 1900..1972: blend to table
    return longTerm(1900) + (first[1] - longTerm(1900)) * t;
  }
  if (year >= last[0]) {
    if (year > 2150) return longTerm(year);
    const t = (year - last[0]) / (2150 - last[0]);
    return last[1] + (longTerm(2150) - last[1]) * t * t;
  }
  for (let i = 1; i < DT_TABLE.length; i++) {
    const [y1, v1] = DT_TABLE[i];
    if (year <= y1) {
      const [y0, v0] = DT_TABLE[i - 1];
      return v0 + ((v1 - v0) * (year - y0)) / (y1 - y0);
    }
  }
  return last[1];
}

/** Terrestrial Time Julian date from a UT Julian date. */
export const ttFromUt = (jdUT) => jdUT + deltaT(decimalYear(jdUT)) / 86400;

/** Julian centuries of TT since J2000. */
export const centuries = (jdTT) => (jdTT - J2000) / 36525;

/** Greenwich mean sidereal time (radians), IAU 1982, from a UT Julian date. */
export function gmst(jdUT) {
  const d = jdUT - J2000;
  const T = d / 36525;
  const deg = 280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - (T * T * T) / 38710000;
  return wrap2pi(deg * DEG);
}

/** Local mean sidereal time (radians) for an east-positive longitude in radians. */
export const localSiderealTime = (jdUT, lonRad) => wrap2pi(gmst(jdUT) + lonRad);
