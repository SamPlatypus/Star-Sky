#!/usr/bin/env node
// Generates the compact offline data files in data/ from the raw catalogues in
// tools/raw/ (see tools/fetch-sources.sh). Run: node tools/build-data.mjs
//
// Output files:
//   data/stars.json           Yale Bright Star Catalogue, V <= 6.5, sorted by magnitude
//   data/constellations.json  IAU constellations: names, lines, label points, boundaries
//   data/places.json          Cities (Natural Earth) + time-zone reference points (IANA tz)
//   data/wmm.json             World Magnetic Model 2025 coefficients (NOAA)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = process.argv[2] || join(here, 'raw');
const OUT = join(here, '..', 'data');
mkdirSync(OUT, { recursive: true });

const read = (f) => readFileSync(join(RAW, f), 'utf8');
const round = (x, d) => { const p = 10 ** d; return Math.round(x * p) / p; };
const write = (name, obj) => {
  const text = JSON.stringify(obj);
  writeFileSync(join(OUT, name), text + '\n');
  console.log(`wrote data/${name} (${(text.length / 1024).toFixed(1)} KB)`);
};

const MAG_LIMIT = 6.5;
const GREEK = ['Alp', 'Bet', 'Gam', 'Del', 'Eps', 'Zet', 'Eta', 'The', 'Iot', 'Kap', 'Lam', 'Mu',
  'Nu', 'Xi', 'Omi', 'Pi', 'Rho', 'Sig', 'Tau', 'Ups', 'Phi', 'Chi', 'Psi', 'Ome'];

// English meanings of the 88 IAU constellation names.
const MEANING = {
  And: 'Chained Maiden', Ant: 'Air Pump', Aps: 'Bird of Paradise', Aqr: 'Water Bearer', Aql: 'Eagle',
  Ara: 'Altar', Ari: 'Ram', Aur: 'Charioteer', Boo: 'Herdsman', Cae: 'Chisel', Cam: 'Giraffe',
  Cnc: 'Crab', CVn: 'Hunting Dogs', CMa: 'Great Dog', CMi: 'Little Dog', Cap: 'Sea Goat', Car: 'Keel',
  Cas: 'Seated Queen', Cen: 'Centaur', Cep: 'King', Cet: 'Sea Monster', Cha: 'Chameleon',
  Cir: 'Compasses', Col: 'Dove', Com: "Berenice's Hair", CrA: 'Southern Crown', CrB: 'Northern Crown',
  Crv: 'Crow', Crt: 'Cup', Cru: 'Southern Cross', Cyg: 'Swan', Del: 'Dolphin', Dor: 'Swordfish',
  Dra: 'Dragon', Equ: 'Little Horse', Eri: 'River', For: 'Furnace', Gem: 'Twins', Gru: 'Crane',
  Her: 'Hero', Hor: 'Pendulum Clock', Hya: 'Water Snake', Hyi: 'Lesser Water Snake', Ind: 'Indian',
  Lac: 'Lizard', Leo: 'Lion', LMi: 'Lesser Lion', Lep: 'Hare', Lib: 'Scales', Lup: 'Wolf', Lyn: 'Lynx',
  Lyr: 'Lyre', Men: 'Table Mountain', Mic: 'Microscope', Mon: 'Unicorn', Mus: 'Fly',
  Nor: "Carpenter's Square", Oct: 'Octant', Oph: 'Serpent Bearer', Ori: 'Hunter', Pav: 'Peacock',
  Peg: 'Winged Horse', Per: 'Hero', Phe: 'Phoenix', Pic: "Painter's Easel", Psc: 'Fishes',
  PsA: 'Southern Fish', Pup: 'Stern', Pyx: 'Compass', Ret: 'Reticle', Sge: 'Arrow', Sgr: 'Archer',
  Sco: 'Scorpion', Scl: 'Sculptor', Sct: 'Shield', Ser: 'Serpent', Sex: 'Sextant', Tau: 'Bull',
  Tel: 'Telescope', Tri: 'Triangle', TrA: 'Southern Triangle', Tuc: 'Toucan', UMa: 'Great Bear',
  UMi: 'Little Bear', Vel: 'Sails', Vir: 'Maiden', Vol: 'Flying Fish', Vul: 'Little Fox',
};

// ---------------------------------------------------------------- constellations (index order)
const conNames = read('constellation_names.dat').split('\n')
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => { const [abbr, ...rest] = l.trim().split(/\s+/); return { abbr, name: rest.join(' ') }; });
if (conNames.length !== 88) throw new Error(`expected 88 constellations, got ${conNames.length}`);
const conIndex = new Map(conNames.map((c, i) => [c.abbr.toUpperCase(), i]));
const conIdx = (abbr) => {
  const i = conIndex.get(abbr.toUpperCase());
  if (i === undefined) throw new Error(`unknown constellation ${abbr}`);
  return i;
};

// ---------------------------------------------------------------- stars (BSC5)
// Byte layout from the CDS ReadMe for catalogue V/50 (1-based, inclusive).
const col = (line, a, b) => line.slice(a - 1, b);

// Reduce a BSC spectral type to "class + subclass + luminosity class", e.g.
// "K1.5IIIFe-0.5" -> "K1.5III", "gG9" -> "G9III", "M1-2Ia-Iab" -> "M1Ia".
function compactSpectrum(raw) {
  let s = raw.trim();
  let lumFromPrefix = '';
  const pre = s.match(/^(sd|sg|g|d|c)(?=[OBAFGKMWCSNR])/);
  if (pre) {
    lumFromPrefix = { sd: 'VI', sg: 'I', g: 'III', d: 'V', c: 'I' }[pre[1]];
    s = s.slice(pre[1].length);
  }
  const m = s.match(/^(W[CN]|[OBAFGKMCSNR])(\d+(?:\.\d+)?)?/);
  if (!m) return '';
  const rest = s.slice(m[0].length).replace(/^-\d+(?:\.\d+)?/, '').replace(/^[:/+]+/, '');
  const lum = rest.match(/^(Ia\+|Iab|Ia|Ib|III|II|IV|VI|V|I)/);
  return m[1] + (m[2] || '') + (lum ? lum[1] : lumFromPrefix);
}
const stars = [];
for (const line of read('bsc5.dat').split('\n')) {
  if (line.length < 107) continue;
  const rah = col(line, 76, 77);
  if (!rah.trim()) continue; // the 14 non-stellar entries removed from the catalogue
  const vmag = parseFloat(col(line, 103, 107));
  if (!(vmag <= MAG_LIMIT)) continue;
  const ra = 15 * (+rah + +col(line, 78, 79) / 60 + +col(line, 80, 83) / 3600);
  const dec = (col(line, 84, 84) === '-' ? -1 : 1) *
    (+col(line, 85, 86) + +col(line, 87, 88) / 60 + +col(line, 89, 90) / 3600);
  const bvText = col(line, 110, 114).trim();
  const spRaw = col(line, 128, 147).trim();
  stars.push({
    hr: parseInt(col(line, 1, 4), 10),
    ra, dec, vmag,
    bv: bvText ? parseFloat(bvText) : null,
    sp: compactSpectrum(spRaw),
    pmra: parseFloat(col(line, 149, 154)) || 0, // arcsec/yr, already multiplied by cos(dec)
    pmde: parseFloat(col(line, 155, 160)) || 0,
    flam: parseInt(col(line, 5, 7), 10) || 0,
    bayer: col(line, 8, 10).trim(),
    sup: parseInt(col(line, 11, 11), 10) || 0,
    con: col(line, 12, 14).trim(),
  });
}
stars.sort((a, b) => a.vmag - b.vmag || a.hr - b.hr);
const byHR = new Map(stars.map((s, i) => [s.hr, i]));

// IAU WGSN proper names, joined on HR number.
const names = [];
for (const line of read('IAU-CSN.txt').split('\n')) {
  if (!line.trim() || line.startsWith('#') || line.startsWith('$')) continue;
  const m = line.match(/\sHR (\d+)\s/);
  if (!m) continue;
  const idx = byHR.get(+m[1]);
  if (idx === undefined) continue;
  const name = [...line].slice(18, 36).join('').trim() || line.slice(0, 18).trim();
  names.push([idx, name]);
}
names.sort((a, b) => a[0] - b[0]);

const out = { count: stars.length, hr: [], ra: [], dec: [], mag: [], bv: [], sp: [], pm: [], bayer: [], flam: [], names: [] };
stars.forEach((s, i) => {
  out.hr.push(s.hr);
  out.ra.push(round(s.ra, 4));
  out.dec.push(round(s.dec, 4));
  out.mag.push(round(s.vmag, 2));
  out.bv.push(s.bv === null ? null : round(s.bv, 2));
  out.sp.push(s.sp);
  if (Math.hypot(s.pmra, s.pmde) >= 0.05) out.pm.push(i, Math.round(s.pmra * 1000), Math.round(s.pmde * 1000));
  if (s.con) {
    const g = GREEK.indexOf(s.bayer);
    if (g >= 0) out.bayer.push(i, g + 1, s.sup, conIdx(s.con));
    if (s.flam) out.flam.push(i, s.flam, conIdx(s.con));
  }
});
for (const [i, n] of names) out.names.push(i, n);
write('stars.json', {
  source: 'Yale Bright Star Catalogue 5th rev. ed. (Hoffleit & Warren 1991); names: IAU WGSN',
  epoch: 2000.0, ...out,
});
console.log(`  ${stars.length} stars, ${names.length} proper names, ${out.pm.length / 3} proper motions`);

// ---------------------------------------------------------------- constellation figures
const unit = (raDeg, decDeg) => {
  const a = raDeg * Math.PI / 180, d = decDeg * Math.PI / 180;
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
};
const starVec = stars.map((s) => unit(s.ra, s.dec));
const lonToRa = (lon) => (lon < 0 ? lon + 360 : lon);
const extra = [];
const extraKey = new Map();
let matched = 0, unmatched = 0;
const MATCH_COS = Math.cos(0.25 * Math.PI / 180);
function vertexRef([lon, lat]) {
  const ra = lonToRa(lon);
  const v = unit(ra, lat);
  let best = -1, bestDot = MATCH_COS;
  for (let i = 0; i < starVec.length; i++) {
    const w = starVec[i];
    const dot = v[0] * w[0] + v[1] * w[1] + v[2] * w[2];
    if (dot > bestDot) { bestDot = dot; best = i; }
  }
  if (best >= 0) { matched++; return best; }
  unmatched++;
  const key = `${ra.toFixed(3)},${lat.toFixed(3)}`;
  if (!extraKey.has(key)) { extraKey.set(key, extra.length); extra.push([round(ra, 4), round(lat, 4)]); }
  return -1 - extraKey.get(key);
}

const d3cCons = JSON.parse(read('d3c-constellations.json')).features;
const d3cLines = JSON.parse(read('d3c-constellations.lines.json')).features;
const rank = new Array(88).fill(3);
const labels = [];
for (const f of d3cCons) {
  const i = conIdx(f.id);
  rank[i] = Math.min(rank[i], parseInt(f.properties.rank, 10) || 3);
  const [lon, lat] = f.geometry.coordinates;
  labels.push([i, round(lonToRa(lon), 2), round(lat, 2)]);
}
const gen = new Array(88).fill('');
for (const f of d3cCons) gen[conIdx(f.id)] = f.properties.gen;
const linesByCon = new Map();
for (const f of d3cLines) {
  const i = conIdx(f.id);
  const list = linesByCon.get(i) || [];
  for (const poly of f.geometry.coordinates) list.push(poly.map(vertexRef));
  linesByCon.set(i, list);
}
const lines = [...linesByCon.entries()].sort((a, b) => a[0] - b[0]);

// Constellation boundaries (Roman 1987), equinox B1875: [raLow h, raHigh h, decLow deg, con]
const bounds = read('roman87.dat').split('\n')
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => { const p = l.trim().split(/\s+/); return [+p[0], +p[1], +p[2], conIdx(p[3])]; });

write('constellations.json', {
  source: 'Lines and label points: d3-celestial (Olaf Frohn, BSD-3-Clause); boundaries: Roman (1987)',
  abbr: conNames.map((c) => c.abbr),
  name: conNames.map((c) => c.name),
  gen,
  meaning: conNames.map((c) => MEANING[c.abbr]),
  rank,
  labels,
  lines,
  extra,
  bounds,
});
console.log(`  line vertices matched to catalogue stars: ${matched}, unmatched: ${unmatched} (${extra.length} unique)`);
for (const c of conNames) if (!MEANING[c.abbr]) throw new Error(`missing meaning for ${c.abbr}`);

// ---------------------------------------------------------------- places
const places = JSON.parse(read('ne_50m_places.geojson')).features
  .map((f) => f.properties)
  .sort((a, b) => (b.pop_max || 0) - (a.pop_max || 0))
  .map((p) => [p.name, p.adm0name, round(p.latitude, 2), round(p.longitude, 2)]);

const parseIso6709 = (s) => {
  const m = s.match(/^([+-])(\d{2})(\d{2})(\d{2})?([+-])(\d{3})(\d{2})(\d{2})?$/);
  if (!m) throw new Error(`bad coordinate ${s}`);
  const lat = (m[1] === '-' ? -1 : 1) * (+m[2] + m[3] / 60 + (m[4] ? m[4] / 3600 : 0));
  const lon = (m[5] === '-' ? -1 : 1) * (+m[6] + m[7] / 60 + (m[8] ? m[8] / 3600 : 0));
  return [round(lat, 2), round(lon, 2)];
};
const tz = {};
for (const line of read('zone.tab').split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const [, coord, zone] = line.split('\t');
  tz[zone] = parseIso6709(coord);
}
let aliases = 0;
for (const line of read('tzdata.zi').split('\n')) {
  const m = line.match(/^L (\S+) (\S+)$/);
  if (m && tz[m[1]] && !tz[m[2]]) { tz[m[2]] = tz[m[1]]; aliases++; }
}
write('places.json', {
  source: 'Cities: Natural Earth (public domain); time-zone points: IANA tz database (public domain)',
  cities: places,
  tz,
});
console.log(`  ${places.length} cities, ${Object.keys(tz).length} time zones (${aliases} aliases)`);

// ---------------------------------------------------------------- WMM2025
const cofLines = read('WMM.COF').split('\n');
const [epochText, modelName] = cofLines[0].trim().split(/\s+/);
const N = 12, size = ((N + 1) * (N + 2)) / 2;
const g = new Array(size).fill(0), h = new Array(size).fill(0), gd = new Array(size).fill(0), hd = new Array(size).fill(0);
for (const line of cofLines.slice(1)) {
  const p = line.trim().split(/\s+/);
  if (p.length < 6 || p[0].startsWith('9999')) continue;
  const n = +p[0], m = +p[1], k = (n * (n + 1)) / 2 + m;
  g[k] = +p[2]; h[k] = +p[3]; gd[k] = +p[4]; hd[k] = +p[5];
}
write('wmm.json', {
  source: 'World Magnetic Model 2025, NOAA NCEI / BGS (public domain)',
  model: modelName, epoch: +epochText, maxDegree: N, g, h, gd, hd,
});
