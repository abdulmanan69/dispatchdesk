import { describe, it, expect } from 'vitest';
import { formatWindow, zonedInput, zonedToInstant, zoneAbbr } from './zoned.js';
import { itemsToLines } from './pdfText.js';
import { formToBody, loadToForm, parsedToForm, rateConNote } from './LoadForm.jsx';
import { checkLoadFit, rulesSummary } from './fit.js';
import { guessDocType } from '../documents/docTypes.js';

describe('facility-local appointment times', () => {
  it('shows an instant as the facility wall clock and converts back', () => {
    expect(zonedInput('2026-11-12T15:00:00.000Z', 'America/Denver')).toBe('2026-11-12T08:00');
    expect(zonedInput('2026-11-12T08:00', 'America/Denver')).toBe('2026-11-12T08:00'); // parser output stays as is
    expect(zonedToInstant('2026-11-12T08:00', 'America/Denver').toISOString()).toBe('2026-11-12T15:00:00.000Z');
    expect(zonedToInstant('2026-07-01T08:00', 'America/New_York').toISOString()).toBe('2026-07-01T12:00:00.000Z');
    expect(zonedInput('', 'America/Denver')).toBe('');
    expect(zoneAbbr('America/Denver', new Date('2026-11-12T15:00:00Z'))).toBe('MST');
  });

  it('formats a window with the facility zone and the viewer’s own time when they differ', () => {
    const text = formatWindow('2026-11-12T15:00:00Z', '2026-11-12T21:00:00Z', 'America/Denver', 'America/Chicago');
    expect(text).toBe('Thu, Nov 12, 8:00 AM–2:00 PM MST · 9:00 AM your time');
    expect(formatWindow('2026-11-12T15:00:00Z', null, 'America/Denver', 'America/Denver')).toBe('Thu, Nov 12, 8:00 AM MST');
    expect(formatWindow('2026-11-12T08:00', '2026-11-12T14:00', 'America/Denver', 'America/Denver')).toBe('Thu, Nov 12, 8:00 AM–2:00 PM MST');
  });
});

describe('rate con PDF text', () => {
  it('rebuilds lines top to bottom and keeps side-by-side columns apart with a tab', () => {
    const it2 = (str, x, y, w = str.length * 5) => ({ str, transform: [10, 0, 0, 10, x, y], width: w, height: 10 });
    const lines = itemsToLines([
      it2('Consignee:', 300, 700), it2('Shipper:', 40, 700),
      it2('Big', 40, 680, 15), it2('Box DC', 57, 680), it2('Corner Market', 300, 680),
      it2('Rate:', 40, 600), it2('$1,900', 70, 600),
    ]);
    expect(lines).toEqual(['Shipper:\tConsignee:', 'Big Box DC\tCorner Market', 'Rate: $1,900']);
  });
});

describe('load form mapping', () => {
  it('sends appointment windows as facility-local wall time and never the zone', () => {
    const form = loadToForm({ originCity: 'El Paso', originState: 'TX', destCity: 'Atlanta', destState: 'GA', pickupWindowStart: '2026-11-12T15:00:00.000Z', pickupTz: 'America/Denver', rateCents: 235000, loadedMiles: 781 });
    expect(form.pickupWindowStart).toBe('2026-11-12T08:00');
    const body = formToBody(form);
    expect(body.pickupWindowStart).toBe('2026-11-12T08:00');
    expect(body.pickupDate).toBe(new Date('2026-11-12T12:00:00').toISOString()); // day taken from the window
    expect(body).not.toHaveProperty('pickupTz');
    expect(body.rateCents).toBe(235000);
  });

  it('applies only the fields a rate con had and lists its terms for the notes', () => {
    const fields = { originCity: 'Dallas', originState: 'TX', detentionRateCents: 5000, freeTimeHours: 2, pickupRefs: [{ kind: 'PO', value: '7788' }], deliveryFcfs: true, paymentTerms: 'Net 30', tonuCents: 15000 };
    const patch = parsedToForm(fields);
    expect(patch).toMatchObject({ originCity: 'Dallas', detentionRate: '50', freeTimeHours: '2' });
    expect(patch).not.toHaveProperty('status');
    expect(patch).not.toHaveProperty('rate');
    expect(rateConNote(fields)).toBe('From the rate con:\nPickup refs: PO 7788\nDelivery: first come, first served\nDetention: $50.00/h after 2 h free\nTONU: $150.00\nPayment terms: Net 30');
  });
});

describe('client load check mirror', () => {
  it('warns from the carrier rules in the browser without a round trip', () => {
    const { warnings, numbers } = checkLoadFit({ rateCents: 180000, loadedMiles: 1000, deadheadMiles: 50, originState: 'TX', destState: 'NY' }, { minRatePerMile: 2, avoidStates: 'NY,NJ', costPerMileCents: 150 });
    expect(warnings.map((w) => w.code)).toEqual(['min_rpm', 'avoid_state']);
    expect(numbers.walkAwayCents).toBe(200000);
    expect(rulesSummary({ teamDrivers: true, maxWeightLbs: 44000 })).toEqual(['Up to 44,000 lb', 'Team drivers']);
  });
});

describe('document type guess', () => {
  it('recognizes common file names and keeps unclear ones as other', () => {
    expect(guessDocType('W9 Blue Line.pdf')).toBe('w9');
    expect(guessDocType('ACORD certificate.pdf')).toBe('coi');
    expect(guessDocType('RateCon_48213.pdf')).toBe('rate_confirmation');
    expect(guessDocType('signed BOL 48213.jpg')).toBe('pod');
    expect(guessDocType('BOL-48213.pdf')).toBe('bol');
    expect(guessDocType('MC authority letter.pdf')).toBe('mc_authority');
    expect(guessDocType('Dispatch Agreement.docx')).toBe('agreement');
    expect(guessDocType('scan0001.pdf')).toBe('other');
    expect(guessDocType('W9.pdf', ['rate_confirmation', 'bol', 'pod', 'other'])).toBe('other');
  });
});
