// Magnetic declination from the World Magnetic Model (spherical harmonic
// synthesis, following the WMM technical report / reference C library).
// Used to turn compass (magnetic) headings into true headings.
import { DEG, RAD } from './math.js';

const A_WGS84 = 6378.137;
const F_WGS84 = 1 / 298.257223563;
const E2 = F_WGS84 * (2 - F_WGS84);
const R_REF = 6371.2;

/**
 * Magnetic declination (degrees, east positive) for geodetic latitude/longitude
 * in degrees, height in km above the ellipsoid and a decimal year.
 * model: { epoch, maxDegree, g, h, gd, hd } as produced by tools/build-data.mjs.
 */
export function magneticDeclination(model, latDeg, lonDeg, heightKm, year) {
  const N = model.maxDegree;
  const dt = year - model.epoch;
  const lat = latDeg * DEG, lon = lonDeg * DEG;

  // Geodetic -> geocentric spherical.
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const Rc = A_WGS84 / Math.sqrt(1 - E2 * sinLat * sinLat);
  const p = (Rc + heightKm) * cosLat;
  const z = (Rc * (1 - E2) + heightKm) * sinLat;
  const r = Math.hypot(p, z);
  const latc = Math.asin(z / r);

  // Gauss-normalised associated Legendre functions and derivatives, converted to Schmidt semi-normalised.
  const size = ((N + 1) * (N + 2)) / 2;
  const P = new Float64Array(size), dP = new Float64Array(size), S = new Float64Array(size);
  const x = Math.sin(latc), zc = Math.sqrt((1 - x) * (1 + x));
  P[0] = 1;
  for (let n = 1; n <= N; n++) {
    for (let m = 0; m <= n; m++) {
      const k = (n * (n + 1)) / 2 + m;
      if (n === m) {
        const k1 = ((n - 1) * n) / 2 + m - 1;
        P[k] = zc * P[k1];
        dP[k] = zc * dP[k1] + x * P[k1];
      } else if (n === 1 && m === 0) {
        P[k] = x * P[0];
        dP[k] = x * dP[0] - zc * P[0];
      } else {
        const k1 = ((n - 2) * (n - 1)) / 2 + m;
        const k2 = ((n - 1) * n) / 2 + m;
        if (m > n - 2) {
          P[k] = x * P[k2];
          dP[k] = x * dP[k2] - zc * P[k2];
        } else {
          const c = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
          P[k] = x * P[k2] - c * P[k1];
          dP[k] = x * dP[k2] - zc * P[k2] - c * dP[k1];
        }
      }
    }
  }
  S[0] = 1;
  for (let n = 1; n <= N; n++) {
    const k0 = (n * (n + 1)) / 2;
    S[k0] = (S[((n - 1) * n) / 2] * (2 * n - 1)) / n;
    for (let m = 1; m <= n; m++) {
      S[k0 + m] = S[k0 + m - 1] * Math.sqrt(((n - m + 1) * (m === 1 ? 2 : 1)) / (n + m));
    }
  }

  let Bx = 0, By = 0, Bz = 0;
  for (let n = 1; n <= N; n++) {
    const rr = Math.pow(R_REF / r, n + 2);
    for (let m = 0; m <= n; m++) {
      const k = (n * (n + 1)) / 2 + m;
      const g = model.g[k] + dt * model.gd[k];
      const h = model.h[k] + dt * model.hd[k];
      const cm = Math.cos(m * lon), sm = Math.sin(m * lon);
      const Pk = P[k] * S[k], dPk = -dP[k] * S[k];
      Bz -= rr * (g * cm + h * sm) * (n + 1) * Pk;
      By += rr * (g * sm - h * cm) * m * Pk;
      Bx -= rr * (g * cm + h * sm) * dPk;
    }
  }
  const cosLatc = Math.cos(latc);
  By = Math.abs(cosLatc) > 1e-10 ? By / cosLatc : 0;

  // Rotate from geocentric to geodetic frame (only X needs it for the declination).
  const psi = latc - lat;
  const X = Bx * Math.cos(psi) - Bz * Math.sin(psi);
  return Math.atan2(By, X) * RAD;
}
