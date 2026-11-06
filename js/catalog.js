// Loads the bundled star and constellation data and prepares typed arrays
// in the equatorial-of-date frame.
import { DEG, ARCSEC, mulVec, mulMat, transpose, fromSpherical, normalize, RAD } from './astro/math.js';
import { precessionMatrix } from './astro/coords.js';

export const GREEK = ['α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'ι', 'κ', 'λ', 'μ',
  'ν', 'ξ', 'ο', 'π', 'ρ', 'σ', 'τ', 'υ', 'φ', 'χ', 'ψ', 'ω'];
const SUP = ['', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

/** Approximate star colour (linear-ish RGB 0..1) from the B-V colour index. */
export function bvToRgb(bv) {
  if (bv === null || bv === undefined || Number.isNaN(bv)) bv = 0.6;
  const b = Math.max(-0.4, Math.min(2.0, bv));
  // Ballesteros (2012) temperature, then a compact blackbody-to-sRGB fit.
  const T = 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
  const t = T / 100;
  let r, g, bl;
  if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; }
  else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); }
  if (t >= 66) bl = 255; else if (t <= 19) bl = 0; else bl = 138.52 * Math.log(t - 10) - 305.04;
  const c = (x) => Math.max(0, Math.min(255, x)) / 255;
  // Desaturate towards white: real stars look mostly white to the eye.
  const k = 0.55;
  return [c(r) * k + (1 - k), c(g) * k + (1 - k), c(bl) * k + (1 - k)];
}

export class StarCatalog {
  constructor(json) {
    this.count = json.count;
    this.hr = json.hr;
    this.ra = Float64Array.from(json.ra, (x) => x * DEG);
    this.dec = Float64Array.from(json.dec, (x) => x * DEG);
    this.mag = Float32Array.from(json.mag);
    this.bv = json.bv;
    this.sp = json.sp;
    this.pm = json.pm; // [index, pmRA*cos(dec) mas/yr, pmDec mas/yr, ...]
    this.color = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) this.color.set(bvToRgb(json.bv[i]), i * 3);
    this.names = new Map();
    for (let i = 0; i < json.names.length; i += 2) this.names.set(json.names[i], json.names[i + 1]);
    this.bayer = new Map();
    for (let i = 0; i < json.bayer.length; i += 4) {
      this.bayer.set(json.bayer[i], { letter: json.bayer[i + 1], sup: json.bayer[i + 2], con: json.bayer[i + 3] });
    }
    this.flam = new Map();
    for (let i = 0; i < json.flam.length; i += 3) this.flam.set(json.flam[i], { num: json.flam[i + 1], con: json.flam[i + 2] });
    this.vectors = new Float32Array(this.count * 3);
    this.epochJd = null;
  }

  /** Index of the first star fainter than mag (stars are sorted by magnitude). */
  countBrighterThan(mag) {
    let lo = 0, hi = this.count;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.mag[mid] <= mag) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /** Recompute equatorial-of-date unit vectors (proper motion + precession) for a TT Julian date. */
  updateEpoch(jdTT) {
    const years = (jdTT - 2451545) / 365.25;
    const P = precessionMatrix(jdTT);
    const pmIndex = new Map();
    for (let i = 0; i < this.pm.length; i += 3) pmIndex.set(this.pm[i], i);
    for (let i = 0; i < this.count; i++) {
      let ra = this.ra[i], dec = this.dec[i];
      const k = pmIndex.get(i);
      if (k !== undefined) {
        dec += this.pm[k + 2] * 1e-3 * ARCSEC * years;
        ra += (this.pm[k + 1] * 1e-3 * ARCSEC * years) / Math.max(Math.cos(dec), 1e-6);
      }
      const v = mulVec(P, fromSpherical(ra, dec));
      this.vectors[i * 3] = v[0]; this.vectors[i * 3 + 1] = v[1]; this.vectors[i * 3 + 2] = v[2];
    }
    this.epochJd = jdTT;
  }

  vector(i) {
    return [this.vectors[i * 3], this.vectors[i * 3 + 1], this.vectors[i * 3 + 2]];
  }

  /** Short designation like "α CMa" / "61 Cyg" / "HR 1234". */
  designation(i, cons, long = false) {
    const b = this.bayer.get(i);
    if (b) return `${GREEK[b.letter - 1]}${SUP[b.sup] || ''} ${long ? cons.gen[b.con] : cons.abbr[b.con]}`;
    const f = this.flam.get(i);
    if (f) return `${f.num} ${long ? cons.gen[f.con] : cons.abbr[f.con]}`;
    return `HR ${this.hr[i]}`;
  }

  displayName(i, cons) {
    return this.names.get(i) || this.designation(i, cons);
  }

  /** Constellation index from the designation, if any. */
  constellationIndex(i) {
    const b = this.bayer.get(i) || this.flam.get(i);
    return b ? b.con : -1;
  }
}

// Julian date (TT) of Besselian epoch B1875.0, the equinox of the IAU boundaries.
const JD_B1875 = 2405889.258550475;

export class Constellations {
  constructor(json) {
    this.abbr = json.abbr;
    this.name = json.name;
    this.gen = json.gen;
    this.meaning = json.meaning;
    this.rank = json.rank;
    this.labels = json.labels.map(([con, ra, dec]) => ({ con, ra: ra * DEG, dec: dec * DEG, vec: null }));
    this.lines = json.lines; // [conIndex, [[starIndex, ...], ...]]
    this.bounds = json.bounds; // [raLow h, raHigh h, decLow deg, con] in B1875
    this.toB1875 = null;
  }

  updateEpoch(jdTT) {
    const P = precessionMatrix(jdTT);
    for (const l of this.labels) l.vec = mulVec(P, fromSpherical(l.ra, l.dec));
    // date -> J2000 -> B1875
    this.toB1875 = mulMat(precessionMatrix(JD_B1875), transpose(P));
  }

  /** Line segments as pairs of star indices, with the constellation index. */
  *segments() {
    for (const [con, polylines] of this.lines) {
      for (const poly of polylines) {
        for (let k = 1; k < poly.length; k++) yield [con, poly[k - 1], poly[k]];
      }
    }
  }

  /** IAU constellation containing an equatorial-of-date direction (Roman 1987). */
  constellationAt(eq) {
    const v = normalize(mulVec(this.toB1875, eq));
    let ra = Math.atan2(v[1], v[0]) * RAD / 15;
    if (ra < 0) ra += 24;
    const dec = Math.asin(Math.max(-1, Math.min(1, v[2]))) * RAD;
    for (const [lo, hi, decLow, con] of this.bounds) {
      if (dec >= decLow && ra >= lo && ra < hi) return con;
    }
    return this.abbr.indexOf('Oct');
  }
}

export async function loadCatalogs(base = './data/') {
  const [stars, cons] = await Promise.all([
    fetch(`${base}stars.json`).then((r) => r.json()),
    fetch(`${base}constellations.json`).then((r) => r.json()),
  ]);
  return { stars: new StarCatalog(stars), cons: new Constellations(cons) };
}
