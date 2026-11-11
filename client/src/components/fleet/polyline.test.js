import { describe, it, expect } from 'vitest';
import { decodePolyline, projectOnRoute, splitRoute, boundsOf, segmentMiles } from './polyline.js';

describe('route geometry', () => {
  it('decodes the reference polyline', () => {
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(pts).toHaveLength(3);
    expect(pts[0][0]).toBeCloseTo(-120.2, 5);
    expect(pts[0][1]).toBeCloseTo(38.5, 5);
    expect(pts[2][0]).toBeCloseTo(-126.453, 5);
    expect(decodePolyline(undefined)).toEqual([]);
  });

  it('snaps a position and splits the route into driven and ahead', () => {
    const route = [[-97, 32], [-96, 32], [-95, 32]];
    const snap = projectOnRoute(route, { lat: 32.01, lng: -95.5 });
    expect(snap.index).toBe(1);
    expect(snap.t).toBeCloseTo(0.5, 2);
    expect(snap.offMiles).toBeLessThan(1);
    const { done, ahead } = splitRoute(route, { lat: 32, lng: -96.5 });
    expect(done[0]).toEqual([-97, 32]);
    expect(done.at(-1)[0]).toBeCloseTo(-96.5, 5);
    expect(ahead[0][0]).toBeCloseTo(-96.5, 5);
    expect(ahead.at(-1)).toEqual([-95, 32]);
    expect(splitRoute([], { lat: 1, lng: 1 }).snap).toBeNull();
  });

  it('measures and bounds', () => {
    expect(segmentMiles([-97, 32], [-96, 32])).toBeGreaterThan(55);
    expect(boundsOf([[-97, 32], [-95, 33]], [[-100, 30]])).toEqual([[-100, 30], [-95, 33]]);
    expect(boundsOf([])).toBeNull();
  });
});
