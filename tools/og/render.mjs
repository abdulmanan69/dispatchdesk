// Renders social preview (Open Graph) images and app icons into client/public.
// Run: cd tools/og && npm install && node render.mjs
// Fonts: IBM Plex Sans / Mono (SIL Open Font License), fetched into ./fonts. Map: us-atlas (US Census, public domain).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { geoAlbersUsa, geoPath } from 'd3-geo';
import { feature, mesh } from 'topojson-client';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../client/public');
const us = JSON.parse(fs.readFileSync(path.join(here, 'node_modules/us-atlas/states-10m.json'), 'utf8'));
const FONT_FILES = ['IBMPlexSans-400.ttf', 'IBMPlexSans-600.ttf', 'IBMPlexSans-700.ttf', 'IBMPlexMono-500.ttf'].map((f) => path.join(here, 'fonts', f));

// State FIPS -> time zone group (E, C, M, P, AK, HI); matches client/src/components/market/usStates.js
const ZONE = {
  '01': 'C', '02': 'AK', '04': 'M', '05': 'C', '06': 'P', '08': 'M', '09': 'E', '10': 'E', '11': 'E', '12': 'E', '13': 'E', '15': 'HI',
  '16': 'M', '17': 'C', '18': 'E', '19': 'C', '20': 'C', '21': 'E', '22': 'C', '23': 'E', '24': 'E', '25': 'E', '26': 'E', '27': 'C',
  '28': 'C', '29': 'C', '30': 'M', '31': 'C', '32': 'P', '33': 'E', '34': 'E', '35': 'M', '36': 'E', '37': 'E', '38': 'C', '39': 'E',
  '40': 'C', '41': 'P', '42': 'E', '44': 'E', '45': 'E', '46': 'C', '47': 'C', '48': 'C', '49': 'M', '50': 'E', '51': 'E', '53': 'P',
  '54': 'E', '55': 'C', '56': 'M',
};
const ZONE_FILL = { E: '#2563eb', C: '#16a34a', M: '#f59e0b', P: '#8b5cf6', AK: '#ef4444', HI: '#ef4444' };

const BG = '#0b0f14';
const FG = '#f8fafc';
const FG2 = '#cbd5e1';
const MUTED = '#94a3b8';
const BRAND = '#14b8a6';
const BRAND_DARK = '#0f766e';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function logo(x, y, size = 56) {
  const s = size / 32;
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <rect width="32" height="32" rx="7" fill="${BRAND_DARK}"/>
    <path d="M7 21h12v-9h4l3 4v5h-2" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="11" cy="22.5" r="2" fill="#f59e0b"/><circle cx="22" cy="22.5" r="2" fill="#f59e0b"/>
  </g>`;
}

/** US map colored by time zone, fitted into a box, with an optional dashed route between lon/lat points. */
function usMap({ x, y, w, h, route = [], lineColor = BG }) {
  const states = feature(us, us.objects.states);
  const projection = geoAlbersUsa().fitExtent([[x, y], [x + w, y + h]], states);
  const p = geoPath(projection);
  const shapes = states.features.map((f) => `<path d="${p(f)}" fill="${ZONE_FILL[ZONE[f.id]] || '#334155'}"/>`).join('');
  const borders = `<path d="${p(mesh(us, us.objects.states, (a, b) => a !== b))}" fill="none" stroke="${lineColor}" stroke-width="1.6" stroke-linejoin="round"/>`;
  let r = '';
  if (route.length > 1) {
    const pts = route.map(([lon, lat]) => projection([lon, lat])).filter(Boolean);
    r += `<polyline points="${pts.map((q) => q.join(',')).join(' ')}" fill="none" stroke="#0b0f14" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" opacity="0.45"/>`;
    r += `<polyline points="${pts.map((q) => q.join(',')).join(' ')}" fill="none" stroke="#ffffff" stroke-width="5" stroke-dasharray="14 10" stroke-linecap="round" stroke-linejoin="round"/>`;
    pts.forEach((q, i) => {
      const end = i === pts.length - 1;
      r += `<circle cx="${q[0]}" cy="${q[1]}" r="${end ? 13 : 11}" fill="${i === 0 ? BRAND : end ? '#ffffff' : '#0b0f14'}" stroke="${i === 0 || end ? '#0b0f14' : '#ffffff'}" stroke-width="3"/>`;
    });
  }
  return shapes + borders + r;
}

function chip(x, y, text, color) {
  const w = 30 + text.length * 10.4;
  return { w, svg: `<g transform="translate(${x} ${y})"><rect width="${w}" height="38" rx="19" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-opacity="0.55"/><circle cx="18" cy="19" r="5" fill="${color}"/><text x="31" y="25.5" font-size="17" font-weight="600" fill="${FG}">${esc(text)}</text></g>` };
}

function chips(x, y, items, maxW) {
  let cx = x; let cy = y; let out = '';
  for (const [t, c] of items) {
    const { w, svg } = chip(cx, cy, t, c);
    if (cx + w > x + maxW) { cx = x; cy += 50; out += chip(cx, cy, t, c).svg; cx += w + 10; continue; }
    out += svg; cx += w + 10;
  }
  return out;
}

function frame(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="IBM Plex Sans">
  <defs>
    <radialGradient id="glow" cx="78%" cy="40%" r="60%"><stop offset="0" stop-color="#134e4a" stop-opacity="0.55"/><stop offset="1" stop-color="${BG}" stop-opacity="0"/></radialGradient>
    <pattern id="dots" width="26" height="26" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.3" fill="#ffffff" fill-opacity="0.06"/></pattern>
  </defs>
  <rect width="1200" height="630" fill="${BG}"/>
  <rect width="1200" height="630" fill="url(#dots)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect x="0" y="0" width="1200" height="8" fill="${BRAND}"/>
  ${inner}
  </svg>`;
}

function text(lines, x, y, { size, weight = 700, color = FG, lh = 1.12 }) {
  return lines.map((l, i) => `<text x="${x}" y="${y + i * size * lh}" font-size="${size}" font-weight="${weight}" fill="${color}" letter-spacing="${size > 40 ? -1 : 0}">${esc(l)}</text>`).join('');
}

const ROUTE = [[-96.797, 32.777], [-90.049, 35.149], [-84.388, 33.749]]; // Dallas -> Memphis -> Atlanta

const images = {
  'og/og-default.png': frame(`
    ${logo(64, 58, 52)}
    <text x="130" y="96" font-size="34" font-weight="700" fill="${FG}">Dispatch<tspan fill="${BRAND}">Desk</tspan></text>
    ${text(['Find carriers.', 'Call them.', 'Keep trucks moving.'], 64, 212, { size: 62 })}
    ${text(['The CRM and dispatch desk for truck', 'dispatchers. Free plan, no card needed.'], 64, 418, { size: 25, weight: 400, color: FG2, lh: 1.35 })}
    ${chips(64, 492, [['Lead generator', '#3b82f6'], ['Google Voice dialer', '#22c55e'], ['Fleet map', '#f59e0b'], ['Sequences', '#a855f7']], 560)}
    <g>${usMap({ x: 640, y: 110, w: 520, h: 360, route: ROUTE })}</g>
    <text x="1136" y="586" font-size="20" font-family="IBM Plex Mono" font-weight="500" fill="${MUTED}" text-anchor="end">dispatchdesk.work.gd</text>
  `),
  'og/og-track.png': frame(`
    ${logo(64, 58, 52)}
    <text x="130" y="96" font-size="34" font-weight="700" fill="${FG}">Dispatch<tspan fill="${BRAND}">Desk</tspan></text>
    <rect x="64" y="150" width="226" height="40" rx="20" fill="${BRAND}" fill-opacity="0.18" stroke="${BRAND}" stroke-opacity="0.6"/>
    <circle cx="86" cy="170" r="6" fill="${BRAND}"/>
    <text x="102" y="177" font-size="18" font-weight="600" fill="${FG}">From your dispatcher</text>
    ${text(['Trip check-in link'], 64, 268, { size: 64 })}
    ${text(['Open this on the phone in your truck to', 'share your location and check in at', 'pickup and delivery.'], 64, 330, { size: 27, weight: 400, color: FG2, lh: 1.38 })}
    ${chips(64, 482, [['Works on one phone', '#22c55e'], ['Stop anytime', '#3b82f6'], ['PIN protected', '#f59e0b']], 560)}
    <g transform="translate(760 60)">
      <rect x="0" y="0" width="300" height="520" rx="44" fill="#111827" stroke="#334155" stroke-width="3"/>
      <rect x="18" y="20" width="264" height="480" rx="30" fill="#0f172a"/>
      <rect x="110" y="30" width="80" height="10" rx="5" fill="#1f2937"/>
      <clipPath id="screen"><rect x="18" y="56" width="264" height="250"/></clipPath>
      <g clip-path="url(#screen)">${usMap({ x: -150, y: 30, w: 460, h: 320, route: ROUTE, lineColor: '#0f172a' })}</g>
      <rect x="36" y="322" width="228" height="62" rx="14" fill="#1e293b"/>
      <text x="54" y="348" font-size="15" fill="${MUTED}">Next stop</text>
      <text x="54" y="372" font-size="19" font-weight="600" fill="${FG}">Atlanta, GA · 6:30 PM</text>
      <rect x="36" y="398" width="228" height="56" rx="14" fill="${BRAND}"/>
      <text x="150" y="433" font-size="20" font-weight="700" fill="#042f2e" text-anchor="middle">Share my location</text>
      <text x="150" y="480" font-size="14" fill="${MUTED}" text-anchor="middle">Arrived · Loaded · Delivered</text>
    </g>
  `),
  'og/og-invite.png': frame(`
    ${logo(64, 58, 52)}
    <text x="130" y="96" font-size="34" font-weight="700" fill="${FG}">Dispatch<tspan fill="${BRAND}">Desk</tspan></text>
    ${text(['You are invited to', 'a dispatch team'], 64, 230, { size: 60 })}
    ${text(['Shared pipeline, call queue, team board', 'and leaderboard. Accept to join.'], 64, 380, { size: 26, weight: 400, color: FG2, lh: 1.38 })}
    ${chips(64, 470, [['Team board', '#22c55e'], ['Leaderboard', '#f59e0b'], ['Shared leads', '#3b82f6']], 560)}
    <g>${usMap({ x: 640, y: 120, w: 520, h: 360 })}</g>
  `),
};

function icon(size, { maskable = false } = {}) {
  const pad = maskable ? size * 0.18 : 0;
  const inner = size - pad * 2;
  const s = inner / 32;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${maskable ? `<rect width="${size}" height="${size}" fill="${BRAND_DARK}"/>` : ''}
    <g transform="translate(${pad} ${pad}) scale(${s})">
      <rect width="32" height="32" rx="${maskable ? 0 : 7}" fill="${BRAND_DARK}"/>
      <path d="M7 21h12v-9h4l3 4v5h-2" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="11" cy="22.5" r="2" fill="#f59e0b"/><circle cx="22" cy="22.5" r="2" fill="#f59e0b"/>
    </g></svg>`;
}

const icons = {
  'icons/icon-192.png': icon(192),
  'icons/icon-512.png': icon(512),
  'icons/icon-maskable-512.png': icon(512, { maskable: true }),
  'apple-touch-icon.png': icon(180, { maskable: true }),
};

for (const [file, svg] of Object.entries({ ...images, ...icons })) {
  const resvg = new Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Sans' }, fitTo: { mode: 'original' } });
  const png = resvg.render().asPng();
  const out = path.join(OUT, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, png);
  console.log(`${file}  ${(png.length / 1024).toFixed(0)} KB`);
}
