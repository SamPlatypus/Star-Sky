// Solar-system bodies for the app: positions in the equatorial-of-date frame
// (topocentric for the Moon), plus magnitude, phase and apparent size.
import { DEG, RAD, normalize, scale, sub, length, mulVec, dot, wrap360, clamp } from './math.js';
import { ttFromUt, localSiderealTime } from './time.js';
import { precessionMatrix, observerVector } from './coords.js';
import { sunPosition } from './sun.js';
import { moonPosition, EARTH_RADIUS_KM } from './moon.js';
import { PLANETS, geocentricPlanet, planetMagnitude, saturnRingTilt, SEMIDIAMETER_1AU } from './planets.js';

export const AU_KM = 149597870.7;

export const BODIES = {
  sun: { name: 'Sun', kind: 'star', color: [1, 0.93, 0.75] },
  moon: { name: 'Moon', kind: 'moon', color: [0.92, 0.92, 0.88] },
  mercury: { name: 'Mercury', kind: 'planet', color: [0.78, 0.75, 0.72] },
  venus: { name: 'Venus', kind: 'planet', color: [1, 0.97, 0.86] },
  mars: { name: 'Mars', kind: 'planet', color: [1, 0.62, 0.42] },
  jupiter: { name: 'Jupiter', kind: 'planet', color: [1, 0.92, 0.8] },
  saturn: { name: 'Saturn', kind: 'planet', color: [0.98, 0.88, 0.66] },
  uranus: { name: 'Uranus', kind: 'planet', color: [0.7, 0.92, 0.95] },
  neptune: { name: 'Neptune', kind: 'planet', color: [0.6, 0.72, 1] },
};
export const BODY_IDS = ['sun', 'moon', ...PLANETS];

const phaseFraction = (phaseAngle) => (1 + Math.cos(phaseAngle)) / 2;

export function moonPhaseName(elongationDeg) {
  const e = wrap360(elongationDeg);
  if (e < 5 || e >= 355) return 'New Moon';
  if (e < 85) return 'Waxing crescent';
  if (e < 95) return 'First quarter';
  if (e < 175) return 'Waxing gibbous';
  if (e < 185) return 'Full Moon';
  if (e < 265) return 'Waning gibbous';
  if (e < 275) return 'Last quarter';
  return 'Waning crescent';
}

/** Equatorial-of-date direction of one body (cheap path used by rise/set searches). */
export function bodyDirection(id, jdUT, observer) {
  const jdTT = ttFromUt(jdUT);
  if (id === 'sun') return sunPosition(jdTT).eq;
  if (id === 'moon') {
    const m = moonPosition(jdTT);
    const lst = localSiderealTime(jdUT, observer.lon);
    const topo = sub(scale(m.eq, m.dist / EARTH_RADIUS_KM), observerVector(observer.lat, observer.height || 0, lst));
    return normalize(topo);
  }
  return normalize(mulVec(precessionMatrix(jdTT), geocentricPlanet(id, jdTT).geoEq));
}

/**
 * Full state of the Sun, Moon and planets at jdUT for an observer
 * { lat, lon (radians, east positive), height (m) }.
 */
export function solarSystem(jdUT, observer) {
  const jdTT = ttFromUt(jdUT);
  const P = precessionMatrix(jdTT);
  const lst = localSiderealTime(jdUT, observer.lon);
  const sun = sunPosition(jdTT);
  const out = {};

  out.sun = {
    id: 'sun', eq: sun.eq, distKm: sun.dist * AU_KM, distAU: sun.dist,
    mag: -26.74, diameter: (2 * 959.63 * DEG) / 3600 / sun.dist, phase: 1,
  };

  // Moon: topocentric direction, phase from the geocentric Sun-Moon geometry.
  const moon = moonPosition(jdTT);
  const obs = observerVector(observer.lat, observer.height || 0, lst);
  const topo = sub(scale(moon.eq, moon.dist / EARTH_RADIUS_KM), obs);
  const topoDist = length(topo) * EARTH_RADIUS_KM;
  const psi = Math.acos(clamp(dot(sun.eq, moon.eq), -1, 1)); // geocentric elongation
  const sunKm = sun.dist * AU_KM;
  const phaseAngle = Math.atan2(sunKm * Math.sin(psi), moon.dist - sunKm * Math.cos(psi));
  const elongation = (moon.lon - sun.lon) * RAD;
  const iDeg = Math.abs(phaseAngle * RAD);
  out.moon = {
    id: 'moon', eq: normalize(topo), distKm: topoDist,
    mag: -12.73 + 0.026 * iDeg + 4e-9 * iDeg ** 4,
    diameter: (2 * 358473400 * DEG) / 3600 / topoDist,
    phase: phaseFraction(phaseAngle), phaseAngle,
    elongation: wrap360(elongation), phaseName: moonPhaseName(elongation),
    waxing: wrap360(elongation) < 180,
  };

  for (const id of PLANETS) {
    const g = geocentricPlanet(id, jdTT);
    const cosI = clamp((g.r * g.r + g.delta * g.delta - g.R * g.R) / (2 * g.r * g.delta), -1, 1);
    const phaseAngleP = Math.acos(cosI);
    const tilt = id === 'saturn' ? saturnRingTilt(g.geoEcl, jdTT) : 0;
    out[id] = {
      id, eq: normalize(mulVec(P, g.geoEq)), distAU: g.delta, distKm: g.delta * AU_KM, sunDistAU: g.r,
      mag: planetMagnitude(id, g.r, g.delta, phaseAngleP * RAD, tilt),
      diameter: (2 * SEMIDIAMETER_1AU[id] * DEG) / 3600 / g.delta,
      phase: phaseFraction(phaseAngleP), phaseAngle: phaseAngleP,
    };
  }
  return out;
}
