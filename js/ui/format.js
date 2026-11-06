// Formatting helpers for the info card and panels.
import { RAD } from '../astro/math.js';
import { dateFromJulian } from '../astro/time.js';

const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compassPoint = (azRad) => DIRS[Math.round((((azRad * RAD) % 360) + 360) % 360 / 22.5) % 16];

export function formatDegrees(rad, digits = 0) {
  return `${(rad * RAD).toFixed(digits)}°`;
}

export function formatRA(rad) {
  let h = (((rad * RAD) / 15) % 24 + 24) % 24;
  let hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  if (mm === 60) { hh = (hh + 1) % 24; mm = 0; }
  return `${hh}h ${String(mm).padStart(2, '0')}m`;
}

export function formatDec(rad) {
  const d = rad * RAD;
  const sign = d < 0 ? '−' : '+';
  const a = Math.abs(d);
  let dd = Math.floor(a), mm = Math.round((a - dd) * 60);
  if (mm === 60) { dd += 1; mm = 0; }
  return `${sign}${dd}° ${String(mm).padStart(2, '0')}′`;
}

export function formatLatLon(latDeg, lonDeg) {
  const la = `${Math.abs(latDeg).toFixed(2)}°${latDeg >= 0 ? 'N' : 'S'}`;
  const lo = `${Math.abs(lonDeg).toFixed(2)}°${lonDeg >= 0 ? 'E' : 'W'}`;
  return `${la} ${lo}`;
}

const timeFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }) : null;
const dayFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : null;
const fullFmt = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : null;

export const formatClock = (date) => (timeFmt ? timeFmt.format(date) : date.toTimeString().slice(0, 5));
export const formatDay = (date) => (dayFmt ? dayFmt.format(date) : date.toDateString());
export const formatFull = (date) => (fullFmt ? fullFmt.format(date) : date.toString());

/** Time of a Julian date relative to a reference date: "21:14", "tomorrow 05:02". */
export function formatEventTime(jd, refDate) {
  if (jd === null || jd === undefined) return '—';
  const d = dateFromJulian(jd);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(refDate)) / 864e5);
  const t = formatClock(d);
  if (diff === 0) return t;
  if (diff === 1) return `${t} tomorrow`;
  if (diff === -1) return `${t} yesterday`;
  return `${t} ${formatDay(d)}`;
}

export function formatDistanceKm(km) {
  if (km < 1e6) return `${Math.round(km).toLocaleString()} km`;
  const au = km / 149597870.7;
  return `${au.toFixed(au < 10 ? 3 : 2)} AU`;
}

export function formatMag(m) {
  return (m < 0 ? '−' : '') + Math.abs(m).toFixed(1);
}

const COLOR_WORD = { O: 'blue', B: 'blue-white', A: 'white', F: 'yellow-white', G: 'yellow', K: 'orange', M: 'red', C: 'red carbon', S: 'red', N: 'red carbon', R: 'red carbon', W: 'Wolf-Rayet' };
const LUM_WORD = [
  ['Ia', 'supergiant'], ['Iab', 'supergiant'], ['Ib', 'supergiant'], ['III', 'giant'], ['II', 'bright giant'],
  ['IV', 'subgiant'], ['VI', 'subdwarf'], ['V', 'main-sequence star'], ['I', 'supergiant'],
];
/** "M1Ia" -> "Red supergiant". */
export function describeSpectrum(sp) {
  if (!sp) return '';
  const cls = sp.startsWith('W') ? 'W' : sp[0];
  const color = COLOR_WORD[cls];
  if (!color) return '';
  const lumPart = sp.replace(/^(W[CN]|[A-Z])[0-9.]*/, '');
  let lum = 'star';
  for (const [k, word] of LUM_WORD) if (lumPart.startsWith(k)) { lum = word; break; }
  if (cls === 'W') return 'Wolf-Rayet star';
  const s = `${color} ${lum}`;
  return s[0].toUpperCase() + s.slice(1);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
