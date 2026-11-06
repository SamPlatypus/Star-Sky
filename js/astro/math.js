// Small vector / matrix helpers. Vectors are [x, y, z] arrays, matrices are
// row-major arrays of 9 numbers. Everything is plain JS so it runs in Node tests.

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const TAU = Math.PI * 2;
export const ARCSEC = DEG / 3600;

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
/** Normalise an angle to [0, 2pi). */
export const wrap2pi = (a) => ((a % TAU) + TAU) % TAU;
/** Normalise an angle to [-pi, pi). */
export const wrapPi = (a) => wrap2pi(a + Math.PI) - Math.PI;
/** Normalise degrees to [0, 360). */
export const wrap360 = (d) => ((d % 360) + 360) % 360;

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a) => Math.hypot(a[0], a[1], a[2]);
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export function normalize(a) {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
/** Angle between two unit vectors (robust for small angles). */
export function angleBetween(a, b) {
  return Math.atan2(length(cross(a, b)), dot(a, b));
}

/** Unit vector from spherical angles (radians): lon measured from +x toward +y, lat from the xy plane. */
export function fromSpherical(lon, lat) {
  const c = Math.cos(lat);
  return [c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat)];
}
/** Inverse of fromSpherical: returns { lon in [0, 2pi), lat }. */
export function toSpherical(v) {
  const lon = Math.atan2(v[1], v[0]);
  return { lon: lon < 0 ? lon + TAU : lon, lat: Math.atan2(v[2], Math.hypot(v[0], v[1])) };
}

export function mulMat(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
}
export function mulVec(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}
export const transpose = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/** Rotation of the coordinate frame about the x axis (passive rotation). */
export function rotX(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, c, s, 0, -s, c];
}
/** Rotation of the coordinate frame about the z axis (passive rotation). */
export function rotZ(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, s, 0, -s, c, 0, 0, 0, 1];
}

/** Solve Kepler's equation E - e sin E = M (radians). */
export function solveKepler(M, e) {
  M = wrapPi(M);
  let E = e < 0.8 ? M : Math.PI * Math.sign(M || 1);
  for (let i = 0; i < 30; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}
