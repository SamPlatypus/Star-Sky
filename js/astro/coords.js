// Reference frames used throughout the app:
//   "J2000"  equatorial, mean equator & equinox of J2000 (catalogue frame)
//   "date"   equatorial, mean equator & equinox of date (nutation is ignored, < 20")
//   "ENU"    local horizontal: x = East, y = North, z = Up (same axes as W3C DeviceOrientation)
import { ARCSEC, DEG, RAD, mulVec, toSpherical, fromSpherical, clamp } from './math.js';
import { centuries } from './time.js';

/** Precession matrix J2000 -> mean of date (IAU 1976, Lieske), Meeus eq. 21.2. */
export function precessionMatrix(jdTT) {
  const T = centuries(jdTT);
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * ARCSEC;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * ARCSEC;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * ARCSEC;
  const cz = Math.cos(zeta), sz = Math.sin(zeta);
  const cZ = Math.cos(z), sZ = Math.sin(z);
  const ct = Math.cos(theta), st = Math.sin(theta);
  return [
    cz * ct * cZ - sz * sZ, -sz * ct * cZ - cz * sZ, -st * cZ,
    cz * ct * sZ + sz * cZ, -sz * ct * sZ + cz * cZ, -st * sZ,
    cz * st, -sz * st, ct,
  ];
}

/** Mean obliquity of the ecliptic (radians), Meeus eq. 22.2. */
export function meanObliquity(jdTT) {
  const T = centuries(jdTT);
  return (23.4392911 * 3600 - 46.815 * T - 0.00059 * T * T + 0.001813 * T * T * T) * ARCSEC;
}
export const OBLIQUITY_J2000 = 23.4392911 * DEG;

/** Rotate an ecliptic rectangular vector into the equatorial frame of the same equinox. */
export function eclipticToEquatorial(v, eps) {
  const c = Math.cos(eps), s = Math.sin(eps);
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
}
export function equatorialToEcliptic(v, eps) {
  const c = Math.cos(eps), s = Math.sin(eps);
  return [v[0], c * v[1] + s * v[2], -s * v[1] + c * v[2]];
}

/**
 * Matrix taking equatorial-of-date unit vectors to local ENU, given local
 * sidereal time and geodetic latitude (radians).
 */
export function equatorialToHorizontalMatrix(lst, lat) {
  const cL = Math.cos(lst), sL = Math.sin(lst);
  const cP = Math.cos(lat), sP = Math.sin(lat);
  return [
    -sL, cL, 0,
    -sP * cL, -sP * sL, cP,
    cP * cL, cP * sL, sP,
  ];
}

/** Azimuth (from North through East) and altitude in radians of an ENU vector. */
export function altAz(enu) {
  const az = Math.atan2(enu[0], enu[1]);
  return { az: az < 0 ? az + 2 * Math.PI : az, alt: Math.atan2(enu[2], Math.hypot(enu[0], enu[1])) };
}
export function enuFromAltAz(alt, az) {
  const c = Math.cos(alt);
  return [c * Math.sin(az), c * Math.cos(az), Math.sin(alt)];
}

/**
 * Atmospheric refraction (radians) to add to a true altitude (radians):
 * Saemundsson (1986) for standard conditions, faded out below -1 deg so the
 * mapping stays continuous and monotonic for objects below the horizon.
 * The GLSL copy in render/shaders.js must stay identical.
 */
export function refraction(alt) {
  const h = alt * RAD;
  if (h < -3 || h > 89.9) return 0;
  const hh = Math.max(h, -1);
  let r = 1.02 / Math.tan((hh + 10.3 / (hh + 5.11)) * DEG); // arcminutes
  if (h < -1) r *= (h + 3) / 2;
  return (r / 60) * DEG;
}

/** Apply refraction to an ENU unit vector (keeps azimuth). */
export function refractEnu(v) {
  const horiz = Math.hypot(v[0], v[1]);
  if (horiz < 1e-9) return v;
  const alt = Math.atan2(v[2], horiz);
  const r = refraction(alt);
  if (r === 0) return v;
  const alt2 = alt + r;
  const k = Math.cos(alt2) / horiz;
  return [v[0] * k, v[1] * k, Math.sin(alt2)];
}

export function raDecFromVector(v) {
  const s = toSpherical(v);
  return { ra: s.lon, dec: s.lat };
}
export const vectorFromRaDec = (ra, dec) => fromSpherical(ra, dec);

/**
 * Observer position in the equatorial-of-date frame, in Earth equatorial radii,
 * for geodetic latitude/longitude (radians), height (m) and local sidereal time.
 */
export function observerVector(lat, heightM, lst) {
  const f = 1 / 298.257223563;
  const u = Math.atan((1 - f) * Math.tan(lat));
  const h = heightM / 6378137;
  const rhoSin = (1 - f) * Math.sin(u) + h * Math.sin(lat);
  const rhoCos = Math.cos(u) + h * Math.cos(lat);
  return [rhoCos * Math.cos(lst), rhoCos * Math.sin(lst), rhoSin];
}

/** Position angle (radians, N through E) of direction b as seen from a, both equatorial unit vectors. */
export function positionAngle(a, b) {
  const { ra: ra1, dec: d1 } = raDecFromVector(a);
  const { ra: ra2, dec: d2 } = raDecFromVector(b);
  const dra = ra2 - ra1;
  return Math.atan2(Math.cos(d2) * Math.sin(dra), Math.sin(d2) * Math.cos(d1) - Math.cos(d2) * Math.sin(d1) * Math.cos(dra));
}

export { mulVec, clamp };
