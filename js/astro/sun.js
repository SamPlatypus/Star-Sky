// Low-precision solar position (Meeus, Astronomical Algorithms ch. 25), ~0.01 deg.
import { DEG, fromSpherical, wrap360 } from './math.js';
import { centuries } from './time.js';
import { eclipticToEquatorial, meanObliquity } from './coords.js';

/**
 * Geocentric Sun for a TT Julian date.
 * Returns ecliptic longitude (radians, mean equinox of date, including the
 * 20.5" aberration/light-time shift), distance in AU, and the equatorial-of-date unit vector.
 */
export function sunPosition(jdTT) {
  const T = centuries(jdTT);
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * DEG;
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  const trueLon = L0 + C;
  const nu = M + C * DEG;
  const dist = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(nu));
  const lon = wrap360(trueLon - 0.00569) * DEG;
  const eq = eclipticToEquatorial(fromSpherical(lon, 0), meanObliquity(jdTT));
  return { lon, lat: 0, dist, eq };
}
