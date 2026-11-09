import { useEffect, useRef } from 'react';
import { cx } from './ui.jsx';

/**
 * Animated WebGL background: slowly drifting topographic contour lines, like a road atlas at night.
 * - Colors follow the theme (re-read when <html> class changes).
 * - Static single frame for prefers-reduced-motion; paused when off-screen or the tab is hidden.
 * - DPR capped for cheap rendering; falls back to nothing if WebGL is unavailable.
 */
const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision mediump float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uBg;
uniform vec3 uLine;
uniform vec3 uAccent;
uniform float uDensity;
uniform float uLineAlpha;

// 2D simplex-style value noise
vec2 hash(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return -1.0 + 2.0 * fract(sin(p) * 43758.5453); }
float noise(vec2 p){
  const float K1 = 0.366025404; const float K2 = 0.211324865;
  vec2 i = floor(p + (p.x + p.y) * K1);
  vec2 a = p - i + (i.x + i.y) * K2;
  vec2 o = (a.x > a.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 b = a - o + K2; vec2 c = a - 1.0 + 2.0 * K2;
  vec3 h = max(0.5 - vec3(dot(a, a), dot(b, b), dot(c, c)), 0.0);
  vec3 n = h * h * h * h * vec3(dot(a, hash(i)), dot(b, hash(i + o)), dot(c, hash(i + 1.0)));
  return dot(n, vec3(70.0));
}
float fbm(vec2 p){ float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++){ v += a * noise(p); p *= 2.02; a *= 0.5; } return v; }

void main(){
  vec2 uv = gl_FragCoord.xy / uRes.y;
  float t = uTime * 0.025;
  // Domain warp so the contours bend like terrain.
  vec2 q = vec2(fbm(uv * 1.1 + vec2(0.0, t)), fbm(uv * 1.1 + vec2(5.2, -t)));
  float h = fbm(uv * 1.3 + q * 0.9 + vec2(t * 0.6, 0.0));

  float bands = h * uDensity;
  float f = fract(bands);
  float w = fwidthApprox(bands);
  float line = 1.0 - smoothstep(0.0, w * 1.4, min(f, 1.0 - f));

  // Every 5th contour is an index line, slightly stronger.
  float idx = step(4.5, mod(floor(bands + 0.5), 5.0));
  float alpha = line * uLineAlpha * mix(1.0, 1.9, idx);

  // A slow travelling highlight along the lines, in the accent color.
  float travel = smoothstep(0.92, 1.0, sin(bands * 0.7 - uTime * 0.35 + uv.x * 1.5) * 0.5 + 0.5);
  vec3 lineColor = mix(uLine, uAccent, travel * 0.85);

  vec3 col = mix(uBg, lineColor, clamp(alpha + travel * line * 0.25, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}`;

// WebGL1 needs OES_standard_derivatives for fwidth; inject the right helper.
const fragWith = (deriv) => (deriv
  ? `#extension GL_OES_standard_derivatives : enable\n${FRAG.replace('precision mediump float;', 'precision mediump float;\nfloat fwidthApprox(float x){ return fwidth(x); }')}`
  : FRAG.replace('precision mediump float;', 'precision mediump float;\nfloat fwidthApprox(float x){ return 0.03; }'));

function hexToRgb(hex, fallback) {
  const m = String(hex || '').trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function themeColors() {
  const dark = document.documentElement.classList.contains('dark');
  const s = getComputedStyle(document.documentElement);
  return {
    bg: hexToRgb(s.getPropertyValue('--bg'), dark ? [0.08, 0.08, 0.085] : [0.98, 0.98, 0.98]),
    line: dark ? [0.55, 0.57, 0.6] : [0.42, 0.43, 0.45],
    accent: dark ? [0.17, 0.73, 0.66] : [0.06, 0.49, 0.45],
    lineAlpha: dark ? 0.16 : 0.13,
  };
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn('[shader]', gl.getShaderInfoLog(sh)); return null; }
  return sh;
}

export default function ShaderBackground({ className, density = 9, speed = 1 }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'low-power' });
    if (!gl) return undefined;
    const deriv = !!gl.getExtension('OES_standard_derivatives');
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragWith(deriv));
    if (!vs || !fs) return undefined;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return undefined;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const u = (n) => gl.getUniformLocation(prog, n);
    const uRes = u('uRes'); const uTime = u('uTime'); const uBg = u('uBg'); const uLine = u('uLine');
    const uAccent = u('uAccent'); const uDensity = u('uDensity'); const uLineAlpha = u('uLineAlpha');

    const applyTheme = () => {
      const c = themeColors();
      gl.uniform3fv(uBg, c.bg); gl.uniform3fv(uLine, c.line); gl.uniform3fv(uAccent, c.accent); gl.uniform1f(uLineAlpha, c.lineAlpha);
    };
    gl.uniform1f(uDensity, density);
    applyTheme();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
      gl.uniform2f(uRes, w, h);
    };

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let raf = 0; let visible = true; let start = performance.now(); let paused = 0;
    const draw = (now) => {
      resize();
      gl.uniform1f(uTime, reduced ? 12 : ((now - start) / 1000) * speed + 12);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const loop = (now) => { draw(now); raf = requestAnimationFrame(loop); };
    const play = () => { if (reduced || raf || !visible || document.hidden) return; start += performance.now() - (paused || performance.now()); raf = requestAnimationFrame(loop); };
    const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; paused = performance.now(); } };

    draw(performance.now());
    play();

    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? play() : stop(); });
    io.observe(canvas);
    const onVis = () => (document.hidden ? stop() : play());
    document.addEventListener('visibilitychange', onVis);
    const ro = new ResizeObserver(() => { if (!raf) draw(performance.now()); });
    ro.observe(canvas);
    const mo = new MutationObserver(() => { applyTheme(); if (!raf) draw(performance.now()); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      stop(); io.disconnect(); ro.disconnect(); mo.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs); gl.deleteBuffer(buf);
    };
  }, [density, speed]);

  return <canvas ref={ref} aria-hidden className={cx('pointer-events-none absolute inset-0 h-full w-full', className)} />;
}
