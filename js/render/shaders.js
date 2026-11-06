// GLSL ES 1.0 shaders. The projection and refraction code must stay in sync
// with view.js / astro/coords.js (covered by test/projection.test.mjs).

const FRAG_PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

const PROJECTION = `
uniform vec3 u_right;
uniform vec3 u_up;
uniform vec3 u_fwd;
uniform float u_k;        // device px
uniform float u_a;        // 1 = stereographic, 0 = perspective
uniform float u_cullCos;
uniform vec2 u_viewport;  // device px

// Saemundsson refraction, faded out below -1 deg (see astro/coords.js).
vec3 refractEnu(vec3 v) {
  float horiz = length(v.xy);
  if (horiz < 1e-6) return v;
  float alt = atan(v.z, horiz);
  float h = degrees(alt);
  if (h < -3.0 || h > 89.9) return v;
  float hh = max(h, -1.0);
  float r = 1.02 / tan(radians(hh + 10.3 / (hh + 5.11)));
  if (h < -1.0) r *= (h + 3.0) / 2.0;
  float alt2 = alt + radians(r / 60.0);
  return vec3(v.xy * (cos(alt2) / horiz), sin(alt2));
}

// ENU direction -> clip space. Culled points get x = 2.0 (outside the clip volume).
vec4 projectEnu(vec3 h) {
  vec3 c = vec3(dot(h, u_right), dot(h, u_up), dot(h, u_fwd));
  if (c.z < u_cullCos) return vec4(2.0, 2.0, 2.0, 1.0);
  float s = u_k / (u_a + c.z);
  return vec4(c.xy * s / (u_viewport * 0.5), 0.0, 1.0);
}
`;

export const SKY_VS = `
attribute vec2 a_xy;
void main() { gl_Position = vec4(a_xy, 0.0, 1.0); }
`;

export const SKY_FS = `${FRAG_PRECISION}
uniform vec3 u_right;
uniform vec3 u_up;
uniform vec3 u_fwd;
uniform float u_k;
uniform float u_a;
uniform vec2 u_viewport;
uniform vec3 u_sunDir;     // ENU
uniform float u_day;       // 0 = night ... 1 = full daylight
uniform float u_twilight;  // strength of the twilight glow
uniform float u_ground;    // 1 = draw the ground, 0 = transparent below the horizon
uniform float u_night;     // red-light mode

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_viewport) / u_k;
  vec3 c;
  if (u_a > 0.5) {
    float r2 = dot(p, p);
    c = vec3(2.0 * p, 1.0 - r2) / (1.0 + r2);
  } else {
    c = normalize(vec3(p, 1.0));
  }
  vec3 d = c.x * u_right + c.y * u_up + c.z * u_fwd;
  float s = d.z;  // sin(altitude)
  vec3 col;
  float alpha = 1.0;
  if (s >= 0.0) {
    float t = pow(1.0 - s, 5.0);
    vec3 zen = mix(vec3(0.0, 0.004, 0.012), vec3(0.11, 0.30, 0.64), u_day);
    vec3 hor = mix(vec3(0.022, 0.034, 0.052), vec3(0.58, 0.73, 0.90), u_day);
    col = mix(zen, hor, t);
    float cs = dot(d, u_sunDir);
    col += vec3(1.0, 0.92, 0.75) * u_day * (0.30 * pow(max(cs, 0.0), 10.0) + 0.9 * pow(max(cs, 0.0), 400.0));
    vec2 dh = d.xy / max(length(d.xy), 1e-4);
    vec2 sh = u_sunDir.xy / max(length(u_sunDir.xy), 1e-4);
    float toward = max(dot(dh, sh), 0.0);
    col += vec3(0.95, 0.42, 0.16) * u_twilight * t * (0.15 + 0.85 * toward * toward);
  } else {
    float depth = sqrt(-s);
    col = mix(vec3(0.045, 0.048, 0.040), vec3(0.012, 0.013, 0.011), depth) * (1.0 + 3.0 * u_day);
    alpha = u_ground;
  }
  if (u_night > 0.5) col = vec3(dot(col, vec3(0.45, 0.45, 0.10)), 0.0, 0.0);
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

export const STAR_VS = `
attribute vec3 a_pos;
attribute float a_mag;
attribute vec3 a_color;
uniform mat3 u_eqToHor;
${PROJECTION}
uniform float u_magLimit;
uniform float u_sizeScale;   // device px radius of a magnitude-6 star
uniform float u_minRadius;   // device px
uniform float u_maxRadius;   // device px
uniform float u_belowDim;
uniform float u_brightness;
varying vec3 v_color;
varying float v_alpha;
varying float v_core;

void main() {
  vec3 h = refractEnu(u_eqToHor * a_pos);
  gl_Position = projectEnu(h);
  float r = u_sizeScale * pow(10.0, -0.12 * (a_mag - 6.0));
  float alpha = 1.0;
  if (r < u_minRadius) { float q = r / u_minRadius; alpha = q * q; r = u_minRadius; }
  r = min(r, u_maxRadius);
  alpha *= clamp((u_magLimit + 0.35 - a_mag) / 0.7, 0.0, 1.0);
  if (h.z < 0.0) alpha *= u_belowDim;
  alpha *= u_brightness;
  float halo = a_mag < 1.5 ? mix(1.7, 3.2, clamp((1.5 - a_mag) / 3.0, 0.0, 1.0)) : 1.35;
  gl_PointSize = (alpha < 0.004 || gl_Position.x > 1.5) ? 0.0 : 2.0 * r * halo;
  v_core = 1.0 / halo;
  v_color = a_color;
  v_alpha = alpha;
}
`;

export const STAR_FS = `${FRAG_PRECISION}
uniform float u_night;
varying vec3 v_color;
varying float v_alpha;
varying float v_core;
void main() {
  float d = length(gl_PointCoord * 2.0 - 1.0);
  if (d > 1.0) discard;
  float x = d / v_core;
  float core = 1.0 - smoothstep(0.45, 1.0, x);
  float halo = 0.28 * (1.0 - d) * (1.0 - d);
  float i = max(core, halo) * v_alpha;
  vec3 col = v_color;
  if (u_night > 0.5) col = vec3(dot(col, vec3(0.4, 0.45, 0.15)), 0.0, 0.0);
  gl_FragColor = vec4(col * i, i);
}
`;

export const LINE_VS = `
attribute vec3 a_p;
attribute vec3 a_q;
attribute vec2 a_side;       // x: which edge of the line (+1/-1), y: 0 at the segment start, 1 at its end
uniform mat3 u_matrix;
uniform float u_refract;
uniform float u_halfWidth;   // device px including the anti-aliasing ramp
uniform float u_belowDim;
${PROJECTION}
varying float v_side;
varying float v_alpha;
void main() {
  vec3 hp = u_matrix * a_p;
  vec3 hq = u_matrix * a_q;
  if (u_refract > 0.5) { hp = refractEnu(hp); hq = refractEnu(hq); }
  vec4 cp = projectEnu(hp);
  vec4 cq = projectEnu(hq);
  v_side = a_side.x;
  v_alpha = (hp.z + hq.z < 0.0) ? u_belowDim : 1.0;
  if (cp.x > 1.5 || cq.x > 1.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 half_vp = u_viewport * 0.5;
  vec2 sp = cp.xy * half_vp;
  vec2 sq = cq.xy * half_vp;
  vec2 dir = a_side.y > 0.5 ? sp - sq : sq - sp;
  float len = length(dir);
  dir = len > 1e-3 ? dir / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  gl_Position = vec4((sp + n * a_side.x * u_halfWidth) / half_vp, 0.0, 1.0);
}
`;

export const LINE_FS = `${FRAG_PRECISION}
uniform vec4 u_color;   // straight (non-premultiplied) rgba
uniform float u_aa;     // fraction of the half width used for the AA ramp
varying float v_side;
varying float v_alpha;
void main() {
  float a = u_color.a * v_alpha * (1.0 - smoothstep(1.0 - u_aa, 1.0, abs(v_side)));
  gl_FragColor = vec4(u_color.rgb * a, a);
}
`;

// Sun, Moon and planets: quads positioned in screen space by the CPU.
export const BODY_VS = `
attribute vec2 a_corner;   // -1..1
attribute vec2 a_center;   // device px from the viewport centre, y up
attribute vec2 a_size;     // disc radius (device px), sprite extent factor (>= 1)
attribute vec4 a_color;    // rgb, alpha
attribute vec4 a_phase;    // bright-limb direction xy, cos(phase angle), kind
attribute vec2 a_north;    // Moon: screen direction of its north pole
uniform vec2 u_viewport;
varying vec2 v_q;
varying vec4 v_color;
varying vec4 v_phase;
varying vec2 v_north;
varying float v_radius;
varying float v_extent;
void main() {
  vec2 pos = a_center + a_corner * a_size.x * a_size.y;
  gl_Position = vec4(pos / (u_viewport * 0.5), 0.0, 1.0);
  v_q = a_corner * a_size.y;
  v_color = a_color;
  v_phase = a_phase;
  v_north = a_north;
  v_radius = a_size.x;
  v_extent = a_size.y;
}
`;

export const BODY_FS = `${FRAG_PRECISION}
uniform float u_night;
varying vec2 v_q;
varying vec4 v_color;
varying vec4 v_phase;
varying vec2 v_north;
varying float v_radius;
varying float v_extent;

// Approximate lunar maria: selenographic lon, lat (deg), radius (deg), darkness.
float maria(vec3 p) {
  float m = 0.0;
  vec4 M[14];
  M[0] = vec4(-57.0, 18.0, 24.0, 0.85);
  M[1] = vec4(-16.0, 33.0, 15.0, 1.0);
  M[2] = vec4(17.5, 28.0, 9.0, 1.0);
  M[3] = vec4(31.0, 8.5, 10.0, 1.0);
  M[4] = vec4(59.0, 17.0, 6.5, 1.0);
  M[5] = vec4(51.0, -8.0, 8.0, 0.85);
  M[6] = vec4(35.0, -15.0, 5.5, 0.8);
  M[7] = vec4(-17.0, -21.0, 10.0, 0.8);
  M[8] = vec4(-39.0, -24.0, 5.5, 0.9);
  M[9] = vec4(-25.0, -8.0, 7.0, 0.7);
  M[10] = vec4(-30.0, 7.0, 7.0, 0.7);
  M[11] = vec4(-15.0, 56.0, 6.0, 0.8);
  M[12] = vec4(12.0, 57.0, 6.0, 0.8);
  M[13] = vec4(4.0, 13.0, 4.5, 0.8);
  for (int i = 0; i < 14; i++) {
    float lo = radians(M[i].x), la = radians(M[i].y);
    vec3 c = vec3(cos(la) * sin(lo), sin(la), cos(la) * cos(lo));
    float ang = degrees(acos(clamp(dot(p, c), -1.0, 1.0)));
    m = max(m, M[i].w * (1.0 - smoothstep(M[i].z * 0.55, M[i].z, ang)));
  }
  return m;
}

void main() {
  float d = length(v_q);
  float aa = 1.2 / max(v_radius, 1.0);
  float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
  float kind = v_phase.w;
  vec3 col = v_color.rgb;
  float glow;
  float discAlpha = 1.0;
  if (kind > 0.5 && kind < 1.5) {
    // Moon: shaded sphere lit from the Sun's direction; the night side only
    // shows a faint earthshine and stays mostly transparent.
    vec3 n = vec3(v_q, sqrt(max(0.0, 1.0 - d * d)));
    float cp = v_phase.z;
    vec3 s = vec3(v_phase.xy * sqrt(max(0.0, 1.0 - cp * cp)), cp);
    float lit = smoothstep(-0.04, 0.04, dot(n, s));
    vec2 west = vec2(v_north.y, -v_north.x);
    vec3 sel = vec3(dot(v_q, west), dot(v_q, v_north), n.z);
    float dark = v_radius > 6.0 ? maria(normalize(sel)) : 0.0;
    col *= (1.0 - 0.38 * dark * lit) * (0.78 + 0.22 * n.z);
    col *= mix(0.12, 1.0, lit);
    discAlpha = mix(0.22, 1.0, lit);
    glow = 0.2 * (0.15 + 0.85 * (1.0 + cp) * 0.5) * exp(-3.0 * max(d - 1.0, 0.0));
  } else if (kind > 1.5) {
    glow = 0.55 * exp(-1.8 * max(d - 1.0, 0.0));   // Sun
  } else {
    glow = 0.45 * exp(-2.6 * max(d - 1.0, 0.0));   // planet
  }
  glow *= 1.0 - smoothstep(0.6 * v_extent, v_extent, d);
  disc *= discAlpha;
  float a = max(disc, glow * (1.0 - disc)) * v_color.a;
  vec3 rgb = mix(v_color.rgb, col, disc > 0.0 ? 1.0 : 0.0);
  if (u_night > 0.5) rgb = vec3(dot(rgb, vec3(0.4, 0.45, 0.15)), 0.0, 0.0);
  gl_FragColor = vec4(rgb * a, a);
}
`;
