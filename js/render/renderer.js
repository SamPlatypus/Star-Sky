// WebGL renderer: sky background, grids, constellation lines, stars and
// solar-system bodies. Geometry lives on the GPU; per frame only uniforms and
// the handful of body quads change, which keeps CPU (and battery) use low.
import { SKY_VS, SKY_FS, STAR_VS, STAR_FS, LINE_VS, LINE_FS, BODY_VS, BODY_FS } from './shaders.js';
import { DEG, angleBetween, transpose, fromSpherical } from '../astro/math.js';
import { eclipticToEquatorial } from '../astro/coords.js';

const IDENTITY = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const LINE_STRIDE = 8;
const BODY_STRIDE = 16;
const MAX_BODIES = 12;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`shader compile failed: ${log}`);
  }
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link failed: ${gl.getProgramInfoLog(p)}`);
  const info = { program: p, attr: {}, uni: {} };
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES); i < n; i++) {
    const a = gl.getActiveAttrib(p, i);
    info.attr[a.name] = gl.getAttribLocation(p, a.name);
  }
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
    const u = gl.getActiveUniform(p, i);
    info.uni[u.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, u.name);
  }
  return info;
}

function slerpArc(a, b, maxStep) {
  const ang = angleBetween(a, b);
  const n = Math.max(1, Math.ceil(ang / maxStep));
  const pts = [a];
  if (n > 1) {
    const s = Math.sin(ang);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const wa = Math.sin((1 - t) * ang) / s, wb = Math.sin(t * ang) / s;
      pts.push([a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb]);
    }
  }
  pts.push(b);
  return pts;
}

/** Build quad geometry for a list of polylines (arrays of unit vectors). */
export function buildLines(polylines, maxStep = 2 * DEG) {
  const pieces = [];
  for (const poly of polylines) {
    for (let i = 1; i < poly.length; i++) {
      const pts = slerpArc(poly[i - 1], poly[i], maxStep);
      for (let k = 1; k < pts.length; k++) pieces.push(pts[k - 1], pts[k]);
    }
  }
  const nSeg = pieces.length / 2;
  const v = new Float32Array(nSeg * 4 * LINE_STRIDE);
  const idx = new Uint16Array(nSeg * 6);
  for (let s = 0; s < nSeg; s++) {
    const p = pieces[2 * s], q = pieces[2 * s + 1];
    const base = s * 4 * LINE_STRIDE;
    const put = (o, a, b, side, end) => {
      v[o] = a[0]; v[o + 1] = a[1]; v[o + 2] = a[2];
      v[o + 3] = b[0]; v[o + 4] = b[1]; v[o + 5] = b[2];
      v[o + 6] = side; v[o + 7] = end;
    };
    put(base, p, q, 1, 0);
    put(base + LINE_STRIDE, p, q, -1, 0);
    put(base + 2 * LINE_STRIDE, q, p, 1, 1);
    put(base + 3 * LINE_STRIDE, q, p, -1, 1);
    const i0 = s * 4;
    idx.set([i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2], s * 6);
  }
  if (nSeg * 4 > 65535) throw new Error('line batch too large');
  return { vertices: v, indices: idx };
}

/** Circle of constant latitude `lat` (radians) around the z axis, as a closed polyline. */
export function latitudeCircle(lat, step = 3 * DEG) {
  const pts = [];
  for (let lon = 0; lon <= 2 * Math.PI + 1e-9; lon += step) pts.push(fromSpherical(lon, lat));
  return pts;
}
/** Meridian at longitude `lon` from latitude lat0 to lat1 (radians). */
export function meridian(lon, lat0, lat1, step = 3 * DEG) {
  const pts = [];
  for (let lat = lat0; lat <= lat1 + 1e-9; lat += step) pts.push(fromSpherical(lon, lat));
  return pts;
}

export class SkyRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.batches = {};
    this.starCount = 0;
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this.init(); this.onRestore?.(); });
    this.init();
  }

  init() {
    const gl = this.canvas.getContext('webgl', {
      alpha: true, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'low-power',
    });
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;
    this.progSky = program(gl, SKY_VS, SKY_FS);
    this.progStar = program(gl, STAR_VS, STAR_FS);
    this.progLine = program(gl, LINE_VS, LINE_FS);
    this.progBody = program(gl, BODY_VS, BODY_FS);
    const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
    this.maxPointSize = range ? range[1] : 64;

    this.skyBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.starBuffer = gl.createBuffer();
    this.bodyBuffer = gl.createBuffer();
    this.bodyData = new Float32Array(MAX_BODIES * 4 * BODY_STRIDE);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bodyBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.bodyData.byteLength, gl.DYNAMIC_DRAW);
    this.bodyIndex = gl.createBuffer();
    const bi = new Uint16Array(MAX_BODIES * 6);
    for (let i = 0; i < MAX_BODIES; i++) bi.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bodyIndex);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, bi, gl.STATIC_DRAW);

    // Re-upload any geometry that existed before a context loss.
    const old = this.batches;
    this.batches = {};
    for (const [name, b] of Object.entries(old)) this.setLines(name, b.geometry);
    if (this.starSource) this.setStars(this.starSource);
  }

  resize(cssWidth, cssHeight, dpr) {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.scale = w / cssWidth;
  }

  /** Upload stars: { vectors: Float32Array(3n), mag: Float32Array(n), color: Float32Array(3n), count }. */
  setStars(stars) {
    this.starSource = stars;
    const n = stars.count;
    const data = new Float32Array(n * 7);
    for (let i = 0; i < n; i++) {
      data[i * 7] = stars.vectors[i * 3];
      data[i * 7 + 1] = stars.vectors[i * 3 + 1];
      data[i * 7 + 2] = stars.vectors[i * 3 + 2];
      data[i * 7 + 3] = stars.mag[i];
      data[i * 7 + 4] = stars.color[i * 3];
      data[i * 7 + 5] = stars.color[i * 3 + 1];
      data[i * 7 + 6] = stars.color[i * 3 + 2];
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.starBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.starCount = n;
  }

  setLines(name, geometry) {
    const gl = this.gl;
    const b = this.batches[name] || { vbo: gl.createBuffer(), ibo: gl.createBuffer() };
    gl.bindBuffer(gl.ARRAY_BUFFER, b.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
    b.count = geometry.indices.length;
    b.geometry = geometry;
    this.batches[name] = b;
  }

  _projectionUniforms(p, view) {
    const gl = this.gl, u = p.uni;
    gl.uniform3fv(u.u_right, view.right);
    gl.uniform3fv(u.u_up, view.up);
    gl.uniform3fv(u.u_fwd, view.forward);
    gl.uniform1f(u.u_k, view.k * this.scale);
    gl.uniform1f(u.u_a, view.a);
    if (u.u_cullCos) gl.uniform1f(u.u_cullCos, view.cullCos);
    gl.uniform2f(u.u_viewport, this.canvas.width, this.canvas.height);
  }

  /**
   * Draw a frame.
   * scene: { view, background: bool, sunDir, day, twilight, night, eqToHor (row-major),
   *          lines: [{ name, frame: 'eq'|'hor', color: [r,g,b,a], width (css px), belowDim }],
   *          stars: { magLimit, sizeScale, belowDim, brightness } | null,
   *          bodies: [{ x, y (css px), radius, glow, color, alpha, kind, limb, cosPhase, north }] }
   */
  draw(scene) {
    if (this.lost) return;
    const gl = this.gl, view = scene.view, S = this.scale;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);

    if (scene.background) {
      const p = this.progSky, u = p.uni;
      gl.useProgram(p.program);
      gl.disable(gl.BLEND);
      this._projectionUniforms(p, view);
      gl.uniform3fv(u.u_sunDir, scene.sunDir);
      gl.uniform1f(u.u_day, scene.day);
      gl.uniform1f(u.u_twilight, scene.twilight);
      gl.uniform1f(u.u_ground, scene.ground ? 1 : 0);
      gl.uniform1f(u.u_night, scene.night ? 1 : 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuffer);
      gl.enableVertexAttribArray(p.attr.a_xy);
      gl.vertexAttribPointer(p.attr.a_xy, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disableVertexAttribArray(p.attr.a_xy);
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const eqMat = new Float32Array(transpose(scene.eqToHor));

    // Lines
    if (scene.lines.length) {
      const p = this.progLine, u = p.uni, A = p.attr;
      gl.useProgram(p.program);
      this._projectionUniforms(p, view);
      gl.enableVertexAttribArray(A.a_p);
      gl.enableVertexAttribArray(A.a_q);
      gl.enableVertexAttribArray(A.a_side);
      for (const l of scene.lines) {
        const b = this.batches[l.name];
        if (!b || !b.count) continue;
        const halfWidth = (l.width * S) / 2 + 0.75;
        gl.uniformMatrix3fv(u.u_matrix, false, l.frame === 'eq' ? eqMat : IDENTITY);
        gl.uniform1f(u.u_refract, l.frame === 'eq' ? 1 : 0);
        gl.uniform1f(u.u_halfWidth, halfWidth);
        gl.uniform1f(u.u_aa, Math.min(1, 1.5 / halfWidth));
        gl.uniform1f(u.u_belowDim, l.belowDim ?? 1);
        gl.uniform4fv(u.u_color, l.color);
        gl.bindBuffer(gl.ARRAY_BUFFER, b.vbo);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.ibo);
        gl.vertexAttribPointer(A.a_p, 3, gl.FLOAT, false, LINE_STRIDE * 4, 0);
        gl.vertexAttribPointer(A.a_q, 3, gl.FLOAT, false, LINE_STRIDE * 4, 12);
        gl.vertexAttribPointer(A.a_side, 2, gl.FLOAT, false, LINE_STRIDE * 4, 24);
        gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_SHORT, 0);
      }
      gl.disableVertexAttribArray(A.a_p);
      gl.disableVertexAttribArray(A.a_q);
      gl.disableVertexAttribArray(A.a_side);
    }

    // Stars
    if (scene.stars && this.starCount) {
      const st = scene.stars;
      const n = Math.min(this.starCount, st.count);
      const p = this.progStar, u = p.uni, A = p.attr;
      gl.useProgram(p.program);
      this._projectionUniforms(p, view);
      gl.uniformMatrix3fv(u.u_eqToHor, false, eqMat);
      gl.uniform1f(u.u_magLimit, st.magLimit);
      gl.uniform1f(u.u_sizeScale, st.sizeScale * S);
      gl.uniform1f(u.u_minRadius, 0.85 * S);
      gl.uniform1f(u.u_maxRadius, Math.min(st.maxRadius * S, this.maxPointSize / 6.4));
      gl.uniform1f(u.u_belowDim, st.belowDim);
      gl.uniform1f(u.u_brightness, st.brightness);
      gl.uniform1f(u.u_night, scene.night ? 1 : 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.starBuffer);
      gl.enableVertexAttribArray(A.a_pos);
      gl.enableVertexAttribArray(A.a_mag);
      gl.enableVertexAttribArray(A.a_color);
      gl.vertexAttribPointer(A.a_pos, 3, gl.FLOAT, false, 28, 0);
      gl.vertexAttribPointer(A.a_mag, 1, gl.FLOAT, false, 28, 12);
      gl.vertexAttribPointer(A.a_color, 3, gl.FLOAT, false, 28, 16);
      gl.drawArrays(gl.POINTS, 0, n);
      gl.disableVertexAttribArray(A.a_pos);
      gl.disableVertexAttribArray(A.a_mag);
      gl.disableVertexAttribArray(A.a_color);
    }

    // Sun, Moon, planets
    const bodies = scene.bodies.slice(0, MAX_BODIES);
    if (bodies.length) {
      const d = this.bodyData;
      const cw = this.canvas.width / 2, ch = this.canvas.height / 2;
      const corners = [[-1, 1], [1, 1], [-1, -1], [1, -1]];
      bodies.forEach((b, i) => {
        for (let c = 0; c < 4; c++) {
          const o = (i * 4 + c) * BODY_STRIDE;
          d[o] = corners[c][0]; d[o + 1] = corners[c][1];
          d[o + 2] = b.x * S - cw; d[o + 3] = ch - b.y * S;
          d[o + 4] = Math.max(0.5, b.radius * S); d[o + 5] = b.glow;
          d[o + 6] = b.color[0]; d[o + 7] = b.color[1]; d[o + 8] = b.color[2]; d[o + 9] = b.alpha;
          d[o + 10] = b.limb ? b.limb.x : 0; d[o + 11] = b.limb ? -b.limb.y : 0;
          d[o + 12] = b.cosPhase ?? 1; d[o + 13] = b.kind;
          d[o + 14] = b.north ? b.north.x : 0; d[o + 15] = b.north ? -b.north.y : 1;
        }
      });
      const p = this.progBody, u = p.uni, A = p.attr;
      gl.useProgram(p.program);
      gl.uniform2f(u.u_viewport, this.canvas.width, this.canvas.height);
      gl.uniform1f(u.u_night, scene.night ? 1 : 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bodyBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.subarray(0, bodies.length * 4 * BODY_STRIDE));
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bodyIndex);
      const attrs = [['a_corner', 2, 0], ['a_center', 2, 2], ['a_size', 2, 4], ['a_color', 4, 6], ['a_phase', 4, 10], ['a_north', 2, 14]];
      for (const [name, size, off] of attrs) {
        gl.enableVertexAttribArray(A[name]);
        gl.vertexAttribPointer(A[name], size, gl.FLOAT, false, BODY_STRIDE * 4, off * 4);
      }
      gl.drawElements(gl.TRIANGLES, bodies.length * 6, gl.UNSIGNED_SHORT, 0);
      for (const [name] of attrs) gl.disableVertexAttribArray(A[name]);
    }
  }
}

/** Read one pixel (CSS coordinates) right after drawing; used by automated tests. */
SkyRenderer.prototype.readPixel = function readPixel(cssX, cssY) {
  const gl = this.gl;
  const px = new Uint8Array(4);
  gl.readPixels(Math.round(cssX * this.scale), Math.round(this.canvas.height - 1 - cssY * this.scale), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return Array.from(px);
};

/** Geometry for the ecliptic of date in the equatorial-of-date frame. */
export function eclipticPolyline(eps) {
  const pts = [];
  for (let l = 0; l <= 360; l += 3) pts.push(eclipticToEquatorial(fromSpherical(l * DEG, 0), eps));
  return pts;
}
