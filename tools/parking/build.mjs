#!/usr/bin/env node
/**
 * Truck parking data build: downloads US truck stops, rest areas and truck parking from OpenStreetMap through the
 * public Overpass API, ONCE at development time, and writes client/public/data/truck-parking.json. The app never
 * calls Overpass at runtime; it serves the generated file as a static asset.
 *
 * Run from the repository root (Node 18+; uses the client's us-atlas and topojson-client, nothing else):
 *   node tools/parking/build.mjs            uses cached responses in tools/parking/.cache when present
 *   node tools/parking/build.mjs --refresh  downloads every region again
 *   node tools/parking/build.mjs --sample   writes a small file marked "sample" from the cache (no download)
 *   OVERPASS_URL=https://… node tools/parking/build.mjs   use another Overpass instance first
 *
 * Points outside the US outline (Canada and Mexico inside the boxes) are dropped with usa.mjs.
 * Polite to the shared Overpass servers: one request at a time, a pause between regions, a descriptive User-Agent,
 * retries with exponential backoff (and a fallback instance), and a region that times out is split in two.
 * Data © OpenStreetMap contributors, ODbL 1.0: keep the attribution wherever the data is shown.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRUCK_BRANDS, buildFile, stringify, KINDS } from './normalize.mjs';
import { loadUSFilter } from './usa.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const OUT = path.join(ROOT, 'client/public/data/truck-parking.json');
const CACHE = path.join(here, '.cache');
const args = new Set(process.argv.slice(2));

const ENDPOINTS = [
  process.env.OVERPASS_URL,
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
].filter(Boolean);
const USER_AGENT = 'DispatchDesk-truck-parking-build/1.0 (one-time data build for a dispatch app; not a runtime client)';
const PAUSE_MS = 12_000;
const TRIES = 6;

// Lower 48 in twelve boxes [south, west, north, east], plus Alaska. Small boxes keep each query well inside the
// 180 s limit on a busy server. They overlap Canada and Mexico; usa.mjs drops those points afterwards.
const REGIONS = [
  ['pacific-south', [32.3, -125.0, 39.0, -114.0]],
  ['pacific-north', [39.0, -125.0, 49.5, -114.0]],
  ['southwest', [31.2, -114.0, 39.0, -103.0]],
  ['rockies', [39.0, -114.0, 49.5, -103.0]],
  ['texas', [25.7, -107.0, 33.5, -93.5]],
  ['plains', [33.5, -103.0, 41.0, -93.5]],
  ['north-plains', [41.0, -103.0, 49.5, -93.5]],
  ['deep-south', [24.3, -93.5, 33.5, -79.5]],
  ['ohio-valley', [33.5, -93.5, 41.0, -84.0]],
  ['great-lakes', [41.0, -93.5, 49.5, -84.0]],
  ['mid-atlantic', [33.5, -84.0, 41.0, -73.5]],
  ['northeast', [41.0, -84.0, 47.6, -66.8]],
  ['alaska', [51.0, -170.0, 71.5, -129.9]],
];

// Regex-escape a brand for the Overpass string: "Sapp Bros." becomes Sapp Bros\\. (the QL string unescapes it to \.).
const quote = (s) => s.replace(/[\\"]/g, '\\$&').replace(/[.*+?^${}()|[\]]/g, '\\\\$&');
const BRAND_RE = `^(${TRUCK_BRANDS.map(quote).join('|')})$`;

/**
 * Overpass QL for one box. Fuel stations are fetched once into a set and filtered in memory; the rarer tag comes
 * first in each parking filter so the server's tag index does the heavy lifting.
 */
export function overpassQuery([s, w, n, e]) {
  return `[out:json][timeout:180][bbox:${s},${w},${n},${e}];
nwr["amenity"="fuel"]->.fuel;
(
  nwr.fuel["hgv"~"^(yes|designated)$"];
  nwr.fuel["truck_stop"="yes"];
  nwr.fuel["fuel:HGV_diesel"="yes"];
  nwr.fuel["brand"~"${BRAND_RE}",i];
  nwr.fuel["name"~"truck ?stop|truck ?plaza|travel ?(center|centre|plaza|stop)|flying j|pilot travel|love.?s travel",i];
  nwr["amenity"="truck_stop"];
  nwr["highway"="rest_area"];
  nwr["highway"="services"];
  nwr["capacity:hgv"]["amenity"="parking"];
  nwr["parking"="truck"]["amenity"="parking"];
  nwr["hgv"="designated"]["amenity"="parking"];
  nwr["amenity"="parking"]["hgv"="yes"];
);
out tags center qt;`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);

class TimedOut extends Error {}

async function post(url, query) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(240_000),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 160).replace(/\s+/g, ' ')}`), { status: res.status });
  const json = JSON.parse(text);
  // Overpass reports a query that ran out of time or memory as a remark on an otherwise normal answer.
  if (json.remark && /timed out|out of memory|runtime error/i.test(json.remark)) throw new TimedOut(json.remark);
  return json;
}

/** One box with retries and backoff; a box that keeps timing out comes back as null so the caller can split it. */
async function fetchBox(name, box) {
  let wait = 30_000;
  let slow = 0;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    const url = ENDPOINTS[(attempt - 1) % ENDPOINTS.length];
    try {
      log(`${name}: request ${attempt}/${TRIES} to ${new URL(url).host}`);
      const json = await post(url, overpassQuery(box));
      log(`${name}: ${json.elements?.length ?? 0} elements`);
      return json;
    } catch (err) {
      // A query that runs out of time (or keeps hitting a proxy's gateway timeout) is too big: split the box.
      if (err instanceof TimedOut || err.status === 504 || err.name === 'TimeoutError') slow++;
      if (slow >= 2) { log(`${name}: ${err.message.slice(0, 80)}; splitting`); return null; }
      log(`${name}: ${err.message}`);
      if (attempt === TRIES) throw err;
      log(`${name}: waiting ${Math.round(wait / 1000)} s`);
      await sleep(wait);
      wait = Math.min(wait * 2, 300_000);
    }
  }
  return null;
}

async function region(name, box, depth = 0) {
  const file = path.join(CACHE, `${name}.json`);
  if (!args.has('--refresh')) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')).elements || []; } catch { /* not cached yet */ }
  }
  const json = await fetchBox(name, box);
  await sleep(PAUSE_MS);
  let elements = json?.elements;
  if (!json) {
    if (depth >= 3) throw new Error(`${name}: still timing out after splitting`);
    // Halve the box, east-west first, then north-south.
    const [s, w, n, e] = box;
    const halves = depth % 2 === 0
      ? [[s, w, n, (w + e) / 2], [s, (w + e) / 2, n, e]]
      : [[s, w, (s + n) / 2, e], [(s + n) / 2, w, n, e]];
    elements = [...await region(`${name}-a`, halves[0], depth + 1), ...await region(`${name}-b`, halves[1], depth + 1)];
  }
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(file, JSON.stringify({ box, fetchedAt: new Date().toISOString(), elements: elements || [] }));
  return elements || [];
}

async function main() {
  const elements = [];
  const failed = [];
  for (const [name, box] of REGIONS) {
    if (args.has('--sample')) {
      try { elements.push(...(JSON.parse(await fs.readFile(path.join(CACHE, `${name}.json`), 'utf8')).elements || [])); } catch { /* skip */ }
      continue;
    }
    // A region that fails is reported and the others still download (and are cached), so a rerun only fetches the gaps.
    try { elements.push(...await region(name, box)); } catch (err) { failed.push(name); log(`${name}: failed (${err.message})`); }
  }
  if (failed.length) {
    log(`not written: ${failed.length} region(s) failed (${failed.join(', ')}). Run again later; finished regions are cached.`);
    process.exitCode = 1;
    return;
  }
  const keep = loadUSFilter();
  let file = buildFile(elements, { sample: args.has('--sample'), keep });
  if (args.has('--sample')) file = { ...file, points: file.points.filter((_, i) => i % 50 === 0) };
  const text = stringify(file);
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, text);
  const counts = KINDS.map((k, i) => (i ? `${k} ${file.points.filter((p) => p[2] === i).length}` : '')).filter(Boolean).join(', ');
  log(`wrote ${path.relative(ROOT, OUT)}: ${file.points.length} points (${counts}), ${(Buffer.byteLength(text) / 1024).toFixed(0)} KB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
