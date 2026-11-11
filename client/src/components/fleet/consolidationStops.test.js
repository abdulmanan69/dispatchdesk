import { describe, it, expect } from 'vitest';
import { defaultStopOrder, checkStopOrder, moveStop, syncStopOrder, sameOrder, estimateOrder, loadsFromTrip, normalizeCandidate } from './consolidationStops.js';

const L = (id, p, d, extra = {}) => ({
  id, ref: id.toUpperCase(),
  pickup: { city: 'Dallas', lat: 32.78, lng: -96.8, window: p ? { start: p } : null },
  delivery: { city: 'Memphis', lat: 35.15, lng: -90.05, window: d ? { start: d } : null },
  ...extra,
});
const keys = (stops) => stops.map((s) => `${s.loadId}:${s.kind[0]}`);

describe('consolidated trip stop order', () => {
  it('defaults to pickups by window start, then deliveries by window start', () => {
    const loads = [L('a', '2026-11-12T12:00Z', '2026-11-14T09:00Z'), L('b', '2026-11-12T08:00Z', '2026-11-13T09:00Z'), L('c', null, null)];
    expect(keys(defaultStopOrder(loads))).toEqual(['b:p', 'a:p', 'c:p', 'b:d', 'a:d', 'c:d']);
  });

  it('flags a delivery placed before its pickup, at the delivery', () => {
    const byId = new Map([['a', L('a')], ['b', L('b')]]);
    const ok = checkStopOrder([{ loadId: 'a', kind: 'pickup' }, { loadId: 'b', kind: 'pickup' }, { loadId: 'b', kind: 'delivery' }, { loadId: 'a', kind: 'delivery' }], ['a', 'b'], byId);
    expect(ok).toEqual({ ok: true, message: null, problems: {} });
    const bad = checkStopOrder([{ loadId: 'a', kind: 'pickup' }, { loadId: 'b', kind: 'delivery' }, { loadId: 'b', kind: 'pickup' }, { loadId: 'a', kind: 'delivery' }], ['a', 'b'], byId);
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad.problems)).toEqual(['1']);
    expect(bad.message).toBe('Load #B is delivered before it is picked up. Move the delivery below its pickup.');
  });

  it('rejects anything that is not one pickup and one delivery per load', () => {
    expect(checkStopOrder([{ loadId: 'a', kind: 'pickup' }, { loadId: 'a', kind: 'delivery' }], ['a', 'b']).ok).toBe(false);
    expect(checkStopOrder([{ loadId: 'a', kind: 'pickup' }, { loadId: 'a', kind: 'pickup' }, { loadId: 'a', kind: 'delivery' }], ['a']).problems).toHaveProperty('1');
    expect(checkStopOrder([{ loadId: 'x', kind: 'pickup' }, { loadId: 'x', kind: 'delivery' }], ['x', 'y']).ok).toBe(false);
  });

  it('moves stops up and down within bounds', () => {
    const s = [{ loadId: 'a', kind: 'pickup' }, { loadId: 'b', kind: 'pickup' }, { loadId: 'a', kind: 'delivery' }];
    expect(keys(moveStop(s, 2, 0))).toEqual(['a:d', 'a:p', 'b:p']);
    expect(keys(moveStop(s, 0, 9))).toEqual(['b:p', 'a:d', 'a:p']);
    expect(keys(moveStop(s, 5, 0))).toEqual(keys(s));
  });

  it('keeps a hand-made order when loads are added or taken off', () => {
    const a = L('a', '2026-11-12T08:00Z', '2026-11-13T08:00Z');
    const b = L('b', '2026-11-12T10:00Z', '2026-11-14T08:00Z');
    const c = L('c', '2026-11-12T09:00Z', '2026-11-13T12:00Z');
    const mine = [{ loadId: 'b', kind: 'pickup' }, { loadId: 'a', kind: 'pickup' }, { loadId: 'a', kind: 'delivery' }, { loadId: 'b', kind: 'delivery' }];
    // c (pickup 09:00) goes before the first stop due later (b at 10:00); its delivery before b's.
    expect(keys(syncStopOrder(mine, [a, b, c]))).toEqual(['c:p', 'b:p', 'a:p', 'a:d', 'c:d', 'b:d']);
    expect(keys(syncStopOrder(mine, [a]))).toEqual(['a:p', 'a:d']);
    expect(sameOrder(mine, mine.slice())).toBe(true);
    expect(sameOrder(mine, mine.slice().reverse())).toBe(false);
  });

  it('estimates straight-line miles through the stops', () => {
    const byId = new Map([['a', L('a')]]);
    const e = estimateOrder([{ loadId: 'a', kind: 'pickup' }, { loadId: 'a', kind: 'delivery' }], byId);
    expect(e.miles).toBeGreaterThan(450);
    expect(e.miles).toBeLessThan(520);
    expect(e.minutes).toBe(Math.round((e.miles / 50) * 60));
    expect(estimateOrder([{ loadId: 'zz', kind: 'pickup' }], byId)).toBeNull();
  });

  it('reads loads from candidates and from a saved trip', () => {
    const c = normalizeCandidate({
      id: 'l1', referenceNumber: '42', status: 'booked', carrierId: null, broker: { companyName: 'Acme' }, rateCents: 100,
      origin: { city: 'Dallas', state: 'TX', lat: 1, lng: 2 }, dest: { city: 'Tulsa', state: 'OK', lat: 3, lng: 4 },
      pickupDate: '2026-11-12T18:00:00Z', pickupWindowStart: null, deliveryWindowStart: '2026-11-13T15:00:00Z', deliveryWindowEnd: null,
    });
    expect(c).toMatchObject({ ref: '42', onTruck: false, broker: 'Acme', pickup: { window: { dateOnly: true } }, delivery: { window: { start: '2026-11-13T15:00:00Z' } } });
    const trip = { id: 't', name: null, stops: [
      { loadId: 'l1', kind: 'pickup', city: 'Dallas', lat: 1, lng: 2, done: true, load: { referenceNumber: '42' } },
      { loadId: 'l2', kind: 'pickup', city: 'Waco', lat: 1, lng: 2, load: {} },
      { loadId: 'l1', kind: 'delivery', city: 'Tulsa', lat: 3, lng: 4, load: { referenceNumber: '42' } },
      { loadId: 'l2', kind: 'delivery', city: 'Enid', lat: 3, lng: 4, load: {} },
    ] };
    const loads = loadsFromTrip(trip);
    expect(loads.map((l) => l.id)).toEqual(['l1', 'l2']);
    expect(loads[0]).toMatchObject({ ref: '42', pickup: { city: 'Dallas', done: true }, delivery: { city: 'Tulsa' } });
  });
});
