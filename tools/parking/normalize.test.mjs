// Run: node --test tools/parking/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KIND, FLAGS, classify, cleanName, flagsOf, hgvSpaces, isTruckBrand, toPoint, dedupe, absorbLots, packPoint, normalize, buildFile, stringify, meters,
} from './normalize.mjs';
import { overpassQuery } from './build.mjs';
import { ringsOf, insideRings, usFilter } from './usa.mjs';

test('classifies truck stops, rest areas and truck parking', () => {
  assert.equal(classify({ amenity: 'fuel', hgv: 'yes' }), KIND.truck_stop);
  assert.equal(classify({ amenity: 'fuel', 'fuel:HGV_diesel': 'yes' }), KIND.truck_stop);
  assert.equal(classify({ amenity: 'fuel', brand: "Love's" }), KIND.truck_stop);
  assert.equal(classify({ amenity: 'fuel', brand: 'Love’s' }), KIND.truck_stop, 'curly apostrophe');
  assert.equal(classify({ amenity: 'fuel', name: 'Iowa 80 Truckstop' }), KIND.truck_stop);
  assert.equal(classify({ amenity: 'truck_stop' }), KIND.truck_stop);
  assert.equal(classify({ highway: 'rest_area' }), KIND.rest_area);
  assert.equal(classify({ highway: 'services', name: 'Molly Pitcher Service Area' }), KIND.rest_area);
  assert.equal(classify({ amenity: 'parking', hgv: 'designated' }), KIND.truck_parking);
  assert.equal(classify({ amenity: 'parking', parking: 'truck' }), KIND.truck_parking);
  assert.equal(classify({ amenity: 'parking', 'capacity:hgv': '40' }), KIND.truck_parking);
});

test('sorts out highway=services: truck stops, service plazas and mis-tagged shops', () => {
  assert.equal(classify({ highway: 'services', brand: "Love's", name: "Love's Travel Stop", hgv: 'yes' }), KIND.truck_stop);
  assert.equal(classify({ highway: 'services', hgv: 'only' }), KIND.truck_stop);
  assert.equal(classify({ highway: 'services', name: 'Walt Whitman Service Area' }, 'node'), KIND.rest_area);
  assert.equal(classify({ highway: 'services' }, 'way'), KIND.rest_area, 'an unnamed area along a highway');
  assert.equal(classify({ highway: 'services' }, 'node'), 0, 'an unnamed point');
  assert.equal(classify({ highway: 'services', name: 'Lucky Spot' }, 'way'), 0);
  assert.equal(classify({ highway: 'services', name: 'Senior Services', amenity: 'social_facility' }), 0);
  assert.equal(classify({ amenity: 'parking', hgv: 'only' }), KIND.truck_parking);
});

test('leaves out places that are not for trucks', () => {
  assert.equal(classify({ amenity: 'fuel', brand: 'Shell' }), 0);
  assert.equal(classify({ amenity: 'fuel', brand: 'Pilot', hgv: 'no' }), 0);
  assert.equal(classify({ amenity: 'fuel', brand: 'TAco Fuel' }), 0, 'brands match whole');
  assert.equal(classify({ highway: 'rest_area', hgv: 'no' }), 0);
  assert.equal(classify({ amenity: 'parking' }), 0);
  assert.equal(classify({ amenity: 'parking', 'capacity:hgv': '0' }), 0);
  assert.equal(classify({ amenity: 'parking', hgv: 'designated', access: 'private' }), 0);
  assert.equal(classify({}), 0);
  assert.equal(isTruckBrand(' flying j '), true);
});

test('cleans names and reads flags and truck spaces', () => {
  assert.equal(cleanName({ name: '  Pilot   Travel Center  #123 ' }), 'Pilot Travel Center #123');
  assert.equal(cleanName({ brand: 'Flying J' }), 'Flying J');
  assert.equal(cleanName({ name: 'Rest Area' }), '', 'generic names are dropped');
  assert.equal(cleanName({}), '');
  assert.equal(cleanName({ name: 'x'.repeat(80) }).length, 64);
  assert.equal(flagsOf({ opening_hours: '24/7', shower: 'yes', toilets: 'yes', fee: 'yes' }), FLAGS.open24h | FLAGS.showers | FLAGS.toilets | FLAGS.paid);
  assert.equal(flagsOf({ opening_hours: 'Mo-Fr 08:00-17:00' }), 0);
  assert.equal(hgvSpaces({ 'capacity:hgv': '~120' }), 120);
  assert.equal(hgvSpaces({ 'capacity:hgv': 'yes' }), 0);
});

test('turns nodes and areas into rounded points', () => {
  const node = toPoint({ type: 'node', id: 1, lat: 32.123456, lon: -97.987654, tags: { amenity: 'fuel', hgv: 'yes', name: 'Stop' } });
  assert.deepEqual(node, { lng: -97.9877, lat: 32.1235, kind: 1, name: 'Stop', flags: 0, spaces: 0 });
  const way = toPoint({ type: 'way', id: 2, center: { lat: 40, lon: -80 }, tags: { highway: 'rest_area' } });
  assert.equal(way.kind, KIND.rest_area);
  assert.equal(toPoint({ type: 'way', id: 3, tags: { highway: 'rest_area' } }), null, 'no position');
  assert.equal(toPoint({ type: 'node', id: 4, lat: 1, lon: 1, tags: { amenity: 'bench' } }), null);
});

test('dedupes the same kind within 150 m and keeps the best record', () => {
  const a = { lng: -97.0, lat: 32.0, kind: 1, name: '', flags: FLAGS.open24h, spaces: 0 };
  const b = { lng: -97.0008, lat: 32.0004, kind: 1, name: "Love's Travel Stop", flags: 0, spaces: 0 }; // ~90 m away
  const far = { lng: -97.01, lat: 32.0, kind: 1, name: 'Far', flags: 0, spaces: 0 }; // ~940 m away
  const other = { lng: -97.0001, lat: 32.0, kind: 2, name: '', flags: 0, spaces: 0 }; // other kind, same spot
  assert.ok(meters(a, b) < 150 && meters(a, far) > 150);
  const out = dedupe([a, b, far, other]);
  assert.equal(out.length, 3);
  const kept = out.find((p) => p.kind === 1 && p.name === "Love's Travel Stop");
  assert.equal(kept.flags, FLAGS.open24h, 'inherits flags from the duplicate');
  assert.equal(a.flags, FLAGS.open24h, 'inputs are not changed');
  assert.equal(b.flags, 0, 'inputs are not changed');
});

test('dedupe never merges two businesses, and merges one business up to 300 m', () => {
  const pilot = { lng: -97.0, lat: 32.0, kind: 1, name: 'Pilot Travel Center', flags: 0, spaces: 0 };
  const loves = { lng: -97.0005, lat: 32.0, kind: 1, name: "Love's Travel Stop", flags: 0, spaces: 0 }; // ~47 m
  assert.equal(dedupe([pilot, loves]).length, 2);
  const pilotArea = { lng: -97.0025, lat: 32.0, kind: 1, name: 'Pilot', flags: 0, spaces: 120 }; // ~236 m
  assert.ok(meters(pilot, pilotArea) > 150 && meters(pilot, pilotArea) < 300);
  const out = dedupe([pilot, pilotArea]);
  assert.equal(out.length, 1);
  assert.equal(out[0].spaces, 120);
  const unnamedFar = { lng: -97.0025, lat: 32.0, kind: 1, name: '', flags: 0, spaces: 0 };
  assert.equal(dedupe([pilot, unnamedFar]).length, 2, 'an unnamed place merges only within 150 m');
});

test('dedupe works across a cell boundary and at high latitude', () => {
  const p = { lng: -149.9, lat: 61.2, kind: 2, name: '', flags: 0, spaces: 0 };
  const q = { ...p, lng: -149.9 + 0.0025 }; // ~135 m east at 61°N, likely in a neighbouring cell
  assert.ok(meters(p, q) < 150);
  assert.equal(dedupe([p, q]).length, 1);
});

test('truck parking next to a truck stop folds into the stop', () => {
  const stop = { lng: -97, lat: 32, kind: 1, name: 'Pilot', flags: 0, spaces: 0 };
  const lot = { lng: -97.0015, lat: 32.001, kind: 3, name: 'Pilot truck lot', flags: FLAGS.paid, spaces: 85 }; // ~180 m
  const alone = { lng: -97.2, lat: 32.1, kind: 3, name: '', flags: 0, spaces: 20 };
  const out = absorbLots([stop, lot, alone]);
  assert.equal(out.length, 2);
  assert.equal(out[0].spaces, 85);
  assert.equal(out[0].flags, FLAGS.paid);
  assert.equal(out[0].name, 'Pilot', 'keeps its own name');
});

test('packs points compactly and normalizes a whole response', () => {
  assert.deepEqual(packPoint({ lng: 1, lat: 2, kind: 3, name: '', flags: 0, spaces: 0 }), [1, 2, 3, '']);
  assert.deepEqual(packPoint({ lng: 1, lat: 2, kind: 3, name: 'A', flags: 1, spaces: 0 }), [1, 2, 3, 'A', 1]);
  assert.deepEqual(packPoint({ lng: 1, lat: 2, kind: 3, name: 'A', flags: 0, spaces: 9 }), [1, 2, 3, 'A', 0, 9]);
  const elements = [
    { type: 'node', id: 1, lat: 35, lon: -101, tags: { amenity: 'fuel', brand: 'Flying J' } },
    { type: 'node', id: 1, lat: 35, lon: -101, tags: { amenity: 'fuel', brand: 'Flying J' } }, // same element twice
    { type: 'way', id: 9, center: { lat: 35.0005, lon: -101.0005 }, tags: { amenity: 'fuel', hgv: 'yes', opening_hours: '24/7' } },
    { type: 'node', id: 2, lat: 36, lon: -100, tags: { highway: 'rest_area' } },
    { type: 'node', id: 3, lat: 55, lon: -100, tags: { highway: 'rest_area' } }, // outside `keep`
    { type: 'node', id: 4, lat: 36, lon: -100, tags: { amenity: 'cafe' } },
  ];
  const pts = normalize(elements, { keep: (lng, lat) => lat < 50 });
  assert.deepEqual(pts, [[-101, 35, 1, 'Flying J', FLAGS.open24h], [-100, 36, 2, '']]);
});

test('builds a file with attribution and one point per line', () => {
  const file = buildFile([{ type: 'node', id: 1, lat: 35, lon: -101, tags: { highway: 'rest_area', name: 'I-40 Rest Area "West"' } }], { generatedAt: 'x' });
  assert.equal(file.source, '© OpenStreetMap contributors (ODbL)');
  assert.equal(file.version, 1);
  assert.equal(file.sample, undefined);
  const text = stringify(file);
  assert.deepEqual(JSON.parse(text), file);
  assert.equal(text.split('\n').length, 4);
  assert.equal(buildFile([], { sample: true }).sample, true);
});

test('Overpass query is bounded and escaped', () => {
  const q = overpassQuery([24, -100, 37, -88]);
  assert.match(q, /^\[out:json\]\[timeout:180\]\[bbox:24,-100,37,-88\];/);
  assert.match(q, /Sapp Bros\\\\\./);
  assert.match(q, /out tags center qt;$/);
});

test('US outline filter: inside, outside, holes and the shore buffer', () => {
  const square = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] };
  const rings = ringsOf(square);
  assert.equal(insideRings(rings, 1, 1), true);
  assert.equal(insideRings(rings, 5, 5), false, 'hole');
  assert.equal(insideRings(rings, 11, 1), false);
  const keep = usFilter(rings, 0.02);
  assert.equal(keep(10.01, 5), true, 'just off the edge');
  assert.equal(keep(10.5, 5), false);
});
