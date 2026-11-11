import { describe, it, expect } from 'vitest';
import { buildIndex, parkingAlongRoute, routeAhead, thinLine, CORRIDOR_MILES } from './parkingCorridor.js';

// An east-west route along latitude 32 from -97 to -95 (about 117 miles).
const ROUTE = Array.from({ length: 201 }, (_, i) => [-97 + i * 0.01, 32]);
const MI_LAT = 1 / 69; // degrees of latitude per mile

describe('parking corridor', () => {
  it('keeps points within the corridor, in the order the truck reaches them', () => {
    const points = [
      [-95.5, 32 + 2 * MI_LAT, 1, 'Two miles north'], // 0
      [-96.5, 32 - 9 * MI_LAT, 2, 'Nine miles south'], // 1
      [-96.0, 32 + 15 * MI_LAT, 3, 'Too far'], // 2
      [-96.9, 32, 3, 'On the road'], // 3
      [-90.0, 32, 1, 'Far east'], // 4
    ];
    const res = parkingAlongRoute(points, ROUTE);
    expect(res.map((r) => r.i)).toEqual([3, 1, 0]);
    expect(res[0].off).toBeLessThan(0.01);
    expect(res[1].off).toBeCloseTo(9, 0);
    expect(res[2].off).toBeCloseTo(2, 0);
    // Miles along the route grow with longitude (about 58.7 miles per degree at 32°N).
    expect(res[0].ahead).toBeCloseTo(5.9, 0);
    expect(res[1].ahead).toBeCloseTo(29.3, 0);
    expect(res[2].ahead).toBeCloseTo(88, 0);
  });

  it('honours a custom corridor width', () => {
    const points = [[-96.5, 32 + 4 * MI_LAT, 1, '']];
    expect(parkingAlongRoute(points, ROUTE, { miles: 3 })).toEqual([]);
    expect(parkingAlongRoute(points, ROUTE, { miles: 5 })).toHaveLength(1);
    expect(CORRIDOR_MILES).toBe(10);
  });

  it('leaves out places behind the start but keeps one at the destination', () => {
    const points = [
      [-97.1, 32, 1, 'Behind'], // ~5.9 miles behind the start
      [-97.005, 32, 1, 'Just behind'], // a few hundred yards back: still counts
      [-94.95, 32, 2, 'Past the end'], // ~2.9 miles past the destination
    ];
    const res = parkingAlongRoute(points, ROUTE);
    expect(res.map((r) => r.i)).toEqual([1, 2]);
    expect(res[0].ahead).toBe(0);
  });

  it('counts the first pass when the route doubles back', () => {
    const outAndBack = [[-97, 32], [-96, 32], [-97, 32.001]];
    const res = parkingAlongRoute([[-96.5, 32.0005, 1, '']], outAndBack);
    expect(res).toHaveLength(1);
    expect(res[0].ahead).toBeLessThan(40);
  });

  it('handles empty input and reuses an index', () => {
    expect(parkingAlongRoute([], ROUTE)).toEqual([]);
    expect(parkingAlongRoute([[-96, 32, 1, '']], [])).toEqual([]);
    expect(parkingAlongRoute(null, ROUTE)).toEqual([]);
    const points = [[-96, 32, 1, '']];
    const index = buildIndex(points);
    expect(parkingAlongRoute(points, ROUTE, { index })).toHaveLength(1);
  });

  it('thins dense routes but keeps both ends', () => {
    const dense = Array.from({ length: 1001 }, (_, i) => [-97 + i * 0.0001, 32]); // ~6 miles in 1000 steps
    const thin = thinLine(dense, 0.25);
    expect(thin.length).toBeLessThan(40);
    expect(thin[0]).toEqual(dense[0]);
    expect(thin.at(-1)).toEqual(dense.at(-1));
  });

  it('is fast on a cross-country route', () => {
    const points = Array.from({ length: 30000 }, (_, i) => [-124 + (i % 300) * 0.19, 25 + Math.floor(i / 300) * 0.24, 1 + (i % 3), '']);
    const longRoute = Array.from({ length: 20000 }, (_, i) => [-118 + i * 0.0021, 34 + Math.sin(i / 2000)]);
    const t = performance.now();
    const res = parkingAlongRoute(points, longRoute);
    expect(res.length).toBeGreaterThan(50);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe('route ahead', () => {
  const trip = (id, status) => ({ id, status, origin: { city: 'Dallas', lat: 32, lng: -97 }, dest: { city: 'Shreveport', lat: 32, lng: -95 } });
  const routes = new Map([['L1', { points: ROUTE, estimate: false }]]);

  it('starts at the truck on a trip in transit', () => {
    const truck = { id: 'C1', location: { lat: 32.01, lng: -96 }, currentTrip: trip('L1', 'in_transit') };
    const r = routeAhead(truck, routes, new Map());
    expect(r.from).toBe('truck');
    expect(r.points[0][0]).toBeCloseTo(-96, 3);
    expect(r.points.at(-1)).toEqual([-95, 32]);
    expect(r.label).toBe('Dallas → Shreveport');
    expect(r.key).toBe('C1:L1');
  });

  it('adds the empty miles to the next pickup when known', () => {
    const deadheads = new Map([['C1:L1', { points: [[-98, 32], [-97.5, 32], [-97, 32]], estimate: false }]]);
    const truck = { id: 'C1', location: { lat: 32, lng: -98 }, nextTrip: trip('L1', 'booked') };
    const r = routeAhead(truck, routes, deadheads);
    expect(r.from).toBe('truck');
    expect(r.points[0]).toEqual([-98, 32]);
    expect(r.points.length).toBe(3 + ROUTE.length);
    const noDeadhead = routeAhead(truck, routes, new Map());
    expect(noDeadhead.from).toBe('pickup');
    expect(noDeadhead.points).toHaveLength(ROUTE.length);
    expect(noDeadhead.points[0]).toEqual([-97, 32]);
  });

  it('has nothing for estimates, missing routes or trucks without trips', () => {
    expect(routeAhead(null, routes)).toBeNull();
    expect(routeAhead({ id: 'C1' }, routes)).toBeNull();
    const truck = { id: 'C1', location: { lat: 32, lng: -96 }, currentTrip: trip('L2', 'in_transit') };
    expect(routeAhead(truck, routes)).toBeNull();
    const est = new Map([['L2', { points: [[-97, 32], [-95, 32]], estimate: true }]]);
    expect(routeAhead(truck, est)).toBeNull();
  });
});
