import { describe, it, expect } from 'vitest';
import { parseLoadText, parseStops, termsNote } from '../src/services/loads/parser.js';
import { facilityTimezone } from '../src/services/loads/facilityTz.js';

const now = new Date('2026-11-09T12:00:00Z');

const RATE_CON = `Summit Logistics LLC
1200 Commerce St, Dallas, TX 75201
MC# 322572  Phone: (800) 555-1234  Email: ops@summitlogistics.com
RATE CONFIRMATION
Load #: SL-48213

Pickup 1
Acme Foods DC
4500 Industrial Blvd
El Paso, TX 79936
11/12/2026 08:00 - 14:00
PO# 778812  PU# A55102

Delivery
Peach State Grocers
455 Logistics Pkwy
Atlanta, GA 30301
11/14/2026 FCFS 7:00 AM to 3:00 PM
Appt# 99812

Equipment: Reefer 53'
Commodity: Frozen foods
Weight: 42,500 lbs
Miles: 1,412
Line Haul: $3,850.00
Total Carrier Pay: $3,950.00
Detention: $50/hr after 2 hours free
TONU: $150
Lumper: reimbursed with receipt
Payment terms: Net 30, quick pay 2%`;

describe('rate con import parser', () => {
  it('reads stops, appointment windows, facility time zones, references, terms and the broker block', () => {
    const { fields, missing } = parseLoadText(RATE_CON, { now });
    expect(missing).toEqual([]);
    expect(fields).toMatchObject({
      originCity: 'El Paso', originState: 'TX', destCity: 'Atlanta', destState: 'GA',
      rateCents: 395000, loadedMiles: 1412, weightLbs: 42500, equipment: 'reefer', commodity: 'Frozen foods', referenceNumber: 'SL-48213',
      brokerName: 'Summit Logistics LLC', brokerMc: '322572', brokerPhone: '(800) 555-1234', brokerEmail: 'ops@summitlogistics.com',
      pickupFacility: 'Acme Foods DC', pickupAddress: '4500 Industrial Blvd, El Paso, TX 79936', pickupTz: 'America/Denver',
      pickupDate: '2026-11-12', pickupWindowStart: '2026-11-12T08:00', pickupWindowEnd: '2026-11-12T14:00',
      deliveryFacility: 'Peach State Grocers', deliveryTz: 'America/New_York', deliveryDate: '2026-11-14',
      deliveryWindowStart: '2026-11-14T07:00', deliveryWindowEnd: '2026-11-14T15:00', deliveryFcfs: true,
      detentionRateCents: 5000, freeTimeHours: 2, tonuCents: 15000, paymentTerms: 'Net 30', trailerLengthFt: 53,
    });
    expect(fields.pickupRefs).toEqual([{ kind: 'PO', value: '778812' }, { kind: 'PU', value: 'A55102' }]);
    const note = termsNote(fields);
    expect(note).toContain('Pickup refs: PO 778812, PU A55102');
    expect(note).toContain('Delivery: FCFS from 07:00 to 15:00');
  });

  it('splits side-by-side pickup and delivery columns and keeps extra stops', () => {
    const text = 'Shipper:\tConsignee:\nBig Box DC\tCorner Market\n10 Main St\t20 Elm Ave\nMemphis, TN 38118\tKnoxville, TN 37902\n11/20 0600-1000\t11/21 1300\nStop 3: Chattanooga, TN 37402 11/21\nRate: $1,900';
    const stops = parseStops(text, now);
    expect(stops.pickup).toMatchObject({ facility: 'Big Box DC', city: 'Memphis', state: 'TN', start: '06:00', end: '10:00' });
    expect(stops.delivery).toMatchObject({ facility: 'Corner Market', city: 'Knoxville', state: 'TN', start: '13:00' });
    expect(stops.extra).toHaveLength(1);
    const { fields, notes } = parseLoadText(text, { now });
    expect(fields.pickupTz).toBe('America/Chicago');
    expect(fields.deliveryTz).toBe('America/New_York'); // East Tennessee
    expect(notes.some((n) => /1 more stop/.test(n))).toBe(true);
  });

  it('resolves split-state facility time zones offline and falls back to the state zone', () => {
    expect(facilityTimezone('El Paso', 'TX')).toBe('America/Denver');
    expect(facilityTimezone('Dallas', 'TX')).toBe('America/Chicago');
    expect(facilityTimezone('Pensacola', 'FL')).toBe('America/Chicago');
    expect(facilityTimezone('Ft. Walton Beach', 'FL')).toBe('America/Chicago');
    expect(facilityTimezone('Bowling Green', 'KY')).toBe('America/Chicago');
    expect(facilityTimezone('Gary', 'IN')).toBe('America/Chicago');
    expect(facilityTimezone('Rapid City', 'SD')).toBe('America/Denver');
    expect(facilityTimezone('Ontario', 'OR')).toBe('America/Boise');
    expect(facilityTimezone('Unknown Town', 'GA')).toBe('America/New_York');
    expect(facilityTimezone('Anywhere', '')).toBeNull();
  });

  it('caps input size and never invents a rate', () => {
    const { fields, notes } = parseLoadText(`${'x '.repeat(30000)} Dallas, TX to Atlanta, GA`, { now });
    expect(fields.rateCents).toBeUndefined();
    expect(notes.join(' ')).toMatch(/No total rate found/);
  });

  it('parses worst-case 20,000-character input in linear time (no regex backtracking blow-up)', () => {
    // These shapes took 0.5-0.8 s of CPU each with an unbounded email pattern; the request thread must stay free.
    for (const text of ['1'.repeat(20000), '0800-'.repeat(4000), `${'x'.repeat(10000)}${' '.repeat(10000)}`, 'a.'.repeat(10000)]) {
      const started = performance.now();
      parseLoadText(text, { now });
      expect(performance.now() - started).toBeLessThan(250);
    }
    expect(parseLoadText('Contact: dispatch@summit-logistics.com. Phone (972) 555-0100', { now }).fields.brokerEmail).toBe('dispatch@summit-logistics.com');
  });
});
