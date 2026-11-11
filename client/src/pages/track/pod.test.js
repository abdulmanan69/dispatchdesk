import { describe, it, expect } from 'vitest';
import { RECEIPT_W, SIG_BOX, composeReceipt, drawReceipt, positionText, receiptLayout, wrapText, zonedDateTime } from './receipt.js';
import { currentStopIndex, stopDone, tripStops, withLoadStatus } from './stops.js';

// A fixed-width text measurer: each character is half the font size wide.
const sizeOf = (font) => Number(/(\d+)px/.exec(font)[1]);
const measure = (text, font) => text.length * sizeOf(font) * 0.5;

const base = {
  reference: 'BM-77', facility: 'Omaha Grocers DC', address: '9 Market St', city: 'Omaha', state: 'NE', tz: 'America/Chicago',
  deliveredAt: new Date('2026-11-11T21:42:00Z'), receiverName: 'Maria Lopez', receiverTitle: 'Receiving clerk', pieces: '24 pallets',
  exceptions: '1 pallet short', strokes: [[{ x: 0.1, y: 0.5 }, { x: 0.5, y: 0.4 }, { x: 0.9, y: 0.6 }]], driverName: 'Ray', company: 'Blue Mesa Freight',
  position: { lat: 41.25654, lng: -95.93450, accuracy: 8.6 },
};
const texts = (layout) => layout.ops.filter((o) => o.kind === 'text').map((o) => o.text);

/** A 2D context that records what is drawn. */
function fakeContext() {
  const calls = [];
  const ctx = new Proxy({ calls, measureText: (t) => ({ width: measure(t, ctx.font || '10px x') }) }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => calls.push([prop, ...args]);
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  return ctx;
}

describe('POD receipt', () => {
  it('lays out every field top to bottom on a 1600 px page', () => {
    const layout = receiptLayout(base, measure);
    expect(layout.width).toBe(RECEIPT_W);
    const t = texts(layout);
    const order = ['Proof of delivery', 'Load BM-77', 'Consignee', 'Omaha Grocers DC', '9 Market St', 'Omaha, NE', 'Delivered', 'Received by', 'Maria Lopez',
      'Receiving clerk', 'Pieces or pallets received', '24 pallets', 'Exceptions (over, short, damaged)', '1 pallet short', 'Receiver\'s signature', 'Driver',
      'Ray, Blue Mesa Freight', 'GPS position', '41.25654, -95.93450 (within 9 m)'];
    let last = -1;
    for (const want of order) {
      const i = t.indexOf(want);
      expect(i, want).toBeGreaterThan(last);
      last = i;
    }
    // Delivered time in the facility's zone (21:42 UTC is 3:42 PM in Chicago).
    expect(t[t.indexOf('Delivered') + 1]).toMatch(/Nov 11, 2026.*3:42\sPM CST/);
    // Baselines go down the page and stay inside it; the signature keeps the pad's 3:1 shape.
    const ys = layout.ops.filter((o) => o.kind === 'text').map((o) => o.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(Math.max(...ys)).toBeLessThan(layout.height);
    const sig = layout.ops.find((o) => o.kind === 'signature');
    expect(sig).toMatchObject({ w: SIG_BOX.w, h: SIG_BOX.h, strokes: base.strokes });
    expect(SIG_BOX.w / SIG_BOX.h).toBeCloseTo(3, 1);
    for (const o of layout.ops) if (o.kind === 'text') expect(o.x + measure(o.text, o.font)).toBeLessThanOrEqual(RECEIPT_W - o.x);
  });

  it('wraps long names, references and exceptions inside the page', () => {
    const longName = 'Bartholomew Maximilian Featherstonehaugh-Cholmondeley the Third of Westchester County';
    const layout = receiptLayout({ ...base, receiverName: longName, reference: 'X'.repeat(140), exceptions: `${'Crushed carton '.repeat(30)}\nWet pallet` }, measure);
    const textOps = layout.ops.filter((o) => o.kind === 'text');
    for (const o of textOps) expect(o.x + measure(o.text, o.font)).toBeLessThanOrEqual(RECEIPT_W - o.x);
    const t = texts(layout);
    // Every word of the name is printed, in order, over more than one line.
    const start = t.indexOf('Received by') + 1;
    const end = t.indexOf('Receiving clerk');
    expect(end - start).toBeGreaterThan(1);
    expect(t.slice(start, end).join(' ')).toBe(longName);
    // A reference with no spaces is split rather than running off the page.
    expect(t.filter((x) => /^(Load )?X+$/.test(x)).join('').replace('Load ', '')).toBe('X'.repeat(140));
    expect(t).toContain('Wet pallet');
    expect(layout.height).toBeGreaterThan(receiptLayout(base, measure).height);
  });

  it('works without GPS, title, pieces, exceptions or a known time zone', () => {
    const layout = receiptLayout({ ...base, position: null, receiverTitle: '', pieces: '  ', exceptions: '', tz: 'Not/AZone', facility: null, address: null, driverName: null }, measure);
    const t = texts(layout);
    expect(t[t.indexOf('GPS position') + 1]).toBe('Not available');
    expect(t[t.indexOf('Exceptions (over, short, damaged)') + 1]).toBe('None noted');
    expect(t).not.toContain('Pieces or pallets received');
    expect(t[t.indexOf('Consignee') + 1]).toBe('Omaha, NE');
    expect(t[t.indexOf('Driver') + 1]).toBe('Blue Mesa Freight');
    expect(t[t.indexOf('Delivered') + 1]).toMatch(/2026/);
    expect(positionText({ lat: Number.NaN, lng: 1 })).toBeNull();
    expect(zonedDateTime(new Date('2026-07-04T16:00:00Z'), 'America/Los_Angeles')).toMatch(/9:00\sAM PDT/);
  });

  it('draws on a white page and composes a JPEG', async () => {
    const layout = receiptLayout(base, measure);
    const ctx = fakeContext();
    drawReceipt(ctx, layout);
    expect(ctx.calls[0]).toEqual(['fillRect', 0, 0, RECEIPT_W, layout.height]);
    expect(ctx.calls.filter(([m]) => m === 'fillText').map((c) => c[1])).toContain('Maria Lopez');
    expect(ctx.calls.filter(([m]) => m === 'stroke')).toHaveLength(1);

    const canvas = { getContext: () => fakeContext(), toBlob: (cb, type) => cb(new Blob(['jpeg'], { type })) };
    const out = await composeReceipt({ ...base, position: null, strokes: [] }, { createCanvas: () => canvas });
    expect(out.width).toBe(1600);
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(out.height);
    expect(out.blob.type).toBe('image/jpeg');
    await expect(composeReceipt(base, { createCanvas: () => ({ getContext: () => null }) })).rejects.toThrow(/could not draw/);
  });

  it('wraps text by words and keeps explicit line breaks', () => {
    const m = (s) => s.length;
    expect(wrapText('one two three four', 9, m)).toEqual(['one two', 'three', 'four']);
    expect(wrapText('abcdefghij', 4, m)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapText('a\n\nb', 10, m)).toEqual(['a', '', 'b']);
    expect(wrapText('', 10, m)).toEqual([]);
  });
});

describe('stops on the driver page', () => {
  const stop = (loadId, kind, status, city) => ({ loadId, kind, status, city, state: 'NE' });
  const consolidated = {
    id: 'A', status: 'booked', pickup: { city: 'Denver' }, delivery: { city: 'Omaha' },
    consolidation: { id: 'c1', stops: [stop('B', 'pickup', 'booked', 'Boulder'), stop('A', 'pickup', 'booked', 'Denver'), stop('A', 'delivery', 'booked', 'Omaha'), stop('B', 'delivery', 'booked', 'Lincoln')] },
  };

  it('keeps the consolidation order from the server', () => {
    expect(tripStops(consolidated).map((s) => `${s.loadId}:${s.kind}`)).toEqual(['B:pickup', 'A:pickup', 'A:delivery', 'B:delivery']);
  });

  it('a single load has its pickup then its delivery', () => {
    const t = { id: 'L1', status: 'in_transit', referenceNumber: 'R1', pickup: { city: 'Dallas', facility: 'DC 1' }, delivery: { city: 'Memphis', tz: 'America/Chicago' } };
    const s = tripStops(t);
    expect(s.map((x) => `${x.kind}:${x.city}`)).toEqual(['pickup:Dallas', 'delivery:Memphis']);
    expect(s[1]).toMatchObject({ loadId: 'L1', referenceNumber: 'R1', status: 'in_transit', tz: 'America/Chicago' });
    expect(tripStops(null)).toEqual([]);
  });

  it('the current stop is the first one not done, and moves on as loads advance', () => {
    let trip = consolidated;
    expect(currentStopIndex(tripStops(trip))).toBe(0);
    trip = withLoadStatus(trip, 'B', 'in_transit');
    expect(currentStopIndex(tripStops(trip))).toBe(1);
    trip = withLoadStatus(trip, 'A', 'in_transit');
    expect(trip.status).toBe('in_transit');
    expect(currentStopIndex(tripStops(trip))).toBe(2);
    trip = withLoadStatus(trip, 'A', 'delivered');
    expect(currentStopIndex(tripStops(trip))).toBe(3);
    trip = withLoadStatus(trip, 'B', 'delivered');
    // All done: the last stop stays current.
    expect(tripStops(trip).every(stopDone)).toBe(true);
    expect(currentStopIndex(tripStops(trip))).toBe(3);
    expect(consolidated.consolidation.stops[0].status).toBe('booked'); // not mutated
  });
});
